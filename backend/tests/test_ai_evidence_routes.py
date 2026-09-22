"""Real router/service, synthetic HTTP and isolated owned persistence."""
import asyncio
import json
from datetime import timedelta

import httpx
import pytest
from backend.tests.test_ai_live import live, authorize, ORIGIN
from backend.tests.test_ai_evidence_review import review, seed_research, ready, start_request
from backend.clinical.contracts import to_iso_z, utc_now

ROOT='/api/ai/sidebar'


def client_for(review, actor=None):
    client=httpx.AsyncClient(transport=httpx.ASGITransport(app=review.live.app),base_url=ORIGIN)
    authorize(client,review.live,actor)
    return client


def checked(response,status):
    assert response.status_code==status,response.text
    assert response.headers.get('cache-control')=='no-store'
    assert 'PRIVATE_SENTINEL' not in response.text
    return response.json()


@pytest.mark.parametrize('gate,status', [('missing',401),('expired',401),('scope',403),('foreign',404),('clinical',403),('disabled',403),('origin',403)])
def test_all_paths_fail_before_external_work(review,gate,status):
    async def scenario():
        detail=await ready(review); count=len(review.http.requests)
        actor=review.actor
        if gate=='expired': actor=actor.model_copy(update={'expires_at':to_iso_z(utc_now()-timedelta(seconds=1))})
        if gate=='scope': actor=actor.model_copy(update={'scopes':[]})
        if gate=='foreign': actor=actor.model_copy(update={'sub':'foreign'})
        if gate=='clinical': review.live.service.config.app_mode='clinical'
        if gate=='disabled': review.live.service.config.enabled=False
        async with client_for(review,actor) as client:
            if gate=='missing': client.cookies.clear()
            paths=[('POST',f'/sessions/{detail.session_id}/tools/{detail.tool_call_id}/evidence-reviews'),
                ('GET',f'/sessions/{detail.session_id}/evidence-reviews'),('GET',f'/evidence-reviews/{detail.review_id}')]
            paths += [('POST',f'/evidence-reviews/{detail.review_id}/{action}') for action in ('start','retry','cancel')]
            for method,path in paths:
                response=await client.request(method,ROOT+path,content=b'{"PRIVATE_SENTINEL":0}',
                    headers={'origin':'https://hostile.test' if gate=='origin' else ORIGIN,'content-type':'application/json'})
                # Foreign ownership follows body validation on writes; provide valid bodies.
                if gate=='foreign' and method=='POST' and not path.endswith('/cancel'):
                    payload={'idempotencyKey':'other'} if path.endswith('evidence-reviews') else start_request(detail).model_dump(mode='json',by_alias=True)
                    if path.endswith('/retry'): payload.pop('selectedUnitIds')
                    response=await client.post(ROOT+path,json=payload,headers={'origin':ORIGIN})
                if gate=='foreign' and path.endswith('/cancel'):
                    response=await client.post(ROOT+path,headers={'origin':ORIGIN})
                checked(response,status)
        assert len(review.http.requests)==count
    asyncio.run(scenario())


@pytest.mark.parametrize('body', [b'[]',b'{"idempotencyKey":"x","idempotencyKey":"y"}',b'{"idempotencyKey":NaN}',
    b'{"idempotencyKey":"x","text":"PRIVATE_SENTINEL"}',b'\xff',b'{"idempotencyKey":"\\ud800"}',b' '*16385], ids=['array','duplicate','nan','extra','utf8','surrogate','oversize'])
def test_strict_bounded_nonreflecting_bodies(review,body):
    async def scenario():
        sid,tid=seed_research(review.live)
        async with client_for(review) as client:
            checked(await client.post(f'{ROOT}/sessions/{sid}/tools/{tid}/evidence-reviews',content=body,
                headers={'origin':ORIGIN,'content-type':'application/json'}),422)
        assert not review.http.requests
    asyncio.run(scenario())


def test_missing_origin_content_type_chunked_and_cancel_body(review):
    async def scenario():
        detail=await ready(review)
        async with client_for(review) as client:
            paths=[f'/sessions/{detail.session_id}/tools/{detail.tool_call_id}/evidence-reviews']+[f'/evidence-reviews/{detail.review_id}/{x}' for x in ('start','retry','cancel')]
            for path in paths:
                checked(await client.post(ROOT+path,json={}),403)
                checked(await client.post(ROOT+path,content=b'{"PRIVATE_SENTINEL":1}',headers={'origin':ORIGIN}),422)
                checked(await client.post(ROOT+path,json={'PRIVATE_SENTINEL':1},headers={'origin':ORIGIN}),422)
            async def chunks():
                for _ in range(17): yield b' '*1024
            checked(await client.post(ROOT+paths[0],content=chunks(),headers={'origin':ORIGIN,'content-type':'application/json'}),422)
            checked(await client.post(ROOT+paths[-1],json={},headers={'origin':ORIGIN}),200)
    asyncio.run(scenario())


def test_full_http_flow_and_source_delete_preserve_original(review):
    async def scenario():
        sid,tid=seed_research(review.live)
        async with client_for(review) as client:
            path=f'{ROOT}/sessions/{sid}/tools/{tid}/evidence-reviews'
            prepared=checked(await client.post(path,json={'idempotencyKey':'prepare'},headers={'origin':ORIGIN}),200)
            rid=prepared['reviewId']; await review.service.jobs[rid].task
            detail=checked(await client.get(f'{ROOT}/evidence-reviews/{rid}'),200)
            assert detail['status']=='ready' and not review.http.submitted
            assert checked(await client.post(path,json={'idempotencyKey':'prepare'},headers={'origin':ORIGIN}),200)['reviewId']==rid
            body={'idempotencyKey':'start','previewSha256':detail['previewSha256'],'confirmation':'synthetic','selectedUnitIds':[detail['claims'][0]['unitId']]}
            checked(await client.post(f'{ROOT}/evidence-reviews/{rid}/start',json=body,headers={'origin':ORIGIN}),200)
            if rid in review.service.jobs: await review.service.jobs[rid].task
            result=checked(await client.get(f'{ROOT}/evidence-reviews/{rid}'),200)
            assert result['status']=='completed' and result['originalAnswer']==detail['originalAnswer']
            checked(await client.post(f'{ROOT}/evidence-reviews/{rid}/start',json=body,headers={'origin':ORIGIN}),200)
            assert len(review.http.submitted)==1
            assert len(checked(await client.get(f'{ROOT}/sessions/{sid}/evidence-reviews'),200)['reviews'])==1
            assert (await client.get(ROOT+'/capabilities')).json()['evidenceReview']['availability']=='configured'
            assert (await client.post(f'{ROOT}/sessions/{sid}/close',headers={'origin':ORIGIN})).status_code==200
            checked(await client.get(f'{ROOT}/evidence-reviews/{rid}'),200)
            assert (await client.delete(f'{ROOT}/sessions/{sid}',headers={'origin':ORIGIN})).status_code==200
            checked(await client.get(f'{ROOT}/evidence-reviews/{rid}'),404)
            assert not any(review.service.root.iterdir())
    asyncio.run(scenario())


def test_unexpected_errors_are_fixed_private_and_ids_bounded(review,monkeypatch):
    async def scenario():
        async with client_for(review) as client:
            checked(await client.get(ROOT+'/evidence-reviews/'+('a'*161)),422)
            def fail(*args): raise RuntimeError('PRIVATE_SENTINEL')
            monkeypatch.setattr(review.service,'get',fail)
            checked(await client.get(ROOT+'/evidence-reviews/example'),500)
    asyncio.run(scenario())
