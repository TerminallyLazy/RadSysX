# CLAUDE.md

If this file conflicts with [AGENTS.md](AGENTS.md), follow `AGENTS.md`.

## Project Snapshot

RadSysX has two product surfaces:

- `clinical`: governed FastAPI contracts, worklist-driven launch, opaque OHIF viewer sessions, audited workflow state
- `research`: experimentation surface for agent tooling, prototype imaging flows, and AI exploration

The clinical path is the migration target. Do not plan against research-only seams when making clinical changes.

There is also a desktop fast path in `desktop/`: Electron starts the local FastAPI backend, Next.js shell, and generated OHIF viewer bridge under one localhost origin for no-Docker local use, with backend-owned local imaging import enabled.

The OHIF app also serves `/viewer/fhir-viewer` for FHIR R4 imaging discovery through SMART on FHIR. Treat its SMART authorization as separate from the governed RadSysX launch/report/writeback authority.

## Environment Posture

- Preferred host: native Linux
- Do not assume WSL, Windows paths, Docker Desktop behavior, or machine-local temp dependency hacks
- Prefer `.venv` for Python deps and workspace-managed Node deps rooted at the repo `package-lock.json`
- Fastest local app path: `npm run desktop`; it checks bootstrap, repairs setup when allowed, and opens OHIF local-start first
- After initial recon on the Linux host, wait for the user's first Linux runtime test report before widening the change scope

## Current Clinical Runtime

- Backend authority: `backend/server.py` and `backend/clinical/*`
- Local imaging import: `backend/clinical/local_imaging.py` plus `POST /api/local-imaging/import`
- Desktop fast path: `desktop/src/main.mjs`, `desktop/scripts/launch.mjs`, `desktop/scripts/bootstrap.mjs`, `desktop/scripts/doctor.mjs`
- Shared frontend/viewer package: `packages/clinical-web/*`
- Clinical shell: `frontend/app/login/page.tsx`, `frontend/app/worklist/page.tsx`
- Authoritative viewer: `viewer/` with:
  - `viewer/scripts/build-ohif-dist.mjs`
  - `viewer/assets/radsysx-bootstrap.js`
  - `viewer/assets/radsysx-fhir-extension.js`
  - `viewer/assets/radsysx-ohif-extension.js`
  - `viewer/assets/radsysx-ohif-mode.js`
- `viewer/assets/radsysx-viewer.css`
- Supported clinical `/viewer` fallback: none

## Python Baseline

- Use Python `3.12` when the same environment needs both `backend/requirements-clinical.txt` and `backend/requirements.txt`.
- Python `3.13` is acceptable for the governed clinical bootstrap path only.

## Critical Rules

- Do not reintroduce browser-supplied actor identity into governed clinical APIs.
- Do not put PHI-bearing launch context into URLs.
- Do not let the browser write directly to Orthanc for governed flows.
- Do not use `frontend/lib/api.ts` as the clinical source of truth.
- Do not restore the old bespoke viewer path as a fallback.

## Verification Commands

```bash
python3 -m compileall backend/clinical backend/server.py backend/radsysx.py
python3 -m pytest backend/tests/test_clinical_platform.py
npm run type-check --workspace frontend
npm run type-check --workspace viewer
npm run build --workspace viewer
npm run test:fhir-bridge --workspace viewer
npm run desktop -- --check-only
npm run desktop:doctor
npm run desktop:smoke:launch
npm run desktop:smoke
```

## Current Checklist

The current execution checklist is [PHASE4_CLINICAL_EXECUTION_CHECKLIST.md](PHASE4_CLINICAL_EXECUTION_CHECKLIST.md).
