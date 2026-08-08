# WARP.md

This repository’s authoritative implementation guidance is [AGENTS.md](AGENTS.md). If this file and `AGENTS.md` ever diverge, follow `AGENTS.md`.

## High-Signal Runtime Notes

- Product/runtime name: `RadSysX`
- Clinical authority: `backend/server.py` + `backend/clinical/*`
- Clinical viewer: dedicated OHIF runtime in `viewer/`
- SMART FHIR viewer: `/viewer/fhir-viewer`, separate from governed RadSysX launch authority
- Clinical `/viewer` fallback: none
- Shared browser clinical package: `packages/clinical-web/*`
- Clinical shell: `frontend/app/login/page.tsx`, `frontend/app/worklist/page.tsx`
- Desktop fast path: `desktop/`, launched with `npm run desktop`
- Local imaging import: `backend/clinical/local_imaging.py` and `POST /api/local-imaging/import`
- Root `frontend/app/page.tsx`: landing/surface selector, not the clinical viewer
- Preferred host: native Linux, not WSL-specific tooling assumptions

## Two Surfaces

- `clinical`: governed FastAPI contracts, worklist launch, opaque viewer sessions, backend-mediated writeback
- `research`: experimentation surface for prototype and agent workflows

Do not treat them as equivalent.

## Commands

Use Python `3.12` if you need both the governed clinical install and the broader research/backend install in one environment.

```bash
python3 -m venv .venv
. .venv/bin/activate
python3 -m pip install -r backend/requirements-clinical.txt
npm install --legacy-peer-deps
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

Install Node dependencies from the repo root so the workspace-managed root `package-lock.json` is the only active lockfile.

Fast local Electron path:

```bash
npm run desktop
```

The desktop launcher checks bootstrap, repairs setup when allowed, and then opens OHIF local-start first. The app defaults to local `pilot` mode, enables backend-owned local imaging import, and supervises FastAPI, Next.js, and the OHIF viewer bridge behind one localhost origin. Use compose when you need Orthanc-backed DICOMweb validation.

After initial recon on the Linux host, wait for the user's first app test report before widening the code-change scope.

Local compose stack:

```bash
export RADSYSX_ORTHANC_USERNAME=local-user
export RADSYSX_ORTHANC_PASSWORD=local-pass
docker compose up --build
```

Full backend/runtime install on the same host:

```bash
. .venv/bin/activate
python3 -m pip install -r backend/requirements.txt
RADSYSX_APP_MODE=research python3 backend/server.py
```

## Guardrails

- Do not restore the old bespoke viewer as a clinical fallback.
- Do not treat research APIs as the clinical source of truth.
- Do not put PHI-bearing launch context into viewer URLs.
- On `/viewer/fhir-viewer`, allow only standard opaque SMART launch/callback parameters; never add patient identifiers, payloads, or access tokens.
- Do not let the browser write directly to Orthanc in governed flows.
