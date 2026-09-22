# Clinical Backend DOX

## Purpose

- Own the governed clinical FastAPI implementation for sessions, worklist, launch, workspace, reports, AI jobs, derived results, DICOMweb handoff, and audit.

## Ownership

- Owns `auth.py`, `config.py`, `contracts.py`, `db.py`, `dicomweb.py`, `local_imaging.py`, `models.py`, `repositories.py`, `seed_orthanc.py`, and `services.py`.
- Owns SQLAlchemy-backed clinical persistence behavior and seed data conventions.
- Owns `ai_config.py`, `ai_credentials.py`, `ai_provider.py`, `ai_openai.py`, `ai_repository.py`, `ai_live.py`, `ai_routes.py`, `ai_tools.py`, `ai_research.py`, `ai_research_worker.py`, and the guarded synthetic `ai_fixture_server.py`.

## Local Contracts

- Backend-issued signed session cookies are the source of actor identity until real OIDC replaces local auth.
- Do not accept browser-supplied `role`, `user_id`, `requestedBy`, or equivalent actor identity for governed APIs.
- Keep launch sessions opaque. PHI-bearing context must be resolved server-side and not encoded directly into viewer URLs.
- Keep DICOM SR/SEG and other derived object writeback mediated by the backend, including STOW via `POST /api/derived-results/stow`.
- Keep local imaging import, safe ZIP archive expansion, safe imported-study asset summaries/previews/technical analysis, paired NIFTI `.hdr/.img` linking, NRRD header/voxel technical analysis, TIFF SVG header previews, and local DICOMweb serving backend-owned through `local_imaging.py`; imported files must stay in private local storage, not public frontend paths.
- Local DICOMDIR imports must resolve referenced file IDs against included files, including paths relative to the DICOMDIR parent, and must associate the DICOMDIR index with each referenced local study when one media folder contains multiple studies.
- `contracts.py` must stay aligned with `packages/clinical-web/src/contracts.ts`.
- `config.py` owns mode, auth, cookie, viewer, archive, AI, and database settings. Governed modes must not silently fall back to insecure secrets.
- `ai_config.py`, `ai_provider.py`, `ai_openai.py`, `ai_repository.py`, `ai_live.py`, `ai_routes.py`, and `ai_tools.py` own the Live assistant backend. `AISidebar*` and `AILive*` contracts are real owned sessions, streaming, history, tool receipts and reviewed actions; the HTTP deterministic message stub is retired. `ai_research.py` and `ai_research_worker.py` own bounded subprocess delegates.
- Deployment provider credentials come from backend-only `.env.ai`, with process settings taking precedence. Personal credentials use the owner-scoped encrypted store below. Never return provider exception strings/URLs or credentials. Do not import research/MCP/global model clients in pilot/clinical.
- `ai_credentials.py` stores personal Gemini/OpenAI keys in additive `ai_credentials` rows, encrypted with Fernet and bound inside the ciphertext to the signed owner and provider. Personal keys override deployment `.env.ai`/environment keys only for that owner, including live connections and Gemini research. Unreadable personal ciphertext fails closed; it must never silently fall back. Explicit removal restores any deployment fallback.
- `/api/ai/sidebar/credentials` returns configuration source/status only, never a key, fragment or fingerprint. PUT/DELETE require signed `ai.run` authority and an explicit allowed Origin. All credential responses, including errors, use `Cache-Control: no-store`. Bound and validate raw JSON manually with fixed errors so framework validation cannot echo secrets. Saving is configuration only, not provider verification.
- A random master key lives in private POSIX storage: a 0700 `.ai-secrets` directory beside the file-backed clinical SQLite database (normally `backend/.ai-secrets`), with a 0600 `master.key`. `RADSYSX_AI_KEY_STORE_DIR` can choose an existing-parent absolute path. Reject symlinks, foreign ownership, unsafe permissions, nonregular files and malformed keys; open existing key files nonblocking before validating type. Preserve the master key with encrypted database backups. Never derive encryption from desktop/session signing secrets or regenerate a missing master over existing ciphertext. Platforms without these private-file guarantees expose unavailable personal storage while deployment keys remain usable.
- Credential changes hold an actor lock, close all that actor's sessions/jobs before mutation, and serialize with connection acceptance. Synchronous session creation rejects during mutation; other actors remain unaffected. Production provider factories use an immutable owner-resolved runtime configuration; zero-argument injected fixtures never receive real credentials.
- `ai_openai.py` owns the exact `gpt-realtime-2.1-mini` GA WebSocket transport. It uses `RADSYSX_OPENAI_API_KEY`, 24 kHz PCM16, low reasoning, setup acknowledgment, staged completed function calls and serialized response creation. `ai_provider.py` isolates Gemini SDK send payloads from the broker. Neither provider owns app authorization.
- Session provider and wire audio rates derive from the persisted exact model ID. A context update cannot switch provider; unknown provider selection is rejected. OpenAI has no primary-WebSocket handle resumption: fresh connections receive bounded textual context and never replay media or mutations.
- OpenAI audio markers identify the following binary frame but are never journaled. Interruption truncates only issued assistant audio, bounded by the reported heard duration and delivered audio. Do not confuse received audio bytes with actual playback.
- Image sharing requires an explicit context-bound `screen_sharing` control. Reject frames while off. Transient `screen_status` receipts distinguish enabled sharing from a forwarded first frame. Provider context and `viewer_get_state` identify selected-viewport scope, whether a current image exists, and its age. Stop, browser detach and provider reconnect reset image availability; prior images are historical. Never treat structured CT/series state as visual pixel evidence.
- Keep an OpenAI audio marker and binary frame atomic on one browser socket. Readiness follows initial context delivery; queued input rechecks authority and the ready provider identity under the send lock, including after UI transcript delivery. Serialize browser detach cleanup against replacement acceptance.
- A lost OpenAI browser socket resets the provider and cancels pending work. On fresh OpenAI setup, restore bounded user text only; unconfirmed generated assistant speech stays in local history. No media or action replay is permitted.
- Live cloud use requires actor ai.run, allowed Origin, session ownership/expiry and bound synthetic/deidentified attestation. Study/capture changes invalidate previous work/sharing. Clinical mode is disabled in this first release.
- Renderer tools use typed names/arguments and observed receipts. Durable report saves need report.write, backend-resolved study, exact immutable proposal and reviewed approval. Lost receipts are outcome_unknown and must not auto-retry.
- Recheck a tool's durable pending status after emitting its initial event and at execution entry: cancellation during browser delivery remains terminal and must not dispatch a later action. OpenAI receive exhaustion is a connection failure, unlike Gemini's per-turn IDLE iterator completion; never spin on a closed transport.
- Serialize each session's context changes, connection acceptance and closure. Logout closes every owned session, including sessions beyond the paged history view. Preserve completed tool outcomes across transport failure; pending responses may be delivered on handle resumption but must not enter a fresh provider conversation.
- Database ai_live_sessions/events/tools are additive; retain text/citations/receipts until explicit deletion, never raw media/private reasoning/resumption handles. Restart marks interrupted work and clears attestation.
- Research delegates use Gemini 3.8 Flash, job-local StateBackend, public sources, no host filesystem/shell/MCP/recursive agents, two children maximum, 120-second total deadline, and bounded call/output limits. The shared graph middleware caps all actual tool dispatches at 16, including virtual scratch/todo tools, and caps model calls at 12; parallel calls share the same job budget. Returned citations must match retrieved sources.
- `ai_research_worker` accepts an optional passive PubMed capture callback for the separate `backend/evidence_review/capture_worker.py` entrypoint. It receives copies of source/XML data; failures cannot alter normal tool returns. Live research still uses only progress/result frames and never receives evaluation judgments or the TypeSafe key.
- ai_fixture_server.py is a fixed synthetic-only entrypoint guarded by RADSYSX_DESKTOP_ALLOW_TEST_SHUTDOWN=1; normal runtime cannot choose it. It substitutes Gemini/OpenAI transports and delayed synthetic research jobs, exercises audio while two jobs run, and repeats a tool ID to test idempotency. Its smoke-only counters expose transient frame counts/byte sizes/formats, never media. It is never evidence of real provider acceptance.

## Work Guidance

- Put request/response definitions in `contracts.py`.
- Put orchestration and policy in `services.py`.
- Put persistence in `repositories.py` and `models.py`.
- Put DICOMweb/Orthanc boundary logic in `dicomweb.py`.
- Put local DICOM/DICOMDIR/NIFTI/NRRD/fallback-file import detection, bounded ZIP archive expansion, storage, asset summaries, backend-mediated previews, deterministic technical analysis, NIFTI header/multi-axis slice inspection including paired `.hdr/.img` voxel data, NRRD header/raw-or-gzip voxel metrics, TIFF header preview/metrics, and local DICOMweb metadata/frame serving logic in `local_imaging.py`.
- Keep audit events meaningful but avoid recording unnecessary identifiers or payload detail.

## Verification

- `python3 -m pytest backend/tests/test_clinical_platform.py`
- `python3 -m compileall backend/clinical backend/server.py`
- `python3 -m pytest backend/tests/test_ai_live.py backend/tests/test_ai_research.py`

## Child DOX Index

- None.
