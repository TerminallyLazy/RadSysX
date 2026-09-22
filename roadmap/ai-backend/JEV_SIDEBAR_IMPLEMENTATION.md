# Jev sidebar evidence review

Implemented on `codex/jev-evidence-implementation`, 2026-09-22, following the approved [specification](../../docs/superpowers/specs/2026-09-22-jev-sidebar-evidence-review-design.md) and [native plan](../../docs/superpowers/plans/2026-09-22-jev-sidebar-evidence-review.md). Experimental public/synthetic abstract-support assessment; no clinical-validation claim.

## Where Jev runs

Open a completed PubMed research result in the AI sidebar, including your saved conversation, and select **Review evidence with Jev**. Preparation retrieves original abstracts from fixed NCBI EFetch endpoints and freezes the unchanged research answer. It makes no TypeSafe request.

Review the exact claims and abstract sections, exclude unwanted claims, and confirm that the selected text is public literature or synthetic material containing no patient information. **Start Jev review** sends only selected claim/abstract pairs through the backend to TypeSafe, pinned to `jev-1.13.0`. Voice/image attestation does not authorize this text transfer. No query, conversation history, report, patient/study identifier, image or audio enters the review request.

Each source receives its own judgment: Supported by this abstract, Partially supported, Contradicted by this abstract, Mixed or Not addressed. Missing/truncated evidence, excluded claims, timeouts and failures remain unreviewed, never semantic negatives. The original answer remains unchanged. Judgments do not feed the live assistant, reports or viewer actions.

**Settings → Jev** is a configuration row, not execution proof. Open a result's **Execution receipt** to see the requested/resolved model, exact hashes, rubric, timestamps, submission, new/reused status and token usage. Source sections identify when they were fetched for this review; they may differ from the bytes originally seen during research. Generation provenance is recorded at actual research dispatch; older unrecorded producers remain Unknown. Optional model probabilities are not probabilities of clinical truth.

## Runtime and data contracts

- Backend-only `RADSYSX_TYPESAFE_AI_API_KEY` supplies Jev. No new personal key vault or reviewer-model dropdown is introduced.
- Research/pilot, signed unexpired `ai.run` authority, owned completed result and explicit allowed Origin are required. Clinical mode disables review before external work. Bodies are bounded to 16 KiB, reject duplicate/extra fields and malformed JSON, and never echo rejected input. Review replies/errors are no-store.
- Preparation/start/retry/cancel are separate operations. Idempotency identity and starting state commit atomically. Frozen preview hash and backend-issued claim selection bind confirmation; arbitrary browser text/URLs are rejected.
- One active review per actor, two globally. Preparation is bounded to 20 seconds and evaluation/cleanup to 70 seconds. Existing 40-pair/20-abstract/input/attempt/retry limits remain enforced.
- End voice or change viewport without cancelling a separate review. Explicit review cancellation, account settings changes, logout/expiry, disable and shutdown stop it. Committed pairs survive partial failures; submitted attempts without a receipt show unknown usage/billing.
- Reopen/Refresh reads saved state without inference. Retry unfinished work requires renewed confirmation and reuses only exactly matching completed pairs. Restart interrupts work without replay. A confirmed operation interrupted before evaluator initialization can retry from its persisted selection only when the manifest is exactly the preparation-only checkpoint; initialized evaluations retain strict resume checks. Generation-guarded browser polling uses 1/2/4-second backoff and stops after 100 seconds until explicit refresh.
- Failed/interrupted preparation, cancelled/unavailable reviews or a preview with no eligible claims offers **Fetch abstracts again**. This explicitly creates a fresh owned preview, preserves previous records and requires fresh text confirmation before inference; reopening selects the latest preparation.
- Source-history deletion invalidates jobs, joins cancellation, removes private artifacts and then clears history. Failed cleanup retains a deletion marker for retry/startup; late callbacks cannot recreate deleted rows. Missing artifacts show unavailable, never implicit retrieval/inference.
- Private immutable artifacts use `.ai-evidence/` beside the actual file-backed database, POSIX 0700 directories/0600 files and existing no-symlink/hash guarantees. Set absolute `RADSYSX_AI_EVIDENCE_DIR` for a non-file database. No private locator reaches browser DTOs. Preserve the private directory with database backups.
- Direct `python backend/server.py` and package imports are supported. The pure evaluator and existing standalone CLI remain independently usable.

The AI sidebar uses a charcoal/slate reading-room palette with muted blue accents, subdued borders, dark scrollbars and no bright mint fills or status glow. Details expand inside research cards; permanent header space stays compact. The full NVIDIA research dropdown is retained. Native ChatNVIDIA still runs inside the bounded DeepAgents/LangGraph research lane; Jev itself uses the independent native evaluation service.

## Verification on 2026-09-22

| Check | Observed result |
| --- | --- |
| Focused backend/evaluator/security/voice/research suites | 520 passed; includes strict routes, ownership, cancellation/backoff, deletion/recovery, private storage, selection/provenance and API acceptance utility |
| Viewer controller/render/protocol suite | 41 passed, including native-fetch receiver, stale replies, explicit consent, uncertain idempotency and bounded mock-timer polling |
| Desktop capture/environment/dependency suite | 17 passed; TypeSafe/NVIDIA secrets removed from non-backend children |
| Type checking and Python compilation | Frontend/viewer/shared contracts and affected Python modules passed |
| Viewer production build | Passed; existing upstream bundle-size warnings remain |
| Guarded actual Electron/OHIF smoke | Preview made zero Jev calls; one selected pair completed; excluded text absent; second submission cancelled with unknown usage; voice end independent; saved reopen made no inference; delayed old-history reply discarded; fresh preparation required new consent without inference; deleting source removed three private runs |
| Narrow sidebar and settings | 280 × 852 px, 503 px conversation while connected; completed review at 280 × 867 px leaves 518 px for conversation; keyboard Tab and consent focus preserved; all 82 synthetic NVIDIA catalog entries retained |

The smoke substitutes only guarded synthetic provider/HTTP fixtures. It does not contact Google, OpenAI, NVIDIA, TypeSafe or NCBI, and uses a fake microphone and generated DICOM. It also executes actual OHIF tools through the existing adapter acceptance harness. Development repeats exposed transient capture-geometry/focus timing failures and an assumption that the resizable dock always opens at 280 px. The final smoke explicitly sizes the real sidebar to 280 px before review assertions; capture boundaries, keyboard checks and geometry thresholds remain intact. The complete repeat passed, and its native screenshot was visually inspected after the palette update.

### Real TypeSafe acceptance

Command: `.venv/bin/python -m backend.tools.accept_jev_sidebar --allow-live --env-file /absolute/operator/env/path`.

The utility refuses without `--allow-live` before reading credentials or creating clients. It composes the normal signed-owner HTTP router/service against disposable isolated persistence. NCBI is deliberately replaced by a synthetic source; the TypeSafe call uses the real transport. The temporary database is removed afterward. It never reads the user's clinical history or connects a conversation provider.

Observed one completed real request on 2026-09-22, 23:01:35 UTC:

- Resolved model: `jev-1.13.0`; observed label: `supported`.
- Exact claim: `The synthetic study reports 10 samples [s1].`
- Exact synthetic abstract: `The synthetic study reports 10 samples.`
- Provider-reported usage: **525 input / 60 output tokens**.
- Attempt: `2026-09-22T23:01:35.245545+00:00` → `2026-09-22T23:01:35.871904+00:00`.
- Request SHA-256: `31b762674f87ca75cea0cc2aba9eeeff87a66aa520fd1e8a35c8bcd5d6c3974f`.
- Private sanitized receipt: `tmp/jev-sidebar-acceptance/run-0mxnka5e/receipt.json` in the implementation worktree; ignored, not committed. Original answer unchanged.

This is **live TypeSafe with synthetic source**, not live NCBI retrieval or a diagnostic-quality benchmark. Hosted CI, compose/Orthanc, physical microphone/speaker acceptance and the 200-pair qualified human study are separate and unverified by these checks. No merge or clinical rollout is implied.

## Final code review

A fresh read-only `gpt-6-astra` review covered `2f22e89..ae8c6cc`. It found no critical issues and two important recovery defects: stranded preparations after failure/cancellation and retry after shutdown before evaluator initialization. Both were reproduced by failing regression tests and fixed in one native pass. The final 520-test backend suite, 41-test viewer suite, compilation/type checks, build and actual Electron recovery scenario passed. The final fixes were verified by those tests, not a second reviewer. No minor findings were deferred.

The reviewer separately declined to establish diagnostic accuracy or repeat external-provider/hardware acceptance. The qualified human study, live NCBI and hardware limitations above remain explicit; the recorded synthetic-source TypeSafe receipt establishes only that bounded provider execution.

## Follow-on work

[Jev/vision routing assessment](JEV_VISION_ROUTING.md) covers contextual tool suggestions and vision-model pairing. Jev is used here for text/abstract judgments. No image anomaly detector, automatic imaging-tool dispatch or new cloud image destination is added.
