# Codex study exploration and viewer tools

Date: 2026-09-23. Status: proposed design for user review. No implementation or provider acceptance of this extension is claimed. The existing single-viewport attachment remains the shipped behavior.

## Intended outcome

The user wants to share the entire visible view or a series, and have `gpt-6-astra` explore RadSysX and operate the same imaging tools as the user. A single attached screenshot does not meet that goal. The assistant should inspect additional frames when needed, use calibrated measurements and viewer commands, retrieve literature, and show what it examined and changed. These operations must work through the signed-in Codex subscription without a Realtime connection.

Existing decisions still apply: synthetic/deidentified pilot work, a quiet and compact sidebar, backend-owned authority, reversible local edits, review before durable changes, and no saved raw image history. This design does not introduce clinical validation, patient-mode cloud access, specialist segmentation inference, unrelated desktop control or a new provider/billing method.

## Approach and alternatives

Use a shared RadSysX action broker and typed OHIF tools, exposed as Codex App Server dynamic tools. Image observations return through the pinned protocol's image content items. The same OHIF/Cornerstone services, command implementations and undo history serve both user and assistant actions.

Bulk image attachments alone improve visual context but do not satisfy autonomous exploration or tool use. General mouse/keyboard or model-written automation offers broader control but makes exact action verification, context binding and durable-change review harder. Prefer named app operations for this release. Tool parity is an explicit acceptance requirement, not a claim that the current small adapter already exposes everything.

## User experience

Keep Chat, Research and Jev review workspaces. Replace the lone attachment control with a compact **Share** menu:

| Choice | What is included |
| --- | --- |
| Current image | The existing single-image preview and send behavior. |
| Entire view | All currently visible image panes and overlays, plus a RadSysX reading-workspace overview. Individual panes remain available at readable resolution. |
| Series | A selected loaded series, its complete frame inventory, neutral geometry and existing measurements. Frames are delivered in batches; the user does not attach each slice manually. |

Add **Allow viewer tools** for the current task. It grants reversible navigation and edits within the selected case. The model can subsequently request fresh observations within that scope without a confirmation for each frame. Sharing alone grants observation, not mutation. The user can share a series for read-only examination, or combine series access and viewer tools.

Show the selected scope before sending: for example, `Series 2 · CT · 34 frames · viewer tools allowed`. The series preview shows its inventory and representative thumbnails clearly labeled as a preview, not full coverage. Do not require rendering a giant preview of every frame before the user can send.

While running, show one activity line such as `Inspecting frames 17–24 of 34` or `Applying lung window`. Provide **Stop**, **Take over**, and expandable action/coverage details. The answer separates visual observations, tool-computed measurements and published evidence. Research retains its explicit Jev action; Jev receives only independently confirmed text and public abstracts.

The reading-workspace overview includes the app's imaging layout and relevant controls, not other applications, OS dialogs, credential settings or unrelated conversations. Opening a sensitive settings/authentication surface blocks overview capture. Main-process region selection is fixed by app code, never by arbitrary model-supplied selectors.

## Components and execution

1. **Backend action broker:** factor transport-independent validation, ownership, authorization, immutable approvals, idempotency and observed receipts out of the Live-only execution path. Preserve current Gemini/OpenAI behavior while adding an HTTP-backed Codex task client.
2. **Codex tool adapter:** supply the allowed dynamic tool schemas for the task. Handle text plus `inputImage` results using the workspace-pinned App Server. Keep exact model selection and existing isolated subscription authentication. Do not enable shell, arbitrary JavaScript, filesystem-image tools or general OS control.
3. **Viewer task channel:** authenticated, same-origin task polling carries commands identified by task, operation, context and lease. A renderer claims a command once and posts a bounded observation/result. Historical journal reads never execute commands. A fresh renderer after reload cannot replay an old command.
4. **Observation service:** capture the visible workspace/all panes and render requested series frames using the same image IDs, presentation and calibrated geometry as OHIF. Use a separate bounded offscreen viewport for series inspection so reading does not scroll the user's screen. If a format cannot be rendered correctly offscreen, return an explicit unsupported capability rather than silently moving the user or substituting a different image.
5. **Viewer adapter:** use named OHIF services/commands for navigation, viewport presentation, annotations, segmentation visibility and report drafts. Capability discovery reports currently enabled tools and typed argument contracts, not unrestricted command names.
6. **Task/coverage view:** show progress, all attempted actions, observed results and frame-delivery coverage. Persist only safe metadata/text/receipts. Pixels remain transient and bounded in memory.

## Contracts

The implementation plan will map these semantic records to strict backend and shared TypeScript DTOs. Each schema rejects extra fields, oversized/nonfinite values and caller-supplied actor identities.

| Record | Required meaning |
| --- | --- |
| Exploration grant | Owner, session/task, explicit observation scope, loaded study/series aliases, permissions, exact model, revision, expiry and revocation status. |
| Series manifest | Opaque study/series/frame handles, stable ordering, full frame count, dimensions and available numeric geometry. No patient labels, raw file paths or provider-fetchable DICOM URLs. |
| Observation request | Grant, operation ID, expected revision, observation kind, requested frame handles and presentation settings. |
| Observation result | Source binding, exact indices/handles, dimensions, windowing/orientation, captured time, hashes and transient image items. Include explicit failures for requested frames that were not rendered. |
| Action request | Task/operation, grant, typed tool/arguments, expected revision, immutable approval binding when required, deadline and one-time renderer claim. |
| Action result | Completed/failed/unknown status, observed state revision, safe result values and undo availability. Dispatch is not completion. |
| Coverage receipt | Manifest identity, requested/captured/delivered/failed frame sets, render settings, model/run identity and completion or partial status. |

`viewer_get_capabilities`, `viewer_get_state`, `viewer_observe`, `series_get_manifest` and `series_read_frames` provide discovery and observations. Reuse the existing typed action families, expanding their validated schemas where the user-facing tool requires more geometry. Observation-only and mutation-capable grants are distinct.

## Entire-series behavior and budgets

Full-series mode enumerates every frame, including multi-frame instances. Deliver ordered batches with frame indices and source geometry. The model can revisit specific frames or change windowing, then request another observation. An overview or contact sheet alone never counts as full-series delivery.

Proposed starting limits: up to eight image items and 8 MiB encoded observation data per batch; no more than 128 image deliveries, 64 tool calls or ten minutes per run; one active exploration task per owner and two globally. These are application limits, not claimed provider limits. Image dimensions are bounded at 2,048 px per edge, with the actual resize/crop recorded. Preserve native dimensions when within the limit. Validate larger App Server notification frames and memory limits before enabling these sizes; the present one-megabyte reader is insufficient for multi-image tool-result events.

A larger series remains available through explicit **Continue review**, preserving the coverage ledger but starting a new bounded run. The model receives bounded summaries and can re-request earlier pixels; no image cache persists across restart. Count repeated deliveries against the budget. Never silently downsample to a handful of slices or truncate the series while labeling it complete.

Show `34/34 frames delivered` only when all distinct manifest frames have acknowledged delivery. A completed model turn and coverage are separate facts. Neither proves diagnostic scrutiny or clinical adequacy. Missing/unsupported frames, timeout or a model that stops early produce **Partial review**, list what remains, and offer continuation. A 34-frame synthetic series must complete in a single normal run.

## Viewer tool parity

Inventory the enabled controls in the shipping OHIF mode at implementation time. For each one, record its native handler, allowed task permission, observed completion and synthetic acceptance. Do not advertise full parity until that inventory is covered.

- Select panes and loaded series; traverse slices/frames; change layouts, window/level, zoom, pan, rotation, inversion and flips; reset or restore presentation.
- Read and operate supported measurement/annotation tools, including their required point geometry and units. Return Cornerstone-calculated values rather than estimating calibrated distances from screenshot pixels. Existing freely entered annotation labels are not automatically model input.
- Use undo/redo through the same native history. Measurement deletion retains explicit review. Report drafts remain visibly unsaved.
- Discover available MPR, crosshair, cine, fusion, segmentation and other reading controls. Wire enabled user-facing controls through validated native handlers and verify them with appropriate fixtures. Features absent or disabled in the current mode remain reported as unavailable to both user and model. Do not represent selecting a segmentation as generating a new mask.
- Navigate relevant app panels and the selected study workspace through named actions. Selecting another study requires a fresh data scope; account settings, credentials, external destinations and filesystem dialogs are outside the grant.
- Saving reports, exporting images/data, deleting durable objects and derived DICOM writeback require an exact reviewable proposal and the existing backend permissions. Unsupported durable operations remain unavailable until an authoritative reviewed endpoint exists; never bypass those contracts by pressing a UI button.

## Context, concurrency and failure behavior

Bind observations and actions to study/series aliases, grant revision and renderer lifetime. Authorized model navigation within the selected scope advances an expected revision and produces a verified receipt; it must not be mistaken for an unrelated case switch. User navigation to another case revokes the grant. Manual interaction while the assistant is changing the viewer pauses further mutations so it cannot fight the user.

Execute viewer mutations serially. Each command is claimed once. Repeated provider calls with the same identity return a saved result; changed arguments fail. A mutation with a lost receipt is **Outcome unknown**, is not retried, and requires state reconciliation or user takeover. Observation retries can obtain fresh pixels only while the same grant remains valid and have distinct capture receipts.

Stop revokes new dispatch immediately and cancels model/capture work. It cannot claim to undo a mutation already applied. Undo and restoring the original presentation are explicit operations. Renderer disconnect, reload, account/model change, grant expiry, backend restart and clinical-mode entry revoke execution. No autonomous replay after reconnect. Durable-action approval expires after two minutes and counts toward the ten-minute task deadline. An expired proposal never executes; retry requires a fresh proposal and review.

Screen content, DICOM annotations, imported documents and literature are untrusted data. They cannot broaden tool permissions. Keep authentication, scope and per-action checks in application code, not only model prompts. Preserve synthetic/deidentified confirmation and clinical-mode disablement. Public literature queries use generic concepts, not identifiers read from an image.

## Acceptance

1. With Realtime disconnected, the signed-in exact `gpt-6-astra` can observe a multi-pane workspace and return a receipt for each pane and the overview.
2. A generated 34-frame series with a visual marker on a late frame is completely delivered without individually attaching slices; coverage identifies every frame, and a real subscription test describes the hidden-to-prompt marker. No patient images are used for tests.
3. The model requests a frame, changes windowing or navigates to another authorized frame, receives fresh pixels and bases its next action on that observation. No fabricated tool success or stale-frame substitution.
4. Enabled reading-tool inventory is covered by actual native fixtures. At minimum prove layout/presentation, series/slice navigation, calibrated measurement creation/readback/edit, undo/redo, available segmentation visibility and reviewed report-save behavior. Do not mark remaining inventory entries complete from stubs.
5. Stop/takeover, manual interference, case changes, duplicate calls, lost receipts, stale capture replies, account expiry and unauthorized grants prevent further dispatch or correctly report unknown outcomes.
6. Full, sampled and partial series coverage are distinct in both UI and model context; no unseen frame is counted from a thumbnail alone.
7. Pixels, raw identifiers, local paths, credentials and private model reasoning are absent from saved history/logs. Observation budgets and protocol line limits fail privately without unbounded buffering.
8. Existing single-image, text, voice, research and Jev acceptance remains valid. Tests distinguish fixture transport, native tool operation and real subscription execution.
9. The actual desktop launch serves the new controls after a user-safe restart. Source/build checks alone do not establish activation.

## Source and implementation evidence

- Current `backend/clinical/ai_codex.py` exposes only the public PubMed dynamic tool; text image support is a single initial attachment. `ai_text.py` strips rich viewer state and has no renderer-action transport.
- `backend/clinical/ai_live.py` owns the existing voice action validation/approval/receipt loop. `viewer/assets/live/ohif.ts` already calls native OHIF services for a subset of user tools; `controller.ts` currently requires a ready voice provider to execute them.
- `desktop/src/live-capture.mjs` currently restricts capture to one visible viewport and a 768 px edge. Whole-view and offscreen-series observations need explicit new scope handling.
- The locally generated Codex 0.154.0 `DynamicToolCallResponse` schema includes text and `inputImage`/`imageUrl` content items. This establishes a protocol surface, not successful live tool-image acceptance; validate that path in implementation.
- [OpenAI App Server documentation](https://learn.chatgpt.com/docs/app-server) describes experimental dynamic tool calls and returned content items.
- [OpenAI computer-use guidance](https://developers.openai.com/api/docs/guides/tools-computer-use) supports an existing custom UI-tool interface and describes returning observations after actions. Its generic Responses API samples do not establish subscription entitlement or require replacing the RadSysX integration.
- [GPT-6 Astra model documentation](https://developers.openai.com/api/docs/models/gpt-6-astra) and [images guidance](https://developers.openai.com/api/docs/guides/images-vision) establish image input and multiple-image request support. Actual subscription catalog/access and limits must still be verified.

## Review and handoff

The implementation plan follows written-design review. Proposed work is one integrated feature with four implementation stages: shared action broker, scoped observations/series coverage, native tool parity, then sidebar and desktop acceptance. No runtime behavior changes until that review/plan handoff is complete.
