# Jev / TypeSafe research for RadSysX

Research date: 2026-09-22. Repository baseline: `43d443ff8a41c67cbc6bf8985b2b26d27e8eee17`.

Status: research dossier supporting [the approved specification](../../docs/superpowers/specs/2026-09-22-jev-pubmed-evidence-review-design.md) and [implementation plan](../../docs/superpowers/plans/2026-09-22-jev-pubmed-evidence-review.md). The plan awaits review and execution-method selection; Jev is not implemented or inference-validated.

## Intent and scope

The user requested a branch from `codex/gemini-live-assistant`, deep TypeSafe research, and collaborative brainstorming. They selected: “Survey the opportunities and recommend the strongest starting point.” They subsequently approved public PubMed evidence review, initially evaluated without changing answers, approved its architecture, data contracts, presentation, failure behavior and acceptance criteria section by section, and approved the consolidated specification on 2026-09-22. Implementation planning is complete and awaiting review.

Created local branch `codex/jev-typesafe-design` at the baseline above after fetching and confirming that the source branch matched its remote. The pre-existing `.DS_Store` change was preserved. No branch was pushed.

Selected direction: develop **public research evidence review** first, initially around PubMed abstracts. The approved architecture uses a separate explicit evaluation runner over frozen completed answers and original abstracts; it does not automatically observe live conversations. Gemini/OpenAI retain their existing conversation roles, and Gemini retains research synthesis. Viewer-action checking and report consistency remain possible follow-on projects. The broader opportunities below are research alternatives, not added V1 requirements.

## What the current documentation establishes

| Property | Dated finding | Implication for RadSysX |
| --- | --- | --- |
| Model | `jev-latest` and `jev-preview` currently resolve to `jev-1.13.0`. | Pin the evaluated version when calibrating behavior. |
| Input | Text and textual JSON state; no image, audio, or video input. | Use transcripts, source passages and structured observations. Pixel interpretation stays elsewhere. |
| Output | Choice selects an option; Noul estimates whether a proposition holds; Score places an item on a descriptive ordered scale. | Use small judgments with application-owned meaning. |
| Cost | $0.042 per million input tokens; output tokens are free. | Measure all repeated state and question tokens. |
| Capacity | 64k tokens per request; state plus longest question limited to 32k. Choice allows 255 options; Score up to 10 levels. | Bound and select evidence before evaluation. |
| Advertised limits | 250,000 tokens/second and 1,200 requests/minute, explicitly subject to change. | Bound concurrency and handle overload. |

Sources: [Models](https://docs.typesafe.ai/models), [API](https://docs.typesafe.ai/api), [Primitives](https://docs.typesafe.ai/primitives).

The API is `POST https://api.typesafe.ai/v1/systemone`, authenticated with a bearer key. Requests contain `model`, `state`, and named `questions`; responses contain the resolved model, answers, and token usage. Independent questions sharing evidence can run together. They cannot consume each other's answers within that request. A later decision requiring new evidence needs another stage. [API](https://docs.typesafe.ai/api), [State](https://docs.typesafe.ai/concepts/state), [Fan-out](https://docs.typesafe.ai/patterns/fan-out).

Choice confidence summarizes the distribution over competing options. Noul has no separate confidence field. Score is a probability-weighted position on the supplied levels, not a physical measurement or percentage of severity. None establishes correctness or authorization. Evaluate thresholds separately for each question and model version. [Confidence](https://docs.typesafe.ai/confidence), [Choice](https://docs.typesafe.ai/primitives/choice), [Noul](https://docs.typesafe.ai/primitives/noul), [Score](https://docs.typesafe.ai/primitives/score).

## How strong is the evidence?

The launch article reports 70–500 ms responses and explains that published evaluations generally ran from West Coast laptops near its service. Its workflow reference answers come from other models, and the authors disclose possible task-selection bias. These are vendor results, not measurements of this RadSysX host or radiology performance. The schema guarantee constrains possible outputs; it does not make the selected answer true. [Launch article](https://typesafe.ai/blog/introducing-system-one-models-and-jev).

The most relevant cookbook evidence is useful but narrow:

- The citation recipe checks exact quote presence in code, then judges support using source context. Its eight-example demonstration used Jev 1.12 and a JWT specification. This motivates a method; it does not validate biomedical claim review. [Citation checking](https://docs.typesafe.ai/cookbooks/citation_check).
- The reranking example improves top-1 retrieval from 5% to 18% over 40 legal queries. Most top-ranked answers still miss its target. Reranking cannot recover a source absent from the candidate set. [Reranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe).
- The skill-suggestion example reduces wrong selections from 16.8% to 7.3% on 488 constructed requests, but also makes some previously correct answers wrong. RadSysX has a much smaller existing tool catalog and different voice interactions. [Skill suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion).
- The extraction cascade demonstrates field-specific checks and selective escalation. Its internal 100-prompt evaluation is not evidence that an additional model would improve RadSysX reports. [Extraction cascade](https://docs.typesafe.ai/cookbooks/sde_cascade).

The documented Jev 1.13 weaknesses include numerical/date reasoning, indirect questions, irrelevant context, and adversarial text. Independent formulations need not obey expected probability identities. Arithmetic, unit conversion, expiry, permissions and exact identifiers belong in code. Source content remains untrusted even after a semantic check. [Known limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13).

No radiology-specific validation or applicable BAA was established by this research. The public legal page offers enterprise ZDR; the DPA describes purpose-based retention without a fixed deletion interval. This research does not establish ZDR for the user's account. The initial recommendation uses public evidence, and any future patient-content use remains subject to the existing project restrictions and a separate assessment. [Legal](https://docs.typesafe.ai/legal), [DPA](https://typesafe.ai/legal/data-processing).

## Repository findings

These findings come from the baseline source, not from running the assistant:

1. `backend/clinical/ai_config.py` reads Gemini/OpenAI credentials but does not consume `RADSYSX_TYPESAFE_AI_API_KEY`.
2. `ai_tools.py` already supplies typed tool schemas, argument validation and explicit approval requirements. Another typed interface alone would add little; semantic checks would have to catch errors that pass those existing validators.
3. `ai_live.py` owns session/context checks, tool idempotency, reviewed saves and renderer receipts. These remain application authority.
4. `ai_research_worker.py:normalize_result` validates citation IDs and URLs and removes unknown references. It does not evaluate whether a sentence follows from its source.
5. `SourceLedger` retains source ID/title/URL, not passages or claim-to-passage links.
6. `search_pubmed` already obtains original abstracts from NCBI, with bounded requests and source IDs. Abstracts are returned to the agent, but a retained evidence record for later claim checking is not present.
7. `read_source` uses Gemini URL context to produce a summary. A Jev check against that summary would establish agreement with generated text, not independent verification against the original article.
8. `ai_research.py` launches isolated research workers with only selected environment variables and the Gemini key. A TypeSafe integration needs intentional credential plumbing; adding a setting to `.env.ai` does not reach the worker automatically.
9. Voice transcription and tool calls arrive through provider events. A completed transcript is not enforced as a prerequisite to dispatch. A new pre-dispatch semantic judge would require explicit turn alignment and ordering behavior.
10. OHIF sends neutral series/measurement aliases. Those are insufficient to infer lesion identity, anatomy, or visual findings. A model cannot repair absent evidence.

Relevant code: [research worker](../../backend/clinical/ai_research_worker.py), [supervisor](../../backend/clinical/ai_research.py), [broker](../../backend/clinical/ai_live.py), [tools](../../backend/clinical/ai_tools.py), [settings](../../backend/clinical/ai_config.py), [OHIF adapter](../../viewer/assets/live/ohif.ts).

## Three candidate directions

### 1. Public research evidence review — recommended

User benefit: research answers expose where their claims are supported, contradicted, or unresolved, with inspectable evidence.

Jev could rate the relevance of each retrieved abstract and judge individual claim/passage pairs. Separate questions could detect population or modality mismatch and whether a conclusion is explicitly present. Relevant contradictory evidence must survive selection. Missing evidence and service failure need distinct states.

Start with PubMed because original text already exists at a controlled boundary. The first experiment should record judgments without changing the answer. If it demonstrates benefit, reviewed evidence annotations can become visible. Relevance filtering and automatic repair are separate experiments so their effects can be measured independently.

The main engineering requirement is provenance: retain bounded original passages, associate claims with exact source IDs and evidence scope, and identify truncated or absent abstracts. An abstract-only judgment must say so. General web verification would require independently retrieved source text and appropriate fetch controls before it can offer the same claim.

Fit: [citation checking](https://docs.typesafe.ai/cookbooks/citation_check) and [passage classification](https://docs.typesafe.ai/cookbooks/classifying_rag_passages). The latter separates evidence from conflicting evidence and explicitly says its injection filter is not a security boundary.

Tradeoff: less immediately visible than a voice-command feature, and a model review can create false reassurance if labeled too strongly. Prefer “supported by this abstract” to a global “verified” badge. Jev does not generate explanations; show original evidence and application-defined labels.

### 2. Semantic checks on proposed viewer actions

User benefit: catch a validly structured action that misunderstands the request, such as deleting a measurement after the user said to keep it.

A possible checker would compare a completed user turn, the proposed tool and arguments, and a fresh narrow viewer snapshot. Useful questions include whether the user asked for a change, whether the proposal matches that change, and whether a target is ambiguous. Existing permission and approval checks still determine execution authority.

Closed-set selection fits presets, tool modes and existing opaque candidates. Free-form findings, coordinates and exact numeric conversions do not become Jev-generated values. The function-calling cookbook explicitly leaves open-ended arguments outside its closed-set mechanism. [Function calling](https://docs.typesafe.ai/cookbooks/function_calling), [Candidate-value selection](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook).

Tradeoff: synchronous checking adds latency and a failure dependency; asynchronous checking cannot prevent an already executed action. Turn ordering, cancelation and stale results require careful design. A separate action dispatcher could duplicate existing provider actions. An evaluation that only counts caught mistakes would miss new errors introduced by the checker.

This is a plausible second project after establishing whether the current assistant actually makes enough semantic action mistakes to justify another component.

### 3. Report consistency and evidence checks

User benefit: highlight discrepancies between supplied observations, measurements, findings and impression before a reviewed save.

Examples worth evaluating are a side changing between sections, an unsupported assertion, an explicitly documented observation omitted from the impression, or uncertain language becoming definite. Jev could select relevant source spans and evaluate narrow relationships; code would compare numbers and units exactly.

Tradeoff: this is the most domain-sensitive candidate. Correct statements may lack explicit textual evidence, and a textual consistency check cannot establish image truth or diagnose disease. Reference labels need qualified review. The initial scope would have to remain synthetic/deidentified and advisory under RadSysX's mode rules.

The extraction-cascade pattern is relevant, but automatically rewriting or saving a report is a different capability requiring its own design. [Extraction cascade](https://docs.typesafe.ai/cookbooks/sde_cascade).

## Evaluation constraints and future integration considerations

- Keep TypeSafe as a backend judgment service, distinct from the user-selected voice provider. Explicitly disclose any added destination for content; existing Gemini/OpenAI consent does not automatically describe TypeSafe use.
- V1 binds evaluations to immutable snapshot, evidence and request identities. A future live integration would additionally need owner, session and context-version binding, and must discard late results after context changes or cancelation. A text-only result must never imply image awareness.
- Read `RADSYSX_TYPESAFE_AI_API_KEY` explicitly through backend configuration. The official SDK expects `TYPESAFE_API_KEY` by default. Personal-key UI is a separate scope decision; the current encrypted store only supports Gemini/OpenAI.
- Either a small HTTP adapter using the existing HTTP/Pydantic stack or the official asynchronous SDK can express the API. Select based on dependency review and transport tests. The SDK documents secret-header redaction but not request/response-body redaction; payload logging must remain disabled. [Python SDK](https://docs.typesafe.ai/sdk/python), [Async client](https://docs.typesafe.ai/sdk/python/api/clients/async).
- Bound time, tokens, questions, concurrency and retries. SDK defaults allow a much larger wait than a live UI might tolerate. The selected evaluation-runner architecture gives review its own deadline after capture; it does not consume the existing research job's 120-second deadline. [SDK retries](https://docs.typesafe.ai/sdk/python/api/retries), [SDK constants](https://docs.typesafe.ai/sdk/python/api/constants).
- A timeout, overload, invalid response, absent abstract or missing key must produce an explicit unavailable/not-checked outcome. None should be reported as a passed review. Existing work must remain usable according to a deliberate fallback policy.
- Pin model and rubric versions. Record resolved model, usage, latency, status and bounded judgment results under the existing local retention policy. Raw media and private reasoning remain excluded. Exact source provenance matters more than a standalone score.

Illustrative cost only: 10,000 billed input tokens cost $0.00042 at the published rate; 1,000 such evaluations cost $0.42. This excludes retrieval, generative synthesis, retries and infrastructure. Actual cost must use returned usage rather than a count of questions.

## What would establish value

Before rollout, compare the current workflow, a comparable Gemini-only review, and Jev-assisted review using the same source material. Candidate selection and claim checking should also be measured separately.

Use public evidence and synthetic cases covering supported claims, contradiction, absent evidence, population mismatch, missing/truncated abstracts, numerical overstatement, misleading quotations and adversarial source text. Split evaluation by document/topic family so near-duplicate claims do not leak between threshold tuning and held-out measurement. Qualified reviewers must adjudicate the biomedical labels.

Measure false support judgments, missed contradictions, false alerts, unreviewed coverage, reviewer disagreement, p50/p95 added latency, total job cost and actual usefulness to the reader. Show denominators and uncertainty; a small successful sample is not proof of clinical reliability. Thresholds and release targets remain design decisions, not copied cookbook constants.

V1 protocol tests separately cover malformed responses, timeout/429/529, missing credentials, evidence truncation and cancelation. A future live integration would also require context-change and owner-isolation tests. The existing synthetic Electron research-while-audio-continues smoke could check that such an integration does not disrupt conversation; it cannot establish live Jev quality and is not a V1 evaluator acceptance requirement.

## Verification performed in this research

- Read current TypeSafe introduction/index, API, model/limit pages, primitives, confidence, state/building guidance, relevant cookbooks, Python client/retry documentation, known limitations, launch evidence and public legal documents.
- Inspected the actual backend research, tool, session and credential paths and the typed OHIF context boundary.
- Confirmed the named key is present without displaying it. `.env.ai` is ignored. An authenticated `GET /v1/models` returned HTTP 200 and aliases `jev-latest` and `jev-preview`. Catalog access does not prove inference readiness, remaining credits, exact model availability or useful performance.
- No inference request, clinical-content transfer, product dependency installation, application launch or runtime test was performed. No credentials were written into this report.
- Initial documentation verification: the research note and roadmap DOX passed whitespace and local-link checks with no unresolved placeholders. The later specification tranche also adds a design-documents DOX and root index entry; it does not change runtime behavior.

## Design outcome and next checkpoint

The [written specification](../../docs/superpowers/specs/2026-09-22-jev-pubmed-evidence-review-design.md) is approved. It narrows V1 to replayable sentence–abstract assessment, independent evaluation budgets, private blind/comparison reports and a 200-pair public-data study. Relevance filtering, automatic repairs, live integration and report/viewer controls remain outside V1. The [implementation plan](../../docs/superpowers/plans/2026-09-22-jev-pubmed-evidence-review.md) is the next review checkpoint, together with execution-method selection. No runtime integration exists yet.
