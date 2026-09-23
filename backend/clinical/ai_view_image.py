"""Bounded, transient JPEG input for an explicitly attached viewer snapshot."""
import base64
import hashlib
import struct
from datetime import datetime
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator
from .contracts import parse_iso_z, utc_now


def jpeg_dimensions(data):
    if not data.startswith(b'\xff\xd8') or not data.endswith(b'\xff\xd9'):
        raise ValueError('Invalid viewer image')
    offset = 2
    while offset + 4 <= len(data):
        if data[offset] != 255: break
        while offset < len(data) and data[offset] == 255: offset += 1
        if offset >= len(data): break
        marker = data[offset]; offset += 1
        if marker in (0xD9, 0xDA): break
        if offset + 2 > len(data): break
        size = struct.unpack('>H', data[offset:offset+2])[0]
        if size < 2 or offset + size > len(data): break
        if marker in (0xC0, 0xC2) and size >= 8:
            height, width = struct.unpack('>HH', data[offset+3:offset+7])
            return width, height
        offset += size
    raise ValueError('Invalid viewer image')


class ViewImage(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    data: str = Field(min_length=4, max_length=700000, repr=False)
    mime_type: Literal['image/jpeg'] = Field(alias='mimeType')
    width: int = Field(ge=1, le=768)
    height: int = Field(ge=1, le=768)
    target_id: str = Field(alias='targetId', min_length=1, max_length=200)
    context_version: int = Field(alias='contextVersion', ge=1)
    captured_at: str = Field(alias='capturedAt', max_length=40)

    @model_validator(mode='after')
    def validate_image(self):
        data = base64.b64decode(self.data, validate=True)
        if len(data) > 524288 or jpeg_dimensions(data) != (self.width, self.height):
            raise ValueError('Invalid viewer image')
        captured = datetime.fromisoformat(self.captured_at.replace('Z', '+00:00'))
        if captured.tzinfo is None: raise ValueError('Invalid capture time')
        return self

    def check_current(self, row):
        age = (utc_now() - parse_iso_z(self.captured_at)).total_seconds()
        if (self.target_id != row['viewerContext']['targetId'] or self.context_version != row['contextVersion']
                or not -10 <= age <= 300):
            raise ValueError('Capture the current view again')

    def receipt(self):
        return {'scope': 'active_viewport', 'width': self.width, 'height': self.height,
                'capturedAt': self.captured_at, 'sha256': hashlib.sha256(base64.b64decode(self.data)).hexdigest()}

    def input_item(self):
        return {'type': 'image', 'url': 'data:image/jpeg;base64,' + self.data}
