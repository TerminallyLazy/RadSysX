"""Voice-independent owned text/research contracts; no cloud calls."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from fastapi import HTTPException
from backend.tests.test_ai_live import live, authorize, ORIGIN, PREFIX, CONTEXT
from backend.clinical import ai_text, ai_research_worker
from backend.clinical.ai_text_routes import TextSessionRequest, TextTurnRequest
from backend.clinical.contracts import AILiveContextUpdate


@pytest.fixture
def anyio_backend(): return 'asyncio'


def session_request(**overrides):
    return TextSessionRequest.model_validate({'viewerContext': CONTEXT, 'attestation': 'synthetic', **overrides})


def turn(key='turn-one', action='chat', **overrides):
    return TextTurnRequest.model_validate({'contextVersion': 1, 'idempotencyKey': key, 'action': action, 'text': 'Explain this synthetic CT series.', **overrides})


def nim_only(monkeypatch, live):
    monkeypatch.delenv('RADSYSX_GEMINI_API_KEY', raising=False)
    monkeypatch.delenv('RADSYSX_OPENAI_API_KEY', raising=False)
    monkeypatch.setenv('RADSYSX_NVIDIA_API_KEY', 'synthetic-nim-key')
    monkeypatch.setenv('RADSYSX_RESEARCH_PROVIDER', 'nvidia_nim')
    monkeypatch.setenv('RADSYSX_NIM_RESEARCH_MODEL', 'z-ai/glm-5.3-flash')
    from backend.clinical.ai_config import AISettings
    live.service.config = AISettings()


@pytest.mark.anyio
async def test_no_realtime_keys_required_and_native_chat_keeps_model_context_history(live, monkeypatch):
    nim_only(monkeypatch, live)
    seen = []
    class Worker:
        def __init__(self, key, model, **kwargs): seen.append((key, model, kwargs))
        async def run(self, query, on_progress):
            await on_progress({'stage': 'waiting_model'})
            return {'summary': 'Synthetic text reply; no image supplied.', 'sources': []}
    monkeypatch.setattr(ai_text, 'ChatSupervisor', Worker)
    service = live.service.text
    row = await service.create(session_request(), live.actor)
    assert row['mode'] == 'text' and row['liveUrl'] is None and row['providerId'] == 'nvidia_nim'
    assert not row['voiceFirst'] and row['inputSampleRate'] is None
    for key in ('one', 'two'):
        receipt = await service.start(row['sessionId'], turn(key), live.actor)
        await asyncio.gather(*list(service.tasks.values()))
        assert service.repo.tool(row['sessionId'], key)['status'] == 'completed'
    assert seen[1][2]['history'][0]['role'] == 'user'
    assert seen[0][1] == 'z-ai/glm-5.3-flash'
    assert not live.service.runtimes and not live.provider.contexts
    history = service.repo.history(row['sessionId'], live.actor)
    assert history['tools'][0]['research']['providerId'] == 'nvidia_nim'
    assert any(event['kind'] == 'research_progress' for event in history['events'])
    assert len([e for e in history['events'] if e['kind'] == 'transcript']) == 4
    assert not service.tasks and not service.owners


@pytest.mark.anyio
async def test_explicit_research_uses_worker_without_prior_chat_or_identifiers(live, monkeypatch):
    seen = []
    class Worker:
        def __init__(self, *args, **kwargs): pass
        async def run(self, query, on_progress):
            seen.append(query)
            await on_progress({'stage': 'searching_pubmed'})
            return {'summary': 'Synthetic cited evidence [s1].', 'sources': [{'id':'s1','url':'https://pubmed.ncbi.nlm.nih.gov/123/','title':'Fixture'}]}
    monkeypatch.setattr(ai_text, 'ResearchSupervisor', Worker)
    context = {**CONTEXT, 'state': {'modality':'CT','imageCount':3,'PatientName':'PRIVATE','series':[{'modality':'MR','uid':'PRIVATE'}]}}
    row = await live.service.text.create(session_request(viewerContext=context), live.actor)
    await live.service.text.start(row['sessionId'], turn(action='research', text='Find public CT literature.'), live.actor)
    await asyncio.gather(*list(live.service.text.tasks.values()))
    assert 'CT' in seen[0] and 'PRIVATE' not in seen[0]
    result = live.service.repository.tool(row['sessionId'], 'turn-one')
    assert result['name'] == 'research_run' and result['status'] == 'completed'
    assert result['result']['sources'][0]['url'].endswith('/123/')


@pytest.mark.anyio
async def test_duplicate_identity_limits_cancel_before_start_and_context_stop(live, monkeypatch):
    class Worker:
        def __init__(self, *args, **kwargs): pass
        async def run(self, *args, **kwargs): await asyncio.sleep(10)
    monkeypatch.setattr(ai_text, 'ChatSupervisor', Worker)
    service = live.service.text
    row = await service.create(session_request(), live.actor); sid = row['sessionId']
    one = await service.start(sid, turn(), live.actor)
    assert (await service.start(sid, turn(), live.actor))['toolCallId'] == one['toolCallId']
    with pytest.raises(HTTPException) as conflict: await service.start(sid, turn(text='Different'), live.actor)
    assert conflict.value.status_code == 409
    with pytest.raises(HTTPException): await service.start(sid, turn('second'), live.actor)
    await service.cancel(sid, one['toolCallId'], live.actor)
    assert not service.tasks and not service.owners
    await service.start(sid, turn('second'), live.actor)
    await asyncio.sleep(0)
    await live.service.update_context(sid, AILiveContextUpdate.model_validate({'contextVersion':1, 'viewerContext':{**CONTEXT,'targetId':'another'}}), live.actor)
    assert not service.tasks and service.repo.tool(sid, 'second')['status'] == 'cancelled'
    with pytest.raises(HTTPException): await service.start(sid, turn('third'), live.actor)


def test_text_http_origin_private_body_ownership_and_no_voice(live, monkeypatch):
    nim_only(monkeypatch, live)
    with TestClient(live.app) as client:
        assert client.post(PREFIX+'/text-sessions', json={}).status_code == 401
        authorize(client, live)
        data = {'viewerContext':CONTEXT,'attestation':'synthetic'}
        assert client.post(PREFIX+'/text-sessions',json=data).status_code == 403
        response = client.post(PREFIX+'/text-sessions', json=data, headers={'origin':ORIGIN})
        assert response.status_code == 200, response.text
        assert response.headers['cache-control'] == 'no-store'
        sid = response.json()['sessionId']
        response = client.post(PREFIX+f'/sessions/{sid}/text-turns', content='{"text":"PRIVATE","text":"duplicate"}', headers={'origin':ORIGIN,'content-type':'application/json'})
        assert response.status_code == 422 and 'PRIVATE' not in response.text
        assert response.headers['cache-control'] == 'no-store'
        assert client.get(PREFIX+'/sessions/'+sid).json()['session']['mode'] == 'text'
        with pytest.raises(Exception):
            with client.websocket_connect(PREFIX+f'/sessions/{sid}/live', headers={'origin':ORIGIN}): pass
        assert not live.provider.contexts


@pytest.mark.anyio
async def test_chat_worker_calls_native_model_with_no_images_tools_or_retrieval_claims(monkeypatch):
    monkeypatch.setenv('NVIDIA_API_KEY','synthetic-key')
    invoke = AsyncMock(return_value=SimpleNamespace(content=[{'type':'reasoning','text':'PRIVATE_REASONING'},{'type':'text','text':'Synthetic answer.'}], usage_metadata={}))
    monkeypatch.setattr(ai_research_worker, 'create_chat_model', lambda *args: SimpleNamespace(ainvoke=invoke))
    events=[]
    result = await ai_research_worker.run_chat({'provider':'nvidia_nim','model':'z-ai/glm-5.3-flash','query':'What can you see?','context':{'modality':'CT'},'history':[]}, events.append)
    assert result['summary'] == 'Synthetic answer.' and not result['sources']
    prompt = invoke.call_args.args[0]
    assert 'No image pixels' in prompt[0]['content'] and 'no tools' in prompt[0]['content']
    assert events == [{'kind':'progress','stage':'waiting_model'}]


def test_metadata_and_unicode_worker_budget():
    context = ai_text.text_context({'modality':'CT','PatientName':'PRIVATE','index':1,'series':[{'modality':'MR','patientId':'PRIVATE'}]})
    assert 'PRIVATE' not in str(context)
    worker = ai_text.ChatSupervisor('synthetic','gemini-3.8-flash', context=context, history=[{'role':'user','content':'x'*8000},{'role':'assistant','content':'x'*8000}])
    request = worker.worker_request('😀'*2000)
    assert not request['history']


@pytest.mark.anyio
@pytest.mark.parametrize('stop_kind', ['close','owner','shutdown','expired'])
async def test_text_jobs_stop_at_owner_lifecycle_boundaries(live, monkeypatch, stop_kind):
    class Worker:
        def __init__(self,*args,**kwargs): pass
        async def run(self,*args,**kwargs): await asyncio.sleep(60)
    monkeypatch.setattr(ai_text, 'ChatSupervisor', Worker)
    service=live.service.text
    row=await service.create(session_request(), live.actor);sid=row['sessionId']
    actor=live.actor
    if stop_kind == 'expired':
        from backend.clinical.contracts import to_iso_z, utc_now
        from datetime import timedelta
        actor=actor.model_copy(update={'expires_at':to_iso_z(utc_now()+timedelta(milliseconds=40))})
    await service.start(sid, turn(), actor)
    await asyncio.sleep(0)
    if stop_kind=='close': await live.service.stop(sid)
    elif stop_kind=='owner': await live.service.stop_owner(live.actor)
    elif stop_kind=='shutdown': await live.service.shutdown()
    else: await asyncio.wait_for(asyncio.gather(*list(service.tasks.values())),1)
    assert not service.tasks and not service.owners
    assert service.repo.tool(sid,'turn-one')['status'] in {'cancelled','interrupted','failed'}
    service.repo.clear(sid, live.actor)
    with pytest.raises(HTTPException): service.repo.get(sid)


def test_text_http_rejects_other_owner_disabled_mode_and_patient_context(live):
    with TestClient(live.app) as client:
        authorize(client,live)
        body={'viewerContext':CONTEXT,'attestation':'synthetic'}
        response=client.post(PREFIX+'/text-sessions',json=body,headers={'origin':ORIGIN})
        sid=response.json()['sessionId']
        other=live.actor.model_copy(update={'sub':'other-test-owner'})
        authorize(client,live,other)
        response=client.post(PREFIX+f'/sessions/{sid}/text-turns',json=turn().model_dump(by_alias=True),headers={'origin':ORIGIN})
        assert response.status_code==404
        authorize(client,live)
        body['viewerContext']={**CONTEXT,'privacyClass':'phi-bearing'}
        assert client.post(PREFIX+'/text-sessions',json=body,headers={'origin':ORIGIN}).status_code==403
        live.service.config.app_mode='clinical'
        assert client.post(PREFIX+f'/sessions/{sid}/text-turns',json=turn().model_dump(by_alias=True),headers={'origin':ORIGIN}).status_code==403
