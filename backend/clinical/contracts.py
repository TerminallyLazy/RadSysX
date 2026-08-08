from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


def _to_camel(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(part.capitalize() for part in tail)


class ClinicalModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=_to_camel,
        populate_by_name=True,
        use_enum_values=True,
    )


class AppMode(str, Enum):
    RESEARCH = "research"
    PILOT = "pilot"
    CLINICAL = "clinical"


class AuthMode(str, Enum):
    LOCAL = "local"
    OIDC = "oidc"


class ImagingLaunchMode(str, Enum):
    DIAGNOSTIC = "diagnostic"
    REVIEW = "review"
    QA = "qa"


class WorkflowMode(str, Enum):
    SHADOW = "shadow"
    ASSISTIVE = "assistive"
    ACTIVE = "active"


class AIJobKind(str, Enum):
    TRIAGE = "triage"
    SEGMENTATION = "segmentation"
    DRAFT_REPORT = "draft_report"
    EVIDENCE_RETRIEVAL = "evidence_retrieval"


class AIJobStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    WITHDRAWN = "withdrawn"


class ReportStatus(str, Enum):
    NEW = "new"
    IN_REVIEW = "in_review"
    DRAFTED = "drafted"
    DRAFT = "draft"
    PENDING_SIGNOFF = "pending_signoff"
    FINAL = "final"
    AMENDED = "amended"


class ReviewerDecision(str, Enum):
    ACCEPTED = "accepted"
    REJECTED = "rejected"
    SUPERSEDED = "superseded"


class AuditAction(str, Enum):
    IMPORT_STUDY = "IMPORT_STUDY"
    SEARCH_STUDY = "SEARCH_STUDY"
    OPEN_STUDY = "OPEN_STUDY"
    VIEW_SERIES = "VIEW_SERIES"
    CREATE_MEASUREMENT = "CREATE_MEASUREMENT"
    STORE_SEG = "STORE_SEG"
    SAVE_REPORT = "SAVE_REPORT"
    FINALIZE_REPORT = "FINALIZE_REPORT"
    RUN_AI = "RUN_AI"
    ACCEPT_AI = "ACCEPT_AI"
    REJECT_AI = "REJECT_AI"


class ResourceType(str, Enum):
    STUDY = "study"
    SERIES = "series"
    REPORT = "report"
    AI_JOB = "ai_job"
    DERIVED_OBJECT = "derived_object"


class StudyQuery(ClinicalModel):
    patient_ref: str | None = None
    accession_number: str | None = None
    modality: str | None = None
    study_instance_uid: str | None = Field(default=None, alias="studyInstanceUID")
    limit: int = Field(default=25, ge=1, le=100)


class StudyMetadata(ClinicalModel):
    study_instance_uid: str = Field(alias="studyInstanceUID")
    patient_ref: str
    accession_number: str | None = None
    modality: str
    description: str
    study_date: str
    series_instance_uids: list[str] = Field(default_factory=list, alias="seriesInstanceUIDs")
    archive_ref: str


class SeriesMetadata(ClinicalModel):
    study_instance_uid: str = Field(alias="studyInstanceUID")
    series_instance_uid: str = Field(alias="seriesInstanceUID")
    modality: str
    description: str
    sop_instance_uids: list[str] = Field(default_factory=list, alias="sopInstanceUIDs")


class StudySearchPage(ClinicalModel):
    items: list[StudyMetadata]
    total: int


class DerivedDicomObject(ClinicalModel):
    object_type: str
    study_instance_uid: str = Field(alias="studyInstanceUID")
    series_instance_uid: str | None = Field(default=None, alias="seriesInstanceUID")
    sop_instance_uid: str | None = Field(default=None, alias="sopInstanceUID")
    storage_class: str
    content_type: str = "application/dicom"
    payload_ref: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class StoreResult(ClinicalModel):
    stored: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class SessionClaims(ClinicalModel):
    sub: str
    username: str
    name: str
    roles: list[str] = Field(default_factory=list)
    scopes: list[str] = Field(default_factory=list)
    expires_at: str = Field(alias="expiresAt")

    @property
    def primary_role(self) -> str:
        return self.roles[0] if self.roles else "radiologist"


class SessionResponse(ClinicalModel):
    authenticated: bool
    session: SessionClaims | None = None


class LocalLoginRequest(ClinicalModel):
    username: str


class LocalLoginResponse(ClinicalModel):
    session: SessionClaims


class ImagingLaunchRequest(ClinicalModel):
    study_instance_uid: str = Field(alias="studyInstanceUID")
    series_instance_uids: list[str] = Field(default_factory=list, alias="seriesInstanceUIDs")
    mode: ImagingLaunchMode = ImagingLaunchMode.DIAGNOSTIC
    requested_scopes: list[str] = Field(default_factory=list)
    trace_id: str | None = None


class ImagingLaunchContext(ClinicalModel):
    study_instance_uid: str = Field(alias="studyInstanceUID")
    series_instance_uids: list[str] = Field(default_factory=list, alias="seriesInstanceUIDs")
    patient_ref: str
    encounter_ref: str | None = None
    accession_number: str | None = None
    prior_study_uids: list[str] = Field(default_factory=list, alias="priorStudyUIDs")
    mode: ImagingLaunchMode
    signed_at: str
    expires_at: str
    scopes: list[str] = Field(default_factory=list)


class ImagingLaunchResponse(ClinicalModel):
    context: ImagingLaunchContext
    signature: str
    launch_token: str = Field(alias="launchToken")
    viewer_url: str


class ViewerFeatureFlags(ClinicalModel):
    local_file_import: bool = Field(default=False, alias="localFileImport")
    report_panel: bool = Field(default=True, alias="reportPanel")
    ai_panel: bool = Field(default=True, alias="aiPanel")
    derived_panel: bool = Field(default=True, alias="derivedPanel")
    audit_panel: bool = Field(default=True, alias="auditPanel")
    direct_stow: bool = Field(default=False, alias="directStow")


class ViewerRuntime(ClinicalModel):
    viewer_kind: str = Field(alias="viewerKind")
    viewer_base_path: str = Field(alias="viewerBasePath")
    study_instance_uid: str = Field(alias="studyInstanceUID")
    series_instance_uids: list[str] = Field(default_factory=list, alias="seriesInstanceUIDs")
    qido_root: str = Field(alias="qidoRoot")
    wado_root: str = Field(alias="wadoRoot")
    wado_uri_root: str = Field(alias="wadoUriRoot")
    stow_root: str = Field(alias="stowRoot")
    auth_mode: AuthMode = Field(alias="authMode")
    feature_flags: ViewerFeatureFlags = Field(alias="featureFlags")


class ImagingLaunchResolveResponse(ClinicalModel):
    launch_token: str = Field(alias="launchToken")
    context: ImagingLaunchContext
    signature: str
    study_wado_rs_uri: str = Field(alias="studyWadoRsUri")
    viewer_runtime: ViewerRuntime = Field(alias="viewerRuntime")


class WorklistRow(ClinicalModel):
    study_instance_uid: str = Field(alias="studyInstanceUID")
    accession_number: str
    patient_ref: str
    modality: str
    description: str
    status: ReportStatus
    archive_ref: str
    encounter_ref: str | None = None
    prior_study_uids: list[str] = Field(default_factory=list, alias="priorStudyUIDs")
    triage_score: float | None = None
    last_updated_at: str


class WorklistResponse(ClinicalModel):
    role: str
    user_id: str
    rows: list[WorklistRow]


class LocalImagingImportedStudy(ClinicalModel):
    study_instance_uid: str = Field(alias="studyInstanceUID")
    accession_number: str = Field(alias="accessionNumber")
    modality: str
    description: str
    archive_ref: str = Field(alias="archiveRef")
    file_count: int = Field(alias="fileCount")
    formats: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class LocalImagingImportResponse(ClinicalModel):
    import_id: str = Field(alias="importId")
    imported_studies: list[LocalImagingImportedStudy] = Field(alias="importedStudies")
    accepted_files: int = Field(alias="acceptedFiles")
    rejected_files: int = Field(alias="rejectedFiles")
    warnings: list[str] = Field(default_factory=list)


class LocalImagingStudyAsset(ClinicalModel):
    asset_id: str = Field(alias="assetId")
    relative_path: str = Field(alias="relativePath")
    format: str
    modality: str | None = None
    size: int
    study_instance_uid: str | None = Field(default=None, alias="studyInstanceUID")
    series_instance_uid: str | None = Field(default=None, alias="seriesInstanceUID")
    sop_instance_uid: str | None = Field(default=None, alias="sopInstanceUID")
    analysis_supported: bool = Field(default=True, alias="analysisSupported")
    viewer_supported: bool = Field(default=False, alias="viewerSupported")
    preview_supported: bool = Field(default=False, alias="previewSupported")
    preview_url: str | None = Field(default=None, alias="previewUrl")
    preview_slices: dict[str, int] = Field(default_factory=dict, alias="previewSlices")
    default_preview_axis: str | None = Field(default=None, alias="defaultPreviewAxis")
    default_preview_slice: int | None = Field(default=None, alias="defaultPreviewSlice")


class LocalImagingStudyFinding(ClinicalModel):
    label: str
    value: str


class LocalImagingStudyAssetsResponse(ClinicalModel):
    study_instance_uid: str = Field(alias="studyInstanceUID")
    archive_ref: str = Field(alias="archiveRef")
    modality: str
    description: str
    file_count: int = Field(alias="fileCount")
    formats: list[str] = Field(default_factory=list)
    summary: str
    findings: list[LocalImagingStudyFinding] = Field(default_factory=list)
    assets: list[LocalImagingStudyAsset] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class LocalImagingAssetAnalysis(ClinicalModel):
    asset_id: str = Field(alias="assetId")
    relative_path: str = Field(alias="relativePath")
    format: str
    summary: str
    metrics: list[LocalImagingStudyFinding] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class LocalImagingStudyAnalysisResponse(ClinicalModel):
    study_instance_uid: str = Field(alias="studyInstanceUID")
    analyzed_at: str = Field(alias="analyzedAt")
    summary: str
    analyses: list[LocalImagingAssetAnalysis] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class ReportDraftRequest(ClinicalModel):
    report_id: str | None = None
    study_instance_uid: str = Field(alias="studyInstanceUID")
    diagnostic_report_id: str | None = None
    status: ReportStatus = ReportStatus.DRAFT
    reviewer_user_id: str | None = None
    findings_summary: str
    impression: str
    derived_object_refs: list[str] = Field(default_factory=list)
    ai_contribution_refs: list[str] = Field(default_factory=list)
    trace_id: str | None = None


class ReportRecord(ClinicalModel):
    report_id: str
    study_instance_uid: str = Field(alias="studyInstanceUID")
    diagnostic_report_id: str | None = None
    status: ReportStatus
    author_user_id: str
    reviewer_user_id: str | None = None
    findings_summary: str
    impression: str
    derived_object_refs: list[str] = Field(default_factory=list)
    ai_contribution_refs: list[str] = Field(default_factory=list)
    created_at: str
    updated_at: str


class AIJobCreateRequest(ClinicalModel):
    kind: AIJobKind
    workflow_mode: WorkflowMode
    study_instance_uid: str = Field(alias="studyInstanceUID")
    series_instance_uid: str | None = Field(default=None, alias="seriesInstanceUID")
    model_id: str
    model_version: str
    input_hash: str
    output_refs: list[str] = Field(default_factory=list)
    trace_id: str | None = None


class AIJobRecord(ClinicalModel):
    job_id: str
    kind: AIJobKind
    workflow_mode: WorkflowMode
    study_instance_uid: str = Field(alias="studyInstanceUID")
    series_instance_uid: str | None = Field(default=None, alias="seriesInstanceUID")
    model_id: str
    model_version: str
    input_hash: str
    requested_by: str
    status: AIJobStatus
    output_refs: list[str] = Field(default_factory=list)
    reviewer_decision: ReviewerDecision | None = None
    created_at: str


class AISidebarModelLane(ClinicalModel):
    lane: str
    status: Literal["planned", "stub", "available", "disabled"]
    role: str
    model_id: str | None = Field(default=None, alias="modelId")


class AISidebarCapabilities(ClinicalModel):
    backend_bound: bool = Field(alias="backendBound")
    voice_first: bool = Field(alias="voiceFirst")
    text_composer: bool = Field(alias="textComposer")
    context_attachments: bool = Field(alias="contextAttachments")
    orchestration_mode: Literal["stub", "local", "api", "hybrid"] = Field(alias="orchestrationMode")
    event_transport: Literal["http", "sse", "websocket"] = Field(alias="eventTransport")
    audio_input_modes: list[str] = Field(default_factory=list, alias="audioInputModes")
    model_lanes: list[AISidebarModelLane] = Field(default_factory=list, alias="modelLanes")
    safety_note: str = Field(alias="safetyNote")


class AISidebarViewerContext(ClinicalModel):
    study_instance_uid: str | None = Field(default=None, alias="studyInstanceUID")
    series_instance_uid: str | None = Field(default=None, alias="seriesInstanceUID")
    sop_instance_uid: str | None = Field(default=None, alias="sopInstanceUID")
    route: str | None = None
    privacy_class: Literal["local-only", "deidentified", "phi-bearing", "unknown"] = Field(
        default="unknown",
        alias="privacyClass",
    )


class AISidebarSessionCreateRequest(ClinicalModel):
    viewer_context: AISidebarViewerContext | None = Field(default=None, alias="viewerContext")
    trace_id: str | None = None


class AISidebarSessionResponse(ClinicalModel):
    session_id: str = Field(alias="sessionId")
    status: Literal["ready", "fallback"]
    created_at: str = Field(alias="createdAt")
    backend_bound: bool = Field(alias="backendBound")
    voice_first: bool = Field(alias="voiceFirst")
    orchestration_mode: Literal["stub", "local", "api", "hybrid"] = Field(alias="orchestrationMode")
    message: str


class AISidebarAttachment(ClinicalModel):
    id: str
    kind: str
    label: str
    metadata: dict[str, Any] = Field(default_factory=dict)


class AISidebarMessageRequest(ClinicalModel):
    text: str = Field(default="", max_length=4000)
    input_source: Literal["typed", "voice", "context"] = Field(default="typed", alias="inputSource")
    attachments: list[AISidebarAttachment] = Field(default_factory=list, max_length=16)
    viewer_context: AISidebarViewerContext | None = Field(default=None, alias="viewerContext")
    trace_id: str | None = None


class AISidebarAssistantMessage(ClinicalModel):
    role: Literal["assistant"] = "assistant"
    text: str
    created_at: str = Field(alias="createdAt")
    model_id: str = Field(alias="modelId")
    model_version: str = Field(alias="modelVersion")


class AISidebarTurnResponse(ClinicalModel):
    session_id: str = Field(alias="sessionId")
    turn_id: str = Field(alias="turnId")
    status: Literal["completed"]
    assistant_message: AISidebarAssistantMessage = Field(alias="assistantMessage")
    route: list[str] = Field(default_factory=list)
    audit_trace_id: str = Field(alias="auditTraceId")
    persisted: bool
    warnings: list[str] = Field(default_factory=list)


class DerivedResultRecord(ClinicalModel):
    id: str
    study_instance_uid: str = Field(alias="studyInstanceUID")
    series_instance_uid: str | None = Field(default=None, alias="seriesInstanceUID")
    sop_instance_uid: str | None = Field(default=None, alias="sopInstanceUID")
    object_type: str
    storage_class: str
    content_type: str
    payload_ref: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: str


class DerivedResultRequest(ClinicalModel):
    objects: list[DerivedDicomObject]
    trace_id: str | None = None


class DerivedResultResponse(ClinicalModel):
    result: StoreResult
    trace_id: str


class DerivedResultStowRequest(ClinicalModel):
    study_instance_uid: str = Field(alias="studyInstanceUID")
    object_type: str
    storage_class: str
    series_instance_uid: str | None = Field(default=None, alias="seriesInstanceUID")
    sop_instance_uid: str | None = Field(default=None, alias="sopInstanceUID")
    content_type: str = "application/dicom"
    metadata: dict[str, Any] = Field(default_factory=dict)
    trace_id: str | None = None


class AuditEvent(ClinicalModel):
    event_id: str
    occurred_at: str
    actor_user_id: str
    actor_role: str
    action: AuditAction
    patient_ref: str | None = None
    study_instance_uid: str | None = Field(default=None, alias="studyInstanceUID")
    resource_type: ResourceType
    resource_id: str
    trace_id: str
    source_ip: str
    outcome: str


class AuditStudyResponse(ClinicalModel):
    study_instance_uid: str = Field(alias="studyInstanceUID")
    events: list[AuditEvent]


class StudyWorkspace(ClinicalModel):
    worklist_row: WorklistRow | None = Field(default=None, alias="worklistRow")
    reports: list[ReportRecord] = Field(default_factory=list)
    ai_jobs: list[AIJobRecord] = Field(default_factory=list, alias="aiJobs")
    derived_results: list[DerivedResultRecord] = Field(
        default_factory=list,
        alias="derivedResults",
    )
    audit: list[AuditEvent] = Field(default_factory=list)


class LaunchSessionRecord(ClinicalModel):
    launch_token: str = Field(alias="launchToken")
    context: ImagingLaunchContext
    signature: str
    actor_user_id: str
    actor_role: str
    expires_at: str
    created_at: str
    resolved_at: str | None = None


class ClinicalPlatformConfig(ClinicalModel):
    mode: AppMode
    experimental_routes_enabled: bool = Field(alias="experimentalRoutesEnabled")
    local_imaging_enabled: bool = Field(alias="localImagingEnabled")
    viewer_base_url: str = Field(alias="viewerBaseUrl")
    viewer_kind: str = Field(alias="viewerKind")
    viewer_base_path: str = Field(alias="viewerBasePath")
    auth_mode: AuthMode = Field(alias="authMode")
    ai_default_workflow_mode: WorkflowMode = Field(alias="aiDefaultWorkflowMode")
    ai_allow_active: bool = Field(alias="aiAllowActive")


def utc_now() -> datetime:
    return datetime.utcnow()


def to_iso_z(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    else:
        value = value.astimezone(timezone.utc)
    return value.isoformat().replace("+00:00", "Z")


def parse_iso_z(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return parsed
