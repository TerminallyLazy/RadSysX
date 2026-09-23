"""Explicit app instrument panel. Model output is never executable code."""
from __future__ import annotations

import json
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class Arguments(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, allow_inf_nan=False)


class ViewportArguments(Arguments):
    viewportId: str | None = Field(default=None, max_length=128)


class WindowLevel(ViewportArguments):
    preset: Literal["lung", "soft_tissue", "bone", "brain", "abdomen", "liver"] | None = None
    windowWidth: float | None = Field(default=None, gt=0, le=100000)
    windowCenter: float | None = Field(default=None, ge=-100000, le=100000)

    @model_validator(mode="after")
    def complete(self):
        if not self.preset and (self.windowWidth is None or self.windowCenter is None):
            raise ValueError("Specify preset or width and center")
        return self


class Layout(Arguments):
    rows: int = Field(ge=1, le=3)
    columns: int = Field(ge=1, le=4)


class OpenSeries(ViewportArguments):
    displaySetId: str = Field(max_length=128)


class Slice(ViewportArguments):
    index: int = Field(ge=0, le=100000)


class View(ViewportArguments):
    zoom: float | None = Field(default=None, gt=0, le=20)
    panX: float | None = Field(default=None, ge=-5000, le=5000)
    panY: float | None = Field(default=None, ge=-5000, le=5000)
    rotation: float | None = Field(default=None, ge=-360, le=360)
    invert: bool | None = None
    flipHorizontal: bool | None = None
    flipVertical: bool | None = None
    reset: bool | None = None


class Tool(ViewportArguments):
    tool: Literal["WindowLevel", "Pan", "Zoom", "StackScroll", "Length", "RectangleROI", "ArrowAnnotate", "Angle", "Crosshairs"]


class Measurement(ViewportArguments):
    operation: Literal["create", "update", "delete", "jump"]
    measurementId: str | None = Field(default=None, max_length=128)
    label: str | None = Field(default=None, max_length=256)
    type: Literal["Length", "RectangleROI", "ArrowAnnotate"] | None = None
    points: list[list[float]] | None = Field(default=None, max_length=2)

    @model_validator(mode="after")
    def complete(self):
        if self.operation == "create":
            if self.type is None or self.points is None or len(self.points) != 2:
                raise ValueError("Creation requires type and two normalized viewport points")
            if any(len(p) != 2 or any(not 0 <= v <= 1 for v in p) for p in self.points):
                raise ValueError("Points are normalized viewport [x,y] coordinates from 0 to 1")
        elif not self.measurementId:
            raise ValueError("Existing measurement ID required")
        return self


class Segmentation(ViewportArguments):
    operation: Literal["select", "visibility"]
    segmentationId: str = Field(max_length=128)
    visible: bool | None = None


class ReadingViewport(ViewportArguments):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, strict=True, allow_inf_nan=False)
    viewportId: str | None = Field(default=None, pattern=r"^viewport-[A-Za-z0-9_-]{1,110}$")

class SelectViewport(ReadingViewport):
    viewportId: str = Field(pattern=r"^viewport-[A-Za-z0-9_-]{1,110}$")

class Orientation(ReadingViewport):
    orientation: Literal["axial", "coronal", "sagittal"]

class Overlays(ReadingViewport):
    visible: bool | None = None
    referenceLines: bool | None = None
    imageOverlay: bool | None = None

class Sync(ReadingViewport):
    enabled: bool
    type: Literal["imageSlice", "voi"]
    viewportIds: list[str] = Field(min_length=2, max_length=16)

    @model_validator(mode="after")
    def distinct(self):
        import re
        if len(set(self.viewportIds)) != len(self.viewportIds) or any(not re.fullmatch(r"viewport-[A-Za-z0-9_-]{1,110}", v) for v in self.viewportIds):
            raise ValueError("Choose distinct current viewports")
        return self

class Panel(ReadingViewport):
    panel: Literal["series", "measurements", "segmentation", "report"]

class Cine(ReadingViewport):
    playing: bool
    fps: float = Field(default=24, ge=1, le=60)

class MPR(ReadingViewport):
    layout: Literal["mpr", "mprAnd3DVolume", "default"]

class Crosshair(ReadingViewport):
    worldPoint: list[float] = Field(min_length=3, max_length=3)

class Fusion(ReadingViewport):
    displaySetId: str = Field(pattern=r"^series-[A-Za-z0-9_-]{1,110}$")
    opacity: float = Field(ge=0, le=1)
    preset: Literal["Grayscale", "Hot Iron", "PET", "PET 20 Step", "Cool to Warm"] | None = None

class Rendering(ReadingViewport):
    displaySetId: str = Field(pattern=r"^series-[A-Za-z0-9_-]{1,110}$")
    threshold: float | None = Field(default=None, ge=-1000000, le=1000000)
    opacity: float | None = Field(default=None, ge=0, le=1)
    colorbar: bool | None = None
    preset: Literal["Grayscale", "Hot Iron", "PET", "PET 20 Step", "Cool to Warm"] | None = None

class Volume(ReadingViewport):
    opacityShift: float | None = Field(default=None, ge=-1000000, le=1000000)
    quality: float | None = Field(default=None, ge=0, le=1)
    ambient: float | None = Field(default=None, ge=0, le=1)
    diffuse: float | None = Field(default=None, ge=0, le=1)
    specular: float | None = Field(default=None, ge=0, le=1)
    shade: bool | None = None
    blend: Literal["composite", "maximum", "minimum", "average"] | None = None
    slabThickness: float | None = Field(default=None, gt=0, le=1000)
    preset: Literal["CT-Bone", "CT-Soft-Tissue", "CT-Lung", "CT-Coronary-Arteries", "MR-Default"] | None = None

class Report(Arguments):
    findings: str = Field(default="", max_length=16000)
    impression: str = Field(default="", max_length=8000)


class Study(Arguments):
    studyId: str = Field(max_length=128)


class Research(Arguments):
    query: str = Field(min_length=1, max_length=2000)


class Cancel(Arguments):
    toolCallId: str = Field(max_length=128)


TOOL_MODELS = {
    "viewer_set_rendering": Rendering, "viewer_get_capabilities": Arguments, "viewer_select_viewport": SelectViewport,
    "viewer_set_orientation": Orientation, "viewer_set_overlays": Overlays, "viewer_set_sync": Sync,
    "viewer_open_panel": Panel, "viewer_set_cine": Cine, "viewer_set_mpr": MPR,
    "viewer_set_crosshair": Crosshair, "viewer_set_fusion": Fusion, "viewer_set_volume": Volume,
    "viewer_get_state": Arguments, "viewer_set_window_level": WindowLevel,
    "viewer_set_layout": Layout, "viewer_open_series": OpenSeries, "viewer_jump_to_slice": Slice,
    "viewer_set_view": View, "viewer_set_tool": Tool, "viewer_measurement": Measurement,
    "viewer_segmentation": Segmentation, "viewer_undo": ViewportArguments,
    "viewer_redo": ViewportArguments, "report_draft": Report, "report_save": Report,
    "viewer_open_worklist": Arguments, "study_open": Study,
    "research_run": Research, "research_cancel": Cancel,
}

DESCRIPTIONS = {
    "viewer_set_rendering": "Adjust a visible layer color map, opacity, absolute pixel threshold or colorbar through native rendering controls.",
    "viewer_get_capabilities": "Discover typed native reading tools and current availability.",
    "viewer_select_viewport": "Select a pane within the shared study.",
    "viewer_set_orientation": "Reorient a reconstructable volume to a named anatomical plane.",
    "viewer_set_overlays": "Set reading overlays, reference lines or DICOM image overlay visibility.",
    "viewer_set_sync": "Set native image-position or window synchronization for explicit same-study panes.",
    "viewer_open_panel": "Show the series, measurements, segmentation or unsaved report panel.",
    "viewer_set_cine": "Play or stop a native cine sequence at a bounded frame rate.",
    "viewer_set_mpr": "Apply an available native MPR layout to reconstructable data.",
    "viewer_set_crosshair": "Move MPR intersections to a calibrated world point inside the selected volume.",
    "viewer_set_fusion": "Set opacity and an optional color map on an already visible same-study fusion layer.",
    "viewer_set_volume": "Set native volume blend, slab thickness or a named volume-rendering preset.",
    "viewer_get_state": "Read current non-identifying viewer state and available study aliases.",
    "viewer_set_window_level": "Set window/level on a viewport using a preset or explicit width/center.",
    "viewer_set_layout": "Change the viewer rows and columns.",
    "viewer_open_series": "Show an available opaque displaySetId in the active or selected viewport.",
    "viewer_jump_to_slice": "Jump to a zero-based slice index in the current series.",
    "viewer_set_view": "Adjust or reset the viewport presentation.",
    "viewer_set_tool": "Select a supported interactive OHIF tool.",
    "viewer_measurement": "Create or edit a reversible measurement draft. Create points are two normalized viewport [x,y] positions in [0,1]; RectangleROI uses opposite corners. Deletion requires review.",
    "viewer_segmentation": "Select or show/hide an existing segmentation; does not generate masks.",
    "viewer_undo": "Undo the previous supported viewer edit.",
    "viewer_redo": "Redo the previous supported viewer edit.",
    "report_draft": "Replace the visible preliminary findings and impression draft for review.",
    "report_save": "Open the app approval card for this exact report draft on the bound imported/governed study. Calling this tool only proposes the save; the backend waits for the user's approval button before persistence. It does not finalize or sign a report.",
    "viewer_open_worklist": "Open the RadSysX worklist; current live context will end.",
    "study_open": "Open an opaque worklist studyId through the governed viewer launch contract; current context will end.",
    "research_run": "Delegate a public literature question to the configured independent research agent. Up to two run concurrently while conversation continues. Never include patient information.",
    "research_cancel": "Cancel one pending research tool call by its toolCallId.",
}


def validate_tool(name, args):
    if name not in TOOL_MODELS:
        raise ValueError("Unknown tool")
    return TOOL_MODELS[name].model_validate(args).model_dump(exclude_none=True)


def requires_approval(name, args):
    return name == "report_save" or (name == "viewer_measurement" and args.get("operation") == "delete")


def declarations():
    from google.genai import types
    return [types.FunctionDeclaration(name=name, description=DESCRIPTIONS[name],
        behavior="NON_BLOCKING", parameters_json_schema=model.model_json_schema())
        for name, model in TOOL_MODELS.items()]


# Do not forward arbitrary renderer dictionaries or route/query/clinical identifiers.
SAFE_STATE_KEYS = {
    "studyId", "seriesId", "activeViewportId", "viewportId", "viewports", "displaySets", "series", "measurements", "segmentations",
    "id", "displaySetId", "segmentationId", "measurementId", "tool", "type", "modality",
    "index", "imageIndex", "sliceIndex", "imageCount", "numImageFrames", "rows", "columns",
    "layout", "windowWidth", "windowCenter", "preset", "zoom", "panX", "panY", "rotation",
    "invert", "flipHorizontal", "flipVertical", "visible", "selected", "points", "label",
    "length", "area", "unit", "value", "canUndo", "canRedo", "available", "status",
    "playing", "fps", "opacity", "sampleDistance", "ambient", "diffuse", "specular", "shade", "blend", "slabThickness", "referenceLines", "imageOverlay", "enabled", "worldPoint", "panel", "seriesIds",
    "canvasWidth", "canvasHeight", "orientation", "position", "width", "height", "active", "state", "applied", "message",
}


def safe_state(value, depth=0):
    if depth > 8:
        return None
    if isinstance(value, dict) and "capabilities" in value:
        # Capability names/availability are data, never new authority or arbitrary schemas.
        return {"capabilities": [{"name": c["name"], "available": c.get("available") is True}
            for c in (value["capabilities"] if isinstance(value["capabilities"], list) else [])[:64] if isinstance(c, dict) and c.get("name") in TOOL_MODELS]}
    if isinstance(value, dict):
        return {k: safe_state(v, depth + 1) for k, v in value.items() if k in SAFE_STATE_KEYS}
    if isinstance(value, list):
        return [safe_state(v, depth + 1) for v in value[:100]]
    if isinstance(value, str):
        return value[:256]
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return None


def bound_json(value, maximum=65536):
    if len(json.dumps(value, allow_nan=False).encode()) > maximum:
        raise ValueError("Payload exceeds limit")
    return value
