# Jev evidence evaluation: observed acceptance

Date: 2026-09-22. Software tested: `9b6a3ed8c969e4c357d58ba9575f4932e91f8d38`, branch `codex/jev-evidence-implementation`, descended from `codex/gemini-live-assistant` (`43d443ff`). Final independent review is pending at this evidence checkpoint.

## Engineering evidence

The explicit [operator CLI](../../backend/evidence_review/README.md) implements immutable public/synthetic snapshots, exact citation/span pairs, pinned Jev review, an independent Gemini baseline, bounded attempts/retries/deadlines, private resumable artifacts, blind reference handling and local reports. It does not modify research answers or add app routes/actions.

The combined evidence-review, research, Live, provider, credential and security suites passed **293 tests**. Python compilation, CLI help and `git diff --check` passed. Existing dependency/framework deprecation warnings remain. New nested immutable-JSON serialization warnings were reproduced and fixed with a regression test.

HTMLParser tests verify inert source markup, positive blind projections, exact Unicode answer round-trip and stylesheet-hash CSP. Browser security policy blocked opening the private file URL. Visual layout, keyboard operation and observed browser network silence are therefore **not verified**. No alternate surface or server was used to bypass that block. Hosted CI, Docker, OHIF, microphone and clinical acceptance were not run or implied.

## Actual provider probes

The same saved, explicitly fictional imaging claim and abstract were submitted once to each evaluator using the CLI and existing operator keys. Credentials and authentication headers were not retained in artifacts or logs.

| Evaluator | Requested / resolved model | Outcome | Attempt seconds | Reported usage |
| --- | --- | --- | --- | --- |
| Jev | `jev-1.13.0` / `jev-1.13.0` | Completed | 0.366 | 546 input, 60 output tokens |
| Gemini baseline | `gemini-3.8-flash` / `gemini-3.8-flash` | Completed | 3.362 | 212 prompt, 5 candidate, 89 thought, 306 total tokens |

Snapshot elapsed times were 0.377 s and 3.371 s respectively. These are single transport-acceptance observations, **not** representative performance estimates or evidence of quality superiority. No price table was frozen; cost remains unavailable rather than zero. Exact request bytes, hashes, outcomes and token receipts are in private run artifacts under `tmp/jev-evaluations/`.

A fresh public DeepAgents capture did not complete. A separate bounded diagnostic reproduced a `GoogleAPIError` from the Google server-error handler after `starting`, before any research-tool progress. The direct Gemini baseline succeeded independently. Do not infer that successful baseline REST means the graph's richer request is accepted. Failed capture usage/billing is unknown; no research answer was fabricated to replace it.

Rechecked primary sources: [TypeSafe API](https://docs.typesafe.ai/api), [models](https://docs.typesafe.ai/models), [Choice](https://docs.typesafe.ai/primitives/choice), [Gemini generateContent](https://ai.google.dev/api/generate-content), [structured output](https://ai.google.dev/gemini-api/docs/structured-output).

## Blinded corpus preparation

The existing fixed-origin `ResearchTools.search_pubmed` and passive `EvidenceCollector` retrieved original complete abstracts for 50 real PMIDs across ten radiology topic families. One empty/failed lung-screening retrieval was repeated with a broader public query. No cloud model selected or labeled the held-out cases.

The private `study/suite.json` contains 200 immutable sentence/abstract pairs: 50 development and 150 held-out, with PMID and topic-family separation. There are 50 natural published abstract excerpts and 150 explicitly constructed challenge claims. Challenges include compounds, explicit negation, population/modality mismatch, numerical overstatement, misleading quotation, instruction injection and unaddressed outcomes. Natural cases are published abstract sentences, **not** successful captured assistant answers; representative live-answer capture remains a limitation of this initial packet.

- Suite canonical-file SHA-256: `be42367f22e6ea6c38e6249602afd0c945a168a0a525b50e0b450ba30e2e4593`.
- Rubric SHA-256: `e698600d8fb0d5fc9a9aadf9ad8d2c0befae26c9c3c94b39dac8fa055599bb57`.
- `validate-suite --require-target`: input ready, 200 cases, 50 real PMIDs, 50/150 split, no input issues, zero resolved references, `human_labels_pending`.
- `blind`: generated private JSON and static HTML containing only the allowed evidence fields, case identity and natural/constructed origin.
- No held-out model inference, tuning, reference labels or quality comparison has been performed.

Private artifacts in the implementation worktree:

- `tmp/jev-evaluations/study/suite.json`: frozen initial corpus manifest and local immutable snapshot references.
- `tmp/jev-evaluations/study/review-template.json`: 200 empty review rows; qualifications/blinding default false, labels/timestamps empty. It is not a valid submitted review until completed by a real reviewer.
- `tmp/jev-evaluations/blind/blind-36e1cf86dacc467f8046f7cedd5fb763/exports/de65d28a13a14f5683427a1778eedade/blind.html`.
- `tmp/jev-evaluations/blind/blind-36e1cf86dacc467f8046f7cedd5fb763/exports/cd2646ad558f4a6385384c7910503f9f/blind.json`.

No abstract bodies, source claims, model labels, reviewer notes or credentials are committed to Git.

## Remaining quality gates

Two qualified people must label independently and attest blinding; a separate qualified adjudicator must resolve disagreements or leave them unresolved. Check five-label coverage in both partitions after adjudication. The packet's constructed cases need human relevance/ambiguity review, and successful natural assistant-answer capture would strengthen representativeness before freezing the final study.

Only then freeze development choices, practical margins, exact resolved models/configurations and dated pricing; evaluate the held-out corpus unchanged; compare paired cases and whole-workload coverage with uncertainty. No reviewer identities, qualifications or labels have been manufactured. No benefit, clinical accuracy or rollout approval is claimed.
