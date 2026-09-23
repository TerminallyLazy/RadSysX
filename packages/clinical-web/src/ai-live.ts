import type { AISidebarSessionResponse, AISidebarViewerContext } from "./contracts";

export type AILiveToolStatus = "pending" | "awaiting_approval" | "running" | "completed" | "failed" | "cancelled" | "interrupted" | "outcome_unknown" | "denied";
export type AILiveSource = { id: string; title: string; url: string };
export type AILiveTool = {
  toolCallId: string; name: string; args: Record<string, unknown>;
  status: AILiveToolStatus; requiresApproval: boolean; contextVersion: number;
  result?: Record<string, unknown> | null;
  research?: { providerId: string; modelId: string; recordedAt: string };
};
type Envelope = { sessionId: string; sequence: number; contextVersion: number; interactionId?: string };
export type AILiveEvent = Envelope & (
  | { kind: "session"; status: AISidebarSessionResponse["status"]; message?: string }
  | { kind: "transcript"; role: "user" | "assistant"; text: string; finished: boolean; turnId: string }
  | { kind: "interaction"; status: "IN_PROGRESS" | "IDLE" }
  | { kind: "interrupted" }
  | { kind: "audio_chunk"; itemId: string; contentIndex: number }
  | { kind: "screen_status"; active: boolean; frameReceived: boolean }
  | { kind: "research_progress"; toolCallId: string; stage: string }
  | ({ kind: "tool" } & AILiveTool)
  | { kind: "viewer_action"; toolCallId: string; name: string; args: Record<string, unknown> }
  | { kind: "citations"; sources: AILiveSource[]; suggestionsHtml?: string }
  | { kind: "error"; code: string; message: string }
  | { kind: "pong" }
);
export type AILiveClientEvent = { contextVersion: number } & (
  | { kind: "text"; text: string }
  | { kind: "screen"; data: string; mimeType: "image/jpeg" | "image/png" }
  | { kind: "screen_sharing"; active: boolean }
  | { kind: "audio_end" }
  | { kind: "playback_stop"; itemId: string; contentIndex: number; audioEndMs: number }
  | { kind: "action_result"; toolCallId: string; status: "completed" | "failed"; result: Record<string, unknown> }
  | { kind: "ping" }
);
export type AILiveHistory = { session: AISidebarSessionResponse; events: AILiveEvent[]; tools: AILiveTool[] };
export type AILiveContextUpdate = { contextVersion: number; viewerContext: AISidebarViewerContext; attestation?: "synthetic" | "deidentified" | null };
