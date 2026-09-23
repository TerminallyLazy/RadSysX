"""Bounded, nonreflecting same-origin routes for explicit public evidence review."""
from fastapi import APIRouter, HTTPException, Request
from fastapi.routing import APIRoute
from fastapi.responses import JSONResponse
from .ai_evidence_contracts import EvidencePrepareRequest, EvidenceStartRequest, EvidenceRetryRequest
if __package__ == 'clinical':
    from evidence_review.serialization import parse_json
else:
    from ..evidence_review.serialization import parse_json


class PrivateReviewRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()
        async def private(request):
            try:
                response = await handler(request)
            except HTTPException as error:
                response = JSONResponse({'detail': error.detail}, status_code=error.status_code)
            except Exception:
                # Never reflect or log provider/storage exceptions or rejected input.
                response = JSONResponse({'detail': 'Evidence review is temporarily unavailable.'}, status_code=500)
            response.headers['Cache-Control'] = 'no-store'
            return response
        return private


async def read_body(request, model=None, *, max_bytes=16384):
    try:
        size = request.headers.get('content-length')
        if size is not None and (not size.isdecimal() or int(size)>max_bytes): raise ValueError()
        body = bytearray()
        async for chunk in request.stream():
            if len(body)+len(chunk)>max_bytes: raise ValueError()
            body.extend(chunk)
        if not body and model is None: return None
        if request.headers.get('content-type','').split(';',1)[0].strip().lower()!='application/json': raise ValueError()
        payload = parse_json(bytes(body),max_bytes=max_bytes)
        if not isinstance(payload,dict): raise ValueError()
        if model is None:
            if payload: raise ValueError()
            return None
        # JSON validation permits JSON arrays for strict tuple fields; parse_json
        # above has already rejected duplicate keys, NaN and invalid Unicode.
        return model.model_validate_json(bytes(body))
    except (ValueError, TypeError, UnicodeError, RecursionError):
        raise HTTPException(422,'Provide a valid evidence review request.') from None


def evidence_router(service, actor_for_request):
    router = APIRouter(route_class=PrivateReviewRoute)

    def actor(request):
        claims = actor_for_request(request)
        service.require(claims)
        if request.method!='GET' and request.headers.get('origin') not in service.live.platform.allowed_origins:
            raise HTTPException(403,'An allowed Origin is required to change evidence reviews.')
        if request.query_params or any(not 1<=len(value)<=160 for value in request.path_params.values()):
            raise HTTPException(422,'Provide a valid evidence review identifier.')
        return claims

    def response(value):
        return JSONResponse(value.model_dump(mode='json',by_alias=True))

    @router.post('/sessions/{session_id}/tools/{tool_id}/evidence-reviews')
    async def prepare(session_id:str,tool_id:str,request:Request):
        claims=actor(request)
        payload=await read_body(request,EvidencePrepareRequest)
        return response(await service.prepare(claims,session_id,tool_id,payload))

    @router.get('/sessions/{session_id}/evidence-reviews')
    async def list_reviews(session_id:str,request:Request):
        return response(service.list(actor(request),session_id))

    @router.get('/evidence-reviews/{review_id}')
    async def detail(review_id:str,request:Request):
        return response(service.get(actor(request),review_id))

    @router.post('/evidence-reviews/{review_id}/start')
    async def start(review_id:str,request:Request):
        claims=actor(request)
        payload=await read_body(request,EvidenceStartRequest)
        return response(await service.start(claims,review_id,payload))

    @router.post('/evidence-reviews/{review_id}/retry')
    async def retry(review_id:str,request:Request):
        claims=actor(request)
        payload=await read_body(request,EvidenceRetryRequest)
        return response(await service.retry(claims,review_id,payload))

    @router.post('/evidence-reviews/{review_id}/cancel')
    async def cancel(review_id:str,request:Request):
        claims=actor(request)
        await read_body(request)
        return response(await service.cancel(claims,review_id))

    return router
