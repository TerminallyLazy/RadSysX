"""Synthetic OpenAI Realtime protocol tests; never load a key or call the cloud."""
import asyncio
import base64
import copy
import json
from types import SimpleNamespace

import pytest

from backend.clinical import ai_openai
from backend.clinical.ai_openai import MODEL, OpenAIProviderError, OpenAIRealtimeProvider
from backend.clinical.ai_tools import TOOL_MODELS


class FakeSocket:
    def __init__(self, *, ack=None, auto_ack=True):
        self.incoming = asyncio.Queue()
        self.sent = []
        self.closed = 0
        self.ack = ack
        self.auto_ack = auto_ack
        self.fail_send = None

    async def send(self, raw):
        event = json.loads(raw)
        self.sent.append(event)
        if self.fail_send == event["type"]:
            raise RuntimeError("secret-key patient-prompt wss://private.example")
        if event["type"] == "session.update" and self.auto_ack:
            self.push({"type": "session.created", "session": {"model": MODEL}})
            config = copy.deepcopy(event["session"])
            if self.ack:
                self.ack(config)
            self.push({"type": "session.updated", "session": config})

    def push(self, event):
        self.incoming.put_nowait(event if isinstance(event, (str, bytes, Exception)) else json.dumps(event))

    async def recv(self):
        event = await self.incoming.get()
        if isinstance(event, Exception):
            raise event
        return event

    async def close(self):
        self.closed += 1

    def events(self, kind):
        return [event for event in self.sent if event["type"] == kind]


class FakeFactory:
    def __init__(self, socket=None, error=None):
        self.socket = socket or FakeSocket()
        self.error = error
        self.calls = []

    def __call__(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return self

    async def __aenter__(self):
        if self.error:
            raise self.error
        return self.socket

    async def __aexit__(self, *args):
        await self.socket.close()


def provider(socket=None, *, key="synthetic-openai-key", error=None):
    factory = FakeFactory(socket, error)
    settings = SimpleNamespace(openai_api_key=key, openai_voice="marin", api_key="must-not-use-gemini")
    return OpenAIRealtimeProvider(settings, _ws_factory=factory), factory


async def created(session, response_id="response_1"):
    return await session._handle({"type": "response.created", "response": {"id": response_id}})


def call(call_id="call_1", name="research_run", args=None):
    return {"type": "function_call", "status": "completed", "id": "item_" + call_id,
            "call_id": call_id, "name": name, "arguments": json.dumps(args or {"query": "public evidence"})}


async def done(session, response_id="response_1", output=None, status="completed"):
    return await session._handle({"type": "response.done", "response": {
        "id": response_id, "status": status, "output": output or []}})


def audio(response_id="response_1", item_id="audio_1", content_index=0, size=4800):
    return {"type": "response.output_audio.delta", "response_id": response_id,
            "item_id": item_id, "content_index": content_index,
            "delta": base64.b64encode(b"\x01\x00" * (size // 2)).decode()}


def test_acknowledged_exact_model_config_backend_auth_and_fresh_handle():
    async def run():
        adapter, factory = provider()
        async with adapter.connect(handle="never-forward-this") as session:
            assert session is not None
            url, kwargs = factory.calls[0]
            assert url == "wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1-mini"
            assert kwargs["additional_headers"] == {"Authorization": "Bearer synthetic-openai-key"}
            assert kwargs["proxy"] is None and kwargs["logger"].disabled
            assert kwargs["max_size"] == 1024 * 1024 and kwargs["max_queue"] == 16
            config = factory.socket.sent[0]["session"]
            assert config["model"] == MODEL
            assert config["reasoning"] == {"effort": "low"}
            assert config["output_modalities"] == ["audio"]
            assert config["audio"]["input"]["transcription"]["model"] == "gpt-4o-mini-transcribe"
            assert config["audio"]["input"]["turn_detection"] == {
                "type": "server_vad", "create_response": False, "interrupt_response": False}
            assert config["audio"]["output"] == {"voice": "marin", "format": {"type": "audio/pcm", "rate": 24000}}
            assert {tool["name"] for tool in config["tools"]} == set(TOOL_MODELS)
            assert all(tool["type"] == "function" and tool["parameters"]["type"] == "object" for tool in config["tools"])
            assert "synthetic-openai-key" not in json.dumps(factory.socket.sent)
            assert "must-not-use-gemini" not in json.dumps(kwargs["additional_headers"])
            assert "never-forward-this" not in json.dumps(factory.socket.sent)
        assert factory.socket.closed == 1
        assert not session._calls and not session._audio and session._closed
    asyncio.run(run())


@pytest.mark.parametrize("change", [
    lambda config: config.update(model="gpt-realtime"),
    lambda config: config.update(output_modalities=["text"]),
    lambda config: config["audio"]["output"].update(voice="alloy"),
    lambda config: config["audio"]["input"]["format"].update(rate=16000),
    lambda config: config["audio"]["input"]["turn_detection"].update(create_response=True),
    lambda config: config["audio"]["input"]["turn_detection"].update(interrupt_response=True),
    lambda config: config["reasoning"].update(effort="high"),
    lambda config: config.update(tools=[]),
])
def test_rejects_changed_setup_before_yield(change):
    async def run():
        adapter, factory = provider(FakeSocket(ack=change))
        with pytest.raises(OpenAIProviderError) as error:
            async with adapter.connect():
                pytest.fail("Configuration mismatch became ready")
        assert error.value.code == "provider_configuration"
        assert factory.socket.closed == 1
    asyncio.run(run())


def test_missing_key_does_not_open_socket_or_fall_back():
    async def run():
        adapter, factory = provider(key="")
        with pytest.raises(OpenAIProviderError) as error:
            async with adapter.connect():
                pytest.fail("Missing key became ready")
        assert error.value.code == "provider_auth"
        assert not factory.calls
    asyncio.run(run())


@pytest.mark.parametrize("status,code", [(401, "provider_auth"), (403, "provider_auth"),
                                          (429, "provider_quota"), (404, "provider_configuration"),
                                          (503, "provider_unavailable")])
def test_handshake_failures_are_sanitized(status, code):
    async def run():
        failure = RuntimeError("secret-key patient-name raw-url")
        failure.response = SimpleNamespace(status_code=status)
        adapter, _ = provider(error=failure)
        with pytest.raises(OpenAIProviderError) as error:
            async with adapter.connect():
                pytest.fail("Failed connection became ready")
        assert error.value.code == code
        assert "secret-key" not in str(error.value) and "patient" not in str(error.value)
    asyncio.run(run())


def test_setup_waits_for_ack_and_cancellation_closes_socket():
    async def run():
        socket = FakeSocket(auto_ack=False)
        adapter, _ = provider(socket)
        ready = asyncio.Event()
        async def opening():
            async with adapter.connect():
                ready.set()
        task = asyncio.create_task(opening())
        for _ in range(10):
            await asyncio.sleep(0)
        assert not ready.is_set()
        assert socket.events("session.update")
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert socket.closed == 1
    asyncio.run(run())


def test_setup_timeout_and_server_error_are_safe(monkeypatch):
    async def run():
        socket = FakeSocket(auto_ack=False)
        adapter, _ = provider(socket)
        monkeypatch.setattr(ai_openai, "SETUP_TIMEOUT", .01)
        with pytest.raises(OpenAIProviderError) as error:
            async with adapter.connect():
                pytest.fail("No ack became ready")
        assert error.value.code == "provider_unavailable" and socket.closed == 1
        socket = FakeSocket(auto_ack=False)
        socket.push({"type": "error", "error": {"code": "insufficient_quota", "message": "secret-key"}})
        adapter, _ = provider(socket)
        with pytest.raises(OpenAIProviderError) as error:
            async with adapter.connect():
                pytest.fail("Provider error became ready")
        assert error.value.code == "provider_quota" and "secret-key" not in str(error.value)
        assert socket.closed == 1
    asyncio.run(run())


def test_input_text_context_image_and_pcm_shapes():
    async def run():
        adapter, factory = provider()
        async with adapter.connect() as session:
            await session.send_context("Synthetic viewer context")
            await session.send_image(b"\x89PNG\r\n\x1a\nsynthetic", "image/png")
            assert not factory.socket.events("response.create")
            await session.send_audio(b"\x00\x00" * 2400)
            assert base64.b64decode(factory.socket.events("input_audio_buffer.append")[0]["audio"]) == b"\x00\x00" * 2400
            await session.end_audio()
            await session.end_audio()
            assert len(factory.socket.events("input_audio_buffer.commit")) == 1
            assert not factory.socket.events("response.create")
            await session._handle({"type": "input_audio_buffer.committed", "item_id": "input_1"})
            assert len(factory.socket.events("response.create")) == 1
            await created(session)
            await session.send_text("Explain this synthetic example")
            items = factory.socket.events("conversation.item.create")
            assert items[0]["item"]["content"] == [{"type": "input_text", "text": "Synthetic viewer context"}]
            assert items[1]["item"]["content"][0]["image_url"].startswith("data:image/png;base64,")
            assert set(items[1]["item"]) == {"type", "role", "content"}
            assert items[2]["item"]["role"] == "user"
            assert len(factory.socket.events("response.create")) == 1
            await done(session)
            assert len(factory.socket.events("response.create")) == 2
    asyncio.run(run())


def test_short_empty_and_vad_committed_audio_do_not_duplicate_commits():
    async def run():
        adapter, factory = provider()
        async with adapter.connect() as session:
            await session.end_audio()
            await session.send_audio(b"\x00\x00" * 50)
            await session.end_audio()
            assert len(factory.socket.events("input_audio_buffer.clear")) == 1
            assert not factory.socket.events("input_audio_buffer.commit")
            await session.send_audio(b"\x00\x00" * 2400)
            await session._handle({"type": "input_audio_buffer.speech_stopped"})
            await session.end_audio()
            assert not factory.socket.events("input_audio_buffer.commit")
            await session._handle({"type": "input_audio_buffer.committed", "item_id": "input_1"})
            await session.end_audio()
            assert len(factory.socket.events("response.create")) == 1
    asyncio.run(run())


def test_two_delayed_calls_audio_and_serialized_result_continuations():
    async def run():
        adapter, factory = provider()
        async with adapter.connect() as session:
            await session.send_text("Compare public sources")
            await created(session)
            calls = [call("call_1"), call("call_2", args={"query": "other public evidence"})]
            events = await done(session, output=calls)
            assert [event["id"] for event in events if event["kind"] == "tool_call"] == ["call_1", "call_2"]
            assert not any(event.get("status") == "IDLE" for event in events)
            # Neither research job has finished; another user turn can still
            # produce audio while both calls remain pending.
            await session.send_text("Give me an overview while they run")
            await created(session, "response_2")
            audio_events = await session._handle(audio("response_2"))
            assert audio_events[0]["kind"] == "audio" and len(audio_events[0]["data"]) == 4800
            await asyncio.gather(session.send_tool_result("call_1", "research_run", {"summary": "one"}),
                                 session.send_tool_result("call_2", "research_run", {"summary": "two"}))
            assert len(factory.socket.events("response.create")) == 2
            assert len([event for event in factory.socket.events("conversation.item.create")
                        if event["item"]["type"] == "function_call_output"]) == 2
            await done(session, "response_2")
            assert len(factory.socket.events("response.create")) == 3
            await created(session, "response_3")
            assert await done(session, "response_3") == [{"kind": "interaction", "status": "IDLE"}]
    asyncio.run(run())


def test_results_before_response_created_reserve_one_generation():
    async def run():
        adapter, factory = provider()
        async with adapter.connect() as session:
            await created(session)
            await done(session, output=[call("a"), call("b")])
            await session.send_tool_result("a", "research_run", {"summary": "first"})
            await session.send_tool_result("b", "research_run", {"summary": "second"})
            assert len(factory.socket.events("response.create")) == 1
            await created(session, "response_2")
            await done(session, "response_2")
            assert len(factory.socket.events("response.create")) == 2
    asyncio.run(run())


def test_tool_argument_completion_never_dispatches_without_completed_response():
    async def run():
        for terminal in ("cancelled", "incomplete", "failed"):
            adapter, _ = provider()
            async with adapter.connect() as session:
                await created(session)
                item = call()
                args_event = {**item, "type": "response.function_call_arguments.done", "response_id": "response_1"}
                assert not any(event["kind"] == "tool_call" for event in await session._handle(args_event))
                assert not any(event["kind"] == "tool_call" for event in await session._handle({
                    "type": "response.output_item.done", "response_id": "response_1", "item": item}))
                assert not any(event["kind"] == "tool_call" for event in await done(session, output=[item], status=terminal))
                assert not session._calls and not session._staged
                if terminal == "cancelled":
                    assert await session._handle(audio()) == []
        adapter, _ = provider()
        async with adapter.connect() as session:
            await created(session)
            item = call()
            await session._handle({**item, "type": "response.function_call_arguments.done", "response_id": "response_1"})
            assert not any(event["kind"] == "tool_call" for event in await done(session))
    asyncio.run(run())


def test_completed_tool_ids_and_results_are_idempotent_but_conflicts_rejected():
    async def run():
        adapter, factory = provider()
        async with adapter.connect() as session:
            await created(session)
            item = call()
            assert sum(event["kind"] == "tool_call" for event in await done(session, output=[item, item])) == 1
            assert await done(session, output=[item]) == []
            with pytest.raises(ValueError, match="Unknown"):
                await session.send_tool_result("missing", "research_run", {})
            with pytest.raises(ValueError, match="Unknown"):
                await session.send_tool_result("call_1", "report_save", {})
            await session.send_tool_result("call_1", "research_run", {"summary": "once"})
            await session.send_tool_result("call_1", "research_run", {"summary": "once"})
            outputs = [event for event in factory.socket.events("conversation.item.create") if event["item"]["type"] == "function_call_output"]
            assert len(outputs) == 1
            with pytest.raises(ValueError, match="Conflicting"):
                await session.send_tool_result("call_1", "research_run", {"summary": "changed"})
            await created(session, "response_2")
            assert not any(event["kind"] == "tool_call" for event in await done(session, "response_2", output=[item]))
            await created(session, "response_3")
            with pytest.raises(OpenAIProviderError):
                await done(session, "response_3", output=[call(args={"query": "changed"})])
    asyncio.run(run())


@pytest.mark.parametrize("prefix,role,done_name,field", [
    ("response.output_audio_transcript", "assistant", "done", "transcript"),
    ("response.output_text", "assistant", "done", "text"),
    ("conversation.item.input_audio_transcription", "user", "completed", "transcript"),
])
def test_transcript_delta_full_done_and_done_only_normalization(prefix, role, done_name, field):
    async def run():
        adapter, _ = provider()
        async with adapter.connect() as session:
            await created(session)
            fields = {"item_id": "spoken_1", "content_index": 0, "response_id": "response_1"}
            events = []
            events.extend(await session._handle({**fields, "type": prefix + ".delta", "delta": "Hello "}))
            events.extend(await session._handle({**fields, "type": prefix + ".delta", "delta": "there"}))
            events.extend(await session._handle({**fields, "type": prefix + "." + done_name, field: "Hello there!"}))
            assert "".join(event["text"] for event in events) == "Hello there!"
            assert [event["finished"] for event in events] == [False, False, True]
            assert all(event["role"] == role and event["turnId"] == "spoken_1" for event in events)
            assert await session._handle({**fields, "type": prefix + "." + done_name, field: "Hello there!"}) == []
            fields["item_id"] = "spoken_2"
            events = await session._handle({**fields, "type": prefix + "." + done_name, field: "Done only"})
            assert events[0]["text"] == "Done only" and events[0]["finished"]
            fields["item_id"] = "spoken_3"
            await session._handle({**fields, "type": prefix + ".delta", "delta": "Identical"})
            events = await session._handle({**fields, "type": prefix + "." + done_name, field: "Identical"})
            assert events[0]["text"] == "" and events[0]["finished"]
    asyncio.run(run())


def test_interruption_cancels_matching_response_truncates_and_drops_late_audio():
    async def run():
        adapter, factory = provider()
        async with adapter.connect() as session:
            await created(session)
            await session._handle(audio(size=9600))
            events = await session._handle({"type": "input_audio_buffer.speech_started"})
            assert {"kind": "interrupted"} in events
            assert factory.socket.events("response.cancel") == [{"type": "response.cancel", "response_id": "response_1"}]
            await session.interrupt("audio_1", 0, 80)
            await session.interrupt("audio_1", 0, 100)
            assert len(factory.socket.events("response.cancel")) == 1
            assert factory.socket.events("conversation.item.truncate") == [{"type": "conversation.item.truncate", "item_id": "audio_1", "content_index": 0, "audio_end_ms": 80}]
            assert await session._handle(audio()) == []
            assert await session._handle({"type": "response.output_audio_transcript.delta", "response_id": "response_1", "item_id": "audio_1", "content_index": 0, "delta": "unplayed"}) == []
            assert not any(event["kind"] == "tool_call" for event in await done(session, output=[call()]))
            await session._handle({"type": "input_audio_buffer.committed", "item_id": "user_1"})
            assert len(factory.socket.events("response.create")) == 1
    asyncio.run(run())


def test_invalid_playback_receipt_cannot_cancel_or_truncate_new_response():
    async def run():
        adapter, factory = provider()
        async with adapter.connect() as session:
            await created(session)
            await session._handle(audio())
            await done(session)
            await created(session, "response_2")
            for item_id, index, ms in [("forged", 0, 0), ("audio_1", 1, 0), ("audio_1", 0, 101),
                                       ("audio_1", 0, -1), ("audio_1", False, 0), ("audio_1", 0, True)]:
                with pytest.raises(ValueError):
                    await session.interrupt(item_id, index, ms)
            assert not factory.socket.events("response.cancel")
            assert not factory.socket.events("conversation.item.truncate")
            await session.interrupt("audio_1", 0, 50)
            assert not factory.socket.events("response.cancel")  # Old playback must not cancel response_2.
            assert (await session._handle(audio("response_2", "audio_2")))[0]["kind"] == "audio"
    asyncio.run(run())


def test_speech_before_response_created_cancels_only_after_id_known():
    async def run():
        adapter, factory = provider()
        async with adapter.connect() as session:
            await session.send_text("Explain")
            await session._handle({"type": "input_audio_buffer.speech_started"})
            assert not factory.socket.events("response.cancel")
            await created(session)
            assert factory.socket.events("response.cancel") == [{"type": "response.cancel", "response_id": "response_1"}]
            assert await session._handle(audio()) == []
    asyncio.run(run())


def test_receive_stream_runs_while_two_tools_wait_and_sanitizes_terminal_error():
    async def run():
        socket = FakeSocket()
        adapter, _ = provider(socket)
        async with adapter.connect() as session:
            stream = session.receive()
            socket.push({"type": "response.created", "response": {"id": "response_1"}})
            assert (await anext(stream))["status"] == "IN_PROGRESS"
            socket.push(audio())
            assert (await anext(stream))["kind"] == "audio"
            socket.push({"type": "response.done", "response": {"id": "response_1", "status": "completed", "output": [call("a"), call("b")]}})
            assert (await anext(stream))["id"] == "a"
            assert (await anext(stream))["id"] == "b"
            socket.push({"type": "response.created", "response": {"id": "response_2"}})
            socket.push(audio("response_2", "audio_2"))
            assert (await asyncio.wait_for(anext(stream), .5))["itemId"] == "audio_2"
            assert all(item["output"] is None for item in session._calls.values())
            socket.push({"type": "error", "error": {"code": "invalid_api_key", "message": "secret patient prompt"}})
            event = await anext(stream)
            assert event["kind"] == "error" and event["code"] == "provider_auth"
            assert "secret" not in json.dumps(event) and "patient" not in json.dumps(event)
            with pytest.raises(OpenAIProviderError):
                await anext(stream)
    asyncio.run(run())


def test_rejected_item_id_is_reported_as_safe_configuration_error():
    async def run():
        socket = FakeSocket()
        adapter, _ = provider(socket)
        async with adapter.connect() as session:
            socket.push({"type": "error", "error": {
                "code": "string_above_max_length", "type": "invalid_request_error", "param": "item.id",
                "message": "private request details must not leave the provider boundary"}})
            stream = session.receive()
            event = await anext(stream)
            assert event["kind"] == "error" and event["code"] == "provider_configuration"
            assert "private" not in event["message"] and "item.id" not in event["message"]
            with pytest.raises(OpenAIProviderError):
                await anext(stream)
    asyncio.run(run())


def test_failed_result_write_is_never_replayed_and_connection_is_closed():
    async def run():
        socket = FakeSocket()
        adapter, _ = provider(socket)
        async with adapter.connect() as session:
            await created(session)
            await done(session, output=[call()])
            socket.fail_send = "conversation.item.create"
            with pytest.raises(OpenAIProviderError) as error:
                await session.send_tool_result("call_1", "research_run", {"summary": "already saved"})
            assert "secret" not in str(error.value) and session._closed and socket.closed
            with pytest.raises(OpenAIProviderError):
                await session.send_tool_result("call_1", "research_run", {"summary": "already saved"})
            assert len(socket.events("conversation.item.create")) == 1
            assert not socket.events("response.create")
    asyncio.run(run())


def test_receive_cancellation_and_context_exit_clear_private_buffers():
    async def run():
        adapter, factory = provider()
        async with adapter.connect() as session:
            await created(session)
            await session._handle(audio())
            stream = session.receive()
            task = asyncio.create_task(anext(stream))
            await asyncio.sleep(0)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        assert factory.socket.closed == 1
        assert not session._audio and not session._transcripts and not session._responses
    asyncio.run(run())


def test_write_failure_while_receive_is_yielded_terminates_with_safe_error():
    async def run():
        socket = FakeSocket()
        adapter, _ = provider(socket)
        async with adapter.connect() as session:
            stream = session.receive()
            socket.push({"type": "response.created", "response": {"id": "response_1"}})
            assert (await anext(stream))["status"] == "IN_PROGRESS"
            socket.fail_send = "input_audio_buffer.append"
            with pytest.raises(OpenAIProviderError):
                await session.send_audio(b"\0\0")
            assert (await anext(stream))["kind"] == "error"
            with pytest.raises(OpenAIProviderError):
                await anext(stream)
            second = session.receive()
            assert (await anext(second))["kind"] == "error"
            with pytest.raises(OpenAIProviderError):
                await anext(second)
    asyncio.run(run())


def test_bounded_input_and_malformed_provider_media_fail_without_raw_data():
    async def run():
        adapter, factory = provider()
        async with adapter.connect() as session:
            for data in (b"", b"x", b"xx" * 12001):
                with pytest.raises(ValueError):
                    await session.send_audio(data)
            with pytest.raises(ValueError):
                await session.send_image(b"secret", "image/png")
            with pytest.raises(ValueError):
                await session.send_text("x" * 32001)
            await created(session)
            for delta in ("invalid-base64-secret", "YQ=="):
                event = audio()
                event["delta"] = delta
                with pytest.raises(OpenAIProviderError) as error:
                    await session._handle(event)
                assert "secret" not in str(error.value)
            stream = session.receive()
            factory.socket.push("{private-invalid-json")
            event = await anext(stream)
            assert event["code"] == "provider_protocol" and "private" not in event["message"]
            with pytest.raises(OpenAIProviderError):
                await anext(stream)
    asyncio.run(run())


def test_unknown_reasoning_events_are_not_returned_and_call_limits_fail_closed(monkeypatch):
    async def run():
        adapter, _ = provider()
        async with adapter.connect() as session:
            await created(session)
            assert await session._handle({"type": "response.reasoning.delta", "delta": "private reasoning"}) == []
            with pytest.raises(OpenAIProviderError) as error:
                await done(session, output=[call("call_" + str(index)) for index in range(17)])
            assert error.value.code == "provider_limit"
        adapter, _ = provider()
        async with adapter.connect() as session:
            monkeypatch.setattr(ai_openai, "MAX_TRACKED_ITEMS", 1)
            await created(session)
            await done(session)
            with pytest.raises(OpenAIProviderError) as error:
                await created(session, "response_2")
            assert error.value.code == "provider_limit"
    asyncio.run(run())
