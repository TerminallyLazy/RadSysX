# Realtime Voice And Chat Research Synthesis

Last updated: 2026-06-12
Status: distilled research artifact; not runtime implementation.

## Why This Exists

This file distills the external GPT 5.5 Pro research pass attached to the Codex thread on 2026-06-12. It preserves the parts that should steer RadSysX implementation without copying the entire research transcript into the repo.

Important correction from the user:

- RadSysX is an Electron desktop app and should remain cross-platform.
- Linux/NVIDIA is the first heavy-model validation lane because the next GPU machine is expected to be Linux and Nemotron/NeMo are NVIDIA-oriented.
- Do not describe the product as Linux-only. Validate the local GPU/ASR worker on Linux first, then verify Electron microphone permissions, device routing, and provider realtime flows on Windows and macOS.
- Do not treat API-backed clinical AI as inherently bad. Ambient clinical documentation products already operate in production clinical settings by using consent, security review, contractual safeguards, retention controls, EHR integration, and clinician review. RadSysX should distinguish unmanaged browser-direct PHI transfer from governed API deployment.

## Bottom Line

The recommended architecture is hybrid:

```text
Electron/OHIF sidebar
  -> FastAPI AI session, context, policy, tool, and audit spine
  -> local/mock orchestrator by default
  -> optional local ASR/local model workers
  -> optional provider realtime voice adapters
  -> typed OHIF command bridge
```

Voice is an I/O layer. It must not become the owner of clinical truth.

API is also an I/O/runtime lane. It must not become a shortcut around RadSysX session authority, policy, approvals, or audit.

Core invariant:

```text
Model proposes.
Backend validates.
User approves state-changing actions.
OHIF executes only typed allowlisted commands.
Audit records the whole chain.
```

## Transport Decision

Use this split unless a prototype proves a better one:

| Flow | Transport | Reason |
| --- | --- | --- |
| Text message submit | HTTP POST | Durable state transition with idempotency and audit |
| Context snapshot | HTTP POST | Durable state transition with redaction and policy checks |
| Tool approval/denial | HTTP POST | Explicit user action and audit boundary |
| OHIF execution result | HTTP POST | Durable result of a proposed action |
| Chat/job/tool/audit events | SSE | Simple one-way stream, replayable event IDs, easy audit |
| Local ASR audio | WebSocket | Bidirectional localhost binary PCM/control frames |
| OpenAI Realtime speech | Provider-native WebRTC | Official docs recommend WebRTC over WebSocket for browser/mobile realtime clients |
| Gemini Live speech | Stateful WSS or backend WSS proxy | Official Live API protocol is stateful WebSocket |

Do not use one provider realtime session as the RadSysX clinical spine. Provider sessions are replaceable leaves around backend-owned state.

## Cross-Platform And API Posture

RadSysX should support five deployment lanes:

| Lane | Role | Design posture |
| --- | --- | --- |
| NVIDIA/Linux | First heavy local model validation lane | Validate Nemotron/NeMo, RAVE, BiomedParse, vLLM/SGLang, and GPU metrics; do not make it the only supported product shape |
| Apple Silicon/Metal | High-priority local desktop lane | Investigate MLX, PyTorch MPS, Core ML, whisper.cpp/llama.cpp-style runtimes, and provider realtime in packaged Electron |
| Windows workstation | High-priority hospital/radiology desktop lane | Investigate CUDA where available, DirectML/ONNX Runtime where useful, enterprise microphone permissions, and no-GPU fallbacks |
| CPU/no-GPU | Accessibility lane | Preserve text chat, mock/lightweight local models, and governed API realtime without heavy bootstrap |
| Governed API | Production voice/chat lane | Use backend mediation, explicit enablement, consent, BAA/DPA or equivalent, retention policy, PHI rules, and audit |

The product stance should be:

- Local capability is a strength.
- Open-source local models are strategically important.
- API-backed realtime can be clinically legitimate when governed.
- Browser-direct unmanaged PHI transfer is the thing to avoid.
- The same RadSysX backend contract should support all lanes.

Ambient scribe precedent:

- Microsoft Dragon Copilot, Abridge, Nabla, and similar systems show that ambient listening plus generated clinical documentation can be deployed in real care environments.
- Their lesson for RadSysX is not "always use cloud"; it is "cloud/API can be acceptable when surrounded by consent, contractual safeguards, retention controls, EHR/workflow integration, and human review."
- RadSysX should use this precedent to design a governed provider lane for realtime voice/chat, while still preserving local/offline operation.

References to recheck before implementation:

- <https://www.microsoft.com/en-us/health-solutions/clinical-workflow/dragon-copilot>
- <https://learn.microsoft.com/en-us/industry/healthcare/dragon-copilot/about/>
- <https://www.abridge.com/>
- <https://www.abridge.com/platform/clinicians>
- <https://www.nabla.com/>

## Current Source Snapshot

Checked on 2026-06-12:

- OpenAI documents `gpt-realtime-2` as a state-of-the-art reasoning voice model for low-latency speech-to-speech, stronger tool use, long context, and controllable reasoning effort.
- OpenAI recommends WebRTC rather than WebSocket when connecting browser/mobile clients to Realtime models.
- Gemini Live API documents raw PCM input/output over stateful WebSocket, with `gemini-3.1-flash-live-preview` as the current Live model string found in the external research.
- Gemini Live tool use supports function calling, but Gemini 3.1 Flash Live Preview is documented with synchronous-only function calling and no automatic tool response handling.
- Nemotron 3.5 ASR Streaming 0.6B is a local streaming ASR candidate with documented 80 ms, 160 ms, 320 ms, 560 ms, and 1120 ms chunk sizes.
- OHIF's command architecture is the right control surface. RadSysX should wrap/allowlist commands rather than exposing arbitrary DOM automation.

Links:

- <https://developers.openai.com/api/docs/guides/realtime-webrtc>
- <https://developers.openai.com/api/docs/guides/realtime-models-prompting>
- <https://ai.google.dev/gemini-api/docs/live-api>
- <https://ai.google.dev/gemini-api/docs/live-api/tools>
- <https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b>
- <https://docs.ohif.org/platform/managers/commands>

## MVP Architecture

Goal:

- Move the AI sidebar from frontend-only local state to backend-owned sessions, messages, SSE events, context snapshots, tool proposals, and audit.
- Do not add heavy model dependencies yet.
- Do not add provider credentials or cloud dependency.

MVP shape:

```text
OHIF sidebar
  -> HTTP POST message/context/approval
  -> SSE assistant/tool/job/audit events
  -> FastAPI AI session broker
  -> mock/local orchestrator
  -> typed tool proposal validator
  -> OHIF command bridge
```

MVP acceptance:

- Desktop still opens quickly into `/viewer/local`.
- AI sidebar can send a message to FastAPI.
- Backend streams deterministic assistant events over SSE.
- Backend records session/message/assistant/tool audit events.
- External AI is disabled by default in `pilot` and `clinical`.
- No NeMo, no GPU model, no provider SDK, and no checkpoint download are required.

## V1 Architecture

Goal:

- Make voice real while keeping the backend spine stable.

V1 shape:

```text
Electron/OHIF mic
  -> getUserMedia
  -> Web Audio or AudioWorklet PCM capture
  -> local WebSocket audio session
  -> mock/replay ASR first
  -> optional Nemotron ASR worker
  -> transcript events over SSE
  -> normal message/tool/audit pipeline
```

Voice modes:

- Push-to-talk first. It is the safest default because capture is explicit.
- Dictation second. Transcript should be editable before send.
- Always-listening stays local-only, experimental, and disabled by default.
- Barge-in can interrupt assistant speech, but it must never approve state-changing actions.

## Optional Provider Realtime

OpenAI Realtime:

- Use WebRTC for browser/Electron provider-native speech when explicitly enabled.
- The backend should create or mediate the session, inject the RadSysX tool schema, record policy state, and route tool calls back through the RadSysX broker.
- External PHI must remain disabled by default in `pilot` and `clinical`.

Gemini Live:

- Use backend WSS proxy for governed deployments.
- Browser-direct ephemeral tokens are acceptable only for deidentified research paths allowed by policy.
- Tool responses must be handled manually and normalized into RadSysX `ToolCallProposal`.

## Contract Refinements

Recommended endpoints:

```text
POST /api/ai/sessions
GET  /api/ai/sessions/{sessionId}
POST /api/ai/sessions/{sessionId}/messages
GET  /api/ai/sessions/{sessionId}/events
POST /api/ai/sessions/{sessionId}/close

POST /api/ai/context-snapshots

POST /api/ai/audio-sessions
WS   /api/ai/audio-sessions/{audioSessionId}/stream
POST /api/ai/audio-sessions/{audioSessionId}/commit
POST /api/ai/audio-sessions/{audioSessionId}/cancel

POST /api/ai/tool-proposals
POST /api/ai/tool-proposals/{proposalId}/approve
POST /api/ai/tool-proposals/{proposalId}/deny
POST /api/ai/tool-executions/{proposalId}/result
```

Recommended SSE event types:

```text
session.created
message.accepted
transcript.partial
transcript.final
assistant.delta
assistant.done
tool.proposed
tool.approved
tool.denied
tool.executing
tool.result
job.started
job.progress
job.completed
job.failed
policy.blocked
error
```

## Voice And Chat State Machine

```text
idle
  -> listening
  -> transcribing
  -> thinking
  -> speaking
  -> tool-proposed
  -> awaiting-approval
  -> executing
  -> idle

error
  -> reset or retry
  -> idle
```

Rules:

- `idle`: no microphone capture.
- `listening`: visible hot-mic indicator, timer, cancel button.
- `transcribing`: partial transcript is visibly provisional.
- `thinking`: assistant may stream text, start jobs, or propose tools.
- `speaking`: barge-in can stop speech, not approve actions.
- `tool-proposed`: show summary, risk, expected effects, evidence, and undo plan.
- `awaiting-approval`: approval must be a UI gesture, not inferred from speech.
- `executing`: execute only through the allowlisted OHIF command bridge.
- `error`: preserve the transcript or proposal where possible.

## Tool Safety

Risk levels:

| Level | Examples | Approval |
| --- | --- | --- |
| R0 read-only | list measurements, list segmentations, inspect active viewport | Auto-allowed if policy permits |
| R1 reversible viewer UI | set tool, set window preset, jump to slice, focus measurement | May auto-execute by policy; always audited |
| R2 preview derived result | preview segmentation, temporary contour, opacity change | Visible preview required |
| R3 persistent state | create measurement, insert report draft, save segmentation | Explicit user approval required |
| R4 external/destructive | send externally, delete, export, finalize diagnosis | Disabled by default |

Required validations:

- Strict schema validation with no extra fields.
- Mode and policy validation.
- User role/permission validation.
- Context snapshot and state hash validation.
- Bounds validation for viewport IDs, slice indexes, series refs, and measurement IDs.
- Privacy validation to block PHI, raw DICOM bytes, launch tokens, and raw pixels unless explicitly allowed.
- Idempotency validation.
- Expiry validation for stale proposals.
- Audit validation for proposal, approval, execution, result, and failure.

## First Three PRs

PR 1:

- Title: `backend: add AI session/event/audit contracts`
- Add backend AI sessions, messages, SSE event stream, mock/local orchestrator, and append-only audit events.
- External AI disabled by default.
- No heavy dependencies.

PR 2:

- Title: `viewer: add AI context snapshots and safe OHIF tool proposals`
- Add context snapshot collector, selected measurement/ROI/segmentation refs, redaction report, proposal UI, approve/deny controls, and R1 OHIF command bridge.
- Initial tools: `viewer.setTool`, `viewer.setWindowLevelPreset`, `viewer.jumpToSlice`, `viewer.focusMeasurement`.

PR 3:

- Title: `voice: add local audio session WebSocket and push-to-talk dictation shell`
- Add audio session contract, push-to-talk capture, dictation mode, Web Audio/AudioWorklet PCM capture, local WebSocket stream, mock/replay ASR, and transcript events through the existing SSE stream.
- Keep Nemotron as a later optional worker behind `RADSYSX_ASR_PROVIDER=nemotron` or equivalent.

PR 3 alternative if governed API voice is the product priority:

- Title: `voice: add governed provider realtime session shell`
- Add backend-created/mediated OpenAI/Gemini realtime sessions.
- Add sidebar-visible provider/policy state.
- Add deidentified research mode first.
- Add explicit PHI block/audit events.
- Keep provider tool calls routed through RadSysX `ToolCallProposal`, never directly into OHIF.

## Latency Targets To Measure

Voice:

- Mic activation after PTT: target under 100 ms.
- Audio frame size: target 20-40 ms for v1, acceptable 40-100 ms initially.
- Local ASR first partial: target 250-400 ms, acceptable under 700 ms.
- End-of-speech to final transcript: target under 700 ms, acceptable under 1.5 s.
- Transcript final to first assistant token: target 500-800 ms.
- Simple tool proposal after transcript final: target under 1 s.
- Assistant first spoken audio: provider target under 700 ms, local target under 1.5 s.
- Barge-in cancel: target under 150 ms.
- R1 OHIF command after approval: target under 100 ms.

System:

- ASR dropped frames and queue depth.
- WebSocket send queue bytes and backpressure drops.
- ASR real-time factor and radiology-term errors.
- Tool proposal schema-valid rate.
- Policy-blocked PHI events.
- External bytes sent by mode.
- Audit sequence gaps.
- GPU VRAM, RAM, cold start, warm latency.
- Normal desktop startup impact.

## GPU And Cross-Platform Experiments

Linux/NVIDIA first:

- Nemotron ASR feasibility with 80, 160, 320, 560, and 1120 ms chunks.
- Local ASR fallback benchmark with one CPU-friendly and one smaller GPU-friendly option.
- Local imaging worker experiments for RAVE, BiomedParse, MedGemma, and Pillar-0.
- PHI egress guard with packet capture and audit checks.

Apple Silicon/Metal:

- Test packaged Electron microphone permissions on M-series Macs.
- Benchmark local ASR options suitable for Metal/CPU.
- Benchmark local LLM/tool-router options through MLX, PyTorch MPS, Core ML, llama.cpp-style runtimes, and ONNX Runtime where useful.
- Validate whether medical image/text workers can run locally without breaking the desktop bootstrap.

Windows workstation:

- Test packaged Electron microphone permissions, audio device routing, and enterprise lockdown behavior.
- Benchmark CUDA if NVIDIA GPU is available.
- Benchmark DirectML/ONNX Runtime where useful.
- Validate API realtime as a no-GPU/high-polish lane.
- Validate install/update path without requiring WSL.

Provider realtime:

- OpenAI Realtime WebRTC deidentified prototype with backend SDP/session broker.
- Gemini Live WSS prototype with backend proxy and a separate ephemeral-token research variant.
- Governed API prototype with explicit policy profile, PHI block events, retention labels, and audit trail.

Cross-platform follow-up:

- Windows and macOS microphone permissions in Electron.
- Device selection and hot-plug behavior.
- Bluetooth headset latency.
- Echo cancellation/noise suppression behavior.
- PTT keybinding reliability.
- Provider WebRTC/WSS behavior in packaged Electron builds.
- No-GPU text and API fallback behavior.

## License And Governance Notes

- BiomedParse is not MIT. Verify repository code license, Hugging Face model card, checkpoint terms, data terms, noncommercial/share-alike constraints, and research-only language separately.
- Pillar-0, Sybil, RAVE, and related YalaLab code/checkpoints must also be verified artifact by artifact. Do not assume one license across the family.
- Provider realtime availability does not imply permission to send PHI.
- Image pixels can contain burned-in PHI; screenshots/current viewport images are PHI-bearing until proven otherwise.
- ASR errors can be clinically meaningful. Never let speech alone approve persistent clinical actions.
