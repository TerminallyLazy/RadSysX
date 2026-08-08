# RadSysX Local Imaging Fast Path Ledger

Date: 2026-06-12
Branch: `easy`
Anchor commit for completed desktop fast path: `9ad93e4 Add Electron desktop fast path`

## Objective To Preserve

Make RadSysX a local runnable, cross-platform app that lets anyone upload and use suitable local medical image files, including DICOM, DICOMDIR, NIFTI, and other medical imaging files, without requiring the full Docker/nginx/Orthanc clinical orchestration for the fast path.

This is not merely an upload button. The desired end state is a local app that can ingest local imaging studies, build a usable study/series workspace, display or hand off images to the viewer, and support analysis workflows while preserving the clinical/research separation and avoiding unsafe shortcuts.

The human-facing local entry point should be one command or one packaged-app open: start RadSysX and land directly in OHIF local mode, with no RadSysX bootstrap card, governed-session ceremony, or product-surface choice before the viewer. Setup checks and repair may happen underneath, but the user should not have to understand Docker composition, clinical/research split decisions, or a sequence of validation commands before seeing OHIF.

## Existing Completed Foundation

- Electron desktop workspace exists in `desktop/`.
- Root scripts exist:
  - `npm run desktop`
  - `npm run desktop:launch`
  - `npm run desktop:bootstrap`
  - `npm run desktop:doctor`
  - `npm run desktop:run`
  - `npm run desktop:smoke`
  - `npm run desktop:smoke:launch`
  - `npm run desktop:smoke:import`
  - `npm run desktop:smoke:local-start`
  - `npm run desktop:smoke:local-start-drop`
  - `npm run desktop:smoke:local-start-nondicom`
  - `npm run desktop:smoke:ui-import`
  - `npm run desktop:smoke:picker-files-import`
  - `npm run desktop:smoke:picker-import`
  - `npm run desktop:smoke:picker-large-import`
  - `npm run desktop:smoke:picker-many-import`
  - `npm run desktop:smoke:viewer-launch`
- Desktop runtime starts:
  - FastAPI backend on an internal loopback port.
  - Production Next.js standalone frontend shell on an internal loopback port by default.
  - A local one-origin bridge, usually `http://127.0.0.1:3000`.
  - Generated OHIF viewer assets from `viewer/dist/`.
- The desktop window now opens `/viewer/local` by default instead of the root shell, a worklist, or the prior RadSysX local-start card. The first visible product surface is OHIF's native local DICOM loader.
- `RADSYSX_DESKTOP_START_PATH` exists as an explicit override for focused validation only; normal local use should keep the default OHIF-first route.
- `npm run desktop` is now the user-facing local launcher rather than only a direct developer Electron run. It performs a non-mutating bootstrap check, runs the cross-platform bootstrap helper when setup is incomplete and repair is allowed, then opens the same OHIF-first Electron runtime.
- `npm run desktop -- --check-only` verifies the launcher bootstrap state without reinstalling dependencies or opening Electron.
- `npm run desktop:run` preserves the lower-level direct Electron run for intentional developer bypasses after setup is known good.
- `npm run desktop:smoke:launch` proves the user-facing launcher path with bootstrap check plus service-ready Electron startup under a short cross-platform smoke shutdown timer; `npm run desktop:smoke:local-start` remains the first-screen OHIF local-mode assertion.
- `npm run desktop:bootstrap` is now a Node-based cross-platform helper that creates or reuses `.venv`, installs clinical Python requirements with the venv Python, runs workspace `npm install --legacy-peer-deps`, and then runs desktop doctor; `npm run desktop:bootstrap -- --check` verifies an existing install without reinstalling dependencies.
- The desktop launcher builds and stamps the frontend production shell with same-origin public API/viewer defaults, then serves it with the generated standalone server; it no longer ties the default production frontend build stamp to one absolute localhost port. `RADSYSX_DESKTOP_FRONTEND_MODE=development` remains available for intentional live Next.js UI development.
- Desktop runtime defaults to local `pilot` mode with local seeded auth and development secrets.
- The current desktop fast path can validate seeded login, worklist, launch/session resolution, workspace/report/AI/audit contracts.
- Desktop runtime, bootstrap, doctor, API smoke, and UI smoke now resolve Python through `RADSYSX_DESKTOP_PYTHON`, then `PYTHON`, then the platform-correct repo-local venv executable (`.venv/bin/python` on Unix-like hosts or `.venv/Scripts/python.exe` on Windows), and only then a platform default.
- The OHIF bootstrap now has a standalone local no-launch exception: `/viewer/local` and `/viewer/dicomlocal` render without `POST /api/imaging/launch`, without `/api/imaging/launch/resolve`, and without the RadSysX clinical workspace panel.
- The viewer build registers OHIF's default `dicomlocal` data source alongside the governed RadSysX DICOMweb data source. Local DICOM files loaded from the first screen route to `/viewer/dicomlocal?datasources=dicomlocal` and render inside OHIF directly.
- The desktop runtime now treats `viewer/dist/` as stale when viewer runtime assets or `viewer/scripts/build-ohif-dist.mjs` are newer than the generated outputs. This prevents an ignored old OHIF distribution from silently showing obsolete governed-launch or local-start behavior.
- Legacy `/viewer/?local=1` is now compatibility input only; in desktop/local mode it should redirect into `/viewer/local`, not show the old RadSysX local-start card.
- Standalone local drag/drop is bridged to OHIF's native local file input so a no-click drop stays in the OHIF `dicomlocal` path rather than creating a governed launch.
- Non-DICOM assets such as NIFTI/NRRD/images/ZIP remain available through the backend/worklist local asset inspection and analysis path until OHIF-native rendering for those formats is implemented.
- The Electron desktop path now exposes a native local imaging file/folder picker through a narrow preload bridge, while retaining browser file input and drag-and-drop fallbacks.
- The preferred Electron native import path now keeps selected paths and file bytes in Electron main, uses file-backed blobs for multipart form data, attaches the backend-issued session cookie from the Electron cookie jar, and posts directly to `POST /api/local-imaging/import` through the one-origin desktop bridge; the renderer receives only the backend response.
- The native picker admits extensionless non-hidden files as DICOM candidates so DICOMDIR companion files such as `SCAN1DCM` can reach backend format detection instead of being filtered out in Electron.
- The native picker also admits paired NIFTI `.hdr/.img` files so Electron main does not filter out the voxel-data companion before the backend can link it to the matching header.
- The native picker also admits NRRD `.nrrd` files and `.zip` archives; archive expansion is backend-owned, bounded by the existing local import file-count/file-size limits after expansion, and detected members flow through the same DICOM/DICOMDIR/NIFTI/NRRD/image import logic as ordinary selected files.
- Backend DICOMDIR import now resolves directory-record `ReferencedFileID` values against included files, including paths relative to the DICOMDIR parent, and associates one DICOMDIR index with each referenced local study when imported media contains multiple studies.
- The desktop import smoke can validate no-Docker import/use of synthetic DICOMDIR, DICOM, `.nii`, `.nii.gz`, paired `.hdr/.img`, `.nrrd`, ZIP archives containing supported files, PNG, JPEG, and TIFF files through the one-origin local bridge.
- The desktop UI import smoke can validate a hydrated worklist UI drag/drop import path, local study inspection, NIFTI slice controls, and backend technical analysis through the Electron bridge.
- The desktop picker import smoke can validate the hydrated worklist `Import folder` action through the Electron preload IPC/native picker bridge, main-process recursive folder collector, backend import, local study inspection, NIFTI slice controls, and backend technical analysis without automating the OS dialog itself.
- The desktop large picker import smoke can validate the same direct native import path with an additional 8 MiB synthetic `256 x 256 x 128` NIFTI volume, proving the bridge/backend path beyond tiny fixtures.
- The desktop many-file picker import smoke can validate the same direct native import path with a nested folder of 32 additional extensionless DICOM instances, proving recursive folder traversal and many-file upload behavior beyond tiny focused fixtures.
- The desktop viewer-launch smoke can validate hydrated local DICOM/DICOMDIR import, `Open viewer`, opaque launch resolution under `/viewer/`, launch-token stripping, same-origin local DICOMweb runtime binding, viewer-origin workspace retrieval, viewer-origin imported-study DICOMweb discovery, and a nonblank OHIF canvas render for the synthetic imported DICOM.
- The desktop local-start smoke can validate the current desired first experience: Electron starts on `/viewer/local`, no RadSysX bootstrap card is present, no governed launch context exists, OHIF's local file/folder controls are visible, a synthetic DICOM loads through OHIF's local file input, `/viewer/dicomlocal` renders it, the clinical workspace panel is suppressed, and the synthetic DICOM paints a nonblank canvas.
- The desktop local-start drag/drop smoke can validate the same first experience with no button click: Electron starts on `/viewer/local`, a synthetic DICOM is dropped directly onto the OHIF local screen, the drop forwards into OHIF's local file input, `/viewer/dicomlocal` renders it, no governed launch exists, and the synthetic DICOM paints a nonblank canvas.
- The desktop local-start non-DICOM smoke can validate that Electron still starts on `/viewer/local` and that NIFTI/NRRD/image/ZIP-only assets remain usable through `/worklist`, the local asset inspection panel, previews, NIFTI axis changes, backend technical analysis, and no exposed OHIF viewer action for the non-DICOM row.
- Electron-supervised uvicorn now runs with access logging disabled so local DICOMweb query strings that may contain identifiers are not casually printed during desktop fast-path use or smoke tests.
- Full Orthanc-backed DICOMweb retrieval and durable STOW validation still require compose unless a local DICOMweb target is configured.

## Non-Negotiable Project Constraints

- Keep clinical and research surfaces explicitly separated.
- Do not reintroduce a Next.js `/viewer` clinical fallback.
- Do not encode PHI-bearing launch context directly in URLs.
- Do not let browser-supplied actor identity become authoritative in clinical APIs.
- Do not send DICOM bytes directly from browser to third-party AI services in `pilot` or `clinical`.
- Do not store clinical uploads in public static paths.
- Backend-mediated writeback remains authoritative for governed derived DICOM results.
- Desktop/local mode may be friendly and fast, but it must not weaken governed contracts.
- Use repo-local `.venv`, workspace npm dependencies, and root `package-lock.json`.
- Keep Linux-native commands in docs, while designing code paths to be cross-platform.

## Current Evidence And Known Gaps

- Existing frontend research upload code exists:
  - `frontend/components/ImageSeriesUpload.tsx`
  - `frontend/lib/services/imageUploadService.ts`
  - `frontend/app/api/upload/route.ts`
  - `frontend/app/api/analyze/route.ts`
- These routes are research-only and not a governed local archive ingest path.
- Existing clinical worklist is seeded in SQLite through `backend/clinical/repositories.py`.
- Existing clinical viewer expects DICOMweb roots from backend launch resolution.
- Desktop bridge can serve `/viewer` and proxy `/api`; it has a placeholder route for `/dicom-web`.
- The root `desktop` script now resolves to the launcher, not directly to `npm run dev --workspace @radsysx/desktop`; direct developer startup remains available as `desktop:run`.
- There is now a first backend-owned local file ingest service in `backend/clinical/local_imaging.py`.
- There is now an ignored repo-local storage default at `backend/local-imaging-data/`, enabled by Electron.
- There is now a minimal backend local DICOMweb surface for imported DICOM: study/series/instance metadata, whole-instance multipart retrieval, bulk-data multipart retrieval, and simple frame multipart retrieval.
- There is now a backend-owned imported-study asset summary endpoint at `GET /api/local-imaging/studies/{studyUid}/assets`.
- There is now a backend-owned imported-asset preview endpoint at `GET /api/local-imaging/studies/{studyUid}/assets/{assetId}/preview`.
- There is now a backend-owned imported-study technical analysis endpoint at `GET /api/local-imaging/studies/{studyUid}/analysis`.
- The local asset endpoints read private stored files server-side and return safe technical metadata/previews/analysis, including NIFTI header dimensions/datatype, paired NIFTI `.hdr/.img` manifest linking, NRRD header/raw-or-gzip voxel metrics, ZIP-expanded member manifests, axial/coronal/sagittal NIFTI SVG slice previews, DICOM/image counts, common image previews including PNG/JPEG byte previews and TIFF SVG header previews, NIFTI/NRRD voxel statistics, simple uncompressed DICOM pixel statistics, and common image header dimensions, without exposing stored paths or PHI-bearing DICOM tags.
- There is now a reproducible desktop import smoke at `npm run desktop:smoke:import`; it starts Electron on high local ports, generates PHI-free synthetic imaging files, imports them, verifies worklist rows, asset summaries, local DICOMweb discovery, and opaque viewer launch, then shuts the runtime down.
- There is now a reproducible hydrated desktop UI import smoke at `npm run desktop:smoke:ui-import`; it drives Electron through the local bridge, signs in with a backend-issued cookie, clicks into `/worklist`, dispatches a DOM drag/drop with PHI-free synthetic DICOMDIR/DICOM/NIFTI `.nii`/`.nii.gz`/paired `.hdr+.img`, NRRD `.nrrd`, ZIP with supported NIFTI/PNG members, plus PNG/JPEG/TIFF files, verifies imported rows, inspects local assets, switches a NIFTI preview to a coronal slice, runs backend technical analysis including NRRD metrics, and shuts the runtime down.
- There is now a reproducible hydrated desktop native file-picker bridge smoke at `npm run desktop:smoke:picker-files-import`; it drives Electron through the local bridge, signs in with a backend-issued cookie, clicks into `/worklist`, clicks the real `Import files` button, routes through `window.radsysxDesktop.importLocalImaging`, uses a smoke-only main-process test-path override guarded by `RADSYSX_DESKTOP_ALLOW_TEST_SHUTDOWN=1`, passes individual PHI-free fixture file paths, verifies imported rows, inspects local assets, switches a NIFTI preview to a coronal slice, runs backend technical analysis, and shuts the runtime down.
- There is now a reproducible hydrated desktop native folder-picker bridge smoke at `npm run desktop:smoke:picker-import`; it drives Electron through the local bridge, signs in with a backend-issued cookie, clicks into `/worklist`, clicks the real `Import folder` button, routes through `window.radsysxDesktop.importLocalImaging`, uses a smoke-only main-process test-path override guarded by `RADSYSX_DESKTOP_ALLOW_TEST_SHUTDOWN=1`, recursively collects the PHI-free fixture folder, verifies imported rows, inspects local assets, switches a NIFTI preview to a coronal slice, runs backend technical analysis, and shuts the runtime down.
- Desktop UI smoke commands share default high ports for Electron, the bridge, Next.js, and FastAPI; run them sequentially unless ports are explicitly overridden.
- The hydrated native picker bridge smoke now proves the preferred `window.radsysxDesktop.importLocalImaging` path: selected files stay in Electron main and are uploaded to backend import with the existing session cookie instead of being copied through renderer IPC as ArrayBuffers.
- The large native picker bridge smoke at `npm run desktop:smoke:picker-large-import` adds `large-volume.nii`, an 8 MiB `256 x 256 x 128` uint8 NIFTI; after adding the NRRD fixture its expected import count is 13 accepted files, though this larger variant was not rerun in the NRRD tranche.
- The many-file native picker bridge smoke at `npm run desktop:smoke:picker-many-import` adds a nested `nested-dicom/series-a` folder with 32 extensionless CT instances; after adding the NRRD fixture its expected import count is 44 accepted files, though this many-file variant was not rerun in the NRRD tranche.
- The first picker bridge smoke exposed and fixed an Electron-side DICOMDIR usability defect: extensionless DICOM companion files were filtered out before backend detection. `desktop/src/main.mjs` now treats extensionless non-hidden files as DICOM candidates while backend import remains the final authority.
- There is still a legacy Electron-native file/folder selection bridge at `window.radsysxDesktop.selectLocalImagingFiles`; it reads selected files in the desktop main process, preserves folder-relative paths as `radsysxRelativePath`, and lets the frontend import through the same backend local imaging contract when the preferred direct import helper is unavailable.
- The desktop bridge now sanitizes hop-by-hop proxy headers, disables upstream socket reuse for proxied HTTP requests, and proxies WebSocket upgrades so Next.js dev assets and HMR can hydrate the Electron shell reliably through the one-origin bridge.
- The desktop startup smoke now schedules `RADSYSX_DESKTOP_EXIT_AFTER_READY_MS` shutdown immediately after internal services report ready, before awaiting the final app URL load, so dev-shell navigation cannot strand the smoke process and child services.
- The normal desktop frontend path no longer depends on the Next.js dev server: `frontend/app/login/page.tsx` now builds under Next production rules, Electron builds/stamps the frontend shell for its bridge URL, syncs standalone static assets, and launches `frontend/.next/standalone/frontend/server.js` with Node.
- The desktop live-frontend and startup-smoke commands now use Node launcher scripts rather than POSIX inline environment assignment, preserving the Linux-first docs while keeping these package scripts friendlier to Windows/macOS shells.
- The shared clinical browser env now reads public `NEXT_PUBLIC_*` keys through guarded direct env access so Next.js can inline them consistently and avoid server/client mode hydration mismatch.
- NIFTI display still needs a dedicated full volume-rendering path because OHIF/DICOMweb is DICOM-centric; short-term local analysis readiness is now represented by backend summaries, multi-axis slice previews, and deterministic voxel statistics.
- DICOMDIR referenced-file path resolution now covers included files, parent-relative media layouts, extensionless companions, and multi-study index association; deeper patient/study/series directory-record metadata extraction remains future work.
- Real native OS-dialog behavior and Windows/macOS directory-picker behavior still need explicit testing beyond the smoke-only picker bridge override.
- Diagnostic AI/segmentation remains future work; the current no-Docker analyzer is deliberately technical and deterministic, not a clinical diagnosis engine.

## Concrete Requirements Derived From User Objective

1. The app must be runnable locally through the desktop fast path.
   - Preferred human command: `npm run desktop`.
   - Expected first screen: OHIF local-start, not a landing page or a choice between surfaces.
2. A user must be able to choose or drop local medical image files or folders from the desktop app.
3. The local ingest path must accept at least:
   - Single DICOM files.
   - Multiple DICOM files representing a study/series.
   - DICOMDIR plus referenced DICOM files.
   - NIFTI `.nii`.
   - NIFTI `.nii.gz`.
   - Paired NIFTI/Analyze-style `.hdr` plus `.img`.
   - NRRD `.nrrd`.
   - ZIP archives containing supported DICOM/DICOMDIR/NIFTI/NRRD/common-image files.
   - Reasonable fallback files suitable for medical-image analysis, such as PNG/JPEG/TIFF, if they appear in existing research workflows.
4. The ingest path must produce a usable local study/workspace entry.
5. The worklist or equivalent local launcher must expose uploaded studies.
6. The viewer or analysis surface must be able to use the uploaded content.
7. Local storage must stay outside public static routes and avoid accidental commits.
8. Uploaded PHI-bearing metadata must not be casually logged.
9. Local analysis must not depend on Docker.
10. Docker/Orthanc may remain the deeper validation path, but not the only local run path.
11. Cross-platform behavior must avoid Linux-only assumptions in the Electron/UI code path, while docs may prefer Linux commands.
12. Verification must prove actual upload and use, not just type-check.

## Suggested Architecture Direction

Prefer a backend-owned local imaging ingest service rather than browser-local state.

Likely components:

- `backend/clinical/local_imaging.py` or similar:
  - Stores uploaded files under an ignored local app-data directory.
  - Detects DICOM, DICOMDIR, NIFTI, ZIP archives, and fallback image formats.
  - Extracts minimal safe metadata with `pydicom` for DICOM.
  - Handles DICOMDIR references carefully and cross-platform.
  - Creates local study/series records or an ingest manifest.
- `backend/clinical/contracts.py`:
  - Add request/response contracts for local imaging uploads/imports.
  - Keep response payloads low-PHI; prefer opaque local IDs and study UIDs.
- `backend/clinical/repositories.py`:
  - Add or reuse study records for local imports.
  - Store archive references such as `local://study/<id>` instead of `orthanc://default`.
- `backend/server.py`:
  - Add desktop/local upload endpoints only where mode permits.
  - Require active backend-issued session where appropriate.
- `frontend/app/worklist/page.tsx` or a dedicated local import route:
  - Add a compact local import control visible in desktop/local modes.
  - Use browser file/directory input as a fallback.
  - Use browser drag-and-drop as a portable fallback when it can still submit to the backend import contract.
- `desktop/src/main.mjs` and `desktop/src/preload.cjs`:
  - Expose an Electron file/folder picker through narrow IPC for better cross-platform directory selection.
  - Keep web app fallback input for browser compatibility.
- Viewer/analysis:
  - Short-term: show imported studies in worklist and provide metadata/preview.
  - Current short-term for NIFTI/fallback images: worklist row plus backend-owned asset summary/inspection panel.
  - Medium-term: deepen local DICOMweb/OHIF parity for imported DICOM and add a real NIFTI volume viewer or converter.
  - NIFTI may need a non-OHIF analysis/preview path unless converted or handled by a suitable viewer library.

## Todo Ledger

### Git And Process

- [x] Create branch `easy`.
- [x] Commit completed Electron fast path with title and description.
- [x] Keep subsequent local-imaging changes on `easy`.
- [x] Before final completion, make one or more intentional commits for local imaging work.
- [x] Add a reproducible no-Docker desktop import smoke command.
- [x] Add a reproducible hydrated Electron UI import smoke command.
- [x] Make `npm run desktop` the one-command user-facing launcher that checks setup and opens OHIF first.
- [x] Preserve a lower-level direct Electron run as `npm run desktop:run`.
- [ ] Do not mark the goal complete until upload/use of local files is proven with runtime evidence.

### Discovery

- [x] Read `frontend/app/api/AGENTS.md` before editing existing upload/analyze route handlers.
- [x] Read `backend/clinical/AGENTS.md` before editing clinical contracts/services/repositories.
- [x] Inspect `frontend/components/ImageSeriesUpload.tsx`.
- [x] Inspect `frontend/lib/services/imageUploadService.ts`.
- [x] Inspect `frontend/app/api/upload/route.ts`.
- [x] Inspect `frontend/app/api/analyze/route.ts`.
- [ ] Inspect `frontend/components/DicomViewer.tsx`.
- [ ] Inspect `frontend/components/AdvancedViewer.tsx`.
- [ ] Inspect `frontend/components/ViewportManager.tsx`.
- [x] Inspect `backend/clinical/contracts.py`.
- [x] Inspect `backend/clinical/repositories.py`.
- [x] Inspect `backend/clinical/services.py`.
- [ ] Inspect current test fixtures under `dicom-test-files/`.
- [ ] Determine whether any NIFTI fixture exists; if not, generate a tiny safe synthetic fixture for tests or document missing manual fixture.
- [x] Generate safe synthetic NIFTI headers inside backend tests for `.nii` and `.nii.gz` coverage without PHI fixtures.

### Backend Local Ingest

- [x] Decide exact endpoint shape: `POST /api/local-imaging/import`.
- [x] Decide whether endpoint is available in `research`, `pilot`, and/or desktop-local mode: explicit `RADSYSX_LOCAL_IMAGING_ENABLED`, enabled by Electron desktop.
- [x] Require an authenticated local session for pilot/clinical-like desktop use.
- [x] Accept multipart uploads without writing to public static paths.
- [x] Store files under ignored `backend/local-imaging-data/` by default.
- [x] Add `.gitignore` rules for local uploaded image stores.
- [x] Enforce file size and count limits with clear errors.
- [x] Detect DICOM by pydicom parse and magic.
- [x] Detect DICOMDIR by filename and DICOM media storage metadata.
- [x] Resolve DICOMDIR referenced files safely enough for included-file warning/grouping and multi-study DICOMDIR association; deeper patient/study/series directory-record metadata coverage remains future work.
- [x] Detect `.nii` and `.nii.gz`.
- [x] Detect paired NIFTI/Analyze-style `.hdr` headers and accept a matching `.img` data file only when the matching header is present in the same import.
- [x] Detect NRRD `.nrrd` files by header and extension, and keep them backend-owned for local technical analysis rather than pretending OHIF can render them directly.
- [x] Expand `.zip` archives server-side into sanitized relative member paths and pass those members through the normal DICOM/DICOMDIR/NIFTI/NRRD/image detection path.
- [x] Apply the local import file-count and per-file size limits after archive expansion so one archive cannot bypass the same backend guardrails as selected files.
- [x] Detect common image fallbacks: PNG, JPEG, TIFF, BMP, GIF as local files.
- [x] Return a structured ingest response with local study IDs, modality/format, count, and warnings.
- [x] Avoid logging patient names, identifiers, raw DICOM tags, or paths containing PHI in tests/manifest.
- [x] Record imported DICOM studies into the local clinical repository.
- [x] Preserve seeded demo worklist behavior.
- [x] Make local archive refs explicit, e.g. `local://...`, not `orthanc://default`.
- [x] Persist `localStudyInstanceUID` in new manifests so generated NIFTI/NRRD/image study rows can find their private files later.
- [x] Add `GET /api/local-imaging/studies/{studyUid}/assets` for safe local asset summaries.
- [x] Return DICOM/NIFTI/NRRD/image asset capability flags without exposing private stored paths.
- [x] Parse NIFTI headers server-side for dimensions, datatype code, bit depth, and storage summary.
- [x] Link paired NIFTI `.hdr/.img` files in the private manifest without exposing raw local paths.
- [x] Keep local asset summaries behind `RADSYSX_LOCAL_IMAGING_ENABLED` and an authenticated backend session.
- [x] Add stable opaque local asset IDs for imported-study assets.
- [x] Add `GET /api/local-imaging/studies/{studyUid}/assets/{assetId}/preview` for backend-mediated local previews.
- [x] Serve common image previews through the backend without public static file exposure, including TIFF SVG header previews for browsers that do not render TIFF pixels natively.
- [x] Render initial NIFTI axial previews server-side as dependency-free SVG from private voxel bytes.
- [x] Extend backend-mediated NIFTI previews to axial, coronal, and sagittal slice selection through `axis` and `slice` query parameters.
- [x] Render paired NIFTI `.hdr/.img` previews by reading the header from `.hdr` and voxel data from the private paired `.img` manifest link.
- [x] Return NIFTI preview slice counts and default preview state in the imported-study asset contract.
- [x] Keep local previews behind `RADSYSX_LOCAL_IMAGING_ENABLED` and an authenticated backend session.
- [x] Add `GET /api/local-imaging/studies/{studyUid}/analysis` for deterministic backend-side local technical analysis.
- [x] Analyze simple uncompressed DICOM pixel data for frame dimensions, intensity range, and mean intensity.
- [x] Analyze NIFTI voxel data for dimensions, voxel count, intensity range, and mean intensity using bounded sampling.
- [x] Analyze paired NIFTI `.hdr/.img` voxel data through the `.hdr` asset while keeping the `.img` row as stored paired data.
- [x] Analyze NRRD header/raw-or-gzip voxel data for dimensions, type, encoding, voxel count, intensity range, and mean intensity using bounded sampling.
- [x] Analyze common image headers for dimensions and safe format metrics where possible.
- [x] Keep local analysis behind `RADSYSX_LOCAL_IMAGING_ENABLED` and an authenticated backend session.

### Frontend Local Import

- [x] Add local import UI to the desktop/local app path.
- [x] Keep controls dense and operational, not marketing-style.
- [x] Support native Electron file/folder selection and browser file/directory selection where browsers allow it.
- [x] Support browser drag-and-drop for files and Chromium-exposed folders while preserving relative paths.
- [x] Support browser/Electron submission of `.nrrd` files and `.zip` archives while keeping detection/decompression backend-owned.
- [x] Add stable test hooks for the local import panel, imported rows, inspect action, analysis action, previews, and analysis panel so UI smoke can verify the hydrated workflow without brittle styling selectors.
- [x] Allow multiple files.
- [x] Clearly show supported formats without in-app instructional clutter.
- [x] Show import success, warnings, and errors.
- [x] Refresh worklist after import.
- [x] Route imported DICOM studies to viewer/workspace launch path; backend now serves minimal local DICOMweb for imported DICOM.
- [x] Route NIFTI/NRRD/fallback images to a backend-owned inspection/analysis-summary path when OHIF is not immediately suitable.
- [x] Show backend-mediated preview thumbnails for previewable imported NIFTI and common image assets in the worklist inspection panel.
- [x] Add NIFTI axial/coronal/sagittal preview controls with a slice slider in the worklist inspection panel.
- [x] Add a worklist local-analysis action that renders backend technical metrics for imported assets.
- [x] Show NRRD assets as analysis-supported and non-viewer/non-preview assets until a proper volume renderer exists.
- [x] Keep text inside buttons/cards from overflowing on mobile and desktop in the worklist controls touched by this tranche.
- [x] Prefer the Electron native file/folder picker when available, while retaining browser input fallback.
- [x] Add richer drag-and-drop affordance for local import if it can stay compatible with governed backend upload.
- [ ] Add a dedicated local study detail route if the inspection panel becomes too dense for the worklist.

### Desktop Integration

- [x] Add Electron IPC file/folder picker for the desktop fast path.
- [x] Expose the picker through `preload.cjs` without exposing raw filesystem or shell primitives.
- [x] Preserve folder-relative paths from Electron picks through `radsysxRelativePath`.
- [x] Keep drag-and-drop browser upload as a portable fallback.
- [x] Add a hydrated Electron UI smoke for drag/drop local imaging import through the worklist.
- [x] Add a smoke-only picker bridge override guarded by `RADSYSX_DESKTOP_ALLOW_TEST_SHUTDOWN=1` and `RADSYSX_DESKTOP_PICKER_TEST_PATHS`, so automation can exercise the native picker IPC path without OS-dialog control.
- [x] Add `desktop:smoke:picker-import` to exercise the real hydrated worklist `Import folder` button, preload IPC bridge, main-process recursive file/folder collector, direct backend import, local inspection, NIFTI preview controls, and technical analysis.
- [x] Add `desktop:smoke:picker-files-import` to exercise the real hydrated worklist `Import files` button, preload IPC bridge, direct backend import of individual selected files, local inspection, NIFTI preview controls, and technical analysis.
- [x] Keep `RADSYSX_DESKTOP_PICKER_TEST_PATHS` out of normal runtime behavior when `RADSYSX_DESKTOP_ALLOW_TEST_SHUTDOWN` is not set.
- [x] Allow extensionless non-hidden picked files to pass through as DICOM candidates so DICOMDIR companion files are not silently dropped before backend detection.
- [x] Allow `.nrrd` files through the Electron native file picker filter and recursive folder collector.
- [x] Add preferred `window.radsysxDesktop.importLocalImaging` IPC that keeps selected file paths and bytes inside Electron main and uploads them to the backend import endpoint with the existing session cookie.
- [x] Keep the old `selectLocalImagingFiles` IPC as a compatibility fallback, but route normal Electron worklist imports through the direct main-process upload path.
- [x] Update `desktop:smoke:picker-import` to assert the direct native import bridge is exposed before clicking the worklist `Import folder` action.
- [x] Add `desktop:smoke:picker-large-import` with an additional 8 MiB synthetic NIFTI volume to exercise the direct native picker upload path beyond tiny focused fixtures.
- [x] Add `desktop:smoke:picker-many-import` with a nested folder of 32 additional extensionless CT instances to exercise recursive folder traversal and many-file direct native picker upload behavior.
- [x] Add `desktop:smoke:local-start-drop` to exercise no-click drag/drop import directly on the first OHIF local-start screen.
- [x] Allow `.zip` archives through the Electron native picker filter and recursive folder collector so bundled studies can reach the backend archive expansion path.
- [x] Fix desktop bridge HTTP proxying so proxied Next.js chunks do not intermittently fail with HTTP parser errors.
- [x] Proxy desktop bridge WebSocket upgrades so Next.js dev-mode hydration can run cleanly behind the one-origin Electron URL.
- [x] Move startup-smoke exit scheduling ahead of final app URL load so `npm run desktop:smoke` cannot hang after services are already ready.
- [x] Add a large-payload synthetic desktop picker smoke to prove bridge/proxy behavior beyond focused smoke fixtures.
- [x] Add a high-volume many-file synthetic desktop picker smoke to prove folder traversal and upload behavior with many DICOM instances.
- [x] Replace the normal desktop frontend path with a production standalone Next.js shell so hydrated UI smokes no longer rely on the noisy Next.js dev chunk proxy path.
- [x] Replace the POSIX-only root `desktop:bootstrap` shell chain with a cross-platform Node bootstrap helper and check mode.
- [x] Add a cross-platform `desktop/scripts/launch.mjs` helper that checks bootstrap, optionally repairs setup, and then opens Electron directly to the OHIF-first local app.
- [x] Point the root `npm run desktop` command at the launcher so the obvious user command is the fast local path.
- [x] Add `npm run desktop:smoke:launch` to keep the launcher contract under automated coverage.
- [x] Make the OHIF local-start screen a single-path experience by focusing `Open local study` as the primary action and keeping folder selection secondary.
- [x] Add first-screen OHIF drag/drop import so users can drop local studies directly onto the initial viewer screen without visiting the worklist first.
- [x] Make the default desktop production frontend build same-origin for public API/viewer URLs so the local app is not coupled to a single absolute localhost port and is friendlier to packaged/portable runtime work.
- [x] Keep `RADSYSX_DESKTOP_FRONTEND_MODE=development` / `npm run desktop:dev-frontend` as an explicit live Next.js development escape hatch.
- [x] Keep `desktop:dev-frontend` and `desktop:smoke` launcher scripts platform-neutral by setting runtime environment through Node launchers instead of POSIX inline shell assignment.
- [x] Force-refresh the frontend production shell during desktop UI smokes so smoke assertions exercise current source, not a stale desktop build stamp.
- [x] Disable Electron-supervised backend access logging to avoid printing local DICOMweb query strings that may include identifiers.
- [x] Ensure startup environment points local upload storage to a predictable ignored path.
- [x] Verify `npm run desktop:smoke` still starts and cleans up.
- [x] Add `npm run desktop:smoke:import` for no-Docker local imaging import/use verification.
- [x] Make the import smoke isolate database and local imaging storage in a temporary directory.
- [x] Gate the desktop bridge shutdown endpoint behind `RADSYSX_DESKTOP_ALLOW_TEST_SHUTDOWN=1` for smoke tests only.
- [x] Verify the import smoke cleans up its desktop runtime children without leaving ports `37000`, `37010`, or `37080` open.

### Viewer And Analysis

- [x] For DICOM, choose whether fast path serves a simple local DICOMweb endpoint or uses existing research DICOM viewer components first: first pass is simple local DICOMweb endpoint.
- [x] Add a desktop viewer-launch smoke proving imported local DICOM studies can open the governed viewer, resolve the opaque launch, bind local DICOMweb roots, query the imported study from the viewer origin, and paint a nonblank OHIF canvas for the synthetic DICOM.
- [x] For DICOMDIR, ensure referenced DICOM files become a series/study collection.
- [x] For NIFTI, choose and implement the short-term metadata path: backend asset summary plus header inspection.
- [x] For NIFTI, add a short-term backend-mediated default axial preview path.
- [x] For NIFTI, add multi-axis slice navigation for imported local volumes in the worklist inspection panel.
- [x] For paired NIFTI/Analyze-style `.hdr/.img`, link the pair server-side and expose the `.hdr` as the previewable/analyzable asset while the `.img` remains accepted private voxel storage.
- [x] For NRRD, implement the short-term backend technical-analysis path: safe header parsing plus bounded raw/gzip voxel statistics, with detached-data warnings and no direct OHIF viewer claim.
- [x] For PNG/JPEG/GIF/BMP, add backend-mediated local preview retrieval for the inspection panel.
- [x] For TIFF, add backend-mediated SVG header previews for the inspection panel without claiming full TIFF pixel decoding.
- [x] Add deterministic backend technical analysis for imported DICOM/NIFTI/NRRD/common image assets.
- [ ] For NIFTI, implement longer-term volume rendering, conversion, or dedicated analysis viewer path beyond backend SVG slice navigation.
- [ ] Add diagnostic/AI/segmentation analysis that consumes local stored files server-side without browser direct third-party transfer.
- [x] Avoid claiming full OHIF image rendering until a real DICOMweb or compatible local source is verified; docs call this minimal local DICOM metadata/frame serving, not full archive parity.
- [x] Ensure the local asset-summary path consumes private local stored files server-side without browser direct third-party transfer.
- [ ] Ensure future AI/segmentation routes can consume local stored files server-side without browser direct third-party transfer.

### Tests And Verification

- [x] Unit-test file format detection through backend endpoint tests for DICOM, DICOMDIR, and NIFTI.
- [x] Unit-test DICOM metadata extraction without PHI logging in manifest.
- [x] Unit-test DICOMDIR reference handling for an included referenced DICOM.
- [x] Unit-test DICOMDIR reference handling for a media-root DICOMDIR that references two different local DICOM studies.
- [x] Unit-test NIFTI detection for `.nii`.
- [x] Unit-test NIFTI detection and header summary for `.nii.gz`.
- [x] Unit-test paired NIFTI `.hdr/.img` import, private manifest link, preview retrieval, and voxel analysis.
- [x] Unit-test NRRD import, asset-summary capability flags, study finding, and technical analysis metrics.
- [x] Unit-test ZIP archive expansion with synthetic DICOMDIR, referenced DICOM, `.nii`, paired `.hdr/.img`, and an unsupported note that is rejected instead of promoted.
- [x] Unit-test NIFTI default axial preview retrieval for `.nii.gz`.
- [x] Unit-test NIFTI preview slice metadata and axial/coronal/sagittal preview retrieval.
- [x] Unit-test NIFTI voxel statistics through the local analysis endpoint.
- [x] Unit-test common image fallback import and asset-summary reporting with synthetic PNG, JPEG, and TIFF payloads.
- [x] Unit-test common image preview retrieval with synthetic PNG/JPEG bytes and TIFF SVG header preview payloads.
- [x] Unit-test common image header analysis with synthetic PNG, JPEG, and TIFF payloads.
- [x] Unit-test local DICOM asset summary reports viewer eligibility for DICOMweb-backed imports.
- [x] Unit-test local DICOM pixel statistics for a simple uncompressed DICOM instance.
- [x] Add backend API test for local import with synthetic/safe files.
- [x] Add frontend type-check coverage for import UI.
- [x] Run `npm run desktop:doctor`.
- [x] Run `npm run desktop -- --check-only`.
- [x] Run `npm run desktop:smoke:launch`.
- [x] Run `npm run desktop:smoke`.
- [x] Run `npm run desktop:smoke:import`.
- [x] Run `npm run desktop:smoke:ui-import`.
- [x] Run `npm run desktop:smoke:picker-import` after adding the picker bridge smoke.
- [x] Run `npm run desktop:smoke:picker-large-import` after adding the large picker payload smoke.
- [x] Run `npm run desktop:smoke:picker-many-import` after adding the many-file picker smoke.
- [x] Run `python3 -m pytest backend/tests/test_clinical_platform.py`.
- [x] Run any new backend tests.
- [x] Run `npm run type-check`.
- [x] Run `npm run build --workspace viewer`.
- [x] Perform a live no-Docker runtime upload smoke through the desktop bridge API with synthetic DICOMDIR+DICOM+`.nii.gz`+PNG files.
- [x] Replace the one-off live no-Docker import smoke with a committed `desktop:smoke:import` command covering DICOMDIR, DICOM, `.nii`, `.nii.gz`, paired `.hdr/.img`, `.nrrd`, ZIP-expanded NIFTI/PNG, PNG, JPEG, and TIFF.
- [x] Extend `desktop:smoke:import` to verify backend-mediated NIFTI SVG preview, PNG/JPEG byte preview retrieval, and TIFF SVG header preview retrieval.
- [x] Extend `desktop:smoke:import` to verify NIFTI preview slice metadata and coronal slice retrieval through the local bridge.
- [x] Extend `desktop:smoke:import` to verify backend local analysis for DICOM intensity range, single-file, paired, and ZIP-expanded NIFTI voxel count/mean intensity, NRRD type/voxel statistics, PNG dimensions, JPEG dimensions/precision, and TIFF dimensions.
- [x] Add `desktop:smoke:ui-import` to exercise hydrated Electron worklist controls, local drag/drop import, inspection, NIFTI preview controls, and backend technical analysis.
- [x] Perform a true UI drag-and-drop upload smoke through the hydrated Electron worklist controls with synthetic PHI-free files.
- [x] Perform the committed individual-file picker bridge smoke through `npm run desktop:smoke:picker-files-import`.
- [x] Perform the committed picker bridge smoke through `npm run desktop:smoke:picker-import`.
- [x] Perform the committed large picker payload smoke through `npm run desktop:smoke:picker-large-import`.
- [x] Perform the committed many-file picker smoke through `npm run desktop:smoke:picker-many-import`.
- [x] Add and run the committed first-screen OHIF drag/drop smoke through `npm run desktop:smoke:local-start-drop`.
- [ ] Perform a native OS file-picker smoke with real or realistic local files once OS-dialog automation is available.

### Documentation

- [x] Update root `AGENTS.md` if local imaging changes behavior/contracts.
- [x] Update closest child `AGENTS.md` files touched by local imaging work.
- [x] Update `README.md` with local import workflow once real behavior exists.
- [x] Update `DEPLOY_LOCAL.md` if desktop/local imaging run path changes.
- [x] Document limitations honestly: e.g. metadata import vs full OHIF rendering if not yet complete.

## Completion Audit Template

Before marking this goal complete, fill in evidence for each explicit requirement:

- Local runnable desktop app:
  - Evidence: `npm run desktop:doctor` and `npm run desktop:smoke` passed after the Electron fast path commit; desktop scripts are in root `package.json` and `desktop/`.
  - Evidence: `npm run desktop:doctor` and `npm run desktop:smoke` also passed after the imported-study asset-summary tranche.
  - Evidence: `npm run desktop:smoke:import` passed after being added as a committed script.
  - Evidence: Electron now exposes a native local imaging file/folder picker through `window.radsysxDesktop.selectLocalImagingFiles`.
  - Evidence: the worklist local import panel now accepts browser drag-and-drop files and Chromium-exposed folders, preserving folder-relative paths as `radsysxRelativePath` before submitting to the backend import endpoint.
  - Evidence: `npm run desktop:smoke:ui-import` now proves the Electron shell hydrates through the one-origin bridge, clicks from the desktop root to `/worklist`, imports synthetic local files through a DOM drag/drop on the real worklist panel, inspects imported studies, switches a NIFTI preview to coronal, and runs backend technical analysis.
  - Evidence: `npm run desktop:smoke:picker-files-import` is now a committed hydrated Electron file-picker bridge smoke; it clicks the real worklist `Import files` button and proves renderer button, preload IPC, smoke-injected individual file selection, backend import, inspection, NIFTI preview controls, and backend technical analysis using PHI-free synthetic files.
  - Evidence: `npm run desktop:smoke:picker-import` is now a committed hydrated Electron folder-picker bridge smoke; it clicks the real worklist `Import folder` button and proves renderer button, preload IPC, main-process recursive folder collection, backend import, inspection, NIFTI preview controls, and backend technical analysis using PHI-free synthetic files.
  - Evidence: `npm run desktop:smoke:picker-files-import` and `npm run desktop:smoke:picker-import` passed after the ZIP fixture tranche; both standard picker fixture sets imported 11 accepted files into 2 local studies after expanding a ZIP containing supported NIFTI/PNG members, including a 9-file NIFTI/image row with paired `.hdr/.img`, and reported `previewCount: 8`.
  - Evidence: the preferred native picker import now uses `window.radsysxDesktop.importLocalImaging`, keeps selected file paths and bytes in Electron main, attaches the existing session cookie from the Electron cookie jar, and sends file-backed multipart data to `POST /api/local-imaging/import`; the renderer receives only the small backend import response.
  - Evidence: `npm run desktop:smoke:picker-large-import` passed after the ZIP fixture tranche with an additional 8 MiB `large-volume.nii`; the refreshed fixture set imported 12 accepted files into 2 local studies after ZIP expansion and reported `previewCount: 9`.
  - Evidence: `npm run desktop:smoke:picker-many-import` passed after the ZIP fixture tranche with a nested folder of 32 additional extensionless CT instances; the refreshed fixture set imported 43 accepted files into 2 local studies after ZIP expansion, kept the DICOM/DICOMDIR row at 34 files, kept the NIFTI/image row at 9 files, and reported `previewCount: 8`.
  - Evidence: after the NRRD plus first-screen-primary tranche, `npm run desktop -- --check-only`, `npm run desktop:smoke:launch`, `npm run desktop:smoke:import`, `npm run desktop:smoke:local-start`, `npm run desktop:smoke:local-start-nondicom`, and `npm run desktop:smoke:picker-files-import` passed. The refreshed standard picker fixture set imported 12 accepted files into 2 local studies with a 10-file NIFTI/NRRD/image row and `previewCount: 8`.
  - Evidence: after the first-screen drag/drop tranche, `npm run desktop:smoke:local-start-drop` passed and reported `importPath: local-start-drop`, `dropState.draggingSeen: true`, dropped fixture file count `11`, same-origin `/dicom-web` roots, matching workspace UID, and one nonblank OHIF canvas.
  - Evidence: the desktop bridge now sanitizes proxied HTTP headers and proxies WebSocket upgrades, fixing the hydration failures found while creating `desktop:smoke:ui-import`.
  - Evidence: `desktop:smoke:import` now also fetches backend-mediated NIFTI SVG, PNG/JPEG byte, and TIFF SVG header previews through the local bridge.
  - Evidence: `desktop:smoke:import` now verifies NIFTI preview slice metadata and a non-default coronal preview through the local bridge.
  - Evidence: `desktop:smoke:import` now fetches backend technical analysis results for imported DICOM, single-file/paired/ZIP-expanded NIFTI, PNG, JPEG, and TIFF assets through the local bridge.
  - Remaining gap: needs manual or automation-backed native OS dialog upload smoke before final completion.
- Upload/select local DICOM:
  - Evidence: backend endpoint tests import synthetic DICOM through `POST /api/local-imaging/import`; local DICOMweb and asset summary tests prove the stored DICOM is discoverable and viewer-eligible; `npm run desktop:smoke:import` imports synthetic DICOM and reports viewer eligibility.
  - Evidence: `desktop:smoke:viewer-launch` imports synthetic DICOM/DICOMDIR through the hydrated worklist, clicks `Open viewer`, verifies `/viewer/` launch resolution and local DICOMweb runtime roots, confirms viewer-origin DICOMweb/workspace access to the imported study, and asserts a nonblank OHIF canvas render.
  - Evidence: backend endpoint tests and `desktop:smoke:import` now prove simple uncompressed DICOM pixel technical analysis, including frame dimensions, intensity range, and mean intensity.
  - Evidence: the Electron native picker can select local imaging files and preserve them for the existing backend import flow.
  - Evidence: `desktop:smoke:ui-import` imports synthetic DICOM plus DICOMDIR through the hydrated worklist drag/drop UI and verifies DICOMDIR asset inspection plus DICOM intensity analysis.
  - Evidence: `desktop:smoke:picker-files-import` exercises the Electron file picker bridge over individual fixture paths containing DICOMDIR plus a DICOM instance, then verifies DICOMDIR inspection and DICOM intensity analysis.
  - Evidence: `desktop:smoke:picker-import` exercises the Electron folder picker bridge over a fixture folder containing DICOMDIR plus a DICOM instance, then verifies DICOMDIR inspection and DICOM intensity analysis.
  - Evidence: the picker now passes extensionless DICOM candidates such as `SCAN1DCM` through to backend detection, matching common DICOMDIR folder layouts.
  - Evidence: `desktop:smoke:picker-many-import` exercises the same direct native picker bridge over a nested folder of 32 additional extensionless CT instances, then verifies the imported DICOM study has 33 DICOM instances and still runs DICOM technical analysis.
  - Remaining gap: native OS dialog upload of a real local DICOM file still needs runtime smoke evidence.
- Upload/select DICOMDIR:
  - Evidence: backend endpoint tests import synthetic DICOMDIR plus referenced DICOM and group them into one local study row; `npm run desktop:smoke:import` imports synthetic DICOMDIR plus referenced DICOM and returns `dicom`/`dicomdir` asset summary.
  - Evidence: backend endpoint tests now import one synthetic DICOMDIR under a media root that references two sibling DICOM studies; each resulting local study row includes both the DICOM asset and the shared DICOMDIR index through manifest `localStudyInstanceUIDs`.
  - Evidence: the Electron native folder picker preserves relative paths for DICOMDIR-style folder imports.
  - Evidence: `desktop:smoke:ui-import` imports synthetic DICOMDIR plus referenced DICOM through a hydrated worklist drag/drop and verifies the local DICOMDIR row can be inspected.
  - Evidence: `desktop:smoke:picker-files-import` exercises the hydrated `Import files` action through the Electron picker bridge with individual DICOMDIR/DICOM paths.
  - Evidence: `desktop:smoke:picker-import` exercises the hydrated `Import folder` action through the Electron picker bridge and recursive folder collector for a DICOMDIR-style folder.
  - Evidence: `desktop:smoke:picker-many-import` preserves the DICOMDIR-style folder import while adding nested extensionless companion DICOM instances under the same study, yielding a 34-file DICOM/DICOMDIR row.
  - Remaining gap: native OS directory-picker runtime smoke with a realistic DICOMDIR folder remains open.
- Upload/select NIFTI `.nii`:
  - Evidence: backend endpoint tests import a synthetic `.nii` file and register a local worklist row; `npm run desktop:smoke:import` imports `.nii` and verifies analysis-supported asset summary.
  - Evidence: the shared local asset contract now exposes opaque asset IDs plus preview capability flags/URLs for NIFTI assets.
  - Evidence: backend technical analysis now computes NIFTI dimensions, voxel count, intensity range, and mean intensity from private local voxel bytes.
  - Evidence: NIFTI assets now expose preview slice counts and can render axial/coronal/sagittal SVG slices through authenticated backend preview URLs.
  - Evidence: `desktop:smoke:ui-import` imports `.nii` and `.nii.gz` through the hydrated worklist drag/drop UI, verifies the NIFTI row, loaded previews, coronal preview control, and voxel technical analysis.
  - Evidence: `desktop:smoke:picker-files-import` imports `.nii` through the hydrated `Import files` picker bridge path and verifies NIFTI inspection, preview loading, coronal preview control, and voxel technical analysis.
  - Evidence: `desktop:smoke:picker-import` imports `.nii` through the hydrated `Import folder` picker bridge path and verifies NIFTI inspection, preview loading, coronal preview control, and voxel technical analysis.
  - Evidence: `desktop:smoke:picker-large-import` imports an 8 MiB `.nii` volume through the direct native picker path and verifies `256 x 256 x 128` dimensions plus `8388608` voxel technical analysis.
  - Remaining gap: native OS dialog upload/inspection of `.nii` remains open; full volume rendering and diagnostic/AI analysis are still future work.
- Upload/select NIFTI `.nii.gz`:
  - Evidence: backend endpoint tests import synthetic gzipped NIFTI, preserve relative path, and extract `2 x 3 x 4` dimensions through the asset-summary endpoint; `npm run desktop:smoke:import` imports `.nii.gz` and returns the same dimension summary.
  - Evidence: backend endpoint tests and `desktop:smoke:import` now fetch an authenticated backend-mediated SVG default axial preview for `.nii.gz`.
  - Evidence: backend endpoint tests and `desktop:smoke:import` now prove deterministic voxel statistics for imported NIFTI assets.
  - Evidence: backend endpoint tests now fetch axial/coronal/sagittal preview slices for `.nii.gz`, and `desktop:smoke:import` verifies non-default coronal preview retrieval.
  - Evidence: `desktop:smoke:ui-import` verifies a NIFTI preview image loads in the UI and that selecting the coronal control changes the preview URL to a coronal slice.
  - Evidence: `desktop:smoke:picker-files-import` imports `.nii.gz` through the hydrated `Import files` picker bridge path and verifies loaded preview plus coronal preview URL transition.
  - Evidence: `desktop:smoke:picker-import` imports `.nii.gz` through the hydrated `Import folder` picker bridge path and verifies loaded preview plus coronal preview URL transition.
  - Remaining gap: native OS dialog upload/inspection of `.nii.gz` remains open; full NIFTI volume rendering and diagnostic/AI analysis remain open.
- Upload/select paired NIFTI/Analyze-style `.hdr/.img`:
  - Evidence: backend endpoint tests import synthetic `paired.hdr` plus `paired.img`, accept both files, write `pairedStoredPath`/`pairedRelativePath` only into the private manifest, return formats `["nifti", "nifti-data"]`, and keep the `.img` row non-previewable/non-analysis-supported directly.
  - Evidence: backend endpoint tests fetch a coronal SVG preview for the `.hdr` asset using voxel bytes from the private paired `.img` link.
  - Evidence: backend endpoint tests prove paired NIFTI voxel statistics through the `.hdr` asset, including voxel count `24`, intensity range `0 to 23`, and mean intensity `11.5`; the `.img` analysis row explains that it is analyzed through the matching `.hdr`.
  - Evidence: the `/worklist` local import file input now advertises `NIFTI (.nii/.nii.gz/.hdr+.img)` and includes `.hdr,.img` in its accept list.
  - Evidence: Electron main now allows `.hdr` and `.img` through native file/folder selection filters and recursive collection so paired voxel data can reach backend linking.
  - Evidence: `desktop:smoke:import`, `desktop:smoke:ui-import`, `desktop:smoke:picker-files-import`, `desktop:smoke:picker-import`, `desktop:smoke:picker-large-import`, `desktop:smoke:picker-many-import`, and `desktop:smoke:viewer-launch` all passed after adding the ZIP fixture on top of the paired fixture; standard smokes imported 11 accepted files into 2 studies after ZIP expansion with a 9-file NIFTI/image row and `previewCount: 8`, large picker imported 12 accepted files with `previewCount: 9`, and many-file picker imported 43 accepted files while preserving the 34-file DICOM/DICOMDIR row.
  - Remaining gap: native OS dialog upload/inspection of a real paired `.hdr/.img` dataset remains open; full NIFTI volume rendering and diagnostic/AI analysis remain open.
- Upload/select NRRD `.nrrd`:
  - Evidence: backend endpoint tests import synthetic `segmentation.nrrd`, return formats including `nrrd`, mark the NRRD asset analysis-supported but not viewer/preview-supported, and report the study finding `2 x 3 x 4 voxels; type uint8; encoding raw`.
  - Evidence: backend analysis tests prove NRRD metrics: volume dimensions `2 x 3 x 4`, type `uint8`, encoding `raw`, voxel count `24`, intensity range `0 to 23`, and mean intensity `11.5`.
  - Evidence: Electron main now allows `.nrrd` through native file/folder selection and uploads it with `application/octet-stream`.
  - Evidence: `/worklist` advertises NRRD and includes `.nrrd` in its browser file input accept list.
  - Evidence: `npm run desktop:smoke:import` passed with `segmentation.nrrd`; the non-DICOM study returned formats `jpeg`, `nifti`, `nifti-data`, `nrrd`, `png`, and `tiff`, file count `10`, NRRD volume findings, and analysis summary `Analyzed 9 of 10 local assets`.
  - Evidence: `npm run desktop:smoke:local-start-nondicom` passed from the OHIF-first screen with NRRD included; the worklist fallback row was `Local NIFTI import (10 files)`, the panel contained `NRRD volume`, and the analysis panel contained `segmentation.nrrd`, `NRRD type`, `uint8`, intensity range, and mean intensity.
  - Evidence: `npm run desktop:smoke:picker-files-import` passed through the Electron native file picker bridge with NRRD included and imported 12 accepted files into 2 local studies.
  - Remaining gap: native OS dialog upload/inspection of a real NRRD labelmap or segmentation remains open; full NRRD volume rendering is not claimed.
- Upload/select ZIP archives containing supported local imaging files:
  - Evidence: backend endpoint tests import one synthetic `case.zip` containing `CASEZ/DICOMDIR`, referenced `CASEZ/SCAN1DCM`, `NIFTI/volume.nii`, paired `NIFTI/paired.hdr` plus `NIFTI/paired.img`, and an unsupported `README.txt`; the backend expands 6 members, accepts 5 medical-image members, rejects the note, writes only accepted members to the private manifest, groups DICOMDIR with its referenced DICOM study UID, and groups the NIFTI/paired assets into the generated NIFTI study.
  - Evidence: backend endpoint tests fetch assets and analysis for the ZIP-expanded NIFTI study, including paired-data findings and voxel statistics for `archives/case/NIFTI/volume.nii`.
  - Evidence: `/worklist` now advertises ZIP and includes `.zip` in the browser file input accept list; drag/drop can submit a `.zip` as a normal file while the backend owns decompression.
  - Evidence: Electron main now allows `.zip` through the native file picker filter, recursive folder collector, and direct main-process backend upload path with `application/zip` content type.
  - Evidence: desktop API/UI/picker smokes now include `archive.zip`, verify the backend returns `Expanded archive archive.zip into 2 file(s).`, verify the ZIP-expanded NIFTI and PNG assets appear in the NIFTI/image study, and verify ZIP-expanded NIFTI technical analysis.
  - Remaining gap: native OS dialog upload/inspection of a real downloaded archive remains open; archive expansion intentionally supports ZIP only, not tar/7z/RAR.
- Generic suitable medical files:
  - Evidence: backend endpoint tests import synthetic PNG, JPEG, and TIFF fallbacks and report them through the asset-summary endpoint; importer accepts PNG/JPEG/TIFF/BMP/GIF extensions; `npm run desktop:smoke:import` imports PNG/JPEG/TIFF fallbacks and reports them as analysis-supported.
  - Evidence: backend endpoint tests and `desktop:smoke:import` now fetch authenticated PNG/JPEG preview bytes plus TIFF SVG header preview bytes through the backend preview endpoint.
  - Evidence: backend endpoint tests and `desktop:smoke:import` now prove local PNG, JPEG, and TIFF header analysis, including image dimensions and JPEG precision/color-component metadata.
  - Evidence: `desktop:smoke:ui-import` imports PNG/JPEG/TIFF through the hydrated worklist drag/drop UI, verifies a preview image loads, and verifies local image dimension analysis.
  - Evidence: `desktop:smoke:picker-files-import` imports PNG/JPEG/TIFF through the hydrated file picker bridge path, verifies preview loading, and verifies local image dimension analysis.
  - Evidence: `desktop:smoke:picker-import` imports PNG/JPEG/TIFF through the hydrated folder picker bridge path, verifies preview loading, and verifies local image dimension analysis.
  - Remaining gap: native OS dialog upload/inspection of real image fallback files remains open; full pixel-decoded TIFF rendering remains future work if needed.
- Files become usable in worklist/viewer/analysis:
  - Evidence: imported rows are registered in the clinical worklist; DICOM rows are viewer-eligible through local DICOMweb metadata/frame/instance endpoints; NIFTI/image rows are inspectable through backend-owned asset summaries and preview thumbnails in the worklist UI.
  - Evidence: Electron now opens first into the OHIF local-start screen instead of requiring the user to land on `/`, understand the product split, click into worklist, import, and then open the viewer.
  - Evidence: `npm run desktop` now runs the launcher contract first: check bootstrap, repair setup when allowed, then open the OHIF-first Electron runtime; `npm run desktop:run` is the explicit direct-run escape hatch.
  - Evidence: `npm run desktop -- --check-only` provides a non-mutating way to verify that a machine is ready before opening the app, while normal users can still simply run `npm run desktop`.
  - Evidence: `npm run desktop:smoke:launch` exists to prove the launcher itself, not only the lower-level Electron startup script.
  - Evidence: the OHIF local-start path imports through `window.radsysxDesktop.importLocalImaging`, preserving the direct Electron-main upload path and avoiding a renderer-owned file-byte bridge for the default desktop experience.
  - Evidence: the OHIF local-start drop path imports through direct same-origin multipart POST to `POST /api/local-imaging/import`, preserving `radsysxRelativePath`/`webkitRelativePath` for dropped browser files and Chromium folder entries, then reuses the same DICOM launch or non-DICOM worklist routing as the native picker path. `desktop:smoke:local-start-drop` proved this with synthetic fixture files dropped onto the first-screen card.
  - Evidence: the refreshed `desktop:smoke:local-start` now fails unless the first OHIF screen reports `title: Open a local study`, `primaryLabel: Open local study`, `secondaryLabel: Choose folder`, `primaryFocused: true`, and `localQueryPresent: false`.
  - Evidence: DICOM imported from the OHIF local-start screen is immediately opened in OHIF by creating a backend governed imaging launch; no PHI-bearing study UID is left in the visible URL and the helper `local=1` query is stripped once the local-start card is shown.
  - Evidence: if the local-start import produces only NIFTI/image studies, the viewer does not pretend OHIF can render those assets directly yet; it sets `radsysx.localStart.inspectStudyUid` in session storage and hands off to the worklist's existing backend-owned asset inspection panel.
  - Evidence: `desktop:smoke:viewer-launch` verifies the imported DICOM study can be opened from the hydrated worklist into the governed viewer path, with the launch token stripped from the browser URL after resolution, same-origin local DICOMweb roots applied to the viewer configuration, and a nonblank OHIF canvas painted for the synthetic DICOM.
  - Evidence: `desktop:smoke:local-start` verifies the OHIF-first path directly: `localStartState.href` is `/viewer/`, `localQueryPresent` is false, the local-start loader state is present, `Open local study` is focused, the imported DICOM study resolves under `/viewer/`, local DICOMweb/workspace probes succeed, and the OHIF canvas has one nonblank sampled canvas.
  - Evidence: `desktop:smoke:local-start-drop` verifies the no-click OHIF-first path directly: `localStartState.href` is `/viewer/`, drop highlighting is observed, synthetic files are dropped onto the local-start card, the imported DICOM study resolves under `/viewer/`, local DICOMweb/workspace probes succeed, and the OHIF canvas has one nonblank sampled canvas.
  - Evidence: `desktop:smoke:local-start-nondicom` verifies the OHIF-first non-DICOM path directly: `localStartState.href` is `/viewer/`, `localQueryPresent` is false, the import selected only NIFTI/NRRD/image/ZIP fixtures, the app landed at `/worklist`, the single local row was `Local NIFTI import (10 files)`, the local assets panel auto-opened, `previewCount` was 8, a coronal preview URL was observed, backend analysis reported voxel count `24`, mean intensity `11.5`, paired `.hdr/.img` linkage, NRRD type `uint8`, ZIP-expanded `zipped-volume.nii`, PNG/JPEG/TIFF image dimensions/precision, and the row did not expose `Open viewer`.
  - Evidence: the worklist now renders NIFTI axis buttons and a slice slider backed by authenticated backend preview URLs.
  - Evidence: the worklist now exposes a backend-owned local analysis action and renders deterministic technical metrics returned by `GET /api/local-imaging/studies/{studyUid}/analysis`.
  - Evidence: `desktop:smoke:ui-import` proves those controls work in a hydrated Electron renderer rather than only through API-level smoke calls.
  - Evidence: `desktop:smoke:picker-files-import` proves those controls also work after files arrive from the Electron native file picker bridge rather than synthetic DOM drag/drop.
  - Evidence: `desktop:smoke:picker-import` proves those controls also work after files arrive from the Electron native folder picker bridge rather than synthetic DOM drag/drop.
  - Evidence: the native picker path no longer requires selected file contents to be marshalled through renderer IPC before backend import, reducing the fragility of larger local DICOM/NIFTI folders.
  - Evidence: `desktop:smoke:picker-large-import` verifies backend summary text for the `256 x 256 x 128` larger NIFTI, preview loading, coronal slice switching, and backend analysis text including the `8388608` voxel count.
  - Evidence: `desktop:smoke:picker-many-import` previously verified the hydrated worklist could inspect and analyze a local import containing 43 accepted files after ZIP expansion, including a 34-file DICOM/DICOMDIR study row and the 9-file NIFTI/image study row. After NRRD, that variant should be rerun at the current 44-file expectation before using it as final completion evidence.
  - Remaining gap: full OHIF pixel rendering across varied real-world DICOM archives and richer diagnostic/AI NIFTI/image analysis remain unproven.
- No Docker required for the fast path:
  - Evidence: Electron supervises FastAPI, Next.js, and the local viewer bridge; local import, worklist, asset summaries/previews/analysis, and local DICOMweb are backend filesystem/database contracts, not Docker/Orthanc-only contracts; `npm run desktop:smoke:import` passed while compose/Orthanc were not running.
  - Evidence: `npm run desktop:smoke:local-start` passed while compose/Orthanc were not running and exercised the exact default first route plus imported-DICOM OHIF rendering through the local backend DICOMweb surface.
  - Evidence: `npm run desktop:smoke:local-start-nondicom` passed while compose/Orthanc were not running and exercised the exact default first route plus NIFTI/image/ZIP inspection and technical analysis through local backend contracts.
  - Evidence: `npm run desktop:smoke:ui-import` passed while compose/Orthanc were not running and exercised the hydrated Electron worklist drag/drop surface.
  - Evidence: `npm run desktop:smoke:viewer-launch` passed while compose/Orthanc were not running and exercised imported-DICOM viewer handoff plus viewer-origin local DICOMweb/workspace access.
  - Evidence: `npm run desktop:smoke:picker-files-import` passed while compose/Orthanc were not running and exercised direct native file picker upload of individual synthetic local files.
  - Evidence: `npm run desktop:smoke:picker-import` passed while compose/Orthanc were not running and exercised the native picker bridge path.
  - Evidence: `npm run desktop:smoke:picker-large-import` passed while compose/Orthanc were not running and exercised direct native picker upload of an 8 MiB NIFTI payload.
  - Evidence: `npm run desktop:smoke:picker-many-import` passed before the NRRD fixture was added while compose/Orthanc were not running and exercised direct native picker upload of 43 accepted synthetic local files after ZIP expansion, including nested extensionless DICOM instances; with the current NRRD fixture the refreshed many-file expectation is 44 accepted files and remains to be rerun.
  - Remaining gap: final native OS dialog smoke should be repeated with real or realistic local files.
- Cross-platform design:
  - Evidence: `npm run desktop:bootstrap` now runs a Node helper instead of a POSIX `. .venv/bin/activate` shell chain; it picks `python3`/`python` on Unix-like hosts, `py -3`/`python` on Windows, resolves the venv Python path per OS, and exposes `--check` for non-mutating bootstrap verification.
  - Evidence: desktop runtime, doctor, bootstrap, API smoke, and UI smoke now share the same platform-aware Python lookup posture: `RADSYSX_DESKTOP_PYTHON`/`PYTHON` override support, `.venv/Scripts/python.exe` on Windows, `.venv/bin/python` on Unix-like hosts, then platform default fallback. This removes the previous Linux-only `.venv/bin/python` assumption from the actual Electron backend launch and smoke fixture generation.
  - Evidence: browser file inputs preserve `webkitRelativePath` when available; browser drag-and-drop preserves Chromium directory-entry relative paths as `radsysxRelativePath`; Electron picks preserve `radsysxRelativePath`; backend sanitizes POSIX-style relative paths and stores private files under configured local storage; docs use Linux commands while Electron path avoids Docker-specific assumptions.
  - Evidence: desktop UI smoke uses Electron/Chromium APIs and repo-local temp storage/database, avoiding Linux-only paths inside the app/runtime path.
  - Evidence: picker bridge smokes use JSON-encoded fixture paths and Electron IPC, avoiding Linux-only renderer file APIs while still preserving POSIX-style relative paths for backend manifests when folders are selected.
  - Evidence: direct native import relies on Electron IPC, the Electron cookie jar, Node file-backed blobs, and backend multipart upload rather than Linux-specific renderer file APIs or absolute-path exposure.
  - Evidence: the large picker payload smoke uses the same Electron-main direct upload path and avoids renderer `File`/`ArrayBuffer` construction for the 8 MiB NIFTI.
  - Evidence: the many-file picker smoke uses the same Electron-main direct upload path and preserves nested POSIX-style relative paths for the synthetic DICOM folder manifest.
  - Remaining gap: Windows/macOS native directory picker behavior is implemented via Electron but not yet tested on those OSes.
- PHI/security guardrails preserved:
  - Evidence: imported files stay outside public static routes; manifests avoid raw DICOM patient identifiers in tests; local asset summaries/previews/analysis omit private stored paths and raw DICOM tags; endpoints require signed backend session and `RADSYSX_LOCAL_IMAGING_ENABLED`.
  - Evidence: Electron-supervised uvicorn access logging is disabled after `desktop:smoke:viewer-launch` exposed that OHIF may issue DICOMweb prior queries containing DICOM identifiers in the URL query string.
  - Remaining gap: broader real-world PHI log audit remains open.
- Tests and runtime smoke:
  - Evidence: focused local imaging backend tests and Python compile checks passed during this tranche; full clinical platform test suite passed; frontend/viewer type-checks passed; viewer build passed; desktop doctor and desktop smoke passed; committed desktop import smoke passed.
  - Evidence: after the OHIF-first desktop local-start tranche, `node --check desktop/src/main.mjs`, `node --check desktop/scripts/ui-import-smoke.mjs`, `node --check viewer/assets/radsysx-bootstrap.js`, `npm run build --workspace viewer`, `npm run desktop:smoke:local-start`, `npm run type-check --workspace frontend`, `npm run type-check --workspace viewer`, `npm run desktop:smoke`, `npm run desktop:smoke:ui-import`, and `npm run desktop:smoke:viewer-launch` passed before the final docs/hygiene pass. The local-start smoke reported `href: http://127.0.0.1:37100/viewer/`, `localQueryPresent: false`, `loaderState: local-start`, imported DICOM study UID `1.2.826.0.1.3680043.10.54321.910`, same-origin `/dicom-web` runtime roots, one DICOMweb study, matching workspace UID, and one nonblank OHIF canvas with 2304 nonblack sampled pixels.
  - Evidence: after the OHIF-first non-DICOM fallback tranche, `node --check desktop/scripts/ui-import-smoke.mjs` and `npm run desktop:smoke:local-start-nondicom` passed before final docs/hygiene. The non-DICOM smoke reported `href: http://127.0.0.1:37100/viewer/`, `localQueryPresent: false`, route fallback to `http://127.0.0.1:37100/worklist`, one `Local NIFTI import (9 files)` row, 8 previewable assets, a coronal preview URL, and backend analysis for NIFTI, paired NIFTI, ZIP-expanded NIFTI/PNG, PNG, JPEG, and TIFF assets.
  - Evidence: after the cross-platform Python resolution tranche, `node --check desktop/src/main.mjs desktop/scripts/bootstrap.mjs desktop/scripts/doctor.mjs desktop/scripts/import-smoke.mjs desktop/scripts/ui-import-smoke.mjs`, `npm run desktop:doctor`, `npm run desktop:bootstrap -- --check`, `npm run desktop:smoke`, `npm run desktop:smoke:import`, and `npm run desktop:smoke:local-start-nondicom` passed. `desktop:smoke` and the two import smokes showed the backend launched through the repo venv Python; `desktop:doctor` now checks `pydicom` too and repair guidance points to `npm run desktop:bootstrap` instead of a Linux shell activation chain.
  - Evidence: after the preview tranche, `python3 -m pytest backend/tests/test_clinical_platform.py` passed with 26 tests and the expected warnings.
  - Evidence: after the local technical analysis tranche, `python3 -m pytest backend/tests/test_clinical_platform.py` passed with 26 tests and the expected warnings; broader verification must be rerun after final edits.
  - Evidence: after the drag-and-drop import tranche, `npm run type-check --workspace frontend`, `npm run type-check`, `npm run desktop:smoke:import`, `npm run desktop:doctor`, `python3 -m pytest backend/tests/test_clinical_platform.py`, `npm run desktop:smoke`, and `git diff --check` passed.
  - Evidence: after the hydrated UI import smoke tranche, `node --check desktop/src/main.mjs desktop/scripts/doctor.mjs desktop/scripts/import-smoke.mjs desktop/scripts/ui-import-smoke.mjs`, `npm run type-check`, `npm run desktop:doctor`, `. .venv/bin/activate && python3 -m pytest backend/tests/test_clinical_platform.py`, `npm run desktop:smoke:ui-import`, `npm run desktop:smoke:import`, `npm run desktop:smoke`, `. .venv/bin/activate && python3 -m compileall backend/clinical backend/server.py backend/radsysx.py`, `npm run build --workspace viewer`, and `git diff --check` passed; smoke ports were clear afterward.
  - Evidence: after the native picker bridge smoke tranche, `node --check desktop/src/main.mjs desktop/scripts/ui-import-smoke.mjs`, `node --check desktop/src/main.mjs desktop/scripts/ui-import-smoke.mjs desktop/scripts/doctor.mjs desktop/scripts/import-smoke.mjs`, `npm run desktop:smoke:picker-import`, `npm run desktop:smoke:ui-import`, `npm run desktop:smoke:import`, `npm run desktop:doctor`, `npm run type-check`, `npm run desktop:smoke`, `. .venv/bin/activate && python3 -m compileall backend/clinical backend/server.py backend/radsysx.py`, `. .venv/bin/activate && python3 -m pytest backend/tests/test_clinical_platform.py`, `npm run build --workspace viewer`, and `git diff --check` passed; checked smoke ports were clear afterward.
  - Evidence: after the direct native import tranche, `node --check desktop/src/main.mjs desktop/src/preload.cjs desktop/scripts/ui-import-smoke.mjs`, `npm run type-check --workspace frontend`, `npm run desktop:smoke:picker-import`, `node --check desktop/src/main.mjs desktop/src/preload.cjs desktop/scripts/doctor.mjs desktop/scripts/import-smoke.mjs desktop/scripts/ui-import-smoke.mjs`, `npm run type-check`, `npm run desktop:smoke:ui-import`, `npm run desktop:smoke:import`, `npm run desktop:doctor`, `. .venv/bin/activate && python3 -m compileall backend/clinical backend/server.py backend/radsysx.py`, `. .venv/bin/activate && python3 -m pytest backend/tests/test_clinical_platform.py`, `npm run build --workspace viewer`, and `npm run desktop:smoke` passed before final hygiene; checked smoke ports were clear afterward.
  - Evidence: after the large picker payload tranche, `node --check desktop/src/main.mjs desktop/src/preload.cjs desktop/scripts/doctor.mjs desktop/scripts/import-smoke.mjs desktop/scripts/ui-import-smoke.mjs`, `npm run type-check`, `. .venv/bin/activate && python3 -m compileall backend/clinical backend/server.py backend/radsysx.py`, `. .venv/bin/activate && python3 -m pytest backend/tests/test_clinical_platform.py`, `npm run build --workspace viewer`, `npm run desktop:doctor`, `npm run desktop:smoke`, `npm run desktop:smoke:import`, `npm run desktop:smoke:picker-large-import`, `npm run desktop:smoke:picker-import`, `npm run desktop:smoke:ui-import`, and `git diff --check` passed; checked smoke ports were clear afterward.
  - Evidence: a parallel rerun of two desktop UI smokes was discarded because those scripts share default high ports; final verification reran all affected UI smokes sequentially.
  - Evidence: after the many-file picker tranche, `node --check desktop/src/main.mjs desktop/src/preload.cjs desktop/scripts/doctor.mjs desktop/scripts/import-smoke.mjs desktop/scripts/ui-import-smoke.mjs`, `npm run type-check`, `. .venv/bin/activate && python3 -m compileall backend/clinical backend/server.py backend/radsysx.py`, `. .venv/bin/activate && python3 -m pytest backend/tests/test_clinical_platform.py`, `npm run build --workspace viewer`, `npm run desktop:smoke:picker-many-import`, `npm run desktop:smoke:ui-import`, `npm run desktop:smoke:import`, `npm run desktop:smoke`, and `npm run desktop:doctor` passed before final hygiene. At that point `npm run desktop:smoke:ui-import` still printed one recoverable local Next.js dev chunk proxy parse warning while completing successfully; the later production-frontend tranche below removes that warning from the normal desktop path.
  - Evidence: after the production desktop frontend tranche, `npm run build --workspace frontend` passed after wrapping `/login` search-param usage in a Suspense boundary; `npm run desktop:smoke` launched the Node standalone frontend server; `npm run desktop:smoke:ui-import` and `npm run desktop:smoke:picker-many-import` passed through the production standalone frontend shell without the previous Next.js dev chunk proxy warning.
  - Evidence: final verification for this tranche passed `node --check` on `desktop/src/main.mjs`, `desktop/src/preload.cjs`, `desktop/scripts/dev-frontend.mjs`, `desktop/scripts/startup-smoke.mjs`, `desktop/scripts/doctor.mjs`, `desktop/scripts/import-smoke.mjs`, and `desktop/scripts/ui-import-smoke.mjs`; `npm run type-check`; `npm run build --workspace frontend`; `. .venv/bin/activate && python3 -m compileall backend/clinical backend/server.py backend/radsysx.py`; `. .venv/bin/activate && python3 -m pytest backend/tests/test_clinical_platform.py`; `npm run build --workspace viewer`; `npm run desktop:doctor`; `npm run desktop:smoke`; `npm run desktop:smoke:import`; `npm run desktop:smoke:ui-import`; `npm run desktop:smoke:picker-import`; `npm run desktop:smoke:picker-large-import`; `npm run desktop:smoke:picker-many-import`; and `git diff --check`. Checked smoke ports were clear afterward. The desktop smokes launched the Node standalone frontend server in normal mode and did not reproduce the old Next.js dev chunk proxy parse warning.
  - Evidence: after the multi-study DICOMDIR tranche, `. .venv/bin/activate && python3 -m pytest backend/tests/test_clinical_platform.py -k "dicomdir or local_dicomweb"` passed with 3 selected tests, including the new media-root DICOMDIR fixture that references two different study UIDs.
  - Evidence: final verification for the multi-study DICOMDIR tranche passed `. .venv/bin/activate && python3 -m compileall backend/clinical backend/server.py backend/radsysx.py`; `. .venv/bin/activate && python3 -m pytest backend/tests/test_clinical_platform.py` with 27 tests; `npm run desktop:smoke:import`; `npm run desktop:smoke:picker-many-import`; `npm run desktop:doctor`; and `git diff --check`. Checked smoke ports were clear afterward.
  - Evidence: after the viewer-launch smoke tranche, individual `node --check` invocations for `desktop/src/main.mjs` and `desktop/scripts/ui-import-smoke.mjs`, `npm run type-check --workspace frontend`, `npm run desktop:smoke:viewer-launch`, `npm run desktop:doctor`, `npm run desktop:smoke:ui-import`, and `git diff --check` passed before final hygiene. The current viewer-launch fixture imports 6 local files into 2 local studies, opens `/viewer/`, resolves the launch to the imported DICOM study, verifies local DICOMweb roots, queries `/dicom-web/studies` and `/api/studies/{studyUid}/workspace` from the viewer origin, and observes no backend access-log query string output after disabling Electron-supervised uvicorn access logs.
  - Evidence: after the viewer canvas assertion tranche, `node --check desktop/scripts/ui-import-smoke.mjs`, `npm run desktop:smoke:viewer-launch`, and `git diff --check` passed. The viewer-launch smoke passed with a 1137 x 912 OHIF canvas, one nonblank sampled canvas, 2304 nonblack sampled pixels, and max sampled pixel value 130 for the synthetic imported DICOM.
  - Evidence: after the cross-platform bootstrap tranche, `node --check desktop/scripts/bootstrap.mjs`, `node --check desktop/scripts/doctor.mjs`, `npm run desktop:bootstrap -- --check`, `npm run bootstrap --workspace @radsysx/desktop -- --check`, `npm run desktop:doctor`, `npm run desktop:smoke`, and `git diff --check` passed before final hygiene.
  - Evidence: after the TIFF preview tranche, `node --check desktop/scripts/import-smoke.mjs`, `node --check desktop/scripts/ui-import-smoke.mjs`, `. .venv/bin/activate && python3 -m compileall backend/clinical backend/server.py backend/radsysx.py`, `. .venv/bin/activate && python3 -m pytest backend/tests/test_clinical_platform.py`, `npm run desktop:smoke:import`, `npm run desktop:smoke:ui-import`, `npm run desktop:smoke:picker-import`, `npm run desktop:smoke:viewer-launch`, `npm run desktop:doctor`, and `git diff --check` passed. The desktop import/UI/picker/viewer smokes imported 6 local files into 2 local studies and the NIFTI/image study contained 4 assets with PNG and TIFF fallbacks.
  - Evidence: continuation verification after the TIFF preview commit also passed `npm run desktop:smoke:picker-large-import` with `Imported 7 files into 2 local studies` and `previewCount: 5`, then `npm run desktop:smoke:picker-many-import` with `Imported 38 files into 2 local studies`, a 34-file DICOM/DICOMDIR row, a 4-file NIFTI/PNG/TIFF row, and `previewCount: 4`.
  - Evidence: after the native file-picker smoke tranche, `node --check desktop/scripts/ui-import-smoke.mjs`, `node --check desktop/src/main.mjs`, `npm run desktop:smoke:picker-files-import`, `npm run desktop:smoke:picker-import`, and `git diff --check` passed before final hygiene. The new file-picker smoke clicked the hydrated `Import files` button, used smoke-injected individual file paths, imported 6 files into 2 local studies, and reported `previewCount: 4`; the folder-picker regression smoke still imported 6 files into 2 local studies and reported `previewCount: 4`.
  - Evidence: after the JPEG fallback tranche, `node --check desktop/scripts/import-smoke.mjs`, `node --check desktop/scripts/ui-import-smoke.mjs`, `. .venv/bin/activate && python3 -m compileall backend/clinical backend/server.py backend/radsysx.py`, `. .venv/bin/activate && python3 -m pytest backend/tests/test_clinical_platform.py`, `npm run desktop:smoke:import`, `npm run desktop:smoke:ui-import`, `npm run desktop:smoke:picker-files-import`, `npm run desktop:smoke:picker-import`, `npm run desktop:smoke:picker-large-import`, `npm run desktop:smoke:picker-many-import`, and `npm run desktop:smoke:viewer-launch` passed before final hygiene. The API desktop smoke imported 7 local files into 2 studies and the NIFTI/image study contained `jpeg`, `nifti`, `png`, and `tiff` formats with 5 assets. Hydrated drag/drop, file picker, folder picker, and viewer-launch smokes imported 7 files into 2 studies and reported `previewCount: 5`; the large picker smoke imported 8 files and reported `previewCount: 6`; the many-file picker smoke imported 39 files, kept the DICOM/DICOMDIR row at 34 files, and reported `previewCount: 5`. Viewer launch still resolved the imported DICOM study under `/viewer/`, used same-origin local DICOMweb roots, and observed one nonblank OHIF canvas.
  - Evidence: after the paired NIFTI `.hdr/.img` tranche, `node --check desktop/src/main.mjs`, `node --check desktop/scripts/import-smoke.mjs`, `node --check desktop/scripts/ui-import-smoke.mjs`, `. .venv/bin/activate && python3 -m compileall backend/clinical backend/server.py backend/radsysx.py`, `. .venv/bin/activate && python3 -m pytest backend/tests/test_clinical_platform.py`, `npm run type-check --workspace frontend`, `npm run desktop:smoke:import`, `npm run desktop:smoke:ui-import`, `npm run desktop:smoke:picker-files-import`, `npm run desktop:smoke:picker-import`, `npm run desktop:smoke:picker-large-import`, `npm run desktop:smoke:picker-many-import`, `npm run desktop:smoke:viewer-launch`, `npm run desktop:doctor`, and `git diff --check` passed before final hygiene. The API smoke imported 9 local files into 2 studies, including `jpeg`, `nifti`, `nifti-data`, `png`, and `tiff` formats with 7 NIFTI/image assets and a paired-data finding. Hydrated drag/drop, file picker, folder picker, and viewer-launch smokes imported 9 files into 2 studies and reported `previewCount: 6`; large picker imported 10 files and reported `previewCount: 7`; many-file picker imported 41 files, kept the DICOM/DICOMDIR row at 34 files, and reported `previewCount: 6`. Viewer launch still resolved the imported DICOM study under `/viewer/`, used same-origin local DICOMweb roots, and observed one nonblank OHIF canvas.
  - Evidence: after the ZIP archive import tranche, `node --check desktop/src/main.mjs && node --check desktop/scripts/import-smoke.mjs && node --check desktop/scripts/ui-import-smoke.mjs`, `. .venv/bin/activate && python3 -m compileall backend/clinical backend/server.py backend/radsysx.py`, `. .venv/bin/activate && python3 -m pytest backend/tests/test_clinical_platform.py` with 29 tests, `npm run type-check --workspace frontend`, `npm run desktop:smoke:import`, `npm run desktop:smoke:ui-import`, `npm run desktop:smoke:picker-files-import`, `npm run desktop:smoke:picker-import`, `npm run desktop:smoke:picker-large-import`, `npm run desktop:smoke:picker-many-import`, `npm run desktop:smoke:viewer-launch`, `npm run desktop:doctor`, `npm run desktop:smoke`, and `git diff --check` passed before final hygiene. The API smoke imported 11 accepted files into 2 studies after expanding `archive.zip`, returned `Expanded archive archive.zip into 2 file(s).`, and the NIFTI/image row contained 9 assets including ZIP-expanded NIFTI/PNG. Hydrated drag/drop, file picker, folder picker, and viewer-launch smokes imported 11 accepted files into 2 studies and reported `previewCount: 8`; large picker imported 12 accepted files and reported `previewCount: 9`; many-file picker imported 43 accepted files, kept the DICOM/DICOMDIR row at 34 files, kept the NIFTI/image row at 9 files, and reported `previewCount: 8`. Viewer launch still resolved the imported DICOM study under `/viewer/`, used same-origin local DICOMweb roots, and observed one nonblank OHIF canvas.
  - Evidence: after the one-command desktop launcher tranche, `node --check desktop/scripts/launch.mjs`, `npm run desktop -- --check-only`, `npm run desktop:smoke:launch`, `npm run desktop:smoke:local-start`, `npm run desktop:doctor`, and `git diff --check` passed before final hygiene. The launcher check used the repo venv Python and confirmed clinical imports plus npm availability. The launcher smoke ran the user-facing bootstrap-check path, then started Electron through `desktop/scripts/launch.mjs --smoke --no-bootstrap`, built the production frontend shell, launched FastAPI, Next.js standalone, and the bridge, and reached `RadSysX desktop is ready at http://127.0.0.1:3000` before smoke shutdown. The local-start smoke then verified the visible first route was `http://127.0.0.1:37100/viewer/`, `localQueryPresent: false`, `loaderState: local-start`, `title: Open local images`, both local import buttons present, imported DICOM launch under OHIF with same-origin `/dicom-web` roots, workspace UID match, and one nonblank OHIF canvas with 2304 nonblack sampled pixels.
  - Evidence: after the same-origin desktop frontend tranche, the default Electron `sharedEnv` set `NEXT_PUBLIC_BACKEND_URL` to an empty same-origin value and `NEXT_PUBLIC_VIEWER_BASE_URL` to `/viewer` unless explicitly overridden. This keeps the production frontend build stamp independent of whichever localhost port the desktop bridge chooses, while the backend still receives absolute `RADSYSX_VIEWER_BASE_URL` and emits governed viewer launch URLs.
  - Evidence: verification for the same-origin desktop frontend tranche passed `node --check desktop/src/main.mjs`, `git diff --check`, `RADSYSX_DESKTOP_REBUILD_FRONTEND=1 npm run desktop:smoke:local-start`, and `npm run desktop:smoke:launch`. The rebuilt stamp was exactly `{"nextPublicBackendUrl":"","nextPublicViewerBaseUrl":"/viewer","nextPublicRadsysxAppMode":"pilot"}`. The local-start smoke rebuilt once, reached `http://127.0.0.1:37100/viewer/`, stripped `local`, showed `Open local images`, imported and launched the synthetic DICOM under OHIF with same-origin `/dicom-web` roots, and observed one nonblank OHIF canvas. The subsequent launcher smoke on the default desktop port logged `using existing desktop Next.js production build`, proving the production shell was reused rather than rebuilt for a different localhost port.
  - Evidence: after the NRRD and focused first-screen tranche, `node --check desktop/src/main.mjs && node --check desktop/scripts/import-smoke.mjs && node --check desktop/scripts/ui-import-smoke.mjs && node --check viewer/assets/radsysx-bootstrap.js`; `. .venv/bin/activate && python3 -m compileall backend/clinical backend/server.py backend/radsysx.py`; `. .venv/bin/activate && python3 -m pytest backend/tests/test_clinical_platform.py` with 29 tests; `npm run type-check --workspace frontend`; `npm run type-check --workspace viewer`; `npm run build --workspace viewer`; `npm run desktop:smoke:import`; `npm run desktop:smoke:local-start`; `npm run desktop:smoke:local-start-nondicom`; `npm run desktop:smoke:picker-files-import`; `npm run desktop -- --check-only`; `npm run desktop:smoke:launch`; and `git diff --check` passed. The local-start smoke saw `/viewer/`, `title: Open a local study`, `primaryLabel: Open local study`, `secondaryLabel: Choose folder`, `primaryFocused: true`, same-origin `/dicom-web`, and a nonblank OHIF canvas. The non-DICOM local-start smoke imported a 10-file NIFTI/NRRD/image row, showed NRRD asset and analysis metrics, and correctly kept `Open viewer` unavailable for that row.
  - Evidence: after the first-screen drag/drop tranche, `node --check viewer/assets/radsysx-bootstrap.js && node --check desktop/scripts/ui-import-smoke.mjs && node --check desktop/src/main.mjs`, `npm run type-check --workspace viewer`, `npm run build --workspace viewer`, `git diff --check`, `npm run desktop:smoke:local-start-drop`, and `npm run desktop:smoke:local-start` passed. The drag/drop smoke saw `/viewer/`, `title: Open a local study`, `dropState.draggingSeen: true`, `dropState.fileCount: 11`, same-origin `/dicom-web`, matching workspace UID, and one nonblank OHIF canvas. The click-path regression smoke then passed with the same first-screen state and nonblank OHIF canvas.
  - Evidence: after the standalone OHIF local-mode supersession tranche, `node --check viewer/assets/radsysx-bootstrap.js && node --check viewer/assets/radsysx-ohif-mode.js && node --check viewer/scripts/build-ohif-dist.mjs && node --check desktop/src/main.mjs && node --check desktop/scripts/ui-import-smoke.mjs`, `npm run build --workspace viewer`, `npm run desktop:smoke:local-start`, `npm run desktop:smoke:local-start-drop`, and `npm run desktop:smoke:local-start-nondicom` passed before the docs pass. The input smoke reported first URL `http://127.0.0.1:37100/viewer/local`, `loaderPresent: false`, `localViewer: true`, `launchPresent: false`, `localStartCardPresent: false`, OHIF `Load files` and `Load folders` visible, then rendered `http://127.0.0.1:37100/viewer/dicomlocal?StudyInstanceUIDs=1.2.826.0.1.3680043.10.54321.910&datasources=dicomlocal` with no workspace panel and one nonblank canvas. The drop smoke reported the same first route, `dropState.fileCount: 1`, no launch, no workspace panel, and two nonblank sampled canvases after routing to `/viewer/dicomlocal`. The non-DICOM smoke reported the same first OHIF local route, then verified `/worklist` inspection for a `Local NIFTI import (10 files)` row with NIFTI, NRRD, PNG, JPEG, TIFF, ZIP-expanded previews, coronal preview URL, and backend technical analysis.
  - Evidence: after the RadSysX title and AI sidebar tranche, `node --check viewer/assets/radsysx-bootstrap.js viewer/assets/radsysx-ohif-extension.js viewer/assets/radsysx-ohif-mode.js viewer/scripts/build-ohif-dist.mjs desktop/src/main.mjs desktop/scripts/ui-import-smoke.mjs`, `npm run build --workspace viewer`, `npm run type-check --workspace viewer`, `npm run desktop:smoke:local-start`, and `npm run desktop:smoke:local-start-drop` passed. The local-start and drop smokes reported `documentTitle: "RadSysX"`, rendered `/viewer/dicomlocal?datasources=dicomlocal` with no governed launch or workspace panel, observed one nonblank OHIF canvas, and verified the `aiChat` right-sidebar panel with `aiTabLabel: "RadSysX AI"`, composer textarea, voice button, send button, open `@` menu, ROI option, and segmentation option. The viewer build now cache-busts injected RadSysX runtime assets and the desktop bridge serves those assets with `no-store` to avoid stale OHIF extension behavior.
  - Remaining gap: native OS dialog upload smoke and full real-world viewer rendering remain open before marking complete.

If any evidence slot is missing, weak, indirect, or only proves a narrower behavior, keep the goal active.
