# Scoped Codex study exploration

Implemented 2026-09-23. This extends subscription chat/research independently of Realtime. It is limited to explicitly attested synthetic/deidentified content; clinical mode remains disabled.

## Use

1. Choose an image-capable ChatGPT / Codex model in Settings and confirm the displayed data.
2. Open **Share images with AI**. Choose the current image, reading workspace, or selected series. Enable **Allow viewer tools** separately when the model should operate the viewer.
3. Choose the **Images** scope, then use **Send with images** or **Research**. Inventory preparation and fresh capture happen automatically. The initial model turn includes real pixels; capture failure cannot silently fall back to text-only inference.
4. Follow frame-delivery counts and activity in the task card. **Stop** revokes access; **Take over** pauses model control. Manual interaction with the reading workspace also takes over. Continue explicitly to grant access again.

The RadSysX logo returns local reading to the local study loader and governed/FHIR reading to the worklist. It does not enter OHIF's disabled study-list route.

## What runs

The backend owns a per-user Codex App Server process, authenticated model selection, immutable tool calls and a renderer lease. The model can request bounded native frame batches, pane/reading-grid observations and enabled semantic OHIF actions. It receives no general shell, filesystem, arbitrary JavaScript, account controls or OS screen access. Whole-view observations include the native reading grid and in-pane overlays; unrelated sidebar/report/account panels are excluded.

Native controls reuse OHIF/Cornerstone services and geometry, with reversible presentation/annotation changes and review before durable operations. The [tool matrix](CODEX_VIEWER_TOOL_MATRIX.md) distinguishes implemented handlers from verified native controls. Unavailable modalities remain unavailable, and untested specialized tools are not represented as full tool parity.

Every grant binds the owner, text session, exact model, study/series handles, renderer epoch and revision. Changing context/model/account, Stop, takeover, expiry or renderer loss invalidates access. An unknown mutation outcome removes mutation authority and requires takeover. Backend report saves retain their existing ownership and review requirements.

## Evidence and limits

Series manifests enumerate every frame in native display-set order, including multiframe acquisitions. Batches contain at most eight images, with task limits of 128 submitted images and 64 calls. Coverage counts distinct frames after the matching App Server turn acceptance for initial inputs or matching tool acknowledgment for subsequent observations. An overview or thumbnail does not count as complete-series delivery. The UI distinguishes complete and partial coverage; delivery itself is not diagnostic validation.

Image bytes are transient. History stores hashes, scope, dimensions, presentation, acknowledged frame IDs and execution receipts. Continuing a task restores metadata without replaying old pixels or mutations. Geometry edits require an acknowledged pane frame at the current revision. Preparation lasts at most 60 seconds; active work lasts at most ten minutes and needs a live renderer heartbeat.

The pinned protocol maps dynamic `callId` directly to the lifecycle item ID: [Codex 0.154.0 source](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/app-server/src/bespoke_event_handling.rs) and [App Server lifecycle](https://learn.chatgpt.com/docs/app-server). A successful local socket write alone does not establish delivery.

## Verification record

- Strict contracts, ownership, cancellation, coverage, broker, protocol and native adapter checks were run during implementation; detailed results are recorded in the approved plan's local execution ledger.
- Focused Codex protocol tests: 16 passed. Viewer type checks and production build passed.
- Earlier actual Electron synthetic acceptance covered base navigation/presentation, Length/RectangleROI operations and combined annotation/report undo/redo.
- The final scoped-series check passed: `node desktop/scripts/ui-import-smoke.mjs --local-start --vision --study-exploration`. It delivered all 34 generated CT frames, executed native slice navigation and window/level, captured the reading grid and pane, and verified clicking the logo returns to the local loader with the desktop alive. It used the production sidebar and owned command channel with a guarded synthetic Codex transport, zero Realtime connections and no cloud calls. Pixels were absent from saved history.
- Real subscription inference on an entire series, model interpretation of the late-frame marker, and specialized volume/fusion/ultrasound/segmentation parity remain unverified. Synthetic transport acceptance does not establish those capabilities or clinical accuracy.

At the user's explicit request, additional exhaustive fixture expansion and repeated broad local suites were deferred. The normal hosted checks remain enabled.

## Desktop activation

On 2026-09-23, the working checkout was fast-forwarded to the implementation and launched with `npm run desktop`. Bootstrap passed, the pinned OHIF distribution rebuilt, and the normal `backend.server:app` started from that checkout on port 8000. The desktop origin on port 3000 serves the current generated bundle with study sharing, viewer-tool permission and supported logo navigation. The production frontend uses port 3013. The unrelated local `.DS_Store` edit and owner credentials were preserved. Release is tracked in [PR #85](https://github.com/TerminallyLazy/RadSysX/pull/85).

The CI browser fixture was updated to provide both `addEventListener` and `removeEventListener`; otherwise teardown threw before clearing the existing auth timer. Its focused controller regressions passed (38 tests). This was a test-double repair, with no change to production behavior.

## 2026-09-23 image delivery repair and real subscription acceptance

The first implementation advertised scoped tools while retaining contradictory text-only instructions. Preparing a scope only enumerated metadata, so a real model could stop after the inventory with zero delivered images. Synthetic scripted tools did not reveal that defect.

The repaired path uses coherent scoped instructions and captures initial pixels before asking the model to answer. The sidebar replaces Prepare sharing with an explicit Images selector and Send with images, repeats fresh capture for subsequent sends, displays acknowledged delivery beside the composer, and folds completed native actions into Task details. Chat, Research and Jev retain separate workspaces. Voice setup is optional and stays behind its header control. The reading-room palette remains subdued.

Real hosted acceptance used the existing signed-in ChatGPT subscription, the normal backend, the actual isolated Electron sidebar, and a generated 34-frame study. `gpt-6-astra` received all 34 distinct frames (50 total observations including repeats/views), correctly reported the randomly generated pixel-only marker count of four, queried technical metadata, navigated the series, set width 800/center 80 and observed the reading view. The expected count was not present in metadata or the prompt. The final answer explicitly reported it. The logo also returned to the local loader. No Realtime session was needed; no patient images were used. This establishes actual vision/tool transport, not clinical accuracy or exhaustive modality/tool parity.

The final UI iteration also passed the isolated scripted 34-frame desktop path with 38 image observations, two native actions, zero voice connections and no saved pixel payloads. Focused backend checks covered subscription transport, literal report extraction, metadata exclusion and research orchestration; viewer type checking/build and targeted controller checks cover the updated path. See the separate OpenMed adaptation note for literature scope. Production activation is recorded separately from these isolated runs.

## 2026-09-23 continuation, scope and cancellation repair

Observed saved receipts showed incomplete series runs stopping on `viewer_get_state`, and prepared continuations with retained coverage but no new submitted question. The renderer incorrectly required every visible pane to belong to the shared series even for a read-only state query, so an adjacent localizer could revoke the task. Background measurement metadata also participated in the takeover fingerprint. Whole-reading-view tool declarations allowed offscreen frame reads, obscuring the difference between image selections.

Read-only state now filters shared panes, pane capture validates only the target, and whole-view overview retains all-visible-pane validation. Takeover tracks presentation and manual interaction rather than derived measurement statistics or canvas resizing. Known read/preflight failures remain tool failures, not uncertain mutations. Terminal cleanup preserves the initial stop/pause reason.

The remaining-frames button submits the original Chat/Research question in one action, skips acknowledged frames and preserves the unsent draft. Scope changes clear the prior delivery display. The sidebar separates model status from cumulative frames sent, names viewer activity, and keeps the newest research result first. The 280 px composer has no horizontal select overflow. Whole-view cannot call offscreen frame capture or offer series continuation.

The failed public-search run retained no PubMed execution receipt; its exact rejected arguments were not available. Codex now accepts omitted/null limits as five and explicit limits up to ten, returns actionable validation failures, and records safe service/timeout/rate-limit errors. Research with only failed searches is marked failed. These changes do not establish the exact rejected arguments in the original run.

Verification was limited to the affected paths:

- Focused backend, controller, scope and native-capture regressions passed; viewer production build passed.
- Actual isolated synthetic Research UI: first eight of 34 frames, one click to continue to 34/34, two native actions, draft preserved; subsequent whole-view supplied two images with no offscreen frames, then active viewport supplied one image. No Realtime or hosted model calls.
- Real signed-in `gpt-6-astra` public-only Research request completed with one PubMed search receipt and three returned sources.
- Real signed-in scoped Electron request delivered 34/34 generated frames (43 total observations), correctly returned the random pixel-only marker count of three, navigated to slice index 31, set window width 800/center 80, observed the pane and returned a cited public PubMed source in that same turn. The screenshot confirmed the actual slice/window state and the compact 280 px layout. The check required saved PubMed receipts and sources, not just the model's assertion. No patient images were used.

These checks establish transport, scope, continuation and the exercised viewer commands. They do not validate diagnostic accuracy or every native tool/modality. Original saved failures remain historical failures; the app does not replay them automatically.

## 2026-09-23 named-preset and target-pane repair

Subsequent saved task receipts identified `viewer_set_window_level` with `preset: brain` as the repeated unknown action, with earlier unknown slice jumps. The pinned OHIF customization supplies presets as an array of IDs/descriptions; the adapter incorrectly indexed it by a semantic name. Slice commands also omitted their explicit pane and depended on active-pane timing.

Preset lookup now resolves the selected pane's modality and configured native values before any effect, then sends numeric window/level to that pane. Slice commands carry the native grid viewport explicitly, and reading commands wait for active-pane selection. Known preflight rejections return failed tool results without revoking the task; uncertain effects still stop execution. Their saved pause reason now states that an action could not be confirmed instead of attributing it to the user.

Verification: viewer build, 64 focused viewer/controller tests and 14 backend lifecycle tests passed. The isolated synthetic Electron check completed series continuation and scope checks, then used a real two-pane OHIF layout to navigate the second pane to index 15 and apply the configured brain preset (80/40), leaving the first pane unchanged. No patient images or new hosted-model calls were used in this repair. The previous single-pane/numeric-window acceptance did not cover these defects.
