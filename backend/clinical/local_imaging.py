from __future__ import annotations

import gzip
import json
import math
import re
import shutil
import struct
import zipfile
from collections import defaultdict
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path, PurePosixPath
from uuid import uuid4

import pydicom
from fastapi import HTTPException
from pydicom.tag import Tag

from .config import ClinicalPlatformSettings
from .contracts import (
    LocalImagingAssetAnalysis,
    LocalImagingImportResponse,
    LocalImagingImportedStudy,
    LocalImagingStudyAnalysisResponse,
    LocalImagingStudyAsset,
    LocalImagingStudyAssetsResponse,
    LocalImagingStudyFinding,
)
from .repositories import ClinicalRepository

DICOMDIR_SOP_CLASS_UID = "1.2.840.10008.1.3.10"
COMMON_IMAGE_EXTENSIONS = {"bmp", "gif", "jpg", "jpeg", "png", "tif", "tiff"}
NRRD_EXTENSIONS = {"nrrd"}
PREVIEW_IMAGE_MEDIA_TYPES = {
    "bmp": "image/bmp",
    "gif": "image/gif",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "png": "image/png",
}
TIFF_PREVIEW_FORMATS = {"tif", "tiff"}
NIFTI_PREVIEW_MAX_DIMENSION = 96
NIFTI_NUMERIC_DATATYPES: dict[int, tuple[str, int]] = {
    2: ("B", 1),
    4: ("h", 2),
    8: ("i", 4),
    16: ("f", 4),
    64: ("d", 8),
    256: ("b", 1),
    512: ("H", 2),
    768: ("I", 4),
}
NRRD_NUMERIC_TYPES: dict[str, tuple[str, int]] = {
    "signed char": ("b", 1),
    "int8": ("b", 1),
    "int8_t": ("b", 1),
    "uchar": ("B", 1),
    "unsigned char": ("B", 1),
    "uint8": ("B", 1),
    "uint8_t": ("B", 1),
    "short": ("h", 2),
    "short int": ("h", 2),
    "signed short": ("h", 2),
    "signed short int": ("h", 2),
    "int16": ("h", 2),
    "int16_t": ("h", 2),
    "ushort": ("H", 2),
    "unsigned short": ("H", 2),
    "unsigned short int": ("H", 2),
    "uint16": ("H", 2),
    "uint16_t": ("H", 2),
    "int": ("i", 4),
    "signed int": ("i", 4),
    "int32": ("i", 4),
    "int32_t": ("i", 4),
    "uint": ("I", 4),
    "unsigned int": ("I", 4),
    "uint32": ("I", 4),
    "uint32_t": ("I", 4),
    "float": ("f", 4),
    "double": ("d", 8),
}
LOCAL_ANALYSIS_MAX_VALUES = 250_000


@dataclass(frozen=True)
class LocalImagingUploadPart:
    filename: str
    content_type: str | None
    relative_path: str | None
    data: bytes


@dataclass(frozen=True)
class _DetectedFile:
    original_name: str
    relative_path: str
    stored_path: str
    size: int
    format: str
    study_instance_uid: str | None = None
    series_instance_uid: str | None = None
    sop_instance_uid: str | None = None
    modality: str | None = None
    paired_stored_path: str | None = None
    paired_relative_path: str | None = None


@dataclass(frozen=True)
class LocalDicomInstance:
    study_instance_uid: str
    series_instance_uid: str
    sop_instance_uid: str
    stored_path: str


@dataclass(frozen=True)
class LocalImagingPreview:
    content: bytes
    media_type: str


class LocalImagingImporter:
    def __init__(
        self,
        settings: ClinicalPlatformSettings,
        repository: ClinicalRepository,
    ) -> None:
        self._settings = settings
        self._repository = repository

    def import_uploads(
        self,
        uploads: list[LocalImagingUploadPart],
    ) -> LocalImagingImportResponse:
        import_id = f"import-{uuid4()}"
        import_root = Path(self._settings.local_imaging_storage_dir) / import_id
        import_root.mkdir(parents=True, exist_ok=False)

        warnings: list[str] = []
        detected_files: list[_DetectedFile] = []
        unknown_files: list[tuple[int, _DetectedFile]] = []
        rejected_files = 0

        try:
            expanded_uploads = self._expand_archive_uploads(uploads, warnings)
            for index, upload in enumerate(expanded_uploads, start=1):
                detected = self._store_and_detect(upload, import_root, index)
                if detected.format == "unknown":
                    unknown_files.append((index, detected))
                    continue

                detected_files.append(detected)

            paired_data_files: list[_DetectedFile]
            detected_files, paired_data_files = self._attach_paired_nifti_data(
                detected_files,
                [file for _, file in unknown_files],
                warnings,
            )
            paired_data_stored_paths = {file.stored_path for file in paired_data_files}
            detected_files.extend(paired_data_files)
            for index, unknown_file in unknown_files:
                if unknown_file.stored_path in paired_data_stored_paths:
                    continue
                rejected_files += 1
                warnings.append(f"Skipped unsupported file at position {index}.")

            dicomdir_study_uids = self._dicomdir_referenced_study_uids(detected_files, warnings)
            studies, file_study_uids = self._register_studies(
                import_id,
                detected_files,
                warnings,
                dicomdir_study_uids,
            )
            self._write_manifest(import_root, import_id, detected_files, studies, file_study_uids, warnings)
        except Exception:
            shutil.rmtree(import_root, ignore_errors=True)
            raise

        return LocalImagingImportResponse(
            import_id=import_id,
            imported_studies=studies,
            accepted_files=len(detected_files),
            rejected_files=rejected_files,
            warnings=warnings,
        )

    def _store_and_detect(
        self,
        upload: LocalImagingUploadPart,
        import_root: Path,
        index: int,
    ) -> _DetectedFile:
        relative_path = self._safe_relative_path(upload.relative_path or upload.filename)
        safe_name = f"{index:04d}-{self._safe_filename(Path(relative_path).name)}"
        stored_path = import_root / safe_name
        stored_path.write_bytes(upload.data)

        detected = self._detect_file(upload, relative_path, stored_path.as_posix())
        return detected

    def _detect_file(
        self,
        upload: LocalImagingUploadPart,
        relative_path: str,
        stored_path: str,
    ) -> _DetectedFile:
        file_name = Path(relative_path).name
        upper_name = file_name.upper()
        lower_name = file_name.lower()
        extension = self._extension(lower_name)

        dicom_dataset = self._read_dicom_metadata(upload.data, force=upper_name == "DICOMDIR")
        if dicom_dataset is not None:
            sop_class_uid = str(getattr(dicom_dataset, "SOPClassUID", ""))
            if upper_name == "DICOMDIR" or sop_class_uid == DICOMDIR_SOP_CLASS_UID:
                return _DetectedFile(
                    original_name=file_name,
                    relative_path=relative_path,
                    stored_path=stored_path,
                    size=len(upload.data),
                    format="dicomdir",
                )

            return _DetectedFile(
                original_name=file_name,
                relative_path=relative_path,
                stored_path=stored_path,
                size=len(upload.data),
                format="dicom",
                study_instance_uid=self._clean_uid(getattr(dicom_dataset, "StudyInstanceUID", None)),
                series_instance_uid=self._clean_uid(getattr(dicom_dataset, "SeriesInstanceUID", None)),
                sop_instance_uid=self._clean_uid(getattr(dicom_dataset, "SOPInstanceUID", None)),
                modality=self._safe_modality(getattr(dicom_dataset, "Modality", None)),
            )

        if self._is_nifti(upload.data, lower_name):
            return _DetectedFile(
                original_name=file_name,
                relative_path=relative_path,
                stored_path=stored_path,
                size=len(upload.data),
                format="nifti",
                modality="NIFTI",
            )

        if self._is_nrrd(upload.data, lower_name):
            return _DetectedFile(
                original_name=file_name,
                relative_path=relative_path,
                stored_path=stored_path,
                size=len(upload.data),
                format="nrrd",
                modality="NRRD",
            )

        if extension in COMMON_IMAGE_EXTENSIONS:
            return _DetectedFile(
                original_name=file_name,
                relative_path=relative_path,
                stored_path=stored_path,
                size=len(upload.data),
                format=extension,
                modality="IMG",
            )

        return _DetectedFile(
            original_name=file_name,
            relative_path=relative_path,
            stored_path=stored_path,
            size=len(upload.data),
            format="unknown",
        )

    def _register_studies(
        self,
        import_id: str,
        detected_files: list[_DetectedFile],
        warnings: list[str],
        dicomdir_study_uids: dict[str, set[str]],
    ) -> tuple[list[LocalImagingImportedStudy], dict[str, list[str]]]:
        if not detected_files:
            return [], {}

        grouped: dict[str, list[_DetectedFile]] = defaultdict(list)
        file_study_uids: dict[str, list[str]] = {}
        generated_study_uid = self._generated_uid()
        primary_dicom_study_uid = next(
            (
                file.study_instance_uid
                for file in detected_files
                if file.format == "dicom" and file.study_instance_uid
            ),
            None,
        )

        for detected in detected_files:
            if detected.format == "dicom" and detected.study_instance_uid:
                study_uids = [detected.study_instance_uid]
            elif detected.format == "dicomdir":
                referenced_study_uids = sorted(dicomdir_study_uids.get(detected.stored_path, set()))
                if referenced_study_uids:
                    study_uids = referenced_study_uids
                elif primary_dicom_study_uid:
                    study_uids = [primary_dicom_study_uid]
                else:
                    study_uids = [generated_study_uid]
            else:
                study_uids = [generated_study_uid]
            file_study_uids[detected.stored_path] = study_uids
            for study_uid in study_uids:
                grouped[study_uid].append(detected)

        studies: list[LocalImagingImportedStudy] = []
        for study_uid, files in grouped.items():
            formats = sorted({file.format for file in files})
            modality = self._study_modality(files)
            accession_number = f"LOCAL-{import_id.removeprefix('import-')[:8].upper()}"
            if len(grouped) > 1:
                accession_number = f"{accession_number}-{len(studies) + 1}"

            summary = LocalImagingImportedStudy(
                study_instance_uid=study_uid,
                accession_number=accession_number,
                modality=modality,
                description=self._study_description(formats, len(files)),
                archive_ref=f"local://{import_id}/studies/{study_uid}",
                file_count=len(files),
                formats=formats,
                warnings=self._study_warnings(files, warnings),
            )
            self._repository.register_local_imported_study(summary)
            studies.append(summary)

        return studies, file_study_uids

    def _expand_archive_uploads(
        self,
        uploads: list[LocalImagingUploadPart],
        warnings: list[str],
    ) -> list[LocalImagingUploadPart]:
        expanded_uploads: list[LocalImagingUploadPart] = []
        for upload in uploads:
            if not self._is_zip_archive(upload):
                expanded_uploads.append(upload)
                continue

            expanded_uploads.extend(self._zip_upload_parts(upload, warnings))

        if len(expanded_uploads) > self._settings.local_imaging_max_files:
            raise HTTPException(
                status_code=413,
                detail=f"Too many files for local import after archive expansion. Limit is {self._settings.local_imaging_max_files}.",
            )
        return expanded_uploads

    def _zip_upload_parts(
        self,
        upload: LocalImagingUploadPart,
        warnings: list[str],
    ) -> list[LocalImagingUploadPart]:
        archive_path = self._safe_relative_path(upload.relative_path or upload.filename)
        archive_label = PurePosixPath(archive_path).name
        archive_base = self._archive_member_base_path(archive_path)
        archive_uploads: list[LocalImagingUploadPart] = []

        try:
            with zipfile.ZipFile(BytesIO(upload.data)) as archive:
                for member in archive.infolist():
                    if member.is_dir():
                        continue

                    member_path = self._safe_archive_member_path(member.filename)
                    if member_path is None:
                        warnings.append(f"Skipped unsafe member in archive {archive_label}.")
                        continue
                    if member.file_size > self._settings.local_imaging_max_file_bytes:
                        raise HTTPException(
                            status_code=413,
                            detail="One or more archive members exceed the local import size limit.",
                        )

                    try:
                        with archive.open(member) as member_stream:
                            member_data = member_stream.read(self._settings.local_imaging_max_file_bytes + 1)
                    except RuntimeError as exc:
                        raise HTTPException(
                            status_code=400,
                            detail=f"Archive {archive_label} contains an encrypted or unreadable member.",
                        ) from exc
                    if len(member_data) > self._settings.local_imaging_max_file_bytes:
                        raise HTTPException(
                            status_code=413,
                            detail="One or more archive members exceed the local import size limit.",
                        )

                    archive_uploads.append(
                        LocalImagingUploadPart(
                            filename=PurePosixPath(member_path).name,
                            content_type="application/octet-stream",
                            relative_path=f"{archive_base}/{member_path}",
                            data=member_data,
                        )
                    )
        except zipfile.BadZipFile as exc:
            raise HTTPException(status_code=400, detail=f"Archive {archive_label} could not be read.") from exc

        warnings.append(f"Expanded archive {archive_label} into {len(archive_uploads)} file(s).")
        return archive_uploads

    def _attach_paired_nifti_data(
        self,
        detected_files: list[_DetectedFile],
        unknown_files: list[_DetectedFile],
        warnings: list[str],
    ) -> tuple[list[_DetectedFile], list[_DetectedFile]]:
        data_files_by_key: dict[str, _DetectedFile] = {}
        for unknown_file in unknown_files:
            if self._extension(unknown_file.relative_path.lower()) != "img":
                continue
            key = self._paired_nifti_key(unknown_file.relative_path)
            if key:
                data_files_by_key[key] = unknown_file

        if not data_files_by_key:
            return detected_files, []

        linked_files: list[_DetectedFile] = []
        accepted_data_files: list[_DetectedFile] = []
        accepted_data_paths: set[str] = set()
        for detected_file in detected_files:
            if detected_file.format != "nifti":
                linked_files.append(detected_file)
                continue

            header = self._read_nifti_header_from_path(Path(detected_file.stored_path))
            if header is None or header.get("magic") != "ni1":
                linked_files.append(detected_file)
                continue

            key = self._paired_nifti_key(detected_file.relative_path)
            paired_data_file = data_files_by_key.get(key or "")
            if paired_data_file is None:
                warnings.append(
                    f"Paired NIFTI header {Path(detected_file.relative_path).name} was imported without its .img data file.",
                )
                linked_files.append(detected_file)
                continue

            linked_files.append(
                replace(
                    detected_file,
                    paired_stored_path=paired_data_file.stored_path,
                    paired_relative_path=paired_data_file.relative_path,
                )
            )
            if paired_data_file.stored_path not in accepted_data_paths:
                accepted_data_paths.add(paired_data_file.stored_path)
                accepted_data_files.append(
                    replace(
                        paired_data_file,
                        format="nifti-data",
                        modality="NIFTI",
                    )
                )

        return linked_files, accepted_data_files

    def _write_manifest(
        self,
        import_root: Path,
        import_id: str,
        detected_files: list[_DetectedFile],
        studies: list[LocalImagingImportedStudy],
        file_study_uids: dict[str, list[str]],
        warnings: list[str],
    ) -> None:
        file_entries = []
        for file in detected_files:
            local_study_uids = file_study_uids.get(file.stored_path, [])
            file_entries.append(
                {
                    "relativePath": file.relative_path,
                    "storedPath": file.stored_path,
                    "size": file.size,
                    "format": file.format,
                    "studyInstanceUID": file.study_instance_uid,
                    "localStudyInstanceUID": local_study_uids[0] if local_study_uids else None,
                    "localStudyInstanceUIDs": local_study_uids,
                    "seriesInstanceUID": file.series_instance_uid,
                    "sopInstanceUID": file.sop_instance_uid,
                    "modality": file.modality,
                    "pairedStoredPath": file.paired_stored_path,
                    "pairedRelativePath": file.paired_relative_path,
                }
            )

        manifest = {
            "importId": import_id,
            "acceptedFiles": len(detected_files),
            "studies": [study.model_dump(by_alias=True) for study in studies],
            "files": file_entries,
            "warnings": warnings,
        }
        (import_root / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    def list_dicom_instances(
        self,
        *,
        study_instance_uid: str | None = None,
        series_instance_uid: str | None = None,
        sop_instance_uid: str | None = None,
    ) -> list[LocalDicomInstance]:
        instances: list[LocalDicomInstance] = []
        for manifest in self._iter_manifests():
            for file_entry in manifest.get("files", []):
                if file_entry.get("format") != "dicom":
                    continue
                instance = LocalDicomInstance(
                    study_instance_uid=str(file_entry.get("studyInstanceUID") or ""),
                    series_instance_uid=str(file_entry.get("seriesInstanceUID") or ""),
                    sop_instance_uid=str(file_entry.get("sopInstanceUID") or ""),
                    stored_path=str(file_entry.get("storedPath") or ""),
                )
                if not all(
                    [instance.study_instance_uid, instance.series_instance_uid, instance.sop_instance_uid]
                ):
                    continue
                if study_instance_uid and instance.study_instance_uid != study_instance_uid:
                    continue
                if series_instance_uid and instance.series_instance_uid != series_instance_uid:
                    continue
                if sop_instance_uid and instance.sop_instance_uid != sop_instance_uid:
                    continue
                instances.append(instance)
        return instances

    def dicom_json_metadata(
        self,
        *,
        study_instance_uid: str,
        series_instance_uid: str | None = None,
        sop_instance_uid: str | None = None,
    ) -> list[dict]:
        return [
            self._dicom_json_for_instance(instance)
            for instance in self.list_dicom_instances(
                study_instance_uid=study_instance_uid,
                series_instance_uid=series_instance_uid,
                sop_instance_uid=sop_instance_uid,
            )
        ]

    def read_dicom_instance(
        self,
        study_instance_uid: str,
        series_instance_uid: str,
        sop_instance_uid: str,
    ) -> bytes:
        instance = self._require_instance(study_instance_uid, series_instance_uid, sop_instance_uid)
        return Path(instance.stored_path).read_bytes()

    def read_bulk_data(
        self,
        study_instance_uid: str,
        series_instance_uid: str,
        sop_instance_uid: str,
        tag: str,
    ) -> bytes:
        instance = self._require_instance(study_instance_uid, series_instance_uid, sop_instance_uid)
        dataset = pydicom.dcmread(instance.stored_path, force=False)
        try:
            data_element = dataset.get(Tag(tag))
        except Exception as exc:
            raise HTTPException(status_code=400, detail="Bulk data tag is invalid.") from exc
        if data_element is None:
            raise HTTPException(status_code=404, detail="Bulk data element was not found.")
        value = data_element.value
        if isinstance(value, bytes):
            return value
        if isinstance(value, bytearray):
            return bytes(value)
        raise HTTPException(status_code=415, detail="Requested element is not binary bulk data.")

    def read_frame(
        self,
        study_instance_uid: str,
        series_instance_uid: str,
        sop_instance_uid: str,
        frame_number: int,
    ) -> bytes:
        if frame_number < 1:
            raise HTTPException(status_code=400, detail="Frame numbers are one-based.")
        instance = self._require_instance(study_instance_uid, series_instance_uid, sop_instance_uid)
        dataset = pydicom.dcmread(instance.stored_path, force=False)
        pixel_data = getattr(dataset, "PixelData", None)
        if pixel_data is None:
            raise HTTPException(status_code=404, detail="Pixel data was not found for this instance.")

        number_of_frames = int(getattr(dataset, "NumberOfFrames", 1) or 1)
        if frame_number > number_of_frames:
            raise HTTPException(status_code=404, detail="Frame was not found.")

        frame_size = self._uncompressed_frame_size(dataset)
        if frame_size is None:
            if frame_number == 1:
                return bytes(pixel_data)
            raise HTTPException(status_code=415, detail="Compressed multi-frame retrieval is not available locally.")

        start = (frame_number - 1) * frame_size
        end = start + frame_size
        frame = bytes(pixel_data[start:end])
        if not frame:
            raise HTTPException(status_code=404, detail="Frame data was not found.")
        return frame

    def study_assets(self, study_instance_uid: str) -> LocalImagingStudyAssetsResponse:
        for manifest in self._iter_manifests():
            study = self._find_manifest_study(manifest, study_instance_uid)
            if study is None:
                continue

            file_entries = [
                (file_index, file_entry)
                for file_index, file_entry in enumerate(manifest.get("files", []))
                if self._manifest_file_belongs_to_study(file_entry, study, manifest)
            ]
            study_file_entries = [file_entry for _, file_entry in file_entries]
            assets = [
                self._asset_from_manifest_entry(
                    manifest=manifest,
                    file_entry_index=file_index,
                    file_entry=file_entry,
                    study_instance_uid=study_instance_uid,
                )
                for file_index, file_entry in file_entries
            ]
            findings, analysis_warnings = self._study_findings(study_file_entries)
            warnings = [str(warning) for warning in study.get("warnings", []) if warning]
            warnings.extend(analysis_warnings)
            formats = [str(file_format) for file_format in study.get("formats", []) if file_format]
            if not formats:
                formats = sorted({asset.format for asset in assets})

            return LocalImagingStudyAssetsResponse(
                study_instance_uid=study_instance_uid,
                archive_ref=str(study.get("archiveRef") or f"local://unknown/studies/{study_instance_uid}"),
                modality=str(study.get("modality") or "LOCAL"),
                description=str(study.get("description") or "Local imaging import"),
                file_count=int(study.get("fileCount") or len(assets)),
                formats=formats,
                summary=self._study_summary(formats, assets),
                findings=findings,
                assets=assets,
                warnings=warnings,
            )

        raise HTTPException(status_code=404, detail="Local imaging study was not found.")

    def preview_asset(
        self,
        study_instance_uid: str,
        asset_id: str,
        *,
        axis: str = "axial",
        slice_index: int | None = None,
    ) -> LocalImagingPreview:
        _, _, file_entry = self._resolve_asset_entry(study_instance_uid, asset_id)
        file_format = str(file_entry.get("format") or "unknown")

        media_type = PREVIEW_IMAGE_MEDIA_TYPES.get(file_format)
        if file_format == "nifti":
            return self._nifti_preview(file_entry, axis=axis, slice_index=slice_index)
        if file_format in TIFF_PREVIEW_FORMATS:
            return self._tiff_preview(file_entry)
        if media_type is None:
            raise HTTPException(status_code=415, detail="Local imaging asset preview is not available.")

        path = self._stored_file_path(file_entry)
        if path is None:
            raise HTTPException(status_code=404, detail="Local imaging asset is missing from storage.")

        try:
            return LocalImagingPreview(content=path.read_bytes(), media_type=media_type)
        except OSError as exc:
            raise HTTPException(status_code=404, detail="Local imaging asset is missing from storage.") from exc

    def study_analysis(self, study_instance_uid: str) -> LocalImagingStudyAnalysisResponse:
        for manifest in self._iter_manifests():
            study = self._find_manifest_study(manifest, study_instance_uid)
            if study is None:
                continue

            file_entries = [
                (file_index, file_entry)
                for file_index, file_entry in enumerate(manifest.get("files", []))
                if self._manifest_file_belongs_to_study(file_entry, study, manifest)
            ]
            analyses = [
                self._analysis_from_manifest_entry(
                    manifest=manifest,
                    file_entry_index=file_index,
                    file_entry=file_entry,
                )
                for file_index, file_entry in file_entries
            ]
            study_warnings = [str(warning) for warning in study.get("warnings", []) if warning]
            warning_count = sum(len(analysis.warnings) for analysis in analyses) + len(study_warnings)
            analyzed_count = sum(1 for analysis in analyses if analysis.metrics)
            summary = (
                f"Analyzed {analyzed_count} of {len(analyses)} local asset"
                f"{'' if len(analyses) == 1 else 's'} with backend technical checks."
            )
            if warning_count:
                summary = f"{summary} {warning_count} warning{'' if warning_count == 1 else 's'} returned."

            return LocalImagingStudyAnalysisResponse(
                study_instance_uid=study_instance_uid,
                analyzed_at=datetime.now(timezone.utc).isoformat(),
                summary=summary,
                analyses=analyses,
                warnings=study_warnings,
            )

        raise HTTPException(status_code=404, detail="Local imaging study was not found.")

    def _dicomdir_referenced_study_uids(
        self,
        detected_files: list[_DetectedFile],
        warnings: list[str],
    ) -> dict[str, set[str]]:
        dicomdir_study_uids: dict[str, set[str]] = {}
        dicomdir_files = [file for file in detected_files if file.format == "dicomdir"]
        if not dicomdir_files:
            return dicomdir_study_uids

        dicom_files_by_alias: dict[str, list[_DetectedFile]] = defaultdict(list)
        for file in detected_files:
            if file.format != "dicom" or not file.study_instance_uid:
                continue
            for alias in self._dicom_path_aliases(file.relative_path):
                dicom_files_by_alias[alias].append(file)

        for dicomdir_file in dicomdir_files:
            try:
                dataset = pydicom.dcmread(dicomdir_file.stored_path, stop_before_pixels=True)
            except Exception:
                warnings.append("DICOMDIR was accepted, but its directory records could not be read.")
                continue

            referenced = self._dicomdir_referenced_paths(dataset)
            missing_count = 0
            matched_study_uids: set[str] = set()
            for referenced_path in referenced:
                matched_files: dict[str, _DetectedFile] = {}
                for candidate in self._dicomdir_reference_candidates(
                    dicomdir_file.relative_path,
                    referenced_path,
                ):
                    for file in dicom_files_by_alias.get(candidate, []):
                        matched_files[file.stored_path] = file
                if not matched_files:
                    missing_count += 1
                    continue
                matched_study_uids.update(
                    file.study_instance_uid
                    for file in matched_files.values()
                    if file.study_instance_uid
                )
            if missing_count:
                warnings.append(
                    f"DICOMDIR references {missing_count} file(s) that were not included in the import.",
                )
            if matched_study_uids:
                dicomdir_study_uids[dicomdir_file.stored_path] = matched_study_uids

        return dicomdir_study_uids

    def _iter_manifests(self):
        storage_root = Path(self._settings.local_imaging_storage_dir)
        if not storage_root.exists():
            return
        for manifest_path in sorted(storage_root.glob("import-*/manifest.json")):
            try:
                yield json.loads(manifest_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue

    @staticmethod
    def _find_manifest_study(manifest: dict, study_instance_uid: str) -> dict | None:
        for study in manifest.get("studies", []):
            if str(study.get("studyInstanceUID") or "") == study_instance_uid:
                return study
        return None

    @staticmethod
    def _local_study_uids(file_entry: dict) -> set[str]:
        return {
            str(study_uid)
            for study_uid in file_entry.get("localStudyInstanceUIDs", []) or []
            if study_uid
        }

    @staticmethod
    def _manifest_file_belongs_to_study(file_entry: dict, study: dict, manifest: dict) -> bool:
        target_uid = str(study.get("studyInstanceUID") or "")
        local_study_uid = str(file_entry.get("localStudyInstanceUID") or "")
        local_study_uids = LocalImagingImporter._local_study_uids(file_entry)
        source_study_uid = str(file_entry.get("studyInstanceUID") or "")
        if (
            local_study_uid == target_uid
            or target_uid in local_study_uids
            or source_study_uid == target_uid
        ):
            return True

        file_format = str(file_entry.get("format") or "")
        study_formats = {str(format_name) for format_name in study.get("formats", [])}
        if file_format not in study_formats:
            return False

        manifest_studies = manifest.get("studies", []) or []
        if len(manifest_studies) == 1:
            return True
        if file_format == "dicomdir":
            return True
        return file_format != "dicom" and not source_study_uid

    def _asset_from_manifest_entry(
        self,
        *,
        manifest: dict,
        file_entry_index: int,
        file_entry: dict,
        study_instance_uid: str,
    ) -> LocalImagingStudyAsset:
        file_format = str(file_entry.get("format") or "unknown")
        local_study_uids = self._local_study_uids(file_entry)
        asset_study_uid = file_entry.get("studyInstanceUID")
        if not asset_study_uid and study_instance_uid in local_study_uids:
            asset_study_uid = study_instance_uid
        if not asset_study_uid:
            asset_study_uid = file_entry.get("localStudyInstanceUID")
        study_uid = str(asset_study_uid or "") or None
        series_uid = str(file_entry.get("seriesInstanceUID") or "") or None
        sop_uid = str(file_entry.get("sopInstanceUID") or "") or None
        viewer_supported = bool(file_format == "dicom" and study_uid and series_uid and sop_uid)
        asset_id = self._asset_id(manifest, file_entry_index)
        preview_supported = self._preview_supported(file_format)
        preview_slices = self._preview_slices(file_entry) if file_format == "nifti" else {}
        default_preview_axis = "axial" if preview_slices else None
        default_preview_slice = (
            max(0, preview_slices["axial"] // 2)
            if "axial" in preview_slices
            else None
        )
        return LocalImagingStudyAsset(
            asset_id=asset_id,
            relative_path=str(file_entry.get("relativePath") or "local-file"),
            format=file_format,
            modality=str(file_entry.get("modality") or "") or None,
            size=int(file_entry.get("size") or 0),
            study_instance_uid=study_uid,
            series_instance_uid=series_uid,
            sop_instance_uid=sop_uid,
            analysis_supported=file_format in {"dicom", "dicomdir", "nifti", "nrrd", *COMMON_IMAGE_EXTENSIONS},
            viewer_supported=viewer_supported,
            preview_supported=preview_supported,
            preview_url=(
                f"/api/local-imaging/studies/{study_instance_uid}/assets/{asset_id}/preview"
                if preview_supported
                else None
            ),
            preview_slices=preview_slices,
            default_preview_axis=default_preview_axis,
            default_preview_slice=default_preview_slice,
        )

    def _resolve_asset_entry(
        self,
        study_instance_uid: str,
        asset_id: str,
    ) -> tuple[dict, int, dict]:
        parsed = self._parse_asset_id(asset_id)
        if parsed is None:
            raise HTTPException(status_code=404, detail="Local imaging asset was not found.")

        import_id, file_index = parsed
        for manifest in self._iter_manifests():
            if str(manifest.get("importId") or "") != import_id:
                continue
            study = self._find_manifest_study(manifest, study_instance_uid)
            if study is None:
                raise HTTPException(status_code=404, detail="Local imaging study was not found.")
            files = manifest.get("files", []) or []
            if file_index < 0 or file_index >= len(files):
                raise HTTPException(status_code=404, detail="Local imaging asset was not found.")
            file_entry = files[file_index]
            if not self._manifest_file_belongs_to_study(file_entry, study, manifest):
                raise HTTPException(status_code=404, detail="Local imaging asset was not found.")
            return manifest, file_index, file_entry

        raise HTTPException(status_code=404, detail="Local imaging asset was not found.")

    def _analysis_from_manifest_entry(
        self,
        *,
        manifest: dict,
        file_entry_index: int,
        file_entry: dict,
    ) -> LocalImagingAssetAnalysis:
        file_format = str(file_entry.get("format") or "unknown")
        asset_id = self._asset_id(manifest, file_entry_index)
        relative_path = str(file_entry.get("relativePath") or "local-file")
        path = self._stored_file_path(file_entry)
        metrics: list[LocalImagingStudyFinding] = []
        warnings: list[str] = []
        summary = "Stored for backend analysis."

        if path is None:
            return LocalImagingAssetAnalysis(
                asset_id=asset_id,
                relative_path=relative_path,
                format=file_format,
                summary="Local asset is missing from private storage.",
                warnings=["Local asset is missing from private storage."],
            )

        if file_format == "dicom":
            summary, metrics, warnings = self._analyze_dicom_asset(path)
        elif file_format == "nifti":
            summary, metrics, warnings = self._analyze_nifti_asset(file_entry)
        elif file_format == "nifti-data":
            summary = "Paired NIFTI voxel data stored; analyzed through the matching .hdr asset when present."
        elif file_format == "nrrd":
            summary, metrics, warnings = self._analyze_nrrd_asset(path)
        elif file_format in COMMON_IMAGE_EXTENSIONS:
            summary, metrics, warnings = self._analyze_common_image_asset(file_format, path)
        elif file_format == "dicomdir":
            summary = "DICOMDIR index accepted; referenced DICOM instances are analyzed separately."
            metrics = [LocalImagingStudyFinding(label="Directory index", value="DICOMDIR")]
        else:
            summary = "No local technical analysis is available for this asset format."
            warnings = ["Asset format is not supported by the local technical analyzer."]

        return LocalImagingAssetAnalysis(
            asset_id=asset_id,
            relative_path=relative_path,
            format=file_format,
            summary=summary,
            metrics=metrics,
            warnings=warnings,
        )

    def _analyze_dicom_asset(
        self,
        path: Path,
    ) -> tuple[str, list[LocalImagingStudyFinding], list[str]]:
        warnings: list[str] = []
        try:
            dataset = pydicom.dcmread(path, force=False)
        except Exception:
            return "DICOM metadata could not be read.", [], ["DICOM metadata could not be read."]

        metrics = self._dicom_metadata_metrics(dataset)
        pixel_data = getattr(dataset, "PixelData", None)
        if pixel_data is None:
            warnings.append("DICOM pixel data is not present.")
            return "DICOM metadata analyzed; pixel data was not present.", metrics, warnings

        transfer_syntax = getattr(getattr(dataset, "file_meta", None), "TransferSyntaxUID", None)
        if bool(getattr(transfer_syntax, "is_compressed", False)):
            warnings.append("Compressed DICOM pixel data is not analyzed in the local fast path.")
            return "DICOM metadata analyzed; compressed pixels were skipped.", metrics, warnings

        pixel_metrics, pixel_warnings = self._dicom_pixel_metrics(dataset, bytes(pixel_data))
        metrics.extend(pixel_metrics)
        warnings.extend(pixel_warnings)
        if pixel_metrics:
            return "DICOM metadata and uncompressed pixel sample analyzed locally.", metrics, warnings
        return "DICOM metadata analyzed locally.", metrics, warnings

    def _analyze_nifti_asset(
        self,
        file_entry: dict,
    ) -> tuple[str, list[LocalImagingStudyFinding], list[str]]:
        payload = self._read_nifti_file_bytes(file_entry)
        if payload is None:
            return "NIFTI asset could not be read.", [], ["NIFTI asset could not be read."]

        header = self._parse_nifti_header(payload[:352])
        if header is None:
            return "NIFTI header could not be read.", [], ["NIFTI header could not be read."]

        dimensions = [int(value) for value in header.get("dimensions", [])]
        datatype = int(header.get("datatypeCode") or 0)
        bitpix = int(header.get("bitsPerVoxel") or 0)
        metrics = [
            LocalImagingStudyFinding(
                label="Volume dimensions",
                value=" x ".join(str(value) for value in dimensions) if dimensions else "Unavailable",
            ),
            LocalImagingStudyFinding(label="Datatype code", value=str(datatype)),
            LocalImagingStudyFinding(label="Bits per voxel", value=str(bitpix)),
        ]

        voxel_count = self._dimension_product(dimensions)
        if voxel_count > 0:
            metrics.append(LocalImagingStudyFinding(label="Voxel count", value=str(voxel_count)))

        decoder = NIFTI_NUMERIC_DATATYPES.get(datatype)
        if decoder is None:
            return (
                "NIFTI header analyzed; voxel statistics are unavailable for this datatype.",
                metrics,
                ["NIFTI datatype is not supported by the local technical analyzer."],
            )

        voxel_offset = float(header.get("voxOffset") or 352.0)
        if not math.isfinite(voxel_offset) or voxel_offset < 0:
            voxel_offset = 352.0
        data_offset = max(int(voxel_offset), 352)
        if data_offset >= len(payload) or voxel_count <= 0:
            return (
                "NIFTI header analyzed; voxel data was not available.",
                metrics,
                ["NIFTI voxel data is missing."],
            )

        format_code, bytes_per_voxel = decoder
        values = self._sample_numeric_values(
            payload,
            data_offset=data_offset,
            total_values=voxel_count,
            endian=str(header.get("endian") or "<"),
            format_code=format_code,
            bytes_per_value=bytes_per_voxel,
        )
        if not values:
            return (
                "NIFTI header analyzed; voxel statistics could not be computed.",
                metrics,
                ["NIFTI voxel data is incomplete."],
            )

        metrics.extend(self._numeric_metrics(values, voxel_count))
        return "NIFTI header and voxel intensity sample analyzed locally.", metrics, []

    def _analyze_nrrd_asset(
        self,
        path: Path,
    ) -> tuple[str, list[LocalImagingStudyFinding], list[str]]:
        try:
            payload = path.read_bytes()
        except OSError:
            return "NRRD asset could not be read.", [], ["NRRD asset could not be read."]

        parsed = self._parse_nrrd(payload)
        if parsed is None:
            return "NRRD header could not be read.", [], ["NRRD header could not be read."]

        header, data_offset = parsed
        metrics = self._nrrd_header_metrics(header)
        warnings: list[str] = []

        data_file = str(header.get("dataFile") or "").strip()
        if data_file:
            warnings.append("Detached NRRD data files are not analyzed in the local fast path yet.")
            return "NRRD header analyzed; detached voxel data was not read.", metrics, warnings

        encoding = str(header.get("encoding") or "raw").lower()
        data_payload = payload[data_offset:]
        if encoding in {"gzip", "gz"}:
            try:
                data_payload = gzip.decompress(data_payload)
            except (OSError, EOFError, gzip.BadGzipFile):
                warnings.append("NRRD gzip voxel data could not be decompressed.")
                return "NRRD header analyzed; gzip voxel data could not be read.", metrics, warnings
        elif encoding != "raw":
            warnings.append(f"NRRD encoding {encoding} is not supported by the local technical analyzer.")
            return "NRRD header analyzed; voxel statistics are unavailable for this encoding.", metrics, warnings

        sizes = [int(size) for size in header.get("sizes", []) if int(size) > 0]
        voxel_count = self._dimension_product(sizes)
        if voxel_count <= 0:
            warnings.append("NRRD sizes are missing or invalid.")
            return "NRRD header analyzed; voxel count was unavailable.", metrics, warnings

        decoder = self._nrrd_numeric_decoder(str(header.get("type") or ""))
        if decoder is None:
            warnings.append("NRRD type is not supported by the local technical analyzer.")
            return "NRRD header analyzed; voxel statistics are unavailable for this type.", metrics, warnings

        format_code, bytes_per_value = decoder
        endian = "<" if str(header.get("endian") or "little").lower() != "big" else ">"
        values = self._sample_numeric_values(
            data_payload,
            data_offset=0,
            total_values=voxel_count,
            endian=endian,
            format_code=format_code,
            bytes_per_value=bytes_per_value,
        )
        if not values:
            warnings.append("NRRD voxel data is missing or incomplete.")
            return "NRRD header analyzed; voxel statistics could not be computed.", metrics, warnings

        metrics.extend(self._numeric_metrics(values, voxel_count))
        return "NRRD header and voxel intensity sample analyzed locally.", metrics, warnings

    def _analyze_common_image_asset(
        self,
        file_format: str,
        path: Path,
    ) -> tuple[str, list[LocalImagingStudyFinding], list[str]]:
        try:
            payload = path.read_bytes()
        except OSError:
            return "Image asset could not be read.", [], ["Image asset could not be read."]

        metrics, warnings = self._common_image_metrics(file_format, payload)
        if metrics:
            return "Image header analyzed locally.", metrics, warnings
        return "Image header could not be analyzed.", metrics, warnings

    def _dicom_metadata_metrics(self, dataset) -> list[LocalImagingStudyFinding]:
        metrics: list[LocalImagingStudyFinding] = []
        try:
            rows = int(dataset.Rows)
            columns = int(dataset.Columns)
            metrics.append(LocalImagingStudyFinding(label="Frame dimensions", value=f"{columns} x {rows}"))
        except Exception:
            pass

        for label, attribute in (
            ("Frames", "NumberOfFrames"),
            ("Samples per pixel", "SamplesPerPixel"),
            ("Bits allocated", "BitsAllocated"),
        ):
            value = getattr(dataset, attribute, None)
            if value is not None:
                metrics.append(LocalImagingStudyFinding(label=label, value=str(value)))

        return metrics

    def _dicom_pixel_metrics(
        self,
        dataset,
        pixel_data: bytes,
    ) -> tuple[list[LocalImagingStudyFinding], list[str]]:
        warnings: list[str] = []
        try:
            bits_allocated = int(dataset.BitsAllocated)
            pixel_representation = int(getattr(dataset, "PixelRepresentation", 0) or 0)
        except Exception:
            return [], ["DICOM pixel layout is incomplete."]

        decoder = self._dicom_pixel_decoder(bits_allocated, pixel_representation)
        if decoder is None:
            return [], ["DICOM pixel bit depth is not supported by the local technical analyzer."]

        format_code, bytes_per_value = decoder
        frame_size = self._uncompressed_frame_size(dataset)
        total_values = len(pixel_data) // bytes_per_value
        if frame_size:
            total_values = min(total_values, frame_size * int(getattr(dataset, "NumberOfFrames", 1) or 1) // bytes_per_value)
        if total_values <= 0:
            return [], ["DICOM pixel data is empty."]

        endian = "<" if bool(getattr(dataset, "is_little_endian", True)) else ">"
        values = self._sample_numeric_values(
            pixel_data,
            data_offset=0,
            total_values=total_values,
            endian=endian,
            format_code=format_code,
            bytes_per_value=bytes_per_value,
        )
        if not values:
            return [], ["DICOM pixel data could not be sampled."]
        return self._numeric_metrics(values, total_values), warnings

    @staticmethod
    def _dicom_pixel_decoder(bits_allocated: int, pixel_representation: int) -> tuple[str, int] | None:
        if bits_allocated == 8:
            return ("b" if pixel_representation else "B", 1)
        if bits_allocated == 16:
            return ("h" if pixel_representation else "H", 2)
        if bits_allocated == 32:
            return ("i" if pixel_representation else "I", 4)
        return None

    @staticmethod
    def _sample_numeric_values(
        payload: bytes,
        *,
        data_offset: int,
        total_values: int,
        endian: str,
        format_code: str,
        bytes_per_value: int,
    ) -> list[float]:
        if total_values <= 0 or bytes_per_value <= 0:
            return []

        step = max(1, math.ceil(total_values / LOCAL_ANALYSIS_MAX_VALUES))
        unpack_format = f"{endian}{format_code}"
        values: list[float] = []
        for value_index in range(0, total_values, step):
            byte_index = data_offset + (value_index * bytes_per_value)
            if byte_index + bytes_per_value > len(payload):
                break
            try:
                value = float(struct.unpack_from(unpack_format, payload, byte_index)[0])
            except struct.error:
                break
            if math.isfinite(value):
                values.append(value)
        return values

    def _numeric_metrics(
        self,
        values: list[float],
        total_values: int,
    ) -> list[LocalImagingStudyFinding]:
        minimum = min(values)
        maximum = max(values)
        mean = sum(values) / len(values)
        metrics = [
            LocalImagingStudyFinding(
                label="Intensity range",
                value=f"{self._format_number(minimum)} to {self._format_number(maximum)}",
            ),
            LocalImagingStudyFinding(label="Mean intensity", value=self._format_number(mean)),
            LocalImagingStudyFinding(label="Analyzed values", value=str(total_values)),
        ]
        if len(values) < total_values:
            metrics.append(LocalImagingStudyFinding(label="Sampled values", value=str(len(values))))
        return metrics

    def _common_image_metrics(
        self,
        file_format: str,
        payload: bytes,
    ) -> tuple[list[LocalImagingStudyFinding], list[str]]:
        if file_format == "png":
            return self._png_metrics(payload)
        if file_format in {"jpg", "jpeg"}:
            return self._jpeg_metrics(payload)
        if file_format == "gif":
            return self._gif_metrics(payload)
        if file_format == "bmp":
            return self._bmp_metrics(payload)
        if file_format in {"tif", "tiff"}:
            return self._tiff_metrics(payload)
        return [], ["Image format is not supported by the local technical analyzer."]

    @staticmethod
    def _png_metrics(payload: bytes) -> tuple[list[LocalImagingStudyFinding], list[str]]:
        if len(payload) < 29 or not payload.startswith(b"\x89PNG\r\n\x1a\n"):
            return [], ["PNG header could not be read."]
        width = int.from_bytes(payload[16:20], "big")
        height = int.from_bytes(payload[20:24], "big")
        bit_depth = payload[24]
        color_type = payload[25]
        return [
            LocalImagingStudyFinding(label="Image dimensions", value=f"{width} x {height}"),
            LocalImagingStudyFinding(label="Bit depth", value=str(bit_depth)),
            LocalImagingStudyFinding(label="Color type", value=str(color_type)),
        ], []

    @staticmethod
    def _gif_metrics(payload: bytes) -> tuple[list[LocalImagingStudyFinding], list[str]]:
        if len(payload) < 10 or payload[:6] not in {b"GIF87a", b"GIF89a"}:
            return [], ["GIF header could not be read."]
        width = int.from_bytes(payload[6:8], "little")
        height = int.from_bytes(payload[8:10], "little")
        return [LocalImagingStudyFinding(label="Image dimensions", value=f"{width} x {height}")], []

    @staticmethod
    def _bmp_metrics(payload: bytes) -> tuple[list[LocalImagingStudyFinding], list[str]]:
        if len(payload) < 30 or not payload.startswith(b"BM"):
            return [], ["BMP header could not be read."]
        width = int.from_bytes(payload[18:22], "little", signed=True)
        height = int.from_bytes(payload[22:26], "little", signed=True)
        bits_per_pixel = int.from_bytes(payload[28:30], "little")
        return [
            LocalImagingStudyFinding(label="Image dimensions", value=f"{abs(width)} x {abs(height)}"),
            LocalImagingStudyFinding(label="Bits per pixel", value=str(bits_per_pixel)),
        ], []

    @staticmethod
    def _jpeg_metrics(payload: bytes) -> tuple[list[LocalImagingStudyFinding], list[str]]:
        if len(payload) < 4 or not payload.startswith(b"\xff\xd8"):
            return [], ["JPEG header could not be read."]
        index = 2
        while index + 9 < len(payload):
            if payload[index] != 0xFF:
                index += 1
                continue
            marker = payload[index + 1]
            index += 2
            if marker in {0xD8, 0xD9}:
                continue
            if index + 2 > len(payload):
                break
            segment_length = int.from_bytes(payload[index:index + 2], "big")
            if segment_length < 2 or index + segment_length > len(payload):
                break
            if marker in {
                0xC0,
                0xC1,
                0xC2,
                0xC3,
                0xC5,
                0xC6,
                0xC7,
                0xC9,
                0xCA,
                0xCB,
                0xCD,
                0xCE,
                0xCF,
            }:
                precision = payload[index + 2]
                height = int.from_bytes(payload[index + 3:index + 5], "big")
                width = int.from_bytes(payload[index + 5:index + 7], "big")
                components = payload[index + 7]
                return [
                    LocalImagingStudyFinding(label="Image dimensions", value=f"{width} x {height}"),
                    LocalImagingStudyFinding(label="Precision", value=str(precision)),
                    LocalImagingStudyFinding(label="Color components", value=str(components)),
                ], []
            index += segment_length
        return [], ["JPEG dimensions could not be read."]

    @staticmethod
    def _tiff_header_tags(payload: bytes) -> tuple[dict[int, int] | None, list[str]]:
        if len(payload) < 8:
            return None, ["TIFF header could not be read."]
        if payload[:2] == b"II":
            endian = "little"
        elif payload[:2] == b"MM":
            endian = "big"
        else:
            return None, ["TIFF byte order could not be read."]
        if int.from_bytes(payload[2:4], endian) != 42:
            return None, ["TIFF magic value could not be read."]
        ifd_offset = int.from_bytes(payload[4:8], endian)
        if ifd_offset + 2 > len(payload):
            return None, ["TIFF image directory could not be read."]
        entry_count = int.from_bytes(payload[ifd_offset:ifd_offset + 2], endian)
        tags: dict[int, int] = {}
        for index in range(entry_count):
            entry_offset = ifd_offset + 2 + (index * 12)
            if entry_offset + 12 > len(payload):
                break
            tag = int.from_bytes(payload[entry_offset:entry_offset + 2], endian)
            field_type = int.from_bytes(payload[entry_offset + 2:entry_offset + 4], endian)
            count = int.from_bytes(payload[entry_offset + 4:entry_offset + 8], endian)
            raw_value = payload[entry_offset + 8:entry_offset + 12]
            if field_type == 3 and count == 1:
                tags[tag] = int.from_bytes(raw_value[:2], endian)
            elif field_type == 4 and count == 1:
                tags[tag] = int.from_bytes(raw_value, endian)
        return tags, []

    @staticmethod
    def _tiff_metrics(payload: bytes) -> tuple[list[LocalImagingStudyFinding], list[str]]:
        tags, warnings = LocalImagingImporter._tiff_header_tags(payload)
        if tags is None:
            return [], warnings
        width = tags.get(256)
        height = tags.get(257)
        metrics: list[LocalImagingStudyFinding] = []
        if width and height:
            metrics.append(LocalImagingStudyFinding(label="Image dimensions", value=f"{width} x {height}"))
        if 258 in tags:
            metrics.append(LocalImagingStudyFinding(label="Bits per sample", value=str(tags[258])))
        if metrics:
            return metrics, []
        return [], ["TIFF dimensions could not be read."]

    def _study_findings(
        self,
        file_entries: list[dict],
    ) -> tuple[list[LocalImagingStudyFinding], list[str]]:
        findings: list[LocalImagingStudyFinding] = []
        warnings: list[str] = []
        total_size = sum(int(file_entry.get("size") or 0) for file_entry in file_entries)
        findings.append(LocalImagingStudyFinding(label="Files", value=str(len(file_entries))))
        findings.append(LocalImagingStudyFinding(label="Stored size", value=self._human_size(total_size)))

        dicom_entries = [entry for entry in file_entries if entry.get("format") == "dicom"]
        if dicom_entries:
            series_uids = {
                str(entry.get("seriesInstanceUID"))
                for entry in dicom_entries
                if entry.get("seriesInstanceUID")
            }
            findings.append(LocalImagingStudyFinding(label="DICOM instances", value=str(len(dicom_entries))))
            findings.append(LocalImagingStudyFinding(label="DICOM series", value=str(len(series_uids))))

        dicomdir_entries = [entry for entry in file_entries if entry.get("format") == "dicomdir"]
        if dicomdir_entries:
            findings.append(LocalImagingStudyFinding(label="DICOMDIR files", value=str(len(dicomdir_entries))))

        nifti_entries = [entry for entry in file_entries if entry.get("format") == "nifti"]
        for nifti_entry in nifti_entries:
            header = self._read_nifti_header(nifti_entry)
            relative_path = str(nifti_entry.get("relativePath") or "NIFTI volume")
            if header is None:
                warnings.append(f"NIFTI header could not be read for {Path(relative_path).name}.")
                continue

            dimensions = header["dimensions"]
            dimension_text = " x ".join(str(value) for value in dimensions) if dimensions else "header detected"
            datatype = header["datatypeCode"]
            bitpix = header["bitsPerVoxel"]
            findings.append(
                LocalImagingStudyFinding(
                    label="NIFTI volume",
                    value=f"{dimension_text} voxels; datatype {datatype}; {bitpix} bits/voxel",
                )
            )

        paired_nifti_data_entries = [
            entry for entry in file_entries if entry.get("format") == "nifti-data"
        ]
        if paired_nifti_data_entries:
            findings.append(
                LocalImagingStudyFinding(
                    label="Paired NIFTI data files",
                    value=str(len(paired_nifti_data_entries)),
                )
            )

        image_entries = [
            entry
            for entry in file_entries
            if str(entry.get("format") or "") in COMMON_IMAGE_EXTENSIONS
        ]
        if image_entries:
            findings.append(LocalImagingStudyFinding(label="Image files", value=str(len(image_entries))))

        nrrd_entries = [entry for entry in file_entries if entry.get("format") == "nrrd"]
        for nrrd_entry in nrrd_entries:
            parsed = self._read_nrrd_header(nrrd_entry)
            relative_path = str(nrrd_entry.get("relativePath") or "NRRD volume")
            if parsed is None:
                warnings.append(f"NRRD header could not be read for {Path(relative_path).name}.")
                continue

            sizes = [int(value) for value in parsed.get("sizes", [])]
            size_text = " x ".join(str(value) for value in sizes) if sizes else "header detected"
            nrrd_type = str(parsed.get("type") or "unknown")
            encoding = str(parsed.get("encoding") or "raw")
            findings.append(
                LocalImagingStudyFinding(
                    label="NRRD volume",
                    value=f"{size_text} voxels; type {nrrd_type}; encoding {encoding}",
                )
            )

        return findings, warnings

    def _read_nifti_header(self, file_entry: dict) -> dict[str, object] | None:
        path = self._stored_file_path(file_entry)
        if path is None:
            return None

        lower_name = str(file_entry.get("relativePath") or path.name).lower()
        if lower_name.endswith(".hdr"):
            return self._read_nifti_header_from_path(path)

        try:
            if lower_name.endswith(".nii.gz") or path.name.lower().endswith(".gz"):
                with gzip.open(path, "rb") as handle:
                    header = handle.read(352)
            else:
                with path.open("rb") as handle:
                    header = handle.read(352)
        except (OSError, EOFError, gzip.BadGzipFile):
            return None

        return self._parse_nifti_header(header)

    def _read_nifti_header_from_path(self, path: Path) -> dict[str, object] | None:
        try:
            with path.open("rb") as handle:
                header = handle.read(352)
        except OSError:
            return None
        return self._parse_nifti_header(header)

    def _read_nrrd_header(self, file_entry: dict) -> dict[str, object] | None:
        path = self._stored_file_path(file_entry)
        if path is None:
            return None

        try:
            payload = path.read_bytes()
        except OSError:
            return None

        parsed = self._parse_nrrd(payload)
        if parsed is None:
            return None
        header, _ = parsed
        return header

    def _preview_slices(self, file_entry: dict) -> dict[str, int]:
        header = self._read_nifti_header(file_entry)
        if header is None:
            return {}
        return self._axis_slices_for_dimensions([int(value) for value in header.get("dimensions", [])])

    @staticmethod
    def _axis_slices_for_dimensions(dimensions: list[int]) -> dict[str, int]:
        if len(dimensions) < 2 or dimensions[0] < 1 or dimensions[1] < 1:
            return {}
        if len(dimensions) < 3 or dimensions[2] < 1:
            return {"axial": 1}
        return {
            "axial": int(dimensions[2]),
            "coronal": int(dimensions[1]),
            "sagittal": int(dimensions[0]),
        }

    def _nifti_preview(
        self,
        file_entry: dict,
        *,
        axis: str = "axial",
        slice_index: int | None = None,
    ) -> LocalImagingPreview:
        payload = self._read_nifti_file_bytes(file_entry)
        if payload is None:
            raise HTTPException(status_code=422, detail="NIFTI asset could not be read.")

        header = self._parse_nifti_header(payload[:352])
        if header is None:
            raise HTTPException(status_code=422, detail="NIFTI header could not be read.")

        dimensions = [int(value) for value in header.get("dimensions", [])]
        if len(dimensions) < 2:
            raise HTTPException(status_code=422, detail="NIFTI dimensions are not previewable.")

        width = dimensions[0]
        height = dimensions[1]
        depth = dimensions[2] if len(dimensions) >= 3 else 1
        if width < 1 or height < 1 or depth < 1:
            raise HTTPException(status_code=422, detail="NIFTI dimensions are not previewable.")
        axis_slices = self._axis_slices_for_dimensions(dimensions)
        normalized_axis = axis.strip().lower() or "axial"
        if normalized_axis not in axis_slices:
            raise HTTPException(status_code=400, detail="NIFTI preview axis is invalid.")
        max_slices = axis_slices[normalized_axis]
        selected_slice = max_slices // 2 if slice_index is None else slice_index
        if selected_slice < 0 or selected_slice >= max_slices:
            raise HTTPException(status_code=400, detail="NIFTI preview slice is out of range.")

        datatype = int(header.get("datatypeCode") or 0)
        decoder = NIFTI_NUMERIC_DATATYPES.get(datatype)
        if decoder is None:
            raise HTTPException(status_code=415, detail="NIFTI datatype is not previewable.")

        voxel_offset = float(header.get("voxOffset") or 352.0)
        if not math.isfinite(voxel_offset) or voxel_offset < 0:
            voxel_offset = 352.0
        data_offset = max(int(voxel_offset), 352)
        if data_offset >= len(payload):
            raise HTTPException(status_code=422, detail="NIFTI voxel data is missing.")

        format_code, bytes_per_voxel = decoder
        svg = self._nifti_slice_svg(
            payload=payload,
            data_offset=data_offset,
            endian=str(header.get("endian") or "<"),
            format_code=format_code,
            bytes_per_voxel=bytes_per_voxel,
            width=width,
            height=height,
            depth=depth,
            axis=normalized_axis,
            slice_index=selected_slice,
        )
        return LocalImagingPreview(content=svg, media_type="image/svg+xml")

    def _tiff_preview(self, file_entry: dict) -> LocalImagingPreview:
        path = self._stored_file_path(file_entry)
        if path is None:
            raise HTTPException(status_code=404, detail="Local imaging asset is missing from storage.")

        try:
            payload = path.read_bytes()
        except OSError as exc:
            raise HTTPException(status_code=404, detail="Local imaging asset is missing from storage.") from exc

        tags, warnings = self._tiff_header_tags(payload)
        if tags is None:
            raise HTTPException(
                status_code=422,
                detail=warnings[0] if warnings else "TIFF header could not be read.",
            )

        width = tags.get(256)
        height = tags.get(257)
        if not width or not height or width < 1 or height < 1:
            raise HTTPException(status_code=422, detail="TIFF dimensions are not previewable.")

        svg = self._tiff_header_preview_svg(
            width=width,
            height=height,
            bits_per_sample=tags.get(258),
        )
        return LocalImagingPreview(content=svg, media_type="image/svg+xml")

    @staticmethod
    def _tiff_header_preview_svg(
        *,
        width: int,
        height: int,
        bits_per_sample: int | None,
    ) -> bytes:
        preview_box_width = 224
        preview_box_height = 112
        scale = min(preview_box_width / width, preview_box_height / height)
        display_width = max(10, min(preview_box_width, round(width * scale)))
        display_height = max(10, min(preview_box_height, round(height * scale)))
        display_x = 48 + ((preview_box_width - display_width) // 2)
        display_y = 30 + ((preview_box_height - display_height) // 2)
        bits_text = f"{bits_per_sample} bits/sample" if bits_per_sample else "bits/sample unavailable"
        svg = (
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 220" role="img">'
            f'<title>TIFF header preview {width} x {height}</title>'
            '<rect width="320" height="220" fill="#020617"/>'
            '<rect x="24" y="20" width="272" height="132" rx="8" fill="#0f172a" stroke="#334155"/>'
            f'<rect x="{display_x}" y="{display_y}" width="{display_width}" height="{display_height}" '
            'fill="#1e293b" stroke="#67e8f9" stroke-width="2"/>'
            '<path d="M48 142 L272 30" stroke="#334155" stroke-width="1" opacity="0.65"/>'
            '<path d="M48 30 L272 142" stroke="#334155" stroke-width="1" opacity="0.65"/>'
            '<text x="160" y="178" fill="#cffafe" font-family="Arial, sans-serif" '
            'font-size="18" text-anchor="middle">TIFF header preview</text>'
            f'<text x="160" y="200" fill="#94a3b8" font-family="Arial, sans-serif" '
            f'font-size="14" text-anchor="middle">{width} x {height} pixels; {bits_text}</text>'
            "</svg>"
        )
        return svg.encode("utf-8")

    @staticmethod
    def _nifti_plane_dimensions(
        *,
        width: int,
        height: int,
        depth: int,
        axis: str,
    ) -> tuple[int, int]:
        if axis == "coronal":
            return width, depth
        if axis == "sagittal":
            return height, depth
        return width, height

    @staticmethod
    def _nifti_voxel_index(
        *,
        x: int,
        y: int,
        width: int,
        height: int,
        axis: str,
        slice_index: int,
    ) -> int:
        if axis == "coronal":
            z = y
            return (z * width * height) + (slice_index * width) + x
        if axis == "sagittal":
            z = y
            return (z * width * height) + (x * width) + slice_index
        z = slice_index
        return (z * width * height) + (y * width) + x

    def _read_nifti_file_bytes(self, file_entry: dict) -> bytes | None:
        path = self._stored_file_path(file_entry)
        if path is None:
            return None

        lower_name = str(file_entry.get("relativePath") or path.name).lower()
        try:
            if lower_name.endswith(".nii.gz") or path.name.lower().endswith(".gz"):
                with gzip.open(path, "rb") as handle:
                    return handle.read()
            payload = path.read_bytes()
            header = self._parse_nifti_header(payload[:352])
            if header is not None and header.get("magic") == "ni1":
                paired_path = self._paired_stored_file_path(file_entry)
                if paired_path is None:
                    return payload
                header_payload = payload[:352].ljust(352, b"\x00")
                return header_payload + paired_path.read_bytes()
            return payload
        except (OSError, EOFError, gzip.BadGzipFile):
            return None

    def _nifti_slice_svg(
        self,
        *,
        payload: bytes,
        data_offset: int,
        endian: str,
        format_code: str,
        bytes_per_voxel: int,
        width: int,
        height: int,
        depth: int,
        axis: str,
        slice_index: int,
    ) -> bytes:
        plane_width, plane_height = self._nifti_plane_dimensions(
            width=width,
            height=height,
            depth=depth,
            axis=axis,
        )
        x_step = max(1, math.ceil(plane_width / NIFTI_PREVIEW_MAX_DIMENSION))
        y_step = max(1, math.ceil(plane_height / NIFTI_PREVIEW_MAX_DIMENSION))
        values: list[list[float]] = []
        flat_values: list[float] = []
        unpack_format = f"{endian}{format_code}"

        for y in range(0, plane_height, y_step):
            row: list[float] = []
            for x in range(0, plane_width, x_step):
                voxel_index = self._nifti_voxel_index(
                    x=x,
                    y=y,
                    width=width,
                    height=height,
                    axis=axis,
                    slice_index=slice_index,
                )
                byte_index = data_offset + (voxel_index * bytes_per_voxel)
                if byte_index + bytes_per_voxel > len(payload):
                    raise HTTPException(status_code=422, detail="NIFTI voxel data is incomplete.")
                try:
                    value = float(struct.unpack_from(unpack_format, payload, byte_index)[0])
                except struct.error as exc:
                    raise HTTPException(status_code=422, detail="NIFTI voxel data is incomplete.") from exc
                if not math.isfinite(value):
                    value = 0.0
                row.append(value)
                flat_values.append(value)
            values.append(row)

        if not values or not values[0] or not flat_values:
            raise HTTPException(status_code=422, detail="NIFTI dimensions are not previewable.")

        minimum = min(flat_values)
        maximum = max(flat_values)
        span = maximum - minimum
        rects: list[str] = []
        for y, row in enumerate(values):
            for x, value in enumerate(row):
                shade = 128 if span <= 0 else round(((value - minimum) / span) * 255)
                shade = max(0, min(255, int(shade)))
                fill = f"#{shade:02x}{shade:02x}{shade:02x}"
                rects.append(f'<rect x="{x}" y="{y}" width="1" height="1" fill="{fill}"/>')

        sample_width = len(values[0])
        sample_height = len(values)
        svg = (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {sample_width} {sample_height}" '
            'shape-rendering="crispEdges" preserveAspectRatio="none">'
            f'<title>NIFTI {axis} slice {slice_index + 1} preview</title>'
            '<rect width="100%" height="100%" fill="#000000"/>'
            f'{"".join(rects)}</svg>'
        )
        return svg.encode("utf-8")

    def _stored_file_path(self, file_entry: dict) -> Path | None:
        return self._stored_file_path_from_raw(str(file_entry.get("storedPath") or ""))

    def _paired_stored_file_path(self, file_entry: dict) -> Path | None:
        return self._stored_file_path_from_raw(str(file_entry.get("pairedStoredPath") or ""))

    def _stored_file_path_from_raw(self, raw_path: str) -> Path | None:
        if not raw_path:
            return None
        try:
            storage_root = Path(self._settings.local_imaging_storage_dir).resolve()
            resolved_path = Path(raw_path).resolve()
        except OSError:
            return None
        if resolved_path != storage_root and storage_root not in resolved_path.parents:
            return None
        return resolved_path if resolved_path.is_file() else None

    def _require_instance(
        self,
        study_instance_uid: str,
        series_instance_uid: str,
        sop_instance_uid: str,
    ) -> LocalDicomInstance:
        instances = self.list_dicom_instances(
            study_instance_uid=study_instance_uid,
            series_instance_uid=series_instance_uid,
            sop_instance_uid=sop_instance_uid,
        )
        if not instances:
            raise HTTPException(status_code=404, detail="Local DICOM instance was not found.")
        instance = instances[0]
        if not Path(instance.stored_path).is_file():
            raise HTTPException(status_code=404, detail="Local DICOM object is missing from storage.")
        return instance

    def _dicom_json_for_instance(self, instance: LocalDicomInstance) -> dict:
        dataset = pydicom.dcmread(instance.stored_path, force=False)

        def bulk_data_uri(data_element) -> str:
            tag = f"{data_element.tag.group:04X}{data_element.tag.element:04X}"
            return (
                f"/dicom-web/studies/{instance.study_instance_uid}"
                f"/series/{instance.series_instance_uid}"
                f"/instances/{instance.sop_instance_uid}/bulkdata/{tag}"
            )

        metadata = dataset.to_json_dict(
            bulk_data_threshold=1,
            bulk_data_element_handler=bulk_data_uri,
            suppress_invalid_tags=True,
        )
        transfer_syntax = getattr(getattr(dataset, "file_meta", None), "TransferSyntaxUID", None)
        if transfer_syntax:
            metadata["00020010"] = {"vr": "UI", "Value": [str(transfer_syntax)]}
        metadata["00081190"] = {
            "vr": "UR",
            "Value": [
                f"/dicom-web/studies/{instance.study_instance_uid}"
                f"/series/{instance.series_instance_uid}"
                f"/instances/{instance.sop_instance_uid}"
            ],
        }
        return metadata

    @staticmethod
    def _dicomdir_referenced_paths(dataset) -> list[str]:
        records = getattr(dataset, "DirectoryRecordSequence", []) or []
        referenced: list[str] = []
        for record in records:
            value = getattr(record, "ReferencedFileID", None)
            if value is None:
                continue
            if isinstance(value, str):
                referenced.append(value.replace("\\", "/"))
            else:
                referenced.append("/".join(str(part) for part in value))
        return referenced

    @classmethod
    def _dicom_path_aliases(cls, relative_path: str) -> set[str]:
        safe_path = cls._safe_relative_path(relative_path)
        return {safe_path.upper(), PurePosixPath(safe_path).name.upper()}

    @classmethod
    def _dicomdir_reference_candidates(
        cls,
        dicomdir_relative_path: str,
        referenced_path: str,
    ) -> set[str]:
        referenced = cls._safe_relative_path(referenced_path)
        candidates = {referenced, PurePosixPath(referenced).name}
        dicomdir_parent = PurePosixPath(cls._safe_relative_path(dicomdir_relative_path)).parent
        if str(dicomdir_parent) not in {"", "."}:
            candidates.add(cls._safe_relative_path(f"{dicomdir_parent.as_posix()}/{referenced}"))
        return {candidate.upper() for candidate in candidates if candidate}

    @staticmethod
    def _asset_id(manifest: dict, file_entry_index: int) -> str:
        import_id = str(manifest.get("importId") or "")
        return f"{import_id}.{file_entry_index}"

    @staticmethod
    def _parse_asset_id(asset_id: str) -> tuple[str, int] | None:
        import_id, separator, index_text = str(asset_id or "").rpartition(".")
        if separator != "." or not import_id.startswith("import-") or not index_text.isdigit():
            return None
        return import_id, int(index_text)

    @staticmethod
    def _preview_supported(file_format: str) -> bool:
        return (
            file_format == "nifti"
            or file_format in PREVIEW_IMAGE_MEDIA_TYPES
            or file_format in TIFF_PREVIEW_FORMATS
        )

    @staticmethod
    def _read_dicom_metadata(data: bytes, *, force: bool = False):
        if len(data) >= 132 and data[128:132] == b"DICM":
            force = False
        elif not force:
            return None

        try:
            return pydicom.dcmread(BytesIO(data), stop_before_pixels=True, force=force)
        except Exception:
            return None

    @staticmethod
    def _parse_nifti_header(header: bytes) -> dict[str, object] | None:
        if len(header) < 348 or header[344:348] not in {b"n+1\x00", b"ni1\x00"}:
            return None

        endian: str | None = None
        for candidate in ("<", ">"):
            try:
                if struct.unpack(f"{candidate}i", header[0:4])[0] == 348:
                    endian = candidate
                    break
            except struct.error:
                return None
        if endian is None:
            return None

        try:
            dims = struct.unpack(f"{endian}8h", header[40:56])
            datatype_code = struct.unpack(f"{endian}h", header[70:72])[0]
            bits_per_voxel = struct.unpack(f"{endian}h", header[72:74])[0]
            vox_offset = struct.unpack(f"{endian}f", header[108:112])[0]
        except struct.error:
            return None

        dimension_count = dims[0] if 0 < dims[0] <= 7 else 0
        dimensions = [int(value) for value in dims[1 : dimension_count + 1] if value > 0]
        return {
            "dimensions": dimensions,
            "datatypeCode": int(datatype_code),
            "bitsPerVoxel": int(bits_per_voxel),
            "voxOffset": float(vox_offset),
            "endian": endian,
            "magic": header[344:347].decode("ascii", errors="ignore"),
        }

    @staticmethod
    def _is_nifti(data: bytes, lower_name: str) -> bool:
        if lower_name.endswith(".nii") or lower_name.endswith(".nii.gz"):
            return True

        header = data[:352]
        if lower_name.endswith(".gz"):
            try:
                header = gzip.decompress(data[:4096])[:352]
            except Exception:
                return False

        if len(header) < 348:
            return False
        return header[344:348] in {b"n+1\x00", b"ni1\x00"}

    @classmethod
    def _is_nrrd(cls, data: bytes, lower_name: str) -> bool:
        if cls._extension(lower_name) in NRRD_EXTENSIONS:
            return cls._parse_nrrd(data) is not None
        return data.startswith(b"NRRD") and cls._parse_nrrd(data) is not None

    @staticmethod
    def _parse_nrrd(payload: bytes) -> tuple[dict[str, object], int] | None:
        if not payload.startswith(b"NRRD"):
            return None

        match = re.search(br"\r?\n\r?\n", payload[:65_536])
        if match is None:
            return None

        try:
            header_text = payload[: match.start()].decode("ascii", errors="strict")
        except UnicodeDecodeError:
            return None

        lines = [line.strip() for line in header_text.splitlines()]
        if not lines or not lines[0].startswith("NRRD"):
            return None

        fields: dict[str, str] = {}
        for line in lines[1:]:
            if not line or line.startswith("#") or ":=" in line:
                continue
            key, separator, value = line.partition(":")
            if separator != ":":
                continue
            fields[key.strip().lower()] = value.strip()

        sizes = []
        for item in fields.get("sizes", "").split():
            try:
                size = int(item)
            except ValueError:
                return None
            if size <= 0:
                return None
            sizes.append(size)

        dimension = None
        if fields.get("dimension"):
            try:
                dimension = int(fields["dimension"])
            except ValueError:
                return None
            if dimension <= 0:
                return None
        if dimension is not None and sizes and len(sizes) != dimension:
            return None

        encoding = fields.get("encoding", "raw").strip().lower() or "raw"
        endian = fields.get("endian", "little").strip().lower() or "little"
        return {
            "version": lines[0],
            "type": fields.get("type", "").strip().lower(),
            "dimension": dimension,
            "sizes": sizes,
            "encoding": encoding,
            "endian": endian,
            "dataFile": fields.get("data file", ""),
        }, match.end()

    @staticmethod
    def _nrrd_numeric_decoder(nrrd_type: str) -> tuple[str, int] | None:
        normalized = " ".join(str(nrrd_type or "").strip().lower().split())
        return NRRD_NUMERIC_TYPES.get(normalized)

    @classmethod
    def _nrrd_header_metrics(cls, header: dict[str, object]) -> list[LocalImagingStudyFinding]:
        sizes = [int(size) for size in header.get("sizes", [])]
        metrics = [
            LocalImagingStudyFinding(
                label="Volume dimensions",
                value=" x ".join(str(size) for size in sizes) if sizes else "Unavailable",
            ),
            LocalImagingStudyFinding(label="NRRD type", value=str(header.get("type") or "unknown")),
            LocalImagingStudyFinding(label="Encoding", value=str(header.get("encoding") or "raw")),
        ]
        voxel_count = cls._dimension_product(sizes)
        if voxel_count > 0:
            metrics.append(LocalImagingStudyFinding(label="Voxel count", value=str(voxel_count)))
        return metrics

    @staticmethod
    def _is_zip_archive(upload: LocalImagingUploadPart) -> bool:
        lower_name = str(upload.relative_path or upload.filename or "").lower()
        if not lower_name.endswith(".zip"):
            return False
        return zipfile.is_zipfile(BytesIO(upload.data))

    @classmethod
    def _archive_member_base_path(cls, archive_path: str) -> str:
        safe_path = cls._safe_relative_path(archive_path)
        path = PurePosixPath(safe_path)
        name = path.name
        base_name = name[:-4] if name.lower().endswith(".zip") else name
        parent = path.parent.as_posix()
        if parent in {"", "."}:
            return cls._safe_relative_path(base_name)
        return cls._safe_relative_path(f"{parent}/{base_name}")

    @classmethod
    def _safe_archive_member_path(cls, member_path: str) -> str | None:
        raw_path = str(member_path or "").replace("\\", "/").strip()
        if not raw_path or raw_path.startswith("/"):
            return None
        path = PurePosixPath(raw_path)
        if path.is_absolute():
            return None
        if any(part in {"", ".", ".."} or part.endswith(":") for part in path.parts):
            return None
        return cls._safe_relative_path(raw_path)

    @classmethod
    def _paired_nifti_key(cls, relative_path: str) -> str | None:
        safe_path = cls._safe_relative_path(relative_path)
        path = PurePosixPath(safe_path)
        lower_name = path.name.lower()
        if not (lower_name.endswith(".hdr") or lower_name.endswith(".img")):
            return None
        stem = path.name[:-4].lower()
        parent = path.parent.as_posix()
        if parent in {"", "."}:
            return stem
        return f"{parent.lower()}/{stem}"

    @staticmethod
    def _extension(lower_name: str) -> str:
        if lower_name.endswith(".nii.gz"):
            return "nii.gz"
        return lower_name.rsplit(".", 1)[-1] if "." in lower_name else ""

    @staticmethod
    def _safe_relative_path(value: str) -> str:
        raw = str(value or "").replace("\\", "/").strip()
        parts = [
            part
            for part in PurePosixPath(raw).parts
            if part not in {"", ".", ".."} and not part.endswith(":")
        ]
        return "/".join(parts) or "upload"

    @staticmethod
    def _safe_filename(value: str) -> str:
        cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", value.strip())
        return cleaned[:120] or "upload"

    @staticmethod
    def _clean_uid(value) -> str | None:
        text = str(value or "").strip()
        if not text:
            return None
        return text if re.fullmatch(r"[0-9.]+", text) else None

    @staticmethod
    def _safe_modality(value) -> str | None:
        text = str(value or "").strip().upper()
        if not text:
            return None
        return re.sub(r"[^A-Z0-9_ -]+", "", text)[:32] or None

    @staticmethod
    def _generated_uid() -> str:
        return f"2.25.{uuid4().int}"

    @staticmethod
    def _study_modality(files: list[_DetectedFile]) -> str:
        modalities = [file.modality for file in files if file.modality]
        if modalities:
            return modalities[0]
        formats = {file.format for file in files}
        if "dicomdir" in formats or "dicom" in formats:
            return "DICOM"
        if "nifti" in formats or "nifti-data" in formats:
            return "NIFTI"
        if "nrrd" in formats:
            return "NRRD"
        return "IMG"

    @staticmethod
    def _study_description(formats: list[str], file_count: int) -> str:
        if formats == ["dicom"]:
            label = "DICOM"
        elif "dicomdir" in formats:
            label = "DICOMDIR"
        elif "nifti" in formats or "nifti-data" in formats:
            label = "NIFTI"
        elif "nrrd" in formats:
            label = "NRRD"
        else:
            label = "image"
        return f"Local {label} import ({file_count} file{'s' if file_count != 1 else ''})"

    @staticmethod
    def _study_warnings(files: list[_DetectedFile], warnings: list[str]) -> list[str]:
        if any(file.format == "dicomdir" for file in files):
            return [warning for warning in warnings if "DICOMDIR" in warning]
        return []

    @staticmethod
    def _study_summary(formats: list[str], assets: list[LocalImagingStudyAsset]) -> str:
        format_set = set(formats)
        has_viewable_dicom = any(asset.viewer_supported for asset in assets)
        has_preview = any(asset.preview_supported for asset in assets)
        if has_viewable_dicom:
            return "Local DICOM assets are available through the desktop DICOMweb bridge."
        if "nifti" in format_set or "nifti-data" in format_set:
            if has_preview:
                return "Local NIFTI assets are previewable and registered for backend-side analysis summary."
            return "Local NIFTI assets are registered for backend-side analysis summary."
        if "nrrd" in format_set:
            return "Local NRRD assets are registered for backend-side analysis summary."
        if format_set.intersection(COMMON_IMAGE_EXTENSIONS):
            if has_preview:
                return "Local image assets are previewable and registered for backend-side analysis summary."
            return "Local image assets are registered for backend-side analysis summary."
        return "Local imaging assets are registered in private storage."

    @staticmethod
    def _dimension_product(dimensions: list[int]) -> int:
        total = 1
        for dimension in dimensions:
            if dimension <= 0:
                return 0
            total *= dimension
        return total if dimensions else 0

    @staticmethod
    def _format_number(value: float) -> str:
        if abs(value - round(value)) < 1e-6:
            return str(int(round(value)))
        return f"{value:.3f}".rstrip("0").rstrip(".")

    @staticmethod
    def _human_size(size_bytes: int) -> str:
        value = float(max(size_bytes, 0))
        for unit in ("B", "KB", "MB", "GB"):
            if value < 1024 or unit == "GB":
                return f"{value:.1f} {unit}" if unit != "B" else f"{int(value)} B"
            value /= 1024
        return f"{value:.1f} GB"

    @staticmethod
    def _uncompressed_frame_size(dataset) -> int | None:
        try:
            rows = int(dataset.Rows)
            columns = int(dataset.Columns)
            samples_per_pixel = int(getattr(dataset, "SamplesPerPixel", 1))
            bits_allocated = int(dataset.BitsAllocated)
        except Exception:
            return None

        bytes_per_sample = max(bits_allocated // 8, 1)
        return rows * columns * samples_per_pixel * bytes_per_sample
