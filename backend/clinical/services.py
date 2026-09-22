from __future__ import annotations

import base64
import hashlib
import hmac
import json
from datetime import timedelta
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from uuid import uuid4

from fastapi import HTTPException

from .config import ClinicalPlatformSettings
from .contracts import (
    AIJobCreateRequest,
    AuditAction,
    AuditEvent,
    AuditStudyResponse,
    DerivedDicomObject,
    DerivedResultRequest,
    DerivedResultResponse,
    DerivedResultStowRequest,
    ImagingLaunchContext,
    ImagingLaunchRequest,
    ImagingLaunchResolveResponse,
    ImagingLaunchResponse,
    ReportDraftRequest,
    ReportRecord,
    ReportStatus,
    ResourceType,
    SessionClaims,
    StudyWorkspace,
    ViewerFeatureFlags,
    ViewerRuntime,
    WorklistResponse,
    WorkflowMode,
    parse_iso_z,
    to_iso_z,
    utc_now,
)
from .dicomweb import DICOMwebAdapter, UploadedDicomPart
from .repositories import ClinicalRepository


class ClinicalPlatformService:
    def __init__(
        self,
        settings: ClinicalPlatformSettings,
        repository: ClinicalRepository,
        dicomweb_adapter: DICOMwebAdapter,
    ) -> None:
        self._settings = settings
        self._repository = repository
        self._dicomweb = dicomweb_adapter

    async def launch_imaging(
        self,
        request: ImagingLaunchRequest,
        actor: SessionClaims,
        source_ip: str,
    ) -> ImagingLaunchResponse:
        worklist_row = self._repository.get_worklist_row(request.study_instance_uid)
        if worklist_row is None:
            raise HTTPException(status_code=404, detail="Study was not found on the worklist.")

        signed_at = utc_now()
        expires_at = signed_at + timedelta(seconds=self._settings.launch_ttl_seconds)

        context = ImagingLaunchContext(
            study_instance_uid=request.study_instance_uid,
            series_instance_uids=request.series_instance_uids,
            patient_ref=worklist_row.patient_ref,
            encounter_ref=worklist_row.encounter_ref,
            accession_number=worklist_row.accession_number,
            prior_study_uids=worklist_row.prior_study_uids,
            mode=request.mode,
            signed_at=self._format_dt(signed_at),
            expires_at=self._format_dt(expires_at),
            scopes=request.requested_scopes or self._default_scopes_for_role(actor.primary_role),
        )
        signature = self._sign_context(context)
        launch_token = self._repository.create_launch_session(
            context=context,
            actor_user_id=actor.username,
            actor_role=actor.primary_role,
            signature=signature,
        )
        viewer_url = self._build_viewer_launch_url(launch_token)

        self._repository.add_audit_event(
            self._build_audit_event(
                actor_user_id=actor.username,
                actor_role=actor.primary_role,
                action=AuditAction.OPEN_STUDY,
                patient_ref=context.patient_ref,
                study_instance_uid=request.study_instance_uid,
                resource_type=ResourceType.STUDY,
                resource_id=request.study_instance_uid,
                trace_id=request.trace_id,
                source_ip=source_ip,
            )
        )

        return ImagingLaunchResponse(
            context=context,
            signature=signature,
            launch_token=launch_token,
            viewer_url=viewer_url,
        )

    async def resolve_imaging_launch(
        self,
        launch_token: str,
        actor: SessionClaims,
        source_ip: str,
    ) -> ImagingLaunchResolveResponse:
        session = self._repository.get_launch_session(launch_token)
        if session is None:
            raise HTTPException(status_code=404, detail="Launch session was not found.")

        if parse_iso_z(session.expires_at) < utc_now():
            raise HTTPException(status_code=410, detail="Launch session has expired.")

        study_wado_rs_uri = self._public_study_wado_uri(session.context.study_instance_uid)

        self._repository.add_audit_event(
            self._build_audit_event(
                actor_user_id=actor.username,
                actor_role=actor.primary_role,
                action=AuditAction.VIEW_SERIES,
                patient_ref=session.context.patient_ref,
                study_instance_uid=session.context.study_instance_uid,
                resource_type=ResourceType.STUDY,
                resource_id=session.context.study_instance_uid,
                source_ip=source_ip,
            )
        )

        return ImagingLaunchResolveResponse(
            launch_token=session.launch_token,
            context=session.context,
            signature=session.signature,
            study_wado_rs_uri=study_wado_rs_uri,
            viewer_runtime=self._viewer_runtime(session.context),
        )

    def get_worklist(
        self,
        actor: SessionClaims,
        source_ip: str,
        trace_id: str | None = None,
    ) -> WorklistResponse:
        rows = sorted(
            self._repository.list_worklist(),
            key=lambda row: (
                row.triage_score is None,
                -(row.triage_score or 0.0),
                row.last_updated_at,
            ),
        )
        self._repository.add_audit_event(
            self._build_audit_event(
                actor_user_id=actor.username,
                actor_role=actor.primary_role,
                action=AuditAction.SEARCH_STUDY,
                resource_type=ResourceType.STUDY,
                resource_id="worklist",
                trace_id=trace_id,
                source_ip=source_ip,
            )
        )
        return WorklistResponse(role=actor.primary_role, user_id=actor.username, rows=rows)

    def get_study_workspace(
        self,
        study_uid: str,
        actor: SessionClaims,
        source_ip: str,
        trace_id: str | None = None,
    ) -> StudyWorkspace:
        workspace = self._repository.get_study_workspace(study_uid)
        self._repository.add_audit_event(
            self._build_audit_event(
                actor_user_id=actor.username,
                actor_role=actor.primary_role,
                action=AuditAction.OPEN_STUDY,
                study_instance_uid=study_uid,
                resource_type=ResourceType.STUDY,
                resource_id=study_uid,
                trace_id=trace_id,
                source_ip=source_ip,
            )
        )
        return workspace

    def save_report(
        self,
        request: ReportDraftRequest,
        actor: SessionClaims,
        source_ip: str,
    ) -> ReportRecord:
        record = self._repository.save_report(request, author_user_id=actor.username)
        audit_action = (
            AuditAction.FINALIZE_REPORT
            if request.status in {ReportStatus.FINAL, ReportStatus.AMENDED}
            else AuditAction.SAVE_REPORT
        )
        self._repository.add_audit_event(
            self._build_audit_event(
                actor_user_id=actor.username,
                actor_role=actor.primary_role,
                action=audit_action,
                study_instance_uid=request.study_instance_uid,
                resource_type=ResourceType.REPORT,
                resource_id=record.report_id,
                trace_id=request.trace_id,
                source_ip=source_ip,
            )
        )
        return record

    def submit_ai_job(
        self,
        request: AIJobCreateRequest,
        actor: SessionClaims,
        source_ip: str,
    ):
        if request.workflow_mode == WorkflowMode.ACTIVE and not self._settings.ai_allow_active:
            raise HTTPException(
                status_code=409,
                detail="Active triage mode is disabled until governance approval is recorded.",
            )

        record = self._repository.create_ai_job(request, requested_by=actor.username)
        self._repository.add_audit_event(
            self._build_audit_event(
                actor_user_id=actor.username,
                actor_role=actor.primary_role,
                action=AuditAction.RUN_AI,
                study_instance_uid=request.study_instance_uid,
                resource_type=ResourceType.AI_JOB,
                resource_id=record.job_id,
                trace_id=request.trace_id,
                source_ip=source_ip,
            )
        )
        return record

    async def store_derived_results(
        self,
        request: DerivedResultRequest,
        actor: SessionClaims,
        source_ip: str,
    ) -> DerivedResultResponse:
        result = await self._dicomweb.store_derived_objects(request.objects)
        trace_id = request.trace_id or f"trace-{uuid4()}"

        for stored_ref, object_ in zip(result.stored, request.objects):
            self._repository.store_derived_result(object_, stored_ref)
            self._repository.add_audit_event(
                self._build_audit_event(
                    actor_user_id=actor.username,
                    actor_role=actor.primary_role,
                    action=AuditAction.STORE_SEG,
                    study_instance_uid=object_.study_instance_uid,
                    resource_type=ResourceType.DERIVED_OBJECT,
                    resource_id=stored_ref,
                    trace_id=trace_id,
                    source_ip=source_ip,
                )
            )

        return DerivedResultResponse(result=result, trace_id=trace_id)

    async def store_uploaded_derived_results(
        self,
        request: DerivedResultStowRequest,
        files: list[UploadedDicomPart],
        actor: SessionClaims,
        source_ip: str,
    ) -> DerivedResultResponse:
        if not files:
            raise HTTPException(status_code=400, detail="At least one DICOM instance is required.")

        object_template = request.model_dump(by_alias=False, exclude={"trace_id"})
        result = await self._dicomweb.store_uploaded_instances(
            request=request,
            files=files,
        )
        trace_id = request.trace_id or f"trace-{uuid4()}"

        for index, stored_ref in enumerate(result.stored, start=1):
            payload = {
                **object_template,
                "payload_ref": stored_ref,
                "metadata": {
                    **request.metadata,
                    "stowFileIndex": index,
                    "stowFileName": files[index - 1].filename,
                },
            }
            derived = DerivedDicomObject.model_validate(payload)
            self._repository.store_derived_result(derived, stored_ref)
            self._repository.add_audit_event(
                self._build_audit_event(
                    actor_user_id=actor.username,
                    actor_role=actor.primary_role,
                    action=AuditAction.STORE_SEG,
                    study_instance_uid=request.study_instance_uid,
                    resource_type=ResourceType.DERIVED_OBJECT,
                    resource_id=stored_ref,
                    trace_id=trace_id,
                    source_ip=source_ip,
                )
            )

        return DerivedResultResponse(result=result, trace_id=trace_id)

    def list_audit_events(self, study_uid: str) -> AuditStudyResponse:
        events = self._repository.list_audit_events(study_uid)
        return AuditStudyResponse(study_instance_uid=study_uid, events=events)

    def _default_scopes_for_role(self, actor_role: str) -> list[str]:
        scopes = ["study.read", "report.read"]
        if actor_role in {"radiologist", "attending", "admin"}:
            scopes.extend(["report.write", "derived.write", "ai.run"])
        return scopes

    def _public_study_wado_uri(self, study_uid: str) -> str:
        root = self._settings.dicomweb_wado_root or "/dicom-web"
        return f"{root}/studies/{study_uid}"

    def _viewer_runtime(self, context: ImagingLaunchContext) -> ViewerRuntime:
        direct_stow_enabled = False
        return ViewerRuntime(
            viewer_kind=self._settings.viewer_kind,
            viewer_base_path=self._settings.viewer_base_path,
            study_instance_uid=context.study_instance_uid,
            series_instance_uids=context.series_instance_uids,
            qido_root=self._settings.dicomweb_qido_root,
            wado_root=self._settings.dicomweb_wado_root,
            wado_uri_root=self._settings.dicomweb_wado_uri_root,
            stow_root=self._settings.dicomweb_stow_root if direct_stow_enabled else "",
            auth_mode=self._settings.auth_mode,
            feature_flags=ViewerFeatureFlags(
                local_file_import=self._settings.local_imaging_enabled,
                report_panel=True,
                ai_panel=True,
                derived_panel=True,
                audit_panel=True,
                direct_stow=direct_stow_enabled,
            ),
        )

    def _build_viewer_launch_url(self, launch_token: str) -> str:
        split = urlsplit(self._settings.viewer_base_url.strip())
        path = split.path or "/"
        normalized_path = path if path.endswith("/") else f"{path}/"
        query_pairs = [(key, value) for key, value in parse_qsl(split.query, keep_blank_values=True) if key != "launch"]
        query_pairs.append(("launch", launch_token))
        query = urlencode(query_pairs, doseq=True)
        return urlunsplit(
            (
                split.scheme,
                split.netloc,
                normalized_path,
                query,
                split.fragment,
            )
        )

    def _sign_context(self, context: ImagingLaunchContext) -> str:
        payload = json.dumps(context.model_dump(by_alias=True), sort_keys=True).encode("utf-8")
        digest = hmac.new(
            self._settings.clinical_api_secret.encode("utf-8"),
            payload,
            hashlib.sha256,
        ).digest()
        return base64.urlsafe_b64encode(digest).decode("utf-8").rstrip("=")

    def _build_audit_event(
        self,
        *,
        actor_user_id: str,
        actor_role: str,
        action: AuditAction,
        resource_type: ResourceType,
        resource_id: str,
        source_ip: str,
        trace_id: str | None = None,
        patient_ref: str | None = None,
        study_instance_uid: str | None = None,
    ) -> AuditEvent:
        return AuditEvent(
            event_id=f"audit-{uuid4()}",
            occurred_at=self._format_dt(utc_now()),
            actor_user_id=actor_user_id,
            actor_role=actor_role,
            action=action,
            patient_ref=patient_ref,
            study_instance_uid=study_instance_uid,
            resource_type=resource_type,
            resource_id=resource_id,
            trace_id=trace_id or f"trace-{uuid4()}",
            source_ip=source_ip,
            outcome="success",
        )

    @staticmethod
    def _format_dt(value) -> str:
        return to_iso_z(value)
