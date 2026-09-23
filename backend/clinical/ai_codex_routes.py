"""Owned subscription status and official browser login; never a raw RPC proxy."""
from fastapi import APIRouter, HTTPException, Request
from fastapi.routing import APIRoute
from fastapi.responses import JSONResponse
from .ai_evidence_routes import read_body
from .contracts import AICodexAccount


class PrivateCodexRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()
        async def private(request):
            try: response = await handler(request)
            except HTTPException as error:
                response = JSONResponse({"detail": error.detail if error.status_code != 422 else "Provide a valid subscription request."}, status_code=error.status_code)
            except Exception:
                response = JSONResponse({"detail": "Codex is unavailable. Check the desktop installation and OS keyring, then retry."}, status_code=503)
            response.headers["Cache-Control"] = "no-store"
            return response
        return private


def codex_router(live, actor_for_request):
    router = APIRouter(route_class=PrivateCodexRoute)
    def actor(request):
        claims = actor_for_request(request)
        live.require_research_settings(claims)
        if request.method != "GET" and request.headers.get("origin") not in live.platform.allowed_origins:
            raise HTTPException(403, "An allowed Origin is required to change subscription sign-in.")
        if request.query_params: raise HTTPException(422, "Unexpected query.")
        return claims

    @router.get("/codex/account", response_model=AICodexAccount)
    async def status(request: Request): return await live.codex.status(actor(request))

    @router.post("/codex/login")
    async def login(request: Request):
        claims = actor(request)
        await read_body(request, None)
        return await live.codex.login(claims)

    @router.post("/codex/logout", response_model=AICodexAccount)
    async def logout(request: Request):
        claims = actor(request)
        await read_body(request, None)
        return await live.codex.signout(claims)

    return router
