"""Owner-scoped API-key settings; all keys, databases and providers are synthetic."""
import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from backend.clinical.ai_credentials import AICredentialStore, CredentialStoreError
from backend.clinical.ai_live import LiveRuntime
from backend.clinical.contracts import AISidebarSessionCreateRequest
from backend.clinical.models import AICredentialModel
from backend.tests.test_ai_live import (CONTEXT, ORIGIN, PREFIX, FakeSocket, authorize, call,
                                       live, runtime_for, wait_until)
from backend.tests.test_ai_providers import OpenAITransportFixture

PATH = PREFIX + "/credentials"
KEY = "synthetic-owner-provider-key-123456"
OTHER_KEY = "synthetic-other-owner-key-123456"


def entries(response):
    body = response.json() if hasattr(response, "json") else response
    return {entry["id"]: entry for entry in body["providers"]}


def put(client, provider="gemini", key=KEY):
    return client.put(PATH + "/" + provider, json={"apiKey": key}, headers={"origin": ORIGIN})


def test_status_save_encryption_restart_and_explicit_environment_fallback(live):
    with TestClient(live.app) as client:
        authorize(client, live)
        before = client.get(PATH)
        assert before.headers["cache-control"] == "no-store"
        assert before.json()["storageAvailable"]
        assert entries(before)["gemini"]["source"] == "environment"
        saved = put(client)
        assert saved.status_code == 200 and saved.headers["cache-control"] == "no-store"
        assert entries(saved)["gemini"] == {"id": "gemini", "label": "Gemini Live", "configured": True,
                                             "source": "saved", "environmentConfigured": True}
        assert KEY not in saved.text and "apiKey" not in saved.text
        vault = live.service.credentials
        assert vault.resolve(live.actor.sub, "gemini", "fallback") == KEY
        assert vault.directory == Path(live.repository._engine.url.database).parent.resolve() / ".ai-secrets"
        assert os.stat(vault.directory).st_mode & 0o777 == 0o700
        assert os.stat(vault.directory / "master.key").st_mode & 0o777 == 0o600
        assert (vault.directory / "master.key").read_bytes() != KEY.encode()
        with live.repository._session_factory() as db:
            row = db.get(AICredentialModel, (live.actor.sub, "gemini"))
            assert KEY not in row.ciphertext and row.ciphertext.startswith("gAAAA")
        assert KEY.encode() not in Path(live.repository._engine.url.database).read_bytes()
        restored = AICredentialStore(live.repository)
        assert restored.resolve(live.actor.sub, "gemini", "fallback") == KEY
        removed = client.delete(PATH + "/gemini", headers={"origin": ORIGIN})
        assert removed.status_code == 200 and removed.headers["cache-control"] == "no-store"
        assert entries(removed)["gemini"]["source"] == "environment"
        assert entries(removed)["gemini"]["environmentConfigured"] is True
        assert restored.resolve(live.actor.sub, "gemini", "fallback") == "fallback"


def test_owner_and_provider_isolation_and_status_never_returns_fragments(live):
    other = live.manager.issue_for_username("attending-radiologist")
    with TestClient(live.app) as client:
        authorize(client, live)
        assert put(client, "openai").status_code == 200
        authorize(client, live, other)
        assert entries(client.get(PATH))["openai"]["source"] == "none"
        assert put(client, "openai", OTHER_KEY).status_code == 200
        assert live.service.config_for(other).openai_api_key == OTHER_KEY
        assert live.service.config_for(live.actor).openai_api_key == KEY
        assert live.service.config_for(live.actor).api_key == live.service.config.api_key
        assert client.delete(PATH + "/openai", headers={"origin": ORIGIN}).status_code == 200
        assert live.service.config_for(other).openai_api_key == ""
        assert live.service.config_for(live.actor).openai_api_key == KEY
        authorize(client, live)
        status = client.get(PATH)
        assert entries(status)["openai"]["source"] == "saved"
        for secret in (KEY, OTHER_KEY, KEY[-4:], OTHER_KEY[-4:]):
            assert secret not in status.text


@pytest.mark.parametrize("method", ["get", "put", "delete"])
def test_credentials_require_signed_ai_actor_and_no_store_even_on_errors(live, method):
    with TestClient(live.app) as client:
        path = PATH if method == "get" else PATH + "/gemini"
        request = {"headers": {"origin": ORIGIN}}
        if method == "put":
            request["json"] = {"apiKey": KEY}
        result = getattr(client, method)(path, **request)
        assert result.status_code == 401 and result.headers["cache-control"] == "no-store"
        authorize(client, live, live.manager.issue_for_username("qa-reviewer"))
        result = getattr(client, method)(path, **request)
        assert result.status_code == 403 and result.headers["cache-control"] == "no-store"
        assert KEY not in result.text


@pytest.mark.parametrize("origin", [None, "null", "https://untrusted.example"])
@pytest.mark.parametrize("method", ["put", "delete"])
def test_credential_writes_require_allowed_origin(live, origin, method):
    with TestClient(live.app) as client:
        authorize(client, live)
        kwargs = {"headers": {"origin": origin} if origin else {}}
        if method == "put":
            kwargs["json"] = {"apiKey": KEY}
        response = getattr(client, method)(PATH + "/gemini", **kwargs)
        assert response.status_code == 403 and response.headers["cache-control"] == "no-store"
        assert KEY not in response.text
        assert live.service.credentials._saved(live.actor.sub, "gemini") is None


@pytest.mark.parametrize("payload", [
    {}, {"apiKey": "short"}, {"apiKey": " leading-secret"}, {"apiKey": "trailing-secret "},
    {"apiKey": "embedded secret"}, {"apiKey": "secret\ncontrol"}, {"apiKey": "key-\u007f-secret"},
    {"apiKey": "key-\u200b-secret"}, {"apiKey": 123456789}, {"apiKey": KEY, "owner": "another-user"},
    {"apiKey": "S" * 4097}, [KEY], KEY,
])
def test_invalid_keys_receive_fixed_errors_without_reflected_input(live, payload):
    with TestClient(live.app) as client:
        authorize(client, live)
        response = client.put(PATH + "/gemini", json=payload, headers={"origin": ORIGIN})
        assert response.status_code == 422
        assert response.headers["cache-control"] == "no-store"
        assert response.json() == {"detail": "Enter a valid API key without spaces or control characters."}
        assert live.service.credentials._saved(live.actor.sub, "gemini") is None


def test_oversized_stream_malformed_json_and_unknown_provider_do_not_echo_keys(live):
    with TestClient(live.app) as client:
        authorize(client, live)
        for body in (b"{\"apiKey\":\"PRIVATE_UNFINISHED", b"X" * 9000, b"[" * 2000 + b"]" * 2000):
            response = client.put(PATH + "/gemini", content=body,
                                  headers={"origin": ORIGIN, "content-type": "application/json"})
            assert response.status_code == 422 and "PRIVATE" not in response.text
            assert response.headers["cache-control"] == "no-store"
        response = client.put(PATH + "/gemini", content=iter((b"X" * 5000, b"X" * 5000)),
                              headers={"origin": ORIGIN, "content-type": "application/json"})
        assert response.status_code == 422
        for method in ("put", "delete"):
            kwargs = {"json": {"apiKey": KEY}} if method == "put" else {}
            response = getattr(client, method)(PATH + "/unsupported", headers={"origin": ORIGIN}, **kwargs)
            assert response.status_code == 422 and KEY not in response.text
            assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("damage", ["ciphertext", "missing_master", "unsafe_key", "unsafe_directory", "symlink_key"])
def test_unreadable_personal_key_never_falls_back_but_explicit_removal_can(live, damage):
    vault = live.service.credentials
    vault.save(live.actor.sub, "gemini", KEY)
    master = vault.directory / "master.key"
    if damage == "ciphertext":
        with live.repository._session_factory() as db:
            db.get(AICredentialModel, (live.actor.sub, "gemini")).ciphertext = "corrupt"
            db.commit()
    elif damage == "missing_master":
        master.unlink()
    elif damage == "unsafe_key":
        master.chmod(0o644)
    elif damage == "unsafe_directory":
        vault.directory.chmod(0o755)
    else:
        real = vault.directory / "real.key"
        master.rename(real)
        master.symlink_to(real)
    with pytest.raises(CredentialStoreError):
        vault.resolve(live.actor.sub, "gemini", "must-not-fallback")
    effective = live.service.config_for(live.actor)
    assert effective.api_key == "" and effective.readiness()[0] == "unavailable"
    with TestClient(live.app) as client:
        authorize(client, live)
        response = client.get(PATH)
        assert response.status_code == 200 and not response.json()["storageAvailable"]
        assert entries(response)["gemini"]["source"] == "saved"
        assert entries(response)["gemini"]["configured"] is False
        removed = client.delete(PATH + "/gemini", headers={"origin": ORIGIN})
        assert removed.status_code == 200
        assert entries(removed)["gemini"]["source"] == "environment"
        assert live.service.config_for(live.actor).api_key == live.service.config.api_key


def test_ciphertext_cannot_be_swapped_between_owners_or_providers(live):
    vault = live.service.credentials
    other = live.manager.issue_for_username("attending-radiologist")
    vault.save(live.actor.sub, "gemini", KEY)
    ciphertext = vault._saved(live.actor.sub, "gemini")
    with live.repository._session_factory() as db:
        db.add(AICredentialModel(owner=other.sub, provider="gemini", ciphertext=ciphertext))
        db.add(AICredentialModel(owner=live.actor.sub, provider="openai", ciphertext=ciphertext))
        db.commit()
    for owner, provider in ((other.sub, "gemini"), (live.actor.sub, "openai")):
        with pytest.raises(CredentialStoreError):
            vault.resolve(owner, provider, "must-not-fallback")
    assert vault.resolve(live.actor.sub, "gemini", "fallback") == KEY


def test_symlinked_credential_directory_is_rejected_without_touching_target(live, tmp_path):
    target = tmp_path / "elsewhere"
    target.mkdir(mode=0o700)
    linked = tmp_path / "linked"
    linked.symlink_to(target, target_is_directory=True)
    vault = AICredentialStore(live.repository, str(linked))
    with pytest.raises(CredentialStoreError):
        vault.save(live.actor.sub, "gemini", KEY)
    assert list(target.iterdir()) == []


def test_nonregular_master_key_fails_closed_without_blocking(live):
    vault = live.service.credentials
    vault.directory.mkdir(mode=0o700)
    os.mkfifo(vault.directory / "master.key", 0o600)
    # Bound a regression to the child process rather than hanging pytest's
    # event loop if a future edit accidentally performs a blocking FIFO open.
    code = """
import sys
from pathlib import Path
from backend.clinical.ai_credentials import AICredentialStore, CredentialStoreError
store = object.__new__(AICredentialStore)
store.directory = Path(sys.argv[1])
try:
    store._cipher()
except CredentialStoreError:
    raise SystemExit(0)
raise SystemExit(1)
"""
    result = subprocess.run([sys.executable, "-c", code, str(vault.directory)],
        cwd=Path(__file__).resolve().parents[2], env={"PYTHONDONTWRITEBYTECODE": "1"},
        capture_output=True, timeout=3)
    assert result.returncode == 0 and result.stdout == b""


def test_database_parent_alias_does_not_disable_private_key_storage(live, tmp_path):
    from sqlalchemy.engine import make_url
    alias = tmp_path / "os-alias"
    actual = Path(live.repository._engine.url.database).parent
    alias.symlink_to(actual, target_is_directory=True)
    repository = SimpleNamespace(_session_factory=live.repository._session_factory,
        _engine=SimpleNamespace(url=make_url("sqlite:///" + str(alias / "live.db"))))
    vault = AICredentialStore(repository)
    assert vault.directory == actual.resolve() / ".ai-secrets"
    vault.save(live.actor.sub, "gemini", KEY)
    assert vault.resolve(live.actor.sub, "gemini", "fallback") == KEY


def test_saved_keys_drive_only_owner_capabilities_and_new_runtime(live, monkeypatch):
    live.service.config.api_key = live.service.config.openai_api_key = ""
    monkeypatch.setattr("importlib.metadata.version", lambda name: "16.1.1" if name == "websockets" else "2.24.0")
    other = live.manager.issue_for_username("attending-radiologist")
    live.service.credentials.save(live.actor.sub, "openai", KEY)
    with TestClient(live.app) as client:
        authorize(client, live)
        mine = client.get(PREFIX + "/capabilities").json()
        assert {p["id"]: p for p in mine["providers"]}["openai"]["availability"] == "configured"
        assert KEY not in json.dumps(mine)
        authorize(client, live, other)
        theirs = client.get(PREFIX + "/capabilities").json()
        assert {p["id"]: p for p in theirs["providers"]}["openai"]["availability"] == "unavailable"
    row = live.service.create(AISidebarSessionCreateRequest(providerId="openai", viewerContext=CONTEXT,
                                                           attestation="synthetic"), live.actor)
    runtime = LiveRuntime(live.service, row["sessionId"], live.actor)
    assert runtime.config.openai_api_key == KEY
    assert live.service.config.openai_api_key == ""


def test_live_transport_and_research_receive_owner_keys_not_global_defaults(live, monkeypatch):
    async def scenario():
        live.service.credentials.save(live.actor.sub, "gemini", KEY)
        live.service.credentials.save(live.actor.sub, "openai", OTHER_KEY)
        runtime = runtime_for(live)
        seen = []
        live.service.provider_factory = None
        def factory(settings):
            seen.append(settings.api_key)
            return live.provider
        monkeypatch.setattr("backend.clinical.ai_live.GeminiLiveProvider", factory)
        runtime.provider = None
        runtime.provider_ready = False
        runtime.provider_task = asyncio.create_task(runtime.provider_loop())
        try:
            await wait_until(lambda: runtime.provider_ready)
            assert seen == [KEY]
            captured = []
            class Research:
                def __init__(self, **kwargs):
                    captured.append(kwargs)
                async def run(self, query):
                    return {"summary": "Synthetic result", "sources": []}
            monkeypatch.setattr("backend.clinical.ai_research.ResearchSupervisor", Research)
            await runtime.schedule_tool(call("research_run", query="Public synthetic topic"))
            await wait_until(lambda: "call-1" not in runtime.tasks)
            assert captured[0]["api_key"] == KEY
            assert live.service.config.api_key != KEY
        finally:
            await live.service.shutdown()
        row = live.service.create(AISidebarSessionCreateRequest(providerId="openai", viewerContext=CONTEXT,
                                                               attestation="synthetic"), live.actor)
        runtime = LiveRuntime(live.service, row["sessionId"], live.actor)
        runtime.websocket = FakeSocket()
        fixture = OpenAITransportFixture()
        live.service._openai_provider = lambda settings: (seen.append(settings.openai_api_key) or fixture)
        runtime.provider_task = asyncio.create_task(runtime.provider_loop())
        try:
            await wait_until(lambda: runtime.provider_ready)
            assert seen[-1] == OTHER_KEY and fixture.handles == [None]
        finally:
            await runtime.close("closed")
    asyncio.run(scenario())


@pytest.mark.parametrize("remove", [False, True])
def test_changing_key_stops_only_owner_jobs_before_mutation_and_blocks_new_use(live, monkeypatch, remove):
    async def scenario():
        live.service.credentials.save(live.actor.sub, "gemini", KEY)
        own = runtime_for(live)
        other_actor = live.manager.issue_for_username("attending-radiologist")
        other = runtime_for(live, actor=other_actor)
        running, cancelled = [], []
        class Research:
            def __init__(self, **kwargs):
                pass
            async def run(self, query):
                running.append(query)
                try:
                    await asyncio.Event().wait()
                except asyncio.CancelledError:
                    cancelled.append(query)
                    raise
        monkeypatch.setattr("backend.clinical.ai_research.ResearchSupervisor", Research)
        for number in range(2):
            await own.schedule_tool(call("research_run", identifier=f"job-{number}", query=f"public topic {number}"))
        await wait_until(lambda: len(running) == 2)
        original_stop = live.service.stop_owner
        stopping, release = asyncio.Event(), asyncio.Event()
        async def stop_owner(actor):
            await original_stop(actor)
            stopping.set()
            await release.wait()
        live.service.stop_owner = stop_owner
        mutation = asyncio.create_task(live.service.change_credential(live.actor, "gemini", None if remove else OTHER_KEY))
        connecting = None
        try:
            await asyncio.wait_for(stopping.wait(), 2)
            assert own.closed and not other.closed
            assert len(cancelled) == 2 and not own.tasks
            assert live.service.credentials.resolve(live.actor.sub, "gemini", "fallback") == KEY
            with pytest.raises(HTTPException) as error:
                live.service.create(AISidebarSessionCreateRequest(viewerContext=CONTEXT), live.actor)
            assert error.value.status_code == 409
            # Another actor is neither locked out nor stopped by this mutation.
            assert live.service.create(AISidebarSessionCreateRequest(viewerContext=CONTEXT), other_actor)
            from backend.tests.test_ai_connection_races import DuplexSocket
            connecting = asyncio.create_task(live.service.attach(DuplexSocket(), own.id, live.actor))
            await asyncio.sleep(0)
            assert not connecting.done()
            release.set()
            await asyncio.wait_for(mutation, 2)
            with pytest.raises(HTTPException):
                await connecting
            assert live.service.credentials.resolve(live.actor.sub, "gemini", "fallback") == ("fallback" if remove else OTHER_KEY)
            assert other.config.api_key == live.service.config.api_key
        finally:
            release.set()
            for task in (mutation, connecting):
                if task and not task.done():
                    task.cancel()
            await asyncio.gather(*(task for task in (mutation, connecting) if task), return_exceptions=True)
            await live.service.shutdown()
    asyncio.run(scenario())


def test_key_change_between_socket_accept_and_runtime_attach_cannot_start_old_provider(live, monkeypatch):
    async def scenario():
        from backend.tests.test_ai_connection_races import DuplexSocket
        row = live.service.create(AISidebarSessionCreateRequest(viewerContext=CONTEXT, attestation="synthetic"), live.actor)
        entered, release = asyncio.Event(), asyncio.Event()
        attach = LiveRuntime.attach
        async def delayed_attach(runtime, websocket):
            entered.set()
            await release.wait()
            await attach(runtime, websocket)
        monkeypatch.setattr(LiveRuntime, "attach", delayed_attach)
        pending = asyncio.create_task(live.service.attach(DuplexSocket(), row["sessionId"], live.actor))
        try:
            await asyncio.wait_for(entered.wait(), 2)
            assert not live.service.owner_lock(live.actor).locked()
            await live.service.change_credential(live.actor, "gemini", KEY)
            release.set()
            await asyncio.wait_for(pending, 2)
            assert live.provider.handles == []
            assert live.service.repository.get(row["sessionId"])["status"] == "closed"
            assert live.service.config_for(live.actor).api_key == KEY
        finally:
            release.set()
            if not pending.done():
                pending.cancel()
                await asyncio.gather(pending, return_exceptions=True)
            await live.service.shutdown()
    asyncio.run(scenario())
