"""Authoritative screen-sharing state, with synthetic pixels and no cloud calls."""
import asyncio
import base64
import json
import re

import pytest
from fastapi import HTTPException

from backend.clinical.ai_provider import SYSTEM_INSTRUCTION
from backend.tests.test_ai_connection_races import DuplexSocket
from backend.tests.test_ai_live import live, wait_until
from backend.tests.test_ai_providers import OpenAITransportFixture, openai_runtime, selected


PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII="
)
MEDIA_PREFIX = "Image availability (authoritative): "


def media_context(provider):
    text = provider.send_context.await_args.args[0]
    lines = [line.removeprefix(MEDIA_PREFIX) for line in text.splitlines() if line.startswith(MEDIA_PREFIX)]
    assert len(lines) == 1, "The model needs one current, authoritative media state."
    return json.loads(lines[0])


def assert_media(provider, *, sharing, available):
    media = media_context(provider)
    assert media["screenSharing"] is sharing
    assert media["imageAvailable"] is available
    assert media["scope"] == "selected_viewport"
    if available:
        assert isinstance(media["imageAgeSeconds"], (float, int)) and media["imageAgeSeconds"] >= 0
    else:
        assert media["imageAgeSeconds"] is None
    return media


def statuses(runtime):
    return [event for event in runtime.websocket.events if event["kind"] == "screen_status"]


async def sharing(runtime, active, version=None):
    await runtime.receive_control({"kind": "screen_sharing", "active": active,
                                   "contextVersion": runtime.context_version if version is None else version})


async def frame(runtime, version=None):
    await runtime.receive_control({"kind": "screen", "mimeType": "image/png",
                                   "data": base64.b64encode(PNG).decode(),
                                   "contextVersion": runtime.context_version if version is None else version})


def test_initial_context_explicitly_has_no_pixels_despite_viewer_metadata(selected):
    async def scenario():
        runtime = openai_runtime(selected)
        provider = runtime.provider
        await runtime.send_context(include_history=True)
        assert_media(provider, sharing=False, available=False)
        assert not runtime.screen_sharing and not runtime.frame_received
        provider.send_image.assert_not_awaited()
        with pytest.raises(ValueError):
            await frame(runtime)
        provider.send_image.assert_not_awaited()
    asyncio.run(scenario())


def test_start_is_pending_until_first_frame_delivery_and_media_is_not_journaled(selected):
    async def scenario():
        runtime = openai_runtime(selected)
        provider = runtime.provider
        await sharing(runtime, True)
        assert_media(provider, sharing=True, available=False)
        assert statuses(runtime)[-1]["active"] is True
        assert statuses(runtime)[-1]["frameReceived"] is False
        assert not runtime.frame_received
        provider.send_image.assert_not_awaited()

        entered, release = asyncio.Event(), asyncio.Event()
        async def delayed_image(data, mime):
            assert data == PNG and mime == "image/png"
            entered.set()
            await release.wait()
        provider.send_image.side_effect = delayed_image
        pending = asyncio.create_task(frame(runtime))
        try:
            await asyncio.wait_for(entered.wait(), 2)
            assert not runtime.frame_received
            assert not any(event["frameReceived"] for event in statuses(runtime))
            assert_media(provider, sharing=True, available=False)
            release.set()
            await asyncio.wait_for(pending, 2)
            assert runtime.frame_received and runtime.screen_sharing
            provider.send_image.assert_awaited_once_with(PNG, "image/png")
            assert_media(provider, sharing=True, available=True)
            assert statuses(runtime)[-1]["active"] is True
            assert statuses(runtime)[-1]["frameReceived"] is True
            history = runtime.repo.history(runtime.id, runtime.actor)
            assert not any(event["kind"] in {"screen_status", "screen", "screen_sharing"} for event in history["events"])
            stored = json.dumps(history)
            assert base64.b64encode(PNG).decode() not in stored
            assert MEDIA_PREFIX not in stored
        finally:
            release.set()
            if not pending.done():
                pending.cancel()
                await asyncio.gather(pending, return_exceptions=True)
    asyncio.run(scenario())


def test_failed_frame_delivery_never_claims_pixels_are_available(selected):
    async def scenario():
        runtime = openai_runtime(selected)
        provider = runtime.provider
        await sharing(runtime, True)
        provider.send_image.side_effect = ConnectionError("Synthetic image delivery failure")
        with pytest.raises(ConnectionError):
            await frame(runtime)
        assert not runtime.frame_received
        assert not any(event["frameReceived"] for event in statuses(runtime))
        assert_media(provider, sharing=True, available=False)
    asyncio.run(scenario())


def test_stopping_sharing_withdraws_pixel_availability_and_rejects_late_frames(selected):
    async def scenario():
        runtime = openai_runtime(selected)
        provider = runtime.provider
        await sharing(runtime, True)
        await frame(runtime)
        assert_media(provider, sharing=True, available=True)

        await sharing(runtime, False)

        assert not runtime.screen_sharing and not runtime.frame_received
        assert_media(provider, sharing=False, available=False)
        assert statuses(runtime)[-1]["active"] is False
        assert statuses(runtime)[-1]["frameReceived"] is False
        runtime.last_frame = 0  # A rejection must be consent-based, not just frame throttling.
        with pytest.raises(ValueError):
            await frame(runtime)
        provider.send_image.assert_awaited_once()
        await sharing(runtime, True)
        assert_media(provider, sharing=True, available=False)
        assert statuses(runtime)[-1]["frameReceived"] is False
    asyncio.run(scenario())


@pytest.mark.parametrize("active", [None, 0, 1, "true", "false", [], {}])
def test_sharing_requires_an_explicit_boolean_and_cannot_be_inferred(selected, active):
    async def scenario():
        runtime = openai_runtime(selected)
        with pytest.raises(ValueError):
            await sharing(runtime, active)
        assert not runtime.screen_sharing and not runtime.frame_received
        runtime.provider.send_context.assert_not_awaited()
        runtime.provider.send_image.assert_not_awaited()
        assert not any(event["active"] for event in statuses(runtime))
    asyncio.run(scenario())


def test_stale_sharing_start_cannot_authorize_current_context(selected):
    async def scenario():
        runtime = openai_runtime(selected)
        with pytest.raises(HTTPException) as error:
            await sharing(runtime, True, version=runtime.context_version + 1)
        assert error.value.status_code == 409
        assert not runtime.screen_sharing and not runtime.frame_received
        runtime.provider.send_context.assert_not_awaited()
    asyncio.run(scenario())


@pytest.mark.parametrize("change", ["context", "attestation", "closed", "provider"])
def test_queued_sharing_start_rechecks_context_and_connection_at_delivery(selected, change):
    async def scenario():
        runtime = openai_runtime(selected)
        original = runtime.provider
        fresh = OpenAITransportFixture()
        await runtime.provider_lock.acquire()
        pending = asyncio.create_task(sharing(runtime, True))
        try:
            await asyncio.sleep(0)
            assert not pending.done(), "The start request must reach the contended provider lock."
            if change == "context":
                runtime.repo.change(runtime.id, context_version=runtime.context_version + 1)
            elif change == "attestation":
                runtime.repo.change(runtime.id, attestation=None)
            elif change == "closed":
                runtime.closed = True
            else:
                runtime.provider = fresh
        finally:
            runtime.provider_lock.release()
        if change == "provider":
            await asyncio.wait_for(pending, 2)
        else:
            with pytest.raises(HTTPException) as error:
                await asyncio.wait_for(pending, 2)
            assert error.value.status_code == 409
        assert not runtime.screen_sharing and not runtime.frame_received
        original.send_context.assert_not_awaited()
        fresh.send_context.assert_not_awaited()
        assert not any(event["active"] for event in statuses(runtime))
    asyncio.run(scenario())


def test_provider_reconnect_clears_previous_sharing_and_does_not_restore_pixels(selected):
    async def scenario():
        env, original = selected
        runtime = openai_runtime(selected)
        fresh = OpenAITransportFixture()
        transports = iter((original, fresh))
        env.service.openai_provider_factory = lambda: next(transports)
        runtime.provider = None
        runtime.provider_ready = False
        runtime.provider_task = asyncio.create_task(runtime.provider_loop())
        try:
            await wait_until(lambda: runtime.provider is original and runtime.provider_ready)
            assert_media(original, sharing=False, available=False)
            await sharing(runtime, True)
            await frame(runtime)
            assert_media(original, sharing=True, available=True)
            await original.messages.put(ConnectionError("Synthetic connection interruption"))
            await wait_until(lambda: runtime.provider is fresh and runtime.provider_ready)
            assert not runtime.screen_sharing and not runtime.frame_received
            assert_media(fresh, sharing=False, available=False)
            assert fresh.handles == [None]
            fresh.send_image.assert_not_awaited()
            runtime.last_frame = 0
            with pytest.raises(ValueError):
                await frame(runtime)
            fresh.send_image.assert_not_awaited()
        finally:
            await env.service.shutdown()
    asyncio.run(scenario())


@pytest.mark.parametrize("operation", ["start", "first_frame"])
@pytest.mark.parametrize("replacement", [False, True], ids=["disconnected", "replaced"])
def test_media_status_cannot_arrive_from_a_replaced_provider_context_send(selected, operation, replacement):
    async def scenario():
        runtime = openai_runtime(selected)
        original = runtime.provider
        fresh = OpenAITransportFixture()
        if operation == "first_frame":
            await sharing(runtime, True)
        entered, release = asyncio.Event(), asyncio.Event()
        async def delayed_context(text):
            entered.set()
            await release.wait()
        original.send_context.side_effect = delayed_context
        before = len(statuses(runtime))
        pending = asyncio.create_task(sharing(runtime, True) if operation == "start" else frame(runtime))
        try:
            await asyncio.wait_for(entered.wait(), 2)
            # Provider setup/teardown can run while an old send is in flight.
            # Its new connection starts without consent or any received image.
            runtime.provider = fresh if replacement else None
            runtime.provider_ready = replacement
            runtime.screen_sharing = runtime.frame_received = False
            release.set()
            await asyncio.wait_for(pending, 2)
            assert not any(event["active"] or event["frameReceived"] for event in statuses(runtime)[before:])
            fresh.send_context.assert_not_awaited()
            fresh.send_image.assert_not_awaited()
            assert not runtime.screen_sharing and not runtime.frame_received
        finally:
            release.set()
            if not pending.done():
                pending.cancel()
                await asyncio.gather(pending, return_exceptions=True)
    asyncio.run(scenario())


def test_browser_disconnect_resets_sharing_before_a_fresh_connection(selected):
    async def scenario():
        env, original = selected
        runtime = openai_runtime(selected)
        fresh = OpenAITransportFixture()
        transports = iter((original, fresh))
        env.service.openai_provider_factory = lambda: next(transports)
        runtime.provider = runtime.websocket = None
        runtime.provider_ready = False
        before, after = DuplexSocket(), DuplexSocket()
        first = asyncio.create_task(env.service.attach(before, runtime.id, env.actor))
        second = None
        try:
            await wait_until(lambda: runtime.provider is original and runtime.provider_ready)
            await sharing(runtime, True)
            await frame(runtime)
            await before.incoming.put({"type": "websocket.disconnect"})
            await asyncio.wait_for(first, 2)
            assert not runtime.screen_sharing and not runtime.frame_received
            second = asyncio.create_task(env.service.attach(after, runtime.id, env.actor))
            await wait_until(lambda: runtime.provider is fresh and runtime.provider_ready)
            assert_media(fresh, sharing=False, available=False)
            assert fresh.handles == [None]
            fresh.send_image.assert_not_awaited()
            assert not any(event.get("frameReceived") for event in after.events)
        finally:
            for task in (first, second):
                if task and not task.done():
                    task.cancel()
            await asyncio.gather(*(task for task in (first, second) if task), return_exceptions=True)
            await env.service.shutdown()
    asyncio.run(scenario())


def test_system_instruction_distinguishes_current_pixels_from_historical_context():
    instruction = SYSTEM_INSTRUCTION.lower()
    # Assert the semantic guardrails, not a verbatim prompt paragraph.
    assert "image availability" in instruction
    assert re.search(r"(no|without|not).{0,80}(image|frame|pixel)", instruction)
    assert "historical" in instruction
    assert "viewport" in instruction
    assert re.search(r"(do not|never|only).{0,100}(claim|see|visible|describe)", instruction)
