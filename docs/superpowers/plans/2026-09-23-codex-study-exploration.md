# Codex Study Exploration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The user has already selected native execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the signed-in Codex model inspect the entire reading view or a selected series and operate the same authorized native imaging tools as the user, independently of Realtime, with visible coverage and action receipts.

**Architecture:** Extract transport-independent action policy from the existing Live runtime, then add an owned HTTP command channel and a scoped observation service. Codex receives typed dynamic tools and transient image results; OHIF/Cornerstone remains responsible for rendering, calibrated measurements and reversible edits. The sidebar exposes sharing, task activity and takeover while the backend owns permissions, deadlines and persisted receipts.

**Tech Stack:** Existing Python 3.12/FastAPI/Pydantic/SQLAlchemy backend, TypeScript OHIF adapter, Cornerstone, Electron, root-pinned `@openai/codex` 0.154.0, Node.js 24+, pytest and Node's test runner. No new model provider, billing path or general computer-control dependency.

**Spec:** [Approved study exploration design](../specs/2026-09-23-codex-study-exploration-design.md).

**Status:** Written design approved 2026-09-23. Implementation plan approved by the user on 2026-09-23 for native execution. Task progress and verification are recorded as work proceeds. Work branch: `codex/study-exploration-design`, based on merged `main` at `7a9cd84484fb5b5d6ffa621a8c2b5aa6852bf95c`.

## Global Constraints

- “synthetic/deidentified pilot work, a quiet and compact sidebar, backend-owned authority, reversible local edits, review before durable changes, and no saved raw image history.”
- “Keep exact model selection and existing isolated subscription authentication.”
- “Do not enable shell, arbitrary JavaScript, filesystem-image tools or general OS control.”
- “Sharing alone grants observation, not mutation.”
- “Pixels remain transient and bounded in memory.”
- “up to eight image items and 8 MiB encoded observation data per batch; no more than 128 image deliveries, 64 tool calls or ten minutes per run; one active exploration task per owner and two globally.” These are application budgets, not provider guarantees.
- “Image dimensions are bounded at 2,048 px per edge, with the actual resize/crop recorded.”
- “A 34-frame synthetic series must complete in a single normal run.”
- “A mutation with a lost receipt is **Outcome unknown**, is not retried, and requires state reconciliation or user takeover.”
- “Durable-action approval expires after two minutes and counts toward the ten-minute task deadline.”
- “No autonomous replay after reconnect.” Preserve clinical-mode disablement and existing signed-cookie authorization.
- “The actual desktop launch serves the new controls after a user-safe restart. Source/build checks alone do not establish activation.”
- Keep the root npm lockfile, pinned OHIF source build and repo-local Python environment. Read each owning `AGENTS.md` chain before editing its files. Preserve unrelated `.DS_Store` changes, open studies and unsent drafts.

## Review Focus

1. **Mixed studies in a multi-pane layout:** a shared view must not quietly authorize an unrelated patient's pane; reject mixed-study scope or ask the user to choose one study before capture (Tasks 1, 4, 5).
2. **Multi-frame, shuffled or changing series:** inventory every actual frame, preserve a stable order, detect inventory changes and avoid counting thumbnails or repeated frames as complete coverage (Tasks 1, 4, 9).
3. **Manual edits during an awaited action:** take over before another mutation; late receipts cannot overwrite newer state or erase uncertainty about an already applied edit (Tasks 2, 3, 10).
4. **Modality-specific calibration and tool availability:** anisotropic spacing, non-axial images, ultrasound calibration and missing volume geometry must produce native values or an explicit unavailable result, never invented units or fake parity (Tasks 6, 7, 11).
5. **Protocol backpressure and late completion:** oversized image events, a blocked writer, repeated tool calls or a disconnected renderer must release bounded buffers, preserve honest delivery/unknown states and stop within the task deadline (Tasks 3, 8, 9).

---

## File and interface map

This is one integrated feature: transport, permissions and image observations share task identity and lifecycle. The commits below are independently testable, but new controls stay disabled until the corresponding path passes acceptance. Do not split it into independently shipped pieces that bypass those contracts.

| Unit | Files and responsibility |
| --- | --- |
| Wire records and limits | New `backend/clinical/ai_exploration_contracts.py`, `ai_exploration_coverage.py`; new `packages/clinical-web/src/exploration.ts`; exports in `src/index.ts`; viewer `protocol.ts` imports/re-exports the shared types. |
| Shared action authority | New `backend/clinical/ai_actions.py`; reuse `ai_tools.py`, `ai_repository.py`, `ai_live.py` authorization, approvals and journal. |
| Owned task channel | New `backend/clinical/ai_exploration.py`, `ai_exploration_routes.py`, `ai_exploration_repository.py`; model additions in `models.py`; mount in `ai_routes.py`. |
| Renderer channel | New `viewer/assets/live/exploration.ts`; coordinates claims, renderer epoch, local checks and cancellation without a voice socket. |
| Observations | New `viewer/assets/live/observations.ts`, `series.ts`; scoped Electron capture in new `desktop/src/study-capture.mjs`, main/preload wiring. Preserve existing `live-capture.mjs` voice/single-image behavior. |
| Native tools | New `viewer/assets/live/capabilities.ts`, `measurements.ts`, `reading-tools.ts`; expand `ohif.ts` using pinned native services; strict backend schemas in `ai_tools.py`. |
| Codex bridge | New `backend/clinical/ai_codex_tools.py`; modify `ai_codex.py` dispatch, budgets and image-result acknowledgments. |
| Text orchestration | Modify `ai_text.py`, `ai_text_routes.py`; task-specific deadline and continuation, no change to Gemini/NVIDIA orchestration. |
| Product UI | New `viewer/assets/live/exploration-panel.ts`; integrate `controller.ts`, `panel.ts`, `radsysx-viewer.css`; retain separate Chat/Research/Jev workspaces. |
| Acceptance | New backend/Node regressions named below; new `desktop/scripts/study-exploration-smoke.mjs`, `codex-study-acceptance.mjs`, `study-exploration-fixtures.py`; extend guarded `ai_fixture_server.py`. |
| Durable guidance | Update closest owning DOX with each change; new `roadmap/ai-backend/CODEX_STUDY_EXPLORATION.md` and `CODEX_VIEWER_TOOL_MATRIX.md` record acceptance and inventory. Update `CODEX_SUBSCRIPTION.md`, root guidance/README and CI at closeout. |

All paths in the task lists are repository-relative. No generated `.cache`, `dist`, private database, credentials or synthetic run output belongs in Git.

### Shared record definitions

Use strict Pydantic records with `extra="forbid"`, finite numbers, bounded lists/strings, and camelCase aliases matching TypeScript. Public records never accept an actor, raw DICOM UID, image URL, filesystem path, selector or command name. `SessionClaims` is the existing backend actor type, supplied only by the session manager.

| Type | Fields and constraints |
| --- | --- |
| `ShareSelection` | `kind: current_image|entire_view|series`, `studyId`, `seriesIds` (1–32 opaque handles), `allowViewerTools: bool`; current-image compatibility uses the existing `ViewImage` path when no exploration is requested. |
| `RendererBinding` | `rendererId` (random per document), `epoch` (random per adapter binding), `contextVersion` (existing session context), `revision` (monotonic task viewer state), `studyId`, `seriesIds`. |
| `FrameDescriptor` | `id`, `index` (zero-based), `rows`, `columns`, optional finite `position[3]`, `orientation[6]`, `spacing[2]`; optional numeric `timeIndex`/`sliceIndex`. No arbitrary DICOM tags. |
| `SeriesManifest` | `manifestId`, `studyId`, `seriesId`, `modality` allowlist, `frameCount`, `ordering`, `frames: FrameDescriptor[]`. Pages contain at most 256 records; a complete digest binds ordering and frame count. |
| `ExplorationGrant` | Backend-issued `grantId`, `sessionId`, `taskId`, `modelId`, scope/binding, `permissions: observe|mutate|propose_durable`, `createdAt`, `expiresAt`, `status: prepared|active|paused|revoked|expired`. Owner stored server-side, not accepted from a body. |
| `ObservationRequest` | `kind: workspace|panes|series_frames`, optional `manifestId`, `frameIds` (0–8), `viewportIds` (0–8), presentation settings: window width/center, inversion and orientation enum. Expected binding comes from the command envelope. |
| `ImageObservation` | `imageId`, optional frame/viewport/manifest handles and index, `kind: overview|pane|frame|thumbnail`, original/output dimensions, crop/resize, presentation, captured timestamp, SHA-256 and transient JPEG `data`. |
| `ObservationResult` | Exact command binding, `images` (0–8), `failures` (bounded handle/reason pairs), `stateRevision`. Strict JPEG decode, dimensions and hash checked server-side; no bytes in `.receipt()`. |
| `ActionRequest` | `operationId`, `grantId`, `name` from typed registry, validated `args`, `expectedRevision`, deadline. Backend binds approval to its canonical digest. |
| `RendererCommand` | Task/action fields, renderer binding, command kind (`observe|action|manifest`), expiresAt; opaque `claimId` returned only by the claim endpoint. |
| `ActionResult` | `status: completed|failed|outcome_unknown`, `operationId`, `claimId`, before/after revision, allowlisted numeric/native state, `canUndo`, stable error code. |
| `CoverageReceipt` | `manifestId`, frame count, distinct requested/captured/delivered/failed indices, pending/unknown submissions, total image-delivery attempts, `status: pending|partial|complete`, run/model identity. Bounded paged frame ranges for large inventories. |
| `TaskSnapshot` | Grant metadata, run status, current activity, coverage summary, safe action receipts and continuation eligibility. Contains no commands eligible for execution and no image bytes. |

Source-of-truth boundaries: renderer geometry/availability is input validated against its registered manifest, not proof of clinical identity. Imported/governed study authority continues to come from the backend. Local-only studies can be explored after attestation but cannot acquire report-save permission by supplying aliases.

## Task 1: Strict contracts, budgets and coverage accounting

**Files:** Create contract/coverage modules and shared `exploration.ts` above; modify shared exports, `viewer/assets/live/protocol.ts`, `viewer/scripts/live-contracts.ts`; create `backend/tests/test_ai_exploration_contracts.py`, `test_ai_exploration_coverage.py`. Update `backend/clinical/AGENTS.md`, `packages/clinical-web/AGENTS.md` for the implemented wire contract.

**Interfaces:** `CoverageLedger(manifest_id: str, frame_ids: tuple[str, ...])`; `requested(ids)`, `captured(ids)`, `submitted(operation_id, ids, kind)`, `acknowledge(operation_id)`, `failed(ids, reason)`, `receipt() -> CoverageReceipt`. `RunBudget.reserve(*, images: int, calls: int, encoded_bytes: int, now: float)` and `check(now)` raise `BudgetExceeded` before allocation/dispatch. Define constants `MAX_BATCH_IMAGES=8`, `MAX_BATCH_BYTES=8*1024*1024`, `MAX_RUN_IMAGES=128`, `MAX_RUN_CALLS=64`, `MAX_RUN_SECONDS=600`, `MAX_EDGE=2048` in this module.

- [x] Write the coverage tests first, including the late-frame and non-frame cases:

```python
from backend.clinical.ai_exploration_coverage import CoverageLedger

def test_repeated_frames_and_thumbnail_do_not_finish_series():
    ledger = CoverageLedger('manifest-1', tuple(f'frame-{i}' for i in range(34)))
    ledger.requested([f'frame-{i}' for i in range(34)])
    ledger.captured([f'frame-{i}' for i in range(34)])
    for i in range(33):
        ledger.submitted(f'op-{i}', [f'frame-{i}'], kind='frame')
        ledger.acknowledge(f'op-{i}')
    ledger.submitted('repeat', ['frame-0'], kind='frame')
    ledger.acknowledge('repeat')
    ledger.submitted('preview', ['frame-33'], kind='thumbnail')
    ledger.acknowledge('preview')
    assert ledger.receipt().status == 'partial'
    assert ledger.receipt().delivered == list(range(33))
    ledger.submitted('last', ['frame-33'], kind='frame')
    assert ledger.receipt().status == 'partial'
    ledger.acknowledge('last')
    assert ledger.receipt().status == 'complete'
```

- [x] Run `.venv/bin/python -m pytest backend/tests/test_ai_exploration_coverage.py -q`; expect an import failure before implementation.
- [x] Implement the schemas and pure ledger/budget functions. Set membership must reject foreign frame IDs; acknowledge only a pending submission with the same immutable operation identity. A repeated delivery increases budget consumption but not distinct coverage. Pending delivery never becomes delivered on model answer completion alone.

```python
# Core invariant inside receipt(), after validating all frame IDs:
status = 'complete' if delivered == all_frames else ('partial' if attempted else 'pending')
# Transport submission and provider acknowledgment are distinct transitions.
# A thumbnail/overview may consume image budget, but never enters delivered.
```

- [x] Add parameterized schema tests for boolean-as-index, NaN/infinity, oversized lists, unknown fields, raw URLs/paths/UIDs, mixed-study scope and unknown handles. Define `synthetic_manifest(count=34)` in this test module using only opaque IDs and numeric geometry; test manifest digest changes when order or frame count changes.
- [x] Test exact budget boundaries and reservation rollback only before any bytes are sent; after a partial write count the attempt. Verify ten-minute wall time includes approvals and waiting. Run both new test files plus `npm run type-check --workspace viewer`.
- [x] Commit only these files and their owning DOX: `feat: define scoped exploration contracts and coverage`.

## Task 2: Extract shared action authorization without changing voice behavior

**Files:** Create `backend/clinical/ai_actions.py`; modify `ai_live.py`, `ai_tools.py`, `ai_repository.py`; create `backend/tests/test_ai_actions.py`; retain existing `test_ai_live.py`, `test_ai_openai.py`, `test_ai_connection_races.py` regressions.

**Interfaces:** `ActionBroker(live)`; `prepare(session_id, call_id, name, args, actor, *, context_version, grant=None) -> (tool, fresh)`; `decide(session_id, call_id, decision, actor, *, grant=None) -> tool`; `execute(session_id, call_id, actor, *, check, dispatch) -> ActionResult`. `dispatch(operation_id: str, name: str, args: dict) -> Awaitable[dict]` is injected by voice or the HTTP channel. Existing repository tool rows remain the shared action journal.

- [x] Add a regression around actual existing fixtures `live` and `authorize` from `backend/tests/test_ai_live.py`: duplicate `viewer_jump_to_slice` executes once; same call ID with different index fails; deletion/report-save requires immutable approval; report write uses the bound backend study. Use an async fake dispatch with a counter, not an alternate implementation:

```python
calls = []
async def dispatch(operation_id, name, args):
    calls.append((operation_id, name, args))
    return {'status': 'completed', 'state': {'index': args['index']}}
# Prepare the same validated request twice, execute the fresh result once,
# then request its receipt; assert len(calls) == 1 and state.index == 2.
```

- [x] Run `.venv/bin/python -m pytest backend/tests/test_ai_actions.py -q`; expect failure until `ActionBroker` exists.
- [x] Move validation, repository identity checks, approval binding, audit and report-save authorization out of `LiveRuntime.schedule_tool/decide/execute` into the broker. Keep provider responses, voice transport and research orchestration in the existing runtime. Do not make the broker depend on a WebSocket or assume the model owns the viewer.
- [x] Share the viewer-mutation lock across voice and text for the same actor/renderer, not just inside each transport. A tool-enabled exploration grant owns that renderer's mutation channel until completion/takeover; voice may continue talking or researching, but conflicting voice mutations return a fixed busy result. Observation-only tasks do not acquire mutation permission. Test a voice action racing a Codex action and assert only the granted command executes.
- [x] Add broker tests where `check()` revokes after an awaited renderer operation: persist `outcome_unknown` for a dispatched mutation with no valid receipt, reject subsequent dispatch, and never rewrite the result to success because the provider completed. Explicit denied/expired proposals never call dispatch.
- [x] Preserve the voice approval TTL and use the same two-minute ceiling for new tasks. Run action tests and the existing Live/OpenAI/connection-race files; confirm no voice schema or audio behavior changes. Update clinical DOX to name the shared owner.
- [x] Commit: `refactor: share viewer action authority across transports`.

## Task 3: Owned task channel, claims and lifecycle

**Files:** Create `ai_exploration.py`, `ai_exploration_routes.py`, `ai_exploration_repository.py`; modify `models.py`, `ai_routes.py`, `ai_live.py`; create `backend/tests/test_ai_exploration_routes.py`, `test_ai_exploration_lifecycle.py` and shared `backend/tests/exploration_helpers.py`.

**Interfaces:** `ExplorationService(live)` exposes `prepare`, `activate`, `snapshot`, `poll`, `claim`, `complete`, `decide`, `takeover`, `revoke`, `continue_run`, `stop_owner`, `shutdown`. Each takes the signed backend actor plus explicit session/task identity; `activate(task_id, tool_id, actor)` binds a prepared share to one text turn. Broker dispatch delegates to `await exploration.dispatch(task_id, operation_id, name, args, actor)`.

**HTTP contract:** All paths beneath `/api/ai/sidebar/sessions/{sessionId}/explorations`. POST root prepares scope; GET `/{taskId}` reads safe state; POST `/{taskId}/poll` supplies renderer ID/epoch and bounded wait; POST `/{taskId}/commands/{operationId}/claim` atomically claims; POST matching `/result` completes; POST `/{taskId}/decisions/{operationId}` reviews; POST `/{taskId}/takeover` revokes mutation authority and cancels current model work; POST `/{taskId}/stop` revokes all; POST `/{taskId}/continue` creates a fresh prepared run referencing the prior ledger. No execution command in history GETs.

- [x] Build `exploration_helpers.make_task(live, *, allow_tools=True, frames=34)` using the existing actor/session fixture and the Task 1 DTOs. It returns `(service, task, binding)`; helpers fabricate only renderer responses, never bypass production policy.
- [x] Write a route test that polls the same command twice but allows only one successful claim. Use two renderer epochs and assert the old epoch cannot post a result after replacement:

```python
first = await service.claim(task.task_id, 'op-1', binding, live.actor)
with pytest.raises(HTTPException) as rejected:
    await service.claim(task.task_id, 'op-1', binding.model_copy(update={'epoch': 'epoch-2'}), live.actor)
assert rejected.value.status_code == 409
assert first.claim_id
snapshot = await service.snapshot(task.task_id, live.actor)
assert 'claimId' not in json.dumps(snapshot.model_dump(by_alias=True))
```

- [x] Run both new test files and confirm the new service/routes are absent before implementation.
- [x] Persist task metadata, coverage ranges and action receipts in new SQLAlchemy tables using the existing additive schema initialization. Persist no pending command image data. Keep futures/pixels in a bounded in-memory map. Recovery marks unfinished tasks interrupted and revokes grants; deleting a source session cascades task metadata and cancels active work. Never restore an executable lease from the database.
- [x] Implement origin-required private routes, actor ownership, `ai.run`, clinical-mode disablement and strict body streaming. Metadata/claims are at most 64 KiB; only `/result` accepts 8 MiB encoded images plus 64 KiB metadata. Validate declared and streamed byte counts before JSON decoding. Omit validation input from errors. Poll waits at most 20 seconds; heartbeat every 5 seconds; revoke after 15 seconds without renderer heartbeat. Check authority before and after every await and immediately before applying a command locally.
- [x] Route manifest pages through the same claimed-result channel with at most 256 descriptors per page and the same 64 KiB metadata ceiling; page size is reduced if geometry makes a page exceed the ceiling. A complete inventory digest is committed only after every page validates. Preview preparation cannot start a provider call or create an unbounded queue of image requests.
- [x] Serialize mutations per task and bind deadline, immutable argument digest, expected revision and renderer epoch into each claim. Expired claims cannot be reclaimed. An action dispatched without a valid completion becomes unknown; observations may be requested again as new operations. Prepared grants expire after 60 seconds; activated runs expire at the earlier of actor expiry or ten minutes.
- [x] Add parameterized tests for wrong owner/origin, clinical mode, two tabs, heartbeat expiry, duplicate/changed results, stopped task, case switch, logout, model change, history deletion and restart. Assert one active task per owner/two globally; inactive prepared grants cannot reserve unbounded memory. Unknown mutation outcomes remain unknown on reload. Account/model changes call `stop_owner` from existing lifecycle paths.
- [x] Run new tests plus text/credential/provider lifecycle regressions. Update clinical/backend test DOX and commit: `feat: add owned cancellable viewer task channel`.

## Task 4: Complete manifests and bounded offscreen series observations

**Files:** Create `viewer/assets/live/series.ts`, `observations.ts`; modify `ohif.ts`; create `viewer/scripts/test-exploration.mjs`; include it in viewer `test:live`. Update `viewer/assets/live/AGENTS.md` and `viewer/scripts/AGENTS.md`.

**Interfaces:** `SeriesRegistry(adapter)` implements `manifest(seriesId, cursor?) -> SeriesManifest`, `resolve(frameId) -> renderer-private image ID`, `invalidate()`; IDs never cross to the model. `ObservationService(adapter, desktop)` implements `observe(request, binding, signal) -> Promise<ObservationResult>` and `dispose()`. `OHIFAdapter.studyBinding()` returns stable opaque study/series membership, separate from active-viewport `targetId`.

- [x] Write pure manifest tests with a 34-frame shuffled single/multi-frame fixture, two studies and a changing frame list. Assert stable full ordering, all multi-frame indices and digest invalidation. Test a renderer-private image ID containing a path/UID never appears in the public manifest:

```javascript
test('manifest includes late multi-frame images without exposing image IDs', () => {
  const frames = Array.from({ length: 34 }, (_, index) => ({
    imageId: `wadouri:PRIVATE_PATH?frame=${index}`, index,
    rows: 64, columns: 64, position: [0, 0, index], spacing: [0.7, 1.2],
  }));
  const manifest = buildManifest('study-1', 'series-1', frames);
  assert.equal(manifest.frameCount, 34);
  assert.equal(manifest.frames[33].index, 33);
  assert.doesNotMatch(JSON.stringify(manifest), /PRIVATE_PATH|wadouri|frame=/);
});
```

`buildManifest(studyId, seriesId, frames)` is a pure export from `series.ts`; its renderer-private input type includes `imageId`, index and Task 1 numeric geometry. Sort using the same OHIF display set image ordering, not filename or unverified instance-number sorting; preserve explicit temporal ordering where present.

- [x] Run `node viewer/scripts/build-live.mjs --compile` and `node --test viewer/scripts/test-exploration.mjs`; expect missing-module failure before implementation.
- [x] Resolve the complete current display set through OHIF's pinned data source and Cornerstone metadata, including enhanced/multi-frame IDs. Page inventories at 256 frames. A partial/unloaded inventory is labeled incomplete and cannot grant a full-series claim. Keep at most 32 manifests/10,000 descriptors per prepared task; exceeding the descriptor budget reports an explicit capacity limit before capture.
- [x] Render requested frames sequentially through one task-owned offscreen Cornerstone viewport using the same loader, rescale, VOI and geometry as the visible viewport. Await native image-render completion for the requested image; do not return the last canvas after a failed load. Never scroll or change the user's visible panes. Destroy the rendering engine/canvas and release only resources owned by this task on stop; do not purge shared user caches.

```typescript
// ObservationService implementation order; each boundary checks binding/signal.
const imageId = registry.resolve(frameId);
await renderer.setFrame(imageId, presentation, signal);
await renderer.waitForRendered(imageId, signal);
const jpeg = await renderer.encodeJpeg({ maxEdge: 2048, maxEncodedBytes: remainingBytes });
return makeFrameObservation(frameId, jpeg, renderer.geometry(), binding);
```

Define private `SeriesRenderer.setFrame`, `waitForRendered`, `encodeJpeg`, `geometry`, `dispose` in `series.ts`; `makeFrameObservation` in `observations.ts` creates the Task 1 DTO with digest/dimensions. Use a 1 MiB encoded per-image ceiling within the 8 MiB batch; if bounded encoding cannot preserve a usable image at the requested settings, report the frame failure rather than silently drop it.
- [x] Test abort during decode, wrong render-completion image, one failed late frame, unsupported viewport type, invalid geometry, mixed-study request, stale binding and oversized data. Use injected renderer doubles for cancellation/order; reserve actual calibrated pixel fidelity for Task 11 native fixtures. Thumbnails explicitly use `kind: thumbnail` and never update coverage.
- [x] Run viewer checks, document supported/unsupported rendering cases and commit: `feat: render scoped series observations without moving the reader`.

## Task 5: Entire-view capture through Electron with explicit scope

**Files:** Create `desktop/src/study-capture.mjs`, `desktop/tests/study-capture.test.mjs`; modify `desktop/src/main.mjs`, `preload.cjs`, desktop `package.json`, `viewer/assets/live/observations.ts`, shared `exploration.ts`. Update `desktop/AGENTS.md`.

**Interfaces:** `StudyCapture({ getWindow, getTask })` implements `start(event, binding)`, `capture(event, {leaseId, operationId, kind, viewportIds})`, `stop(event, {leaseId})`. Expose only these scoped methods through preload as `startStudyCapture`, `captureStudyObservation`, `stopStudyCapture`. Main resolves fixed reading-workspace and native viewport regions; model input contains no rectangles or selectors.

- [x] Add Electron-boundary tests using the existing `live-capture.test.mjs` event/window fixture pattern. Test foreign window/frame/origin, expired grant, mixed study panes, hidden pane and sensitive settings. A test passes `rect`, `selector`, `path` and `url` extra properties and expects rejection.

```javascript
await assert.rejects(capture.start(foreignSender, binding), /not allowed/);
await assert.rejects(capture.capture(ownerSender, {
  leaseId, operationId: 'op-1', kind: 'workspace', selector: 'body',
}), /invalid/i);
// settingsOpen is provided by the trusted app surface probe used by the fixture.
settingsOpen = true;
await assert.rejects(capture.capture(ownerSender, {
  leaseId, operationId: 'op-2', kind: 'workspace', viewportIds: [],
}), /settings|sensitive/i);
```

- [x] Run `node --test desktop/tests/study-capture.test.mjs` and confirm failure before adding the class.
- [x] Reuse `assertDesktopSender` and same-origin frame/route checks from `live-capture.mjs`. Fetch task authority with the Electron cookie jar; never accept a renderer-provided attestation as the authority. Check task, binding and sensitive surfaces before and after capture; stop/expiry invalidates in-flight results. Keep existing voice/single-image IPC unchanged.
- [x] Register a fixed app-owned reading workspace region containing image grid and reading controls while excluding conversation, credentials and unrelated panels. Capture overview and each visible pane separately, retaining overlays. More than seven panes plus overview requires multiple batches tied to one frozen view revision; any intervening layout change invalidates the group. Same-study membership is required for every included pane. At unsupported surfaces return a stable unavailable reason instead of capturing the entire window.
- [x] Test zoom/device-pixel-ratio/crop metadata, edge and byte bounds, overlapping captures, 15-second capture lease expiry and navigation during an awaited capture. Run `npm run desktop:test:live` including the new test file and preserve all existing capture tests.
- [x] Update desktop DOX and commit: `feat: capture the scoped reading workspace and visible panes`.

## Task 6: Discover capabilities and implement navigation/presentation parity

**Files:** Create `viewer/assets/live/capabilities.ts`, `reading-tools.ts`; modify `ohif.ts`, `backend/clinical/ai_tools.py`; create `backend/tests/test_ai_exploration_tools.py`; expand `viewer/scripts/test-exploration.mjs`; create `roadmap/ai-backend/CODEX_VIEWER_TOOL_MATRIX.md` with its owning DOX entry.

**Interfaces:** `capabilities(adapter) -> ViewerCapability[]`; each entry has a stable semantic name, strict JSON argument schema, permission, available flag/reason and native handler ID for local verification. `executeReadingTool(adapter, name, args, signal) -> Promise<ActionResult>` runs only registered handlers. `OHIFAdapter.execute` delegates to this registry after validating availability.

- [x] Inventory the actual built mode and its toolbar/service controls. Source anchors are pinned OHIF `modes/basic/src/index.tsx`, `initToolGroups.ts`, `extensions/cornerstone/src/customizations/toolbarButtonsCustomization.ts`, `commandsModule.ts` and the RadSysX mode/extension. Read `.cache` for investigation, never edit it. Record mode/tool availability, native handler, permission, receipt and native fixture status for every enabled reading control; compare that inventory with the actual runtime, not just the upstream list.
- [x] Write registry tests that an unknown native command cannot be executed, a disabled control is returned as unavailable and the selected capability matches current data/tool group. Add backend tests rejecting nonfinite view parameters and arbitrary command names. Compile/run new tests before implementation.

```javascript
const result = capabilities(adapter);
assert.ok(result.every(item => typeof item.available === 'boolean'));
await assert.rejects(executeReadingTool(adapter, 'runCommand', { name: 'anything' }, signal));
assert.equal(result.find(item => item.name === 'viewer_set_cine').available, false);
```

- [x] Cover native pane selection, series/slice navigation, layout, window/level, zoom/pan/rotation/flips/inversion/reset, orientation, reference lines, sync, overlay visibility and panel selection. Add explicit schemas `viewer_select_viewport`, `viewer_set_orientation`, `viewer_set_overlays`, `viewer_set_sync`, `viewer_open_panel`; panel enums are series/measurements/segmentation/report only. Reading state is allowlisted numeric/neutral state; tag browser is not exposed because it contains identifying metadata.
- [x] Add `viewer_set_cine({viewportId, playing, fps})`, `viewer_set_mpr({layout})`, `viewer_set_crosshair({viewportId, worldPoint})` and `viewer_set_fusion({viewportId, opacity, preset})` only through available pinned services. `fps` is finite 1–60; opacity 0–1; world coordinates must lie in the selected volume. More advanced enabled reading controls discovered in the inventory receive an explicit validated schema/handler in this same registry before parity can pass; never make `name` an arbitrary native command.
- [x] Native presentation changes save enough pre-state to support explicit restore/undo, use the native history where it supports that operation, and return post-state only after the service/render update completes. A layout action cannot silently grant pixels from a newly selected series; observation scope remains the explicitly shared series set. Navigation within the same study changes task revision through the observed action, while a different study requires fresh scope.
- [x] Classify enabled controls outside the grant explicitly in the matrix: tag browser/identifying metadata, account settings and filesystem dialogs are privacy exclusions; export/writeback remain unavailable until an authoritative reviewed endpoint exists. Do not disable an ordinary user reading control merely to make the parity inventory pass. Missing handlers for in-scope enabled reading controls remain a release blocker.
- [x] Add tests for expected model navigation versus manual case switch, MPR without usable volume geometry, cine stop on takeover and fusion source membership. Update the matrix with implementation status, leaving native fixture columns unverified until Task 11. Run viewer tests/backend tool tests and commit: `feat: expose native reading capabilities and verified navigation`.

## Task 7: Calibrated measurement, annotation and segmentation operations

**Files:** Create `viewer/assets/live/measurements.ts`; modify `ohif.ts`, `reading-tools.ts`, `capabilities.ts`, `backend/clinical/ai_tools.py`; expand the Task 6 test files and tool matrix.

**Interfaces:** `measurementSpecs` declares supported geometry per native tool; `applyMeasurement(adapter, args, signal) -> Promise<ActionResult>`; `readMeasurements(adapter, seriesIds) -> MeasurementValue[]`. `MeasurementValue` contains opaque measurement/frame IDs, tool type, numeric geometry, numeric native value/unit and calculation status; excludes free-text imported labels. Backend `viewer_measurement` retains create/update/delete/jump with a discriminated geometry schema.

- [ ] Write parameterized point-count tests: Length/ArrowAnnotate 2; Angle 3; CobbAngle/Bidirectional 4; Probe 1; ROI shapes use their native handle contract; bounded freehand/spline paths allow 3–256 finite points. Supply normalized canvas points only with a captured viewport/frame/revision, or finite world coordinates bound to manifest geometry. Out-of-bounds/degenerate/nonfinite points fail before native mutation.

```python
@pytest.mark.parametrize('tool,count', [('Length', 1), ('Angle', 2), ('CobbAngle', 3)])
def test_wrong_geometry_never_becomes_a_native_annotation(tool, count):
    with pytest.raises(ValueError):
        validate_tool('viewer_measurement', {
            'operation': 'create', 'type': tool,
            'points': [[0.2, 0.3]] * count,
        })
```

- [ ] Run backend tool tests and viewer tests; capture new failures for schemas/handlers absent from the current three-tool implementation.
- [ ] Use the actual registered Cornerstone tool annotation creation/edit path and measurement-service registration. Convert geometry using its viewport/frame transform, await native statistics and return calculated values. Preserve native calibration semantics for anisotropic CT, oblique orientation and ultrasound; unavailable calibration returns `unit: null`/explicit status, never a guessed millimetre value.
- [ ] Implement the enabled inventory tools, including ROI/angle/probe/freehand variants, not merely selection via `setToolActive`. Readback/edit/jump/visibility, shared native undo/redo and report-draft history must work together. Native type-specific adapters live in `measurements.ts`, avoiding further growth of the large `ohif.ts` switch. Unsupported-on-current-data tools remain honestly unavailable; enabled-but-unimplemented reading controls block the parity release gate.
- [ ] Expose native segmentation selection/visibility and enabled reversible segment-edit controls using the actual segmentation service and history. Validate segmentation/segment IDs against the selected study. Add `viewer_segmentation` strict variants for native edits actually enabled in the shipped mode; do not invent inference, create masks from model prose, or expose a durable export action. Deletion retains broker review. Draft report edits remain visibly unsaved; report persistence stays exclusively in `ActionBroker` and the clinical service.
- [ ] Test unknown measurement IDs, late calculation, failed registration, geometry edit without reusing stale statistics, delete denial and report-draft/measurement undo ordering. Update the tool matrix with exact native-test requirements: stack CT, calibrated oblique/anisotropic CT, ultrasound regions, generated volume, segmentation labelmap and temporal multi-frame fixtures as applicable.
- [ ] Run focused backend/viewer suites, update local DOX and commit: `feat: add calibrated native measurement and annotation parity`.

## Task 8: Codex dynamic tools with image results and acknowledged delivery

**Files:** Create `backend/clinical/ai_codex_tools.py`; modify `ai_codex.py`; create `backend/tests/test_ai_codex_exploration.py`; extend `test_ai_codex.py` without replacing existing subscription/image tests.

**Interfaces:** `CodexToolBridge(exploration, task_id, actor)` exposes `declarations() -> list[dict]`, `call(call_id, name, arguments) -> DynamicToolResult`, `acknowledge(call_id)` and `close()`. `DynamicToolResult` is an internal record with `success`, `content_items` and a safe receipt; image bytes exist only in `content_items` until the write/ack lifecycle releases them. Extend `CodexService.run(..., exploration=None)`; existing callers remain source-compatible.

- [ ] Use the pinned CLI to regenerate protocol schemas into ignored temporary output. Confirm `DynamicToolCallParams` binds `threadId`, `turnId`, `callId`; response items are `inputText/text` and `inputImage/imageUrl`. Inspect the pinned dynamic-tool completion item to establish the exact acknowledgment ID; do not count stdin `drain()` as provider acknowledgment. If completion notifications cannot establish delivery, retain `submitted/unconfirmed` coverage and resolve that protocol gap before enabling full-delivery claims.
- [ ] Extend `FakeCodex` fixtures to emit a dynamic observation request, accept text plus two image items, acknowledge that exact call, then issue a typed navigation call. Run the new test and expect the current PubMed-only dispatcher to reject it.

```python
expected_result = {
    'success': True,
    'contentItems': [
        {'type': 'inputText', 'text': '{"operationId":"op-1","frameIndices":[0,1]}'},
        {'type': 'inputImage', 'imageUrl': 'data:image/jpeg;base64,' + jpeg_a},
        {'type': 'inputImage', 'imageUrl': 'data:image/jpeg;base64,' + jpeg_b},
    ],
}
# Assert the dispatch response equals this shape, binds callId to op-1,
# and leaves coverage pending until the matching tool completion arrives.
```

- [ ] Register `viewer_get_capabilities`, `viewer_get_state`, `viewer_observe`, `series_get_manifest`, `series_read_frames` plus the authorized Task 6/7 action schemas. Keep PubMed on research tasks and preserve its separate eight-search bound. Count every dynamic call toward the 64-call exploration limit. Check frozen model image support and current authority at dispatch, after rendering and before writing image data.
- [ ] Serialize writes with a bounded writer lock, cap a JSON-RPC line at 12 MiB, set the reader limit accordingly and reject oversized responses privately. Allow at most one in-flight image batch per task, eight images/8 MiB encoded, plus one bounded serialized copy; release content references after acknowledgment or terminal failure. Timeout blocked writes within 15 seconds or the earlier run deadline; terminate the private process on an uncertain protocol state without replay. Never print protocol frames or include them in exception messages.
- [ ] Identity is `(threadId, turnId, callId)`; JSON-RPC request ID is transport only. A repeated completed mutation returns its safe recorded result. A repeated image call must not resend discarded pixels invisibly: return its prior receipt with `pixelsUnavailable: true` and require a new observation call if fresh pixels are needed. Changed arguments or unknown namespaces fail closed. Limit concurrent provider dispatch handlers so a burst cannot grow unbounded tasks before budget checks.
- [ ] Test unknown/mismatched thread/turn/call, invalid namespace, duplicate calls, expired account/grant, image auth loss during capture, oversized line, bounded writer stall, late acknowledgment and provider stop. Keep general shell/browser/computer/MCP/filesystem capabilities disabled and verify the returned execution configuration as today.
- [ ] Run old/new Codex backend suites; update clinical DOX and commit: `feat: return scoped viewer observations through Codex tools`.

## Task 9: Text-turn orchestration, continuation and literature boundaries

**Files:** Modify `ai_text.py`, `ai_text_routes.py`, `ai_exploration.py`, `ai_exploration_repository.py`, shared text DTOs; create `backend/tests/test_ai_text_exploration.py`; update `backend/clinical/AGENTS.md`.

**Interfaces:** `TextTurnRequest.explorationId: str | None`; an exploration and the old `image` attachment cannot both be supplied. `ExplorationService.activate` binds a prepared grant to the turn's exact idempotency key and model. `continue_run(previous_task_id, selection, binding, actor) -> ExplorationGrant` copies only coverage metadata after confirming the same manifest and explicit renewed scope.

- [ ] Write integration tests using the real TextService and fake Codex protocol: a 34-frame task completes five bounded image batches; an early model stop returns partial; a 129-frame task never claims full coverage; continuation fills remaining frames without replaying old images. A changed manifest starts separate coverage.

```python
assert result['exploration']['coverage']['delivered'] == list(range(34))
assert result['exploration']['coverage']['status'] == 'complete'
assert live.service.runtimes == {}  # No Realtime provider needed.
assert 'data:image' not in json.dumps(live.service.repository.history(sid, live.actor))
```

- [ ] Run `.venv/bin/python -m pytest backend/tests/test_ai_text_exploration.py -q`; expect missing exploration support.
- [ ] Route only explicit Codex exploration requests into the bridge. Preserve the existing 120-second text/research limits for ordinary requests; exploration uses the shared ten-minute deadline, shortened by actor expiry. Avoid nested independent capacity semaphores deadlocking the existing two-job limit. Revalidate session/model/scope after catalog calls; normal text still captures nothing.
- [ ] Expose `exploration` capability only when the desktop renderer protocol and backend schemas agree, a supported exact subscription model advertises images, and the required observation services are present. Before final acceptance keep the controls on this unmerged feature branch; do not advertise incomplete coverage/tool parity on `main`.
- [ ] For series mode, provide the complete manifest count and bounded manifest paging tool. Direct the model to request all remaining ordered frames before claiming a complete review, then revisit as needed. Backend coverage derives exclusively from receipts; it never trusts the prose. If the model finishes early, retain the answer plus **Partial review** and continuation, without automatically starting another billed run. A 34-frame real acceptance remains mandatory even if all fake tests pass.
- [ ] Keep `requested`, `captured`, `submitted/unconfirmed`, `delivered` and `failed` distinct. Persist model/run IDs, coverage ranges and action receipts on cancellation/failure, not only success. Continuation sends a bounded neutral summary and prior coverage, explicitly marks old pixels absent, and counts newly delivered repeats toward the new run budget. Stop clears transient pixels and cannot erase or replay an already applied mutation.
- [ ] Preserve PubMed's source ledger and Jev eligibility rules; image observations are not PubMed citations. Search queries are a separate public-concepts request, not a serialization of measurements, DICOM labels or image bytes. Tool schemas reject identifiers/extra payload fields and existing public-literature consent remains. Jev gets no observation objects or grant handles; it still requires independently previewed public text/abstract confirmation.
- [ ] Add failure tests for original text idempotency with a different exploration ID, account switch during activation, concurrent ordinary/exploration requests, history deletion, no search performed, no automatic continuation and normal Gemini/NVIDIA behavior. Run text/Codex/evidence regressions and commit: `feat: orchestrate scoped study review and honest continuation`.

## Task 10: Compact sharing, activity and takeover in the sidebar

**Files:** Create `viewer/assets/live/exploration.ts`, `exploration-panel.ts`; modify `controller.ts`, `panel.ts`, `protocol.ts`, `viewer/assets/radsysx-viewer.css`; extend `viewer/scripts/test-exploration.mjs`, `test-subscription.mjs` and contract checks. Update viewer/assets/live DOX.

**Interfaces:** `ExplorationController` implements `prepare(selection)`, `start(task)`, `stop()`, `takeover()`, `continueReview(task)`, `dispose()` and exposes read-only `snapshot`. It owns the renderer epoch, abort controllers, polling and one serial mutation queue. `explorationMarkup(snapshot, selection)` returns escaped UI markup; event listeners call typed controller actions, never model-generated HTML.

- [ ] Write UI/state tests for Share choices, read-only versus viewer-tools permission, preview labels, keyboard focus, task status and coverage. Scope selection changes before Send invalidate the prepared grant. Old single-image capture/removal/unsent-draft behavior remains intact.

```javascript
const html = explorationMarkup({
  status: 'completed', coverage: { frameCount: 34, delivered: [0, 1], status: 'partial' },
  activity: null, actions: [],
}, { kind: 'series', allowViewerTools: false });
assert.match(html, /Partial review/);
assert.match(html, /2\/34 frames delivered/);
assert.doesNotMatch(html, /34\/34|all frames reviewed/i);
assert.match(html, /Continue review/);
```

- [ ] Compile/run viewer tests and confirm new controls/rendering fail before implementation.
- [ ] Add one Share menu near the composer, a compact scope chip, optional **Allow viewer tools**, and one progress line with Stop/Take over. Series selection shows the full frame count plus clearly labeled representative previews. Entire view explains all included panes. Image sharing and mutations are separate choices. Keep technical actions/coverage receipts collapsed, avoid duplicate task cards, and retain the quiet existing palette. The microphone and Realtime connection stay optional and independent.
- [ ] Start command polling only for the active task/renderer epoch. Claim, recheck local binding/signal, execute through `ObservationService` or `OHIFAdapter`, then post one result. Route returned approval proposals to the existing exact-text approval UI. Never execute entries from session history or task snapshots. Recreating/remounting the sidebar can display progress but cannot silently assume a lost execution lease.
- [ ] Distinguish expected changes made while executing the current operation from trusted user pointer/keyboard/tool events. Manual reading interaction pauses mutations immediately; **Take over** additionally cancels model work and revokes the task. Keep the user's just-made change. A different case, disposed adapter, navigation, account/model change or sensitive settings dialog revokes capture/dispatch. Use `AbortController` through every awaited observation boundary; late callbacks do not replace a newer draft or view.
- [ ] Test delayed capture after Stop, old epoch polling, manual edit during an awaited mutation, queued action after takeover, historical review reopening and keyboard focus while polling. Assert no preview `<img>` is visible before a valid source exists; do not expand Impeccable suppressions for newly introduced elements. Validate native layout at 360 px rail width and a short window in Task 11.
- [ ] Run all viewer tests/type checks, update DOX and commit: `feat: add study sharing and observable viewer assistance`.

## Task 11: Native tool, multi-frame and real subscription acceptance

**Files:** Create `desktop/scripts/study-exploration-fixtures.py`, `study-exploration-smoke.mjs`, `codex-study-acceptance.mjs`; extend guarded `backend/clinical/ai_fixture_server.py`, desktop scripts/package scripts and backend fixture tests. Record results in `roadmap/ai-backend/CODEX_STUDY_EXPLORATION.md` and the tool matrix; update desktop/roadmap DOX.

**Interfaces:** Fixture generator accepts `--output <private-directory>` and creates only synthetic data. Both harnesses accept `--output <private-directory>` and `--model <exact-model-id>` where relevant. Synthetic smoke uses isolated profile/database/high ports, fake subscription transport and production renderer/channel/broker; real acceptance uses the normal backend and an authorized RadSysX subscription, never copied Codex auth files.

- [ ] Generate a 34-frame CT with anisotropic known spacing and a visibly encoded randomized late-frame marker. Keep the marker's expected answer only in the harness; do not put it in DICOM tags, filenames, prompt, manifest or metadata. Add a multiframe temporal series, oblique calibrated stack, MPR-ready volume and small segmentation fixture. Add ultrasound-region calibration and other fixture types needed by the actual enabled-tool matrix. No patient data or downloads are required.
- [ ] Build a deterministic fake Codex dialogue that calls capabilities → manifest → frame batches → window change → fresh image → measurement → readback → undo/redo. Test 34/34 delivery and a partial failed-frame scenario. Verify a multi-pane overview plus individual-pane receipts, zero Realtime connections and no saved image bytes. Run:

```bash
node desktop/scripts/study-exploration-smoke.mjs
node desktop/scripts/ui-import-smoke.mjs --local-start --vision
```

The new smoke must initially fail on missing production feature behavior, then pass without weakening its expected coverage/action assertions.
- [ ] Exercise every enabled reading-tool matrix entry through the actual native adapter, comparing observed service state and measurements with fixture ground truth. At minimum prove layout/presentation, series/slice navigation, calibrated creation/edit/readback, native undo/redo, available segmentation visibility and report-save denial/approval. Imported/governed synthetic report-save must use backend permissions; a local-only image remains unsavable. Unverified enabled controls block the parity claim; never mark them complete from doubles.
- [ ] Run native Stop/takeover, manual interference, reload, capture during settings and lost-receipt scenarios. Verify capture engines, queues, timers and buffers are released. Inspect saved database/journal output for known synthetic identifiers, raw image sentinels and data URLs. Retain only deliberate private synthetic screenshots for visual review, with collapsed receipts, short-height/narrow-rail layouts and no placeholder images.
- [ ] Run an explicit real subscription acceptance with exact `gpt-6-astra`, generated images and production code: tool-result images, late-frame marker, all 34 delivered, a request→native action→fresh observation loop, and public research with ledger citations. First check signed-in status/catalog through normal Codex APIs. If login is required, hand browser/password steps to the user; never read auth files. If using the current signed-in actor, coordinate with its existing tasks, do not replace its model/settings or session state silently.

```bash
node desktop/scripts/codex-study-acceptance.mjs --model gpt-6-astra --output tmp/codex-study-acceptance
```

- [ ] Record exact source/build revision, model, safe task/tool IDs, timestamp, frame coverage, marker result and native actions. Separate synthetic protocol proof, real tool operation, real subscription delivery and clinical validation. Failed/partial real acceptance is a remaining gap, not permission to substitute another model or infer completion from an initial-image test.
- [ ] Commit only harness code and redacted guidance: `test: verify native study exploration and subscription delivery`.

## Task 12: Review, CI, release and actual desktop activation

**Files:** Modify `.github/workflows/security-regressions.yml` as needed to include the new suites; update root `AGENTS.md`, `README.md`, closest owning DOX, `roadmap/ai-backend/CODEX_SUBSCRIPTION.md`, the new runbook/tool matrix and this plan's checkboxes. Do not change unrelated guidance or private runtime files.

- [ ] Perform a spec-to-code review: grant boundaries, complete manifest, capture privacy, tool parity, unknown outcomes, delivery acknowledgment and continuation. Use the fresh whole-branch review required by the selected execution skill. Fix concrete defects and rerun only affected checks before the final suite.
- [ ] Add new tests to CI's existing clinical/AI/browser/desktop jobs; preserve audits and CodeQL. Run the complete affected local checks once:

```bash
.venv/bin/python -m pytest backend/tests/test_ai_actions.py backend/tests/test_ai_exploration_contracts.py backend/tests/test_ai_exploration_coverage.py backend/tests/test_ai_exploration_routes.py backend/tests/test_ai_exploration_lifecycle.py backend/tests/test_ai_exploration_tools.py backend/tests/test_ai_codex_exploration.py backend/tests/test_ai_text_exploration.py backend/tests/test_ai_codex.py backend/tests/test_ai_text.py backend/tests/test_ai_live.py backend/tests/test_ai_openai.py backend/tests/test_ai_connection_races.py -q
npm run test:live --workspace viewer
npm run desktop:test:live
npm run type-check
npm run build --workspace viewer
npm run build --workspace frontend
npm run desktop -- --check-only
git diff --check
```

Also run `.venv/bin/python -m pytest backend/tests/test_ai_evidence_review.py backend/tests/test_ai_evidence_routes.py backend/tests/test_ai_evidence_provenance.py -q` and `node desktop/scripts/evidence-review-smoke.mjs`, because result envelopes/history and sidebar mounting changed. Run desktop smoke processes sequentially. Native acceptance results from Task 11 need repetition only after relevant changes.
- [ ] Check current branch/diff, stage only intended files, push and create the feature PR with the concrete resulting behavior and actual validation evidence. Attach it to the task. Follow existing user authorization for commit/push/PR/merge; verify current-head required CI and reviews before a normal merge. Do not use admin bypass or describe skipped third-party reviews as successful.
- [ ] Confirm the merged remote ref, bring the working checkout to merged main without overwriting unrelated edits, and check desktop bootstrap/build stamps and runtime process paths. The user has an open study/draft and an earlier restart question was unanswered: resolve that specific state-loss risk before restarting their actual app unless they already closed/restarted or explicitly authorized it. Do all builds/tests first so restart is the final operational step.
- [ ] Launch through `npm run desktop`, never the bare Electron binary. Verify the new Share/Series/Allow viewer tools controls in the actual served build. Use a generated fixture for an actual-sidebar request and verify task activity, native receipt and coverage in that running instance; do not send the user's study to a provider as a test. Preserve their study/draft or let them reopen it themselves if restart required it.
- [ ] Report implementation, merged commit/PR, passed native/real acceptance and actual desktop activation separately. Leave any real-provider, parity or activation gap explicitly open. DOX closeout names changed contracts and records why unrelated documentation was left unchanged.

## Self-review and handoff

Spec mapping: sharing and compact UI → Tasks 4/5/10; backend/tool/renderer contracts → Tasks 1/2/3/8/9; full-series budgets and continuation → Tasks 1/4/8/9; native parity → Tasks 6/7/11; lifecycle/failures → Tasks 2/3/8/10; privacy and literature boundaries → Tasks 1/5/8/9; native, real-provider and desktop acceptance → Tasks 11/12. The five Review Focus conditions each have named owning tests above.

The plan preserves native execution already selected by the user. The user approved this written plan on 2026-09-23; native implementation proceeds without a per-task permission cycle. Scope confirmations and durable-action reviews described here are product behavior, not additional development approvals.
