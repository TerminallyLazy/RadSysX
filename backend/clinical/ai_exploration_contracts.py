"""Strict scoped observation records. Pixels have no durable representation."""
from __future__ import annotations
import base64
import hashlib
import json
from datetime import datetime
from io import BytesIO
from PIL import Image
from typing import Annotated, Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel
from .ai_view_image import jpeg_dimensions

MAX_BATCH_IMAGES = 8
MAX_BATCH_BYTES = 8 * 1024 * 1024
MAX_RUN_IMAGES = 128
MAX_RUN_CALLS = 64
MAX_RUN_SECONDS = 600
MAX_EDGE = 2048
Handle = Annotated[str, Field(pattern=r'^[a-z][a-z0-9]*-[A-Za-z0-9_-]{1,120}$')]
Finite = Annotated[float, Field(ge=-1e7, le=1e7)]
Index = Annotated[int, Field(ge=0, le=100000)]


class Record(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, populate_by_name=True,
                              alias_generator=to_camel, allow_inf_nan=False)
    def wire(self):
        return self.model_dump(by_alias=True, exclude_none=True)


class ShareSelection(Record):
    kind: Literal['current_image', 'entire_view', 'series']
    study_id: Handle
    series_ids: list[Handle] = Field(min_length=1, max_length=32)
    allow_viewer_tools: bool = False

    @model_validator(mode='after')
    def unique(self):
        if len(set(self.series_ids)) != len(self.series_ids): raise ValueError('Duplicate scope')
        if self.kind == 'series' and len(self.series_ids) != 1: raise ValueError('Select one series')
        return self


class RendererBinding(Record):
    renderer_id: Handle
    epoch: Handle
    context_version: int = Field(ge=1)
    revision: int = Field(ge=0)
    study_id: Handle
    series_ids: list[Handle] = Field(min_length=1, max_length=32)


class FrameDescriptor(Record):
    id: Handle
    index: Index
    rows: int = Field(ge=1, le=65535)
    columns: int = Field(ge=1, le=65535)
    position: list[Finite] | None = Field(default=None, min_length=3, max_length=3)
    orientation: list[Finite] | None = Field(default=None, min_length=6, max_length=6)
    spacing: list[Annotated[float, Field(gt=0, le=10000)]] | None = Field(default=None, min_length=2, max_length=2)
    time_index: Index | None = None
    slice_index: Index | None = None


class SeriesManifest(Record):
    manifest_id: Handle
    study_id: Handle
    series_id: Handle
    modality: Literal['CT','MR','US','PT','CR','DX','XA','RF','MG','NM','OT','SEG']
    frame_count: int = Field(ge=1, le=10000)
    ordering: Literal['display_set'] = 'display_set'
    offset: int = Field(default=0, ge=0, le=9999)
    frames: list[FrameDescriptor] = Field(min_length=1, max_length=256)

    @model_validator(mode='after')
    def ordered(self):
        if [f.index for f in self.frames] != list(range(self.offset, self.offset+len(self.frames))):
            raise ValueError('Unstable frame ordering')
        if self.offset + len(self.frames) > self.frame_count or len({f.id for f in self.frames}) != len(self.frames):
            raise ValueError('Invalid inventory')
        return self

    def digest(self):
        return hashlib.sha256(json.dumps(self.wire(), sort_keys=True, separators=(',', ':')).encode()).hexdigest()


class Presentation(Record):
    window_width: float | None = Field(default=None, gt=0, le=100000)
    window_center: float | None = Field(default=None, ge=-100000, le=100000)
    invert: bool | None = None
    orientation: Literal['native','axial','coronal','sagittal'] | None = None


class ObservationRequest(Record):
    kind: Literal['workspace','panes','series_frames']
    manifest_id: Handle | None = None
    frame_ids: list[Handle] = Field(default_factory=list, max_length=8)
    viewport_ids: list[Handle] = Field(default_factory=list, max_length=8)
    presentation: Presentation = Field(default_factory=Presentation)

    @model_validator(mode='after')
    def coherent(self):
        if self.kind == 'series_frames' and (not self.manifest_id or not self.frame_ids or self.viewport_ids):
            raise ValueError('Frames require a manifest')
        if self.kind != 'series_frames' and (self.manifest_id or self.frame_ids): raise ValueError('Invalid view observation')
        if len(set(self.frame_ids)) != len(self.frame_ids) or len(set(self.viewport_ids)) != len(self.viewport_ids):
            raise ValueError('Duplicate image selection')
        return self


class ImageObservation(Record):
    image_id: Handle
    kind: Literal['overview','pane','frame','thumbnail']
    frame_id: Handle | None = None
    viewport_id: Handle | None = None
    manifest_id: Handle | None = None
    index: Index | None = None
    width: int = Field(ge=1, le=MAX_EDGE)
    height: int = Field(ge=1, le=MAX_EDGE)
    original_width: int = Field(ge=1, le=65535)
    original_height: int = Field(ge=1, le=65535)
    crop: list[int] | None = Field(default=None, min_length=4, max_length=4)
    presentation: Presentation = Field(default_factory=Presentation)
    captured_at: str = Field(max_length=40)
    sha256: str = Field(pattern=r'^[a-f0-9]{64}$')
    data: str = Field(min_length=4, max_length=1024*1024, repr=False, exclude=True)

    @model_validator(mode='after')
    def validate_image(self):
        raw = base64.b64decode(self.data, validate=True)
        if jpeg_dimensions(raw) != (self.width,self.height) or hashlib.sha256(raw).hexdigest() != self.sha256:
            raise ValueError('Invalid observation image')
        try:
            with Image.open(BytesIO(raw)) as decoded:
                if decoded.format != 'JPEG' or decoded.size != (self.width, self.height):
                    raise ValueError('Invalid observation image')
                decoded.load()
        except Exception:
            raise ValueError('Invalid observation image') from None
        stamp = datetime.fromisoformat(self.captured_at.replace('Z','+00:00'))
        if stamp.tzinfo is None: raise ValueError('Capture time requires a timezone')
        if self.kind == 'frame' and (not self.frame_id or not self.manifest_id or self.index is None):
            raise ValueError('Frame image must identify its source')
        if self.crop and (min(self.crop) < 0 or self.crop[2] < 1 or self.crop[3] < 1): raise ValueError('Invalid crop')
        return self

    def receipt(self):
        return self.wire()

    def input_item(self):
        return {'type':'inputImage', 'imageUrl':'data:image/jpeg;base64,' + self.data}


class ObservationFailure(Record):
    id: Handle
    reason: Literal['render_failed','unsupported','stale','budget','cancelled']


class ObservationResult(Record):
    operation_id: Handle
    claim_id: Handle
    revision: int = Field(ge=0)
    images: list[ImageObservation] = Field(default_factory=list, max_length=MAX_BATCH_IMAGES)
    failures: list[ObservationFailure] = Field(default_factory=list, max_length=8)

    @model_validator(mode='after')
    def bounded(self):
        if len({i.image_id for i in self.images}) != len(self.images): raise ValueError('Duplicate image')
        if sum(len(i.data) for i in self.images) > MAX_BATCH_BYTES: raise ValueError('Observation too large')
        return self


class CoverageReceipt(Record):
    manifest_id: Handle
    frame_count: int = Field(ge=1, le=10000)
    frame_ids: list[Handle] = Field(max_length=10000)
    requested: list[Index] = Field(default_factory=list, max_length=10000)
    captured: list[Index] = Field(default_factory=list, max_length=10000)
    delivered: list[Index] = Field(default_factory=list, max_length=10000)
    failed: list[Index] = Field(default_factory=list, max_length=10000)
    unconfirmed: list[Index] = Field(default_factory=list, max_length=10000)
    delivery_attempts: int = Field(default=0, ge=0)
    status: Literal['pending','partial','complete']


class ExplorationGrant(Record):
    grant_id: Handle
    session_id: str = Field(min_length=1, max_length=160)
    task_id: Handle
    model_id: str = Field(min_length=1, max_length=200)
    scope: ShareSelection
    binding: RendererBinding
    permissions: list[Literal['observe','mutate','propose_durable']] = Field(max_length=3)
    created_at: str = Field(max_length=40)
    expires_at: str = Field(max_length=40)
    status: Literal['prepared','active','paused','revoked','expired']

    @model_validator(mode='after')
    def matches(self):
        if self.scope.study_id != self.binding.study_id or not set(self.scope.series_ids) <= set(self.binding.series_ids):
            raise ValueError('Scope does not match renderer')
        if not self.scope.allow_viewer_tools and set(self.permissions) - {'observe'}:
            raise ValueError('Viewer permission was not granted')
        return self


class ActionRequest(Record):
    operation_id: Handle
    grant_id: Handle
    name: str = Field(pattern=r'^[a-z][a-z0-9_]{1,63}$')
    args: dict = Field(default_factory=dict)
    expected_revision: int = Field(ge=0)
    deadline: str = Field(max_length=40)


class RendererCommand(ActionRequest):
    task_id: Handle
    binding: RendererBinding
    kind: Literal['observe','action','manifest']
    claim_id: Handle | None = None


class ActionResult(Record):
    operation_id: Handle
    claim_id: Handle
    status: Literal['completed','failed','outcome_unknown']
    before_revision: int = Field(ge=0)
    revision: int = Field(ge=0)
    state: dict = Field(default_factory=dict)
    can_undo: bool = False
    error: Literal['unavailable','stale','cancelled','failed','unknown'] | None = None


class TaskSnapshot(Record):
    grant: ExplorationGrant
    status: Literal['prepared','running','completed','failed','cancelled','interrupted','paused']
    activity: str | None = Field(default=None, max_length=160)
    coverage: list[CoverageReceipt] = Field(default_factory=list, max_length=32)
    actions: list[dict] = Field(default_factory=list, max_length=64)
    can_continue: bool = False
