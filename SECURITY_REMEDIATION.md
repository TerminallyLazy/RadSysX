# Security remediation — September 2026

Baseline: GitHub reported **29 open Dependabot alerts and 27 open CodeQL alerts** on `main` at `981c1432e096e9bb14a0efe516318db4849400d7`.

## Changes

- Replaced exception strings and tracebacks in JSON, HTML, SSE, and optional-import responses with fixed public messages. Removed query text and patient payloads/identifiers from the affected logs; verbose DICOM anonymization now reports field actions without values or filenames.
- Restricted BioMedParse artifact reads to generated run IDs and the two supported artifacts. Run IDs are parsed and rebuilt as fixed-width hexadecimal names before filesystem access, with resolved containment and symlink rejection. Worker stderr remains a local diagnostic artifact and is never returned to the client.
- Updated AnyIO and Soup Sieve. Removed unused NLTK/Unstructured dependencies instead of retaining their vulnerable optional document-processing chain.
- Updated the npm dependency graph, including React Router, URI decoding/query parsing, YAML parsing, ZIP utilities, UUID, translation backend, merging, and serialization. Removed the unused browser crypto polyfill.
- Replaced abandoned `validate.js` with the Social Tables fork containing the email-regex fix for [CVE-2020-26308](https://securitylab.github.com/advisories/GHSL-2020-302-redos-validate.js/). The regression test exercises the disclosed malformed email under a process timeout.
- Rebuild OHIF 3.13.4 from pinned source commit `e1cf19a210b745c81d281b77cb94666654ee70b1` and a separately audited, frozen dependency graph. Updating the root lockfile alone cannot repair the upstream precompiled viewer.
- The source build excludes unused upstream docs, CLI, Cypress, and rsbuild tooling, and replaces the ITK download helper's decompressor with the maintained XhmikosR implementation. No advisory ignore list is used.
- Removed the retired prebundled OIDC client from shipping output. OHIF OIDC uses its existing `oidc-client-ts` path with authorization-code flow and PKCE; the silent callback loads the maintained client locally. Deployments using implicit flow must migrate to authorization-code flow. RadSysX signed-cookie auth and the separate SMART/FHIR launch contract remain separate authorities.
- Updated minified runtime/base-path packaging and workspace module resolution. Desktop checks the source-build fingerprint before reusing generated viewer output.
- Added CI regression tests, audits of both Node dependency trees and both Python dependency sets, type checks, and production builds alongside the existing CodeQL workflow.

## Reproduction

Use Node.js 24+, Git, and Python 3.12. First viewer builds download the pinned upstream source and registry dependencies into ignored `viewer/.cache/`; dependency lifecycle scripts are disabled. All build inputs and dependency integrity records are committed under `viewer/ohif-build/`.

```sh
npm ci --legacy-peer-deps --ignore-scripts
npx prisma generate --schema frontend/schema.prisma
npm audit
npm run type-check
npm run build
npm run audit:ohif --workspace viewer
npm run test:security --workspace viewer
npm run test:fhir-bridge --workspace viewer
python3 -m pytest backend/tests/test_security_regressions.py backend/tests/test_biomedparse_demo.py backend/tests/test_clinical_platform.py -q
```

Research dependency verification resolves `backend/requirements.txt` with `uv pip compile --python 3.12`, then audits the complete resolved result with `pip-audit --no-deps --disable-pip`. Clinical requirements are audited separately. No audit severity is excluded.

## Acceptance boundaries

Dependency audits establish the state of the advisory databases at execution time. The backend tests use synthetic data and fake model workers; they do not establish clinical diagnostic performance. Docker/Orthanc deployment, real institutional OIDC/SMART accounts, and GPU inference require their own acceptance checks. Default-branch GitHub alert closure must be confirmed after the fixes are merged and rescanned.
