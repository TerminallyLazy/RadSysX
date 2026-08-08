# Current Clinical Execution Checklist

Branch context:

- local working branch: use the current active branch
- related architecture guidance: `AGENTS.md`
- public product/runtime name: `RadSysX`

Purpose:

- Track the remaining work after the clinical OHIF cutover, the RadSysX rename, and the PR #51 hardening/polish fixes.
- Keep the next tranche grounded in the current shipped baseline rather than earlier migration-phase assumptions.

## Current Baseline

These items are already part of the current post-Phase-4-polish baseline:

- [x] RadSysX is the active runtime name across code, packages, env vars, and active docs.
- [x] OHIF owns the clinical `/viewer` route.
- [x] The Next.js `/viewer` fallback route has been removed.
- [x] Local clinical auth is mode-gated and returns deterministic client errors.
- [x] Clinical session cookies are configurable and safe by default for governed modes.
- [x] Launch tokens are removed from the URL after resolve.
- [x] STOW uploads no longer buffer the full payload into RAM before DICOMweb forwarding.
- [x] Orthanc credentials are environment-driven instead of committed as live defaults.

## Definition Of Done

- RadSysX remains the only active product/runtime name in maintained code and docs.
- OHIF remains the only supported viewer runtime for the clinical surface.
- Measurement tracking and segmentation export/reload are fully wired through governed backend-mediated SR/SEG flows.
- The one-origin nginx + frontend + viewer + backend + Orthanc stack is validated end to end.
- Guidance docs describe the shipped architecture accurately enough that a new contributor would not plan against stale assumptions.

## Execution Checklist

- [ ] Start the native Linux validation tranche correctly.
  - Use a native Linux host as the reference posture.
  - Bootstrap Python deps with `.venv` and `backend/requirements-clinical.txt`, and Node deps with workspace `npm install`.
  - Keep research/agent extras out of the initial governed clinical bring-up unless the task explicitly needs them.
  - If the validation pass needs both the clinical and research/backend dependency sets on one host, use Python `3.12`.
  - Do a short context recon, then wait for the user's first Linux runtime test report before broad code changes.

- [ ] Finish documentation alignment across the maintained surface.
  - Update any remaining deploy/runtime docs to reflect `RADSYSX_*` env vars, the no-fallback OHIF viewer, and the current one-origin compose stack.
  - Remove or quarantine stale historical notes instead of letting them read like active instructions.

- [ ] Deepen the native RadSysX OHIF integration.
  - Keep `viewer/assets/radsysx-bootstrap.js` minimal: session check, launch resolve, transient startup URL state, and cleanup.
  - Move remaining RadSysX workflow behavior toward OHIF-native extension/mode/service seams rather than bootstrap-owned DOM logic.
  - Preserve the backend-authoritative workspace contract and the same-origin DICOMweb runtime contract.

- [ ] Wire standards-native SR export through the governed backend.
  - Connect OHIF measurement-tracking export to `POST /api/derived-results/stow`.
  - Record persisted SR references back into study workspace state and audit history.
  - Confirm reload rehydrates tracked measurements from persisted SR objects.

- [ ] Wire standards-native SEG export through the governed backend.
  - Connect OHIF segmentation export to `POST /api/derived-results/stow`.
  - Record persisted SEG references back into study workspace state and audit history.
  - Confirm reload rehydrates persisted segmentations correctly.

- [ ] Tighten viewer/runtime smoke coverage.
  - Add focused checks for launch resolution, URL cleanup, report save/finalize, AI queueing, SR upload/export, SEG upload/export, and workspace refresh behavior.
  - Keep the tests aligned with the backend contracts instead of browser-local shortcuts.

- [ ] Validate the local one-origin clinical stack end to end.
  - Run nginx + frontend + viewer + backend + Orthanc with explicit RadSysX credentials.
  - Prove the sequence: login -> worklist -> launch -> OHIF load -> report save/finalize -> AI queue -> SR persistence -> SEG persistence -> workspace refresh -> reload rehydration -> logout.
  - Capture any runtime gaps as explicit follow-up issues instead of leaving them implicit.

- [ ] Prepare the institutional identity/context tranche.
  - Define the replacement path for seeded local personas.
  - Keep backend-issued actor identity authoritative until real identity is integrated.
  - Do not reintroduce browser-supplied actor identity fields into governed APIs.

## Suggested Execution Order

1. Native Linux validation intake and first observed runtime report
2. Documentation alignment and leftover rename cleanup
3. Native OHIF extension/mode deepening
4. SR export + reload wiring
5. SEG export + reload wiring
6. End-to-end compose validation
7. Institutional identity/context preparation

## Suggested Verification

- `python3 -m compileall backend/clinical backend/server.py backend/radsysx.py`
- `python3 -m pytest backend/tests/test_clinical_platform.py`
- `npm run type-check --workspace frontend`
- `npm run type-check --workspace viewer`
- `npm run build --workspace viewer`
- If Docker Engine + Compose are available on the Linux host:
  - `RADSYSX_ORTHANC_USERNAME=<user> RADSYSX_ORTHANC_PASSWORD=<pass> docker compose up --build`

## Guardrails

- Do not restore the old bespoke viewer as a fallback.
- Do not put PHI-bearing launch context into URLs.
- Do not let the browser write directly to Orthanc for governed flows.
- Do not treat research routes or `frontend/lib/api.ts` as the clinical source of truth.
- Do not widen the bootstrap layer when the same behavior can live in an OHIF extension/mode/service seam.
