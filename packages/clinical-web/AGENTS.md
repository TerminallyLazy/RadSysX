# Clinical Web Package DOX

## Purpose

- Own shared TypeScript contracts, clinical API client, and env helpers consumed by the Next.js shell and OHIF viewer.

## Ownership

- Owns `package.json` and `src/client.ts`, `src/contracts.ts`, `src/env.ts`, `src/index.ts`, and `src/ai-live.ts`.

## Local Contracts

- `src/contracts.ts` must mirror the backend clinical contract models in `backend/clinical/contracts.py`.
- `src/client.ts` should call governed backend endpoints with cookies included and should not invent browser-local clinical state.
- `src/client.ts` owns the browser client for backend local imaging import, imported-study asset summaries/previews/preview controls/technical analysis, API URL resolution, and relative-path preservation for folder/DICOMDIR uploads from browser `webkitRelativePath` and Electron `radsysxRelativePath`.
- `src/client.ts` owns the shared browser client methods for the owned AI sidebar session/capability/history/context/approval/cancel contracts and typed Live media/event envelopes.
- AI capabilities expose an allowlisted provider catalog and readiness; session creation can select `gemini` or `openai`. Persisted sessions return the exact model, provider and fixed audio rates. `ai-live.ts` includes transient audio-chunk markers and actual-playback stop receipts; provider endpoint/configuration remains backend-owned.
- API-key settings use authenticated `/api/ai/sidebar/credentials` status and write-only PUT/DELETE provider endpoints. Status contains only configured/source/environmentConfigured flags; no key value or fragment may return to a browser. A user-entered key is transient request input only, never browser storage, model context, history or error text. Use fixed client errors on credential requests to prevent upstream error bodies from reflecting keys. The backend owns encrypted per-user persistence, effective provider selection and session invalidation on change.
- `screen_sharing` controls explicit image forwarding; transient `screen_status` reports active sharing and first-frame delivery. These controls describe the selected viewport, not whole-desktop access, and their receipts do not enter durable history.
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

- `AIResearchSettings` and `AIResearchModels` mirror authenticated research preferences/catalog endpoints. `getAIResearchSettings`, `getAIResearchModels` and `saveAIResearchSettings` carry cookies and no-store requests; signed owner identity is never supplied by the browser. Provider/model selection is backend-persisted, with full catalog IDs and explicit capability-verification status.
- `Evidence*` DTOs mirror `backend/clinical/ai_evidence_contracts.py`. Explicit prepare/list/detail/start/retry/cancel methods use signed cookies, no-store and fixed errors; only GET detail accepts a polling abort signal. Claim IDs and preview hashes refer to backend-frozen text, not browser-provided evidence. `AISidebarCapabilities.evidenceReview` reports configuration separately from saved completion receipts.
