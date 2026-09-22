# Jev PubMed Evidence Review — Design Specification

Date: 2026-09-22

Branch: `codex/jev-typesafe-design`

Repository baseline: `43d443ff8a41c67cbc6bf8985b2b26d27e8eee17`

Status: all conversational design sections and the consolidated written specification approved by the user on 2026-09-22. The [implementation plan](../plans/2026-09-22-jev-pubmed-evidence-review.md) awaits user review and execution-method selection. Implementation and live evaluation have not started.

## 1. Approved intent and scope

Determine whether Jev improves the assessment of evidence behind RadSysX research answers. The first scope is public PubMed evidence review, evaluated without changing answers. The user separately approved architecture, data contracts, user presentation, failure behavior and acceptance criteria.

The first deliverable is a replayable backend evaluator, invoked through an explicit local evaluation runner. It preserves the original research answer, evaluates exact sentence–abstract pairs, and produces private blind-review and comparison artifacts. An honest negative result is a successful evaluation outcome.

V1 uses deliberately selected public-literature or synthetic cases. It does not automatically consume live conversations, clinical records, viewer state, images, audio or existing session history. The evaluation designation comes from the operator's curated input manifest, not a model's privacy judgment. Clinical-mode execution remains disabled. The runner neither exposes a research route in pilot/clinical nor grants access to governed app actions.

The approved scope excludes changes to answer generation, source ranking, automatic answer repair, report editing/saving, viewer actions, the sidebar, personal-key settings and general-web claim verification. An automatic live observer is a possible later integration requiring its own decision. This specification does not authorize that rollout.

## 2. Architecture

### 2.1 Components and ownership

| Component | Responsibility | Inputs and outputs |
| --- | --- | --- |
| Existing research worker | Retrieve public evidence and generate the existing answer | Public question to normal research result; optional evaluation-only evidence capture |
| Snapshot builder | Freeze answer and source provenance | Completed result and captured abstracts to an immutable research snapshot |
| Review-unit builder | Identify exact answer spans and their citations | Snapshot to review units and explicit coverage exclusions |
| TypeSafe adapter | Issue bounded requests and validate judgments | One claim/abstract pair and rubric to a typed assessment |
| Evaluation runner | Own scheduling, artifacts, comparisons and resume | Curated snapshots and optional reference labels to private reports and JSON |

Domain models, pair construction and TypeSafe transport are separate units. The reviewer has no tool dispatcher, clinical database access or renderer authority. Use the existing Python/Pydantic/HTTP stack for a small transport adapter; a new general-purpose agent or orchestration service is unnecessary.

### 2.2 Capture, then evaluate

Capture and evaluation are separate explicit runner operations. Capture may call the existing bounded research worker with a curated public question. Replay evaluates an existing snapshot without regenerating an answer or refetching an abstract. Supplying a TypeSafe key does not automatically enable either operation.

The PubMed retrieval boundary records original extracted abstract sections before the current 10,000-character truncation is applied. It retains only bounded text and marks truncation truthfully. Capturing evidence must not change the worker's tool declarations, prompts, tool return values, synthesis parameters or normalized answer.

An evaluation-only capture path returns bounded evidence to the runner alongside the completed result. It must be isolated from the normal live worker protocol and must not place abstracts or assessment data inside the existing `research_run` result. Capture failures produce incomplete evaluation evidence while preserving any valid completed research result. The existing research process remains isolated and receives only its required Gemini credential; the TypeSafe credential belongs to the evaluation adapter.

The snapshot freezes the exact normalized answer delivered by the research workflow. Jev receives no request until that snapshot has been validated. Evaluation has its own deadline and concurrency budget; it does not consume the existing research job's 120-second deadline or its model/tool call budget.

### 2.3 Repository seams

At the baseline, `backend/clinical/ai_research_worker.py` owns PubMed extraction, `SourceLedger`, generation and result normalization. The ledger retains citation identities but not passages. `backend/clinical/ai_research.py` owns isolated process supervision and bounded worker output. `backend/clinical/ai_config.py` owns deployment credential resolution. These are the relevant implementation seams; existing actor, session, approval and provider behavior in `ai_live.py` remains authoritative and unchanged by V1.

The implementation plan must keep focused evidence modules separate from the already substantial worker. It must read the backend and backend-test DOX chains before editing. This document specifies behavior and boundaries, not an implementation task sequence.

## 3. Data contracts

All records carry an explicit schema version, use UTC timestamps, reject invalid field types and enforce size bounds. IDs identify records; they are not evidence of truth or authorization. JSON encodes Unicode as UTF-8. SHA-256 hashes bind immutable content; a hash verifies consistency, not the truth of a source.

### 3.1 Research snapshot

Required fields:

- `snapshot_id`, `schema_version`, `created_at`, and `data_class` (`public_literature` or `synthetic`).
- Exact normalized research result, including answer text, citation manifest and limitations; `answer_sha256` covers the exact UTF-8 answer text.
- Generation model and available generation configuration/prompt version, with explicit unavailable metadata rather than invented values. Synthetic cases identify their fixture origin instead of claiming model generation.
- Evidence records, source-to-evidence mapping, capture completeness and sanitized capture exclusions.
- `snapshot_sha256`, calculated over canonical JSON of the immutable payload with the hash field itself excluded. Canonicalization uses sorted object keys, compact separators and UTF-8 encoding and has its own version.

A suite manifest associates snapshots/units with case IDs, topic families and development/held-out membership. Those fields remain local and never enter a model request. Completed assessment records and human labels are not part of the frozen snapshot.

### 3.2 PubMed evidence

Required fields include `evidence_id`, snapshot-local citation ID, `source_kind: pubmed_abstract`, PMID, canonical PubMed URL, title, retrieved timestamp, extracted abstract sections, extraction version, retained-text hash and completeness status.

Completeness is `complete`, `truncated`, `absent`, or `unavailable`. “Complete” means the available abstract was fully retained, not that full article text was retrieved. Section labels and text come from NCBI extraction; summaries generated by Gemini never acquire this source kind. Preserve extracted wording and section boundaries as ordered label/text records. The retained-text hash covers their canonical JSON representation; send the same records without paraphrasing or flattening away section boundaries. Record original character count when observed, and never infer that a string at the length limit is complete.

Synthetic fixtures use a distinct synthetic source kind and never masquerade as real PubMed retrievals. Actual corpus evidence uses valid PMIDs. Publication metadata may be absent; do not invent dates. Changed source text creates a new evidence/snapshot version rather than overwriting a prior evaluation input.

### 3.3 Review unit and coverage

A review unit contains `unit_id`, snapshot ID, exact sentence text, inclusive start/exclusive end offsets, citation tokens and their offsets, linked evidence IDs, and builder version. Offsets count Unicode code points in the unchanged answer string. Validation requires that each stored span exactly matches the snapshot; HTML highlighting converts those offsets safely without assuming JavaScript UTF-16 indexing.

Use a deterministic, versioned sentence/citation builder. It must handle decimals, abbreviations, lists and trailing citation groups through tested rules. Cite attachment that cannot be established unambiguously is excluded with a reason. A citation at the end of a multi-sentence paragraph is not silently assigned to every sentence. For curated evaluation cases, explicit span/citation annotations may replace automatic boundaries; they must pass the same exact-span and source validation and record their origin. They cannot rewrite the claim.

Preserve compound claims as written. For a sentence citing two abstracts, create two pair assessments, one for each cited abstract. Do not pool evidence into one positive verdict or search for uncited evidence to rescue a claim.

Maintain an inventory of candidate sentences and their outcomes, including no citation, ambiguous attachment, unknown citation, non-PubMed source, missing/truncated evidence and evaluation limits. Clearly identified formatting-only spans can be excluded from the candidate inventory under documented builder rules. Unsupported splitting or ambiguous boundaries remain visible as unreviewed spans. Deduplicated source citations do not inflate pair counts.

### 3.4 Assessment

Each assessment binds the snapshot, unit, evidence, request hash, evaluator/model and rubric version. Execution status is one of `completed`, `skipped`, `failed`, or `cancelled`; a reason code explains any non-completed outcome. Only a completed assessment contains a relationship judgment.

V1 asks one Choice question about the relationship between the exact claim and supplied abstract. Its rubric explicitly considers population, modality, outcome and certainty qualifiers. The mutually exclusive labels are:

| Label | Definition |
| --- | --- |
| `supported` | The abstract supports every substantive part of the claim, within its stated scope and certainty. |
| `partially_supported` | It supports at least one substantive part, leaves other parts unaddressed and contradicts none. |
| `contradicted` | It contradicts at least one substantive part and supports no other independently meaningful part; remaining parts may be unaddressed. |
| `mixed` | It supports and contradicts different substantive parts of the claim. |
| `not_addressed` | It neither supports nor contradicts any substantive part; available information is insufficient either way. |

These are abstract-relative judgments, not findings of medical truth. Missing/truncated abstracts never receive `not_addressed`; they are skipped. The rubric cannot ask Jev to compute measurements, ratios or date intervals. Numeric overstatement may be tested as textual support, while exact arithmetic remains code's responsibility.

Completed records retain the returned label, full distribution, confidence, requested and resolved model IDs, rubric version, exact submitted JSON payload, request hash, timing and reported usage. Serialize the request body once as canonical UTF-8 JSON, hash and retain those exact bytes, and reuse them for retries. Authentication headers are never retained. Attempt records preserve sanitized failures, retry delays and whether usage is known. A timed-out submitted request has unknown usage unless a usage receipt was received; estimated cost must not imply zero billing.

The request's task content includes only the claim, relevant abstract text/section labels and question definitions, alongside the API's required model and fixed rubric question IDs. It excludes credentials, local record metadata, user/session data, broader conversation, other model judgments and reference labels. Citation tokens already inside the exact sentence remain verbatim; local snapshot, unit and evidence IDs are not added. TypeSafe probabilities are estimates; no confidence value changes the answer or grants execution permission.

### 3.5 Reference label

Reference records bind unit/evidence content hashes to a reviewer ID, label, optional notes, label version and adjudication status. Reviewer identity stays local. At least two independent domain-qualified reviews are reconciled for the quality study; disagreements are adjudicated. Unresolved cases remain visible but are excluded from definitive accuracy claims with an explicit denominator adjustment.

Reference labels are established before model judgments are revealed. A separate comparison stage joins frozen model results with adjudicated labels. Altering a reference label creates a new label-set version; it does not mutate the original assessment or silently retune the rubric.

## 4. User presentation and artifacts

The runner produces local HTML and structured JSON. V1 adds no sidebar controls or automatic live-evaluation status. Its normal console output contains run IDs, counts, timings and fixed error categories, not full claims, abstracts or provider response bodies.

The report includes:

- Run counts by execution status, sentence and pair coverage, elapsed time, known token usage, estimated evaluator cost and any unknown billing.
- The verbatim frozen answer, with reviewed spans linked to assessments and unreviewed spans explained separately.
- Individual sentence–abstract comparisons, source provenance/completeness and source disagreements.
- Expandable technical details containing versions, distributions, confidence, timing and usage.

The relationship labels shown to readers are “Supported by this abstract,” “Partially supported,” “Contradicted by this abstract,” “Mixed,” and “Not addressed in this abstract.” No whole-answer verified badge or accuracy percentage is derived from confidence. Evidence and human notes explain a result; the report does not invent model reasoning. A source link opens only when the reviewer chooses it.

Blind review is a separately generated artifact containing only cases and evidence. It omits model results and existing reference labels from HTML source, embedded data, attributes, comments and companion files. Hiding a comparison section with CSS is insufficient. The comparison report is generated after reference labels are frozen and includes both Jev and the Gemini-only baseline, with unresolved labels identified.

Default artifacts belong under the repository-local, Git-ignored `tmp/jev-evaluations/<run-id>/`. On the supported Linux/macOS environment use owner-only directories/files (0700/0600), reject unsafe path/symlink substitutions and create new runs without overwriting old ones. The operator can select another private output root. Artifacts remain local until explicit deletion or sharing; there is no upload or automatic report publication.

Persist input snapshots and completed attempt/assessment records atomically. Generated HTML can be rebuilt from JSON. A run manifest references only fully committed artifacts so interrupted writes cannot appear complete. A separate blind-review export contains only its allowed fields, not a copy of the entire run directory.

Render external text as escaped text, validate source links and use a restrictive content policy. Reports require no remote fonts, scripts, images, analytics, model calls or automatic network requests. Ordinary source text must not become executable HTML.

## 5. Failure behavior and resource bounds

### 5.1 Initial defaults

The approved defaults are two concurrent requests, ten seconds per attempt, at most one retry, and sixty seconds per snapshot/evaluator. The attempt deadline is an overall request deadline, not a timeout restarted for every received chunk. The snapshot deadline includes queue waits, backoff and all attempts. No new request starts after cancellation or deadline expiry. Cancellation/transport cleanup gets a separate bounded five-second grace period, during which no new inference may start; report finalization time is measured separately.

Additional finite V1 bounds are 20 evidence records per snapshot, 10,000 retained abstract characters per record, 12,000 answer characters, 200 candidate units eligible for pair construction, and 40 evaluated pairs per snapshot. The coverage inventory still accounts for overflow sentences/spans as excluded by the unit limit. Thus retries allow at most 80 request attempts, still constrained by the time limit. Limit selection follows stable answer/source order and records excluded counts/spans. Corpus runs use multiple snapshots rather than evading a per-snapshot limit.

Reject serialized input snapshots above 2 MiB and request/response bodies above 128 KiB each before unbounded allocation. Character and byte limits both apply. These are application bounds, not estimates of provider token limits. Provider validation failures remain explicit; do not silently truncate a claim or abstract to make a request fit. Approved runtime limits may be configured for a declared experiment; record their effective values and use the same policy for comparable evaluators.

### 5.2 Outcome rules

| Condition | Required behavior |
| --- | --- |
| Missing/truncated abstract, ambiguous citation or out-of-scope source | Skip with the specific reason; no model call. |
| Missing/rejected credential or unavailable configured model | Mark the affected evaluation failure; stop further scheduling for that evaluator and list untouched units as skipped due to evaluator unavailability. |
| Timeout, network failure, 429, 529 or temporary 5xx | Retry the identical payload at most once if budget permits. Honor retry delay headers only within the remaining deadline. |
| Invalid request, unexpected redirect, invalid response or model-version mismatch | Fail without retry or model substitution. |
| Pair budget exhausted | Preserve completed results and mark unscheduled pairs as skipped due to the limit. |
| Snapshot deadline exhausted | Cancel outstanding requests; mark dispatched unfinished pairs failed due to the deadline and unscheduled pairs skipped. |
| Explicit user cancellation | Cancel pending/in-flight work; retain completed results and mark all unfinished planned pairs cancelled. |
| Schema, hash or span mismatch | Reject the affected input before transmission. Snapshot-integrity failure rejects the entire snapshot. |
| Storage failure | Stop scheduling, report a fixed local-storage failure and retain previously committed artifacts. Never claim an unsaved result is durable. |

Do not include provider exception strings, headers, request URLs containing credentials, or raw error bodies in reports/logs. Disable automatic payload logging in dependencies. Persist exact approved input payloads only through the deliberate private artifact path.

### 5.3 Validation, resume and accounting

Validate exact answer IDs/types, the five permitted labels, finite probabilities/confidence in [0,1], the expected distribution keys, a probability sum within a documented 0.0001 tolerance, choice membership among maximum-probability options, the resolved model ID and bounded nonnegative integer usage. Do not repair or renormalize an invalid response into a success. An inconclusive but valid model distribution is a completed result with uncertainty, not a transport failure.

The first evaluated model is pinned to `jev-1.13.0`, based on the dated source research. Revalidate availability before implementation; changing the pin creates a new declared experiment and never silently falls back to `jev-latest`. Authentication or catalog success alone is not inference acceptance.

Use `RADSYSX_TYPESAFE_AI_API_KEY` from the backend-only environment or `.env.ai`, with process settings taking precedence. Replay with Jev does not require a Gemini key. Fresh answer capture and the Gemini-only baseline require their separately configured Gemini credential. No key or key fingerprint enters an artifact. Normal app provider readiness is unchanged.

Resume is explicit. Reuse a completed assessment only when snapshot/evidence/request hashes, exact model and rubric versions match. Store prior attempts, mark reuse and exclude cache hits from fresh-inference latency statistics. Retrying previously failed or cancelled work begins a new evaluation attempt with a new deadline. Restart never sends requests automatically.

Show received usage and known cost separately from unconfirmed attempts. Cost estimates record the pricing source/date; do not label them account billing totals. Include failures, retries and exclusions in workload accounting so a fast incomplete run cannot appear to outperform a complete run.

## 6. Acceptance criteria

### 6.1 Engineering acceptance

| Area | Evidence required |
| --- | --- |
| Answer isolation | Fixture-backed capture on/off comparison preserves tool inputs/returns and the normalized answer; evaluation leaves the frozen answer bytes unchanged and cannot feed results back into generation. |
| Provenance | Each completed assessment resolves to exact validated spans, original evidence, request payload, hashes and versions. |
| Coverage | Every candidate unit/pair completes or has an explicit exclusion/failure/cancellation reason; counts reconcile and distinguish sentence from pair coverage. |
| Failure handling | Focused tests cover each outcome rule, concurrency, identical-payload retry, deadline/cancellation scheduling and interrupted writes. |
| Reproducibility | Saved inputs reproduce request bytes and permit historical result inspection. Fresh model outputs need not be deterministic. |
| Presentation | Blind bundles contain no model/reference judgments; comparison artifacts show uncertainty, disagreements and incomplete coverage; source text is escaped and opening reports makes no automatic network request. |
| Data handling | Only designated public/synthetic cases reach the adapter; isolated fixtures prove credentials and error bodies never enter output/logs. Artifacts stay private and ignored by Git. |

Use focused backend and renderer/report tests appropriate to the implementation. Tests must inject synthetic credentials and mock network access; they must not read the operator's actual `.env.ai` or silently contact providers. Build/type-check/Electron suites are required only if their runtime surfaces are changed. V1's evaluation runner does not require an Electron acceptance claim.

### 6.2 Initial quality study

Evaluate 200 sentence–abstract pairs drawn from at least 50 real PubMed records: 50 development pairs and 150 held-out pairs. Include naturally occurring public research sentences and explicitly identified constructed challenge claims. Partition entire document and topic families before tuning so near duplicates, the same PMID and related claims do not cross development/held-out boundaries. Represent all five relationship labels in both partitions; publish the actual label counts and case origins. Synthetic transport/security fixtures are separate from these 200 quality pairs.

Include compound claims, population/modality mismatch, numerical overstatement, misleading quotation and adversarial text cases. Unavailable/truncated evidence belongs in separate coverage/failure cases and is never mislabeled as a semantic negative to inflate accuracy. The suite manifest records exclusions and any unresolved human labels.

Domain-qualified reviewers label cases without seeing model judgments, adjudicate disagreement, and freeze a versioned reference set. Until those reviews exist, the engineering tool can be complete but domain-quality acceptance remains pending. Synthetic expected labels or another model's answers are not substituted for the required human references.

Compare Jev with a separately invoked Gemini-only reviewer, initially the existing `gemini-3.8-flash` lane, using the same immutable claims, abstracts and five-way definitions. The baseline receives no tools, live search, additional context, Jev judgments or reference labels. Record its full generation settings and rubric. It may produce extra prose, but comparisons consume only validated labels; it does not supply synthetic probability distributions for metrics that require probabilities. Establish the configuration on development data and freeze it before held-out evaluation.

The current unchanged workflow is the product baseline: it performs no semantic support assessment. Report its underlying claim errors against the references without pretending it emitted classification labels. Jev and Gemini classifications can then be compared fairly as added review stages.

Report the following, with denominators and uncertainty:

- Full five-way confusion matrix and per-label precision/recall.
- Incorrect support rate: predictions labeled `supported` whose reference is not `supported`, divided by all predictions labeled `supported` with resolved references.
- Missed contradiction rate: predictions outside `contradicted`/`mixed` whose reference is in that pair of labels, divided by all completed cases with a reference in that pair.
- False contradiction alert rate: predictions in `contradicted`/`mixed` whose reference is outside that pair, divided by all completed cases with a reference outside that pair.
- Unreviewed coverage, failures, reviewer disagreement and unresolved-label exclusions.
- p50/p95 successful attempt and pair latency, complete snapshot elapsed time, failure durations, retries, input/output usage and known/unknown costs, separated by evaluator and cache reuse.

An empty metric denominator is unavailable, never zero error. Report reference contradictions among failed/unreviewed cases separately; the completed-case rates must not hide them. Any confidence threshold analysis uses development data only and reports accuracy against coverage; it does not change V1 answers. Use paired comparisons on the same eligible cases and uncertainty estimates that account for shared documents/topics. Report whole-workload completion separately so dropping difficult cases cannot improve apparent quality. Lack of enough resolved examples widens uncertainty; it does not justify a claim of equivalence.

### 6.3 Decision after evaluation

Engineering completion and a completed quality study do not require Jev to outperform the baseline. A recommendation to expand requires observed benefit: better error detection at comparable false-alert rates, or comparable quality with lower latency or cost. The comparison must state its practical margins and evidence, and held-out results must support the conclusion. This specification sets no automatic promotion threshold or live deployment gate. Inconclusive evidence or a negative result is recorded plainly and keeps the feature in explicit evaluation.

Local protocol/fault tests establish integration behavior. Live public-data inference establishes actual provider performance. Neither is physical-device audio acceptance, clinical certification or evidence of image interpretation.

## 7. Research sources and review status

The [research dossier](../../../roadmap/ai-backend/JEV_RESEARCH.md) contains the dated capability survey, alternatives and baseline code findings. Principal primary references are the [TypeSafe API](https://docs.typesafe.ai/api), [Models](https://docs.typesafe.ai/models), [Choice](https://docs.typesafe.ai/primitives/choice), [Confidence](https://docs.typesafe.ai/confidence), [citation cookbook](https://docs.typesafe.ai/cookbooks/citation_check), and [known limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13). These were inspected on 2026-09-22 and must be rechecked before integration.

During research, the configured key was detected without disclosure and an authenticated model-catalog request returned HTTP 200. No inference, dataset labeling, application launch or runtime test has been performed for this design. No such acceptance is implied by these documents.

The user approved this consolidated specification on 2026-09-22. The implementation plan has been written through the requested brainstorming workflow; implementation requires review of that plan and selection of its execution method.
