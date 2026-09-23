# Codex viewer tool coverage

Status: native handlers implemented, 2026-09-23; specialized fixture acceptance remains pending. This inventory does not claim complete parity or clinical validation. The user explicitly deferred exhaustive additional fixture expansion.

The isolated native Electron inventory used `node desktop/scripts/ui-import-smoke.mjs --local-start --vision --study-inventory`, pinned OHIF `e1cf19a210b745c81d281b77cb94666654ee70b1`, longitudinal/basic mode, a generated single-frame CT, and the guarded synthetic provider. It confirmed runtime toolbar IDs, tool-group membership, and the existing single-image sidebar path. No cloud call or user study was used. Geometry-dependent controls need the Task 11 volume/multiframe fixtures before native acceptance can pass.

All tool names are semantic allowlists. The renderer never accepts arbitrary commands or selectors. Backend schemas remain authoritative. “Mutate” requires the user’s separate viewer-tools grant; observation alone grants no viewer edits. Availability follows native data, services and tool groups. User controls are not disabled to improve this inventory.

| Native control / toolbar IDs | Semantic handler | Permission | Observed receipt / undo | Native acceptance |
|---|---|---|---|---|
| Pane selection | `viewer_select_viewport` → viewportGridService | Mutate | Active pane readback | Single-frame native regression passed for base navigation/presentation; specialized fixture pending |
| Series thumbnails, StackScroll, slice slider | `viewer_open_series`, `viewer_jump_to_slice` | Mutate | Display-set membership and current image index | Single-frame native regression passed for base navigation/presentation; specialized fixture pending |
| Layout | `viewer_set_layout` → native grid | Mutate | Actual rows/columns | Single-frame native regression passed for base navigation/presentation; specialized fixture pending |
| WindowLevel, windowLevelMenu, windowLevelMenuEmbedded, voiManualControlMenu | `viewer_set_window_level` | Mutate | Actual width/center; shared presentation undo | Single-frame native regression passed for base navigation/presentation; specialized fixture pending |
| Pan, Zoom, rotate-right, flipHorizontal, invert, Reset | `viewer_set_view` | Mutate | Actual camera/presentation; shared undo | Single-frame native regression passed for base navigation/presentation; specialized fixture pending |
| orientationMenu | `viewer_set_orientation` | Mutate | Volume plane normal; shared undo | Disabled on single CT; volume fixture pending |
| ReferenceLines, ImageOverlayViewer, dataOverlayMenu | `viewer_set_overlays` | Mutate | Actual overlay/tool state; shared undo | Single-frame native regression passed for base navigation/presentation; specialized fixture pending |
| ImageSliceSync / VOI synchronization | `viewer_set_sync` | Mutate | Native synchronizer state; study membership | Needs multiple panes |
| Cine | `viewer_set_cine` | Mutate | Native playback state; stop on takeover | Needs multiple frames; cross-study regression passed |
| MPR / hanging protocols | `viewer_set_mpr` | Mutate | Native protocol readback, scoped observations | Needs reconstructable volume |
| Crosshairs | `viewer_set_crosshair` | Mutate | Plane intersections, volume bounds; multi-pane undo | Disabled on single CT; volume fixture pending |
| Fused layer opacity / colormap | `viewer_set_fusion` | Mutate | Attached-layer membership and native opacity; undo | Needs fusion fixture |
| Colorbar, thresholdMenu, opacityMenu | `viewer_set_rendering` | Mutate | Native colormap/threshold/opacity and colorbar; undo | Data-dependent; Task 11 pending |
| AdvancedRenderingControls (volume quality, lighting, shade, opacity shift, presets, blending/slab) | `viewer_set_volume` | Mutate | Native mapper/property readback; presentation undo | Needs volume fixture |
| Series, measurements, segmentation, report panels | `viewer_open_panel` | Mutate | Rendered open-panel marker | Single-frame native regression passed for base navigation/presentation; specialized fixture pending |
| MeasurementTools / MoreTools groups | Inventory containers, no generic command | — | Children listed below | Native inventory confirmed |
| Length, Bidirectional, ArrowAnnotate, EllipticalROI, RectangleROI, CircleROI, Angle, CobbAngle | `viewer_measurement` → native type-specific annotation/statistics | Mutate / delete review | Native annotation/statistics and shared undo | Implemented; remaining native type fixtures pending |
| PlanarFreehandROI, SplineROI, LivewireContour | `viewer_measurement` → native contour/spline tools | Mutate / delete review | Native contour and geometry | Implemented; remaining native type fixtures pending |
| Probe, CalibrationLine, UltrasoundDirectionalTool | `viewer_measurement` / reviewed `viewer_calibrate` | Mutate | Native units/calibration; never invent physical units | US disabled on CT; US fixture pending |
| Magnify, AdvancedMagnify, WindowLevelRegion, TrackballRotate | `viewer_region` / native tool activation | Mutate | Actual tool group activation/settings | TrackballRotate disabled on CT; volume fixture pending |
| SegmentLabelTool, segmentation selection/visibility/contour editing | `viewer_segmentation` → native service/contour tool | Mutate / reviewed durable changes | Native representations and segments | SegmentLabelTool disabled on CT; fixture pending |
| trackingStatus | Read-only measurement state | Observe | Native measurements | Native numeric readback implemented; modality fixtures pending |
| navigationComponent, modalityLoadBadge | Native navigation/status containers | Observe | Neutral series/frame state | Hidden in the initial CT fixture |
| TagBrowser | Privacy exclusion | Unavailable | Identifying DICOM metadata is not tool-readable | Confirmed excluded |
| Capture/export, filesystem dialogs, account settings | Filesystem/privacy exclusion | Unavailable | No arbitrary file or account tools | Confirmed excluded |
| Report saves, deletion, DICOM writeback | Existing backend review boundary only | Reviewed | Authoritative backend receipt | No browser-direct persistence |

`study-tools.patch` exports the pinned existing viewport adapter and a neutral open-panel marker. It does not replace native rendering or measurement logic. `capabilities.ts` names the local native handlers; only validated name/availability summaries cross the backend tool-state boundary. Tests with doubles establish argument, scope, cancellation and no-op behavior; they do not replace actual rendering/calibration acceptance.

Final scoped Codex fixture: all 34 synthetic CT frames were acknowledged through the production sidebar; navigation to frame index 31, window/level to 800/80 and native reading-grid/pane capture completed. This supplements the base controls above without changing specialized modality acceptance.


Task 7 native regression: the isolated actual-sidebar OpenAI fixture passed window/level, zoom/pan/rotation/flip/inversion/reset, slice selection, tool activation, layout restore, Length and RectangleROI create/edit/jump/delete, measurement undo/redo and report-draft/annotation combined history. It used the synthetic provider. No segmentation, volume, ultrasound or real subscription acceptance is claimed by this run. Image-point fixtures now derive their canvas coordinates from native image indices, so letterboxing is not accepted as measurement geometry.

Measurement contracts: Length/ArrowAnnotate/CircleROI/UltrasoundDirectional use two points; Probe one; Angle three; CobbAngle/Bidirectional/EllipticalROI four; closed freehand/spline/livewire paths 3–256. EllipticalROI handles follow the native bottom/top/left/right axis ordering. RectangleROI takes opposite corners and constructs the native four handles in the current plane. Geometry must match the observed frame/revision for exploration; legacy voice retains context-version authorization. Native statistics are awaited and stale caches cleared on edits; missing calibration is explicit and imported labels are omitted. Context summaries bound geometry with completeness/count metadata. Calibration uses an explicit known physical length and broker review, never a model-estimated calibration value.
