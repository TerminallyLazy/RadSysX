# Scoped Codex study exploration

Implemented 2026-09-23. This extends subscription chat/research independently of Realtime. It is limited to explicitly attested synthetic/deidentified content; clinical mode remains disabled.

## Use

1. Choose an image-capable ChatGPT / Codex model in Settings and confirm the displayed data.
2. Open **Share images with AI**. Choose the current image, reading workspace, or selected series. Enable **Allow viewer tools** separately when the model should operate the viewer.
3. Prepare the scope, then use **Send** or **Research**. Preparation inventories images locally; it does not contact the model.
4. Follow frame-delivery counts and activity in the task card. **Stop** revokes access; **Take over** pauses model control. Manual interaction with the reading workspace also takes over. Continue explicitly to grant access again.

The RadSysX logo returns local reading to the local study loader and governed/FHIR reading to the worklist. It does not enter OHIF's disabled study-list route.

## What runs

The backend owns a per-user Codex App Server process, authenticated model selection, immutable tool calls and a renderer lease. The model can request bounded native frame batches, pane/reading-grid observations and enabled semantic OHIF actions. It receives no general shell, filesystem, arbitrary JavaScript, account controls or OS screen access. Whole-view observations include the native reading grid and in-pane overlays; unrelated sidebar/report/account panels are excluded.

Native controls reuse OHIF/Cornerstone services and geometry, with reversible presentation/annotation changes and review before durable operations. The [tool matrix](CODEX_VIEWER_TOOL_MATRIX.md) distinguishes implemented handlers from verified native controls. Unavailable modalities remain unavailable, and untested specialized tools are not represented as full tool parity.

Every grant binds the owner, text session, exact model, study/series handles, renderer epoch and revision. Changing context/model/account, Stop, takeover, expiry or renderer loss invalidates access. An unknown mutation outcome removes mutation authority and requires takeover. Backend report saves retain their existing ownership and review requirements.

## Evidence and limits

Series manifests enumerate every frame in native display-set order, including multiframe acquisitions. Batches contain at most eight images, with task limits of 128 submitted images and 64 calls. Coverage counts distinct frames only after the matching App Server tool acknowledgment. An overview or thumbnail does not count as complete-series delivery. The UI distinguishes complete and partial coverage; delivery itself is not diagnostic validation.

Image bytes are transient. History stores hashes, scope, dimensions, presentation, acknowledged frame IDs and execution receipts. Continuing a task restores metadata without replaying old pixels or mutations. Geometry edits require an acknowledged pane frame at the current revision. Preparation lasts at most 60 seconds; active work lasts at most ten minutes and needs a live renderer heartbeat.

The pinned protocol maps dynamic `callId` directly to the lifecycle item ID: [Codex 0.154.0 source](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/app-server/src/bespoke_event_handling.rs) and [App Server lifecycle](https://learn.chatgpt.com/docs/app-server). A successful local socket write alone does not establish delivery.

## Verification record

- Strict contracts, ownership, cancellation, coverage, broker, protocol and native adapter checks were run during implementation; detailed results are recorded in the approved plan's local execution ledger.
- Focused Codex protocol tests: 16 passed. Viewer type checks and production build passed.
- Earlier actual Electron synthetic acceptance covered base navigation/presentation, Length/RectangleROI operations and combined annotation/report undo/redo.
- The final scoped-series check passed: `node desktop/scripts/ui-import-smoke.mjs --local-start --vision --study-exploration`. It delivered all 34 generated CT frames, executed native slice navigation and window/level, captured the reading grid and pane, and verified clicking the logo returns to the local loader with the desktop alive. It used the production sidebar and owned command channel with a guarded synthetic Codex transport, zero Realtime connections and no cloud calls. Pixels were absent from saved history.
- Real subscription inference on an entire series, model interpretation of the late-frame marker, and specialized volume/fusion/ultrasound/segmentation parity remain unverified. Synthetic transport acceptance does not establish those capabilities or clinical accuracy.

At the user's explicit request, additional exhaustive fixture expansion and repeated broad local suites were deferred. The normal hosted checks remain enabled.
