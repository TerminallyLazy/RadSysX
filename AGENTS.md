# RadSysX Agent Guidance

Last updated: 2026-08-08

## Purpose

- This file is the root DOX rail for RadSysX: project-wide instructions, global preferences, durable workflow rules, and the top-level Child DOX Index.
- RadSysX has two parallel product surfaces:
  - `research`: rapid experimentation, legacy viewer flows, browser-side AI prototypes, and agent/MCP exploration.
  - `clinical`: governed FastAPI contracts, worklist-driven launch, opaque viewer sessions, OHIF reading, audited reporting, AI workflow state, and backend-mediated derived DICOM writeback.
- RadSysX now also has a `desktop` runtime path: an Electron fast path that starts the local backend, Next.js shell, and OHIF viewer bridge under one localhost origin without Docker; by default it opens directly into OHIF's native local DICOM route at `/viewer/local`, keeps the visible app name as RadSysX, and exposes a voice-first RadSysX AI sidebar that binds to backend session/message stub contracts when authenticated while preserving local fallback.
- The OHIF app also exposes `/viewer/fhir-viewer` for FHIR R4 imaging discovery through SMART on FHIR. That route has its own SMART authorization context and is not a shortcut around the governed RadSysX launch/report/writeback contracts.
- Do not treat the research and clinical surfaces as equivalent.

## Ownership

- Root owns project-wide posture, root manifests, root docs, root Docker Compose, top-level scripts, logo/assets, and cross-domain workflow guidance.
- Child `AGENTS.md` files own domain-specific instructions for their subtrees. When a path has a child doc, read the full chain from this file to the nearest child before editing.
- Root-owned files and folders include `README.md`, `CLAUDE.md`, `WARP.md`, `DEPLOY_GPU.md`, `DEPLOY_LOCAL.md`, `PHASE4_CLINICAL_EXECUTION_CHECKLIST.md`, `package.json`, `package-lock.json`, `docker-compose.yml`, `.gitignore`, `dev.sh`, `RadSysX-Logo.png`, `RadSysX-Logo-Light.png`, `test-biomedparse.py`, `test-files-inventory.txt`, `.claude/`, `.cursor/`, `.handoffs/`, `roadmap/`, and `.serena/`.

## DOX Core Contract

- `AGENTS.md` files are binding work contracts for their subtrees.
- Work products, source materials, instructions, records, assets, and durable docs must stay understandable from the nearest applicable `AGENTS.md` plus every parent `AGENTS.md` above it.
- Before editing, re-read this file, identify every path you expect to touch, walk from the repository root to each target path, and read every `AGENTS.md` found along each route.
- If a parent `AGENTS.md` lists a child whose scope contains the path, read that child and continue from there.
- The closer doc controls local work details when instructions conflict, but no child doc may weaken this DOX contract or project-wide safety rules.
- After every meaningful change, do a DOX pass: update the closest owning `AGENTS.md` when purpose, scope, ownership, durable structure, contracts, workflows, inputs, outputs, permissions, constraints, side effects, artifacts, or durable user preferences change.
- Update parent docs when parent-level structure, ownership, workflow, or a Child DOX Index changes. Update children when parent changes alter local rules. Remove stale or contradictory text immediately.
- Small edits that do not change behavior or contracts may leave docs unchanged, but the DOX pass still must happen and closeout should state why docs were unchanged.

## Host Environment Posture

- The primary development and validation target is native Ubuntu/Linux.
- Do not assume WSL, Windows path translation, Docker Desktop integration, `fnm`, or Windows-only shell behavior.
- Prefer Linux paths and commands. Use `./.venv/bin/python` style paths, not Windows virtualenv paths.
- Prefer a repo-local Python virtual environment in `.venv` and the workspace `package.json` plus root `package-lock.json` for Node dependencies.
- Treat Docker Engine plus Compose on Linux as the reference container runtime.
- Do not rely on machine-specific temporary dependency paths, ad hoc `PYTHONPATH` overrides, or globally preinstalled packages that are not documented.
- On a fresh Linux host, first do quick repo/context recon, then stop and wait for the user's report about the first Linux app test pass before deeper code changes.

## Bootstrap

- Clinical-first local bootstrap:
  - `python3 -m venv .venv`
  - `. .venv/bin/activate`
  - `python3 -m pip install --upgrade pip`
  - `python3 -m pip install -r backend/requirements-clinical.txt`
  - `npm install --legacy-peer-deps`
- Desktop fast-path bootstrap:
  - `npm run desktop`
  - This checks the desktop bootstrap, runs the cross-platform bootstrap helper if setup is incomplete, then opens Electron directly to OHIF local mode at `/viewer/local`.
  - Use `npm run desktop:bootstrap -- --check` for a non-mutating setup preflight, and `npm run desktop:run` only when intentionally bypassing the launcher after setup.
- `backend/requirements.txt` is the broader research/agent dependency set. Use it only when intentionally working on the research surface and its extra dependencies.
- Use Python `3.12` if one interpreter must install both clinical and broader research dependency sets.
- If the host is missing a required system dependency, surface that explicitly instead of patching around it with host-local hacks.

## Project Operating Rules

1. Update docs in the same tranche as code when behavior, architecture, env vars, commands, or operational expectations change.
2. Treat `AGENTS.md` as authoritative and keep `README.md`, `CLAUDE.md`, `WARP.md`, and active checklists aligned instead of letting them drift.
3. Keep the research and clinical surfaces explicitly separated; do not solve a clinical gap by routing through a research-only shortcut.
4. Prefer backend-authoritative contracts over browser-local state or inferred client behavior whenever clinical workflow, actor identity, reporting, AI, DICOM, or audit data is involved.
5. Keep the viewer bootstrap minimal; if behavior can live in an OHIF extension, mode, service, or backend contract, move it there.
6. Never normalize insecure local habits into maintained guidance: no committed live credentials, no PHI-bearing URLs, no casual identifier logging, and no dependence on machine-local temp paths.
7. Make environment setup reproducible from the repo itself: `.venv`, declared Python requirements, workspace-managed npm installs, and env-driven secrets.
8. When review comments expose a real defect or ambiguity, fix the code and capture the durable lesson in guidance or checklists if it is likely to recur.
9. After substantial changes, record what was actually verified and what was not; do not imply Docker, viewer, or end-to-end validation if it did not happen.
10. On new machines or major environment transitions, do initial recon first, then anchor next decisions to observed runtime behavior from the first user-reported test pass.

## Runtime Modes

- Mode is controlled by `RADSYSX_APP_MODE`.
- Valid modes are `research`, `pilot`, and `clinical`.
- Only `research` may expose experimental upload/analyze flows.
- `pilot` and `clinical` must use the clinical FastAPI surface and worklist/viewer flow.
- Do not send DICOM bytes directly from the browser to third-party AI services in `pilot` or `clinical`.
- The Electron desktop fast path defaults to `pilot` with local development secrets and seeded local auth; override via env only when intentionally validating another mode.

## Clinical Workflow Contract

1. Establish a clinical session via `POST /api/auth/local-login` and confirm it with `GET /api/auth/session`.
2. Open `/worklist` in the Next.js shell.
3. Create an opaque launch session via `POST /api/imaging/launch`.
4. Resolve that session in `/viewer/?launch=...` via `GET /api/imaging/launch/resolve`.
5. Let the dedicated OHIF viewer app bind to returned `viewerRuntime` and same-origin DICOMweb roots.
6. Load study workspace state via `GET /api/studies/{studyUid}/workspace`.
7. Persist reports, AI jobs, derived results, and audit events through backend contracts, including backend-mediated STOW via `POST /api/derived-results/stow`.

## Clinical Runtime Paths

- Backend authority:
  - `backend/server.py`
  - `backend/clinical/auth.py`
  - `backend/clinical/config.py`
  - `backend/clinical/contracts.py`
  - `backend/clinical/dicomweb.py`
  - `backend/clinical/local_imaging.py`
  - `backend/clinical/models.py`
  - `backend/clinical/repositories.py`
  - `backend/clinical/seed_orthanc.py`
  - `backend/clinical/services.py`
- Clinical frontend shell:
  - `frontend/app/login/page.tsx`
  - `frontend/app/worklist/page.tsx`
  - `frontend/lib/clinical/client.ts`
  - `frontend/lib/clinical/contracts.ts`
  - `frontend/lib/env.ts`
- Shared browser package:
  - `packages/clinical-web/src/client.ts`
  - `packages/clinical-web/src/contracts.ts`
  - `packages/clinical-web/src/env.ts`
- OHIF viewer runtime:
  - `viewer/scripts/build-ohif-dist.mjs`
  - `viewer/assets/radsysx-bootstrap.js`
  - `viewer/assets/radsysx-fhir-extension.js`
  - `viewer/assets/radsysx-ohif-extension.js`
  - `viewer/assets/radsysx-ohif-mode.js`
  - `viewer/assets/radsysx-viewer.css`
  - `viewer/vendor/ohif-fhir-viewer/*`
- Desktop fast path:
  - `desktop/package.json`
  - `desktop/src/main.mjs`
  - `desktop/src/preload.cjs`
  - `desktop/scripts/bootstrap.mjs`
  - `desktop/scripts/doctor.mjs`
- Local clinical stack:
  - `docker-compose.yml`
  - `deploy/clinical-stack/nginx.conf`
  - `deploy/clinical-stack/orthanc.json`

## Research Surface Contract

- Research-only routes and components remain valid for experimentation, but are not authoritative clinical paths:
  - `frontend/app/page.tsx`
  - `frontend/components/core/CoreViewer.tsx`
  - `frontend/components/DicomViewer.tsx`
  - `frontend/app/api/analyze/route.ts`
  - `frontend/app/api/upload/route.ts`
  - `frontend/components/toolbars/RightPanel.tsx`
  - `backend/radsysx.py`
  - `backend/chat_interface.py`
  - `backend/biomedparse_demo.py`
  - `backend/biomedparse_demo_worker.py`
  - `backend/mcp/*`
  - `backend/biomedparse_api.py`
- Research-only routes must stay gated outside `pilot` and `clinical` modes.

## Security And PHI Rules

- Do not put PHI-bearing launch context directly into viewer URLs.
- SMART launches may use the standard opaque `iss`, `launch`, `client_id`, `code`, and `state` parameters on `/viewer/fhir-viewer`; do not add patient identifiers, FHIR payloads, or access tokens to that URL.
- Use opaque launch tokens, then resolve server-side.
- Do not write uploads into public static paths for clinical workflows.
- Do not log patient names, identifiers, DICOM tags, or FHIR payloads casually.
- Keep AI execution server-side for governed workflows.
- Treat `frontend/app/api/analyze` and `frontend/app/api/upload` as research-only.
- Do not reintroduce browser-supplied `role`, `user_id`, `requestedBy`, or other actor identity inputs into governed clinical APIs.
- Treat backend-issued signed session cookies as the source of clinical actor context until a real OIDC provider replaces the local issuer.
- Keep DICOM SR and DICOM SEG writeback mediated by the backend rather than letting the browser store directly to Orthanc.

## Working Conventions

- Backend: use async endpoints for I/O boundaries; keep orchestration in services, persistence in repositories, and request/response definitions in contracts.
- Frontend: use TypeScript strict-mode patterns already present in the repo; keep viewer and worklist pages study-centric, not file-centric.
- Clinical frontend code should import the client from `@/lib/clinical/client`, which re-exports the shared `@radsysx/clinical-web` package.
- Do not treat `frontend/lib/api.ts` as the primary clinical API client; it remains a legacy convenience surface.
- The clinical public `/viewer` route is owned exclusively by the dedicated OHIF app in `viewer/`. There is no supported Next.js `/viewer` fallback route.
- Cornerstone remains the rendering and tooling substrate inside OHIF.
- For Agent Zero plugin/backend code outside this repo, treat the Docker container at `localhost:32080` as the live runtime code and always copy live runtime changes into `/home/eclypso/a0/agent-zero/plugins`.

## Verification

- Preferred focused checks for the clinical slice:
  - `python3 -m pytest backend/tests/test_clinical_platform.py`
  - `python3 -m compileall backend/clinical backend/server.py backend/radsysx.py`
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
  - `npm run type-check --workspace frontend`
  - `npm run build --workspace frontend`
  - `npm run type-check --workspace viewer`
  - `npm run build --workspace viewer`
  - `npm run test:fhir-bridge --workspace viewer`
- Use broader suites only when the change demands it.
- Install missing Python dependencies into `.venv`; do not normalize one-off temp-path dependency shims as part of expected workflow.
- If Docker Engine and Compose are available on the Linux host, validate the composed stack with Orthanc and nginx for clinical end-to-end work.

## Commands

- Backend dev server: `. .venv/bin/activate && python3 backend/server.py`
- Desktop bootstrap: `npm run desktop:bootstrap`
- Desktop bootstrap check: `npm run desktop:bootstrap -- --check`
- Desktop launcher check: `npm run desktop -- --check-only`
- Desktop preflight: `npm run desktop:doctor`
- Desktop app: `npm run desktop`
- Desktop direct run after setup: `npm run desktop:run`
- Desktop app with live Next.js dev frontend: `npm run desktop:dev-frontend`
- Desktop startup smoke test: `npm run desktop:smoke`
- Desktop user-facing launcher smoke test: `npm run desktop:smoke:launch`
- Desktop local import smoke test: `npm run desktop:smoke:import`
- Desktop OHIF local DICOM input/render smoke test: `npm run desktop:smoke:local-start`
- Desktop OHIF local DICOM drag/drop render smoke test: `npm run desktop:smoke:local-start-drop`
- Desktop OHIF-first non-DICOM inspection smoke test: `npm run desktop:smoke:local-start-nondicom`
- Desktop native file picker bridge import smoke test: `npm run desktop:smoke:picker-files-import`
- Desktop large native picker import smoke test: `npm run desktop:smoke:picker-large-import`
- Desktop many-file native picker import smoke test: `npm run desktop:smoke:picker-many-import`
- Desktop native picker bridge import smoke test: `npm run desktop:smoke:picker-import`
- Desktop hydrated UI local import smoke test: `npm run desktop:smoke:ui-import`
- Desktop imported-DICOM viewer launch smoke test: `npm run desktop:smoke:viewer-launch`
- Clinical backend tests: `. .venv/bin/activate && python3 -m pytest backend/tests/test_clinical_platform.py`
- Whole backend runtime: `. .venv/bin/activate && RADSYSX_APP_MODE=research python3 backend/server.py`
- Frontend dev server: `npm run dev --workspace frontend`
- Viewer dev server: `npm run dev --workspace viewer`
- Frontend type check: `npm run type-check --workspace frontend`
- Frontend build: `npm run build --workspace frontend`
- Viewer type check: `npm run type-check --workspace viewer`
- Viewer build: `npm run build --workspace viewer`
- Viewer FHIR bridge check: `npm run test:fhir-bridge --workspace viewer`
- Root type check: `npm run type-check`

## Local Clinical Stack

- Fast local desktop path:
  - Run `npm run desktop` from the repo root.
  - The user-facing desktop launcher first runs the non-mutating bootstrap check, runs `npm run desktop:bootstrap` if setup is incomplete, then opens the Electron app.
  - `npm run desktop:bootstrap` remains the explicit cross-platform Node helper that creates/uses `.venv`, installs clinical Python requirements, runs workspace `npm install --legacy-peer-deps`, and then runs desktop doctor; use `npm run desktop:bootstrap -- --check` or `npm run desktop -- --check-only` to verify an existing bootstrap without reinstalling dependencies.
  - Use `npm run desktop:run` only for a lower-level direct Electron run after setup is known good.
  - Electron exposes one local origin, usually `http://127.0.0.1:3000`, and internally supervises FastAPI, a stamped production Next.js standalone shell, and the generated OHIF viewer bridge.
  - Desktop runtime, doctor, bootstrap, and smoke helpers resolve the repo-local venv Python using platform-specific paths (`.venv/bin/python` on Unix-like hosts, `.venv/Scripts/python.exe` on Windows) and may be overridden with `RADSYSX_DESKTOP_PYTHON` or `PYTHON`.
  - Electron opens `/viewer/local` by default so OHIF's native local DICOM loader is the first visible screen. The viewer bootstrap no longer requires a governed launch for local OHIF routes, suppresses the clinical workspace panel in standalone local mode, rewrites local DICOM navigation to `/viewer/dicomlocal`, and keeps the window/document title as `RadSysX`; use `RADSYSX_DESKTOP_START_PATH` only when intentionally validating a different first route.
  - Standalone and governed OHIF viewer layouts include a voice-first RadSysX AI right-sidebar panel. It creates an authenticated backend AI sidebar session when possible, sends voice/composer turns through `/api/ai/sidebar/*` stub contracts, keeps a local fallback when the backend session is unavailable, and lets users attach ROI/segmentation/measurement context chips through `@`. These endpoints are orchestration stubs only: no diagnostic model inference, no report persistence, and no DICOM SEG writeback occur through them yet.
  - `/viewer/fhir-viewer` activates the pinned FHIR R4 data source and supports SMART EHR launch with PKCE. The browser calls the configured FHIR origin directly, so that server must allow the RadSysX origin through CORS. Set the public SMART client with `RADSYSX_FHIR_CLIENT_ID` before building the viewer or pass `client_id` on the launch URL; optional build settings are `RADSYSX_FHIR_SERVER_URL` and `RADSYSX_FHIR_SCOPE`.
  - The desktop launcher builds or refreshes the frontend production shell when the expected desktop build stamp is missing or mismatched; the default public frontend API/viewer settings are same-origin so the build is not tied to a specific localhost port. Use `npm run desktop:dev-frontend` or `RADSYSX_DESKTOP_FRONTEND_MODE=development npm run desktop` only when intentionally doing live Next.js UI development.
  - This path validates local login, native local file/folder selection, local imaging import, imported-study asset summaries/previews/technical analysis, worklist, launch, workspace, report, AI job, and audit contracts without Docker.
  - Run `npm run desktop:smoke:launch` to prove the same user-facing launcher checks setup and reaches service-ready Electron startup through a cross-platform smoke shutdown; `npm run desktop:smoke:local-start` remains the first-screen OHIF local-mode assertion.
  - Run `npm run desktop:smoke:import` to start the desktop runtime, import synthetic DICOMDIR/DICOM/NIFTI `.nii`/`.nii.gz`/paired `.hdr+.img`, NRRD `.nrrd`, ZIP archives containing supported files, plus PNG/JPEG/TIFF files, verify worklist/asset-summary/preview/analysis/DICOMweb/launch behavior, and cleanly shut down.
  - Run `npm run desktop:smoke:local-start` to start Electron at `/viewer/local`, verify there is no RadSysX bootstrap card or governed launch, verify the title is `RadSysX`, load a synthetic DICOM through OHIF's local file input, route to `/viewer/dicomlocal`, verify a nonblank OHIF canvas, and assert the RadSysX AI right-sidebar composer with voice and `@` ROI/segmentation controls.
  - Run `npm run desktop:smoke:local-start-drop` to start Electron at `/viewer/local`, drop a synthetic DICOM directly onto the OHIF local screen, route to `/viewer/dicomlocal`, and verify the same `RadSysX` title, nonblank OHIF canvas, and RadSysX AI composer without a governed launch.
  - Run `npm run desktop:smoke:local-start-nondicom` to start Electron at `/viewer/local`, then validate NIFTI/NRRD/image/ZIP inspection through `/worklist`, local asset previews, NIFTI axis switching, and backend technical analysis.
  - Run `npm run desktop:smoke:ui-import` to drive the hydrated Electron worklist UI, dispatch a local imaging drag/drop import, inspect imported studies, verify NIFTI previews including a coronal slice, run backend technical analysis, and cleanly shut down.
  - Run `npm run desktop:smoke:viewer-launch` to drive the hydrated Electron worklist UI through local DICOM import, `Open viewer`, opaque launch resolution, launch-token stripping, same-origin local DICOMweb binding, viewer-origin workspace retrieval, and imported-study DICOMweb discovery.
  - Run `npm run desktop:smoke:picker-files-import` to drive the hydrated Electron worklist UI through the native file picker bridge using smoke-injected individual file paths, proving the `Import files` button, preload IPC, direct main-process upload to backend import, inspection, NIFTI preview controls, and analysis path without automating the OS dialog itself.
  - Run `npm run desktop:smoke:picker-import` to drive the hydrated Electron worklist UI through the native picker bridge using smoke-injected test paths, proving the renderer button, preload IPC, main-process recursive collector, direct main-process upload to backend import, inspection, NIFTI preview controls, and analysis path without automating the OS dialog itself.
  - Run `npm run desktop:smoke:picker-large-import` to repeat the native picker bridge path with an additional 8 MiB synthetic NIFTI volume, proving direct main-process upload and backend preview/analysis behavior beyond the tiny focused fixtures.
  - Run `npm run desktop:smoke:picker-many-import` to repeat the native picker bridge path with 32 additional nested extensionless DICOM instances, proving recursive folder traversal and many-file upload behavior.
  - Local imaging import is controlled by `RADSYSX_LOCAL_IMAGING_ENABLED`; the Electron desktop runtime enables it by default for the fast path.
  - Full Orthanc-backed DICOMweb retrieval and durable STOW validation still require the compose stack or an explicitly configured local DICOMweb target.
- Before starting compose:
  - `export RADSYSX_ORTHANC_USERNAME=local-user`
  - `export RADSYSX_ORTHANC_PASSWORD=local-pass`
- Start stack: `docker compose up --build`
- This stack validates the governed clinical surface only; it is not the full research plus clinical runtime.
- Clinical public origin: `http://localhost:3000`
- Do not validate the governed viewer flow by opening the raw viewer dev server on port `3001`; use the nginx-served `http://localhost:3000` origin instead.
- Next.js shell: `/`
- OHIF viewer: `/viewer/`
- FastAPI: `/api`
- Orthanc DICOMweb: `/dicom-web`

## Avoid These Wrong Assumptions

- `frontend/app/page.tsx` is not the main product entry point for clinical work.
- `frontend/lib/api.ts` is not the authoritative clinical API client.
- `frontend/app/api/analyze/route.ts` and `frontend/app/api/upload/route.ts` are not normal production paths.
- `frontend/components/core/CoreViewer.tsx` is not the long-term clinical viewer shell.
- Prisma is not the backend clinical runtime datastore.
- Viewer launch should not trust raw query parameters like `study=...&patient=...`.
- The Electron fast path is not a reason to reintroduce a Next.js `/viewer` fallback or browser-local clinical state.

## User Preferences

- Favor rigorous, beautiful, professional solutions with high signal-to-noise.
- Prefer Linux-native commands and paths.
- Record durable behavior changes in this file or the nearest relevant child `AGENTS.md`.

## Child DOX Index

- `backend/AGENTS.md`: FastAPI backend, clinical/research backend split, Python dependencies, backend tests, MCP, skills, tools, and model utilities.
- `deploy/AGENTS.md`: deploy/runtime configuration, especially the clinical nginx and Orthanc stack.
- `desktop/AGENTS.md`: Electron desktop fast path, local process supervision, one-origin bridge, and desktop preflight/smoke checks.
- `dicom-test-files/AGENTS.md`: local DICOM fixtures and non-production imaging test assets.
- `frontend/AGENTS.md`: Next.js shell, clinical login/worklist pages, research UI, frontend libraries, and styling.
- `ideas-inspo/AGENTS.md`: source inspiration documents and exploratory materials.
- `packages/AGENTS.md`: workspace packages shared across app surfaces.
- `roadmap/AGENTS.md`: durable future planning docs, AI backend roadmaps, GPU evaluation runbooks, and compaction-resistant todo ledgers.
- `related-papers/AGENTS.md`: research papers and media used as source material.
- `tests/AGENTS.md`: root-level legacy/test harness scripts outside `backend/tests`.
- `viewer/AGENTS.md`: dedicated OHIF clinical viewer app, build wrapper, runtime assets, and generated viewer distribution.
