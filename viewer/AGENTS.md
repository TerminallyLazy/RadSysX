# Viewer DOX

## Purpose

- Own the dedicated OHIF-based clinical viewer app.

## Ownership

- Owns `package.json`, `tsconfig.json`, generated `dist/`, viewer scripts, and RadSysX viewer runtime assets.
- Child docs own build scripts and runtime asset contracts.

## Local Contracts

- The clinical public `/viewer` route is served from this app, usually through nginx at `http://localhost:3000/viewer/`.
- Do not add or rely on a Next.js clinical `/viewer` fallback.
- `dist/` is generated output from `npm run build --workspace viewer`; do not hand-edit generated bundles for durable behavior.
- Governed viewer runtime must resolve opaque launch sessions through the backend and bind OHIF to returned same-origin DICOMweb roots. Standalone desktop/local OHIF routes may use OHIF's `dicomlocal` data source without a governed launch.
- `/viewer/fhir-viewer` is the standalone SMART on FHIR route. It uses the pinned FHIR R4 data source, keeps SMART launch handling separate from RadSysX opaque launches, and must not imply governed report, audit, derived-result, or STOW behavior.
- RadSysX report, AI, derived-result, and audit UI belongs in the OHIF extension/mode assets or backend contracts, not an ad hoc sidecar. The AI sidebar may keep local fallback state, but authenticated voice/composer turns should bind through explicit backend contracts before claiming backend AI execution.

## Work Guidance

- Keep bootstrap minimal and move durable workflow behavior into extension, mode, service, or backend seams when possible.
- Preserve OHIF and Cornerstone as the clinical rendering/tooling substrate.
- Never expose PHI-bearing launch context in URLs.

## Verification

- `npm run type-check --workspace viewer`
- `npm run build --workspace viewer`
- `npm run test:fhir-bridge --workspace viewer`
- For governed flow, validate through `http://localhost:3000/viewer/` in the composed stack rather than raw port `3001`.

## Child DOX Index

- `viewer/assets/AGENTS.md`: RadSysX OHIF bootstrap, extension, mode, and CSS assets.
- `viewer/scripts/AGENTS.md`: OHIF dist build wrapper.
