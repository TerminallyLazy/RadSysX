# Clinical Web Package DOX

## Purpose

- Own shared TypeScript contracts, clinical API client, and env helpers consumed by the Next.js shell and OHIF viewer.

## Ownership

- Owns `package.json` and `src/client.ts`, `src/contracts.ts`, `src/env.ts`, `src/index.ts`.

## Local Contracts

- `src/contracts.ts` must mirror the backend clinical contract models in `backend/clinical/contracts.py`.
- `src/client.ts` should call governed backend endpoints with cookies included and should not invent browser-local clinical state.
- `src/client.ts` owns the browser client for backend local imaging import, imported-study asset summaries/previews/preview controls/technical analysis, API URL resolution, and relative-path preservation for folder/DICOMDIR uploads from browser `webkitRelativePath` and Electron `radsysxRelativePath`.
- `src/client.ts` owns the shared browser client methods for the backend-bound AI sidebar capability/session/message stub contracts.
- `src/client.ts` may also expose explicitly optional research/demo endpoints, such as the BioMedParse integration demo capability/run calls, when the backend keeps them session-protected and opt-in.
- `src/env.ts` owns app mode, backend base URL, viewer base URL, and experimental imaging flags shared by browser surfaces; public `NEXT_PUBLIC_*` reads must use direct guarded env keys so Next.js can inline them consistently across server and client hydration.
- Keep exports stable for both `frontend` and `viewer` workspaces.

## Work Guidance

- Update this package when a clinical endpoint request/response shape changes.
- Keep error handling clear and avoid swallowing backend contract failures.
- Keep browser code free of Node-only APIs unless guarded.

## Verification

- `npm run type-check --workspace frontend`
- `npm run type-check --workspace viewer`

## Child DOX Index
