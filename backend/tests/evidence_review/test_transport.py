import asyncio
from datetime import datetime, timezone

import httpx
import pytest


def test_stream_size_bound_and_whole_attempt_deadline():
    from backend.evidence_review.transport import post_bounded
    class Slow(httpx.AsyncByteStream):
        async def __aiter__(self):
            while True:
                yield b"x"
                await asyncio.sleep(.005)
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req:httpx.Response(200,stream=Slow()))) as client:
            with pytest.raises(TimeoutError):
                async with asyncio.timeout(.03):
                    await post_bounded(client,url="https://api.typesafe.ai/v1/systemone",headers={},body=b"{}",byte_limit=128)
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req:httpx.Response(200,content=b"x"*100))) as client:
            with pytest.raises(ValueError,match="response_too_large"):
                await post_bounded(client,url="https://api.typesafe.ai/v1/systemone",headers={},body=b"{}",byte_limit=50)
    asyncio.run(scenario())


def test_retry_after_dates_and_untrusted_values():
    from backend.evidence_review.transport import retry_delay
    now=datetime(2026,9,22,tzinfo=timezone.utc)
    assert retry_delay("Tue, 22 Sep 2026 00:00:03 GMT",now=now)==3
    for value in ("NaN","Infinity","-1","garbage","999999999999"):
        assert retry_delay(value,now=now) is None
