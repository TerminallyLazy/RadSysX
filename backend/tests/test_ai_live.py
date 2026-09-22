"""Synthetic, isolated Live broker regression tests; no cloud or device access."""

import asyncio
import base64
import json
import os
import subprocess
import sys
from contextlib import asynccontextmanager
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from google.genai import types
from starlette.websockets import WebSocketDisconnect

from backend.clinical import ai_config
from backend.clinical.ai_live import AILiveService, LiveRuntime, provider_failure
from backend.clinical.ai_provider import GeminiLiveProvider
from backend.clinical.ai_repository import AILiveRepository
from backend.clinical.ai_routes import live_router
from backend.clinical.auth import ClinicalSessionManager
from backend.clinical.config import ClinicalPlatformSettings
from backend.clinical.contracts import (
    AILiveContextUpdate,
    AILiveDecision,
    AISidebarSessionCreateRequest,
    to_iso_z,
    utc_now,
)
from backend.clinical.repositories import ClinicalRepository
from backend.clinical.services import ClinicalPlatformService


ORIGIN = "http://testserver"
PREFIX = "/api/ai/sidebar"
CONTEXT = {
    "targetId": "synthetic-viewport",
    "route": "/viewer/local",
    "privacyClass": "deidentified",
    "state": {"activeViewportId": "viewport-1", "layout": {"rows": 1, "columns": 1}},
}


class FakeProvider:
    def __init__(self):
        self.setup_complete = types.LiveServerSetupComplete()
        self.messages = asyncio.Queue()
        self.receive_calls = 0
        self.contexts = []
        self.inputs = []
        self.responses = []
        self.handles = []
        self.closed = 0

    @asynccontextmanager
    async def connect(self, handle=None):
        self.handles.append(handle)
        try:
            yield self
        finally:
            self.closed += 1

    async def receive(self):
        self.receive_calls += 1
        message = await self.messages.get()
        if isinstance(message, Exception):
            raise message
        yield message

    async def send_client_content(self, **kwargs):
        self.contexts.append(kwargs)

    async def send_realtime_input(self, **kwargs):
        self.inputs.append(kwargs)
        if "text" in kwargs:
            await self.messages.put(types.LiveServerMessage(server_content=types.LiveServerContent(
                model_turn=types.Content(parts=[types.Part(inline_data=types.Blob(data=b"\x00\x01\x02\x03", mime_type="audio/pcm;rate=24000"))]),
                output_transcription=types.Transcription(text="Synthetic reply.", finished=True),
                interaction_status="IDLE",
            )))

    async def send_tool_response(self, **kwargs):
        self.responses.extend(kwargs["function_responses"])


class FakeSocket:
    def __init__(self):
        self.events = []
        self.audio = []
        self.closed = False

    async def send_json(self, event):
        self.events.append(event)

    async def send_bytes(self, data):
        self.audio.append(data)

    async def close(self, **kwargs):
        self.closed = True


@pytest.fixture
def live(tmp_path, monkeypatch):
    # Do not read the owner's .env.ai or depend on process-global server fixtures.
    import dotenv
    monkeypatch.setattr(dotenv, "dotenv_values", lambda *args, **kwargs: {})
    monkeypatch.setenv("RADSYSX_GEMINI_API_KEY", "synthetic-not-a-real-key")
    monkeypatch.setenv("RADSYSX_RESEARCH_PROVIDER", "gemini")
    monkeypatch.delenv("RADSYSX_NVIDIA_API_KEY", raising=False)
    monkeypatch.delenv("RADSYSX_TYPESAFE_AI_API_KEY", raising=False)
    monkeypatch.setenv("RADSYSX_AI_EVIDENCE_DIR", str(tmp_path / ".ai-evidence"))
    monkeypatch.setenv("RADSYSX_AI_ENABLED", "true")
    monkeypatch.setenv("RADSYSX_APP_MODE", "pilot")
    monkeypatch.setenv("RADSYSX_CLINICAL_API_SECRET", "synthetic-clinical-test-signing-secret")
    monkeypatch.setenv("RADSYSX_SESSION_SECRET", "synthetic-session-test-signing-secret")
    monkeypatch.setenv("RADSYSX_SESSION_COOKIE_SECURE", "false")
    monkeypatch.setenv("RADSYSX_ALLOWED_ORIGINS", ORIGIN)
    monkeypatch.setenv("RADSYSX_VIEWER_BASE_URL", ORIGIN + "/viewer")
    monkeypatch.setattr(ai_config.importlib.metadata, "version", lambda name: "2.24.0")
    settings = ClinicalPlatformSettings()
    repository = ClinicalRepository(f"sqlite:///{tmp_path / 'live.db'}")
    repository.initialize()
    clinical = ClinicalPlatformService(settings, repository, None)
    service = AILiveService(clinical, repository, settings)
    manager = ClinicalSessionManager(settings)
    provider = FakeProvider()
    service.provider_factory = lambda: provider

    @asynccontextmanager
    async def lifespan(app):
        yield
        await service.shutdown()

    app = FastAPI(lifespan=lifespan)
    app.include_router(live_router(service, manager))
    result = SimpleNamespace(service=service, repository=repository, manager=manager,
                             provider=provider, app=app,
                             actor=manager.issue_for_username("demo-radiologist"))
    yield result
    repository._engine.dispose()


def authorize(client, live, actor=None):
    client.cookies.set(live.manager.cookie_name, live.manager.dumps(actor or live.actor))


def create_http(client, **overrides):
    body = {"viewerContext": CONTEXT, "attestation": "synthetic", **overrides}
    response = client.post(PREFIX + "/sessions", json=body, headers={"origin": ORIGIN})
    assert response.status_code == 200, response.text
    return response.json()


def runtime_for(live, *, context=None, actor=None):
    actor = actor or live.actor
    row = live.service.create(AISidebarSessionCreateRequest.model_validate({
        "viewerContext": context or CONTEXT, "attestation": "synthetic",
    }), actor)
    runtime = LiveRuntime(live.service, row["sessionId"], actor)
    runtime.provider = live.provider
    runtime.provider_ready = True
    runtime.websocket = FakeSocket()
    live.service.runtimes[runtime.id] = runtime
    return runtime


async def drain_tools(runtime):
    if runtime.tasks:
        await asyncio.wait_for(asyncio.gather(*list(runtime.tasks.values())), 2)


async def wait_until(predicate):
    async with asyncio.timeout(2):
        while not predicate():
            await asyncio.sleep(.001)


def call(name, identifier="call-1", **args):
    return types.FunctionCall(id=identifier, name=name, args=args)


def test_http_auth_scope_owner_origin_and_retired_stub(live):
    with TestClient(live.app) as client:
        assert client.get(PREFIX + "/capabilities").status_code == 401
        authorize(client, live, live.manager.issue_for_username("qa-reviewer"))
        assert client.get(PREFIX + "/capabilities").status_code == 403
        authorize(client, live)
        assert client.post(PREFIX + "/sessions", json={}, headers={"origin": "https://untrusted.example"}).status_code == 403
        session = create_http(client)
        identifier = session["sessionId"]
        assert client.post(f"{PREFIX}/sessions/{identifier}/messages", json={"message": "test"}).status_code == 409
        assert "synthetic-not-a-real-key" not in json.dumps(session)
        authorize(client, live, live.manager.issue_for_username("attending-radiologist"))
        assert client.get(f"{PREFIX}/sessions/{identifier}").status_code == 404
        assert client.post(f"{PREFIX}/sessions/{identifier}/close").status_code == 404
        assert client.delete(f"{PREFIX}/sessions/{identifier}").status_code == 404
        assert client.get(PREFIX + "/sessions").json() == {"sessions": []}


@pytest.mark.parametrize("problem,expected", [("no-cookie", 4401), ("expired", 4401), ("wrong-owner", 4403), ("no-scope", 4403), ("no-origin", 4403), ("wrong-origin", 4403), ("no-attestation", 4403)])
def test_websocket_requires_cookie_owner_scope_origin_attestation(live, problem, expected):
    with TestClient(live.app) as client:
        authorize(client, live)
        row = create_http(client, attestation=None if problem == "no-attestation" else "synthetic")
        headers = {"origin": ORIGIN}
        if problem == "no-cookie":
            client.cookies.clear()
        elif problem == "expired":
            authorize(client, live, live.actor.model_copy(update={"expires_at": to_iso_z(utc_now() - timedelta(seconds=1))}))
        elif problem == "wrong-owner":
            authorize(client, live, live.manager.issue_for_username("attending-radiologist"))
        elif problem == "no-scope":
            authorize(client, live, live.manager.issue_for_username("qa-reviewer"))
        elif problem == "no-origin":
            headers = {}
        elif problem == "wrong-origin":
            headers = {"origin": "https://untrusted.example"}
        with pytest.raises(WebSocketDisconnect) as error:
            with client.websocket_connect(row["liveUrl"], headers=headers):
                pass
        assert error.value.code == expected
        assert live.provider.handles == []


@pytest.mark.parametrize("mode,key,availability", [("pilot", "", "unavailable"), ("clinical", "synthetic-key", "disabled")])
def test_no_key_or_clinical_mode_never_claims_ready_or_connects(live, mode, key, availability):
    live.service.config.api_key = key
    live.service.config.app_mode = mode
    with TestClient(live.app) as client:
        authorize(client, live)
        caps = client.get(PREFIX + "/capabilities").json()
        assert caps["availability"] == availability
        assert all(lane["status"] == "disabled" for lane in caps["modelLanes"])
        row = create_http(client)
        assert row["status"] == "unavailable"
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(row["liveUrl"], headers={"origin": ORIGIN}):
                pass
        assert not live.provider.handles


def test_phi_bearing_attestation_is_rejected(live):
    with TestClient(live.app) as client:
        authorize(client, live)
        response = client.post(PREFIX + "/sessions", json={"viewerContext": {**CONTEXT, "privacyClass": "phi-bearing"}, "attestation": "deidentified"})
        assert response.status_code == 400
        assert not live.provider.handles


def test_real_websocket_text_audio_and_repeated_receive_after_idle(live):
    with TestClient(live.app) as client:
        authorize(client, live)
        row = create_http(client)
        with client.websocket_connect(row["liveUrl"], headers={"origin": ORIGIN}) as websocket:
            assert websocket.receive_json()["status"] == "connecting"
            assert websocket.receive_json()["status"] == "ready"
            for text in ("Synthetic question one", "Synthetic question two"):
                websocket.send_json({"kind": "text", "text": text, "contextVersion": 1})
                assert websocket.receive_json()["text"] == text
                assert websocket.receive_bytes() == b"\x00\x01\x02\x03"
                transcript = websocket.receive_json()
                assert transcript["text"] == "Synthetic reply." and transcript["finished"]
                assert websocket.receive_json()["status"] == "IDLE"
            websocket.send_json({"kind": "ping", "contextVersion": 1})
            assert websocket.receive_json()["kind"] == "pong"
        history = client.get(f"{PREFIX}/sessions/{row['sessionId']}").json()
        assert len([e for e in history["events"] if e["kind"] == "transcript"]) == 4
        assert not any(e["kind"] in {"audio", "pong"} for e in history["events"])
    assert live.provider.receive_calls >= 2
    assert live.provider.closed == 1


def test_exact_live_config_uses_nonblocking_tools_low_thinking_and_handle_only(live):
    config = GeminiLiveProvider(live.service.config).config("opaque-resumption")
    assert config.response_modalities == [types.Modality.AUDIO]
    assert config.thinking_config.thinking_level == types.ThinkingLevel.LOW
    assert config.input_audio_transcription is not None
    assert config.output_audio_transcription is not None
    assert config.session_resumption.handle == "opaque-resumption"
    assert config.session_resumption.transparent is None
    assert config.context_window_compression.sliding_window is not None
    assert config.tools[0].google_search is not None
    assert all(tool.behavior == types.Behavior.NON_BLOCKING for tool in config.tools[1].function_declarations)
    assert "execute" not in {tool.name for tool in config.tools[1].function_declarations}


def test_provider_requires_setup_complete_and_closes_client(live, monkeypatch):
    from google import genai
    async def scenario():
        connector = Mock(side_effect=lambda **kwargs: live.provider.connect())
        close = AsyncMock()
        constructor = Mock(return_value=SimpleNamespace(aio=SimpleNamespace(live=SimpleNamespace(connect=connector), aclose=close)))
        monkeypatch.setattr(genai, "Client", constructor)
        async with GeminiLiveProvider(live.service.config).connect() as session:
            assert session is live.provider
        kwargs = constructor.call_args.kwargs
        assert kwargs["api_key"] == "synthetic-not-a-real-key"
        assert kwargs["enterprise"] is False
        assert kwargs["http_options"].api_version == "v1beta"
        assert connector.call_args.kwargs["model"] == "gemini-3.8-live-extended-thinking"
        close.assert_awaited_once()
        live.provider.setup_complete = None
        with pytest.raises(ConnectionError):
            async with GeminiLiveProvider(live.service.config).connect():
                pass
        assert close.await_count == 2
    asyncio.run(scenario())


def test_all_provider_parts_nested_status_transcript_finish_and_private_data(live):
    async def scenario():
        runtime = runtime_for(live)
        original_user_turn = runtime.turn_ids["user"]
        message = types.LiveServerMessage(
            server_content=types.LiveServerContent(
                interrupted=True,
                model_turn=types.Content(parts=[
                    types.Part(text="PRIVATE-THOUGHT-MARKER", thought=True),
                    types.Part(inline_data=types.Blob(data=b"AUDIO-ONE", mime_type="audio/pcm;rate=24000")),
                    types.Part(inline_data=types.Blob(data=b"PRIVATE-AUDIO", mime_type="audio/pcm;rate=24000"), thought=True),
                    types.Part(inline_data=types.Blob(data=b"AUDIO-TWO", mime_type="audio/pcm;rate=24000")),
                ]),
                input_transcription=types.Transcription(text="Synthetic input", finished=False),
                output_transcription=types.Transcription(text="Synthetic output", finished=True),
                interaction_status="IN_PROGRESS",
            ),
            session_resumption_update=types.LiveServerSessionResumptionUpdate(new_handle="PRIVATE-RESUME-HANDLE", resumable=True),
        )
        assert await runtime.handle_provider(message) is False
        assert runtime.websocket.audio == [b"AUDIO-ONE", b"AUDIO-TWO"]
        assert runtime.handle == "PRIVATE-RESUME-HANDLE"
        events = runtime.websocket.events
        assert [e["kind"] for e in events] == ["interrupted", "transcript", "transcript", "interaction"]
        assert events[1]["turnId"] != original_user_turn
        assert events[1]["finished"] is False
        assert events[2]["finished"] is True
        assert runtime.turn_ids["assistant"] != events[2]["turnId"]
        journal = json.dumps(runtime.repo.history(runtime.id, runtime.actor))
        for marker in ("PRIVATE", "AUDIO-ONE", "AUDIO-TWO"):
            assert marker not in journal
        await runtime.close("closed")
    asyncio.run(scenario())


def test_model_text_fallback_filters_thoughts_and_keeps_all_audio_parts(live):
    async def scenario():
        runtime = runtime_for(live)
        await runtime.handle_provider(types.LiveServerMessage(server_content=types.LiveServerContent(
            model_turn=types.Content(parts=[
                types.Part(text="PRIVATE-REASONING", thought=True),
                types.Part(text="A synthetic "),
                types.Part(text="text reply."),
            ]), turn_complete=True,
        )))
        transcripts = [e for e in runtime.websocket.events if e["kind"] == "transcript"]
        assert len(transcripts) == 1 and transcripts[0]["text"] == "A synthetic text reply."
        assert transcripts[0]["finished"] is True
        assert runtime.turn_ids["assistant"] != transcripts[0]["turnId"]
        await runtime.handle_provider(types.LiveServerMessage(server_content=types.LiveServerContent(
            model_turn=types.Content(parts=[
                types.Part(text="This duplicate model text must not appear."),
                types.Part(inline_data=types.Blob(data=b"PCM-ONE", mime_type="audio/pcm;rate=24000")),
                types.Part(text="PRIVATE-REASONING", thought=True),
                types.Part(inline_data=types.Blob(data=b"PCM-TWO", mime_type="audio/pcm;rate=24000")),
            ]),
            output_transcription=types.Transcription(text="Explicit synthetic transcript.", finished=True),
            turn_complete=True,
        )))
        transcripts = [e for e in runtime.websocket.events if e["kind"] == "transcript"]
        assert [e["text"] for e in transcripts] == ["A synthetic text reply.", "Explicit synthetic transcript."]
        assert runtime.websocket.audio == [b"PCM-ONE", b"PCM-TWO"]
        history = json.dumps(runtime.repo.history(runtime.id, runtime.actor))
        assert "PRIVATE-REASONING" not in history and "duplicate model text" not in history
        await runtime.close("closed")
    asyncio.run(scenario())


def test_interaction_identity_spans_utterances_and_rotates_only_after_idle(live):
    async def scenario():
        runtime = runtime_for(live)
        for text in ("Checking synthetic evidence.", "The synthetic research is ready."):
            await runtime.handle_provider(types.LiveServerMessage(server_content=types.LiveServerContent(
                interaction_status="IN_PROGRESS",
                output_transcription=types.Transcription(text=text, finished=True),
                turn_complete=True,
            )))
        first_events = list(runtime.websocket.events)
        first_interaction = first_events[0]["interactionId"]
        assert first_interaction and all(e["interactionId"] == first_interaction for e in first_events)
        utterances = [e for e in first_events if e["kind"] == "transcript"]
        assert utterances[0]["turnId"] != utterances[1]["turnId"]
        await runtime.handle_provider(types.LiveServerMessage(server_content=types.LiveServerContent(interaction_status="IDLE")))
        assert runtime.websocket.events[-1]["interactionId"] == first_interaction
        await runtime.handle_provider(types.LiveServerMessage(server_content=types.LiveServerContent(
            interaction_status="IN_PROGRESS",
            model_turn=types.Content(parts=[types.Part(text="A new synthetic task.")]),
            turn_complete=True,
        )))
        second_interaction = runtime.websocket.events[-1]["interactionId"]
        assert second_interaction != first_interaction
        assert runtime.websocket.events[-2]["interactionId"] == second_interaction
        history = runtime.repo.history(runtime.id, runtime.actor)
        assert {e["interactionId"] for e in history["events"]} == {first_interaction, second_interaction}
        await runtime.close("closed")
    asyncio.run(scenario())


def test_direct_backend_script_import_uses_clinical_fallback_without_network(tmp_path):
    # The normal `python backend/server.py` import path exposes backend/, not
    # the repository's parent package. Reproduce that path without starting ASGI.
    environment = {name: os.environ[name] for name in ("PATH", "SystemRoot", "WINDIR", "LANG", "LC_ALL") if name in os.environ}
    environment.update({
        "RADSYSX_APP_MODE": "pilot",
        "RADSYSX_CLINICAL_API_SECRET": "synthetic-direct-script-signing-secret",
        "RADSYSX_SESSION_SECRET": "synthetic-direct-script-session-secret",
        "RADSYSX_SESSION_COOKIE_SECURE": "false",
        "RADSYSX_CLINICAL_DATABASE_URL": f"sqlite:///{tmp_path / 'direct-import.db'}",
        "RADSYSX_AI_ENABLED": "false",
        "RADSYSX_GEMINI_API_KEY": "",
    })
    code = """
import json, pathlib, runpy, socket, sys
import dotenv
dotenv.dotenv_values = lambda *args, **kwargs: {}
def no_network(*args, **kwargs):
    raise AssertionError('Import must not contact a network service')
socket.socket.connect = no_network
module = runpy.run_path(str(pathlib.Path('server.py').resolve()), run_name='radsysx_direct_import_test')
service = module['ai_live_service']
assert 'backend' not in sys.modules
assert service.__class__.__module__ == 'clinical.ai_live'
assert service.config.api_key == ''
assert '/api/ai/sidebar/sessions' in module['app'].openapi()['paths']
assert 'deepagents' not in sys.modules and 'langchain_google_genai' not in sys.modules
assert 'google.genai' not in sys.modules
print(json.dumps({'availability': service.capabilities().availability, 'fallback': True}))
module['clinical_repository']._engine.dispose()
"""
    result = subprocess.run([sys.executable, "-s", "-c", code], cwd=Path(__file__).resolve().parents[1],
                            env=environment, text=True, capture_output=True, timeout=15)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout.strip().splitlines()[-1]) == {"availability": "disabled", "fallback": True}


def test_multiple_delayed_tools_do_not_block_audio_or_each_other(live, monkeypatch):
    from backend.clinical.ai_research import ResearchSupervisor
    async def scenario():
        started = []
        gates = {"one": asyncio.Event(), "two": asyncio.Event()}
        async def research(self, query, on_progress=None):
            started.append(query)
            await gates[query].wait()
            return {"summary": query, "sources": [], "limitations": []}
        monkeypatch.setattr(ResearchSupervisor, "run", research)
        runtime = runtime_for(live)
        await runtime.handle_provider(types.LiveServerMessage(tool_call=types.LiveServerToolCall(function_calls=[
            call("research_run", "one", query="one"), call("research_run", "two", query="two"),
        ])))
        await wait_until(lambda: len(started) == 2)
        await runtime.handle_provider(types.LiveServerMessage(server_content=types.LiveServerContent(
            model_turn=types.Content(parts=[types.Part(inline_data=types.Blob(data=b"FILLER", mime_type="audio/pcm;rate=24000"))]),
            interaction_status="IN_PROGRESS")))
        assert runtime.websocket.audio == [b"FILLER"] and not live.provider.responses
        gates["two"].set()
        await wait_until(lambda: bool(live.provider.responses))
        assert live.provider.responses[0].id == "two"
        assert runtime.repo.tool(runtime.id, "one")["status"] == "running"
        gates["one"].set()
        await drain_tools(runtime)
        assert [response.id for response in live.provider.responses] == ["two", "one"]
        await runtime.close("closed")
    asyncio.run(scenario())


def test_cancelled_research_cannot_publish_late_result(live, monkeypatch):
    from backend.clinical.ai_research import ResearchSupervisor
    async def scenario():
        cancelled = asyncio.Event()
        async def research(self, query, on_progress=None):
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()
        monkeypatch.setattr(ResearchSupervisor, "run", research)
        runtime = runtime_for(live)
        await runtime.schedule_tool(call("research_run", query="public synthetic question"))
        await wait_until(lambda: runtime.repo.tool(runtime.id, "call-1")["status"] == "running")
        await runtime.handle_provider(types.LiveServerMessage(tool_call_cancellation=types.LiveServerToolCallCancellation(ids=["call-1"])))
        assert cancelled.is_set()
        assert runtime.repo.tool(runtime.id, "call-1")["status"] == "cancelled"
        assert not runtime.tasks
        assert not live.provider.responses
        await runtime.close("closed")
    asyncio.run(scenario())


def test_renderer_ack_idempotency_and_conflicting_id_replay(live):
    async def scenario():
        runtime = runtime_for(live)
        action = call("viewer_set_layout", rows=2, columns=1)
        await runtime.schedule_tool(action)
        await wait_until(lambda: "call-1" in runtime.pending_actions)
        await runtime.schedule_tool(action)
        await runtime.receive_control({"kind": "action_result", "contextVersion": 1, "toolCallId": "call-1", "status": "completed", "result": {"applied": True, "patientName": "DO-NOT-RETAIN"}})
        await drain_tools(runtime)
        await runtime.schedule_tool(action)
        await runtime.schedule_tool(call("viewer_set_layout", rows=3, columns=1))
        assert len([e for e in runtime.websocket.events if e["kind"] == "viewer_action"]) == 1
        assert runtime.repo.tool(runtime.id, "call-1")["args"] == {"rows": 2, "columns": 1}
        assert "error" in live.provider.responses[-1].response
        assert "DO-NOT-RETAIN" not in json.dumps(runtime.repo.history(runtime.id, runtime.actor))
        with pytest.raises(ValueError):
            await runtime.receive_control({"kind": "action_result", "contextVersion": 1, "toolCallId": "call-1", "status": "completed"})
        await runtime.close("closed")
    asyncio.run(scenario())


def test_cancel_dispatched_renderer_action_records_unknown_outcome(live):
    async def scenario():
        runtime = runtime_for(live)
        await runtime.schedule_tool(call("viewer_set_layout", rows=2, columns=1))
        await wait_until(lambda: "call-1" in runtime.pending_actions)
        assert (await runtime.cancel("call-1"))["status"] == "outcome_unknown"
        assert not runtime.pending_actions and not runtime.tasks
        await runtime.schedule_tool(call("viewer_set_layout", rows=2, columns=1))
        assert len([e for e in runtime.websocket.events if e["kind"] == "viewer_action"]) == 1
        await runtime.close("closed")
    asyncio.run(scenario())


def test_cached_success_from_old_viewer_context_is_not_reused(live):
    async def scenario():
        runtime = runtime_for(live)
        await runtime.schedule_tool(call("viewer_get_state"))
        await drain_tools(runtime)
        assert runtime.repo.tool(runtime.id, "call-1")["status"] == "completed"
        await live.service.update_context(runtime.id, AILiveContextUpdate.model_validate({
            "contextVersion": 1, "viewerContext": {**CONTEXT, "targetId": "new-viewport"}, "attestation": "synthetic",
        }), runtime.actor)
        next_runtime = LiveRuntime(live.service, runtime.id, runtime.actor)
        next_runtime.provider = live.provider
        next_runtime.websocket = FakeSocket()
        await next_runtime.schedule_tool(call("viewer_get_state"))
        assert "error" in live.provider.responses[-1].response
        assert next_runtime.repo.tool(runtime.id, "call-1")["contextVersion"] == 1
        await next_runtime.close("closed")
    asyncio.run(scenario())


def test_context_change_cancels_actions_and_requires_new_attestation(live):
    async def scenario():
        runtime = runtime_for(live)
        await runtime.schedule_tool(call("viewer_measurement", operation="delete", measurementId="synthetic-measurement"))
        updated = await live.service.update_context(runtime.id, AILiveContextUpdate.model_validate({
            "contextVersion": 1, "viewerContext": {**CONTEXT, "targetId": "new-viewport"},
        }), runtime.actor)
        assert updated["contextVersion"] == 2 and updated["attestation"] is None
        assert runtime.closed and runtime.id not in live.service.runtimes
        assert runtime.repo.tool(runtime.id, "call-1")["status"] == "cancelled"
        with pytest.raises(HTTPException):
            await runtime.decide("call-1", AILiveDecision(contextVersion=1, approved=True))
        with pytest.raises(HTTPException):
            await live.service.update_context(runtime.id, AILiveContextUpdate(contextVersion=1,viewerContext=CONTEXT), runtime.actor)
    asyncio.run(scenario())


def test_concurrent_context_updates_cannot_share_new_version(live, monkeypatch):
    async def scenario():
        runtime = runtime_for(live)
        entered, release = asyncio.Event(), asyncio.Event()
        original_close = runtime.close
        async def delayed_close(status):
            entered.set()
            await release.wait()
            await original_close(status)
        monkeypatch.setattr(runtime, "close", delayed_close)
        def request(target):
            return AILiveContextUpdate.model_validate({"contextVersion": 1,
                "viewerContext": {**CONTEXT, "targetId": target}, "attestation": "synthetic"})
        first = asyncio.create_task(live.service.update_context(runtime.id, request("first"), runtime.actor))
        await entered.wait()
        second = asyncio.create_task(live.service.update_context(runtime.id, request("second"), runtime.actor))
        await asyncio.sleep(0)
        assert not second.done()
        release.set()
        first_result, second_result = await asyncio.wait_for(asyncio.gather(first, second, return_exceptions=True), 2)
        assert first_result["contextVersion"] == 2
        assert isinstance(second_result, HTTPException) and second_result.status_code == 409
        assert runtime.repo.get(runtime.id)["viewerContext"]["targetId"] == "first"
    asyncio.run(scenario())


def test_concurrent_websocket_accept_reserves_one_viewer(live, monkeypatch):
    async def scenario():
        runtime = runtime_for(live)
        runtime.websocket = None
        accepting, allow_accept, attached, release = (asyncio.Event() for _ in range(4))
        async def accept():
            accepting.set()
            await allow_accept.wait()
        async def hold_attachment(socket):
            attached.set()
            await release.wait()
        first_socket, second_socket = FakeSocket(), FakeSocket()
        first_socket.accept = accept
        second_socket.accept = AsyncMock()
        monkeypatch.setattr(runtime, "attach", hold_attachment)
        first = asyncio.create_task(live.service.attach(first_socket, runtime.id, runtime.actor))
        await accepting.wait()
        second = asyncio.create_task(live.service.attach(second_socket, runtime.id, runtime.actor))
        await asyncio.sleep(0)
        assert not second.done()
        allow_accept.set()
        await attached.wait()
        with pytest.raises(HTTPException) as error:
            await asyncio.wait_for(second, 2)
        assert error.value.status_code == 409
        second_socket.accept.assert_not_awaited()
        release.set()
        await first
        await runtime.close("closed")
    asyncio.run(scenario())


def test_logout_closes_active_session_beyond_history_listing_limit(live):
    async def scenario():
        runtime = runtime_for(live)
        for _ in range(100):
            live.service.repository.create(runtime.actor, CONTEXT, "synthetic", "allocated", live.service.config.model)
        assert runtime.id not in {row["sessionId"] for row in runtime.repo.list(runtime.actor)}
        await live.service.stop_owner(runtime.actor)
        assert runtime.closed and runtime.id not in live.service.runtimes
        assert runtime.repo.get(runtime.id)["attestation"] is None
        assert runtime.repo.active_sessions(runtime.actor) == []
    asyncio.run(scenario())


def test_state_update_keeps_binding_but_phi_update_revokes_attestation(live):
    async def scenario():
        runtime = runtime_for(live)
        updated = await live.service.update_context(runtime.id, AILiveContextUpdate.model_validate({
            "contextVersion": 1, "viewerContext": {**CONTEXT, "state": {"imageIndex": 10}},
        }), runtime.actor)
        assert updated["contextVersion"] == 1 and updated["attestation"] == "synthetic"
        assert live.provider.contexts
        updated = await live.service.update_context(runtime.id, AILiveContextUpdate.model_validate({
            "contextVersion": 1, "viewerContext": {**CONTEXT, "privacyClass": "phi-bearing"}, "attestation": "synthetic",
        }), runtime.actor)
        assert updated["attestation"] is None and updated["contextVersion"] == 2
        assert runtime.closed
    asyncio.run(scenario())


@pytest.mark.parametrize('privacy_class', ['unknown', 'local-only'])
def test_privacy_class_change_requires_fresh_attestation(live, privacy_class):
    async def scenario():
        runtime=runtime_for(live)
        updated=await live.service.update_context(runtime.id,AILiveContextUpdate.model_validate({
            'contextVersion':1,'viewerContext':{**CONTEXT,'privacyClass':privacy_class}}),live.actor)
        assert updated['attestation'] is None
        assert updated['contextVersion']==2 and runtime.closed
        with pytest.raises(HTTPException) as error:
            await live.service._accept(FakeSocket(),runtime.id,live.actor)
        assert error.value.status_code==403
    asyncio.run(scenario())


def test_missing_update_context_is_rejected_without_changing_session(live):
    with TestClient(live.app) as client:
        authorize(client,live)
        before=create_http(client)
        response=client.post(PREFIX+'/sessions/'+before['sessionId']+'/context',
            json={'contextVersion':1},headers={'origin':ORIGIN})
        assert response.status_code==422
        assert live.service.repository.get(before['sessionId'])==before


@pytest.mark.parametrize('operation',['create','update'])
def test_oversized_viewer_context_returns_private_validation_error(live,operation):
    with TestClient(live.app,raise_server_exceptions=False) as client:
        authorize(client,live)
        before=create_http(client)
        payload={'viewerContext':{**CONTEXT,'state':{'private':'PRIVATE_SENTINEL'*7000}}}
        if operation=='create': response=client.post(PREFIX+'/sessions',json=payload,headers={'origin':ORIGIN})
        else: response=client.post(PREFIX+'/sessions/'+before['sessionId']+'/context',
            json={**payload,'contextVersion':1},headers={'origin':ORIGIN})
        assert response.status_code==422
        assert 'PRIVATE_SENTINEL' not in response.text
        assert live.service.repository.get(before['sessionId'])==before


def test_report_save_requires_review_then_uses_bound_study_and_authenticated_actor(live):
    async def scenario():
        uid = live.repository.list_worklist()[0].study_instance_uid
        runtime = runtime_for(live, context={**CONTEXT, "studyInstanceUID": uid})
        before = len(live.repository.get_study_workspace(uid).reports)
        action = call("report_save", findings="Synthetic teaching finding", impression="Synthetic draft only")
        await runtime.schedule_tool(action)
        assert runtime.repo.tool(runtime.id, "call-1")["status"] == "awaiting_approval"
        assert not runtime.tasks and len(live.repository.get_study_workspace(uid).reports) == before
        with pytest.raises(HTTPException):
            await runtime.decide("call-1", AILiveDecision(contextVersion=2, approved=True))
        await runtime.decide("call-1", AILiveDecision(contextVersion=1, approved=True))
        await drain_tools(runtime)
        assert runtime.repo.tool(runtime.id, "call-1")["status"] == "completed"
        reports = live.repository.get_study_workspace(uid).reports
        assert len(reports) == before + 1
        assert reports[-1].author_user_id == runtime.actor.username
        assert reports[-1].findings_summary == "Synthetic teaching finding"
        await runtime.schedule_tool(action)
        assert len(live.repository.get_study_workspace(uid).reports) == before + 1
        with pytest.raises(HTTPException):
            await runtime.decide("call-1", AILiveDecision(contextVersion=1, approved=True))
        await runtime.close("closed")
    asyncio.run(scenario())


def test_delivery_failure_cannot_reclassify_successful_report_save(live, monkeypatch):
    async def scenario():
        uid = live.repository.list_worklist()[0].study_instance_uid
        runtime = runtime_for(live, context={**CONTEXT, "studyInstanceUID": uid})
        before = len(live.repository.get_study_workspace(uid).reports)
        original_send = live.provider.send_tool_response
        monkeypatch.setattr(live.provider, "send_tool_response", AsyncMock(side_effect=ConnectionError("Synthetic provider loss")))
        await runtime.schedule_tool(call("report_save", findings="Synthetic persisted finding", impression="Synthetic"))
        await runtime.decide("call-1", AILiveDecision(contextVersion=1, approved=True))
        await drain_tools(runtime)
        tool = runtime.repo.tool(runtime.id, "call-1")
        assert tool["status"] == "completed" and tool["result"]["status"] == "draft_saved"
        assert len(live.repository.get_study_workspace(uid).reports) == before + 1
        assert "call-1" in runtime.response_outbox
        monkeypatch.setattr(live.provider, "send_tool_response", original_send)
        await runtime.flush_tool_responses()
        assert not runtime.response_outbox
        assert live.provider.responses[-1].response["status"] == "completed"
        assert len(live.repository.get_study_workspace(uid).reports) == before + 1
        await runtime.close("closed")
    asyncio.run(scenario())


def test_research_completed_during_reconnect_is_delivered_without_reexecution(live, monkeypatch):
    from backend.clinical.ai_research import ResearchSupervisor
    async def scenario():
        started, complete = asyncio.Event(), asyncio.Event()
        calls = []
        async def research(self, query, on_progress=None):
            calls.append(query)
            started.set()
            await complete.wait()
            return {"summary": "Synthetic completed research", "sources": [], "limitations": []}
        monkeypatch.setattr(ResearchSupervisor, "run", research)
        runtime = runtime_for(live)
        runtime.handle = "PRIVATE-RESUMPTION-HANDLE"
        await runtime.schedule_tool(call("research_run", query="public synthetic question"))
        await started.wait()
        runtime.provider = None
        complete.set()
        await drain_tools(runtime)
        assert runtime.repo.tool(runtime.id, "call-1")["status"] == "completed"
        assert not live.provider.responses and "call-1" in runtime.response_outbox
        await live.provider.messages.put(RuntimeError("RESOURCE_EXHAUSTED quota"))
        await asyncio.wait_for(runtime.provider_loop(), 2)
        assert live.provider.handles == ["PRIVATE-RESUMPTION-HANDLE"]
        assert len(live.provider.responses) == 1 and live.provider.responses[0].id == "call-1"
        assert live.provider.responses[0].response["result"]["summary"] == "Synthetic completed research"
        assert calls == ["public synthetic question"] and not runtime.response_outbox
        await runtime.close("closed")
    asyncio.run(scenario())


def test_fresh_provider_conversation_drops_old_transport_outbox_only(live):
    async def scenario():
        runtime = runtime_for(live)
        runtime.repo.add_tool(runtime.id, "old-call", "viewer_get_state", {}, 1, False)
        runtime.repo.set_tool(runtime.id, "old-call", "completed", {"state": {}})
        runtime.provider = None
        await runtime.tool_response("old-call", "viewer_get_state", {"status": "completed", "result": {"state": {}}})
        assert "old-call" in runtime.response_outbox and runtime.handle is None
        await live.provider.messages.put(RuntimeError("RESOURCE_EXHAUSTED quota"))
        await asyncio.wait_for(runtime.provider_loop(), 2)
        assert live.provider.responses == []
        assert not runtime.response_outbox
        assert runtime.repo.tool(runtime.id, "old-call")["status"] == "completed"
        await runtime.close("closed")
    asyncio.run(scenario())


def test_http_research_cancellation_notifies_coordinator(live, monkeypatch):
    from backend.clinical.ai_research import ResearchSupervisor
    async def research(self, query, on_progress=None):
        await asyncio.Event().wait()
    monkeypatch.setattr(ResearchSupervisor, "run", research)
    with TestClient(live.app) as client:
        authorize(client, live)
        row = create_http(client)
        with client.websocket_connect(row["liveUrl"], headers={"origin": ORIGIN}) as websocket:
            assert websocket.receive_json()["status"] == "connecting"
            assert websocket.receive_json()["status"] == "ready"
            runtime = live.service.runtimes[row["sessionId"]]
            client.portal.call(runtime.schedule_tool, call("research_run", "research", query="Public synthetic research"))
            response = client.post(f"{PREFIX}/sessions/{runtime.id}/tools/research/cancel", headers={"origin": ORIGIN})
            assert response.status_code == 200 and response.json()["status"] == "cancelled"
            assert live.provider.responses[-1].id == "research"
            assert live.provider.responses[-1].response["status"] == "cancelled"
            assert runtime.repo.tool(runtime.id, "research")["status"] == "cancelled"


@pytest.mark.parametrize("problem", ["unbound", "no-write-scope", "denied"])
def test_report_cannot_save_without_bound_authorized_review(live, problem):
    async def scenario():
        uid = live.repository.list_worklist()[0].study_instance_uid
        actor = live.actor.model_copy(update={"scopes": ["ai.run", "study.read"]}) if problem == "no-write-scope" else live.actor
        runtime = runtime_for(live, actor=actor, context=CONTEXT if problem == "unbound" else {**CONTEXT, "studyInstanceUID": uid})
        before = len(live.repository.get_study_workspace(uid).reports)
        await runtime.schedule_tool(call("report_save", findings="Synthetic", impression="Synthetic"))
        await runtime.decide("call-1", AILiveDecision(contextVersion=1, approved=problem != "denied"))
        await drain_tools(runtime)
        assert runtime.repo.tool(runtime.id, "call-1")["status"] == ("denied" if problem == "denied" else "failed")
        assert len(live.repository.get_study_workspace(uid).reports) == before
        await runtime.close("closed")
    asyncio.run(scenario())


def test_media_bounds_stale_version_and_screen_not_journaled(live):
    async def scenario():
        runtime = runtime_for(live)
        for data in (b"x", b"xx" * 8001):
            with pytest.raises(ValueError):
                await runtime.receive_audio(data)
        with pytest.raises(HTTPException):
            await runtime.receive_control({"kind": "text", "text": "stale", "contextVersion": 2})
        frame = b"\x89PNG\r\n\x1a\nSYNTHETIC-FRAME-MARKER"
        await runtime.receive_control({"kind": "screen_sharing", "active": True, "contextVersion": 1})
        await runtime.receive_control({"kind": "screen", "contextVersion": 1, "mimeType": "image/png", "data": base64.b64encode(frame).decode()})
        await runtime.receive_audio(b"\x00\x00")
        assert live.provider.inputs[-2]["video"].data == frame
        assert live.provider.inputs[-1]["audio"].mime_type == "audio/pcm;rate=16000"
        assert "FRAME-MARKER" not in json.dumps(runtime.repo.history(runtime.id, runtime.actor))
        with pytest.raises(ValueError):
            await runtime.receive_control({"kind": "screen", "contextVersion": 1, "mimeType": "image/png", "data": base64.b64encode(frame).decode()})
        await runtime.close("closed")
    asyncio.run(scenario())


def test_recovery_interrupts_jobs_and_keeps_only_application_history(live):
    runtime = runtime_for(live)
    runtime.repo.change(runtime.id, status="ready")
    runtime.repo.event(runtime.id, "transcript", {"role": "user", "text": "Synthetic history", "finished": True})
    runtime.repo.add_tool(runtime.id, "pending", "research_run", {"query": "synthetic"}, 1, False)
    runtime.repo.add_tool(runtime.id, "complete", "viewer_get_state", {}, 1, False)
    runtime.repo.set_tool(runtime.id, "complete", "completed", {"state": {}})
    recovered = AILiveRepository(live.repository)
    recovered.recover()
    history = recovered.history(runtime.id, runtime.actor)
    assert history["session"]["status"] == "interrupted"
    assert history["session"]["attestation"] is None
    assert history["events"][0]["text"] == "Synthetic history"
    assert {t["toolCallId"]: t["status"] for t in history["tools"]} == {"pending": "interrupted", "complete": "completed"}
    assert "handle" not in json.dumps(history).lower()
    recovered.clear(runtime.id, runtime.actor)
    with pytest.raises(HTTPException):
        recovered.history(runtime.id, runtime.actor)


@pytest.mark.parametrize("status", ["allocated", "failed", "interrupted"])
def test_restart_revokes_attestation_even_without_active_provider(live, status):
    runtime = runtime_for(live)
    runtime.repo.change(runtime.id, status=status)
    runtime.repo.recover()
    assert runtime.repo.get(runtime.id)["attestation"] is None


def test_grounding_rejects_private_or_credential_bearing_source_urls(live):
    async def scenario():
        runtime = runtime_for(live)
        await runtime.handle_provider(types.LiveServerMessage(server_content=types.LiveServerContent(
            grounding_metadata=types.GroundingMetadata(grounding_chunks=[
                types.GroundingChunk(web=types.GroundingChunkWeb(uri="https://pubmed.ncbi.nlm.nih.gov/123/#abstract", title="Public paper")),
                types.GroundingChunk(web=types.GroundingChunkWeb(uri="https://user:PRIVATE-CREDENTIAL@example.com/", title="Bad source")),
                types.GroundingChunk(web=types.GroundingChunkWeb(uri="https://127.0.0.1/private", title="Bad source")),
            ]))
        ))
        citations = runtime.websocket.events[-1]
        assert len(citations["sources"]) == 1
        assert citations["sources"][0]["url"] == "https://pubmed.ncbi.nlm.nih.gov/123/"
        assert "PRIVATE-CREDENTIAL" not in json.dumps(runtime.repo.history(runtime.id, runtime.actor))
        await runtime.close("closed")
    asyncio.run(scenario())


def test_expired_approval_cannot_save_report(live):
    from backend.clinical.models import AILiveToolModel
    async def scenario():
        uid = live.repository.list_worklist()[0].study_instance_uid
        runtime = runtime_for(live, context={**CONTEXT, "studyInstanceUID": uid})
        before = len(live.repository.get_study_workspace(uid).reports)
        await runtime.schedule_tool(call("report_save", findings="Synthetic", impression="Synthetic"))
        with runtime.repo.factory() as database:
            tool = database.get(AILiveToolModel, f"{runtime.id}:call-1")
            tool.expires_at = to_iso_z(utc_now() - timedelta(seconds=1))
            database.commit()
        with pytest.raises(HTTPException) as error:
            await runtime.decide("call-1", AILiveDecision(contextVersion=1, approved=True))
        assert error.value.status_code == 409
        assert not runtime.tasks
        assert len(live.repository.get_study_workspace(uid).reports) == before
        await runtime.close("closed")
    asyncio.run(scenario())


def test_pending_approvals_count_toward_tool_cap_and_close_cancels_them(live):
    async def scenario():
        runtime = runtime_for(live)
        for index in range(17):
            await runtime.schedule_tool(call("report_save", f"approval-{index}", findings="Synthetic", impression="Synthetic"))
        assert len(runtime.repo.active_tools(runtime.id)) == 16
        assert all(tool["status"] == "awaiting_approval" for tool in runtime.repo.active_tools(runtime.id))
        assert runtime.repo.tool(runtime.id, "approval-16")["status"] == "failed"
        assert not runtime.tasks
        await runtime.decide("approval-0", AILiveDecision(contextVersion=1, approved=False))
        await runtime.schedule_tool(call("report_save", "replacement", findings="Synthetic", impression="Synthetic"))
        assert len(runtime.repo.active_tools(runtime.id)) == 16
        await runtime.close("closed")
        assert runtime.repo.active_tools(runtime.id) == []
        assert runtime.repo.tool(runtime.id, "approval-0")["status"] == "denied"
        assert runtime.repo.tool(runtime.id, "replacement")["status"] == "cancelled"
    asyncio.run(scenario())


def test_study_launch_url_goes_only_to_renderer(live):
    async def scenario():
        runtime = runtime_for(live)
        await runtime.schedule_tool(call("viewer_get_state", "state"))
        await drain_tools(runtime)
        state = live.provider.responses[-1].response["result"]
        assert state["studies"] and "patient" not in json.dumps(state).lower()
        await runtime.schedule_tool(call("study_open", "open", studyId=state["studies"][0]["studyId"]))
        await wait_until(lambda: "open" in runtime.pending_actions)
        action = next(e for e in runtime.websocket.events if e["kind"] == "viewer_action")
        launch_url = action["args"]["url"]
        assert "launch=" in launch_url
        await runtime.receive_control({"kind": "action_result", "contextVersion": 1, "toolCallId": "open", "status": "completed", "result": {"applied": True}})
        await drain_tools(runtime)
        assert launch_url not in json.dumps(runtime.repo.history(runtime.id, runtime.actor))
        assert launch_url not in json.dumps([response.model_dump(mode="json") for response in live.provider.responses])
        await runtime.close("closed")
    asyncio.run(scenario())


def test_dispatched_study_navigation_without_ack_has_unknown_outcome(live):
    async def scenario():
        runtime = runtime_for(live)
        runtime.study_aliases = {"study-0": live.repository.list_worklist()[0].study_instance_uid}
        await runtime.schedule_tool(call("study_open", studyId="study-0"))
        await wait_until(lambda: "call-1" in runtime.pending_actions)
        assert any(e["kind"] == "viewer_action" for e in runtime.websocket.events)
        runtime.pending_actions["call-1"].set_exception(ConnectionError("Synthetic missing receipt"))
        await drain_tools(runtime)
        assert runtime.repo.tool(runtime.id, "call-1")["status"] == "outcome_unknown"
        await runtime.close("closed")
    asyncio.run(scenario())


@pytest.mark.parametrize("identifier", [None, "", "invalid/id"])
def test_tools_require_a_provider_id_before_any_execution(live, identifier):
    async def scenario():
        runtime = runtime_for(live)
        for _ in range(2):
            await runtime.schedule_tool(types.FunctionCall(id=identifier, name="viewer_set_window_level",
                args={"windowWidth": 400, "windowCenter": 40}))
        assert not runtime.tasks
        assert not runtime.repo.history(runtime.id, runtime.actor)["tools"]
        assert all(event["kind"] == "error" for event in runtime.websocket.events)
        await runtime.close("closed")
    asyncio.run(scenario())


def test_unknown_tools_and_injected_arguments_never_dispatch(live):
    async def scenario():
        runtime = runtime_for(live)
        await runtime.schedule_tool(call("execute_shell", "shell", command="echo synthetic"))
        await runtime.schedule_tool(call("viewer_set_layout", "injected", rows=1, columns=1, user_id="other-actor"))
        assert not runtime.tasks and not runtime.repo.history(runtime.id, runtime.actor)["tools"]
        assert len(live.provider.responses) == 2
        assert all("error" in response.response for response in live.provider.responses)
        assert not runtime.websocket.events
        await runtime.close("closed")
    asyncio.run(scenario())


@pytest.mark.parametrize("detail", ["RESOURCE_EXHAUSTED quota", "Your prepayment credits are depleted"])
def test_provider_quota_stops_without_retry_or_exception_disclosure(live, detail):
    async def scenario():
        runtime = runtime_for(live)
        await live.provider.messages.put(RuntimeError(detail + " key=PRIVATE-CREDENTIAL"))
        await asyncio.wait_for(runtime.provider_loop(), 2)
        assert live.provider.handles == [None]
        history = runtime.repo.history(runtime.id, runtime.actor)
        assert history["session"]["status"] == "failed"
        assert any(e.get("code") == "provider_quota" for e in history["events"])
        assert "PRIVATE-CREDENTIAL" not in json.dumps(history)
        assert runtime.provider is None
        await runtime.close("closed")
    asyncio.run(scenario())


def test_go_away_reconnect_uses_private_handle_and_does_not_replay_history(live):
    async def scenario():
        runtime = runtime_for(live)
        runtime.repo.event(runtime.id, "transcript", {"role": "user", "text": "PRIOR-SYNTHETIC-TURN", "finished": True})
        await live.provider.messages.put(types.LiveServerMessage(
            session_resumption_update=types.LiveServerSessionResumptionUpdate(new_handle="PRIVATE-RESUMPTION-HANDLE", resumable=True),
            go_away=types.LiveServerGoAway(time_left="1s"),
        ))
        await live.provider.messages.put(RuntimeError("RESOURCE_EXHAUSTED quota"))
        await asyncio.wait_for(runtime.provider_loop(), 4)
        assert live.provider.handles == [None, "PRIVATE-RESUMPTION-HANDLE"]
        assert "PRIOR-SYNTHETIC-TURN" in live.provider.contexts[0]["turns"].parts[0].text
        assert "PRIOR-SYNTHETIC-TURN" not in live.provider.contexts[1]["turns"].parts[0].text
        assert "PRIVATE-RESUMPTION-HANDLE" not in json.dumps(runtime.repo.history(runtime.id, runtime.actor))
        assert live.provider.closed == 2
        await runtime.close("closed")
    asyncio.run(scenario())


@pytest.mark.parametrize("detail,code", [("quota https://host?key=SECRET", "provider_quota"), ("Your prepayment credits are depleted key=SECRET", "provider_quota"), ("invalid API key SECRET", "provider_auth"), ("model not found SECRET", "provider_configuration"), ("socket failed SECRET", "provider_unavailable")])
def test_provider_errors_never_expose_raw_details(detail, code):
    actual_code, message = provider_failure(RuntimeError(detail))
    assert actual_code == code
    assert "SECRET" not in message and "https://" not in message
