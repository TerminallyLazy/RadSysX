# Evidence Review DOX

## Purpose and ownership

Own the explicit offline public/synthetic evidence evaluator. This package has no clinical database, viewer authority, live observer or HTTP routes. Gemini/OpenAI conversation and existing research behavior remain unchanged.

## Contracts

- Read the root and backend DOX and approved Jev specification/plan under `docs/superpowers/`.
- Only operator-designated public literature or synthetic snapshots are eligible. Network evaluation is disabled in clinical mode.
- Preserve exact answer spans, original abstract sections, source completeness, canonical UTF-8 hashes and immutable records. Missing evidence is not a semantic negative.
- Credentials remain backend-only. Never log provider bodies, rejected input, keys or exception strings.
- All model calls are explicit, bounded and independent of the original research answer; no judgments feed app actions or generation.
- Private evaluation artifacts stay in ignored storage; human references remain separate from requests.
- Use declared Python dependencies and repo `.venv`; no path shims.

## Verification

`.venv/bin/python -m pytest backend/tests/evidence_review -q` uses synthetic fixtures and blocked live network access. Live-provider and human-quality acceptance are separate.

## Child DOX Index

None.

## Evaluation inputs and providers

- `sentence-citations-v1` keeps exact Unicode spans, compound sentences and separate cited abstracts. Ambiguous paragraph citation attachment is excluded; curated annotations must validate against original spans and sources.
- `settings.py` reads only explicitly requested deployment settings. Clinical/unknown modes reject network evaluation; Jev does not require Gemini credentials. The normal application provider catalog is unchanged.
- `typesafe.py` pins Jev 1.13.0 and validates all five-way probabilities, model identity and usage. Adapters issue one attempt; the runner owns retries/deadlines. Transport discards error bodies, rejects compression and bounds success bodies.

## Private persistence

- `artifacts.py` requires POSIX, rejects symlink paths and uses directory-relative descriptors. Storage roots/runs/directories are owner-only 0700, files 0600. Immutable content hashes are verified on every read; files are bounded and regular.
- Each writer holds a nonblocking run lock. Objects precede immutable manifest generations and an atomic HEAD pointer. Unreferenced objects are never promoted automatically; an unfinished committed attempt means interrupted/unknown billing.
- Exports use fresh private directories and allowlisted filenames. Retention and deletion remain operator-controlled; resume is always explicit.

## Evaluation scheduling

- `runner.py` validates the snapshot and rebuilds its annotated review plan before dispatch. At most two workers evaluate 40 pairs, with a 10-second attempt and 60-second snapshot ceiling, one identical-byte retry, interruptible backoff and five-second cleanup.
- Requests and attempt-start records are committed before dispatch; outcomes precede assessments. Storage failures stop scheduling. Cancellation, expiry, provider failure and semantic labels remain distinct.
- Explicit resume reuses completed assessments only when snapshot, unit, evidence, model, rubric and request identities match. Prior attempts remain auditable; unfinished/submitted attempts without usage retain unknown billing.

- `gemini.py` is a direct, single-turn `gemini-3.8-flash` reviewer. It receives the same claim/sections and rubric, with no research graph, tools, history, reference labels or cached context. It validates the resolved model and label, retains prompt/output/thinking usage separately and never invents probabilities. Frozen experiments must supply an expected resolved model; initial development defaults are temperature 1, 4000 output tokens and medium thinking.

## Human references and comparison

- `study.py` binds case identity to immutable snapshots/pairs, checks PMID/topic partitions, and distinguishes input readiness from human-label readiness. The real target is 200 pairs, at least 50 PMIDs, 50 development and 150 held-out cases. Synthetic fixtures cannot satisfy it.
- Reference freeze requires distinct, qualified, blinded reviewer attestations. Agreement resolves directly; disagreement requires a separate qualified adjudicator or remains unresolved. Review revisions are new artifacts. Hashes prove local integrity, not medical truth or reviewer identity.
- `metrics.py` reports explicit denominators, ordered five-label matrices, per-label precision/recall, failures and unreviewed reference contradictions, own-completed and paired-intersection results. Intervals use 2,000 deterministic topic-family resamples; insufficient groups/denominators remain unavailable. Latency quantiles use nearest rank. Missing pricing/usage remains unknown, and cached assessments are excluded from fresh latency.
- Held-out comparisons require frozen experiment, model, resolved version, rubric/configuration and limit identities. Reports never automatically promote an evaluator or modify answers.

## Local reports

- `report.py` emits static accessible HTML with escaped text, keyboard-operable native disclosures and a CSP that permits only its fixed stylesheet hash. It never fetches sources; source links are canonical PubMed or designated synthetic fixture HTTPS URLs.
- Blind exports positively select exact claim/citation/abstract fields, public/synthetic designation, constructed/natural origin and immutable case identity. They contain no model predictions, reference labels, generation metadata or suggested HTML. Case hashes support label submission; constructed claims are visibly distinguished from paper quotations.
- Run reports preserve the exact original answer and show abstract-scoped judgments, coverage, exclusions and unknown billing. Comparison exports require frozen references and display unresolved cases. Keep result reports away from blind reviewers until reference freeze.

## Explicit operator interface

- `python -m backend.evidence_review` exposes models, capture, replay, resume, blind, freeze-references, validate-suite and compare. See `README.md` for private input formats and destinations. Input files are bounded, owner-only regular files; suite/run-list paths cannot escape their private directory.
- Network mode is checked before settings/clients. Local commands never read credentials. SIGINT/SIGTERM signal cancellation; exit codes are 0 completed operation, 2 rejected configuration/input, 3 partial/provider/storage failure and 130 cancellation.
- CLI resume reconstructs the original configuration and rejects changed request bytes. Experiment generation configurations are retained alongside their hashes so replay/resume can enforce the same declared request.

- Paired estimates and their completion denominators are computed separately for development and held-out partitions; development performance never enters the held-out interval. Reports identify the held-out comparison explicitly.
- Output export failures return a storage failure and preserve the already-created run locator. Tests block operator dotenv reads; only temporary fixture files may exercise dotenv parsing.

- `nim.py` implements the `nvidia_nim` catalog and evaluator on fixed NVIDIA hosted endpoints. Use backend-only `RADSYSX_NVIDIA_API_KEY` and an explicit `replay --model`. Catalog output lists IDs only and does not certify tools, JSON support, availability or free usage. NIM judgments have no probabilities; exact response model/finish state/label and token usage are validated, reasoning text discarded. The shared runner owns limits, retries and immutable resume.
- NIM evaluation uses direct HTTP; NIM research uses the separate native DeepAgents/LangGraph worker. Capture remains Gemini-only so the existing study generation protocol stays fixed.

- Optional selected-unit evaluation projects executable pairs from the fully rebuilt immutable plan; it never rewrites the original answer or weakens span/citation validation. Selection is bound into explicit resume identity; old unselected CLI runs remain compatible.
- Callers may supply a synchronous pre-attempt guard and committed-progress callback. Guards prevent submission with a distinct nonsemantic reason, including on retries; callbacks see only successfully committed manifests. Callback persistence failure stops scheduling as local storage failure. Actor/database authority remains outside this package.

- `pubmed.py` retrieves only fixed-origin NCBI EFetch by exact canonical PMID citations, never model-supplied fetch URLs. It bounds bodies/nodes/depth, rejects redirects/compression/entity declarations, permits ordinary nonexpanding public DOCTYPE declarations, and reuses original `EvidenceCollector` section semantics. Missing/ambiguous/unsafe evidence is explicitly unavailable. Retrieval guards are caller-owned.
- `ArtifactStore.delete_run` is an explicit caller-authorized, locked, descriptor-relative removal of one verified private run. It rejects links/unsafe entries and cannot traverse other runs. The app service uses it only after owned source-history deletion cancels and joins linked work; offline retention remains operator-controlled.
- Sentence extraction preserves original offsets even when an answer ends with spaces/newlines. Trailing whitespace must not silently drop the final paragraph.
