"""Same-origin, signed-cookie AI API; no provider credentials reach the browser."""
from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException, Request, WebSocket
from fastapi.responses import JSONResponse

from .ai_evidence_routes import evidence_router
from .ai_text_routes import text_router
from .ai_codex_routes import codex_router
from .ai_exploration_routes import exploration_router
from .ai_config import PROVIDER_PROFILES
from .ai_credentials import validate_api_key
from .contracts import (AIResearchSettings, AIResearchModels, AICredentialStatusResponse, AILiveContextUpdate, AILiveDecision,
                        AISidebarSessionCreateRequest)


def live_router(service, session_manager):
    router = APIRouter(prefix="/api/ai/sidebar")

    def actor(request, *, require_ai=True):
        claims = session_manager.loads(request.cookies.get(session_manager.cookie_name))
        if claims is None:
            raise HTTPException(401, "Clinical session required.")
        if require_ai:
            service.require_actor(claims)
        # Origin check is required for WS and checked for all browser writes.
        origin = request.headers.get("origin")
        if origin and origin not in service.platform.allowed_origins:
            raise HTTPException(403, "Origin is not allowed.")
        return claims

    @router.get("/capabilities")
    async def capabilities(request: Request):
        return service.capabilities(actor(request))

    def credential_actor(request, *, write=False):
        claims = actor(request)
        if write and request.headers.get("origin") not in service.platform.allowed_origins:
            raise HTTPException(403, "An allowed Origin is required to change API key settings.")
        return claims

    def private_error(error):
        # Exception responses do not inherit a normal Response's headers.
        error.headers = {**(error.headers or {}), "Cache-Control": "no-store"}
        return error

    @router.get("/research-settings", response_model=AIResearchSettings)
    async def research_settings(request: Request):
        try:
            claims = actor(request)
            if service.config_for(claims).research_provider == "codex":
                try: await service.codex.status(claims)
                except Exception: pass  # Preserve the selected model, marked unavailable.
            return JSONResponse(service.research_settings(claims), headers={"Cache-Control":"no-store"})
        except HTTPException as error:
            raise private_error(error)

    @router.get("/research-settings/models/{provider_id}", response_model=AIResearchModels)
    async def research_models(provider_id: str, request: Request, refresh: bool = False):
        try:
            result = await service.research_models(actor(request), provider_id, refresh=refresh)
            return JSONResponse(result, headers={"Cache-Control":"no-store"})
        except HTTPException as error:
            raise private_error(error)

    @router.put("/research-settings", response_model=AIResearchSettings)
    async def save_research_settings(request: Request):
        try:
            claims = actor(request)
            if request.headers.get("origin") not in service.platform.allowed_origins:
                raise HTTPException(403, "An allowed Origin is required to change research settings.")
            try:
                body = bytearray()
                async for chunk in request.stream():
                    if len(body) + len(chunk) > 1024: raise ValueError()
                    body.extend(chunk)
                payload = json.loads(body)
                if not isinstance(payload, dict) or set(payload) != {"providerId", "modelId"}: raise ValueError()
                provider, model = payload["providerId"], payload["modelId"]
                if not isinstance(provider, str) or not isinstance(model, str): raise ValueError()
            except (ValueError, TypeError, KeyError, UnicodeError, RecursionError):
                raise HTTPException(422, "Choose a supported research provider and model.") from None
            result = await service.change_research_settings(claims, provider, model)
            return JSONResponse(result, headers={"Cache-Control":"no-store"})
        except HTTPException as error:
            raise private_error(error)

    @router.get("/credentials", response_model=AICredentialStatusResponse)
    async def credentials(request: Request):
        try:
            result = service.credential_status(credential_actor(request))
            return JSONResponse(result, headers={"Cache-Control": "no-store"})
        except HTTPException as error:
            raise private_error(error)

    @router.put("/credentials/{provider_id}", response_model=AICredentialStatusResponse)
    async def save_credential(provider_id: str, request: Request):
        try:
            claims = credential_actor(request, write=True)
            if provider_id not in PROVIDER_PROFILES:
                raise HTTPException(422, "Choose a supported AI provider.")
            # No automatic Pydantic body errors: they include the rejected
            # input. Bound the stream before decoding JSON or reading a key.
            try:
                if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
                    raise ValueError()
                size = request.headers.get("content-length")
                if size is not None and (not size.isdecimal() or int(size) > 8192):
                    raise ValueError()
                body = bytearray()
                async for chunk in request.stream():
                    if len(body) + len(chunk) > 8192:
                        raise ValueError()
                    body.extend(chunk)
                payload = json.loads(body)
                if not isinstance(payload, dict) or set(payload) != {"apiKey"}:
                    raise ValueError()
                key = validate_api_key(payload["apiKey"])
            except (ValueError, TypeError, KeyError, UnicodeError, RecursionError):
                raise HTTPException(422, "Enter a valid API key without spaces or control characters.") from None
            result = await service.change_credential(claims, provider_id, key)
            return JSONResponse(result, headers={"Cache-Control": "no-store"})
        except HTTPException as error:
            raise private_error(error)

    @router.delete("/credentials/{provider_id}", response_model=AICredentialStatusResponse)
    async def delete_credential(provider_id: str, request: Request):
        try:
            claims = credential_actor(request, write=True)
            result = await service.change_credential(claims, provider_id)
            return JSONResponse(result, headers={"Cache-Control": "no-store"})
        except HTTPException as error:
            raise private_error(error)

    @router.post("/sessions")
    async def create(payload: AISidebarSessionCreateRequest, request: Request):
        return service.create(payload, actor(request))

    @router.get("/sessions")
    async def sessions(request: Request):
        return {"sessions": service.repository.list(actor(request))}

    @router.get("/sessions/{session_id}")
    async def history(session_id: str, request: Request):
        return service.repository.history(session_id, actor(request))

    @router.post("/sessions/{session_id}/context")
    async def context(session_id: str, payload: AILiveContextUpdate, request: Request):
        return await service.update_context(session_id, payload, actor(request))

    @router.post("/sessions/{session_id}/close")
    async def close(session_id: str, request: Request):
        claims = actor(request)
        service.repository.owned(session_id, claims)
        await service.stop(session_id)
        return service.repository.owned(session_id, claims)

    @router.delete("/sessions/{session_id}")
    async def clear(session_id: str, request: Request):
        claims = actor(request)
        service.repository.owned(session_id, claims)
        if request.headers.get("origin") not in service.platform.allowed_origins:
            raise HTTPException(403, "An allowed Origin is required to delete conversation history.")
        await service.exploration.delete_source(session_id, claims)
        await service.evidence_reviews.delete_source(claims, session_id)
        return {"deleted": True}

    @router.post("/sessions/{session_id}/tools/{tool_id}/decision")
    async def decide(session_id: str, tool_id: str, payload: AILiveDecision, request: Request):
        claims = actor(request)
        service.repository.owned(session_id, claims, active=True)
        runtime = service.runtimes.get(session_id)
        if not runtime or not runtime.provider:
            raise HTTPException(409, "Reconnect the live session before reviewing this action.")
        return await runtime.decide(tool_id, payload)

    @router.post("/sessions/{session_id}/tools/{tool_id}/cancel")
    async def cancel(session_id: str, tool_id: str, request: Request):
        claims = actor(request)
        row = service.repository.owned(session_id, claims, active=True)
        if row.get("mode") == "text":
            if request.headers.get("origin") not in service.platform.allowed_origins:
                raise HTTPException(403, "An allowed Origin is required to cancel text work.")
            return await service.text.cancel(session_id, tool_id, claims)
        runtime = service.runtimes.get(session_id)
        if not runtime:
            raise HTTPException(409, "AI session is not active.")
        return await runtime.cancel(tool_id, notify_provider=True)

    @router.post("/sessions/{session_id}/messages")
    async def old_message(session_id: str, request: Request):
        service.repository.owned(session_id, actor(request), active=True)
        # Old HTTP callers must never mistake a deterministic response for inference.
        raise HTTPException(409, "Start a live assistant session and send text through its connection. The HTTP stub is retired.")

    @router.websocket("/sessions/{session_id}/live")
    async def live(websocket: WebSocket, session_id: str):
        try:
            if websocket.headers.get("origin") not in service.platform.allowed_origins:
                raise HTTPException(403, "Origin required.")
            claims = actor(websocket)
            await service.attach(websocket, session_id, claims)
        except HTTPException as error:
            await websocket.close(code=4401 if error.status_code == 401 else 4403,
                                  reason="AI session is unavailable or unauthorized.")
        except Exception:
            # Never let provider URLs, tokens or request contents enter ASGI logs.
            try:
                await websocket.close(code=1011, reason="AI connection ended.")
            except Exception:
                pass

    router.include_router(evidence_router(service.evidence_reviews, actor))
    router.include_router(text_router(service, actor))
    router.include_router(codex_router(service, actor))
    router.include_router(exploration_router(service.exploration, actor))
    return router
