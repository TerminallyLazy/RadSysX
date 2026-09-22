# Public evidence review

An explicit local experiment that compares abstract-relative Jev and Gemini judgments. It never changes research answers, sources, reports, viewer actions or conversation behavior. There is no server route or live observer. Inputs must be deliberately designated public literature or synthetic material; do not use clinical session exports.

## Setup and destinations

Use the repository Python 3.12 environment and declared requirements:

```bash
.venv/bin/python -m pip install -r backend/requirements-ai.txt
.venv/bin/python -m backend.evidence_review --help
```

Keys stay in operator `.env.ai` or exported environment variables. `--env-file` selects an operator-owned credential file; input manifests cannot choose credentials or destinations. Exported variables take precedence. No CLI key argument exists.

- Jev: `RADSYSX_TYPESAFE_AI_API_KEY`, fixed `https://api.typesafe.ai/v1/systemone`, pinned `jev-1.13.0`.
- Baseline: `RADSYSX_GEMINI_API_KEY`, fixed Gemini `generateContent`, `gemini-3.8-flash`, fresh context with no tools or history.
- Fresh capture: the existing isolated Gemini DeepAgents worker and its existing Google/NCBI research destinations. Original PubMed sections are captured passively; normal research prompts and answers are unchanged.

Network commands reject `RADSYSX_APP_MODE=clinical` and unknown modes before loading keys. The default is research; pilot still requires explicit public/synthetic input. Local validation, blinding, reference freeze and comparison work without keys, including in clinical mode.

## Private inputs and commands

All paths are private POSIX files: owner-only directories (0700), regular files (0600), no symlinks. The default output root is ignored `tmp/jev-evaluations/`. Outputs use new run/export directories; existing results are never overwritten. Run locks prevent simultaneous writers. Copy only a selected blind export to reviewers, never the entire run directory.

First create a curated query manifest with this structure, choosing your own public query:

```json
{"schema_version":1,"data_class":"public_literature","queries":["Public PubMed research question"]}
```

Save it privately as `tmp/jev-evaluations/inputs/queries.json` after creating its parent directories with mode 0700, and set the file to 0600. The following commands require those real operator-prepared files. Capture prints actual snapshot export paths; substitute that returned path in replay.

```bash
.venv/bin/python -m backend.evidence_review capture --input tmp/jev-evaluations/inputs/queries.json
.venv/bin/python -m backend.evidence_review replay --snapshot /absolute/private/snapshot.json --evaluator jev
.venv/bin/python -m backend.evidence_review replay --snapshot /absolute/private/snapshot.json --evaluator gemini
.venv/bin/python -m backend.evidence_review resume --run /absolute/private/run-directory
```

`replay --annotations` accepts a JSON array of exact code-point spans and citation spans (`SpanAnnotation` in `contracts.py`). No generated answer text can be rewritten by an annotation. `replay --experiment` accepts a frozen `ExperimentConfig` from `study.py`, including models, resolved versions, generation configurations, their hashes, rubric hash, limits, declared practical margins and optional dated pricing. The runner records the complete request bytes and identities. Resume restores the original configuration and rejects changed request bytes; completed matching judgments are reused, while failed/interrupted work is explicitly retried under a new bounded deadline.

Every evaluation has at most two in-flight attempts, 40 pairs per snapshot, 10 seconds per attempt, one retry and 60 seconds per snapshot. Limits may be tightened. An interrupted or timed-out submitted request without a usage receipt has unknown billing. Reported token usage and dated price estimates are not account invoices.

## Study and blind references

`StudyManifest` in `study.py` is the strict suite schema. `snapshots` maps each canonical snapshot hash to a file path relative to the suite directory. Paths must remain inside that private directory. `cases` binds an exact snapshot, unit, evidence and pair ID to a case ID, real PMID (or null for synthetic fixtures), topic family, development/held-out partition, natural/constructed origin and challenge tags. Optional `annotations` are keyed by snapshot hash. The target is 200 pairs from at least 50 real PMIDs: 50 development and 150 held-out, without PMID/topic-family overlap. Synthetic fixtures cannot satisfy it.

```bash
.venv/bin/python -m backend.evidence_review validate-suite --suite /private/study/suite.json --require-target
.venv/bin/python -m backend.evidence_review blind --suite /private/study/suite.json
.venv/bin/python -m backend.evidence_review freeze-references --suite /private/study/suite.json --reviews /private/study/reviews.json --adjudications /private/study/adjudications.json
.venv/bin/python -m backend.evidence_review compare --suite /private/study/suite.json --references /private/study/references.json --runs /private/runs.json
```

A run list is `{"schema_version":1,"runs":["relative/run-directory"]}` relative to its own private directory. Comparison uses committed run manifests, never raw provider responses. Reports contain no active scripts or automatic network requests; source links require deliberate selection.

Blind packets include only exact claim/abstract fields, citation display, case hash, public/synthetic designation and natural/constructed origin. They exclude model outputs, confidence, reference labels, generation metadata and challenge tags. Two domain-qualified people must independently review each case, attest qualification and blinding, and return a JSON array of `HumanLabel` records:

```json
[{"schema_version":1,"case_id":"case-id-from-packet","pair_hash":"64-character-hash-from-packet","reviewer_id":"reviewer-1","qualification_attested":true,"blind_review_attested":true,"label":"supported","notes":"Independent rationale","version":"v1","submitted_at":"2026-09-22T00:00:00Z"}]
```

Use actual reviewer identities/attestations and timestamps. A different qualified adjudicator resolves disagreements with an `Adjudication` record; otherwise they remain unresolved. Supply `[]` as the adjudications file when none exist. Original reviews and revisions remain separate immutable artifacts. No model or software test substitutes for human references.

Five labels, each relative to one abstract:

- `supported`: all substantive parts supported within the abstract's scope and certainty.
- `partially_supported`: at least one part supported, others unaddressed, none contradicted.
- `contradicted`: at least one part contradicted, no independent part supported.
- `mixed`: different substantive parts supported and contradicted.
- `not_addressed`: no part supported or contradicted.

Missing/truncated/unavailable abstracts are excluded, not assigned semantic negatives. Confusion matrices use reference rows and prediction columns. Empty denominators and inadequate uncertainty intervals are unavailable. Completed-case metrics appear alongside failures, unreviewed contradictions, coverage and unknown costs. Paired intervals resample topic families 2,000 times; p50/p95 use nearest-rank quantiles. Held-out comparisons reject experiment/version/configuration drift. There is no automatic promotion decision.

## Failure and retention

Exit codes: 0 operation completed, 2 invalid input/configuration, 3 partial/provider/storage failure, 130 cancellation. A completed operation does not mean a positive quality result. Fixed errors omit source payloads, provider bodies, keys and private reasoning. SIGINT/SIGTERM stop new work and preserve committed outcomes. Crash-orphaned objects are not promoted or replayed; a committed start without a finish means interrupted with unknown usage.

Artifacts remain local until the operator deletes the selected private directories. There is no automatic pruning, upload, publication or app database write. Clinical accuracy, hosted CI, desktop integration, physical audio and live-provider readiness are separate from these software tests:

```bash
.venv/bin/python -m pytest backend/tests/evidence_review -q
```
