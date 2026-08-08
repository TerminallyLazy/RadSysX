from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any, BinaryIO, Protocol
from uuid import uuid4

import httpx

from .config import ClinicalPlatformSettings
from .contracts import (
    DerivedDicomObject,
    DerivedResultStowRequest,
    SeriesMetadata,
    StoreResult,
    StudyMetadata,
    StudyQuery,
    StudySearchPage,
)

ALLOWED_STOW_CONTENT_TYPES = {"application/dicom"}


def normalize_dicom_stow_content_type(value: str) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in ALLOWED_STOW_CONTENT_TYPES:
        return normalized
    supported = ", ".join(sorted(ALLOWED_STOW_CONTENT_TYPES))
    raise ValueError(f"Unsupported DICOM STOW contentType '{value}'. Supported values: {supported}.")


class DICOMwebAdapter(Protocol):
    async def search_studies(self, query: StudyQuery) -> StudySearchPage: ...

    async def get_study_metadata(self, study_uid: str) -> StudyMetadata: ...

    async def get_series_metadata(self, study_uid: str, series_uid: str) -> SeriesMetadata: ...

    async def get_wado_rs_uri(self, study_uid: str, series_uid: str | None = None) -> str: ...

    async def store_derived_objects(self, objects: list[DerivedDicomObject]) -> StoreResult: ...

    async def store_uploaded_instances(
        self,
        request: DerivedResultStowRequest,
        files: list["UploadedDicomPart"],
    ) -> StoreResult: ...


@dataclass(frozen=True)
class UploadedDicomPart:
    filename: str
    stream: BinaryIO


class OrthancDICOMwebAdapter:
    def __init__(self, settings: ClinicalPlatformSettings) -> None:
        self._settings = settings

    async def search_studies(self, query: StudyQuery) -> StudySearchPage:
        if not self._settings.orthanc_base_url:
            return StudySearchPage(items=[], total=0)

        params: dict[str, str | int] = {"limit": query.limit}
        if query.study_instance_uid:
            params["StudyInstanceUID"] = query.study_instance_uid
        if query.accession_number:
            params["AccessionNumber"] = query.accession_number
        if query.modality:
            params["ModalitiesInStudy"] = query.modality

        async with self._client() as client:
            response = await client.get("/studies", params=params)
            response.raise_for_status()
            payload = response.json()

        items = [
            StudyMetadata(
                study_instance_uid=item.get("0020000D", {}).get("Value", ["unknown"])[0],
                patient_ref=item.get("00100020", {}).get("Value", ["unknown"])[0],
                accession_number=item.get("00080050", {}).get("Value", [None])[0],
                modality=item.get("00080061", {}).get("Value", ["OT"])[0],
                description=item.get("00081030", {}).get("Value", ["Untitled study"])[0],
                study_date=item.get("00080020", {}).get("Value", [""])[0],
                archive_ref=self._settings.orthanc_base_url,
            )
            for item in payload
        ]
        return StudySearchPage(items=items, total=len(items))

    async def get_study_metadata(self, study_uid: str) -> StudyMetadata:
        if not self._settings.orthanc_base_url:
            wado_rs = await self.get_wado_rs_uri(study_uid)
            return StudyMetadata(
                study_instance_uid=study_uid,
                patient_ref="external",
                modality="OT",
                description="External DICOMweb study",
                study_date="",
                archive_ref=wado_rs,
            )

        async with self._client() as client:
            response = await client.get("/studies", params={"StudyInstanceUID": study_uid, "limit": 1})
            response.raise_for_status()
            payload = response.json()

        if not payload:
            return StudyMetadata(
                study_instance_uid=study_uid,
                patient_ref="external",
                modality="OT",
                description="External DICOMweb study",
                study_date="",
                archive_ref=await self.get_wado_rs_uri(study_uid),
            )

        item = payload[0]
        return StudyMetadata(
            study_instance_uid=self._tag_value(item, "0020000D", study_uid),
            patient_ref=self._tag_value(item, "00100020", "external"),
            accession_number=self._tag_value(item, "00080050"),
            modality=self._tag_value(item, "00080061", "OT"),
            description=self._tag_value(item, "00081030", "External DICOMweb study"),
            study_date=self._tag_value(item, "00080020", ""),
            archive_ref=await self.get_wado_rs_uri(study_uid),
        )

    async def get_series_metadata(self, study_uid: str, series_uid: str) -> SeriesMetadata:
        if not self._settings.orthanc_base_url:
            return SeriesMetadata(
                study_instance_uid=study_uid,
                series_instance_uid=series_uid,
                modality="OT",
                description="External DICOMweb series",
            )

        async with self._client() as client:
            response = await client.get(f"/studies/{study_uid}/series/{series_uid}/metadata")
            response.raise_for_status()
            payload = response.json()

        first_item = payload[0] if payload else {}
        sop_instance_uids = [
            self._tag_value(item, "00080018", "")
            for item in payload
            if self._tag_value(item, "00080018", "")
        ]
        return SeriesMetadata(
            study_instance_uid=study_uid,
            series_instance_uid=series_uid,
            modality=self._tag_value(first_item, "00080060", "OT"),
            description=self._tag_value(first_item, "0008103E", "External DICOMweb series"),
            sop_instance_uids=sop_instance_uids,
        )

    async def get_wado_rs_uri(self, study_uid: str, series_uid: str | None = None) -> str:
        base = self._settings.orthanc_base_url or "dicomweb://unconfigured"
        if series_uid:
            return f"{base}/studies/{study_uid}/series/{series_uid}"
        return f"{base}/studies/{study_uid}"

    async def store_derived_objects(self, objects: list[DerivedDicomObject]) -> StoreResult:
        stored = [
            object_.payload_ref
            or f"{object_.object_type}:{object_.study_instance_uid}:{index}"
            for index, object_ in enumerate(objects, start=1)
        ]
        warnings: list[str] = []
        if not self._settings.orthanc_base_url:
            warnings.append("Orthanc DICOMweb endpoint is not configured; results were staged logically only.")
        return StoreResult(stored=stored, warnings=warnings)

    async def store_uploaded_instances(
        self,
        request: DerivedResultStowRequest,
        files: list[UploadedDicomPart],
    ) -> StoreResult:
        warnings: list[str] = []
        if not self._settings.orthanc_base_url:
            warnings.append("Orthanc DICOMweb endpoint is not configured; results were staged logically only.")
            return StoreResult(
                stored=[
                    self._build_public_instance_ref(
                        request.study_instance_uid,
                        request.series_instance_uid,
                        request.sop_instance_uid or f"unconfigured-{index}",
                    )
                    for index, _ in enumerate(files, start=1)
                ],
                warnings=warnings,
            )

        content_type = normalize_dicom_stow_content_type(request.content_type)
        boundary = f"radsysx-{uuid4().hex}"
        headers = {
            "Content-Type": f'multipart/related; type="{content_type}"; boundary={boundary}'
        }
        content = self._build_multipart_related_stream(boundary, files, content_type)

        async with self._client() as client:
            response = await client.post("/studies", headers=headers, content=content)
            response.raise_for_status()
            payload = response.json() if response.content else {}

        stored = self._stored_refs_from_stow_response(payload, request, len(files))
        if not stored:
            stored = [
                self._build_public_instance_ref(
                    request.study_instance_uid,
                    request.series_instance_uid,
                    request.sop_instance_uid or f"stored-{index}",
                )
                for index, _ in enumerate(files, start=1)
            ]
        return StoreResult(stored=stored, warnings=warnings)

    def _client(self) -> httpx.AsyncClient:
        auth = None
        if self._settings.orthanc_username and self._settings.orthanc_password:
            auth = (self._settings.orthanc_username, self._settings.orthanc_password)

        return httpx.AsyncClient(
            base_url=self._settings.orthanc_base_url,
            auth=auth,
            timeout=10.0,
        )

    @staticmethod
    def _tag_value(item: dict[str, Any], tag: str, default: Any = None) -> Any:
        value = item.get(tag, {}).get("Value", [default])
        if not value:
            return default
        first = value[0]
        if isinstance(first, list) and first:
            return first[0]
        return first

    @staticmethod
    def _rewind(stream: BinaryIO) -> None:
        try:
            stream.seek(0)
        except (AttributeError, OSError):
            return

    async def _stream_file(
        self,
        stream: BinaryIO,
        *,
        chunk_size: int = 1024 * 1024,
    ) -> AsyncIterator[bytes]:
        while True:
            chunk = await asyncio.to_thread(stream.read, chunk_size)
            if not chunk:
                break
            yield chunk

    async def _build_multipart_related_stream(
        self,
        boundary: str,
        files: list[UploadedDicomPart],
        content_type: str,
    ) -> AsyncIterator[bytes]:
        for file in files:
            self._rewind(file.stream)
            yield (
                f"--{boundary}\r\n"
                f"Content-Type: {content_type}\r\n\r\n"
            ).encode("utf-8")
            async for chunk in self._stream_file(file.stream):
                yield chunk
            yield b"\r\n"
        yield f"--{boundary}--\r\n".encode("utf-8")

    def _build_public_instance_ref(
        self,
        study_uid: str,
        series_uid: str | None,
        sop_uid: str,
    ) -> str:
        root = self._settings.dicomweb_wado_root or "/dicom-web"
        if series_uid:
            return f"{root}/studies/{study_uid}/series/{series_uid}/instances/{sop_uid}"
        return f"{root}/studies/{study_uid}/instances/{sop_uid}"

    def _stored_refs_from_stow_response(
        self,
        payload: dict[str, Any],
        request: DerivedResultStowRequest,
        file_count: int,
    ) -> list[str]:
        sequence = payload.get("00081199", {}).get("Value", [])
        stored: list[str] = []
        for item in sequence:
            sop_uid = self._tag_value(item, "00081155")
            if not sop_uid:
                continue
            stored.append(
                self._build_public_instance_ref(
                    request.study_instance_uid,
                    request.series_instance_uid,
                    sop_uid,
                )
            )

        if stored or file_count == 0:
            return stored

        fallback_sop = request.sop_instance_uid
        if fallback_sop:
            return [
                self._build_public_instance_ref(
                    request.study_instance_uid,
                    request.series_instance_uid,
                    fallback_sop,
                )
            ]
        return []

    @staticmethod
    def _build_multipart_related(
        boundary: str,
        files: list[tuple[str, bytes]],
        content_type: str,
    ) -> bytes:
        parts: list[bytes] = []
        delimiter = f"--{boundary}\r\n".encode("ascii")
        closing = f"--{boundary}--\r\n".encode("ascii")
        for _, payload in files:
            parts.append(delimiter)
            parts.append(f"Content-Type: {content_type}\r\n\r\n".encode("ascii"))
            parts.append(payload)
            parts.append(b"\r\n")
        parts.append(closing)
        return b"".join(parts)
