# Sidebar Jev Evidence Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The user selected Native execution: implement in this session, then obtain one fresh whole-change review. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user explicitly review an owned, completed PubMed research answer with Jev, after previewing and confirming the exact selected text, and inspect saved claim/source judgments and execution receipts.

**Architecture:** A backend-owned review service freezes the existing research result, retrieves original PubMed abstracts, and composes the existing pure evaluator. Separate jobs, private immutable artifacts and signed-owner HTTP contracts keep review independent of live voice and preserve the original answer. A focused viewer controller and card component present preparation, consent, progress, exclusions and saved receipts inside the existing conversation.

**Tech Stack:** Python 3.12, existing FastAPI/Pydantic/SQLAlchemy/httpx, SQLite desktop persistence, standard-library XML parsing, strict TypeScript, existing OHIF extension and Electron smoke harness. No new agent framework or package is required.

**Spec:** [Approved sidebar specification](../specs/2026-09-22-jev-sidebar-evidence-review-design.md). Read it and this plan together.

**Stage:** Written plan awaiting user review, 2026-09-22. Runtime implementation has not started. Preserve Native execution. Worktree: `codex/jev-evidence-implementation`, based on `codex/gemini-live-assistant`. Implementation baseline: `2f22e89`.

## Global Constraints

- “The offline evaluation CLI and its blinded study remain independent.” Keep its default selection, request bytes, resume validation and existing artifacts compatible.
- “TypeSafe receives selected eligible claims and original abstract sections only.” No query, chat, report, study/session identifiers, audio or images enters a reviewer request.
- “Clinical mode rejects review before credentials or external connections.” Require enabled research/pilot mode, signed unexpired `ai.run` actor, owned source and an explicit allowed Origin on writes.
- “Existing synthetic/deidentified image attestation is insufficient.” Every start/retry needs public-literature/synthetic text confirmation for the frozen preview and selection.
- Reviewer identity is `TypeSafe · jev-1.13.0`; use backend-only `RADSYSX_TYPESAFE_AI_API_KEY`. No reviewer dropdown or new personal-key vault.
- “One active review per actor and at most two globally.” Preparation is at most 20 seconds; total active operation budget is 90 seconds, including cleanup. Human time reading the preview consumes no inference resources or execution budget.
- Evaluator ceilings remain 40 pairs, 20 abstracts, 10,000 abstract characters, 12,000 answer characters, two concurrent attempts, 10 seconds per attempt, one retry, 60 seconds evaluation and five seconds cleanup; snapshot/XML bodies are at most 2 MiB and reviewer requests at most 128 KiB.
- “End voice does not cancel an explicitly separate public-literature review.” Cancel, logout/expiry, conversation deletion, shutdown, feature disable and account credential/model mutation do. Restart never automatically submits requests.
- “The compact sidebar header remains unchanged.” Details live inside the scrollable research card; keep exact source text, keyboard controls and stable consent inputs.
- No answer edits, model feedback, image inference, autonomous tool dispatch, report mutations, global Verified badge, invented Jev explanations or clinical-validation claim.
- Follow the root and each owning child `AGENTS.md`. Use repo-managed dependencies, ignored private artifacts and network-isolated tests. Do not read operator dotenv files during tests or copy credentials into this worktree.

## Review Focus

1. A result arrives after its conversation was deleted or another account changed settings: no late submission, artifact recreation or visible result resurrection (Tasks 3–4).
2. A selected Unicode claim cites two abstracts, one missing/truncated, or selection is changed on retry: preserve offsets and separate source judgments; reject changed resume identity (Tasks 1–2).
3. Double-click/retransmitted start, cancellation during backoff, and disk failure immediately after submission: no duplicate scheduling; preserve committed successes and unknown usage (Tasks 1, 3–4).
4. A normal PubMed XML document contains its public DOCTYPE, while a hostile document declares entities, redirects or repeats mismatched PMIDs: accept ordinary abstracts without fetching a DTD; reject unsafe/ambiguous evidence (Task 2).
5. A saved NVIDIA result opens after provider/viewport changes while an older poll resolves: retain original generation/source identity and original answer; never overwrite current consent or show a result on the wrong card (Tasks 2, 5–6).

## File and responsibility map

| Area | Files | Responsibility |
| --- | --- | --- |
| Pure evaluator | `backend/evidence_review/units.py`, `runner.py`, `artifacts.py` | Validated selection, committed progress, dispatch guard, safe explicit artifact deletion; no actor/database dependencies |
| Source retrieval | new `backend/evidence_review/pubmed.py`; existing `capture_worker.py` | Fixed EFetch transport and bounded XML; reuse `EvidenceCollector` extraction without changing offline capture |
| Generation provenance | `backend/clinical/models.py`, `ai_repository.py`, `ai_live.py` | Additive per-tool record of the provider/model actually dispatched, separate from prompt/result text |
| Review persistence | new `backend/clinical/ai_evidence_contracts.py`, `ai_evidence_repository.py`, `ai_evidence_artifacts.py` | Strict DTOs, owned records/idempotency, private artifact projection and deletion |
| Review orchestration | new `backend/clinical/ai_evidence_review.py`; `ai_config.py`, `ai_live.py`, `backend/server.py` | Preparation/start/retry/cancel, limits, ownership and lifecycle composition |
| HTTP | new `backend/clinical/ai_evidence_routes.py`; `ai_routes.py` | Strict bounded bodies, cookie/Origin authority, fixed errors, no-store |
| Shared browser API | `packages/clinical-web/src/contracts.ts`, `client.ts`; `viewer/assets/live/protocol.ts`, `viewer/scripts/live-contracts.ts` | Matching request/response types and same-origin clients |
| Viewer | new `viewer/assets/live/evidence.ts`, `evidence-panel.ts`; `controller.ts`, `panel.ts`, `viewer/assets/radsysx-viewer.css` | Separate review state/polling, compact card presentation, settings availability |
| Verification | new `backend/tests/evidence_review/test_selection.py`, `test_pubmed.py`, `backend/tests/test_ai_evidence_review.py`, `test_ai_evidence_routes.py`, `test_ai_evidence_provenance.py`; existing runner/storage/Live tests; new `viewer/scripts/test-evidence.mjs` | Source, privacy, lifecycle, UI and unchanged behavior regressions |
| Acceptance | `backend/clinical/ai_fixture_server.py`, `desktop/scripts/ui-import-smoke.mjs`, new `desktop/scripts/evidence-review-smoke.mjs`, new `backend/tools/accept_jev_sidebar.py` | Guarded synthetic Electron flow and explicit synthetic live-provider backend-path acceptance |
| Durable docs | Owning DOX files, `README.md`, `CLAUDE.md`, `WARP.md`, new `roadmap/ai-backend/JEV_SIDEBAR_IMPLEMENTATION.md` | Actual behavior, configuration, commands, receipts and limitations |

Read DOX chains before edits: root → backend → clinical/tests/evidence_review/tools; root → packages → clinical-web; root → viewer → assets → live and root → viewer → scripts; root → desktop; root → roadmap; root → docs. Do not create a new worktree or change the original checkout's unrelated `.DS_Store`.

## Shared identities and state

Use opaque generated `jer-<uuidhex>` review IDs and `jev-<uuidhex>` artifact run IDs. A review belongs permanently to `(actor.sub, sessionId, toolCallId, contextVersion, answerSha256)`. Changing the active viewer or today's research settings cannot change those values. Return `sourceContextVersion`, not a patient/study identifier.

Statuses are `preparing`, `ready`, `reviewing`, `completed`, `partial`, `failed`, `cancelled`, `interrupted`, `unavailable`. Only preparing/reviewing consume active slots. Preparation may be repeated as a new review after failure/cancellation; a duplicate operation key returns its original review. Completed reviews are read-only. Retry applies only to partial/failed/interrupted evaluation with a valid saved selection, never to a missing preview or a cancelled review. A fresh preparation is an explicit action, never a GET side effect.

Keep operation idempotency keys separate from snapshot and selected-unit identities. Persist the operation key, canonical request hash and review ID before scheduling. Reusing a key with different input returns 409. A second start with another key while already reviewing returns current status without scheduling; a start against a completed result returns the saved result. Retry cannot overlap an active job.

---

### Task 1: Preserve evaluator integrity with explicit claim selection and lifecycle hooks

**Files:** Modify `backend/evidence_review/units.py`, `runner.py`, `AGENTS.md`; create `backend/tests/evidence_review/test_selection.py`; extend `backend/tests/evidence_review/test_runner.py`.

**Interfaces:**
- Consumes existing `Snapshot`, `ReviewPlan`, `RunView`, `Evaluator`, `Limits`, `build_review_plan(snapshot, *, limits, annotations=())`.
- Produces `select_review_plan(plan: ReviewPlan, *, selected_unit_ids: tuple[str, ...] | None) -> ReviewPlan`.
- Extends `evaluate_snapshot` with optional `selected_unit_ids: tuple[str, ...] | None = None`, `before_attempt: Callable[[], str | None] | None = None`, `on_commit: Callable[[RunView], None] | None = None`. Existing parameters and `RunResult` return stay unchanged. A guard returns a fixed non-submission reason or `None`; callbacks must not perform network I/O.

- [ ] **Step 1: Add selection and forged-plan RED tests.** Reuse `snapshot_factory` from the existing evidence-test conftest and `ScriptedEvaluator` from `test_runner.py`. Cover exact Unicode text, two sources, empty/duplicate/unknown selection and changing selection during resume.

```python
def test_selection_preserves_unicode_answer_and_source_pairs(snapshot_factory):
    from backend.evidence_review.units import build_review_plan, select_review_plan
    from backend.evidence_review.contracts import Limits
    snap = snapshot_factory(answer="Nodule ≤6 mm [s1][s2]. Follow-up differs [s1].", evidence_count=2)
    full = build_review_plan(snap, limits=Limits())
    chosen = select_review_plan(full, selected_unit_ids=(full.units[0].unit_id,))
    assert len(chosen.pairs) == 2
    assert chosen.units == full.units
    assert all(p.unit.text == snap.result.summary[p.unit.start:p.unit.end] for p in chosen.pairs)
    assert {p.evidence.citation_id for p in chosen.pairs} == {"s1", "s2"}
    assert any(p.reason == "user_excluded" for p in chosen.excluded_pairs)
    assert select_review_plan(full, selected_unit_ids=None) == full
```

- [ ] **Step 2: Run RED.** `.venv/bin/python -m pytest backend/tests/evidence_review/test_selection.py -q`. Expected: missing `select_review_plan`, not an unrelated fixture/import failure.
- [ ] **Step 3: Implement validated projection.** Retain every original unit, including curated spans. Eligibility is membership in at least one original executable pair. Reject empty, duplicate and unknown IDs; canonicalize the chosen set into original unit order. Filter pairs, add `user_excluded` pair exclusions, and update coverage without rewriting the answer or removing other exclusion reasons.

```python
eligible = {pair.unit.unit_id for pair in plan.pairs}
selected = set(selected_unit_ids)
if not selected or len(selected) != len(selected_unit_ids) or not selected <= eligible:
    raise ValueError("invalid_unit_selection")
pairs = tuple(pair for pair in plan.pairs if pair.unit.unit_id in selected)
```

The runner first reloads the snapshot, rebuilds the full annotated plan, applies this same projection and compares it to the supplied plan. Store canonical selection in the manifest only for explicit selection; absent selection remains compatible with old CLI manifests. Resume must match snapshot and selection before reading its cache. Never relax existing per-pair request/model/rubric validation.

- [ ] **Step 4: Add guard/progress failure RED tests.** A guard that returns `authorization_expired` must produce zero adapter calls and only non-submitted failures. A second guard invocation may fail after one success; that success survives. A callback must observe the attempt-start manifest before its adapter executes. Callback/storage failure prevents further scheduling and becomes `LocalStorageFailure`, with no provider error body exposed.

```python
def test_dispatch_guard_prevents_inference(snapshot_factory, tmp_path):
    import asyncio
    from backend.evidence_review.artifacts import ArtifactStore
    from backend.evidence_review.contracts import Limits
    from backend.evidence_review.runner import evaluate_snapshot
    from backend.evidence_review.units import build_review_plan
    from backend.tests.evidence_review.test_runner import ScriptedEvaluator
    async def scenario():
        snap = snapshot_factory()
        adapter = ScriptedEvaluator()
        with ArtifactStore.create(tmp_path / "private", run_id="guard") as store:
            result = await evaluate_snapshot(snap, build_review_plan(snap, limits=Limits()),
                adapter=adapter, store=store, limits=Limits(), cancel=asyncio.Event(),
                before_attempt=lambda: "authorization_expired")
            assert adapter.bodies == []
            assert all(a.outcome is None or not a.outcome.submitted for a in result.attempts)
            assert all(a.status != "completed" for a in result.assessments)
    asyncio.run(scenario())
```

- [ ] **Step 5: Run RED, implement hooks, then GREEN.** Run the new guard test before implementation; expected unexpected-keyword failure. Invoke the guard synchronously immediately before each adapter call/retry, after durable attempt start and before marking submitted. Convert guard failure into a fixed `AttemptOutcome(submitted=False, stop_evaluator=True)`. Invoke `on_commit(store.load_run())` only after a successful manifest commit; stop scheduling if projection persistence fails. Run `.venv/bin/python -m pytest backend/tests/evidence_review -q`; expected all existing and new tests pass, including CLI resume and forged-plan rejection.
- [ ] **Step 6: DOX and commit.** Explain optional caller guards/selection while preserving the evaluator's independence from app authority. `git add backend/evidence_review/units.py backend/evidence_review/runner.py backend/evidence_review/AGENTS.md backend/tests/evidence_review/test_selection.py backend/tests/evidence_review/test_runner.py` then `git commit -m "feat: support validated selected evidence review"`.

### Task 2: Retrieve bounded original abstracts and preserve research generation provenance

**Files:** Create `backend/evidence_review/pubmed.py`, `backend/tests/evidence_review/test_pubmed.py`, `backend/tests/test_ai_evidence_provenance.py`; modify `backend/clinical/models.py`, `ai_repository.py`, `ai_live.py`, applicable DOX. Read `capture_worker.py` and reuse `EvidenceCollector`; do not change the isolated capture CLI's generation contract.

**Interfaces:**
- `canonical_pmid(url: str) -> str | None` accepts only `https://pubmed.ncbi.nlm.nih.gov/` followed by 1–12 decimal digits and `/`, with no query/fragment/credentials/port.
- `async fetch_pubmed_evidence(sources: tuple[Source, ...], *, client: httpx.AsyncClient, limits: Limits, before_request: Callable[[], str | None]) -> tuple[tuple[Evidence, ...], tuple[CaptureExclusion, ...]]`.
- `parse_pubmed_xml(body: bytes, sources: tuple[Source, ...], *, limits: Limits) -> tuple[tuple[Evidence, ...], tuple[CaptureExclusion, ...]]` is pure, has no URL loading and returns per-source completeness/exclusions.
- `AILiveRepository.record_research_generation(session_id: str, tool_id: str, *, provider: str, model: str) -> None` and `research_generation(session_id: str, tool_id: str) -> dict[str, str | None]` return `{providerId, modelId, recordedAt}`; absent record returns null values.

- [ ] **Step 1: Add RED source tests.** Use `httpx.MockTransport` and the network-blocking evidence fixture. Assert the outgoing destination is exactly `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi`, with `db=pubmed`, `retmode=xml` and numeric IDs; never a citation URL. A 302 is unavailable with zero follow-up requests. Include whitespace, entity-encoded Unicode text, labeled sections, empty abstract, 10,001-character abstract, wrong PMID, duplicate conflicting PMID, 65 sections and oversized body.

```python
@pytest.mark.parametrize("url", [
    "http://pubmed.ncbi.nlm.nih.gov/123/", "https://pubmed.ncbi.nlm.nih.gov.evil.test/123/",
    "https://user@pubmed.ncbi.nlm.nih.gov/123/", "https://pubmed.ncbi.nlm.nih.gov/123/?x=1",
    "https://127.0.0.1/123/", "https://pubmed.ncbi.nlm.nih.gov/123/#abstract",
])
def test_noncanonical_source_never_becomes_a_fetch_target(url):
    from backend.evidence_review.pubmed import canonical_pmid
    assert canonical_pmid(url) is None
```

Add a normal `PubmedArticleSet` document with its external public DOCTYPE and no entity declarations; expect successful parsing without fetching its DTD. Add internal/external entity declarations and excessive nesting; expect fixed parsing exclusions, never expansion or leaked parser text.

- [ ] **Step 2: Run RED.** `.venv/bin/python -m pytest backend/tests/evidence_review/test_pubmed.py -q`; expected new-module/function failures.
- [ ] **Step 3: Implement fixed transport and safe extraction.** Deduplicate PMIDs for retrieval but project the original citation IDs separately. Bound the streamed body to 2 MiB, reject compressed responses/redirects and enforce the caller's preparation deadline. No credentials or original research query goes to NCBI. Use the existing HTTP client's fixed timeout policy; recheck the guard before every request.

Use standard-library Expat with an `ElementTree.TreeBuilder`: count nodes (maximum 50,000) and nesting (maximum 64), reject `EntityDeclHandler`, `UnparsedEntityDeclHandler`, and `ExternalEntityRefHandler`, and disable parameter-entity parsing. An ordinary DOCTYPE declaration without an internal subset may be present but is never fetched. Raise only `ValueError("invalid_pubmed_xml")` outside the parser. Bound input before parsing, reject duplicate PMID articles, and feed the matching article plus frozen source into `EvidenceCollector`.

```python
PMID_URL = re.compile(r"https://pubmed\.ncbi\.nlm\.nih\.gov/([0-9]{1,12})/\Z")
def canonical_pmid(url: str) -> str | None:
    match = PMID_URL.fullmatch(url)
    return match.group(1) if match else None

def reject_entity(*args):
    raise ValueError("invalid_pubmed_xml")

parser.EntityDeclHandler = reject_entity
parser.UnparsedEntityDeclHandler = reject_entity
parser.ExternalEntityRefHandler = reject_entity
parser.SetParamEntityParsing(xml.parsers.expat.XML_PARAM_ENTITY_PARSING_NEVER)
```

Noncanonical sources receive `non_pubmed_source` exclusions. Missing article or malformed response produces unavailable evidence with empty sections and hashes of those exact sections, or a capture exclusion when no valid evidence record can be constructed. Absent/truncated evidence remains visible but cannot enter executable pairs. Retain extraction version `ncbi-abstract-v1` and retrieval time; do not fabricate original research-time provenance.

- [ ] **Step 4: Add RED provenance regression.** Seed a research tool, dispatch a fake NIM supervisor, then change account research settings before reading its saved result. Assert saved provenance remains `nvidia_nim` and the dispatched exact model; old tools return null rather than the current model. Check the primary-provider tool response is byte-equivalent to the original result and contains no new review/provenance metadata.

```python
def test_unrecorded_generation_is_unknown(live):
    from backend.tests.test_ai_live import runtime_for
    runtime = runtime_for(live)
    value = live.service.repository.research_generation(runtime.id, "old-tool")
    assert value == {"providerId": None, "modelId": None, "recordedAt": None}
```

Run `.venv/bin/python -m pytest backend/tests/test_ai_evidence_provenance.py -q`; expected missing repository method.
- [ ] **Step 5: Implement additive provenance persistence.** Add `AIResearchGenerationModel` keyed by the existing composite tool record ID; store session ID, exact provider/model and dispatch timestamp. Record only server-resolved values immediately before `ResearchSupervisor.run()`. Do not add columns requiring an implicit migration to old tool tables. Delete these rows with source history. The endpoint/service later reads this table; the original result and primary-model response remain unchanged.
- [ ] **Step 6: GREEN, DOX and commit.** Run source tests, provenance tests and `backend/tests/test_ai_research.py`, `backend/tests/test_ai_live.py`. Expected unchanged worker isolation and both research providers' behavior. Document recorded versus unknown generation provenance in clinical DOX and fixed public-source retrieval in evidence DOX. Commit the explicitly listed files with `feat: freeze original PubMed evidence and research provenance`.

### Task 3: Build owned review jobs, immutable artifacts and cancellation authority

**Files:** Create `backend/clinical/ai_evidence_contracts.py`, `ai_evidence_repository.py`, `ai_evidence_artifacts.py`, `ai_evidence_review.py`, `backend/tests/test_ai_evidence_review.py`; modify `.gitignore`, `backend/clinical/models.py`, `ai_config.py`, `ai_live.py`, `backend/server.py`, `backend/evidence_review/artifacts.py`, `backend/tests/evidence_review/test_artifacts.py`, `backend/tests/test_ai_live.py`, owning DOX.

**Interfaces:**
- Consumes Task 1's runner/selection/hooks, Task 2's fetcher/provenance and existing `AILiveService.require_actor`, `owner_lock`, `AILiveRepository.owned(..., active=False)`, `tool(...)` and actual clinical repository engine/session factory.
- `EvidenceReviewService(live: AILiveService)` is composed once as `live.evidence_reviews`; it does not instantiate another Live service.
- Service methods: `async prepare(actor: SessionClaims, session_id: str, tool_id: str, request: EvidencePrepareRequest) -> EvidenceReviewDetail`; `get(actor, review_id: str) -> EvidenceReviewDetail`; `list(actor, session_id: str) -> EvidenceReviewList`; `async start(actor, review_id: str, request: EvidenceStartRequest) -> EvidenceReviewDetail`; `async retry(actor, review_id: str, request: EvidenceRetryRequest) -> EvidenceReviewDetail`; `async cancel(actor, review_id: str) -> EvidenceReviewDetail`; `async stop_owner(owner: str, *, reason: str) -> None`; `async delete_source(actor, session_id: str) -> None`; `recover() -> None`; `async shutdown() -> None`; `availability() -> EvidenceReviewAvailability`.
- Repository methods: `create_owned(actor, session_id, tool_id, request) -> AIJevReviewModel`, `owned(actor, review_id) -> AIJevReviewModel`, `list_owned(actor, session_id, limit=100) -> list[AIJevReviewModel]`, `claim_operation(actor, review_id, operation, key, request_hash) -> bool` (true only when newly claimed), `update_if_current(review_id, generation, **values) -> bool`, `mark_source_deleting(owner, session_id) -> list[AIJevReviewModel]`, `delete_source(owner, session_id) -> None`, `recover() -> None`. Actor arguments are `SessionClaims`; IDs/keys/hashes/operations are strings; generation is an integer. These use database transactions and fixed domain errors; only service methods return public DTOs.
- Service dispatch helper: `dispatch_block_reason(actor: SessionClaims, review_id: str, generation: int) -> str | None` checks the immutable source binding, generation, mode, cancellation and actor expiry without performing network I/O.
- Artifact wrapper: `ReviewArtifacts(root: Path, run_id: str)` exposes `create_preview(snapshot: Snapshot, plan: ReviewPlan, generation: dict) -> tuple[str, str]` (immutable object reference and preview hash), `read_preview(ref: str) -> dict`, `open_run() -> ArtifactStore`, `delete() -> None`. `ArtifactStore.delete_run(root: Path, *, run_id: str) -> None` performs locked descriptor-relative removal without following symlinks.

Define strict, extra-forbidden request models with camelCase aliases: `EvidencePrepareRequest(idempotency_key: str)`, `EvidenceStartRequest(idempotency_key: str, preview_sha256: str, selected_unit_ids: tuple[str, ...], confirmation: Literal['public_literature','synthetic'])`, `EvidenceRetryRequest(idempotency_key: str, preview_sha256: str, confirmation: Literal['public_literature','synthetic'])`. Bound keys to 1–80 safe characters, hashes to 64 lowercase hex, selected IDs to at most 40 unique bounded strings. Retry cannot supply a new selection. No `actor`, source text, URL, path, model or query fields.

Public DTO fields (use these exact camelCase wire names; Python fields use snake_case):

| Type | Fields |
| --- | --- |
| `EvidenceReviewAvailability` | `modelId: 'jev-1.13.0'`, `availability: 'configured'|'missing'|'disabled'|'unavailable'`, `reason: string` |
| `EvidenceGeneration` | `providerId: string|null`, `modelId: string|null`, `recordedAt: string|null` |
| `EvidenceReviewSummary` | `reviewId`, `sessionId`, `toolCallId`, `sourceContextVersion: number`, `status`, `createdAt`, `updatedAt`, `modelId`, `generation`, `totalPairs: number`, `completedPairs: number`, `settledPairs: number`, `submittedAttempts: number`, `unknownUsageAttempts: number`, `reason: string|null` |
| `EvidenceClaim` | `unitId`, `text`, `start: number`, `end: number`, `evidenceIds: string[]`, `eligible: boolean`, `exclusionReason: string|null` |
| `EvidenceAbstract` | `evidenceId`, `citationId`, `title`, `pmid`, `url`, `retrievedAt`, `completeness`, `sections: {label: string|null, text: string}[]`, `textSha256`, `extractionVersion` |
| `EvidenceAttempt` | `attemptId`, `pairId`, `requestSha256`, `startedAt`, `endedAt: string|null`, `submitted: boolean|null`, `reason: string|null`, `usage: {input_tokens: number, output_tokens: number}|null` |
| `EvidenceAssessment` | `pairId`, `unitId`, `evidenceId`, `status`, `reason: string|null`, `label: five-label union|null`, `requestedModel`, `resolvedModel: string|null`, `rubricVersion`, `rubricSha256`, `answerSha256`, `abstractSha256`, `requestSha256: string|null`, `attemptIds: string[]`, `reused: boolean`, `probabilities: five-label numeric map|null` |
| `EvidenceReviewDetail` | Summary fields plus `previewSha256: string|null`, `answerSha256: string|null`, `snapshotSha256: string|null`, `originalAnswer: string|null`, `claims: EvidenceClaim[]`, `abstracts: EvidenceAbstract[]`, `exclusions: {unitId: string|null, citationId: string|null, reason: string}[]`, `selectedUnitIds: string[]|null`, `assessments: EvidenceAssessment[]`, `attempts: EvidenceAttempt[]`, `earlierAttemptCount: number` |
| `EvidenceReviewList` | `reviews: EvidenceReviewSummary[]`, `truncated: boolean` |

Keep full original abstract sections once per evidence ID, rather than repeating them per assessment. Return the newest 200 attempts and an explicit `earlierAttemptCount`; all attempts remain in immutable private artifacts. Never expose filesystem locators, stored query/arguments, raw exception strings or tokens. `submitted: null` means an attempt-start was committed but its outcome was never committed; usage is unknown. Return no fabricated label for any noncompleted assessment.

- [ ] **Step 1: Add isolated service fixtures and RED preview tests.** Extend the existing `live` fixture to erase TypeSafe environment credentials and point private artifacts at its temporary database directory. Block nonloopback sockets for these tests and replace PubMed/TypeSafe transports with `httpx.MockTransport`. Reuse `runtime_for(live)` only to seed an owned completed research result; close its voice session before review. Define this fixture helper in the new test file:

```python
def seed_research(live, *, tool_id="public-research", summary="Synthetic finding [s1]."):
    from backend.tests.test_ai_live import runtime_for
    runtime = runtime_for(live)
    repo = live.service.repository
    repo.add_tool(runtime.id, tool_id, "research_run", {"query": "PRIVATE_QUERY_SENTINEL"}, 1, False)
    repo.set_tool(runtime.id, tool_id, "completed", {"summary": summary,
        "sources": [{"id": "s1", "title": "Synthetic public fixture",
                     "url": "https://pubmed.ncbi.nlm.nih.gov/123/"}], "limitations": []})
    return runtime.id, tool_id
```

Test prepare returns immediately with an owned ID, then the background task reaches ready with exact answer/source bytes and zero TypeSafe calls. Wait on that task in service tests, not a timed sleep. Test another actor cannot get/list/start/cancel it; failed/nonresearch/non-PubMed-only tools cannot prepare. Tamper the stored tool result between prepare and start and require 409 with zero submissions.
- [ ] **Step 2: Run RED.** `.venv/bin/python -m pytest backend/tests/test_ai_evidence_review.py -q`; expected missing service/contracts, not real network use.
- [ ] **Step 3: Implement persistence and frozen preparation.** Add `AIJevReviewModel` and `AIJevOperationModel` via existing `Base.metadata.create_all`. Review rows contain owner/source IDs/context version, source-result hash, preview object reference/hash, artifact run ID, status, selection/confirmation, operation generation, timestamps and bounded progress JSON. Operation rows have a unique `(owner, operation, idempotency_key)` plus request hash/review ID. Never use an upsert to recreate a deleted review. Repository updates require matching generation and an existing nondeleting source.

Resolve storage beside the **actual repository database**, under `.ai-evidence/`; add `.ai-evidence/` to the root ignore rules and prove it with `git check-ignore backend/.ai-evidence/probe`. Non-file-backed databases require explicit backend `RADSYSX_AI_EVIDENCE_DIR`. Existing POSIX ownership/mode/hash checks remain mandatory. Unsupported storage returns unavailable instead of using a temporary public directory. Add `typesafe_api_key` as a redacted `SecretStr` and `evidence_dir` setting; resolve the TypeSafe setting only after the research/pilot enablement check. Missing key permits preview, but rejects start/retry with 503 before allocating inference.

Freeze only allowlisted result fields and the separately recorded generation metadata. Do not reuse the Gemini-only capture assembler. Build the original `Snapshot`/full `ReviewPlan`, save a hashed preview envelope, then publish ready. The preview's candidate literature designation does not authorize transmission: confirmation exists only in the start envelope. Persist source-result hash separately and check it at start and dispatch. Label source retrieval as occurring for this review.

```python
preview_identity = {"snapshotSha256": snapshot.snapshot_sha256,
    "plan": plan.model_dump(mode="json"), "modelId": "jev-1.13.0",
    "rubricVersion": RUBRIC_VERSION, "rubricSha256": RUBRIC_SHA256,
    "generation": generation}
preview_sha256 = sha256_bytes(canonical_json(preview_identity))
```

Import both rubric constants from `backend.evidence_review.rubric`. Reject start/retry if the running rubric/model differs from the saved preview; changing software must not silently change what the user confirmed.

- [ ] **Step 4: Add RED lifecycle, identity and privacy tests.** Gate fake retrieval/inference with `asyncio.Event`, and coordinate events rather than sleeps. Cover all cases in this matrix:

| Condition | Required assertion |
| --- | --- |
| None/false/deidentified confirmation; changed hash; empty, unknown or duplicate IDs | Rejected before any TypeSafe request |
| Two starts with the same key, and two different keys while active | One evaluation task and one request per selected pair/attempt |
| Second active job for actor; third actor globally | 409 without allocating network work; ready previews do not reserve capacity |
| Claim excluded by user | Its text never appears in captured TypeSafe request bodies |
| Source args/context contain query, patient, image, report, session sentinels | No sentinel appears in reviewer bytes; only selected claim and original abstract sections are variable state |
| Cancel before submit, during submit and during retry backoff | No later scheduling; completion already committed survives; submitted attempts without receipts retain unknown usage |
| Logout/expiry or credential/model mutation during preparation/inference | Account work stops before further external calls; other account unaffected |
| End voice or change viewport | Review retains source identity and continues independently |
| Delete source while inference is blocked, then release late result | No source/review/artifact resurrection and no new submission |
| Restart with ready/preparing/reviewing records | Preparing/reviewing become interrupted without HTTP calls; ready previews remain readable with a fresh authorized actor |
| Missing/corrupt artifact, unsafe permissions or symlink | Unavailable/fixed error; no reconstruction or inference on GET |
| Projection/manifest write fails after an attempt starts | Stop scheduling; preserve committed record; do not claim an uncommitted receipt |

Add explicit resume test: first selected pair completes, second fails; retry keeps the identical preview/selection and only submits the unfinished pair, preserving old attempts. All-completed retry reads saved results. Old unfinished preparation without a complete preview requires a new preparation instead of inference.
- [ ] **Step 5: Implement job boundaries.** Use the existing account lock for prepare/start/retry and account mutation; use a source-operation lock for deletion/cancel transitions and a short global reservation lock for two-slot admission. Never hold a lock while awaiting HTTP or a task that needs it. Reserve capacity, persist operation generation, create task; release on every terminal path. Worker updates are conditional on generation/source state.

Preparation has a 20-second timeout. Each evaluation has the existing 60-second runner deadline plus five-second cleanup; total active preparation/evaluation work for a review operation stays below 90 seconds. Preview waiting is idle; retry has a fresh bounded explicit operation. Cancel the parent task/transport when expiry, shutdown or deletion occurs, set its cancellation event, then join with the cleanup ceiling. Recheck actor expiry, mode/enabled state, source existence/hash, operation generation and cancel event before **each** NCBI/TypeSafe request. Run an expiry watcher while a task is blocked, so an in-flight request cannot continue until the next dispatch check.

Compose `before_attempt` and `on_commit` without passing the actor or source context to the pure evaluator. The latter writes counts only from the newly committed `RunView`. GET during an active job reads through its existing artifact handle on the event loop; it must not acquire a second exclusive writer lock or submit work. Inactive GET opens the store normally, verifies hashes and projects records. The immutable preview object remains DB-referenced while the evaluator writes newer manifests; never auto-promote unreferenced files.

```python
def before_attempt():
    if cancel.is_set():
        return "cancelled"
    return self.dispatch_block_reason(actor, review_id, generation)

# dispatch_block_reason is a service helper returning None or a fixed reason;
# it checks expiry, mode, source/result identity and the persisted generation.
```

Use pinned `TypeSafeAdapter` and existing bounded HTTP client. Never feed review results to `tool_response` or primary-model context. Status derives from committed counts: all selected pairs completed → completed; some → partial; none → failed unless explicitly cancelled/interrupted/unavailable. Semantic label and operation status remain separate.

- [ ] **Step 6: Implement safe deletion and global lifecycle composition.** Add descriptor-relative `ArtifactStore.delete_run`: validate generated name, verify root/run ownership, acquire its nonblocking writer lock, reject symlinks/nonregular entries and remove only the known run's objects/manifests/exports/HEAD/lock. Test a hostile symlink leaves an outside sentinel untouched. Service deletion first marks the source deleting/increments generations, cancels and joins linked jobs, closes handles, deletes artifacts, then deletes DB records/source history. Failure leaves a recoverable deletion marker and fixed error; retry or startup finishes cleanup without inference. Late callbacks only update existing matching rows.

`AILiveService.stop_owner` stops review work even when there is no open voice session. `shutdown` also stops reviews. Startup calls review `recover` after database initialization. `/sessions/{id}/close` keeps reviews; source DELETE is routed through `delete_source` in Task 4. Existing logout already invokes `stop_owner`. During source deletion, acquire the same owner/session boundary as session attachment to prevent a fresh connection escaping cleanup.
- [ ] **Step 7: GREEN, DOX and commit.** Run `.venv/bin/python -m pytest backend/tests/test_ai_evidence_review.py backend/tests/evidence_review backend/tests/test_ai_live.py backend/tests/test_ai_credentials.py backend/tests/test_ai_research_settings.py -q`. Expect all privacy/lifecycle/storage tests and old CLI behavior pass. Update clinical/evidence/test DOX to describe authority and pure reuse accurately. Commit the explicitly changed files with `feat: add owned cancellable Jev review jobs`.

### Task 4: Expose strict same-origin contracts and settings availability

**Files:** Create `backend/clinical/ai_evidence_routes.py`, `backend/tests/test_ai_evidence_routes.py`; modify `backend/clinical/ai_routes.py`, `contracts.py`, `ai_live.py`, `packages/clinical-web/src/contracts.ts`, `client.ts`, `viewer/assets/live/protocol.ts`, `viewer/scripts/live-contracts.ts`, applicable DOX.

**Interfaces:**
- Consumes Task 3 DTOs/service. `evidence_router(service: EvidenceReviewService, actor_for_request: Callable) -> APIRouter` mounts inside `live_router` so tests and production use the same composition and cookie manager.
- Endpoints are the six paths in the approved spec: prepare, session list, detail GET, start, retry and cancel. `GET /capabilities` gains `evidenceReview: EvidenceReviewAvailability` for the settings row; key presence is configuration only.
- Shared browser methods: `prepareAIEvidenceReview(sessionId: string, toolCallId: string, request: EvidencePrepareRequest): Promise<EvidenceReviewDetail>`, `listAIEvidenceReviews(sessionId: string): Promise<EvidenceReviewList>`, `getAIEvidenceReview(reviewId: string, signal?: AbortSignal): Promise<EvidenceReviewDetail>`, `startAIEvidenceReview(reviewId: string, request: EvidenceStartRequest): Promise<EvidenceReviewDetail>`, `retryAIEvidenceReview(reviewId: string, request: EvidenceRetryRequest): Promise<EvidenceReviewDetail>`, `cancelAIEvidenceReview(reviewId: string): Promise<EvidenceReviewDetail>`. Mirror the types in the viewer protocol following its existing build pattern and compile structural equality assertions.

- [ ] **Step 1: Add RED API tests with the existing `live` fixture.** Mount through `live_router`, authorize using `authorize(client, live)`, and seed the Task 3 research helper. Every success/error must have `Cache-Control: no-store`. Parameterize all paths for missing/expired/wrong-owner cookie, missing `ai.run`, disallowed/missing write Origin and clinical/disabled mode; assert zero outbound calls. READ with no Origin is allowed with a valid cookie; a provided hostile Origin is rejected.

```python
def test_prepare_requires_origin_and_never_echoes_extra_text(live):
    from fastapi.testclient import TestClient
    from backend.tests.test_ai_live import authorize, ORIGIN
    from backend.tests.test_ai_evidence_review import seed_research
    sid, tid = seed_research(live)
    path = f"/api/ai/sidebar/sessions/{sid}/tools/{tid}/evidence-reviews"
    with TestClient(live.app) as client:
        authorize(client, live)
        assert client.post(path, json={"idempotencyKey": "prepare-1"}).status_code == 403
        bad = client.post(path, json={"idempotencyKey": "prepare-1", "text": "PRIVATE_SENTINEL"},
                          headers={"origin": ORIGIN})
        assert bad.status_code == 422
        assert "PRIVATE_SENTINEL" not in bad.text
        assert bad.headers["cache-control"] == "no-store"
```

Also test oversized/chunked JSON, duplicate JSON keys, arrays, NaN, invalid UTF-8, unknown fields and content type. Preparation/start/retry bodies cap at 16 KiB; cancel accepts no body or `{}` only. Query/path IDs are bounded; no raw input is echoed. List returns at most 100 summaries plus `truncated`, sorted newest first.
- [ ] **Step 2: Run RED.** `.venv/bin/python -m pytest backend/tests/test_ai_evidence_routes.py -q`; expect missing-route 404 where the tests require explicit contract status.
- [ ] **Step 3: Implement route guards and DTO validation.** Authenticate/mode-check before body parsing. Stream and bound raw JSON; use the strict JSON parser's duplicate-key/NaN rejection, then `model_validate_json`, catching validation errors into fixed 422 messages without `.errors()` input details. Require explicit allowed Origin for mutations. Wrap success and HTTP errors with no-store; fixed 404 for missing/foreign source/review, 409 for busy/identity conflict, 422 for malformed selection, 503 for unavailable key/storage. Do not change unrelated global FastAPI validation behavior.

```python
def private_response(value):
    return JSONResponse(value.model_dump(mode="json", by_alias=True),
                        headers={"Cache-Control": "no-store"})
```

Route existing source-history DELETE through `await service.evidence_reviews.delete_source(claims, session_id)` so review shutdown/artifact removal precede history deletion. Keep voice-close separate. Fixed errors should identify review conflicts without telling users to reconnect live voice.
- [ ] **Step 4: Add shared contracts and client methods.** Mirror Task 3's enums/nullability/bounds. Use included cookies and `cache: 'no-store'`, encode path IDs, and accept `AbortSignal` for poll cancellation. Fixed client error messages must not reflect arbitrary backend bodies. Add `EvidenceReviewDetail`, `EvidenceStartRequest`, `EvidenceRetryRequest` and availability to `viewer/scripts/live-contracts.ts` type assertions. No keys are returned through capabilities or settings.
- [ ] **Step 5: GREEN, DOX and commit.** Run API tests, `.venv/bin/python -m pytest backend/tests/test_security_regressions.py -q`, `npm run type-check`. Expected shared/frontend/viewer shape checks and existing auth boundaries pass. Update clinical/package DOX, then commit the listed files with `feat: expose authenticated evidence review contracts`.

### Task 5: Present the explicit review flow inside research cards

**Files:** Create `viewer/assets/live/evidence.ts`, `evidence-panel.ts`, `viewer/scripts/test-evidence.mjs`; modify `viewer/assets/live/controller.ts`, `panel.ts`, `viewer/assets/radsysx-viewer.css`, `viewer/package.json`, `viewer/scripts/test-live.mjs`, relevant DOX.

**Interfaces:**
- `EvidenceController(notify: () => void, fetcher: typeof fetch = fetch)` owns review UI state independently of audio. It exposes `sessionId: string | undefined`, `reviews: Map<string, EvidenceReviewSummary>`, `detail: EvidenceReviewDetail | undefined`, `selectedUnitIds: Set<string>`, `confirmation: 'public_literature'|'synthetic'|null`, `busy: boolean`, `message: string`, and `open: boolean`.
- Methods: `async selectSession(sessionId: string | undefined): Promise<void>`, `async openTool(toolCallId: string): Promise<void>`, `setSelected(unitId: string, selected: boolean): void`, `setConfirmation(value: 'public_literature'|'synthetic'|null): void`, `async start(): Promise<void>`, `async retry(): Promise<void>`, `async cancel(): Promise<void>`, `async refresh(): Promise<void>`, `close(): void`, `dispose(): void`. `openTool` reuses an existing saved review before preparing a new one.
- `renderEvidenceSummary(summary: EvidenceReviewSummary): string`, `renderEvidenceDetail(detail: EvidenceReviewDetail): string`, and `mountEvidencePanel(host: HTMLElement, controller: EvidenceController): {update(): void, dispose(): void}` keep rendering/handlers separate from network lifecycle.
- `LiveController.evidence` owns the persistent instance. Current session/history identity is explicitly passed to `selectSession`; closing voice does not dispose this instance or post review cancel. Actual component disconnect disposes polling subscriptions; remount reloads owned summaries without replaying inference.

- [ ] **Step 1: Add controller RED tests.** Extend `test:live` to compile once then run both `test-live.mjs` and `test-evidence.mjs`. Inject a fake fetcher to inspect exact HTTP bodies. Use Node test mock timers for 1/2/4-second polling backoff; no sleep-based tests. Verify prepare → ready makes zero start calls, start is blocked until confirmation and nonempty selection, repeat click makes one operation, retry carries the original hash/confirmation with no editable selection, and GET/reopen never posts start.

```javascript
test('an old session response cannot replace the current review', async () => {
  let resolveOld;
  const old = new Promise(resolve => { resolveOld = resolve; });
  const fetcher = async url => String(url).includes('/sessions/old/')
    ? old : new Response(JSON.stringify({ reviews: [], truncated: false }));
  const controller = new EvidenceController(() => {}, fetcher);
  const pending = controller.selectSession('old');
  await controller.selectSession('new');
  resolveOld(new Response(JSON.stringify({ reviews: [], truncated: false })));
  await pending;
  assert.equal(controller.sessionId, 'new');
  assert.equal(controller.reviews.size, 0);
  controller.dispose();
});
```

Also test a late detail poll from another review, failure after unmount, 401/403 stopping polling, temporary network failure retaining saved data with a fixed retry message, and settings/model changes clearing consent without applying an older response. Use request IDs/hash to keep an uncertain start's idempotency key stable on retransmission.
- [ ] **Step 2: Run RED.** `npm run test:live --workspace viewer`; expected missing compiled evidence module/new behavior, while previous controller tests remain meaningful.
- [ ] **Step 3: Implement independent state and bounded polling.** All requests use cookies/no-store/fixed errors and an AbortController. Increment a local generation on session/review change and check it after every awaited result, even if the fetch implementation ignores abort. Only one poll is in flight; schedule after it settles, at 1, 2 then at most 4 seconds. Stop active polling after 100 seconds and show an explicit Refresh review action; a refresh only GETs. Closing the card keeps active card status polling; selecting a different conversation/unmount stops old polling, while its backend job continues. Ready and terminal states need no automatic poll.

```typescript
const generation = ++this.generation;
this.abort?.abort();
this.abort = new AbortController();
const response = await this.fetcher(path, {
  credentials: 'include', cache: 'no-store', signal: this.abort.signal,
});
if (generation !== this.generation) return;
```

Track selection/confirmation locally only for the currently displayed immutable preview. Do not store them in localStorage or infer them from image attestation. Freeze selected IDs once a start is accepted; clear confirmation after any attempted start/retry and on preview/account/session change. Reconnection or ordinary transcript rendering cannot automatically select, confirm or submit anything.

- [ ] **Step 4: Add rendering/interaction RED tests.** Add fixtures with all five labels, partial failure, absent/truncated sources, user exclusion, unknown generation, unknown usage, reused assessment, HTML-injection strings, long model IDs, Unicode and two contradictory source assessments for one claim. Assert escaped text and real canonical PubMed links, full original abstract sections, “fetched for this review”, and absence of global Verified wording or disease-probability copy.

```javascript
test('review markup escapes source text and keeps unavailable evidence distinct', () => {
  const detail = reviewFixture({
    originalAnswer: '<img src=x onerror=alert(1)> [s1].',
    status: 'partial',
    exclusions: [{ unitId: null, citationId: 's2', reason: 'abstract_truncated' }],
  });
  const html = renderEvidenceDetail(detail);
  assert.ok(html.includes('&lt;img'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('Not reviewed'));
  assert.ok(!html.includes('Verified'));
});
```

Define this complete synthetic `reviewFixture` in `test-evidence.mjs`. Hash strings here are wire-format fixtures, not a claim of real execution. Production rendering tests must not read real saved conversations.

```javascript
function reviewFixture(overrides = {}) {
  const hash = 'a'.repeat(64), time = '2026-09-22T00:00:00Z';
  const text = 'Synthetic finding [s1].';
  return {
    reviewId: 'jer-fixture', sessionId: 'ais-fixture', toolCallId: 'research-fixture',
    sourceContextVersion: 1, status: 'completed', createdAt: time, updatedAt: time,
    modelId: 'jev-1.13.0', generation: { providerId: null, modelId: null, recordedAt: null },
    totalPairs: 1, completedPairs: 1, settledPairs: 1, submittedAttempts: 1,
    unknownUsageAttempts: 0, reason: null, previewSha256: hash, answerSha256: hash,
    snapshotSha256: hash, originalAnswer: text,
    claims: [{ unitId: 'u1', text, start: 0, end: text.length, evidenceIds: ['e1'],
               eligible: true, exclusionReason: null }],
    abstracts: [{ evidenceId: 'e1', citationId: 's1', title: 'Synthetic fixture', pmid: '123',
      url: 'https://pubmed.ncbi.nlm.nih.gov/123/', retrievedAt: time, completeness: 'complete',
      sections: [{ label: null, text: 'Synthetic finding.' }], textSha256: hash,
      extractionVersion: 'ncbi-abstract-v1' }],
    exclusions: [], selectedUnitIds: ['u1'],
    assessments: [{ pairId: 'p1', unitId: 'u1', evidenceId: 'e1', status: 'completed', reason: null,
      label: 'supported', requestedModel: 'jev-1.13.0', resolvedModel: 'jev-1.13.0',
      rubricVersion: 'abstract-support-v1', rubricSha256: hash, answerSha256: hash,
      abstractSha256: hash, requestSha256: hash, attemptIds: ['a1'], reused: false,
      probabilities: { supported: 1, partially_supported: 0, contradicted: 0, mixed: 0, not_addressed: 0 } }],
    attempts: [{ attemptId: 'a1', pairId: 'p1', requestSha256: hash, startedAt: time,
      endedAt: time, submitted: true, reason: null, usage: { input_tokens: 10, output_tokens: 1 } }],
    earlierAttemptCount: 0, ...overrides,
  };
}
```
- [ ] **Step 5: Implement stable card controls and settings row.** Show the action only on eligible completed `research_run` cards; other cards state a short eligibility reason. Put a summary/status line on the card even when details are collapsed. Within details, render original answer, individually selectable eligible claims, source sections/completeness/exclusions, destination and public/synthetic confirmation. Start, cancel and retry buttons reflect the server state. Use native details/summary and associated checkbox/select labels with unique IDs derived from backend opaque IDs; all text and attributes are escaped.

Use the exact five label strings from the spec. Separate counts for completed judgments versus settled failures. Receipts show generation (Unknown when absent), requested/resolved Jev model, rubric version/hash, answer/snapshot/abstract/request hashes, retrieval/attempt times, submitted/new/reused and reported/unknown usage. Put model probabilities in optional details with “Model output; not a probability of clinical truth.” Show `earlierAttemptCount` explicitly when only the latest attempts are displayed. Never fabricate a rationale or highlighted supporting quote.

Keep the mounted consent controls stable while polling/transcripts update; patch status/result regions instead of replacing focused DOM. On a truly different preview, clear consent and selection intentionally. In Settings, add a single Jev row from capabilities with the pinned model and configured/missing/disabled/unavailable state; use “Configured” only for key readiness, and “Completed” only for a saved receipt. No new header area or model dropdown. Retain all NVIDIA research choices.
- [ ] **Step 6: GREEN, DOX and commit.** Run `npm run test:live --workspace viewer`, `npm run type-check`, `npm run build --workspace viewer`. Expected old voice/media/settings tests and new review tests pass; generated viewer assets remain ignored. Update Live/assets/scripts/package DOX for the separate review controller and saved-history contract. Update the root lockfile only if its workspace metadata changes with the viewer script; do not change dependency resolutions. Commit explicit source/test/docs paths with `feat: add visible Jev review cards and receipts`.

### Task 6: Verify the real app path, obtain a live receipt and close out

**Files:** Modify `backend/clinical/ai_fixture_server.py`, `desktop/scripts/ui-import-smoke.mjs`, `desktop/tests/live-capture.test.mjs`; create `desktop/scripts/evidence-review-smoke.mjs`, `backend/tools/accept_jev_sidebar.py`, `roadmap/ai-backend/JEV_SIDEBAR_IMPLEMENTATION.md`; update root/clinical/evidence/tests/tools/viewer/desktop/roadmap DOX, `README.md`, `CLAUDE.md`, `WARP.md`, and this plan's execution stage. Read the complete relevant DOX chains before modifying them.

**Interfaces:**
- `node desktop/scripts/evidence-review-smoke.mjs` launches the existing guarded Electron harness with `--local-start --ai-live --openai --evidence-review`. The new flag is synthetic-only and incompatible with real OpenAI acceptance. It uses the actual backend router/service and production viewer bundle, with injected PubMed/TypeSafe HTTP transports only inside the already guarded fixture server.
- `.venv/bin/python -m backend.tools.accept_jev_sidebar --allow-live --env-file /absolute/operator/env/path` runs one clearly synthetic Jev acceptance through the real in-process HTTP routes/service, using a temporary private database, synthetic signed actor and deterministic abstract fixture. It resolves only `RADSYSX_TYPESAFE_AI_API_KEY` from the explicitly supplied file/environment. It never imports the production server's database, reads saved conversations, starts voice or calls other providers.
- The acceptance script's single synthetic claim is `The synthetic study reports 10 samples [s1].`; abstract is `The synthetic study reports 10 samples.`. Its mock source is titled `Synthetic acceptance fixture, not a real PubMed paper`. This fixture uses the canonical-source shape solely to exercise the normal prepare/confirm/start contract. Label the report “live TypeSafe with synthetic source”; this is not live NCBI retrieval or a diagnostic-quality benchmark.

- [ ] **Step 1: Add the guarded smoke scenario, initially RED.** In the synthetic fixture server, provide a completed research result with canonical source shape and deterministic XML, then use the real TypeSafe adapter against a local mock transport returning the pinned model, five-way distribution and token usage. A second response blocks until cancellation. The fixture starts only with `RADSYSX_DESKTOP_ALLOW_TEST_SHUTDOWN=1`; production settings must have no user-selectable fake provider URL.

The wrapper spawns the existing smoke with an allowlisted environment. Set all provider credentials to synthetic sentinels and private directories to its disposable workspace. Verify `publicChildEnvironment` still removes `RADSYSX_TYPESAFE_AI_API_KEY`; expand the existing environment test coverage rather than altering the broad filter.

```javascript
const result = spawnSync(process.execPath,
  ['desktop/scripts/ui-import-smoke.mjs', '--local-start', '--ai-live', '--openai', '--evidence-review'],
  { cwd: repoRoot, env: syntheticEnvironment, stdio: 'inherit' });
process.exitCode = result.status ?? 1;
```

Define `repoRoot` from `import.meta.url`; derive `syntheticEnvironment` using the existing public-child environment filter plus explicit synthetic values and test paths. Add UI assertions via the existing CDP client; do not replace the actual app with a screenshot mock. RED should identify the first missing fixture/action/assertion, not an accidental real-provider call.
- [ ] **Step 2: Drive the complete UI flow and GREEN.** The smoke must:

1. Import synthetic DICOM, open the actual sidebar and finish a synthetic research tool.
2. Open Review evidence with Jev; assert exact preview/source text and zero inference before confirmation.
3. Exclude a claim, confirm public/synthetic content, start and observe committed progress then a receipt.
4. Assert the original research answer and source identity remain byte-identical and the excluded text was never submitted.
5. End voice while a second review is active; assert review continues. Cancel it explicitly and verify cancelled status/unknown usage as applicable.
6. Reopen completed review from saved history; provider call count stays unchanged. Switch histories with a delayed poll and verify no wrong-card update.
7. Delete the source conversation and verify its review and private artifacts are gone.
8. Exercise keyboard focus/consent stability while polling; confirm no horizontal overflow at 280 px sidebar width. At 852 px height, collapsed review UI leaves at least 400 px for conversation while connected and introduces no extra always-visible header region. Check the full NVIDIA catalog count is unchanged.

Run `node desktop/scripts/evidence-review-smoke.mjs`. Expected one machine-readable synthetic pass report with request counts, receipt identity and layout measurements. Run the existing `node desktop/scripts/ui-import-smoke.mjs --local-start --ai-live --openai` only if shared fixture/control changes require revalidation beyond this smoke. Do not claim hardware microphone/speaker or real OpenAI acceptance from synthetic fixtures.
- [ ] **Step 3: Implement and test the explicit live acceptance utility.** Refuse without `--allow-live` before reading dotenv or creating HTTP clients. Use ignored private output under `tmp/jev-sidebar-acceptance/`, owner-only files/directories, and a temporary DB detached from the user's history. Construct the same `AILiveService`, signed-cookie session manager and router used in tests, seed only the fixed synthetic result, prepare via HTTP, wait for ready, post the exact preview hash/selection/`synthetic` confirmation, then GET the receipt. No browser path, key value or raw provider body may enter output.

Add utility tests under `backend/tests/test_ai_evidence_routes.py`: missing opt-in performs zero dotenv/network reads; mocked live execution calls TypeSafe exactly once, preserves result/receipt hash and cleans the temporary database; provider failure leaves an honest failed receipt and nonzero exit. The utility must not silently substitute a fixture response for TypeSafe when `--allow-live` is set.
- [ ] **Step 4: Run the one real TypeSafe acceptance.** Use the owner's already authorized backend key without copying it into this worktree:

```bash
.venv/bin/python -m backend.tools.accept_jev_sidebar --allow-live --env-file /Users/lazy/Documents/ChatGPT/RadSysX/.env.ai
```

Expected: a real `jev-1.13.0` resolved-model receipt, submission timestamps, request/answer/abstract hashes and provider-reported tokens for one synthetic claim. The exact semantic label is observed, not hardcoded as acceptance. Missing credential/quota/provider failure is an incomplete live acceptance, not a reason to invent success or substitute providers. Record only sanitized metadata and private artifact locator in the implementation runbook. Do not commit raw artifacts or credentials. Use the CLI's tested cancellation path if the call exceeds the bounded operation deadline.
- [ ] **Step 5: Run focused final verification once.** After all code changes:

```bash
.venv/bin/python -m pytest backend/tests/evidence_review backend/tests/test_ai_evidence_review.py backend/tests/test_ai_evidence_routes.py backend/tests/test_ai_evidence_provenance.py backend/tests/test_ai_live.py backend/tests/test_ai_credentials.py backend/tests/test_ai_research.py backend/tests/test_ai_research_settings.py backend/tests/test_ai_providers.py backend/tests/test_ai_openai.py backend/tests/test_ai_connection_races.py backend/tests/test_ai_screen_awareness.py backend/tests/test_security_regressions.py -q
.venv/bin/python -m compileall -q backend/clinical backend/evidence_review backend/tools/accept_jev_sidebar.py backend/server.py
npm run test:live --workspace viewer
npm run test:live --workspace desktop
npm run type-check
npm run build --workspace viewer
git diff --check
```

Expected: all selected checks pass. Run the guarded Electron smoke against the latest generated bundle, reusing its earlier result only if no code/build inputs changed. Do not run broader unrelated suites or repeat successful tests without a new change/failure/concern. Hosted CI, compose/Orthanc, hardware audio and the 200-pair human study remain separate from these checks.
- [ ] **Step 6: DOX pass and focused commit.** Update runtime docs to state where Jev is used, how to open it, exactly what leaves the backend, why configuration is not execution proof, source retrieval time, saved results/retry/delete semantics, POSIX private storage and non-file DB configuration. Change root guidance that currently says Jev has “no app route” to distinguish the offline CLI from the new explicit app service. Keep vision/tool matching a separately designed follow-on; link `JEV_VISION_ROUTING.md`. Record actual test counts, smoke geometry/request counts, real receipt outcome and unverified acceptance in `JEV_SIDEBAR_IMPLEMENTATION.md`. Stage named files, inspect `git diff --cached --stat`/`--check`, and commit with `test: verify sidebar Jev review and document acceptance`.
- [ ] **Step 7: Obtain one fresh whole-change review.** Native implementation ends with a fresh read-only reviewer using `gpt-6-astra`, `fork_turns="none"`, against `2f22e89..HEAD` in this worktree. Provide the approved spec, this plan and exact test/receipt evidence. Ask for correctness, source/actor authority, secret/data flow, race/restart/deletion behavior and UI scope; prohibit edits, real-provider calls and additional delegation. Fix actionable findings, rerun only affected checks, and record the review outcome without claiming a reviewer checked later unreviewed changes.
- [ ] **Step 8: Push and verify.** The user already authorized commit/push. Inspect status to preserve unrelated files, push `codex/jev-evidence-implementation`, and verify `git ls-remote origin refs/heads/codex/jev-evidence-implementation` equals local HEAD. Do not merge or deploy. Report the branch/commit, visible entry point, actual validation, genuine receipt status and remaining human-quality/clinical limitations.

## Self-review and requirement coverage

| Approved requirement | Owner/check |
| --- | --- |
| Exact source text and claim selection, immutable original answer | Tasks 1–2; selected-plan and Unicode tests |
| Public-preview confirmation and minimal TypeSafe payload | Tasks 3–5; payload sentinels and no-call-before-confirmation tests |
| Saved NVIDIA/unknown historical provenance | Task 2; dispatch persistence and primary-response regression |
| Owned strict API, mode/Origin/auth and no-store | Tasks 3–4; parameterized API/ownership tests |
| Idempotency, bounded work, failure/partial/unknown usage | Tasks 1, 3–4; durable-attempt and lifecycle matrix |
| Independent voice lifecycle, cancellation, deletion and recovery | Task 3; deterministic blocked-request races; Task 6 app smoke |
| Compact accessible preview, labels and honest receipts | Task 5 rendering/controller tests; Task 6 actual DOM/keyboard/layout checks |
| Read saved results without inference and safe explicit retry | Tasks 1, 3, 5–6; cache/selection and provider-count assertions |
| Existing offline CLI/voice/NIM paths remain valid | Focused regressions in Tasks 1–6 |
| Real provider execution distinct from clinical quality | Task 6 one synthetic live receipt; human study remains pending |
| Vision routing stays separate | Docs and final scope check; no image/model dispatch added |

Before handoff, self-check every row, all five Review Focus tests, file existence for modifications, method/type spelling and every command. No implementation tasks are marked complete by writing this plan. Approval of this plan starts Native implementation; no further feature-design or execution-method question is needed.
