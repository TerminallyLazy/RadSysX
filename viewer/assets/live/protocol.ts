/** Browser-only wire contract; backend remains the authority for actor and policy. */
export type Attestation = 'synthetic' | 'deidentified';
export type Json = Record<string, unknown>;
export type ProviderId = 'gemini' | 'openai';
export type AIProviderCredentialStatus = { id: ProviderId; label: string; configured: boolean; source: 'saved' | 'environment' | 'none'; environmentConfigured: boolean };
export type AICredentialStatusResponse = { storageAvailable: boolean; providers: AIProviderCredentialStatus[] };
export type ProviderProfile = { id: ProviderId; label: string; modelId: string; availability: 'configured' | 'unavailable' | 'disabled'; reason: string; inputSampleRate: 16000 | 24000; outputSampleRate: 24000; screen: boolean; tools: boolean };
export type AudioChunk = { itemId: string; contentIndex: number };
export type PlaybackStop = AudioChunk & { audioEndMs: number };
export type ScreenSharing = { kind: 'screen_sharing'; active: boolean };
export type ScreenStatus = { kind: 'screen_status'; active: boolean; frameReceived: boolean };
export type ViewerContext = {
  targetId: string;
  captureTarget: 'viewer';
  route: string;
  privacyClass: 'unknown' | 'deidentified';
  studyInstanceUID?: string;
  seriesInstanceUID?: string;
  state: Json;
};
export type Session = {
  mode?: 'voice' | 'text';
  sessionId: string;
  providerId?: ProviderId | 'nvidia_nim' | 'codex';
  modelId?: string;
  inputSampleRate?: 16000 | 24000 | null;
  outputSampleRate?: 24000 | null;
  status: string;
  contextVersion: number;
  liveUrl?: string | null;
  expiresAt?: string | null;
  message?: string;
  viewerContext?: { targetId?: string } | null;
};
export type SavedConversation = { session?: Session; events: Json[]; tools?: Json[] };
export type ServerEvent = Json & {
  kind: string;
  sessionId: string;
  sequence: number;
  contextVersion: number;
};
export type Transcript = { id: string; role: string; text: string; finished: boolean };
export type Tool = { id: string; name: string; args: Json; status: string; approval: boolean; result?: Json; research?: Json; progress?: string };
export type Citation = { title: string; url: string };
export type CaptureRequest = {
  sessionId: string; contextVersion: number; targetId: string; viewportId: string;
  rect: { x: number; y: number; width: number; height: number };
};
export type ViewImage = { data: string; mimeType: 'image/jpeg'; width: number; height: number; targetId: string; contextVersion: number; capturedAt: string };
export type DesktopCapture = {
  startViewerCapture(request: CaptureRequest): Promise<{ leaseId: string; expiresAt: number }>;
  captureViewerFrame(request: CaptureRequest & { leaseId: string }): Promise<{
    data: string; mimeType: string; contextVersion: number; targetId: string; width: number; height: number;
  }>;
  stopViewerCapture(request: { leaseId?: string }): Promise<unknown>;
};

export function object(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
}
export function toolFromWire(value: Json, historical = false): Tool {
  return { id: String(value.toolCallId), name: String(value.name), args: object(value.args), status: String(value.status),
    approval: !historical && value.requiresApproval === true && value.status === 'awaiting_approval',
    ...(value.result && typeof value.result === 'object' ? { result: object(value.result) } : {}),
    ...(value.research && typeof value.research === 'object' ? { research: object(value.research) } : {}),
  };
}
export function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
export function escape(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
export function parseEvent(value: string): ServerEvent | null {
  try {
    const event = object(JSON.parse(value));
    if (typeof event.kind !== 'string' || typeof event.sessionId !== 'string' ||
        !Number.isSafeInteger(event.sequence) || !Number.isSafeInteger(event.contextVersion)) return null;
    return event as ServerEvent;
  } catch { return null; }
}

/** Reject duplicates, old sockets, and events for a previous image context. */
export class EventGate {
  sequence = -1;
  constructor(public sessionId: string, public contextVersion: number) {}
  accepts(event: ServerEvent): boolean {
    if (event.sessionId !== this.sessionId || event.contextVersion !== this.contextVersion || event.sequence <= this.sequence) return false;
    this.sequence = event.sequence;
    return true;
  }
}

/** Partial transcripts are not durable completion or interaction-idle signals. */
export class TranscriptStore {
  items: Transcript[] = [];
  private generation = 0;
  append(role: string, text: string, turnId: string, finished: boolean): void {
    const id = `${this.generation}:${role}:${turnId}`;
    let item = this.items.find(entry => entry.id === id && !entry.finished);
    if (!item) {
      item = { id, role, text: '', finished: false };
      this.items.push(item);
    }
    item.text += text;
    item.finished = finished;
    if (this.items.length > 300) this.items.splice(0, this.items.length - 300);
  }
  interrupt(): void {
    this.items.forEach(item => { item.finished = true; });
    this.generation += 1;
  }
}

export class ImageInputRejected extends Error {}

export async function request<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(path, {
    credentials: 'include', cache: 'no-store', method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    // Do not surface arbitrary backend error payloads or private request context.
    if (response.status === 409 && path.endsWith('/text-turns')) {
      const detail = object(await response.json().catch(() => ({}))).detail;
      if (typeof detail === 'string' && [
        'Viewer image attachments currently require a ChatGPT / Codex model.',
        'The attached view is no longer current. Remove it and attach the current view again.',
        'The selected subscription model does not advertise image input. Choose an image-capable model in Settings.',
      ].includes(detail)) throw new ImageInputRejected(detail);
    }
    if (response.status === 401) throw new Error('Sign in to start the assistant.');
    if (response.status === 403) throw new Error('This session or action is not permitted.');
    if (response.status === 409) throw new Error('The image context changed. Review it and reconnect.');
    throw new Error(`Assistant request failed (${response.status}).`);
  }
  return response.json() as Promise<T>;
}

export type ResearchProviderId = 'gemini' | 'nvidia_nim' | 'codex';
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

export type { DesktopStudyCapture, StudyCaptureBinding, ShareSelection, RendererBinding, FrameDescriptor, SeriesManifest, Presentation, ObservationRequest, ImageObservation, ImageReceipt, ObservationResult, CoverageReceipt, ExplorationGrant, ActionRequest, RendererCommand, ActionResult, TaskSnapshot } from '@radsysx/clinical-web';
