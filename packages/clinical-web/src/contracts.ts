export type AppMode = "research" | "pilot" | "clinical";
export type AuthMode = "local" | "oidc";
export type ImagingLaunchMode = "diagnostic" | "review" | "qa";
export type WorkflowMode = "shadow" | "assistive" | "active";
export type AIJobKind =
  | "triage"
  | "segmentation"
  | "draft_report"
  | "evidence_retrieval";
export type AIJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "withdrawn";
export type AISidebarLaneStatus =
  | "planned"
  | "stub"
  | "available"
  | "disabled";
export type AISidebarOrchestrationMode =
  | "stub"
  | "local"
  | "api"
  | "hybrid";
export type AISidebarInputSource =
  | "typed"
  | "voice"
  | "context";
export type ReportStatus =
  | "new"
  | "in_review"
  | "drafted"
  | "draft"
  | "pending_signoff"
  | "final"
  | "amended";

export type SessionClaims = {
  sub: string;
  username: string;
  name: string;
  roles: string[];
  scopes: string[];
  expiresAt: string;
};

export type SessionResponse = {
  authenticated: boolean;
  session: SessionClaims | null;
};

export type LocalLoginRequest = {
  username: string;
};

export type LocalLoginResponse = {
  session: SessionClaims;
};

export type ImagingLaunchContext = {
  studyInstanceUID: string;
  seriesInstanceUIDs?: string[];
  patientRef: string;
  encounterRef?: string;
  accessionNumber?: string;
  priorStudyUIDs: string[];
  mode: ImagingLaunchMode;
  signedAt: string;
  expiresAt: string;
  scopes: string[];
};

export type ImagingLaunchRequest = {
  studyInstanceUID: string;
  seriesInstanceUIDs?: string[];
  mode?: ImagingLaunchMode;
  requestedScopes?: string[];
  traceId?: string;
};

export type ViewerFeatureFlags = {
  localFileImport: boolean;
  reportPanel: boolean;
  aiPanel: boolean;
  derivedPanel: boolean;
  auditPanel: boolean;
  directStow: boolean;
};

export type LocalImagingImportedStudy = {
  studyInstanceUID: string;
  accessionNumber: string;
  modality: string;
  description: string;
  archiveRef: string;
  fileCount: number;
  formats: string[];
  warnings: string[];
};

export type LocalImagingImportResponse = {
  importId: string;
  importedStudies: LocalImagingImportedStudy[];
  acceptedFiles: number;
  rejectedFiles: number;
  warnings: string[];
};

export type LocalImagingStudyAsset = {
  assetId: string;
  relativePath: string;
  format: string;
  modality?: string | null;
  size: number;
  studyInstanceUID?: string | null;
  seriesInstanceUID?: string | null;
  sopInstanceUID?: string | null;
  analysisSupported: boolean;
  viewerSupported: boolean;
  previewSupported: boolean;
  previewUrl?: string | null;
  previewSlices: Record<string, number>;
  defaultPreviewAxis?: string | null;
  defaultPreviewSlice?: number | null;
};

export type LocalImagingStudyFinding = {
  label: string;
  value: string;
};

export type LocalImagingStudyAssetsResponse = {
  studyInstanceUID: string;
  archiveRef: string;
  modality: string;
  description: string;
  fileCount: number;
  formats: string[];
  summary: string;
  findings: LocalImagingStudyFinding[];
  assets: LocalImagingStudyAsset[];
  warnings: string[];
};

export type LocalImagingAssetAnalysis = {
  assetId: string;
  relativePath: string;
  format: string;
  summary: string;
  metrics: LocalImagingStudyFinding[];
  warnings: string[];
};

export type LocalImagingStudyAnalysisResponse = {
  studyInstanceUID: string;
  analyzedAt: string;
  summary: string;
  analyses: LocalImagingAssetAnalysis[];
  warnings: string[];
};

export type BiomedParseDemoCapabilities = {
  enabled: boolean;
  ready: boolean;
  reason?: string | null;
  modelId: string;
  license: string;
  source: "included_ct_amos";
  supportedPromptIds: number[];
  defaultPromptIds: number[];
  researchOnly: boolean;
  outputNote: string;
};

export type BiomedParseDemoRunRequest = {
  source?: "included_ct_amos";
  promptIds?: number[];
  sliceBatchSize?: number;
  studyInstanceUID?: string;
  traceId?: string;
};

export type BiomedParseDemoLabelSummary = {
  label: number;
  prompt: string;
  voxelCount: number;
  boundingBox?: number[] | null;
  color: string;
};

export type BiomedParseDemoTiming = {
  modelInstantiatedSeconds?: number | null;
  modelLoadedSeconds?: number | null;
  inferenceSeconds?: number | null;
};

export type BiomedParseDemoRuntime = {
  python?: string | null;
  torchVersion?: string | null;
  torchCuda?: string | null;
  device?: string | null;
  gpuName?: string | null;
  peakVramGib?: number | null;
};

export type BiomedParseDemoArtifacts = {
  maskNpzUrl: string;
  previewPngUrl: string;
};

export type BiomedParseDemoRunResponse = {
  status: "completed";
  runId: string;
  source: "included_ct_amos";
  modelId: string;
  modelVersion: string;
  license: string;
  promptIds: number[];
  inputShape: number[];
  maskShape: number[];
  nonzeroVoxels: number;
  previewSlice: number;
  labels: BiomedParseDemoLabelSummary[];
  timings: BiomedParseDemoTiming;
  runtime: BiomedParseDemoRuntime;
  artifacts: BiomedParseDemoArtifacts;
  warnings: string[];
  studyInstanceUID?: string | null;
  traceId?: string | null;
};

export type ViewerRuntime = {
  viewerKind: string;
  viewerBasePath: string;
  studyInstanceUID: string;
  seriesInstanceUIDs: string[];
  qidoRoot: string;
  wadoRoot: string;
  wadoUriRoot: string;
  stowRoot: string;
  authMode: AuthMode;
  featureFlags: ViewerFeatureFlags;
};

export type ImagingLaunchResponse = {
  context: ImagingLaunchContext;
  signature: string;
  launchToken: string;
  viewerUrl: string;
};

export type ImagingLaunchResolveResponse = {
  launchToken: string;
  context: ImagingLaunchContext;
  signature: string;
  studyWadoRsUri: string;
  viewerRuntime: ViewerRuntime;
};

export type WorklistRow = {
  studyInstanceUID: string;
  accessionNumber: string;
  patientRef: string;
  modality: string;
  description: string;
  status: ReportStatus;
  archiveRef: string;
  encounterRef?: string;
  priorStudyUIDs: string[];
  triageScore?: number | null;
  lastUpdatedAt: string;
};

export type WorklistResponse = {
  role: string;
  userId: string;
  rows: WorklistRow[];
};

export type ReportRecord = {
  reportId: string;
  studyInstanceUID: string;
  diagnosticReportId?: string;
  status: ReportStatus;
  authorUserId: string;
  reviewerUserId?: string;
  findingsSummary: string;
  impression: string;
  derivedObjectRefs: string[];
  aiContributionRefs: string[];
  createdAt: string;
  updatedAt: string;
};

export type ReportDraftRequest = {
  reportId?: string;
  studyInstanceUID: string;
  diagnosticReportId?: string;
  status?: ReportStatus;
  reviewerUserId?: string;
  findingsSummary: string;
  impression: string;
  derivedObjectRefs?: string[];
  aiContributionRefs?: string[];
  traceId?: string;
};

export type AIJobRecord = {
  jobId: string;
  kind: AIJobKind;
  workflowMode: WorkflowMode;
  studyInstanceUID: string;
  seriesInstanceUID?: string;
  modelId: string;
  modelVersion: string;
  inputHash: string;
  requestedBy: string;
  status: AIJobStatus;
  outputRefs: string[];
  reviewerDecision?: "accepted" | "rejected" | "superseded";
  createdAt: string;
};

export type AIJobRequest = {
  kind: AIJobKind;
  workflowMode: WorkflowMode;
  studyInstanceUID: string;
  seriesInstanceUID?: string;
  modelId: string;
  modelVersion: string;
  inputHash: string;
  outputRefs?: string[];
  traceId?: string;
};

export type AISidebarModelLane = {
  lane: string;
  status: AISidebarLaneStatus;
  role: string;
  modelId?: string | null;
};

export type AISidebarCapabilities = {
  backendBound: boolean;
  voiceFirst: boolean;
  textComposer: boolean;
  contextAttachments: boolean;
  orchestrationMode: AISidebarOrchestrationMode;
  eventTransport: "http" | "sse" | "websocket";
  audioInputModes: string[];
  modelLanes: AISidebarModelLane[];
  safetyNote: string;
};

export type AISidebarViewerContext = {
  studyInstanceUID?: string | null;
  seriesInstanceUID?: string | null;
  sopInstanceUID?: string | null;
  route?: string | null;
  privacyClass?: "local-only" | "deidentified" | "phi-bearing" | "unknown";
};

export type AISidebarSessionCreateRequest = {
  viewerContext?: AISidebarViewerContext | null;
  traceId?: string | null;
};

export type AISidebarSessionResponse = {
  sessionId: string;
  status: "ready" | "fallback";
  createdAt: string;
  backendBound: boolean;
  voiceFirst: boolean;
  orchestrationMode: AISidebarOrchestrationMode;
  message: string;
};

export type AISidebarAttachment = {
  id: string;
  kind: string;
  label: string;
  metadata: Record<string, unknown>;
};

export type AISidebarMessageRequest = {
  text?: string;
  inputSource?: AISidebarInputSource;
  attachments?: AISidebarAttachment[];
  viewerContext?: AISidebarViewerContext | null;
  traceId?: string | null;
};

export type AISidebarAssistantMessage = {
  role: "assistant";
  text: string;
  createdAt: string;
  modelId: string;
  modelVersion: string;
};

export type AISidebarTurnResponse = {
  sessionId: string;
  turnId: string;
  status: "completed";
  assistantMessage: AISidebarAssistantMessage;
  route: string[];
  auditTraceId: string;
  persisted: boolean;
  warnings: string[];
};

export type DerivedDicomObject = {
  objectType: string;
  studyInstanceUID: string;
  seriesInstanceUID?: string;
  sopInstanceUID?: string;
  storageClass: string;
  contentType?: string;
  payloadRef?: string;
  metadata?: Record<string, unknown>;
};

export type DerivedResultRecord = {
  id: string;
  studyInstanceUID: string;
  seriesInstanceUID?: string;
  sopInstanceUID?: string;
  objectType: string;
  storageClass: string;
  contentType: string;
  payloadRef?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type DerivedResultRequest = {
  objects: DerivedDicomObject[];
  traceId?: string;
};

export type DerivedResultStowRequest = {
  studyInstanceUID: string;
  objectType: string;
  storageClass: string;
  seriesInstanceUID?: string;
  sopInstanceUID?: string;
  contentType?: string;
  metadata?: Record<string, unknown>;
  traceId?: string;
};

export type StoreResult = {
  stored: string[];
  warnings: string[];
};

export type DerivedResultResponse = {
  result: StoreResult;
  traceId: string;
};

export type AuditEvent = {
  eventId: string;
  occurredAt: string;
  actorUserId: string;
  actorRole: string;
  action:
    | "IMPORT_STUDY"
    | "SEARCH_STUDY"
    | "OPEN_STUDY"
    | "VIEW_SERIES"
    | "CREATE_MEASUREMENT"
    | "STORE_SEG"
    | "SAVE_REPORT"
    | "FINALIZE_REPORT"
    | "RUN_AI"
    | "ACCEPT_AI"
    | "REJECT_AI";
  patientRef?: string;
  studyInstanceUID?: string;
  resourceType: "study" | "series" | "report" | "ai_job" | "derived_object";
  resourceId: string;
  traceId: string;
  sourceIp: string;
  outcome: "success" | "failure";
};

export type AuditStudyResponse = {
  studyInstanceUID: string;
  events: AuditEvent[];
};

export type StudyWorkspace = {
  worklistRow: WorklistRow | null;
  reports: ReportRecord[];
  aiJobs: AIJobRecord[];
  derivedResults: DerivedResultRecord[];
  audit: AuditEvent[];
};

export type ClinicalPlatformConfig = {
  mode: AppMode;
  experimentalRoutesEnabled: boolean;
  localImagingEnabled: boolean;
  viewerBaseUrl: string;
  viewerKind: string;
  viewerBasePath: string;
  authMode: AuthMode;
  aiDefaultWorkflowMode: WorkflowMode;
  aiAllowActive: boolean;
};
