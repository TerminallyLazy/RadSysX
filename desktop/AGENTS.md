# Desktop DOX

## Purpose

- Own the RadSysX Electron fast path for local, no-Docker startup.
- Provide a friendly desktop entry point that starts the local FastAPI backend, Next.js shell, and OHIF viewer bridge under one localhost origin.
- Enable the backend-owned local imaging import path for no-Docker DICOM/DICOMDIR/NIFTI/NRRD/fallback-file ingestion.
- Provide session-bound capture of the selected OHIF viewport for backend-mediated Gemini Live or OpenAI Realtime conversations using synthetic or deidentified data.

## Ownership

- Owns `package.json`, Electron main/preload code, desktop helper scripts, and local desktop runtime documentation.
- Does not own clinical backend contracts, frontend route behavior, or viewer runtime assets.

## Local Contracts

- The desktop path is a local convenience runtime. Its default open-source first screen is OHIF standalone local mode, while governed clinical contracts remain available when a launch token is explicitly used.
- Electron must keep the app shell, `/api`, and `/viewer` under one local origin so clinical cookies and opaque launch sessions work without nginx.
- The default Electron first route is `/viewer/local`, which shows OHIF's native local DICOM loader immediately. Use `RADSYSX_DESKTOP_START_PATH` only for intentional alternate-start validation.
- The visible Electron window title must stay `RadSysX`, even after OHIF updates the browser document title.
- `npm run desktop` is the user-facing fast-path command from the repo root. It runs a non-mutating desktop bootstrap check, repairs setup through `npm run desktop:bootstrap` when allowed, then opens the OHIF-first Electron app. Use `npm run desktop:run` or the workspace `npm run dev --workspace @radsysx/desktop` only for intentional direct-run developer bypasses.
- The default desktop frontend path is a production Next.js standalone shell built with same-origin public API/viewer defaults and reused via `frontend/.next/radsysx-desktop-build.json`; use `RADSYSX_DESKTOP_REBUILD_FRONTEND=1` to force a rebuild. Do not stamp the default build to an absolute localhost port unless an explicit `NEXT_PUBLIC_*` override needs that behavior.
- `RADSYSX_DESKTOP_FRONTEND_MODE=development` is the explicit live-UI-development mode and may use the Next.js dev server; normal fast-path validation should prefer the production standalone frontend.
- The local bridge may serve the generated `viewer/dist/` app and proxy backend routes, but durable OHIF behavior still belongs in `viewer/` assets or backend contracts.
- The desktop runtime must rebuild `viewer/dist/` when viewer runtime assets or the viewer build wrapper are newer than the generated files; do not silently reuse stale ignored OHIF output.
- Live viewer freshness includes `assets/live/`, `scripts/build-live.mjs`, `tsconfig.live.json`, and both generated Live controller/audio-worklet bundles.
- The local bridge must proxy Next.js development static assets and WebSocket upgrades reliably enough for the Electron shell to hydrate through the one-origin desktop URL.
- The bridge may use tolerant HTTP parsing only for trusted loopback upstreams that the desktop runtime starts itself; do not apply parser leniency to arbitrary remote archive targets.
- Do not add PHI-bearing launch context to desktop URLs.
- Do not let the browser write directly to Orthanc; backend-mediated derived result paths remain authoritative.
- A missing local DICOMweb archive should degrade honestly. Full Orthanc-backed image retrieval remains the compose-stack path until a local archive bundle is added.
- Desktop sets `RADSYSX_LOCAL_IMAGING_ENABLED=true` and stores local imports in an ignored repo-local backend data directory unless overridden.
- When `RADSYSX_DESKTOP_DICOMWEB_TARGET` is unset, the desktop bridge routes `/dicom-web` to the backend's local DICOMweb endpoints for imported DICOM studies.
- The Electron-supervised backend runs uvicorn without access logs so local DICOMweb query strings and workspace URLs are not casually printed during desktop use or smoke tests.
- `preload.cjs` exposes only narrow desktop helpers, including native local imaging file/folder selection and the preferred direct desktop import bridge; browser drag-and-drop remains a portable frontend fallback and must still import through backend contracts. Do not expose raw filesystem or shell primitives to the renderer.
- All privileged IPC validates the originating RadSysX main `webContents`, exact public origin, and main frame. Capture and microphone access additionally require an OHIF viewer route; SMART FHIR routes are excluded from this initial synthetic/deidentified integration.
- `startViewerCapture`, `captureViewerFrame`, and `stopViewerCapture` expose an explicit capture lease. Requests bind the backend session ID, context version, target ID, and selected `viewportId`; rect coordinates must match the visible `data-viewportid` element containing an imaging canvas. Main captures only that element from its own `webContents`, with no operating-system screen/window enumeration.
- Main checks the actor's cookie-authenticated backend session before and after capture, requires `ready` with current synthetic/deidentified attestation, limits capture to one frame per second, preserves aspect ratio within 768 by 768 pixels, and returns ephemeral JPEG bytes. Leases expire after 15 seconds without a successful frame and revoke on stop, navigation, process loss, context/attestation invalidation, logout, or shutdown. In-flight frames after revocation must be discarded.
- Media permission handlers allow microphone audio only for the same viewer main frame, and deny camera and general display-capture permissions. Native fullscreen and pointer-lock viewer controls remain permitted in that frame. Hardware permission prompts remain platform-owned; synthetic smoke uses fake media devices.
- Provider and clinical credentials are removed from frontend, viewer, npm, and build child environments. Only the backend inherits them and reads ignored repo-root `.env.ai`; never export that file into shared process environment. The backend keys are `RADSYSX_GEMINI_API_KEY` and `RADSYSX_OPENAI_API_KEY`. Doctor reports configuration readiness for each provider independently from dependency readiness and never contacts either provider or prints keys. Secret-filter regression coverage must include both keys for frontend/viewer/build children.
- Sidebar API key settings store personal Gemini/OpenAI keys through authenticated backend contracts. Doctor inspects only deployment `.env.ai`/environment configuration; it cannot determine whether the current actor has a saved key and must label its status app-level. The backend encrypts saved keys in the clinical database and keeps its master key in a private credential directory (overridable with `RADSYSX_AI_KEY_STORE_DIR`); keep both out of source control. UI smokes always override the credential directory into their own isolated temporary workspace so no user vault is touched.
- The preferred native desktop import path should keep selected file paths and file bytes in Electron main, attach the existing backend-issued session cookie from the Electron cookie jar, and POST multipart data to `POST /api/local-imaging/import` through the one-origin desktop bridge.
- The legacy `selectLocalImagingFiles` helper may remain as a compatibility fallback, but normal desktop worklist imports should prefer `importLocalImaging` so large folders do not need to cross renderer IPC as ArrayBuffers.
- The desktop native picker must admit extensionless non-hidden files as DICOM candidates, paired NIFTI `.hdr/.img` files, NRRD `.nrrd` files, and `.zip` archives so DICOMDIR companions, paired voxel data, segmentation/labelmap volumes, and bundled local studies can reach backend format detection/linking; unsupported candidates are still rejected by the backend import contract.
- `RADSYSX_DESKTOP_ALLOW_TEST_SHUTDOWN=1` enables the local `/_radsysx/desktop/shutdown` endpoint for smoke tests only; do not enable it for normal desktop runs.
- `RADSYSX_DESKTOP_PICKER_TEST_PATHS` may be honored only when `RADSYSX_DESKTOP_ALLOW_TEST_SHUTDOWN=1`; it is a smoke-only native picker bridge override, not a normal desktop runtime feature.
- `RADSYSX_DESKTOP_PYTHON` may point the desktop runtime/bootstrap/smoke scripts at a specific Python executable; otherwise they use `PYTHON`, then the platform-correct repo-local venv Python, then a platform default (`python` on Windows, `python3` elsewhere).
- `RADSYSX_DESKTOP_EXIT_AFTER_READY_MS` should schedule smoke shutdown immediately after internal services report ready, before waiting on the final app URL load, so startup smokes cannot hang behind slow dev-shell navigation; scheduled startup-smoke teardown may suppress transient loopback Next.js dev asset parse noise.
- `npm run desktop:smoke:launch` should keep proving the same user-facing launcher contract as `npm run desktop`: bootstrap check first, then service-ready Electron startup with the OHIF-first default retained, with `--smoke` setting a cross-platform startup shutdown timer. `npm run desktop:smoke:local-start` remains the smoke that samples the first-screen OHIF standalone local UI.
- `npm run desktop:smoke:import` should keep proving local DICOMDIR/DICOM/NIFTI `.nii`/`.nii.gz`/paired `.hdr+.img`, NRRD `.nrrd`, ZIP archives containing supported files, plus PNG/JPEG/TIFF import, asset summaries, local previews including NIFTI slice navigation, JPEG byte preview retrieval, TIFF SVG header preview, NRRD technical analysis, DICOMweb discovery, and opaque launch without Docker.
- `npm run desktop:smoke:local-start` should keep proving Electron opens first into `/viewer/local`, has no RadSysX bootstrap card, has no governed launch context, exposes OHIF's local file/folder controls, keeps the document title as `RadSysX`, loads a synthetic DICOM through OHIF's local file input, routes to `/viewer/dicomlocal?datasources=dicomlocal`, suppresses the clinical workspace panel, paints a nonblank OHIF canvas, and exposes the voice-first RadSysX AI right-sidebar composer. Before explicit attestation/connect it must show disconnected/unavailable state with microphone/sharing disabled and no fabricated session or attachments; `@` offers actual measurements/segmentations or an instructional empty state.
- `npm run desktop:smoke:local-start-drop` should keep proving the same first OHIF local screen accepts dropped DICOM files directly, forwards the drop to OHIF's local file input, routes to `/viewer/dicomlocal?datasources=dicomlocal`, avoids a governed launch, paints a nonblank OHIF canvas, and exposes the same voice-first RadSysX AI composer.
- `npm run desktop:smoke:local-start-nondicom` should keep proving Electron still opens first into `/viewer/local` and that NIFTI/NRRD/image/ZIP fixtures remain usable through `/worklist` inspection, local previews, NIFTI axis switching, and backend technical analysis without exposing an OHIF viewer action.
- `npm run desktop:smoke:ui-import` should keep proving the hydrated worklist UI can import dropped local imaging files, inspect imported assets including PNG/JPEG/TIFF fallback images, change NIFTI preview slices, and run backend technical analysis without Docker.
- `npm run desktop:smoke:picker-files-import` should keep proving the hydrated worklist UI can invoke the `Import files` action through the Electron native picker bridge, pass smoke-injected individual file paths through `preload.cjs`, upload selected files from Electron main to the backend import endpoint, inspect imported assets, change NIFTI preview slices, and run backend technical analysis without Docker.
- `npm run desktop:smoke:picker-import` should keep proving the hydrated worklist UI can invoke the Electron native folder picker bridge through `preload.cjs`, read a selected folder through the main-process recursive collector, upload selected files from Electron main to the backend import endpoint, inspect imported assets, change NIFTI preview slices, and run backend technical analysis without Docker. This does not replace a human or OS-automation smoke of the actual native dialog.
- `npm run desktop:smoke:picker-large-import` should keep proving the same direct native picker import path with an additional 8 MiB synthetic NIFTI volume, including backend asset summary, preview, and technical analysis checks.
- `npm run desktop:smoke:picker-many-import` should keep proving the same direct native picker import path with a nested folder of 32 additional extensionless DICOM instances, including recursive folder collection, backend import of 44 accepted files after ZIP expansion, DICOM asset summary, and technical analysis checks.
- `npm run desktop:smoke:viewer-launch` should keep proving the hydrated worklist can import a local DICOM/DICOMDIR study, launch it through the governed viewer path, resolve the opaque launch in `/viewer/`, strip the launch token from the browser URL, bind OHIF runtime configuration to same-origin local DICOMweb roots, query the imported study from the viewer origin, and paint a nonblank OHIF canvas for the synthetic imported DICOM.
- Desktop UI smokes force-refresh the frontend production shell by default so smoke assertions always exercise the current source tree, not a stale stamped build.
- `npm run desktop:bootstrap` is a Node-based cross-platform bootstrap helper, not a POSIX shell activation chain; it creates/uses `.venv`, installs `backend/requirements-ai.txt` (which includes clinical requirements) with the venv Python, runs workspace `npm install --legacy-peer-deps`, and then runs desktop doctor. `npm run desktop:bootstrap -- --check` verifies clinical/AI imports and the pinned Live SDK without reinstalling dependencies. This does not install the legacy `backend/requirements.txt` stack.
- Bootstrap preserves an existing repo virtual environment instead of recreating it with a changed host interpreter; on Unix it prefers `python3.12` when creating a new environment, following any explicit Python override.
- `npm run smoke:ai-live --workspace @radsysx/desktop` launches its own isolated database/profile and backend fake provider, replaces only its own page with a synthetic viewport, and verifies same-origin authenticated WebSocket audio/action traffic plus capture/stop. Two delayed synthetic research tasks must overlap while audio continues, return citations, and complete before IDLE; replaying a completed viewer call must not repeat the app action. It proves transport and Electron boundaries, not physical-device audio or authenticated Gemini. `RADSYSX_DESKTOP_BACKEND_APP` accepts only `backend.clinical.ai_fixture_server:app`, only alongside `RADSYSX_DESKTOP_ALLOW_TEST_SHUTDOWN=1`; normal runs always load `backend.server:app`.
- `RADSYSX_KEEP_UI_IMPORT_SMOKE_TMP=1 npm run smoke:local-start --workspace @radsysx/desktop` retains that synthetic test workspace and writes `synthetic-viewer-sidebar.png` for visual review after successful DICOM/sidebar assertions. Capture is limited to the smoke's own application and generated test image.
- `npm run smoke:ai-viewer --workspace @radsysx/desktop` extends the local-start DICOM test with the fake backend provider, actual sidebar synthetic attestation/connect/share, an actual OHIF window/level action with backend completion, and stop/end. Chromium's fake microphone runs through the actual AudioWorklet, controller and WebSocket; guarded fixture counters must observe 640-byte PCM16 frames at 16 kHz, zero input before activation, and stable byte counts after mute/end. No physical microphone is used. A smoke-only bundle of the same compiled adapter verifies real zoom/pan/rotation/flips/invert/reset, slice selection, tool activation, layout restore, Length/ROI creation/edit/jump/delete, measurement undo/redo, and local report-draft undo/redo against OHIF engine/services; no production debug global is exposed. Segmentation selection is unverified without a segmentation fixture. It overrides the provider key with a synthetic unused value. The same optional screenshot flag captures the final synthetic sidebar and checks connected/ended layout bounds.
- `scripts/ai-dependencies.mjs` derives exact supported versions from every direct pin in `backend/requirements-ai.txt` plus HTTPX/Pydantic pins in `backend/requirements-clinical.txt`. Bootstrap checks and doctor share this comparison and reject missing or mismatched versions; configuration readiness is separate and makes no cloud request.
- `node desktop/scripts/ui-import-smoke.mjs --local-start --ai-live --openai` repeats the complete actual-sidebar/adapter smoke with OpenAI selected through the real provider dropdown. It verifies the persisted exact model and 24 kHz input/output profile, 960-byte microphone packets, setup retry after local authentication, fresh attestation, selected-image capture and action receipts. The visible status must confirm backend image receipt, name the active-image-only scope, turn off after Stop, and clear the working indicator after End. Omitting `--openai` preserves Gemini's 16 kHz/640-byte input assertions. Both runs use guarded synthetic providers and fake microphones without cloud calls.
- Add `--credentials` to the synthetic actual-sidebar smoke to save/replace/remove synthetic Gemini/OpenAI keys through visible settings, prove masked inputs are stable across status refresh and cleared on submit/close, and verify replacement ends an active conversation and clears attestation. Removal must disclose and restore app-environment fallback. It uses only the isolated smoke database/vault and the guarded fake provider, never real keys or cloud calls. The adapter acceptance also interleaves a report draft and an actual Length annotation to verify combined undo/redo ordering.
- `node desktop/scripts/openai-acceptance.mjs` is an explicit real-provider acceptance run using the normal `backend.server:app` and backend-only `.env.ai`. It imports generated synthetic fixtures into an isolated database/profile, opens the governed viewer, selects OpenAI, attests synthetic data, shares only that active viewport, requests an observed zoom change, and reviews an exact synthetic `report_save` proposal through its visible approval button. The harness verifies the saved draft in the backend workspace and counts transient 24 kHz output without storing raw media. It retains its synthetic database and approval/final screenshots for review; no microphone is activated. This opt-in command sends real API requests and is separate from the synthetic smoke suite.
- `node desktop/scripts/ui-import-smoke.mjs --local-start --audio-playback` tests the exact compiled `LiveAudio` module in a real Electron AudioContext with silent synthetic PCM. It delivers 20 seconds in under one second and verifies natural playback duration, interrupts a 45-second burst after about two audible seconds, and verifies that single or cumulative input exceeding the 60-second bound is rejected before allocating another AudioBuffer. Every queued source must stop, and playback receipts must count audible time rather than queued duration. This forces the guarded fake backend and never starts a microphone or calls a cloud provider; it is separate from physical speaker acceptance. Combine with `--ai-live --openai` to retain the existing actual-sidebar and OHIF adapter regression checks in the same isolated run.
- Run desktop UI smoke commands sequentially unless their ports are explicitly overridden; by default they share fixed high ports for Electron, the bridge, Next.js, and FastAPI.

## Work Guidance

- Prefer Node built-ins for process supervision and local proxying unless a dependency removes meaningful complexity.
- Keep startup errors actionable for non-specialist local users.
- Use repo-local `.venv` and workspace-managed npm dependencies.
- Preserve Linux-native commands in docs and scripts.

## Verification

- `npm run test:live --workspace @radsysx/desktop`
- `npm run smoke:ai-live --workspace @radsysx/desktop`
- `npm run desktop:doctor`
- `npm run desktop:smoke`
- `npm run desktop:smoke:launch`
- `npm run desktop:smoke:import`
- `npm run desktop:smoke:local-start`
- `npm run desktop:smoke:local-start-drop`
- `npm run desktop:smoke:local-start-nondicom`
- `npm run desktop:smoke:picker-files-import`
- `npm run desktop:smoke:picker-large-import`
- `npm run desktop:smoke:picker-many-import`
- `npm run desktop:smoke:picker-import`
- `npm run desktop:smoke:ui-import`
- `npm run desktop:smoke:viewer-launch`
- `node --check desktop/scripts/bootstrap.mjs`
- `node --check desktop/src/main.mjs`
- `node --check desktop/scripts/dev-frontend.mjs`
- `node --check desktop/scripts/doctor.mjs`
- `node --check desktop/scripts/import-smoke.mjs`
- `node --check desktop/scripts/launch.mjs`
- `node --check desktop/scripts/startup-smoke.mjs`
- `node --check desktop/scripts/ui-import-smoke.mjs`
- `npm run build --workspace frontend`

## Child DOX Index

## Security build freshness

- Require Node.js 24+ to match the OHIF source build.
- Compare the generated viewer receipt against `ohifBuildFingerprint()` before reusing the viewer, including changes to the source patch and either dependency lockfile.

- Software-canvas rendering probes must sample the entire DICOM image, not only a corner that can contain letterboxing or a valid black pixel. Preserve the nonblank-image assertion.

- The actual-sidebar smoke checks the compact `[data-role="session-controls"]` toolbar, hidden before connection, instead of the retired large microphone card. Layout checks compare the visible setup/session/status blocks against conversation/composer bounds; synthetic media, attestation and capture assertions remain unchanged.

- `node desktop/scripts/evidence-review-smoke.mjs` runs the production viewer/router/service through the guarded synthetic Electron harness (`--local-start --ai-live --openai --evidence-review`). Its wrapper allowlists host environment settings and substitutes synthetic credentials; backend evidence/key directories and database are disposable. Verify preview without inference, exact exclusion/confirmation, keyboard/focus, saved receipts, independent voice lifecycle, cancellation/unknown usage, history/deletion and full NVIDIA dropdown. This is synthetic app acceptance; the separate Python utility provides one real TypeSafe receipt. TypeSafe/NVIDIA keys must also be stripped from every non-backend child environment.

- The evidence-review smoke preserves strict pre-submission consent/focus checks. If OHIF remounts the dock after submission, reacquire the current panel and open the same saved review via its visible GET-only action; never infer failure or success from a detached element, relax request-count assertions, or silently resubmit.
