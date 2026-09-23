"""Explicit typed requests with optional Codex viewport input, private errors and bounded JSON input."""
from typing import Literal
from types import SimpleNamespace
from fastapi import APIRouter, HTTPException, Request
from fastapi.routing import APIRoute
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, model_validator
from .contracts import AISidebarViewerContext
from .ai_evidence_routes import read_body
from .ai_view_image import ViewImage


class TextSessionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    viewer_context: AISidebarViewerContext = Field(alias="viewerContext")
    attestation: Literal["synthetic", "deidentified"]


class TextTurnRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    context_version: int = Field(alias="contextVersion", ge=1)
    idempotency_key: str = Field(alias="idempotencyKey", pattern=r"^[A-Za-z0-9_-]{1,80}$")
    action: Literal["chat", "research"]
    text: str = Field(min_length=1, max_length=2000)
    image: ViewImage | None = None
    exploration_id: str | None = Field(default=None,alias='explorationId',pattern=r'^task-[A-Za-z0-9_-]{1,120}$')

    @model_validator(mode="after")
    def bounded(self):
        if self.image is not None and self.exploration_id is not None: raise ValueError('Choose one image scope')
        if not self.text.strip() or (self.action == "research" and len(self.text) > 1700):
            raise ValueError("Invalid text length")
        return self


class PrivateTextRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()
        async def private(request):
            try:
                response = await handler(request)
            except HTTPException as error:
                response = JSONResponse({"detail": error.detail if error.status_code != 422 else "Provide a valid text/research request."}, status_code=error.status_code)
            except Exception:
                response = JSONResponse({"detail": "Text chat is temporarily unavailable."}, status_code=500)
            response.headers["Cache-Control"] = "no-store"
            return response
        return private


def text_router(live, actor_for_request):
    router = APIRouter(route_class=PrivateTextRoute)
    def actor(request):
        claims = actor_for_request(request)
        live.require_research_settings(claims)
        if request.headers.get("origin") not in live.platform.allowed_origins:
            raise HTTPException(403, "An allowed Origin is required for text chat and research.")
        return claims

    @router.post("/text-sessions")
    async def create(request: Request):
        claims = actor(request)
        payload = await read_body(request, TextSessionRequest)
        return await live.text.create(payload, claims)

    @router.post("/sessions/{session_id}/text-turns")
    async def start(session_id: str, request: Request):
        claims = actor(request)
        row = live.repository.owned(session_id, claims, active=True)
        payload = await read_body(request, TextTurnRequest, max_bytes=720000)
        if row.get("mode") != "text":
            if payload.image is not None or payload.exploration_id is not None:
                raise HTTPException(409, "Attach current view in a separate text conversation. Voice has its own image-sharing control.")
            async with live.owner_lock(claims):
                async with live.session_lock(session_id):
                    row = live.repository.owned(session_id, claims, active=True)
                    runtime = live.runtimes.get(session_id)
                    if payload.action != "research" or not runtime or row["contextVersion"] != payload.context_version:
                        raise HTTPException(409, "Start a text conversation or reconnect voice before using this session.")
                    runtime.check()
                    try:
                        prior = live.repository.tool(session_id, "typed-" + payload.idempotency_key)
                    except HTTPException as error:
                        if error.status_code != 404: raise
                    else:
                        if prior["name"] != "research_run" or prior["args"] != {"query": payload.text} or prior["contextVersion"] != payload.context_version:
                            raise HTTPException(409, "This request identity belongs to another turn.")
                        return prior
                    await runtime.schedule_tool(SimpleNamespace(id="typed-" + payload.idempotency_key, name="research_run", args={"query": payload.text}))
                    return live.repository.tool(session_id, "typed-" + payload.idempotency_key)
        return await live.text.start(session_id, payload, claims)

    return router
