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

export type AISidebarProvider = {
  id: "gemini" | "openai";
  label: string;
  modelId: string;
  availability: "configured" | "unavailable" | "disabled";
  reason: string;
  inputSampleRate: 16000 | 24000;
  outputSampleRate: 24000;
  screen: boolean;
  tools: boolean;
};

export type AIProviderCredentialStatus = {
  id: "gemini" | "openai";
  label: string;
  configured: boolean;
  source: "saved" | "environment" | "none";
  environmentConfigured: boolean;
};

/** Status only: saved key values and fragments are never returned. */
export type AICredentialStatusResponse = {
  storageAvailable: boolean;
  providers: AIProviderCredentialStatus[];
};

/** Write-only input; never persist this request in browser state or history. */
export type AICredentialSaveRequest = { apiKey: string };

export type AISidebarCapabilities = {
  evidenceReview: EvidenceReviewAvailability;
  backendBound: boolean;
  voiceFirst: boolean;
  textComposer: boolean;
  contextAttachments: boolean;
  orchestrationMode: AISidebarOrchestrationMode;
  eventTransport: "http" | "sse" | "websocket";
  audioInputModes: string[];
  modelLanes: AISidebarModelLane[];
  safetyNote: string;
  availability: "configured" | "unavailable" | "disabled";
  modelId: string;
  reason: string;
  defaultProviderId: "gemini" | "openai";
  providers: AISidebarProvider[];
};

export type AISidebarViewerContext = {
  studyInstanceUID?: string | null;
  seriesInstanceUID?: string | null;
  sopInstanceUID?: string | null;
  route?: string | null;
  privacyClass?: "local-only" | "deidentified" | "phi-bearing" | "unknown";
  targetId?: string;
  captureTarget?: "viewer";
  state?: Record<string, unknown>;
};

export type AISidebarSessionCreateRequest = {
  providerId?: "gemini" | "openai";
  viewerContext?: AISidebarViewerContext | null;
  traceId?: string | null;
  attestation?: "synthetic" | "deidentified" | null;
};

export type AISidebarSessionResponse = {
  mode?: "voice" | "text";
  sessionId: string;
  status: "allocated" | "ready" | "unavailable" | "closed" | "interrupted" | "connecting" | "reconnecting" | "fallback" | "failed";
  createdAt: string;
  backendBound: boolean;
  voiceFirst: boolean;
  orchestrationMode: AISidebarOrchestrationMode;
  message: string;
  contextVersion: number;
  expiresAt: string | null;
  liveUrl: string | null;
  attestation: "synthetic" | "deidentified" | null;
  viewerContext: AISidebarViewerContext | null;
  modelId: string;
  providerId: "gemini" | "openai" | "nvidia_nim";
  inputSampleRate: 16000 | 24000 | null;
  outputSampleRate: 24000 | null;
};

export type AITextSessionRequest = { viewerContext: AISidebarViewerContext; attestation: "synthetic" | "deidentified" };
export type AITextTurnRequest = { contextVersion: number; idempotencyKey: string; action: "chat" | "research"; text: string };

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

export type ResearchProviderId = 'gemini' | 'nvidia_nim';
export type AIResearchSettings = { providerId: ResearchProviderId; modelId: string; source: 'saved' | 'environment'; providers: { id: ResearchProviderId; label: string; configured: boolean }[] };
export type AIResearchModels = { providerId: ResearchProviderId; models: string[]; capabilitiesVerified: boolean };

// Explicit saved-result review: independent of live voice and image attestation.
export type EvidenceLabel = 'supported' | 'partially_supported' | 'contradicted' | 'mixed' | 'not_addressed';
export type EvidenceStatus = 'preparing' | 'ready' | 'reviewing' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'interrupted' | 'unavailable';
export type EvidenceConfirmation = 'public_literature' | 'synthetic';
export type EvidencePrepareRequest = { idempotencyKey: string };
export type EvidenceRetryRequest = EvidencePrepareRequest & { previewSha256: string; confirmation: EvidenceConfirmation };
export type EvidenceStartRequest = EvidenceRetryRequest & { selectedUnitIds: string[] };
export type EvidenceReviewAvailability = { modelId: 'jev-1.13.0'; availability: 'configured' | 'missing' | 'disabled' | 'unavailable'; reason: string };
export type EvidenceGeneration = { providerId: string | null; modelId: string | null; recordedAt: string | null };
export type EvidenceReviewSummary = {
  reviewId: string; sessionId: string; toolCallId: string; sourceContextVersion: number;
  status: EvidenceStatus; createdAt: string; updatedAt: string; modelId: 'jev-1.13.0'; generation: EvidenceGeneration;
  totalPairs: number; completedPairs: number; settledPairs: number; submittedAttempts: number; unknownUsageAttempts: number; reason: string | null;
};
export type EvidenceClaim = { unitId: string; text: string; start: number; end: number; evidenceIds: string[]; eligible: boolean; exclusionReason: string | null };
export type EvidenceAbstract = {
  evidenceId: string; citationId: string; title: string; pmid: string | null; url: string; retrievedAt: string;
  completeness: 'complete' | 'truncated' | 'absent' | 'unavailable'; sections: { label: string | null; text: string }[];
  textSha256: string; extractionVersion: string;
};
export type EvidenceAttempt = {
  attemptId: string; pairId: string; requestSha256: string; startedAt: string; endedAt: string | null;
  submitted: boolean | null; reason: string | null; usage: Record<string, number> | null;
};
export type EvidenceAssessment = {
  pairId: string; unitId: string; evidenceId: string; status: 'completed' | 'skipped' | 'failed' | 'cancelled'; reason: string | null;
  label: EvidenceLabel | null; requestedModel: string; resolvedModel: string | null; rubricVersion: string; rubricSha256: string;
  answerSha256: string; abstractSha256: string; requestSha256: string | null; attemptIds: string[]; reused: boolean;
  probabilities: Record<EvidenceLabel, number> | null;
};
export type EvidenceReviewDetail = EvidenceReviewSummary & {
  previewSha256: string | null; answerSha256: string | null; snapshotSha256: string | null; originalAnswer: string | null;
  claims: EvidenceClaim[]; abstracts: EvidenceAbstract[]; exclusions: { unitId: string | null; citationId: string | null; reason: string }[];
  selectedUnitIds: string[] | null; assessments: EvidenceAssessment[]; attempts: EvidenceAttempt[]; earlierAttemptCount: number;
};
export type EvidenceReviewList = { reviews: EvidenceReviewSummary[]; truncated: boolean };
