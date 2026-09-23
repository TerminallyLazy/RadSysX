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

Install Node dependencies from the repo root so the workspace-managed root `package-lock.json` owns RadSysX dependencies.

Fast local Electron path:

```bash
npm run desktop
```

The desktop launcher checks bootstrap, repairs setup when allowed, and then opens OHIF local-start first. The app defaults to local `pilot` mode, enables backend-owned local imaging import, and supervises FastAPI, Next.js, and the OHIF viewer bridge behind one localhost origin. Use compose when you need Orthanc-backed DICOMweb validation.

Desktop bootstrap installs `backend/requirements-ai.txt` (clinical base plus Gemini/OpenAI transports and deepagents), using repo-local Python 3.12. Keep legacy research dependencies in a separate environment. Configure `RADSYSX_GEMINI_API_KEY` and/or `RADSYSX_OPENAI_API_KEY` only in backend `.env.ai` or the process environment. The sidebar selects the exact Gemini Live or `gpt-realtime-2.1-mini` provider; research delegates default to Gemini Flash with an explicit NVIDIA NIM PubMed option. Both providers require explicit synthetic/deidentified attestation, connection, microphone and viewport sharing controls; real patient cloud use is disabled. Read `roadmap/ai-backend/LIVE_IMPLEMENTATION.md` for current contracts and verification. `npm run desktop:smoke:ai-live` is synthetic bridge validation, not authenticated cloud or physical-audio acceptance.

Users can configure their own Gemini/OpenAI keys through **Settings → API keys** in the assistant panel. Keys are write-only, encrypted by the backend per authenticated user and override app configuration only for that user. Changes end active assistant sessions. Keep `.env.ai`, `.ai-secrets/` and local databases uncommitted; the source distribution must contain no personal key.

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

### Security-patched viewer build

Use Node.js 24+ and Git. The viewer now rebuilds pinned OHIF source with audited dependency updates; the npm package prebuilt bundle is not shipped. `viewer/ohif-build/` holds the upstream commit, reviewed patch, and separate frozen pnpm lockfile. `npm run build --workspace viewer` prepares an ignored `viewer/.cache/` checkout on the first run (network access required) and reuses matching builds afterward. Run `npm audit` and `npm run audit:ohif --workspace viewer` to check both dependency trees. See [the build contract](viewer/ohif-build/AGENTS.md).

## Explicit public evidence evaluation

The standalone [evidence-review runbook](backend/evidence_review/README.md) documents private public/synthetic PubMed capture, Jev/Gemini/NIM replay, blind references and comparative reports. Run `.venv/bin/python -m backend.evidence_review --help`. The CLI remains independent of live conversation and never changes assistant answers. The sidebar now offers a separate explicit **Review evidence with Jev** action on completed PubMed research cards; see the [sidebar implementation runbook](roadmap/ai-backend/JEV_SIDEBAR_IMPLEMENTATION.md). Preview the exact claims and original abstracts, exclude claims as needed, and confirm public/synthetic text before TypeSafe receives anything. Saved claim-level judgments and resolved-model receipts establish what ran; the Settings configuration row alone does not. Clinical mode disables its network commands; local report/validation commands need no credentials. Software completion does not imply human-quality or live-provider acceptance.

NVIDIA NIM is available for explicit evidence evaluation and opt-in PubMed research. Set backend-only `RADSYSX_NVIDIA_API_KEY`, `RADSYSX_RESEARCH_PROVIDER=nvidia_nim` and an exact `RADSYSX_NIM_RESEARCH_MODEL` to select NIM research; these environment settings supply the default when the account has no saved choice. In **Settings → Text & research models**, choose Gemini or NVIDIA NIM and an exact model from the dropdown. NVIDIA lists every ID returned by its hosted catalog, with a refresh control. Saving persists the choice for the signed-in account and ends its active sessions/tasks; the next text or research request uses it. Catalog membership does not verify tool support or access. The model catalog is `.venv/bin/python -m backend.evidence_review models --provider nvidia_nim`. See the [NIM runbook](roadmap/ai-backend/NIM_IMPLEMENTATION.md) for tested models, limits and failure evidence.

Typed **Send** and explicit **Research** work without Gemini Live/OpenAI Realtime. Confirm synthetic/deidentified content and choose the standard model in **Settings → Text & research models**. Only the question, bounded text history (chat only) and neutral viewer metadata are sent; Codex image input requires explicit **Attach current view**, preview, and Send/Research. This submits one active-viewport snapshot including visible overlays, not the full series; other providers retain separate live sharing. **Connect voice** starts a separate voice conversation. See `roadmap/ai-backend/DESKTOP_AI_ACTIVATION.md`.

ChatGPT/Codex subscription sign-in is available under desktop AI Settings for typed chat and public PubMed research through isolated, pinned Codex App Server. Subscription credentials stay in the OS keyring; Realtime remains API-key billed. Read `roadmap/ai-backend/CODEX_SUBSCRIPTION.md`.

The AI sidebar separates Chat, Research and Jev review. Optional voice setup is behind the header Voice button. Explicit Images selection plus Send captures fresh pixels automatically, with acknowledged delivery beside the composer. The review workspace hides the composer and collapses abstracts/technical receipts. Sidebar evidence uses versioned intact cited passages and explicitly reports empty previews as unavailable. See `roadmap/ai-backend/JEV_SIDEBAR_IMPLEMENTATION.md` for the corrected workflow and live acceptance.
