# Viewer Assets DOX

## Purpose

- Own RadSysX runtime assets injected into the OHIF distribution.

## Ownership

- Owns `radsysx-bootstrap.js`, `radsysx-fhir-extension.js`, `radsysx-ohif-extension.js`, `radsysx-ohif-mode.js`, and `radsysx-viewer.css`.

## Local Contracts

- Bootstrap must require a governed launch session for governed viewer URLs, resolve it through `/api/imaging/launch/resolve`, and strip sensitive launch query parameters.
- The no-launch exception is standalone local OHIF mode: `/viewer/local` and `/viewer/dicomlocal` must render without a governed launch, suppress the clinical workspace panel, register OHIF's `dicomlocal` data source, keep `/viewer` as the router base on subroutes, and let local DICOM files load directly into OHIF. Legacy `/viewer/?local=1` should be treated as a compatibility entry and redirected into `/viewer/local`, not shown as an intermediate RadSysX card.
- The other no-RadSysX-launch exception is `/viewer/fhir-viewer`: preserve standard SMART launch/callback parameters for the FHIR data source, never reinterpret SMART `launch` as a RadSysX launch token, and never accept patient identifiers or access tokens as viewer URL context.
- Standalone local drop handling may forward file drops to OHIF's local file input, but it must not create a governed launch or expose PHI-bearing study context in the URL. Non-DICOM local assets remain a backend/worklist inspection path until OHIF-native rendering for those formats is implemented.
- The viewer must keep the visible app/document title as `RadSysX`.
- The RadSysX AI sidebar is owned by typed `live/` modules, bundled before `radsysx-ohif-extension.js`. The extension passes its runtime OHIF managers through `window.__RADSYSX_OHIF_MANAGERS__` and the `radsysx-ohif-ready` event. The controller survives panel remounts; `radsysx-ohif-exit` ends its active call.
- The backend provider catalog populates an explicit Gemini/OpenAI selector. Disclosure follows the selected provider; provider changes end the previous session, stop media, and reset data attestation.
- The sidebar uses same-origin `/api/ai/sidebar/*` and its Live WebSocket. Require explicit synthetic/deidentified attestation before connecting, provider `ready` before sending media, and separate user controls for microphone and active-image sharing. Keep the composer draft usable while unavailable. Do not claim the legacy `/messages` stub is model inference.
- Attachments must resolve actual OHIF measurements/ROIs or loaded segmentations. Never fabricate attachment chips. Local report drafts are visibly unsaved; durable saves require a backend-associated study and reviewed backend tool approval.
- Restrict automated actions to the typed semantic OHIF adapter. Never expose arbitrary JavaScript, DOM selectors, commands, paths, browser STOW, patient metadata, or provider credentials to a model.

- Runtime DICOMweb roots must come from backend `viewerRuntime`.
- Workspace panels must use backend clinical endpoints for reports, AI jobs, derived results, workspace refresh, and audit.
- Direct browser STOW to Orthanc must remain disabled unless the governed backend contract explicitly changes.

## Work Guidance

- Keep global `window.__RADSYSX_*` usage deliberate and documented by nearby code.
- Keep UI resilient to missing launch/session/workspace state.
- Avoid storing PHI or launch context beyond what is required to survive login redirects.

## Verification

- `npm run type-check --workspace viewer`
- `npm run build --workspace viewer`
- `npm run test:fhir-bridge --workspace viewer`
- `npm run test:live --workspace viewer`
- `npm run desktop:smoke:local-start`
- `npm run desktop:smoke:local-start-drop`
- `npm run desktop:smoke:local-start-nondicom`

## Child DOX Index

- `viewer/assets/live/AGENTS.md`: typed Live controller, PCM media, semantic OHIF adapter, and sidebar.

- The live sidebar uses compact connection/media controls and a Settings overlay containing account-owned research provider/model dropdowns and API-key inputs. Keep CSS aligned with the typed panel and its hidden-state contract; media controls do not occupy space before connection.
- Evidence review styles belong inside the existing scrollable research card. No additional permanent header region; checkbox/select controls, long hashes/source text and receipts must fit the 280 px sidebar without horizontal overflow.
