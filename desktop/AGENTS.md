# Desktop DOX

## Purpose

- Own the RadSysX Electron fast path for local, no-Docker startup.
- Provide a friendly desktop entry point that starts the local FastAPI backend, Next.js shell, and OHIF viewer bridge under one localhost origin.
- Enable the backend-owned local imaging import path for no-Docker DICOM/DICOMDIR/NIFTI/NRRD/fallback-file ingestion.

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
- The local bridge must proxy Next.js development static assets and WebSocket upgrades reliably enough for the Electron shell to hydrate through the one-origin desktop URL.
- The bridge may use tolerant HTTP parsing only for trusted loopback upstreams that the desktop runtime starts itself; do not apply parser leniency to arbitrary remote archive targets.
- Do not add PHI-bearing launch context to desktop URLs.
- Do not let the browser write directly to Orthanc; backend-mediated derived result paths remain authoritative.
- A missing local DICOMweb archive should degrade honestly. Full Orthanc-backed image retrieval remains the compose-stack path until a local archive bundle is added.
- Desktop sets `RADSYSX_LOCAL_IMAGING_ENABLED=true` and stores local imports in an ignored repo-local backend data directory unless overridden.
- When `RADSYSX_DESKTOP_DICOMWEB_TARGET` is unset, the desktop bridge routes `/dicom-web` to the backend's local DICOMweb endpoints for imported DICOM studies.
- The Electron-supervised backend runs uvicorn without access logs so local DICOMweb query strings and workspace URLs are not casually printed during desktop use or smoke tests.
- `preload.cjs` exposes only narrow desktop helpers, including native local imaging file/folder selection and the preferred direct desktop import bridge; browser drag-and-drop remains a portable frontend fallback and must still import through backend contracts. Do not expose raw filesystem or shell primitives to the renderer.
- The preferred native desktop import path should keep selected file paths and file bytes in Electron main, attach the existing backend-issued session cookie from the Electron cookie jar, and POST multipart data to `POST /api/local-imaging/import` through the one-origin desktop bridge.
- The legacy `selectLocalImagingFiles` helper may remain as a compatibility fallback, but normal desktop worklist imports should prefer `importLocalImaging` so large folders do not need to cross renderer IPC as ArrayBuffers.
- The desktop native picker must admit extensionless non-hidden files as DICOM candidates, paired NIFTI `.hdr/.img` files, NRRD `.nrrd` files, and `.zip` archives so DICOMDIR companions, paired voxel data, segmentation/labelmap volumes, and bundled local studies can reach backend format detection/linking; unsupported candidates are still rejected by the backend import contract.
- `RADSYSX_DESKTOP_ALLOW_TEST_SHUTDOWN=1` enables the local `/_radsysx/desktop/shutdown` endpoint for smoke tests only; do not enable it for normal desktop runs.
- `RADSYSX_DESKTOP_PICKER_TEST_PATHS` may be honored only when `RADSYSX_DESKTOP_ALLOW_TEST_SHUTDOWN=1`; it is a smoke-only native picker bridge override, not a normal desktop runtime feature.
- `RADSYSX_DESKTOP_PYTHON` may point the desktop runtime/bootstrap/smoke scripts at a specific Python executable; otherwise they use `PYTHON`, then the platform-correct repo-local venv Python, then a platform default (`python` on Windows, `python3` elsewhere).
- `RADSYSX_DESKTOP_EXIT_AFTER_READY_MS` should schedule smoke shutdown immediately after internal services report ready, before waiting on the final app URL load, so startup smokes cannot hang behind slow dev-shell navigation; scheduled startup-smoke teardown may suppress transient loopback Next.js dev asset parse noise.
- `npm run desktop:smoke:launch` should keep proving the same user-facing launcher contract as `npm run desktop`: bootstrap check first, then service-ready Electron startup with the OHIF-first default retained, with `--smoke` setting a cross-platform startup shutdown timer. `npm run desktop:smoke:local-start` remains the smoke that samples the first-screen OHIF standalone local UI.
- `npm run desktop:smoke:import` should keep proving local DICOMDIR/DICOM/NIFTI `.nii`/`.nii.gz`/paired `.hdr+.img`, NRRD `.nrrd`, ZIP archives containing supported files, plus PNG/JPEG/TIFF import, asset summaries, local previews including NIFTI slice navigation, JPEG byte preview retrieval, TIFF SVG header preview, NRRD technical analysis, DICOMweb discovery, and opaque launch without Docker.
- `npm run desktop:smoke:local-start` should keep proving Electron opens first into `/viewer/local`, has no RadSysX bootstrap card, has no governed launch context, exposes OHIF's local file/folder controls, keeps the document title as `RadSysX`, loads a synthetic DICOM through OHIF's local file input, routes to `/viewer/dicomlocal?datasources=dicomlocal`, suppresses the clinical workspace panel, paints a nonblank OHIF canvas, and exposes the voice-first RadSysX AI right-sidebar composer with text, primary voice, backend-bound session state, and `@` ROI/segmentation attachment controls.
- `npm run desktop:smoke:local-start-drop` should keep proving the same first OHIF local screen accepts dropped DICOM files directly, forwards the drop to OHIF's local file input, routes to `/viewer/dicomlocal?datasources=dicomlocal`, avoids a governed launch, paints a nonblank OHIF canvas, and exposes the same voice-first RadSysX AI composer.
- `npm run desktop:smoke:local-start-nondicom` should keep proving Electron still opens first into `/viewer/local` and that NIFTI/NRRD/image/ZIP fixtures remain usable through `/worklist` inspection, local previews, NIFTI axis switching, and backend technical analysis without exposing an OHIF viewer action.
- `npm run desktop:smoke:ui-import` should keep proving the hydrated worklist UI can import dropped local imaging files, inspect imported assets including PNG/JPEG/TIFF fallback images, change NIFTI preview slices, and run backend technical analysis without Docker.
- `npm run desktop:smoke:picker-files-import` should keep proving the hydrated worklist UI can invoke the `Import files` action through the Electron native picker bridge, pass smoke-injected individual file paths through `preload.cjs`, upload selected files from Electron main to the backend import endpoint, inspect imported assets, change NIFTI preview slices, and run backend technical analysis without Docker.
- `npm run desktop:smoke:picker-import` should keep proving the hydrated worklist UI can invoke the Electron native folder picker bridge through `preload.cjs`, read a selected folder through the main-process recursive collector, upload selected files from Electron main to the backend import endpoint, inspect imported assets, change NIFTI preview slices, and run backend technical analysis without Docker. This does not replace a human or OS-automation smoke of the actual native dialog.
- `npm run desktop:smoke:picker-large-import` should keep proving the same direct native picker import path with an additional 8 MiB synthetic NIFTI volume, including backend asset summary, preview, and technical analysis checks.
- `npm run desktop:smoke:picker-many-import` should keep proving the same direct native picker import path with a nested folder of 32 additional extensionless DICOM instances, including recursive folder collection, backend import of 44 accepted files after ZIP expansion, DICOM asset summary, and technical analysis checks.
- `npm run desktop:smoke:viewer-launch` should keep proving the hydrated worklist can import a local DICOM/DICOMDIR study, launch it through the governed viewer path, resolve the opaque launch in `/viewer/`, strip the launch token from the browser URL, bind OHIF runtime configuration to same-origin local DICOMweb roots, query the imported study from the viewer origin, and paint a nonblank OHIF canvas for the synthetic imported DICOM.
- Desktop UI smokes force-refresh the frontend production shell by default so smoke assertions always exercise the current source tree, not a stale stamped build.
- `npm run desktop:bootstrap` is a Node-based cross-platform bootstrap helper, not a POSIX shell activation chain; it creates/uses `.venv`, installs clinical Python requirements with the venv Python, runs workspace `npm install --legacy-peer-deps`, and then runs desktop doctor. `npm run desktop:bootstrap -- --check` verifies an existing bootstrap without reinstalling dependencies.
- Run desktop UI smoke commands sequentially unless their ports are explicitly overridden; by default they share fixed high ports for Electron, the bridge, Next.js, and FastAPI.

## Work Guidance

- Prefer Node built-ins for process supervision and local proxying unless a dependency removes meaningful complexity.
- Keep startup errors actionable for non-specialist local users.
- Use repo-local `.venv` and workspace-managed npm dependencies.
- Preserve Linux-native commands in docs and scripts.

## Verification

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
