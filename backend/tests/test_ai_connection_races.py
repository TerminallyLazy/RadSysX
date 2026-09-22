"""Connection and authority races, using synthetic transports without cloud access."""

import asyncio
import base64
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from backend.tests.test_ai_live import FakeSocket, live, runtime_for, wait_until
from backend.tests.test_ai_providers import (
    OpenAITransportFixture,
    openai_runtime,
    selected,
)


KINDS = ("audio", "text", "screen", "audio_end", "playback_stop", "context")
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII="
)


def test_cancelled_pending_tool_cannot_dispatch_after_initial_event_finishes(selected):
    async def scenario():
        runtime = openai_runtime(selected)
        entered, release = asyncio.Event(), asyncio.Event()
        send_json = runtime.websocket.send_json
        async def delayed_pending(event):
            await send_json(event)
            if event.get("kind") == "tool" and event.get("status") == "pending":
                entered.set()
                await release.wait()
        runtime.websocket.send_json = delayed_pending
        tool = SimpleNamespace(id="cancel-before-dispatch", name="viewer_set_view", args={"zoom": 1.5})
        pending = asyncio.create_task(runtime.schedule_tool(tool))
        cancelled = None
        try:
            await asyncio.wait_for(entered.wait(), 2)
            cancelled = asyncio.create_task(runtime.cancel(tool.id))
            await wait_until(lambda: runtime.repo.tool(runtime.id, tool.id)["status"] == "cancelled")
            release.set()
            await asyncio.gather(pending, cancelled)
            assert runtime.repo.tool(runtime.id, tool.id)["status"] == "cancelled"
            assert tool.id not in runtime.tasks
            assert not any(event.get("kind") == "viewer_action" for event in runtime.websocket.events)
            # Even an already-created stale execution task must respect the
            # durable cancellation at its entry point.
            await runtime.execute(runtime.repo.tool(runtime.id, tool.id))
            assert runtime.repo.tool(runtime.id, tool.id)["status"] == "cancelled"
        finally:
            release.set()
            await asyncio.gather(*(task for task in (pending, cancelled) if task), return_exceptions=True)
            await runtime.cancel_all()
    asyncio.run(scenario())


def tracked(provider):
    provider.send_text = AsyncMock()
    return provider


def sent_count(provider):
    return sum(getattr(provider, name).await_count for name in (
        "send_audio", "send_text", "send_image", "end_audio", "interrupt", "send_context",
    ))


async def submit(runtime, kind):
    if kind == "audio":
        return await runtime.receive_audio(b"\0\0" * 480)
    if kind == "context":
        return await runtime.send_context()
    event = {"kind": kind, "contextVersion": runtime.context_version}
    if kind == "text":
        event["text"] = "Synthetic queued request."
    elif kind == "screen":
        event.update(mimeType="image/png", data=base64.b64encode(PNG).decode())
    elif kind == "playback_stop":
        event.update(itemId="item_fixture", contentIndex=0, audioEndMs=17)
    return await runtime.receive_control(event)


async def clean_rejection_or_drop(task):
    try:
        await asyncio.wait_for(task, 2)
    except HTTPException as error:
        assert error.status_code == 409


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("replacement", [False, True], ids=["disconnected", "replaced"])
def test_queued_send_cannot_cross_provider_connection(selected, kind, replacement):
    async def scenario():
        runtime = openai_runtime(selected)
        original = tracked(runtime.provider)
        fresh = tracked(OpenAITransportFixture())
        await runtime.provider_lock.acquire()
        pending = asyncio.create_task(submit(runtime, kind))
        try:
            await asyncio.sleep(0)
            assert not pending.done(), "The input must reach the contended send lock."
            runtime.provider = fresh if replacement else None
        finally:
            runtime.provider_lock.release()
        await clean_rejection_or_drop(pending)
        assert sent_count(original) == sent_count(fresh) == 0
    asyncio.run(scenario())


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("revocation", ["closed", "attestation", "context"])
def test_queued_send_rechecks_authority_at_delivery(selected, kind, revocation):
    async def scenario():
        runtime = openai_runtime(selected)
        provider = tracked(runtime.provider)
        await runtime.provider_lock.acquire()
        pending = asyncio.create_task(submit(runtime, kind))
        try:
            await asyncio.sleep(0)
            assert not pending.done(), "The input must reach the contended send lock."
            if revocation == "closed":
                runtime.closed = True
            elif revocation == "attestation":
                runtime.repo.change(runtime.id, attestation=None)
            else:
                runtime.repo.change(runtime.id, context_version=runtime.context_version + 1)
        finally:
            runtime.provider_lock.release()
        await clean_rejection_or_drop(pending)
        assert sent_count(provider) == 0
    asyncio.run(scenario())


@pytest.mark.parametrize("change", ["disconnected", "replaced", "closed", "attestation", "context"])
def test_text_ui_delivery_cannot_hide_a_later_authority_change(selected, change):
    async def scenario():
        runtime = openai_runtime(selected)
        original = tracked(runtime.provider)
        fresh = tracked(OpenAITransportFixture())
        entered, release = asyncio.Event(), asyncio.Event()
        send_json = runtime.websocket.send_json

        async def hold_user_transcript(event):
            await send_json(event)
            if event.get("kind") == "transcript" and event.get("role") == "user":
                entered.set()
                await release.wait()

        runtime.websocket.send_json = hold_user_transcript
        pending = asyncio.create_task(submit(runtime, "text"))
        try:
            await asyncio.wait_for(entered.wait(), 2)
            already_sent = sent_count(original)
            if change in {"disconnected", "replaced"}:
                runtime.provider = fresh if change == "replaced" else None
            elif change == "closed":
                runtime.closed = True
            elif change == "attestation":
                runtime.repo.change(runtime.id, attestation=None)
            else:
                runtime.repo.change(runtime.id, context_version=runtime.context_version + 1)
            release.set()
            await clean_rejection_or_drop(pending)
            # Sending before the transcript is permitted; sending afterward
            # requires authority and the same connection to still be valid.
            assert sent_count(original) == already_sent
            assert sent_count(fresh) == 0
        finally:
            release.set()
            if not pending.done():
                pending.cancel()
                await asyncio.gather(pending, return_exceptions=True)
    asyncio.run(scenario())


def test_ready_waits_for_initial_context_and_rejects_early_input(selected):
    async def scenario():
        runtime = openai_runtime(selected)
        provider = tracked(runtime.provider)
        runtime.provider = None
        runtime.provider_ready = False
        started, release = asyncio.Event(), asyncio.Event()

        async def send_context(text):
            started.set()
            await release.wait()

        provider.send_context.side_effect = send_context
        pending = asyncio.create_task(runtime.provider_loop())
        try:
            await asyncio.wait_for(started.wait(), 2)
            assert not any(e.get("status") == "ready" for e in runtime.websocket.events)
            early = asyncio.create_task(submit(runtime, "text"))
            await clean_rejection_or_drop(early)
            assert provider.send_text.await_count == 0
            release.set()
            await wait_until(lambda: any(e.get("status") == "ready" for e in runtime.websocket.events))
            await submit(runtime, "text")
            provider.send_text.assert_awaited_once_with("Synthetic queued request.")
        finally:
            release.set()
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
    asyncio.run(scenario())


def test_context_setup_failure_never_publishes_ready(selected):
    async def scenario():
        runtime = openai_runtime(selected)
        provider = runtime.provider
        runtime.provider = None
        runtime.provider_ready = False
        provider.send_context.side_effect = RuntimeError("invalid argument")
        await asyncio.wait_for(runtime.provider_loop(), 2)
        assert not any(e.get("status") == "ready" for e in runtime.websocket.events)
        assert runtime.repo.get(runtime.id)["status"] == "failed"
        assert runtime.provider is None
    asyncio.run(scenario())


def test_fresh_openai_context_excludes_unconfirmed_assistant_speech(selected):
    async def scenario():
        runtime = openai_runtime(selected)
        provider = runtime.provider
        texts = {"user": "SYNTHETIC PRIOR USER REQUEST", "assistant": "SYNTHETIC UNHEARD ASSISTANT SPEECH"}
        for role, text in texts.items():
            runtime.repo.event(runtime.id, "transcript", {"role": role, "text": text,
                "finished": True, "turnId": f"synthetic-{role}"})

        await runtime.send_context(include_history=True)

        forwarded = provider.send_context.await_args.args[0]
        assert texts["user"] in forwarded
        assert texts["assistant"] not in forwarded
        # The local conversation remains reviewable; provider reconstruction
        # must not treat generated speech as proof that the user heard it.
        history = runtime.repo.history(runtime.id, runtime.actor)
        assert {e["role"]: e["text"] for e in history["events"] if e["kind"] == "transcript"} == texts
    asyncio.run(scenario())


def test_resumed_gemini_ready_waits_for_application_result_delivery(live):
    async def scenario():
        runtime = runtime_for(live)
        runtime.provider = None
        runtime.provider_ready = False
        runtime.handle = "synthetic-resumption-handle"
        runtime.response_outbox["synthetic-research"] = ("research_run", {"status": "completed"})
        started, release = asyncio.Event(), asyncio.Event()

        async def send_result(**kwargs):
            started.set()
            await release.wait()

        live.provider.send_tool_response = AsyncMock(side_effect=send_result)
        pending = asyncio.create_task(runtime.provider_loop())
        try:
            await asyncio.wait_for(started.wait(), 2)
            assert not any(e.get("status") == "ready" for e in runtime.websocket.events)
            release.set()
            await wait_until(lambda: any(e.get("status") == "ready" for e in runtime.websocket.events))
            assert runtime.response_outbox == {}
            assert live.provider.send_tool_response.await_count == 1
        finally:
            release.set()
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
    asyncio.run(scenario())


class DuplexSocket(FakeSocket):
    def __init__(self):
        super().__init__()
        self.incoming = asyncio.Queue()
        self.accepted = False

    async def accept(self):
        self.accepted = True

    async def receive(self):
        return await self.incoming.get()


def test_openai_detach_finishes_before_reconnect_and_never_replays_mutations(selected):
    async def scenario():
        env, original = selected
        runtime = openai_runtime(selected)
        fresh = OpenAITransportFixture()
        runtime.websocket = runtime.provider = None
        runtime.provider_ready = False
        closing, release = asyncio.Event(), asyncio.Event()

        @asynccontextmanager
        async def slow_connection(handle=None):
            original.handles.append(handle)
            try:
                yield original
            finally:
                closing.set()
                await release.wait()
                original.closed += 1

        original.connect = slow_connection
        providers = iter((original, fresh))
        env.service.openai_provider_factory = lambda: next(providers)
        before, after = DuplexSocket(), DuplexSocket()
        first = asyncio.create_task(env.service.attach(before, runtime.id, env.actor))
        second = None
        try:
            await wait_until(lambda: any(e.get("status") == "ready" for e in before.events))
            mutation = SimpleNamespace(id="completed-window", name="viewer_set_window_level",
                                       args={"windowWidth": 400, "windowCenter": 40})
            await runtime.schedule_tool(mutation)
            await wait_until(lambda: any(e.get("kind") == "viewer_action" for e in before.events))
            await runtime.receive_control({"kind": "action_result", "contextVersion": 1,
                "toolCallId": mutation.id, "status": "completed", "result": {"applied": True}})
            await wait_until(lambda: runtime.repo.tool(runtime.id, mutation.id)["status"] == "completed")
            await runtime.schedule_tool(SimpleNamespace(id="unapproved-save", name="report_save",
                args={"findings": "Synthetic findings", "impression": "Synthetic draft"}))
            runtime.response_outbox["undelivered-result"] = ("viewer_get_state", {"status": "completed"})

            await before.incoming.put({"type": "websocket.disconnect"})
            await asyncio.wait_for(closing.wait(), 2)
            second = asyncio.create_task(env.service.attach(after, runtime.id, env.actor))
            await asyncio.sleep(0)
            assert not after.accepted, "A replacement viewer cannot attach during provider teardown."
            release.set()
            await asyncio.wait_for(first, 2)
            if second.done():
                # A clean rejection during teardown may be retried afterward.
                with pytest.raises(HTTPException) as rejected:
                    await second
                assert rejected.value.status_code == 409
                second = asyncio.create_task(env.service.attach(after, runtime.id, env.actor))
            await wait_until(lambda: any(e.get("status") == "ready" for e in after.events))
            assert original.closed == 1 and original.handles == fresh.handles == [None]
            assert runtime.provider is fresh and runtime.provider_ready
            assert runtime.repo.tool(runtime.id, "unapproved-save")["status"] == "cancelled"
            assert runtime.response_outbox == {}
            fresh.send_tool_result.assert_not_awaited()

            # A repeated call ID can return the journal receipt but cannot
            # dispatch the completed mutation into the replacement viewer.
            await fresh.messages.put({"kind": "tool_call", "id": mutation.id,
                                      "name": mutation.name, "args": mutation.args})
            await wait_until(lambda: fresh.send_tool_result.await_count == 1)
            assert sum(e.get("kind") == "viewer_action" for e in before.events + after.events) == 1
            assert runtime.repo.tool(runtime.id, mutation.id)["status"] == "completed"
        finally:
            release.set()
            for task in (first, second):
                if task and not task.done():
                    task.cancel()
            await asyncio.gather(*(t for t in (first, second) if t), return_exceptions=True)
            await env.service.shutdown()
    asyncio.run(scenario())


def test_audio_marker_and_binary_stay_on_same_socket(selected):
    async def scenario():
        runtime = openai_runtime(selected)
        before, after = runtime.websocket, FakeSocket()
        entered, release = asyncio.Event(), asyncio.Event()
        send_json = before.send_json

        async def hold_marker(event):
            await send_json(event)
            entered.set()
            await release.wait()

        before.send_json = hold_marker
        pending = asyncio.create_task(runtime.handle_normalized_provider({"kind": "audio",
            "data": b"\0\0" * 240, "itemId": "item_fixture", "contentIndex": 0}))
        try:
            await asyncio.wait_for(entered.wait(), 2)
            runtime.websocket = after
            release.set()
            await pending
            assert before.events[-1]["kind"] == "audio_chunk"
            assert before.audio == [b"\0\0" * 240]
            assert after.events == after.audio == []
            assert all(e["kind"] != "audio_chunk" for e in runtime.repo.history(runtime.id, runtime.actor)["events"])
        finally:
            release.set()
            if not pending.done():
                pending.cancel()
                await asyncio.gather(pending, return_exceptions=True)
    asyncio.run(scenario())
