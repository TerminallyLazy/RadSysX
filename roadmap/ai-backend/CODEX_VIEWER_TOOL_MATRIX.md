# Codex viewer tool coverage

Status: implementation in progress, 2026-09-23. This inventory is a release gate, not a claim of complete parity or clinical validation.

The isolated native Electron inventory used `node desktop/scripts/ui-import-smoke.mjs --local-start --vision --study-inventory`, pinned OHIF `e1cf19a210b745c81d281b77cb94666654ee70b1`, longitudinal/basic mode, a generated single-frame CT, and the guarded synthetic provider. It confirmed runtime toolbar IDs, tool-group membership, and the existing single-image sidebar path. No cloud call or user study was used. Geometry-dependent controls need the Task 11 volume/multiframe fixtures before native acceptance can pass.

All tool names are semantic allowlists. The renderer never accepts arbitrary commands or selectors. Backend schemas remain authoritative. “Mutate” requires the user’s separate viewer-tools grant; observation alone grants no viewer edits. Availability follows native data, services and tool groups. User controls are not disabled to improve this inventory.

| Native control / toolbar IDs | Semantic handler | Permission | Observed receipt / undo | Native acceptance |
|---|---|---|---|---|
| Pane selection | `viewer_select_viewport` → viewportGridService | Mutate | Active pane readback | Task 11 pending |
| Series thumbnails, StackScroll, slice slider | `viewer_open_series`, `viewer_jump_to_slice` | Mutate | Display-set membership and current image index | Task 11 pending |
| Layout | `viewer_set_layout` → native grid | Mutate | Actual rows/columns | Task 11 pending |
| WindowLevel, windowLevelMenu, windowLevelMenuEmbedded, voiManualControlMenu | `viewer_set_window_level` | Mutate | Actual width/center; shared presentation undo | Task 11 pending |
| Pan, Zoom, rotate-right, flipHorizontal, invert, Reset | `viewer_set_view` | Mutate | Actual camera/presentation; shared undo | Task 11 pending |
| orientationMenu | `viewer_set_orientation` | Mutate | Volume plane normal; shared undo | Disabled on single CT; volume fixture pending |
| ReferenceLines, ImageOverlayViewer, dataOverlayMenu | `viewer_set_overlays` | Mutate | Actual overlay/tool state; shared undo | Task 11 pending |
| ImageSliceSync / VOI synchronization | `viewer_set_sync` | Mutate | Native synchronizer state; study membership | Needs multiple panes |
| Cine | `viewer_set_cine` | Mutate | Native playback state; stop on takeover | Needs multiple frames; cross-study regression passed |
| MPR / hanging protocols | `viewer_set_mpr` | Mutate | Native protocol readback, scoped observations | Needs reconstructable volume |
| Crosshairs | `viewer_set_crosshair` | Mutate | Plane intersections, volume bounds; multi-pane undo | Disabled on single CT; volume fixture pending |
| Fused layer opacity / colormap | `viewer_set_fusion` | Mutate | Attached-layer membership and native opacity; undo | Needs fusion fixture |
| Colorbar, thresholdMenu, opacityMenu | `viewer_set_rendering` | Mutate | Native colormap/threshold/opacity and colorbar; undo | Data-dependent; Task 11 pending |
| AdvancedRenderingControls (volume quality, lighting, shade, opacity shift, presets, blending/slab) | `viewer_set_volume` | Mutate | Native mapper/property readback; presentation undo | Needs volume fixture |
| Series, measurements, segmentation, report panels | `viewer_open_panel` | Mutate | Rendered open-panel marker | Task 11 pending |
| MeasurementTools / MoreTools groups | Inventory containers, no generic command | — | Children listed below | Native inventory confirmed |
| Length, Bidirectional, ArrowAnnotate, EllipticalROI, RectangleROI, CircleROI, Angle, CobbAngle | Task 7 calibrated geometry registry | Mutate / delete review | Native annotation/statistics and shared undo | Implementation pending; release blocker |
| PlanarFreehandROI, SplineROI, LivewireContour | Task 7 contour registry | Mutate / delete review | Native contour and geometry | Implementation pending; release blocker |
| Probe, CalibrationLine, UltrasoundDirectionalTool | Task 7 calibrated reading tools | Mutate | Native units/calibration; never invent physical units | US disabled on CT; implementation pending |
| Magnify, AdvancedMagnify, WindowLevelRegion, TrackballRotate | Task 7 native interaction tools | Mutate | Actual tool group activation/settings | TrackballRotate disabled on CT; implementation pending |
| SegmentLabelTool, segmentation selection/visibility/contour editing | Task 7 segmentation registry | Mutate / reviewed durable changes | Native representations and segments | SegmentLabelTool disabled on CT; fixture pending |
| trackingStatus | Read-only measurement state | Observe | Native measurements | Task 7 pending |
| navigationComponent, modalityLoadBadge | Native navigation/status containers | Observe | Neutral series/frame state | Hidden in the initial CT fixture |
| TagBrowser | Privacy exclusion | Unavailable | Identifying DICOM metadata is not tool-readable | Confirmed excluded |
| Capture/export, filesystem dialogs, account settings | Filesystem/privacy exclusion | Unavailable | No arbitrary file or account tools | Confirmed excluded |
| Report saves, deletion, DICOM writeback | Existing backend review boundary only | Reviewed | Authoritative backend receipt | No browser-direct persistence |

`study-tools.patch` exports the pinned existing viewport adapter and a neutral open-panel marker. It does not replace native rendering or measurement logic. `capabilities.ts` names the local native handlers; only validated name/availability summaries cross the backend tool-state boundary. Tests with doubles establish argument, scope, cancellation and no-op behavior; they do not replace actual rendering/calibration acceptance.
