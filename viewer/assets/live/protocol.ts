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
  sessionId: string;
  providerId?: ProviderId;
  modelId?: string;
  inputSampleRate?: 16000 | 24000;
  outputSampleRate?: 24000;
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
export type Tool = { id: string; name: string; args: Json; status: string; approval: boolean; result?: Json };
export type Citation = { title: string; url: string };
export type CaptureRequest = {
  sessionId: string; contextVersion: number; targetId: string; viewportId: string;
  rect: { x: number; y: number; width: number; height: number };
};
export type DesktopCapture = {
  startViewerCapture(request: CaptureRequest): Promise<{ leaseId: string; expiresAt: number }>;
  captureViewerFrame(request: CaptureRequest & { leaseId: string }): Promise<{
    data: string; mimeType: string; contextVersion: number; targetId: string;
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

export async function request<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(path, {
    credentials: 'include', method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    // Do not surface arbitrary backend error payloads or private request context.
    if (response.status === 401) throw new Error('Sign in to start the assistant.');
    if (response.status === 403) throw new Error('This session or action is not permitted.');
    if (response.status === 409) throw new Error('The image context changed. Review it and reconnect.');
    throw new Error(`Assistant request failed (${response.status}).`);
  }
  return response.json() as Promise<T>;
}
