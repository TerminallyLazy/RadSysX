# Backend Tests DOX

## Purpose

- Own backend pytest coverage.

## Ownership

- Owns clinical platform tests and research/model validation tests under `backend/tests`.

## Local Contracts

- Clinical tests should exercise backend-authoritative contracts rather than browser-local state.
- Tests must not depend on committed local databases, live PHI, or machine-local dependency paths.
- Use fixtures and synthetic/de-identified data.

## Work Guidance

- Prefer focused tests near the contract being changed.
- Expand coverage when touching shared clinical contracts, launch/session behavior, audit, DICOMweb, or persistence.

## Verification

- `python3 -m pytest backend/tests/test_clinical_platform.py`
- `python3 -m pytest backend/tests`

## Child DOX Index

## Security regression suite

- `evidence_review/` owns synthetic network-isolated tests for immutable snapshots, original abstracts, bounded evaluators and private review artifacts. Fixtures clear provider credentials; live inference and qualified human labels are separate acceptance work.
- `python3 -m pytest backend/tests/test_security_regressions.py` covers synthetic error privacy, streaming completion, artifact traversal/symlink rejection, worker failures, and DICOM/FHIR logging. It must not contact a real FHIR server or process live patient data.

- `test_ai_live.py` verifies synthetic Live ownership, media/lifecycle, action approval/idempotency/recovery without Google; `test_ai_research.py` verifies bounded isolated delegates, shared dispatch limits across public and virtual tools, and citation contracts. Tests must not read a real provider key into fixtures or accidentally call Google.
- `test_ai_openai.py` verifies the OpenAI transport without cloud access; `test_ai_providers.py` verifies selected-provider routing, immutable session identity, readiness, media markers and shared tool authority. Mock both providers and isolate `.env.ai` reads in fixtures; authenticated provider probes are separate, explicitly synthetic acceptance work.
- `test_ai_connection_races.py` covers queued-input provider replacement and authority revocation, context-before-ready ordering, atomic audio markers, serialized detach/accept, no mutation replay, and exclusion of unconfirmed assistant speech from fresh OpenAI context.
- `test_ai_screen_awareness.py` covers explicit sharing off/pending/received state, nonpersistent receipts, first-frame failures, stop/reconnect resets, historical-image honesty and stale provider notification races.
- `test_ai_credentials.py` covers encrypted personal keys, signed owner/provider isolation, deployment fallback, live/research key selection, fixed nonreflecting validation errors, no-store replies, unsafe/missing/corrupt master storage, FIFO rejection and actor-scoped session/job shutdown before key mutation. Use only synthetic key strings and isolated SQLite-adjacent key directories. Never read, change or validate a real account key in these tests.

The evidence-review CLI tests exercise real private artifacts and mocked capture/providers, including capture/replay/resume, offline blind/reference/comparison flows, mode gates and SIGINT. They do not claim live inference, browser rendering, or qualified human review.

- NIM tests cover bounded catalog/evaluator HTTP, cancellation, immutable CLI resume, provider configuration and key isolation, and actual DeepAgents graphs with synthetic NVIDIA model calls. Shared dispatch-budget tests run against both Gemini and NIM. Live NIM acceptance remains a separate public/synthetic probe.

- `test_ai_research_settings.py` covers signed owner-only model preferences, persistence/runtime resolution, session invalidation, catalog membership, provider readiness, mode/auth/origin gates and fixed no-store failures. Mock discovery and provider keys; live catalog checks are separate from these network-isolated tests.
- `test_ai_evidence_review.py` composes the actual owned service, temporary database and private artifacts with HTTP-only fixtures. It verifies exact text confirmation/selection, payload isolation, ownership, capacity, idempotency/atomic starts, cancellation/backoff, expiry/settings changes, deletion, restart and unknown billing. Clear TypeSafe environment keys and block external sockets; synthetic fixture responses never establish live acceptance.
- `test_ai_evidence_routes.py` exercises production router composition with isolated persistence and synthetic HTTP: all six ownership/auth/mode/origin gates, strict bounded bodies, fixed private failures, preview/start/idempotency, unchanged answer and source deletion. No real key or external network is permitted.
