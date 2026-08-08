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
- The RadSysX AI right-sidebar panel is voice-first and backend-bound when an authenticated backend session is available. It may call `/api/ai/sidebar/capabilities`, `/api/ai/sidebar/sessions`, and `/api/ai/sidebar/sessions/{sessionId}/messages`; those endpoints are deterministic orchestration stubs, not real model inference, diagnostic output, report persistence, or DICOM SEG persistence. The panel must keep a local fallback for standalone or unauthenticated runtimes, preserve the bottom text composer, and keep ROI/segmentation/measurement chips available through `@`.
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
- `npm run desktop:smoke:local-start`
- `npm run desktop:smoke:local-start-drop`
- `npm run desktop:smoke:local-start-nondicom`

## Child DOX Index
