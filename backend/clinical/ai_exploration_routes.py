"""Private, bounded, same-origin task/claim endpoints; GET never dispatches."""
from fastapi import APIRouter, HTTPException, Request
from fastapi.routing import APIRoute
from fastapi.responses import JSONResponse
from pydantic import Field
from .ai_evidence_routes import read_body
from .ai_exploration_contracts import (Record,ShareSelection,RendererBinding,SeriesManifest,
    ObservationResult,ActionResult,Handle,MAX_BATCH_BYTES)

class Decision(Record):
    context_version: int = Field(ge=1)
    approved: bool

class Prepare(Record):
    selection: ShareSelection
    binding: RendererBinding
class Poll(Record):
    binding: RendererBinding
    wait_seconds: int = Field(default=5,ge=0,le=20)
class Bound(Record):
    binding: RendererBinding
class ManifestCompletion(Bound):
    operation_id: Handle
    claim_id: Handle
    manifest: SeriesManifest
class Completion(Bound):
    result: ActionResult | ObservationResult

class PrivateExplorationRoute(APIRoute):
    def get_route_handler(self):
        handler=super().get_route_handler()
        async def private(request):
            try: response=await handler(request)
            except HTTPException as error:
                response=JSONResponse({'detail':error.detail if error.status_code!=422 else 'Provide a valid study task request.'},status_code=error.status_code)
            except Exception:
                response=JSONResponse({'detail':'The study task could not complete.'},status_code=500)
            response.headers['Cache-Control']='no-store'
            return response
        return private


def exploration_router(service, actor_for_request):
    router=APIRouter(route_class=PrivateExplorationRoute)
    prefix='/sessions/{session_id}/explorations'
    def actor(request,session_id,task_id=None):
        claims=actor_for_request(request); service.live.require_research_settings(claims)
        service.live.repository.owned(session_id,claims)
        if request.method!='GET' and request.headers.get('origin') not in service.live.platform.allowed_origins:
            raise HTTPException(403,'An allowed Origin is required for study exploration.')
        if request.query_params or any(len(value)>160 for value in request.path_params.values()): raise HTTPException(422,'Invalid identifier.')
        if task_id and service.owned(task_id,claims)['snapshot']['grant']['sessionId']!=session_id:
            raise HTTPException(404,'Study task not found.')
        return claims
    def response(value):
        return JSONResponse(value.wire() if hasattr(value,'wire') else value)

    @router.post(prefix)
    async def prepare(session_id:str,request:Request):
        claims=actor(request,session_id); body=await read_body(request,Prepare,max_bytes=65536)
        return response(await service.prepare(session_id,body.selection,body.binding,claims))

    @router.get(prefix+'/{task_id}')
    async def snapshot(session_id:str,task_id:str,request:Request):
        return response(await service.snapshot(task_id,actor(request,session_id,task_id)))

    @router.post(prefix+'/{task_id}/poll')
    async def poll(session_id:str,task_id:str,request:Request):
        claims=actor(request,session_id,task_id); body=await read_body(request,Poll,max_bytes=65536)
        commands=await service.poll(task_id,body.binding,claims,wait_seconds=body.wait_seconds)
        return response({'commands':[command.wire() for command in commands]})

    @router.post(prefix+'/{task_id}/commands/{operation_id}/claim')
    async def claim(session_id:str,task_id:str,operation_id:str,request:Request):
        claims=actor(request,session_id,task_id); body=await read_body(request,Bound,max_bytes=65536)
        return response(await service.claim(task_id,operation_id,body.binding,claims))

    @router.post(prefix+'/{task_id}/commands/{operation_id}/manifest')
    async def manifest(session_id:str,task_id:str,operation_id:str,request:Request):
        claims=actor(request,session_id,task_id); body=await read_body(request,ManifestCompletion,max_bytes=65536)
        if body.operation_id!=operation_id: raise HTTPException(409,'Operation mismatch.')
        return response(await service.complete_manifest(task_id,operation_id,body.claim_id,body.binding,body.manifest,claims))

    @router.post(prefix+'/{task_id}/commands/{operation_id}/result')
    async def result(session_id:str,task_id:str,operation_id:str,request:Request):
        claims=actor(request,session_id,task_id); body=await read_body(request,Completion,max_bytes=MAX_BATCH_BYTES+65536)
        if body.result.operation_id!=operation_id: raise HTTPException(409,'Operation mismatch.')
        if isinstance(body.result,ObservationResult):
            return response(await service.complete_observation(task_id,body.binding,body.result,claims))
        return response(await service.complete(task_id,body.binding,body.result,claims))

    @router.post(prefix+'/{task_id}/decisions/{operation_id}')
    async def decide(session_id:str,task_id:str,operation_id:str,request:Request):
        claims=actor(request,session_id,task_id); body=await read_body(request,Decision,max_bytes=65536)
        return response(await service.decide(task_id,operation_id,body,claims))

    @router.post(prefix+'/{task_id}/stop')
    async def stop(session_id:str,task_id:str,request:Request):
        claims=actor(request,session_id,task_id); await read_body(request,max_bytes=65536)
        return response(await service.revoke(task_id,claims))

    @router.post(prefix+'/{task_id}/takeover')
    async def takeover(session_id:str,task_id:str,request:Request):
        claims=actor(request,session_id,task_id); await read_body(request,max_bytes=65536)
        return response(await service.takeover(task_id,claims))

    @router.post(prefix+'/{task_id}/continue')
    async def continue_run(session_id:str,task_id:str,request:Request):
        claims=actor(request,session_id,task_id); body=await read_body(request,Prepare,max_bytes=65536)
        return response(await service.continue_run(task_id,body.selection,body.binding,claims))
    return router
