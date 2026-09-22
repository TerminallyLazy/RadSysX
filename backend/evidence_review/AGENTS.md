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
