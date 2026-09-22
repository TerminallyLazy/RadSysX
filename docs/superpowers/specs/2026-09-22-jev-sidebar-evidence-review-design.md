# Review evidence with Jev in the sidebar

Date: 2026-09-22. Status: written specification approved by the user on 2026-09-22; [implementation plan](../plans/2026-09-22-jev-sidebar-evidence-review.md) approved for Native execution; implemented on the feature branch, with acceptance tracked in [the runbook](../../../roadmap/ai-backend/JEV_SIDEBAR_IMPLEMENTATION.md). This document makes the explicit app action's data flow, permissions, presentation and verification concrete. Native execution remains the user's selected implementation method.

## Intended outcome

A radiologist or researcher can deliberately review a completed public PubMed research result without changing its answer. The result displays what Jev checked, against which original abstract, what it concluded, what it could not review, and whether a real provider call completed. The user can distinguish available configuration, queued work, submitted inference, completed review and failure.

Existing conversation providers and the user's selected Gemini/NVIDIA research model retain their roles. The offline evaluation CLI and its blinded study remain independent. This feature is an experimental abstract-support assessment; it does not confer clinical validation or solve the unfinished human-quality study.

## Chosen approach and alternatives

Use an explicit action on a stored, owned, completed `research_run` result. The backend prepares immutable evidence, then reuses the existing sentence/citation planner, pinned Jev adapter and bounded evaluator. A separate review service owns app authorization, persistence, lifecycle and API presentation. The evaluator package gains no clinical actor or viewer authority.

Automatic review after every research task would send additional text to TypeSafe without a per-result decision and spend tokens even when review is unwanted. A browser-direct TypeSafe call would expose credentials and bypass ownership. Both are excluded. Running the separate CLI manually remains supported but does not meet the visible app-workflow request.

## User flow

1. A completed research card with at least one canonical PubMed source offers **Review evidence with Jev**. The action is also available when viewing that account's saved conversation. Non-PubMed-only or failed results show a short eligibility reason instead of implying they were reviewed.
2. Opening the review prepares a local snapshot and fetches the cited public abstracts from fixed NCBI endpoints. This step does not call TypeSafe. Show the exact eligible claim text, referenced abstracts, exclusions, and the destination `TypeSafe · jev-1.13.0` in an expandable review panel. Label abstracts as fetched for this review, with time; they are not claimed to be the same bytes seen during original research.
3. **Start Jev review** requires the user to confirm that the displayed claim text contains only public literature or synthetic material and no patient information. Existing synthetic/deidentified image attestation is insufficient: research prose can contain case details. The user can exclude a claim using its backend-issued ID; editing or substituting arbitrary text is outside V1. If none remain, no call is made.
4. The card reports **Preparing**, **Ready to review**, **Reviewing 3 of 8 pairs**, then **Completed**, **Partially completed**, **Failed**, **Cancelled** or **Interrupted**. Progress counts come from committed attempts/assessments, not timers. Closing the panel does not hide the job status on the research card.
5. Completed rows show the unchanged claim, source title/PMID, abstract-scoped five-way label, full source passage, and expandable receipt. If one claim cites two papers, show two assessments rather than collapsing their disagreement. Missing/ambiguous evidence and unselected claims remain visibly unreviewed.
6. Reopening a completed review reads saved results without inference. A deliberate **Retry unfinished review** is available after a partial/failed/interrupted run and requires renewed public-text confirmation; it reuses only exact matching completed pairs and retains the earlier attempts. Cancel is available during preparation/inference.

The compact sidebar header remains unchanged. Review details expand within the existing scrollable research card, not in an always-visible panel above the conversation. A settings row shows Jev's pinned model and configured/missing status; only a successful receipt establishes that Jev ran. No new model dropdown or personal TypeSafe key vault is required: use backend-only `RADSYSX_TYPESAFE_AI_API_KEY`.

## Data and source boundaries

The browser supplies only owned session/tool/review IDs, backend-issued selected claim IDs, an idempotency key and explicit confirmation. It cannot supply a new answer, abstract, URL, provider, filesystem path, actor identity or model ID. The backend resolves the exact completed result from its journal and freezes its answer/source identity.

Only canonical `https://pubmed.ncbi.nlm.nih.gov/<digits>/` citations in that result may trigger retrieval. Use bounded fixed-origin NCBI EFetch by PMID, never the model-supplied URL as a fetch target; reject redirects and malformed/oversized XML. Reuse the original-abstract extraction semantics and complete/truncated/absent/unavailable distinctions. Do not use generated research summaries as evidence. No full-text scraping is added.

Do not hardcode generation metadata from the Gemini-only capture CLI for NVIDIA output. Store available generation provider/model provenance at research dispatch/completion for new jobs. Older result provenance is explicitly unknown; never infer its producer from today's account preference.

Freeze a `Snapshot` and `ReviewPlan` using the existing exact Unicode spans, citation bindings, source hashes and rubric. The separate review envelope binds excluded-by-user claim IDs without rewriting the original answer. Exclusions are incorporated explicitly when deriving the evaluation plan; the runner must validate this selection against the immutable original plan, preserving its existing input-mismatch protection.

TypeSafe receives selected eligible claims and original abstract sections only. It receives no patient/study identifiers, DICOM bytes, viewport images, audio, free-form chat history, reports, original research query, or unrelated conversation state. No claimed automatic PHI detector replaces user confirmation. Statements that cannot meet the public/synthetic restriction remain excluded.

## App contracts and authority

A backend `ai_evidence_review` service composes the existing evaluator. Additive tables record owner, source session/tool/context, answer/snapshot/request identity, review status, selected claims, timestamps, artifact locator and bounded progress/receipt summaries. Detailed immutable attempt/request/evidence artifacts use a backend-owned private directory beside the database, with generated run IDs and existing private-file/hash checks. Client responses never expose that filesystem locator.

Proposed same-origin endpoints:

- `POST /api/ai/sidebar/sessions/{sessionId}/tools/{toolCallId}/evidence-reviews`: idempotently create a preparation job and return its owned review ID/status.
- `GET /api/ai/sidebar/sessions/{sessionId}/evidence-reviews`: list bounded review summaries for saved history.
- `GET /api/ai/sidebar/evidence-reviews/{reviewId}`: owned preview, progress and result projection, including full public abstract text within existing limits.
- `POST /api/ai/sidebar/evidence-reviews/{reviewId}/start`: selected backend claim IDs, immutable preview hash and explicit public/synthetic confirmation; starts only that frozen version.
- `POST /api/ai/sidebar/evidence-reviews/{reviewId}/retry`: explicit resumption of unfinished pairs under the same immutable identities and renewed confirmation.
- `POST /api/ai/sidebar/evidence-reviews/{reviewId}/cancel`: idempotent cancellation.

All require the backend-signed unexpired actor with `ai.run`, owned source session/result and enabled `research` or `pilot` mode. Writes require an explicit allowed Origin. Clinical mode rejects review before credentials or external connections. Use bounded strict JSON with fixed errors and no-store responses. IDs cannot authorize cross-owner reads, jobs or cached results. Terminal research history may be reviewed without restarting live voice; the review is bound to the saved result, not the current viewport.

The UI polls the owned status endpoint while a job is active, with bounded backoff and cancellation on unmount. It must ignore late replies after another review/session is selected. No review event, source text or judgment is forwarded to the conversation model or research worker.

## Lifecycle, bounds and failure behavior

One active review per actor and at most two globally. Cap preparation at 20 seconds and the entire review operation at 90 seconds, including evaluator cleanup. Retain evaluator ceilings: 40 eligible claim/abstract pairs, 20 abstracts, 10,000 characters per abstract, 12,000 answer characters, two concurrent attempts, 10 seconds per attempt, one retry and a 60-second evaluation deadline. Bound XML and artifacts using the existing 2 MiB snapshot/128 KiB request contracts. Polling and duplicate clicks cannot schedule more calls.

Check authorization, source existence and cancellation again immediately before every external request. A viewer target change cannot relabel a result as belonging to the new image: its saved research identity remains visible and fixed. End voice does not cancel an explicitly separate public-literature review; explicit review Cancel, logout/auth expiry, source-history deletion, backend shutdown and disabling the feature do. Account credential/model mutations continue to stop all account background work. Restart marks unfinished jobs interrupted; no inference replays automatically.

Delete a conversation through the existing history deletion contract only after cancelling its reviews and removing linked private artifacts. Missing artifacts produce an unavailable result, never reconstruction or inference on GET. Serialize start/cancel/delete with source ownership and artifact operations to prevent a late result from resurrecting deleted history.

Never map timeout, key failure, invalid model response, absent/truncated abstract, unselected claim or ambiguous citation to a semantic negative. Preserve completed pairs on partial failure. Attempts submitted without a usage receipt show unknown usage/billing. Persist attempt-start before submission; if local storage fails, stop scheduling rather than claiming a durable receipt.

## Receipt and presentation contract

Every completed row links to its exact input claim/source. The receipt includes review ID, generation provider/model if recorded, requested/resolved reviewer model, rubric version/hash, answer/abstract/request hashes, source retrieval time, attempt start/end, submission status, result label, reported token counts and reused/new status. Confidence/probabilities may appear in details as model output; do not label them probability of clinical truth or automatically accept a diagnosis on a threshold.

Use **Supported by this abstract**, **Partially supported**, **Contradicted by this abstract**, **Mixed**, and **Not addressed**. No global Verified badge, invented natural-language Jev rationale, fabricated citation highlight or claim that a paper's full text was reviewed. Show original abstract sections, not a fabricated supporting quote. Execution completion and evidence support are separate statuses.

## Verification and acceptance

- Network-isolated backend tests for signed-owner isolation, mode/origin/expiry, frozen source resolution, fixed PMID retrieval, hostile URLs/XML, source completeness, exact spans and unsupported citations.
- Tests for explicit preview confirmation, selected-claim validation, duplicate-click idempotency, recorded generation provenance, owner/global limits, cancellation before/after submit, deletion/restart and no automatic retry from GET/reopen.
- Instrumented fake provider tests prove the outgoing payload contains only selected claim/abstract text, never raw query, image bytes, DICOM metadata, report text, study/session identifiers, or another actor's content. Pin and validate the resolved model.
- Browser/controller tests show statuses, exclusions and receipts, preserve the original answer, escape untrusted text, keep controls keyboard-accessible and reject stale polling replies. Maintain compact sidebar layout.
- Guarded synthetic Electron/OHIF smoke drives the actual review action, preview/confirmation, progress, receipt, reopening and cancellation through the real backend bridge. It sends no real credentials or patient material.
- One explicit synthetic/public live acceptance run demonstrates a genuine Jev receipt through the normal backend path. Keep live connectivity separate from the pending blinded human-quality study; no clinical rollout claim.

## Scope after this feature

The contextual imaging-tool advisor discussed in the user's illustration remains a separately designed next feature. See [research assessment](../../../roadmap/ai-backend/JEV_VISION_ROUTING.md). It is not bundled into evidence review, and no image inference, autonomous detector dispatch, report mutation or new cloud image destination is enabled by this specification.
