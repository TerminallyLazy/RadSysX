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

- Use Python `3.12` for `backend/requirements-ai.txt`, the desktop Gemini/OpenAI and deepagents runtime layered over clinical requirements. Keep the incompatible legacy `backend/requirements.txt` in a separate environment.
- Python `3.13` is acceptable for the governed clinical bootstrap path only.

## Critical Rules

- API-key settings are backend-owned, encrypted per authenticated user and write-only from the browser. Never commit `.env.ai`, `.ai-secrets/` or local databases. Saved keys override operator configuration only for their owner; changes end their active assistant sessions and tasks.

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

### Security-patched viewer build

Use Node.js 24+ and Git. The viewer now rebuilds pinned OHIF source with audited dependency updates; the npm package prebuilt bundle is not shipped. `viewer/ohif-build/` holds the upstream commit, reviewed patch, and separate frozen pnpm lockfile. `npm run build --workspace viewer` prepares an ignored `viewer/.cache/` checkout on the first run (network access required) and reuses matching builds afterward. Run `npm audit` and `npm run audit:ohif --workspace viewer` to check both dependency trees. See [the build contract](viewer/ohif-build/AGENTS.md).

## Explicit public evidence evaluation

The standalone [evidence-review runbook](backend/evidence_review/README.md) documents private public/synthetic PubMed capture, Jev/Gemini/NIM replay, blind references and comparative reports. Run `.venv/bin/python -m backend.evidence_review --help`. The CLI remains independent of live conversation and never changes assistant answers. The sidebar now offers a separate explicit **Review evidence with Jev** action on completed PubMed research cards; see the [sidebar implementation runbook](roadmap/ai-backend/JEV_SIDEBAR_IMPLEMENTATION.md). Preview the exact claims and original abstracts, exclude claims as needed, and confirm public/synthetic text before TypeSafe receives anything. Saved claim-level judgments and resolved-model receipts establish what ran; the Settings configuration row alone does not. Clinical mode disables its network commands; local report/validation commands need no credentials. Software completion does not imply human-quality or live-provider acceptance.

NVIDIA NIM is available for explicit evidence evaluation and opt-in PubMed research. Set backend-only `RADSYSX_NVIDIA_API_KEY`, `RADSYSX_RESEARCH_PROVIDER=nvidia_nim` and an exact `RADSYSX_NIM_RESEARCH_MODEL` to select NIM research; these environment settings supply the default when the account has no saved choice. In **Settings → Text & research models**, choose Gemini or NVIDIA NIM and an exact model from the dropdown. NVIDIA lists every ID returned by its hosted catalog, with a refresh control. Saving persists the choice for the signed-in account and ends its active sessions/tasks; the next text or research request uses it. Catalog membership does not verify tool support or access. The model catalog is `.venv/bin/python -m backend.evidence_review models --provider nvidia_nim`. See the [NIM runbook](roadmap/ai-backend/NIM_IMPLEMENTATION.md) for tested models, limits and failure evidence.

Typed **Send** and explicit **Research** work without Gemini Live/OpenAI Realtime. Confirm synthetic/deidentified content and choose the standard model in **Settings → Text & research models**. Only the question, bounded text history (chat only) and neutral viewer metadata are sent; Codex image input requires explicit **Attach current view**, preview, and Send/Research. This submits one active-viewport snapshot including visible overlays, not the full series; other providers retain separate live sharing. **Connect voice** starts a separate voice conversation. See `roadmap/ai-backend/DESKTOP_AI_ACTIVATION.md`.

ChatGPT/Codex subscription sign-in is available under desktop AI Settings for typed chat and public PubMed research. It uses isolated backend-owned Codex App Server and the OS keyring, not OpenAI API credentials or Realtime entitlement. Read `roadmap/ai-backend/CODEX_SUBSCRIPTION.md`; never copy the user's existing Codex auth.

The AI sidebar separates Chat, Research and Jev review. Optional voice setup is behind the header Voice button. Explicit Images selection plus Send captures fresh pixels automatically, with acknowledged delivery beside the composer. The review workspace hides the composer and collapses abstracts/technical receipts. Sidebar evidence uses versioned intact cited passages and explicitly reports empty previews as unavailable. See `roadmap/ai-backend/JEV_SIDEBAR_IMPLEMENTATION.md` for the corrected workflow and live acceptance.
