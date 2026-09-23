# Desktop AI activation and observability

Verified on 2026-09-22, native macOS development host. Linux remains the reference target; no Linux or Docker acceptance is claimed here.

## Runtime activation

The working checkout was advanced to merged main `24be139` (PR #78), then startup/observability fixes were developed on `codex/desktop-ai-activation`. The repo Python 3.12 environment was installed from `backend/requirements-ai.txt`, including `langchain-nvidia-ai-endpoints==1.4.3`. `pip check` passed. Credentials, local databases and unrelated working-tree edits were preserved.

The stale backend listeners on 8000/8001 and static preview on 32489 were stopped after checking their owning processes. `npm run desktop` starts the actual `backend.server:app`, production frontend and rebuilt OHIF distribution under `http://127.0.0.1:3000`. The native window was inspected directly; NVIDIA research settings and Jev availability are present. An accidentally launched bare Electron bundle was closed; it was not the RadSysX launcher. Start through `npm run desktop`, not by opening `node_modules/electron/dist/Electron.app` directly.

## Startup hardening

- Bootstrap checks actual imports of native Gemini/NVIDIA adapters, DeepAgents and LangGraph in the repo venv, in addition to pin checks and `pip check`.
- npm 11 can reject a nested project install when `npm run` re-exports a file-backed `allow-scripts` policy. The helper removes that environment copy only if the identical policy remains in the normal `.npmrc` cascade; it preserves stricter flags and fails on missing/different policy. No owner npm configuration is edited.
- Doctor reports app-level voice configuration, research provider/model, NVIDIA and Jev configuration separately. It does not perform inference or inspect personal credentials.
- MLX VoiceChat remains explicitly deferred. Launching RadSysX does not start local model servers or make automatic Jev calls.

## Visible research and Jev workflow

Research cards precede the transcript in the existing scroll region. They show recorded dispatch provider/model, queued/start/model-wait/search/source/answer steps, terminal status, request details and cancellation. Progress is restricted to named stages; no provider reasoning or raw exceptions are streamed. Provider/worker timeouts produce a fixed `research_timeout` result. Ending voice refreshes authoritative saved tool states; unavailable receipts are unconfirmed, never fabricated completion.

The visible **Jev evidence review** entry explains the task and provides **Review latest evidence with Jev** plus **Saved research**. The latest action opens the most recent eligible completed PubMed result. When evidence is absent, the sidebar explains the prerequisite. Preparation fetches original abstracts; only explicit exact-text confirmation and selected claims allow TypeSafe inference. Saved judgments distinguish support, partial support, contradiction, mixed and not addressed, with execution receipts. Original research answers remain unchanged. This is text evidence review, not image anomaly detection.

## Verification

- Full desktop bootstrap through `npm run desktop:bootstrap` passed, including the previously failing nested npm install; workspace audit reported zero vulnerabilities.
- Desktop launcher `--check-only`, doctor, actual normal Electron launch and venv consistency passed.
- 213 focused backend tests passed across research, Live broker, research preferences, credentials, Jev provenance/service/routes.
- 43 viewer tests and 20 desktop protocol/environment tests passed; viewer type check and production build passed.
- Guarded synthetic Electron evidence-review smoke passed: visible Jev/latest action, progress journal and model identity, preview before inference, selected claims, saved resolved-model receipt, unchanged answer, cancellation/unknown usage, independent voice lifecycle, saved-history reopening/deletion and all 82 fixture catalog models. This test uses synthetic providers and does not prove cloud access.
- Native desktop settings fetched all 82 models returned by the live NVIDIA catalog endpoint. A listing does not establish model entitlement, task or voice compatibility; a different tool's catalog may differ.

## Hosted-provider evidence and limits

The normal desktop-served sidebar connected to OpenAI Realtime with microphone and image sharing off. A public NLST/PubMed software acceptance request dispatched the configured NVIDIA `z-ai/glm-5.3-flash` research graph; its provider/model were recorded in the live database. That initial job failed after approximately 61 seconds before a PubMed tool call. An isolated call through the actual native DeepAgents worker reproduced `SocketTimeoutError`; a direct minimal request to NVIDIA's official chat-completions endpoint also timed out after 30 seconds. No provider exception detail or credential was exposed to the application.

A subsequent test from the actual native sidebar, using only a generated checkerboard DICOM and public query, recorded `queued → starting → waiting_model`. The user changed the viewer study during that test; the job was cancelled and the session closed, with no sources returned. The new Jev entry was visibly verified in that native window.

These observations prove dispatch and identify a hosted request timeout; they do not establish successful live NIM research or a new live Jev review. Earlier provider acceptance remains separately recorded in `NIM_IMPLEMENTATION.md` and `JEV_SIDEBAR_IMPLEMENTATION.md`. Physical microphone/speaker, real-patient use, clinical validation, Orthanc and MLX VoiceChat were not tested in this activation work.

## Voice-independent chat and research

Typed Send now uses the selected standard Gemini/NVIDIA model without Realtime; Research explicitly dispatches the bounded DeepAgents graph. Both retain synthetic/deidentified confirmation, owned idempotent jobs, cancellation, saved progress/results and exact dispatch model receipts. Text-only context contains neutral modality/count/series metadata, not pixels or patient records. Chat adds bounded prior completed chat turns; public research receives no chat history. No model or provider is silently substituted. Connect voice starts a new voice conversation. Settings is labeled Text & research models.

Focused validation after this addition: 333 backend tests, 45 viewer tests, frontend/viewer type checks and rebuilt viewer. Guarded Electron acceptance additionally exercises chat and research with zero voice connections; hosted-provider acceptance remains separate.

The real text-only NVIDIA test used `z-ai/glm-5.3-flash` with a fixed synthetic “Reply with OK” question and no image or patient data. It reached the native hosted adapter but timed out after 60.8 seconds. Therefore independent text/research software acceptance passed, while successful hosted GLM output remains unverified. The selected model was not substituted.
