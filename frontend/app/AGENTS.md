# Frontend App Routes DOX

## Purpose

- Own Next.js route files for the RadSysX shell.

## Ownership

- Owns `layout.tsx`, `page.tsx`, `login/`, `worklist/`, route assets, and child route handlers under `api/`.

## Local Contracts

- `/login` establishes local seeded clinical sessions through the backend.
- `/worklist` is the clinical launch surface and must create opaque imaging launch sessions through the backend.
- `/worklist` may expose local imaging import and imported-study inspection/analysis controls when backend platform config enables them; native picker, browser input, drag-and-drop imports, ZIP archive submissions, asset summaries, technical analysis, NIFTI slice navigation including paired `.hdr/.img`, NRRD analysis, and preview thumbnails must go through the backend local imaging contract.
- In Electron, `/worklist` should prefer `window.radsysxDesktop.importLocalImaging` for native file/folder imports so selected paths and bytes stay in Electron main and upload directly to the backend local imaging import contract with the backend-issued session cookie.
- `/worklist` may consume `sessionStorage["radsysx.localStart.inspectStudyUid"]` set by the Electron OHIF local-start screen so non-DICOM local imports can fall back into the existing local asset inspection panel without adding a Next.js `/viewer` fallback.
- `/worklist` may show the BioMedParse integration demo panel only when the backend capability endpoint reports `RADSYSX_BIOMEDPARSE_DEMO_ENABLED=1`. This panel must remain a research/demo preview artifact path, not a clinical DICOM SEG persistence path.
- `window.radsysxDesktop.selectLocalImagingFiles` may remain a compatibility fallback, but should not be the normal native desktop path for larger imaging folders because it returns selected file bytes through renderer IPC.
- Browser drag-and-drop may recurse through Chromium directory entries and preserve relative paths as `radsysxRelativePath`; never preserve absolute local paths or route dropped bytes through research-only upload handlers.
- `/` may help select or explain surfaces, but must not become a clinical viewer runtime.
- Do not add a Next.js `/viewer` route for clinical fallback.
- Route copy and behavior must preserve the distinction between research and governed clinical modes.

## Work Guidance

- Redirect unauthenticated clinical users to `/login` through backend session checks.
- Keep worklist launch URLs opaque and backend-issued.
- Keep client-side state secondary to backend contracts.

## Verification

- `npm run type-check --workspace frontend`
- `npm run desktop:smoke:local-start-nondicom` when changing the worklist auto-inspection fallback from the OHIF local-start screen.

## Child DOX Index

- `frontend/app/api/AGENTS.md`: research-only Next route handlers.
