# OHIF Source Build DOX

## Purpose and ownership

Own the pinned OHIF source-build inputs: upstream commit, source patch, pnpm workspace policy, and frozen lockfile. The root npm workspace remains authoritative for RadSysX packages; this separate lockfile belongs only to the upstream OHIF build.

## Contracts

- Keep the OHIF version aligned with `viewer/package.json`.
- Build browser code from the pinned source with the patched dependencies; never fall back to the npm package's prebuilt `dist`.
- No advisory suppressions. Exclude upstream documentation, CLI, Cypress, and rsbuild tooling that the production Rspack build does not use.
- Keep replacements explicit: `validate.js` uses the Social Tables security fork, and the ITK download utility uses the maintained XhmikosR decompressor.
- Changes to any input invalidate the generated source cache and the desktop viewer build.
- Regenerate the lockfile in the prepared source checkout, then copy it here and audit before committing. Do not edit lockfile versions by hand.

## Verification

- `npm run build --workspace viewer`
- `npm run audit:ohif --workspace viewer`
- `npm run test:fhir-bridge --workspace viewer`
- `npm run desktop:smoke:local-start`

- OHIF OIDC uses `oidc-client-ts` authorization-code flow with PKCE. Never ship the old `oidc-client.min.js` asset or restore implicit-flow fallback. Copy the maintained silent-callback bundle before building the service-worker manifest.
