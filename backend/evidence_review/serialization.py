"""Versioned canonical JSON without duplicate keys or nonfinite numbers."""
from __future__ import annotations

import hashlib
import json
from typing import Any


def canonical_json(value: object) -> bytes:
    try:
        return json.dumps(value, sort_keys=True, separators=(",", ":"),
                          ensure_ascii=False, allow_nan=False).encode("utf-8")
    except (UnicodeError, TypeError, OverflowError, RecursionError) as exc:
        raise ValueError("invalid_json") from None


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def parse_json(data: bytes, *, max_bytes: int = 2 * 1024 * 1024) -> Any:
    if len(data) > max_bytes:
        raise ValueError("input_too_large")
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate_key")
            result[key] = value
        return result
    def constant(value):
        raise ValueError("nonfinite_number")
    try:
        value = json.loads(data.decode("utf-8"), object_pairs_hook=pairs, parse_constant=constant)
        canonical_json(value)  # Reject lone surrogates, including escaped ones.
        return value
    except (UnicodeError, RecursionError, json.JSONDecodeError):
        raise ValueError("invalid_json") from None


class FrozenDict(dict):
    """JSON-serializable immutable mappings for nested snapshot metadata."""
    def _deny(self, *args, **kwargs):
        raise TypeError("immutable_record")
    __setitem__ = __delitem__ = clear = pop = popitem = setdefault = update = __ior__ = _deny
    def __copy__(self):
        return self
    def __deepcopy__(self, memo):
        return self


def immutable(value):
    if isinstance(value, dict):
        return FrozenDict({key: immutable(item) for key, item in value.items()})
    if isinstance(value, (list, tuple)):
        return tuple(immutable(item) for item in value)
    return value
