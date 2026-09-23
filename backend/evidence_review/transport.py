"""Bounded single-attempt HTTP. No retry policy or error-body retention."""
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import math
import time

import httpx

from .contracts import AttemptOutcome


@dataclass(frozen=True)
class HTTPReceipt:
    status: int
    body: bytes
    retry_after: str | None
    elapsed_seconds: float
    submitted: bool = True


def new_http_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=10, follow_redirects=False, trust_env=False,
                            limits=httpx.Limits(max_connections=2, max_keepalive_connections=2))


def retry_delay(value: str | None, *, now: datetime | None = None) -> float | None:
    if not value or len(value) > 128:
        return None
    try:
        seconds = float(value)
    except ValueError:
        try:
            timestamp = parsedate_to_datetime(value)
            if timestamp.tzinfo is None:
                return None
            seconds = max(0,(timestamp - (now or datetime.now(timezone.utc))).total_seconds())
        except (TypeError, ValueError, OverflowError):
            return None
    return seconds if math.isfinite(seconds) and 0 <= seconds <= 86400 else None


async def post_bounded(client: httpx.AsyncClient, *, url: str, headers: dict[str,str], body: bytes, byte_limit: int) -> HTTPReceipt:
    if len(body) > byte_limit:
        raise ValueError("request_too_large")
    started = time.monotonic()
    async with client.stream("POST",url,headers={**headers,"Content-Type":"application/json","Accept-Encoding":"identity"},
                             content=body,follow_redirects=False,timeout=10) as response:
        data = bytearray()
        if response.status_code == 200:
            if response.headers.get("content-encoding", "identity").lower() != "identity":
                raise ValueError("unsupported_encoding")
            async for chunk in response.aiter_bytes(chunk_size=16384):
                if len(data) + len(chunk) > byte_limit:
                    raise ValueError("response_too_large")
                data.extend(chunk)
        delay = response.headers.get("retry-after")
        return HTTPReceipt(response.status_code,bytes(data),delay[:128] if delay else None,time.monotonic()-started)


def status_outcome(receipt: HTTPReceipt) -> AttemptOutcome | None:
    status = receipt.status
    if status == 200:
        return None
    retryable, stop = False, False
    if status in {401,403}:
        reason, stop = "credential_rejected", True
    elif status == 404:
        reason, stop = "model_unavailable", True
    elif status == 422:
        reason = "invalid_request"
    elif status in {429,529,500,502,503,504}:
        reason, retryable = "overloaded", True
    elif 300 <= status < 400:
        reason = "unexpected_redirect"
    else:
        reason = "provider_rejected"
    return AttemptOutcome(reason=reason,retryable=retryable,stop_evaluator=stop,submitted=True,
        retry_after_seconds=retry_delay(receipt.retry_after) if retryable else None,elapsed_seconds=receipt.elapsed_seconds)
