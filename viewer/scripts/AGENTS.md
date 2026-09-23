# Viewer Scripts DOX

## Purpose

- Own scripts that build the RadSysX OHIF distribution.

## Ownership

- Owns OHIF/FHIR build scripts plus `build-live.mjs`, `live-contracts.ts`, and `test-live.mjs`.

## Local Contracts

- Build script rebuilds the pinned OHIF source distribution, bundles the pinned FHIR/SMART data-source slice, copies RadSysX assets, logo, React UMD asset, and patches runtime configuration.
- Build script must cache-bust injected RadSysX runtime assets in `index.html` so Electron/Chromium does not keep stale extension, mode, bootstrap, or CSS behavior.
- `build-live.mjs` compiles strict TypeScript and checks structural compatibility with `@radsysx/clinical-web`, bundles the persistent Live controller as `radsysx-live.js`, and emits `radsysx-audio-worklet.js`. Both outputs participate in injected asset cache busting. Intermediate output stays under ignored `.cache/live-runtime/`.
- Generated files belong in `viewer/dist/`.
- Do not make the build depend on machine-local paths outside the npm workspace.

## Work Guidance

- Keep script errors explicit when required assets or dependencies are missing.
- If runtime assets change, ensure the build still copies them into `dist/`.
- Keep the vendored FHIR bundle's upstream commit and license explicit; do not fetch moving GitHub state during a normal build.

## Verification

- `npm run build --workspace viewer`
- `npm run test:fhir-bridge --workspace viewer`
- `npm run test:live --workspace viewer` (fake runtime, media codec/queue, lifecycle and semantic adapter checks; does not establish real provider or hardware audio acceptance). Audio regressions cover a 45-second burst at the original rate, draining/reuse, audible interruption receipts and duration/source-count limits checked before allocation.

## Child DOX Index

## Security build inputs

- `build-ohif-source.mjs` checks the pinned upstream commit, applies the reviewed source patch, installs the frozen `ohif-build/pnpm-lock.yaml` with dependency lifecycle scripts disabled, and runs the production Rspack build.
- `build-ohif-dist.mjs` packages this rebuilt output, then applies the RadSysX assets/configuration patches. Never silently copy the upstream prebuilt npm dist.
- The cache fingerprint includes the source-build script, pinned input files, viewer manifest, and root lockfile. Desktop checks the same fingerprint.
- Audit with `npm run audit:ohif --workspace viewer`; keep all advisory severities enabled.

- `test-security-dependencies.mjs` checks actual resolved query-string behavior, the validation ReDoS fix, absence of the retired OIDC asset, and generated build provenance.

- Live tests cover research-selection save/attestation boundaries, stale catalog response suppression, preserved selection on catalog failure, and credential changes updating research availability without replacing a pending dropdown selection. Shared compile checks include research settings and catalog response shapes.
- Shared compile assertions also cover bidirectional evidence-review detail/start/retry/availability shapes. Their independent HTTP contract never modifies the live conversation protocol.
- `test:live` compiles once and runs both `test-live.mjs` and `test-evidence.mjs`. Review tests use synthetic wire fixtures and mock timers to prove confirmation/selection, stable uncertain idempotency, old-response rejection, bounded polling, no inference on reopen/refresh and escaped abstract-scoped presentation. The guarded Electron smoke owns actual DOM/focus/layout acceptance.

- Research presentation checks distinguish model waiting, PubMed search and terminal timeout/cancellation; recorded model identity must remain unknown when absent. Ending-session tests require backend terminal receipts or explicit unconfirmed status, never a stale running card.

- Text-controller regressions prove Send/Research without voice or audio allocation, preserved draft/operation identity on uncertain submission, and stale polling rejection after End. Keep these separate from actual hosted-model acceptance.
