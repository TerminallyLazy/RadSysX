"""Provider selection, frozen session identity and the shared authority boundary."""
import asyncio
import json
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from backend.clinical.ai_config import AISettings
from backend.clinical.ai_live import LiveRuntime, provider_failure
from backend.clinical.contracts import AILiveContextUpdate, AISidebarSessionCreateRequest
from backend.tests.test_ai_live import (CONTEXT, ORIGIN, PREFIX, FakeSocket, authorize,
                                       create_http, live, wait_until)


class OpenAITransportFixture:
    def __init__(self):
        self.messages = asyncio.Queue()
        self.send_audio = AsyncMock()
        self.send_image = AsyncMock()
        self.end_audio = AsyncMock()
        self.send_context = AsyncMock()
        self.send_tool_result = AsyncMock()
        self.interrupt = AsyncMock()
        self.closed = 0
        self.handles = []

    @asynccontextmanager
    async def connect(self, handle=None):
        self.handles.append(handle)
        try:
            yield self
        finally:
            self.closed += 1

    async def receive(self):
        while True:
            event = await self.messages.get()
            if isinstance(event, Exception):
                raise event
            yield event

    async def send_text(self, text):
        await self.messages.put({"kind": "interaction", "status": "IN_PROGRESS"})
        await self.messages.put({"kind": "audio", "data": b"\0\0" * 240,
                                 "itemId": "item_fixture", "contentIndex": 0})
        await self.messages.put({"kind": "transcript", "role": "assistant", "text": "Synthetic OpenAI response.",
                                 "finished": True, "turnId": "turn-fixture"})
        await self.messages.put({"kind": "interaction", "status": "IDLE"})


@pytest.fixture
def selected(live, monkeypatch):
    monkeypatch.setattr(live.service.config, "openai_api_key", "synthetic-openai-key")
    monkeypatch.setattr(live.service.config, "readiness", lambda provider_id="gemini": ("configured", "Synthetic provider."))
    provider = OpenAITransportFixture()
    live.service.openai_provider_factory = lambda: provider
    return live, provider


def openai_runtime(selected):
    env, provider = selected
    row = env.service.create(AISidebarSessionCreateRequest(providerId="openai", viewerContext=CONTEXT,
                                                           attestation="synthetic"), env.actor)
    runtime = LiveRuntime(env.service, row["sessionId"], env.actor)
    runtime.provider, runtime.websocket = provider, FakeSocket()
    runtime.provider_ready = True
    env.service.runtimes[runtime.id] = runtime
    return runtime


def test_exact_catalog_independent_readiness_and_no_credentials(live, monkeypatch):
    monkeypatch.setattr(live.service.config, "api_key", "")
    monkeypatch.setattr(live.service.config, "openai_api_key", "SECRET_OPENAI_FIXTURE")
    monkeypatch.setattr("importlib.metadata.version", lambda name: "16.1.1" if name == "websockets" else "2.24.0")
    with TestClient(live.app) as client:
        authorize(client, live)
        payload = client.get(PREFIX + "/capabilities").json()
        assert payload["defaultProviderId"] == "gemini"
        profiles = {p["id"]: p for p in payload["providers"]}
        assert profiles["gemini"]["availability"] == "unavailable"
        assert profiles["openai"]["availability"] == "configured"
        assert profiles["openai"]["modelId"] == "gpt-realtime-2.1-mini"
        assert profiles["openai"]["inputSampleRate"] == 24000
        assert "SECRET_OPENAI_FIXTURE" not in json.dumps(payload)
        row = create_http(client, providerId="openai")
        assert row["providerId"] == "openai" and row["status"] == "allocated"


def test_unknown_provider_rejected_and_provider_cannot_change_in_place(selected):
    env, _ = selected
    with TestClient(env.app) as client:
        authorize(client, env)
        assert client.post(PREFIX + "/sessions", json={"providerId": "arbitrary", "attestation": "synthetic"}).status_code == 422
        row = create_http(client, providerId="openai")
        path = PREFIX + "/sessions/" + row["sessionId"]
        request = {"contextVersion": 1, "viewerContext": CONTEXT, "providerId": "gemini"}
        assert client.post(path + "/context", json=request).status_code == 409
        del request["providerId"]
        assert client.post(path + "/context", json=request).json()["providerId"] == "openai"
        env.service.repository.recover()
        restored = client.get(path).json()["session"]
        assert restored["modelId"] == "gpt-realtime-2.1-mini"
        assert restored["providerId"] == "openai" and restored["inputSampleRate"] == 24000
        assert restored["attestation"] is None and restored["status"] == "interrupted"


def test_openai_socket_uses_selected_transport_and_transient_audio_marker(selected):
    env, provider = selected
    with TestClient(env.app) as client:
        authorize(client, env)
        row = create_http(client, providerId="openai")
        with client.websocket_connect(row["liveUrl"], headers={"origin": ORIGIN}) as socket:
            assert socket.receive_json()["status"] == "connecting"
            assert socket.receive_json()["status"] == "ready"
            socket.send_json({"kind": "text", "contextVersion": 1, "text": "Synthetic test."})
            assert socket.receive_json()["role"] == "user"
            assert socket.receive_json()["status"] == "IN_PROGRESS"
            marker = socket.receive_json()
            assert marker["kind"] == "audio_chunk" and marker["itemId"] == "item_fixture"
            assert socket.receive_bytes() == b"\0\0" * 240
            assert socket.receive_json()["text"] == "Synthetic OpenAI response."
            assert socket.receive_json()["status"] == "IDLE"
        history = client.get(PREFIX + "/sessions/" + row["sessionId"]).json()
        assert all(e["kind"] != "audio_chunk" for e in history["events"])
        assert env.provider.handles == []
        assert provider.handles == [None]


def test_openai_media_and_playback_are_context_bound(selected):
    async def scenario():
        runtime = openai_runtime(selected)
        provider = selected[1]
        await runtime.receive_audio(b"\0\0" * 480)
        provider.send_audio.assert_awaited_once_with(b"\0\0" * 480)
        await runtime.receive_control({"kind": "playback_stop", "contextVersion": 1,
                                       "itemId": "item_fixture", "contentIndex": 0, "audioEndMs": 17})
        provider.interrupt.assert_awaited_once_with("item_fixture", 0, 17)
        with pytest.raises(HTTPException):
            await runtime.receive_control({"kind": "playback_stop", "contextVersion": 2,
                                           "itemId": "item_fixture", "contentIndex": 0, "audioEndMs": 17})
        with pytest.raises(ValueError):
            await runtime.receive_control({"kind": "playback_stop", "contextVersion": 1,
                                           "itemId": "item_fixture", "contentIndex": 0, "audioEndMs": -1})
    asyncio.run(scenario())


def test_openai_tools_reuse_governed_idempotency_and_approval(selected):
    async def scenario():
        runtime = openai_runtime(selected)
        provider = selected[1]
        call = {"kind": "tool_call", "id": "openai-read", "name": "viewer_get_state", "args": {}}
        await runtime.handle_provider(call)
        await wait_until(lambda: "openai-read" not in runtime.tasks)
        await runtime.handle_provider(call)
        assert len(runtime.repo.history(runtime.id, runtime.actor)["tools"]) == 1
        assert provider.send_tool_result.await_count == 2
        await runtime.handle_provider({"kind": "tool_call", "id": "save-report", "name": "report_save",
                                       "args": {"findings": "Synthetic", "impression": "Draft"}})
        assert runtime.repo.tool(runtime.id, "save-report")["status"] == "awaiting_approval"
        assert "save-report" not in runtime.tasks
        await runtime.handle_provider({"kind": "interrupted"})
        assert runtime.repo.tool(runtime.id, "save-report")["status"] == "awaiting_approval"
        await runtime.cancel_all()
    asyncio.run(scenario())


@pytest.mark.parametrize("provider_id", ["gemini", "openai"])
def test_both_cloud_providers_disabled_in_clinical_mode(live, provider_id):
    settings = AISettings("clinical")
    assert settings.readiness(provider_id)[0] == "disabled"


def test_openai_error_category_does_not_disclose_provider_payload():
    error = RuntimeError("insufficient_quota key=SECRET https://private-host")
    code, message = provider_failure(error, "openai")
    assert code == "provider_quota"
    assert "SECRET" not in message and "private-host" not in message
