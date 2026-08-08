# Viewer Scripts DOX

## Purpose

- Own scripts that build the RadSysX OHIF distribution.

## Ownership

- Owns `build-ohif-dist.mjs`.

## Local Contracts

- Build script copies OHIF app dist, bundles the pinned FHIR/SMART data-source slice, copies RadSysX assets, logo, React UMD asset, and patches runtime configuration.
- Build script must cache-bust injected RadSysX runtime assets in `index.html` so Electron/Chromium does not keep stale extension, mode, bootstrap, or CSS behavior.
- Generated files belong in `viewer/dist/`.
- Do not make the build depend on machine-local paths outside the npm workspace.

## Work Guidance

- Keep script errors explicit when required assets or dependencies are missing.
- If runtime assets change, ensure the build still copies them into `dist/`.
- Keep the vendored FHIR bundle's upstream commit and license explicit; do not fetch moving GitHub state during a normal build.

## Verification

- `npm run build --workspace viewer`
- `npm run test:fhir-bridge --workspace viewer`

## Child DOX Index
