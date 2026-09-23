"""Backend-owned Live session and asynchronous action lifecycle."""
from __future__ import annotations

import asyncio
import base64
import copy
import json
import re
import time
from uuid import uuid4
from types import SimpleNamespace

from fastapi import HTTPException, WebSocket

from .ai_config import AISettings, PROVIDER_PROFILES, profile_for_model
from .ai_credentials import AICredentialStore, CredentialStoreError, validate_api_key
from .ai_provider import GeminiLiveProvider, session_transport
from .ai_repository import AILiveRepository, TERMINAL_TOOLS
from .ai_research_worker import public_url
from .ai_tools import bound_json, requires_approval, safe_state, validate_tool
from .contracts import (AISidebarCapabilities, AISidebarModelLane, AISidebarViewerContext,
                        AuditAction, ResourceType, ImagingLaunchRequest, ReportDraftRequest, parse_iso_z, utc_now)


def provider_failure(error, provider_id="gemini"):
    # Provider exception strings can contain URLs/credentials. Never return them.
    detail = str(error).lower()
    if provider_id == "openai":
        code = getattr(error, "code", "")
        if code in {"insufficient_quota", "rate_limit_exceeded", "provider_quota"} or any(term in detail for term in ("quota", "rate_limit", "429")):
            return "provider_quota", "OpenAI reports exhausted API quota or a rate limit. Check the API project's billing and limits, then retry."
        if code in {"invalid_api_key", "provider_auth"} or any(term in detail for term in ("401", "403", "api key", "unauth", "permission")):
            return "provider_auth", "OpenAI rejected the API credential or model permission. Check RADSYSX_OPENAI_API_KEY and project access."
        if code in {"provider_configuration", "invalid_request_error", "model_not_found"} or any(term in detail for term in ("not found", "not supported", "invalid argument")):
            return "provider_configuration", "OpenAI rejected the requested model or Realtime configuration. No alternate model was selected."
        return "provider_unavailable", "OpenAI Realtime could not connect. Check connectivity and retry."
    if any(term in detail for term in ("quota", "resource_exhausted", "prepayment credits", "credits are depleted")):
        return "provider_quota", "Google reports exhausted Gemini quota or billing credits. Check the API project's quota and AI Studio billing, then retry."
    if "api key" in detail or "unauth" in detail or "permission" in detail:
        return "provider_auth", "Google rejected the Gemini credential or model permission. Check .env.ai and project access."
    if "not found" in detail or "not supported" in detail or "invalid argument" in detail:
        return "provider_configuration", "Google rejected the requested model or Live configuration. No alternate model was selected."
    return "provider_unavailable", "Gemini Live could not connect. Check connectivity and retry."


def clean_context(context):
    context = context or AISidebarViewerContext()
    try:
        result = context.model_dump(by_alias=True)
        bound_json(result)
    except (ValueError, TypeError, RecursionError):
        raise HTTPException(422, "Viewer context is invalid or exceeds the size limit.") from None
    result["route"] = (result.get("route") or "").split("?")[0].split("#")[0][:128]
    result["state"] = safe_state(result.get("state", {}))
    return result


def context_identity(context):
    return tuple(context.get(k) for k in ("targetId", "studyInstanceUID", "seriesInstanceUID", "captureTarget", "privacyClass"))


class AILiveService:
    def __init__(self, clinical_service, clinical_repository, settings):
        self.clinical = clinical_service
        self.clinical_repository = clinical_repository
        self.platform = settings
        self.config = AISettings(settings.app_mode.value)
        self.credentials = AICredentialStore(clinical_repository, self.config.key_store_dir)
        self.repository = AILiveRepository(clinical_repository)
        from .ai_actions import ActionBroker
        self.actions = ActionBroker(self)
        # Optional zero-argument test/fixture factories. Production providers
        # receive an owner-resolved runtime snapshot instead of global secrets.
        self.provider_factory = None
        self.openai_provider_factory = None
        self.runtimes: dict[str, LiveRuntime] = {}
        self.session_locks: dict[str, asyncio.Lock] = {}
        self.owner_locks: dict[str, asyncio.Lock] = {}
        self.research_catalog_lock = asyncio.Lock()
        self.research_catalog_cache = None
        from .ai_evidence_review import EvidenceReviewService
        self.evidence_reviews = EvidenceReviewService(self)
        from .ai_text import TextService
        self.text = TextService(self)
        from .ai_codex import CodexService
        self.codex = CodexService(self)

    def _openai_provider(self, settings):
        from .ai_openai import OpenAIRealtimeProvider
        return OpenAIRealtimeProvider(settings)

    def owner_lock(self, actor):
        return self.owner_locks.setdefault(actor.sub, asyncio.Lock())

    def config_for(self, actor=None):
        if actor is None:
            return self.config
        config = copy.copy(self.config)
        config.credential_errors = set()
        for provider, attribute in (("gemini", "api_key"), ("openai", "openai_api_key")):
            try:
                key = self.credentials.resolve(actor.sub, provider, getattr(self.config, attribute))
            except CredentialStoreError:
                key = ""
                config.credential_errors.add(provider)
            setattr(config, attribute, key)
        preference = self.repository.research_preference(actor.sub)
        if preference is not None:
            config.research_provider, config.research_model = preference
        config.codex_ready = self.codex.ready(actor.sub)
        return config

    def readiness(self, provider_id="gemini", actor=None):
        config = self.config_for(actor)
        return config.readiness() if provider_id == "gemini" else config.readiness(provider_id)

    def credential_status(self, actor):
        self.require_actor(actor)
        try:
            return self.credentials.status(actor.sub, self.config)
        except CredentialStoreError:
            raise HTTPException(503, "API key storage is unavailable.") from None

    async def change_credential(self, actor, provider, api_key=None):
        self.require_actor(actor)
        if provider not in PROVIDER_PROFILES:
            raise HTTPException(422, "Choose a supported AI provider.")
        if api_key is not None:
            try:
                validate_api_key(api_key)
            except ValueError:
                raise HTTPException(422, "Enter a valid API key without spaces or control characters.") from None
        async with self.owner_lock(actor):
            # New sessions/connections cannot escape the stop-before-change
            # boundary. Existing jobs are cancelled before credentials change.
            await self.stop_owner(actor)
            self.require_actor(actor)
            try:
                if api_key is None:
                    self.credentials.delete(actor.sub, provider)
                else:
                    self.credentials.save(actor.sub, provider, api_key)
                return self.credentials.status(actor.sub, self.config)
            except CredentialStoreError:
                raise HTTPException(503, "API key storage is unavailable.") from None

    def require_research_settings(self, actor):
        self.require_actor(actor)
        if not self.config.enabled or self.config.app_mode not in {"research", "pilot"}:
            raise HTTPException(403, "Research models are disabled in this runtime.")

    def research_settings(self, actor):
        self.require_research_settings(actor)
        config = self.config_for(actor)
        return {"providerId":config.research_provider, "modelId":config.research_model,
            "source":"saved" if self.repository.research_preference(actor.sub) else "environment",
            "providers":[
                {"id":"gemini", "label":"Gemini", "configured":bool(config.api_key) and "gemini" not in config.credential_errors},
                {"id":"nvidia_nim", "label":"NVIDIA NIM", "configured":bool(config.nvidia_api_key)},
                *([{"id":"codex", "label":"ChatGPT / Codex subscription", "configured":config.codex_ready}] if self.codex.enabled() else [])]}

    async def research_models(self, actor, provider, *, refresh=False):
        self.require_research_settings(actor)
        config = self.config_for(actor)
        if provider == "codex":
            try:
                return {"providerId":provider, "models":await self.codex.models(actor), "capabilitiesVerified":False}
            except HTTPException: raise
            except Exception:
                raise HTTPException(503, "The Codex model catalog is unavailable. Check subscription sign-in and retry.") from None
        if provider == "gemini":
            return {"providerId":provider, "models":["gemini-3.8-flash"], "capabilitiesVerified":False}
        if provider != "nvidia_nim":
            raise HTTPException(422, "Choose a supported research provider.")
        if not config.nvidia_api_key:
            raise HTTPException(503, "NVIDIA NIM is not configured. Add the NVIDIA key to backend settings.")
        async with self.research_catalog_lock:
            cached = self.research_catalog_cache
            if refresh or cached is None or time.monotonic() - cached[0] > 180:
                from pydantic import SecretStr
                from ..evidence_review.nim import discover_models
                from ..evidence_review.transport import new_http_client
                async with new_http_client() as client:
                    result = await discover_models(SecretStr(config.nvidia_api_key), client)
                if "error" in result:
                    self.research_catalog_cache = None
                    raise HTTPException(503, "NVIDIA model catalog is unavailable. Check the backend key and connection, then retry.")
                self.research_catalog_cache = (time.monotonic(), tuple(result["models"]))
            models = list(self.research_catalog_cache[1])
        self.require_research_settings(actor)
        return {"providerId":provider, "models":models, "capabilitiesVerified":False}

    async def change_research_settings(self, actor, provider, model):
        self.require_research_settings(actor)
        from .ai_research_worker import validate_research_model
        try:
            validate_research_model(provider, model)
        except ValueError:
            raise HTTPException(422, "Choose a supported research model.") from None
        catalog = await self.research_models(actor, provider)
        if model not in catalog["models"]:
            raise HTTPException(422, "Choose a model from the current provider catalog.")
        async with self.owner_lock(actor):
            config = self.config_for(actor)
            config.research_provider, config.research_model = provider, model
            try:
                config.research_configuration()
            except ValueError:
                raise HTTPException(503, "Configure this research provider before saving its model.") from None
            # Match credential changes: sessions/jobs cannot retain the old choice.
            await self.stop_owner(actor)
            self.require_research_settings(actor)
            self.repository.save_research_preference(actor.sub, provider, model)
            return self.research_settings(actor)

    def session_lock(self, session_id):
        return self.session_locks.setdefault(session_id, asyncio.Lock())

    def require_actor(self, actor):
        if "ai.run" not in actor.scopes:
            raise HTTPException(403, "AI execution permission required.")
        if parse_iso_z(actor.expires_at) <= utc_now():
            raise HTTPException(401, "Clinical session expired.")

    def capabilities(self, actor=None):
        config = self.config_for(actor)
        availability, reason = config.readiness()
        try:
            config.research_configuration()
            research_available = True
        except ValueError:
            research_available = False
        return AISidebarCapabilities(evidence_review=self.evidence_reviews.availability(), backend_bound=True, voice_first=True, text_composer=True,
            context_attachments=True, orchestration_mode="api", event_transport="websocket",
            audio_input_modes=["pcm16_16000", "pcm16_24000"], model_lanes=[
                AISidebarModelLane(lane="live", status="available" if availability == "configured" else "disabled",
                    role="Conversational voice, shared viewport and app tools.", model_id=config.model),
                AISidebarModelLane(lane="research", status="available" if research_available else "disabled",
                    role="Bounded PubMed research via NVIDIA NIM." if config.research_provider == "nvidia_nim" else "Bounded asynchronous research delegates.", model_id=config.research_model or None)],
            safety_note="Synthetic/deidentified use only. Sharing is opt-in; raw audio and screen frames are not retained.",
            availability=availability, model_id=config.model, reason=reason,
            providers=config.profiles())

    def create(self, request, actor):
        self.require_actor(actor)
        if self.owner_lock(actor).locked():
            raise HTTPException(409, "API key settings are changing. Retry after they finish.")
        context = clean_context(request.viewer_context)
        if context.get("privacyClass") == "phi-bearing" and request.attestation:
            raise HTTPException(400, "Patient-bearing context cannot be attested for this release.")
        profile = PROVIDER_PROFILES[request.provider_id]
        status = "allocated" if self.readiness(request.provider_id, actor)[0] == "configured" else "unavailable"
        session = self.repository.create(actor, context, request.attestation, status, profile["modelId"])
        self.audit(session, actor, session["sessionId"])
        return session

    def audit(self, row, actor, resource_id):
        uid = row["viewerContext"].get("studyInstanceUID")
        if uid and not self.clinical_repository.get_worklist_row(uid):
            uid = None
        self.clinical_repository.add_audit_event(self.clinical._build_audit_event(
            actor_user_id=actor.username, actor_role=actor.primary_role,
            action=AuditAction.RUN_AI, resource_type=ResourceType.AI_JOB,
            resource_id=resource_id, source_ip="live-sidebar", study_instance_uid=uid))

    async def update_context(self, session_id, request, actor):
        async with self.session_lock(session_id):
            return await self._update_context(session_id, request, actor)

    async def _update_context(self, session_id, request, actor):
        self.require_actor(actor)
        row = self.repository.owned(session_id, actor, active=True)
        if "provider_id" in request.model_fields_set and request.provider_id != row["providerId"]:
            raise HTTPException(409, "Changing AI provider requires a new session.")
        if request.context_version != row["contextVersion"]:
            raise HTTPException(409, "Viewer context changed. Refresh the AI session.")
        context = clean_context(request.viewer_context)
        changed = context_identity(context) != context_identity(row["viewerContext"])
        if context.get("privacyClass") == "phi-bearing":
            request.attestation = None
            changed = True
        # State-only updates keep the binding and pending actions stable.
        attestation = request.attestation if request.attestation is not None else (None if changed else row["attestation"])
        if changed:
            await self._stop(session_id)
        updated = self.repository.change(session_id, context_json=context,
            context_version=row["contextVersion"] + int(changed), attestation=attestation,
            status="allocated" if changed else row["status"])
        runtime = self.runtimes.get(session_id)
        if runtime and runtime.provider:
            await runtime.send_context()
        return updated

    async def stop(self, session_id, *, status="closed"):
        async with self.session_lock(session_id):
            await self._stop(session_id, status=status)

    async def _stop(self, session_id, *, status="closed"):
        await self.text.stop(session_id, status="interrupted" if status == "interrupted" else "cancelled")
        runtime = self.runtimes.pop(session_id, None)
        if runtime:
            await runtime.close(status)
        else:
            self.repository.change(session_id, status=status, attestation=None)

    async def stop_owner(self, actor):
        await self.evidence_reviews.stop_owner(actor.sub, reason="account_work_stopped")
        for row in self.repository.active_sessions(actor):
            if row["status"] != "closed":
                await self.stop(row["sessionId"])

    async def shutdown(self):
        await self.evidence_reviews.shutdown()
        await self.text.shutdown()
        for session_id in list(self.runtimes):
            await self.stop(session_id, status="interrupted")
        await self.codex.shutdown()

    async def attach(self, websocket: WebSocket, session_id, actor):
        async with self.owner_lock(actor):
            async with self.session_lock(session_id):
                runtime = await self._accept(websocket, session_id, actor)
        await runtime.attach(websocket)

    async def _accept(self, websocket, session_id, actor):
        self.require_actor(actor)
        row = self.repository.owned(session_id, actor, active=True)
        if row.get("mode") == "text":
            raise HTTPException(409, "Text sessions do not open a Realtime connection.")
        if not row["attestation"]:
            raise HTTPException(403, "Confirm synthetic/deidentified content before starting the assistant.")
        readiness = self.readiness(row["providerId"], actor)
        if readiness[0] != "configured":
            raise HTTPException(503, readiness[1])
        runtime = self.runtimes.get(session_id)
        if runtime is None or runtime.closed:
            runtime = LiveRuntime(self, session_id, actor)
            self.runtimes[session_id] = runtime
        if runtime.websocket is not None:
            raise HTTPException(409, "This AI session already has an active viewer.")
        await websocket.accept()
        runtime.websocket = websocket
        return runtime


class LiveRuntime:
    def __init__(self, service, session_id, actor):
        self.service = service
        self.repo = service.repository
        self.id = session_id
        self.actor = actor
        self.config = service.config_for(actor)
        self.context_version = self.row()["contextVersion"]
        self.profile = profile_for_model(self.row()["modelId"])
        self.websocket = None
        self.provider = None
        self.provider_ready = False
        self.handle = None
        self.provider_task = None
        self.expiry_task = None
        self.detached_task = None
        self.tasks = {}
        self.pending_actions = {}
        self.response_outbox = {}
        self.closed = False
        self.send_lock = asyncio.Lock()
        self.provider_lock = asyncio.Lock()
        self.action_lock = asyncio.Lock()
        self.last_frame = 0.0
        self.screen_sharing = False
        self.frame_received = False
        self.audio_window = (time.monotonic(), 0)
        self.turn_ids = {"user": uuid4().hex, "assistant": uuid4().hex}
        self.study_aliases = {}
        self.interaction_id = uuid4().hex
        self.interaction_active = False

    def row(self):
        return self.repo.owned(self.id, self.actor, active=True)

    def check(self):
        self.service.require_actor(self.actor)
        row = self.row()
        if self.closed or not row["attestation"] or row["contextVersion"] != self.context_version:
            raise HTTPException(409, "AI context is no longer authorized.")
        return row

    async def emit(self, kind, *, persist=True, **payload):
        payload.setdefault("interactionId", self.interaction_id)
        event = self.repo.event(self.id, kind, payload, persist=persist)
        async with self.send_lock:
            if self.websocket:
                try:
                    await asyncio.wait_for(self.websocket.send_json(event), 3)
                except Exception:
                    pass
        return event

    async def audio(self, data, *, marker=None):
        async with self.send_lock:
            socket = self.websocket
            if socket:
                try:
                    # The marker and its binary frame belong to one socket and
                    # must not straddle reconnects or concurrent tool events.
                    if marker:
                        event = self.repo.event(self.id, "audio_chunk", {
                            "interactionId": self.interaction_id, **marker}, persist=False)
                        await asyncio.wait_for(socket.send_json(event), 3)
                    await asyncio.wait_for(socket.send_bytes(data), 3)
                except Exception:
                    pass

    async def attach(self, websocket):
        if self.detached_task:
            self.detached_task.cancel()
        self.websocket = websocket
        if self.provider_task is None or self.provider_task.done():
            self.provider_task = asyncio.create_task(self.provider_loop())
        else:
            await self.emit("session", status="ready" if self.provider_ready else "connecting")
        if self.expiry_task is None:
            self.expiry_task = asyncio.create_task(self.watch_authority())
        try:
            while not self.closed:
                message = await websocket.receive()
                if message["type"] == "websocket.disconnect":
                    break
                try:
                    self.check()
                    if message.get("bytes") is not None:
                        await self.receive_audio(message["bytes"])
                    elif message.get("text") is not None:
                        if len(message["text"]) > 400000:
                            raise ValueError("Input too large")
                        await self.receive_control(json.loads(message["text"]))
                except (ValueError, KeyError, TypeError):
                    await self.emit("error", code="invalid_input", message="The AI input was invalid or exceeded its limit.")
                except HTTPException:
                    await self.emit("error", code="stale_context", message="The AI session context changed or expired. Start a new session.")
                    break
        finally:
            # Acceptance cannot attach a replacement socket halfway through
            # teardown of the previous provider and its pending work.
            async with self.service.session_lock(self.id):
                if self.websocket is websocket:
                    self.websocket = None
                    self.screen_sharing = False
                    self.frame_received = False
                    if self.profile["id"] == "openai":
                        # A lost browser connection gives no trustworthy final
                        # playback position. Never reuse unheard audio context.
                        self.provider_ready = False
                        if self.provider_task:
                            self.provider_task.cancel()
                            await asyncio.gather(self.provider_task, return_exceptions=True)
                            self.provider_task = None
                        await self.cancel_all()
                        self.response_outbox.clear()
                    elif self.provider and not self.closed:
                        try:
                            await self.send_context()
                        except Exception:
                            pass
                    # Lost command acknowledgments never authorize retries.
                    for future in self.pending_actions.values():
                        if not future.done():
                            future.set_exception(ConnectionError("Viewer disconnected"))
                    if not self.closed:
                        self.detached_task = asyncio.create_task(self.expire_detached())

    async def expire_detached(self):
        await asyncio.sleep(30)
        if self.websocket is None:
            await self.service.stop(self.id)

    async def watch_authority(self):
        while not self.closed:
            await asyncio.sleep(1)
            try:
                self.check()
                for tool in self.repo.active_tools(self.id):
                    if tool["status"] == "awaiting_approval" and parse_iso_z(tool["expiresAt"]) <= utc_now():
                        await self.cancel(tool["toolCallId"])
                        await self.tool_response(tool["toolCallId"], tool["name"], {"status": "cancelled", "reason": "Approval expired."})
            except HTTPException:
                await self.service.stop(self.id)
                return

    async def provider_loop(self):
        attempts = 0
        while not self.closed:
            self.provider_ready = False
            self.screen_sharing = False
            self.frame_received = False
            if not self.handle:
                self.response_outbox.clear()
            status = "connecting" if attempts == 0 else "reconnecting"
            self.repo.change(self.id, status=status)
            await self.emit("session", status=status)
            try:
                async with asyncio.timeout(25):
                    factory = self.service.openai_provider_factory if self.profile["id"] == "openai" else self.service.provider_factory
                    provider_instance = factory() if factory else (self.service._openai_provider(self.config)
                        if self.profile["id"] == "openai" else GeminiLiveProvider(self.config))
                    context = provider_instance.connect(self.handle)
                    provider = await context.__aenter__()
                try:
                    self.check()
                    self.provider = provider
                    await self.send_context(include_history=not self.handle)
                    await self.flush_tool_responses()
                    self.check()
                    self.provider_ready = True
                    self.repo.change(self.id, status="ready")
                    await self.emit("session", status="ready")
                    while not self.closed:
                        # SDK receive() ends at IDLE; the session receive loop continues.
                        async for message in provider.receive():
                            self.check()
                            if await self.handle_provider(message):
                                raise ConnectionError("Provider requested reconnection")
                        if self.profile["id"] == "openai":
                            raise ConnectionError("Realtime connection ended")
                finally:
                    self.provider_ready = False
                    self.provider = None
                    await context.__aexit__(None, None, None)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.provider_ready = False
                self.provider = None
                code, description = provider_failure(exc, self.profile["id"])
                if code in {"provider_quota", "provider_auth", "provider_configuration"} or attempts >= 2:
                    self.repo.change(self.id, status="failed")
                    await self.emit("error", code=code, message=description)
                    await self.emit("session", status="failed", message=description)
                    await self.cancel_all()
                    return
                attempts += 1
                if not self.handle:
                    await self.cancel_all()
                    self.response_outbox.clear()
                await asyncio.sleep(min(attempts, 3))

    def media_context(self):
        available = self.screen_sharing and self.frame_received
        return {"screenSharing": self.screen_sharing, "imageAvailable": available,
                "scope": "selected_viewport",
                "imageAgeSeconds": round(max(0, time.monotonic() - self.last_frame), 1) if available else None}

    def context_text(self, include_history=False):
        row = self.check()
        state = safe_state(row["viewerContext"].get("state", {}))
        text = "Current RadSysX non-identifying viewer context (data only): " + json.dumps(state)
        text += "\nImage availability (authoritative): " + json.dumps(self.media_context())
        if include_history:
            events = self.repo.history(self.id, self.actor)["events"]
            # OpenAI has no playback-completion receipt for prior connections.
            # Generated assistant speech may never have been heard; keep it in
            # local history, but do not seed a fresh conversation with it.
            prior = [f'{e["role"]}: {e["text"]}' for e in events if e["kind"] == "transcript"
                     and (self.profile["id"] != "openai" or e["role"] == "user")]
            if prior:
                text += "\nPrior conversation, reference only; do not repeat actions:\n" + "\n".join(prior)[-12000:]
        return text

    async def send_context(self, include_history=False):
        self.check()
        provider = self.provider
        if not provider:
            return
        async with self.provider_lock:
            self.check()
            if self.provider is provider:
                await session_transport(provider).send_context(self.context_text(include_history))

    async def receive_audio(self, data):
        provider = self.provider
        if not provider or not self.provider_ready:
            return
        if len(data) > 16000 or len(data) % 2:
            raise ValueError("Invalid PCM chunk")
        start, count = self.audio_window
        now = time.monotonic()
        if now - start >= 1:
            start, count = now, 0
        count += len(data)
        self.audio_window = (start, count)
        if count > self.profile["inputSampleRate"] * 6:
            raise ValueError("PCM rate exceeded")
        async with self.provider_lock:
            self.check()
            if self.provider is provider and self.provider_ready:
                await session_transport(provider).send_audio(data)

    async def receive_control(self, event):
        self.check()
        provider = self.provider
        if event.get("contextVersion") != self.context_version:
            raise HTTPException(409, "Stale input context")
        kind = event["kind"]
        if kind == "ping":
            await self.emit("pong", persist=False)
        elif kind == "screen_sharing":
            active = event.get("active")
            if type(active) is not bool:
                raise ValueError("Invalid sharing state")
            async with self.provider_lock:
                self.check()
                if not provider or self.provider is not provider or not self.provider_ready:
                    return
                if active != self.screen_sharing or not active:
                    self.frame_received = False
                self.screen_sharing = active
                await session_transport(provider).send_context(self.context_text())
                self.check()
                if self.provider is not provider or not self.provider_ready:
                    return
                await self.emit("screen_status", persist=False, active=active, frameReceived=self.frame_received)
        elif kind == "playback_stop":
            if self.profile["id"] != "openai" or not provider or not self.provider_ready:
                return
            item_id, index, end_ms = event.get("itemId"), event.get("contentIndex"), event.get("audioEndMs")
            if (not isinstance(item_id, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", item_id)
                    or type(index) is not int or not 0 <= index <= 16
                    or type(end_ms) is not int or not 0 <= end_ms <= 3600000):
                raise ValueError("Invalid playback receipt")
            async with self.provider_lock:
                self.check()
                if self.provider is provider and self.provider_ready:
                    await session_transport(provider).interrupt(item_id, index, end_ms)
        elif kind == "action_result":
            tool_id = event["toolCallId"]
            future = self.pending_actions.get(tool_id)
            tool = self.repo.tool(self.id, tool_id)
            if future is None or future.done() or tool["status"] != "running":
                raise ValueError("Unexpected action acknowledgment")
            if event.get("status") not in {"completed", "failed"}:
                raise ValueError("Invalid action status")
            result = bound_json(event.get("result", {}), 32768)
            # Preserve only bounded, normalized viewer evidence.
            future.set_result({"status": event["status"], "result": safe_state(result)})
        elif kind in {"text", "audio_end", "screen"}:
            if not provider or not self.provider_ready:
                return
            async with self.provider_lock:
                self.check()
                if self.provider is not provider or not self.provider_ready:
                    return
                if kind == "text":
                    text = event.get("text", "")
                    if not isinstance(text, str) or not 0 < len(text.strip()) <= 4000:
                        raise ValueError("Invalid text")
                    await self.emit("transcript", role="user", text=text, finished=True, turnId=uuid4().hex)
                    self.check()
                    if self.provider is not provider or not self.provider_ready:
                        return
                    await session_transport(provider).send_text(text)
                elif kind == "audio_end":
                    await session_transport(provider).end_audio()
                else:
                    if not self.screen_sharing:
                        raise ValueError("Start image sharing before sending a frame")
                    now = time.monotonic()
                    if now - self.last_frame < 0.95:
                        raise ValueError("Screen rate exceeded")
                    if event.get("mimeType") not in {"image/jpeg", "image/png"}:
                        raise ValueError("Invalid screen type")
                    data = base64.b64decode(event["data"], validate=True)
                    if not 0 < len(data) <= 256000:
                        raise ValueError("Screen too large")
                    if not (data.startswith(b"\xff\xd8\xff") or data.startswith(b"\x89PNG\r\n\x1a\n")):
                        raise ValueError("Invalid image")
                    await session_transport(provider).send_image(data, event["mimeType"])
                    self.check()
                    if self.provider is not provider or not self.provider_ready:
                        return
                    first = not self.frame_received
                    self.last_frame = now
                    self.frame_received = True
                    if first:
                        await session_transport(provider).send_context(self.context_text())
                    self.check()
                    if self.provider is not provider or not self.provider_ready:
                        return
                    await self.emit("screen_status", persist=False, active=True, frameReceived=True)
        else:
            raise ValueError("Unknown input")

    async def handle_provider(self, message):
        if isinstance(message, dict):
            return await self.handle_normalized_provider(message)
        content = message.server_content
        if content:
            if content.interaction_status == "IN_PROGRESS" and not self.interaction_active:
                self.interaction_id = uuid4().hex
                self.interaction_active = True
            if content.interrupted:
                await self.emit("interrupted")
                self.turn_ids = {"user": uuid4().hex, "assistant": uuid4().hex}
            # Do not early-return: interrupted events may contain a new user transcript.
            text_parts = []
            for part in content.model_turn.parts if content.model_turn else []:
                if part.text and not getattr(part, "thought", False):
                    text_parts.append(part.text)
                if part.inline_data and not getattr(part, "thought", False):
                    if (part.inline_data.mime_type or "").startswith("audio/pcm"):
                        await self.audio(part.inline_data.data)
            if text_parts and not content.output_transcription:
                await self.emit("transcript", role="assistant", text="".join(text_parts)[:16000],
                    finished=bool(content.turn_complete), turnId=self.turn_ids["assistant"])
                if content.turn_complete:
                    self.turn_ids["assistant"] = uuid4().hex
            for role, transcription in (("user", content.input_transcription), ("assistant", content.output_transcription)):
                if transcription:
                    await self.emit("transcript", role=role, text=(transcription.text or "")[:16000],
                        finished=bool(transcription.finished), turnId=self.turn_ids[role])
                    if transcription.finished:
                        self.turn_ids[role] = uuid4().hex
            if content.interaction_status in {"IDLE", "IN_PROGRESS"}:
                await self.emit("interaction", status=content.interaction_status)
                if content.interaction_status == "IDLE":
                    self.interaction_active = False
            if content.grounding_metadata:
                metadata = content.grounding_metadata
                sources = []
                for index, chunk in enumerate(metadata.grounding_chunks or []):
                    web = chunk.web
                    url = public_url(web.uri) if web else None
                    if url:
                        sources.append({"id": f"source-{index}", "title": (web.title or "Source")[:256], "url": url})
                suggestions = metadata.search_entry_point.rendered_content if metadata.search_entry_point else None
                await self.emit("citations", sources=sources, suggestionsHtml=(suggestions or "")[:64000])
        if message.session_resumption_update:
            update = message.session_resumption_update
            self.handle = update.new_handle if update.resumable else None
        if message.tool_call_cancellation:
            for tool_id in message.tool_call_cancellation.ids or []:
                try:
                    await self.cancel(tool_id)
                except HTTPException:
                    pass
        if message.tool_call:
            for call in message.tool_call.function_calls or []:
                await self.schedule_tool(call)
        return bool(message.go_away)

    async def handle_normalized_provider(self, message):
        kind = message.get("kind")
        if kind == "audio":
            data = message["data"]
            if not isinstance(data, bytes) or len(data) > 1024 * 1024 or len(data) % 2:
                raise ValueError("Invalid provider audio")
            await self.audio(data, marker={"itemId": message["itemId"], "contentIndex": message["contentIndex"]})
        elif kind == "transcript":
            await self.emit("transcript", role=message["role"], text=message["text"][:16000],
                            finished=message["finished"], turnId=message["turnId"])
        elif kind == "interaction":
            status = message["status"]
            if status == "IN_PROGRESS" and not self.interaction_active:
                self.interaction_id = uuid4().hex
            self.interaction_active = status == "IN_PROGRESS"
            await self.emit("interaction", status=status)
        elif kind == "interrupted":
            await self.emit("interrupted")
        elif kind == "tool_call":
            await self.schedule_tool(SimpleNamespace(id=message.get("id"), name=message.get("name"), args=message.get("args")))
        elif kind == "error":
            # Only normalized transport error categories cross this boundary.
            error = RuntimeError("OpenAI transport error")
            error.code = message.get("code")
            code, description = provider_failure(error, "openai")
            await self.emit("error", code=code, message=description)
        return False

    async def tool_response(self, tool_id, name, result):
        self.check()
        # Transport delivery is separate from the recorded action outcome. A
        # dropped provider socket must never turn a successful save into failure.
        self.response_outbox[tool_id] = (name, result)
        await self.flush_tool_responses()

    async def flush_tool_responses(self):
        async with self.provider_lock:
            while self.provider and self.response_outbox:
                tool_id, (name, result) = next(iter(self.response_outbox.items()))
                try:
                    await asyncio.wait_for(session_transport(self.provider).send_tool_result(tool_id, name, result), 5)
                except Exception:
                    # Keep only application tool results in memory for the next
                    # handle-resumed setup; never repeat the underlying action.
                    return
                self.response_outbox.pop(tool_id, None)

    async def schedule_tool(self, call):
        self.check()
        tool_id = call.id
        if not isinstance(tool_id, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", tool_id):
            await self.emit("error", code="invalid_tool_call", message="The provider supplied no usable tool call identifier. No action was executed.")
            return
        try:
            tool, fresh = self.service.actions.prepare(self.id, tool_id, call.name, call.args or {}, self.actor,
                context_version=self.context_version)
        except (ValueError, HTTPException):
            await self.tool_response(tool_id, call.name, {"error": "Unsupported tool, invalid arguments or reused identity."})
            return
        if not fresh:
            if tool["status"] in TERMINAL_TOOLS:
                await self.tool_response(tool_id, call.name, {"status": tool["status"], "result": tool["result"]})
            return
        if len(self.repo.active_tools(self.id)) > 16:
            tool = self.repo.set_tool(self.id, tool_id, "failed", {"message": "Too many concurrent tools."})
            await self.emit("tool", **tool)
            await self.tool_response(tool_id, call.name, {"error": "Too many concurrent tools."})
            return
        await self.emit("tool", **tool)
        if not tool["requiresApproval"] and self.repo.tool(self.id, tool_id)["status"] == "pending":
            self.tasks[tool_id] = asyncio.create_task(self.execute(tool))

    async def decide(self, tool_id, request):
        self.check()
        tool = self.service.actions.decide(self.id, tool_id, request, self.actor)
        if request.approved:
            self.tasks[tool_id] = asyncio.create_task(self.execute(tool))
        else:
            await self.tool_response(tool_id, tool["name"], {"status": "denied"})
        await self.emit("tool", **tool)
        return tool

    async def execute(self, tool):
        tool_id, name, args = tool["toolCallId"], tool["name"], tool["args"]
        try:
            self.check()
            if self.repo.tool(self.id, tool_id)["status"] != "pending":
                return
            tool = self.repo.set_tool(self.id, tool_id, "running")
            await self.emit("tool", **tool)
            if name == "research_run":
                from .ai_research import RESEARCH_PROGRESS_STAGES, ResearchSupervisor
                provider, key, model = self.config.research_configuration()
                worker = ResearchSupervisor(api_key=key, model=model, provider=provider)
                self.repo.record_research_generation(self.id, tool_id, provider=provider, model=model)
                await self.emit("tool", **self.repo.tool(self.id, tool_id))
                async def research_progress(progress):
                    self.check()
                    stage = progress.get("stage")
                    if stage in RESEARCH_PROGRESS_STAGES and self.repo.tool(self.id, tool_id)["status"] == "running":
                        await self.emit("research_progress", toolCallId=tool_id, stage=stage)
                await research_progress({"stage": "queued"})
                if provider == "codex":
                    async with asyncio.timeout(120):
                        result = await self.service.codex.run(self.actor, model, args["query"], research=True, on_progress=research_progress)
                else:
                    result = await worker.run(args["query"], on_progress=research_progress)
                if result.get("sources"):
                    await self.emit("citations", sources=result["sources"], suggestionsHtml=result.get("suggestionsHtml", ""))
            elif name == "research_cancel":
                result = await self.cancel(args["toolCallId"], notify_provider=True)
            elif name == "viewer_get_state":
                result = {"state": safe_state(self.check()["viewerContext"].get("state", {}))}
                result["imageAvailability"] = self.media_context()
                self.study_aliases = {f"study-{i}": row.study_instance_uid for i, row in enumerate(self.service.clinical_repository.list_worklist())}
                result["studies"] = [{"studyId": key, "label": f"Worklist study {i + 1}"} for i, key in enumerate(self.study_aliases)]
            elif name == "study_open":
                if "study.read" not in self.actor.scopes or args["studyId"] not in self.study_aliases:
                    raise HTTPException(403, "Choose an available worklist study.")
                launch = await self.service.clinical.launch_imaging(ImagingLaunchRequest(
                    studyInstanceUID=self.study_aliases[args["studyId"]]), actor=self.actor, source_ip="live-sidebar")
                # Opaque launch URL goes only to the renderer, never back to Google/history.
                result = await self.renderer_action(tool_id, name, {"url": launch.viewer_url})
            else:
                result = await self.service.actions.execute(self.id, tool_id, self.actor,
                    check=self.check, dispatch=self.renderer_action)
                tool = self.repo.tool(self.id, tool_id)
                await self.emit("tool", **tool)
                await self.tool_response(tool_id, name, {"status": tool["status"], "result": result})
                return
            self.check()
            if self.repo.tool(self.id, tool_id)["status"] in TERMINAL_TOOLS:
                return
            status = "failed" if result.get("status") == "failed" or result.get("error") else "completed"
            tool = self.repo.set_tool(self.id, tool_id, status, result)
            await self.emit("tool", **tool)
            await self.tool_response(tool_id, name, {"status": status, "result": result})
        except asyncio.CancelledError:
            raise
        except (asyncio.TimeoutError, ConnectionError):
            if self.repo.tool(self.id, tool_id)["status"] in TERMINAL_TOOLS:
                return  # A lost notification cannot rewrite a committed receipt.
            status = "outcome_unknown" if name.startswith("viewer_") or name in {"report_draft", "study_open"} else "failed"
            tool = self.repo.set_tool(self.id, tool_id, status, {"message": "No completion receipt. The action was not retried."})
            await self.emit("tool", **tool)
            try:
                await self.tool_response(tool_id, name, {"status": status})
            except Exception:
                pass
        except Exception as error:
            if self.repo.tool(self.id, tool_id)["status"] in TERMINAL_TOOLS:
                return
            message = error.detail if isinstance(error, HTTPException) else "The tool could not complete. No automatic retry was performed."
            tool = self.repo.set_tool(self.id, tool_id, "failed", {"message": message})
            await self.emit("tool", **tool)
            try:
                await self.tool_response(tool_id, name, {"status": "failed", "message": message})
            except Exception:
                pass
        finally:
            self.tasks.pop(tool_id, None)

    async def renderer_action(self, tool_id, name, args):
        if self.websocket is None:
            raise ConnectionError("No viewer")
        future = asyncio.get_running_loop().create_future()
        self.pending_actions[tool_id] = future
        try:
            await self.emit("viewer_action", persist=False, toolCallId=tool_id, name=name, args=args)
            return await asyncio.wait_for(future, 15)
        finally:
            self.pending_actions.pop(tool_id, None)

    async def cancel(self, tool_id, *, notify_provider=False):
        tool = self.repo.tool(self.id, tool_id)
        if tool["status"] in TERMINAL_TOOLS:
            return tool
        dispatched = tool_id in self.pending_actions
        task = self.tasks.pop(tool_id, None)
        if task and task is not asyncio.current_task():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        status = "outcome_unknown" if dispatched else "cancelled"
        tool = self.repo.set_tool(self.id, tool_id, status)
        await self.emit("tool", **tool)
        if notify_provider:
            await self.tool_response(tool_id, tool["name"], {"status": status})
        return tool

    async def cancel_all(self):
        for tool in self.repo.active_tools(self.id):
            await self.cancel(tool["toolCallId"])

    async def close(self, status):
        if self.closed:
            return
        self.closed = True
        self.provider_ready = False
        self.screen_sharing = False
        self.frame_received = False
        await self.cancel_all()
        for task in (self.provider_task, self.expiry_task, self.detached_task):
            if task and task is not asyncio.current_task():
                task.cancel()
        await asyncio.gather(*(t for t in (self.provider_task, self.expiry_task, self.detached_task) if t and t is not asyncio.current_task()), return_exceptions=True)
        self.repo.change(self.id, status=status, attestation=None)
        await self.emit("session", status=status)
        if self.websocket:
            try:
                await self.websocket.close(code=1000)
            except Exception:
                pass
        self.websocket = None
