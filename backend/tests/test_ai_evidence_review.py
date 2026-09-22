"""Owned real service + private persistence; HTTP alone is synthetic."""
import asyncio
import json
import socket
from datetime import timedelta
from types import SimpleNamespace
from pathlib import Path

import httpx
import pytest
from fastapi import HTTPException
from pydantic import SecretStr, ValidationError
from backend.tests.test_ai_live import live, runtime_for
from backend.clinical.contracts import to_iso_z, utc_now


def seed_research(live, *, tool_id='public-research', summary='Synthetic finding [s1].', actor=None):
    runtime = runtime_for(live, actor=actor)
    repo = live.service.repository
    repo.add_tool(runtime.id, tool_id, 'research_run', {'query':'PRIVATE_QUERY_SENTINEL'}, 1, False)
    repo.set_tool(runtime.id, tool_id, 'completed', {'summary':summary,
        'sources':[{'id':'s1','title':'Synthetic public fixture','url':'https://pubmed.ncbi.nlm.nih.gov/123/'}], 'limitations':[]})
    return runtime.id, tool_id


class FakeEvidenceHTTP:
    def __init__(self):
        self.requests=[]; self.started=asyncio.Event(); self.release=asyncio.Event()
        self.block=None; self.responses=[]
    async def __call__(self,request):
        self.requests.append(request)
        kind='jev' if request.url.host=='api.typesafe.ai' else 'pubmed'
        if self.block==kind:
            self.started.set(); await self.release.wait()
        if kind=='pubmed':
            return httpx.Response(200,content=b'<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>123</PMID><Article><Abstract><AbstractText>Synthetic finding.</AbstractText></Abstract></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>')
        if self.responses: return self.responses.pop(0)
        return httpx.Response(200,json={'model':'jev-1.13.0','answers':{'relationship':{'type':'choice','choice':'supported',
            'probabilities':{'supported':1.0,'partially_supported':0.0,'contradicted':0.0,'mixed':0.0,'not_addressed':0.0},'confidence':1.0}},'usage':{'input_tokens':10,'output_tokens':1}})
    @property
    def submitted(self): return [r for r in self.requests if r.url.host=='api.typesafe.ai']


@pytest.fixture
def review(live,monkeypatch):
    from backend.clinical import ai_evidence_review
    original=socket.socket.connect
    def connect(sock,address):
        if sock.family in (socket.AF_INET,socket.AF_INET6): raise AssertionError('Network forbidden')
        return original(sock,address)
    monkeypatch.setattr(socket.socket,'connect',connect)
    live.service.config.typesafe_api_key=SecretStr('synthetic-jev-key')
    http=FakeEvidenceHTTP()
    monkeypatch.setattr(ai_evidence_review,'new_http_client',lambda:httpx.AsyncClient(transport=httpx.MockTransport(http)))
    return SimpleNamespace(live=live,service=live.service.evidence_reviews,http=http,actor=live.actor)


async def ready(review, *, summary='Synthetic finding [s1].', actor=None, key='prepare-1'):
    from backend.clinical.ai_evidence_contracts import EvidencePrepareRequest
    sid,tid=seed_research(review.live, summary=summary, actor=actor)
    detail=await review.service.prepare(actor or review.actor,sid,tid,EvidencePrepareRequest(idempotency_key=key))
    assert detail.status=='preparing'
    await review.service.jobs[detail.review_id].task
    detail=review.service.get(actor or review.actor,detail.review_id)
    assert detail.status=='ready', detail.reason
    return detail


def start_request(detail, *, key='start-1', selected=None):
    from backend.clinical.ai_evidence_contracts import EvidenceStartRequest
    return EvidenceStartRequest(idempotency_key=key,preview_sha256=detail.preview_sha256,
        selected_unit_ids=tuple(selected if selected is not None else [c.unit_id for c in detail.claims if c.eligible]), confirmation='synthetic')


async def finish(review,detail,request=None):
    value=await review.service.start(review.actor,detail.review_id,request or start_request(detail))
    if value.review_id in review.service.jobs: await review.service.jobs[value.review_id].task
    return review.service.get(review.actor,value.review_id)


def test_owned_preview_and_minimal_payload_preserve_answer(review):
    async def scenario():
        detail=await ready(review,summary='Synthetic finding [s1]. PRIVATE_EXCLUDED [s1].')
        assert not review.http.submitted
        assert detail.abstracts[0].sections[0].text=='Synthetic finding.'
        await review.live.service.stop(detail.session_id)
        result=await finish(review,detail,start_request(detail,selected=[detail.claims[0].unit_id]))
        assert result.status=='completed' and result.completed_pairs==1
        assert result.original_answer==detail.original_answer
        body=review.http.submitted[0].content.decode()
        for value in ('PRIVATE_QUERY_SENTINEL','PRIVATE_EXCLUDED',detail.session_id,'report','DICOM'):
            assert value not in body
        assert result.assessments[0].resolved_model=='jev-1.13.0'
        assert result.attempts[0].usage=={'input_tokens':10,'output_tokens':1}
        assert result.generation.model_id is None
        before=len(review.http.requests)
        assert review.service.get(review.actor,result.review_id).status=='completed'
        assert review.service.list(review.actor,detail.session_id).reviews[0].review_id==result.review_id
        assert len(review.http.requests)==before
        assert review.live.provider.responses==[]
    asyncio.run(scenario())


def test_foreign_actor_and_tampered_source_are_rejected(review):
    async def scenario():
        detail=await ready(review)
        other=review.actor.model_copy(update={'sub':'foreign'})
        for operation in (lambda:review.service.get(other,detail.review_id),lambda:review.service.list(other,detail.session_id)):
            with pytest.raises(HTTPException) as error: operation()
            assert error.value.status_code==404
        for operation in (review.service.start,review.service.cancel):
            with pytest.raises(HTTPException) as error:
                if operation==review.service.start: await operation(other,detail.review_id,start_request(detail))
                else: await operation(other,detail.review_id)
            assert error.value.status_code==404
        review.live.service.repository.set_tool(detail.session_id,detail.tool_call_id,'completed',{'summary':'changed','sources':[]})
        with pytest.raises(HTTPException) as error: await review.service.start(review.actor,detail.review_id,start_request(detail))
        assert error.value.status_code==409 and not review.http.submitted
    asyncio.run(scenario())


@pytest.mark.parametrize('change',[{'confirmation':None},{'confirmation':False},{'confirmation':'deidentified'},
    {'selectedUnitIds':[]},{'selectedUnitIds':['unknown']},{'previewSha256':'0'*64}])
def test_invalid_confirmation_and_selection_never_submits(review,change):
    async def scenario():
        from backend.clinical.ai_evidence_contracts import EvidenceStartRequest
        detail=await ready(review)
        payload=start_request(detail).model_dump(mode='json',by_alias=True); payload.update(change)
        with pytest.raises((ValidationError,HTTPException,ValueError)):
            await review.service.start(review.actor,detail.review_id,EvidenceStartRequest.model_validate_json(json.dumps(payload)))
        assert not review.http.submitted
    asyncio.run(scenario())


def test_duplicate_start_cancel_and_unknown_usage(review):
    async def scenario():
        detail=await ready(review); review.http.block='jev'
        request=start_request(detail)
        await review.service.start(review.actor,detail.review_id,request)
        await review.http.started.wait()
        await review.service.start(review.actor,detail.review_id,request)
        await review.service.start(review.actor,detail.review_id,start_request(detail,key='double-click'))
        assert len(review.http.submitted)==1
        result=await review.service.cancel(review.actor,detail.review_id)
        assert result.status=='cancelled' and result.unknown_usage_attempts==1
        review.http.release.set()
        assert review.service.get(review.actor,detail.review_id).status=='cancelled'
    asyncio.run(scenario())


def test_partial_retry_reuses_only_completed_pairs(review):
    async def scenario():
        from backend.clinical.ai_evidence_contracts import EvidenceRetryRequest
        detail=await ready(review,summary='First [s1]. Second [s1].')
        good=await review.http(httpx.Request('POST','https://api.typesafe.ai/test'))
        review.http.requests.clear()
        review.http.responses=[good,httpx.Response(422)]
        result=await finish(review,detail)
        assert result.status=='partial' and result.completed_pairs==1 and len(review.http.submitted)==2
        request=EvidenceRetryRequest(idempotency_key='retry-1',preview_sha256=detail.preview_sha256,confirmation='synthetic')
        await review.service.retry(review.actor,result.review_id,request)
        await review.service.jobs[result.review_id].task
        result=review.service.get(review.actor,result.review_id)
        assert result.status=='completed' and len(review.http.submitted)==3
        assert len(result.attempts)==3 and sum(a.reused for a in result.assessments)==1
        await review.service.retry(review.actor,result.review_id,request)
        assert len(review.http.submitted)==3
    asyncio.run(scenario())


@pytest.mark.parametrize('action',['logout','expiry','credentials','disabled','delete','shutdown'])
def test_revocation_stops_inflight_work_without_resurrection(review,action):
    async def scenario():
        detail=await ready(review); review.http.block='jev'
        await review.service.start(review.actor,detail.review_id,start_request(detail))
        job=review.service.jobs[detail.review_id]
        await review.http.started.wait()
        if action=='logout': await review.live.service.stop_owner(review.actor)
        elif action=='credentials': await review.live.service.change_credential(review.actor,'gemini','synthetic-new-api-key')
        elif action=='expiry':
            review.actor.expires_at=to_iso_z(utc_now()-timedelta(seconds=1))
            await asyncio.wait_for(job.task,2)
        elif action=='disabled':
            review.live.service.config.enabled=False
            await asyncio.wait_for(job.task,2)
        elif action=='delete': await review.service.delete_source(review.actor,detail.session_id)
        else: await review.live.service.shutdown()
        assert job.task.done() and not review.service.jobs
        review.http.release.set()
        if action=='delete':
            with pytest.raises(HTTPException): review.service.get(review.actor,detail.review_id)
            assert not any(review.service.root.iterdir())
        elif action not in {'expiry','disabled'}:
            assert review.service.get(review.actor,detail.review_id).status in {'cancelled','interrupted'}
        assert len(review.http.submitted)==1
    asyncio.run(scenario())


def test_capacity_and_preparation_cancel(review):
    async def scenario():
        from backend.clinical.ai_evidence_contracts import EvidencePrepareRequest
        review.http.block='pubmed'
        sid,tid=seed_research(review.live)
        first=await review.service.prepare(review.actor,sid,tid,EvidencePrepareRequest(idempotency_key='first'))
        await review.http.started.wait()
        sid2,tid2=seed_research(review.live)
        with pytest.raises(HTTPException) as error:
            await review.service.prepare(review.actor,sid2,tid2,EvidencePrepareRequest(idempotency_key='second'))
        assert error.value.status_code==409
        other=review.actor.model_copy(update={'sub':'other'})
        osid,otid=seed_research(review.live,actor=other)
        await review.service.prepare(other,osid,otid,EvidencePrepareRequest(idempotency_key='other'))
        third=review.actor.model_copy(update={'sub':'third'})
        tsid,ttid=seed_research(review.live,actor=third)
        with pytest.raises(HTTPException) as error:
            await review.service.prepare(third,tsid,ttid,EvidencePrepareRequest(idempotency_key='third'))
        assert error.value.status_code==409
        assert (await review.service.cancel(review.actor,first.review_id)).status=='cancelled'
        await review.service.shutdown()
        assert not review.http.submitted
    asyncio.run(scenario())


def test_missing_artifacts_are_not_refetched(review):
    async def scenario():
        detail=await ready(review)
        row=review.service.repository.owned(review.actor,detail.review_id)
        from backend.evidence_review.artifacts import ArtifactStore
        ArtifactStore.delete_run(review.service.root,run_id=row.run_id)
        count=len(review.http.requests)
        assert review.service.get(review.actor,detail.review_id).status=='unavailable'
        assert len(review.http.requests)==count
    asyncio.run(scenario())


def test_restart_interrupts_work_without_replaying(review):
    async def scenario():
        detail=await ready(review)
        row=review.service.repository.owned(review.actor,detail.review_id)
        review.service.repository.update_if_current(row.id,row.generation,status='reviewing')
        from backend.clinical.ai_evidence_review import EvidenceReviewService
        restored=EvidenceReviewService(review.live.service)
        count=len(review.http.requests)
        restored.recover()
        assert restored.get(review.actor,detail.review_id).status=='interrupted'
        assert not restored.jobs and len(review.http.requests)==count
    asyncio.run(scenario())


def test_queued_start_cannot_escape_account_stop(review):
    async def scenario():
        detail=await ready(review)
        async with review.live.service.owner_lock(review.actor):
            pending=asyncio.create_task(review.service.start(review.actor,detail.review_id,start_request(detail)))
            await asyncio.sleep(0)  # Let this request reach the held account lock.
            await review.live.service.stop_owner(review.actor)
        with pytest.raises(HTTPException) as error: await pending
        assert error.value.status_code==409 and not review.http.submitted
    asyncio.run(scenario())


def test_progress_write_failure_and_final_database_failure_do_not_leak(review,monkeypatch):
    async def scenario():
        detail=await ready(review)
        original=review.service.repository.update_if_current
        failed=False
        def write(review_id,expected_generation,**values):
            nonlocal failed
            if values.get('progress_json',{}).get('unknownUsageAttempts') or failed:
                failed=True
                raise OSError('PRIVATE_DATABASE_SENTINEL')
            return original(review_id,expected_generation,**values)
        monkeypatch.setattr(review.service.repository,'update_if_current',write)
        await review.service.start(review.actor,detail.review_id,start_request(detail))
        task=review.service.jobs[detail.review_id].task
        await task
        result=review.service.get(review.actor,detail.review_id)
        assert result.status=='interrupted' and result.unknown_usage_attempts==1
        assert not review.http.submitted and 'PRIVATE_DATABASE_SENTINEL' not in result.model_dump_json()
    asyncio.run(scenario())


def test_prepare_idempotency_and_cancel_before_dispatch(review):
    async def scenario():
        from backend.clinical.ai_evidence_contracts import EvidencePrepareRequest
        sid,tid=seed_research(review.live)
        request=EvidencePrepareRequest(idempotency_key='duplicate')
        first=await review.service.prepare(review.actor,sid,tid,request)
        again=await review.service.prepare(review.actor,sid,tid,request)
        assert first.review_id==again.review_id
        assert (await review.service.cancel(review.actor,first.review_id)).status=='cancelled'
        assert not review.http.requests
        sid2,tid2=seed_research(review.live)
        with pytest.raises(HTTPException) as error: await review.service.prepare(review.actor,sid2,tid2,request)
        assert error.value.status_code==409
    asyncio.run(scenario())


@pytest.mark.parametrize('bad',['failed','nonresearch','nonpubmed'])
def test_ineligible_source_cannot_prepare(review,bad):
    async def scenario():
        from backend.clinical.ai_evidence_contracts import EvidencePrepareRequest
        from backend.clinical.models import AILiveToolModel
        sid,tid=seed_research(review.live)
        with review.live.repository._session_factory() as db:
            tool=db.get(AILiveToolModel,f'{sid}:{tid}')
            if bad=='failed': tool.status='failed'
            elif bad=='nonresearch': tool.name='report_save'
            else: tool.result_json={'summary':'Private','sources':[{'id':'s1','title':'private','url':'http://127.0.0.1/'}]}
            db.commit()
        with pytest.raises(HTTPException) as error:
            await review.service.prepare(review.actor,sid,tid,EvidencePrepareRequest(idempotency_key='bad'))
        assert error.value.status_code==422 and not review.http.requests
    asyncio.run(scenario())


def test_missing_key_allows_preview_but_not_inference(review):
    async def scenario():
        review.live.service.config.typesafe_api_key=SecretStr('')
        detail=await ready(review)
        with pytest.raises(HTTPException) as error: await review.service.start(review.actor,detail.review_id,start_request(detail))
        assert error.value.status_code==503 and not review.http.submitted
    asyncio.run(scenario())


def test_voice_and_viewport_change_do_not_rebind_or_cancel_review(review):
    async def scenario():
        detail=await ready(review); review.http.block='jev'
        await review.service.start(review.actor,detail.review_id,start_request(detail))
        task=review.service.jobs[detail.review_id].task
        await review.http.started.wait()
        review.live.service.repository.change(detail.session_id,context_version=99)
        await review.live.service.stop(detail.session_id)
        assert not task.done()
        review.http.release.set(); await task
        result=review.service.get(review.actor,detail.review_id)
        assert result.status=='completed' and result.source_context_version==1
    asyncio.run(scenario())


def test_preparation_deadline_is_failure_not_user_cancellation(review,monkeypatch):
    async def scenario():
        from backend.clinical.ai_evidence_contracts import EvidencePrepareRequest
        original=asyncio.timeout
        monkeypatch.setattr(asyncio,'timeout',lambda seconds:original(.01 if seconds==20 else seconds))
        review.http.block='pubmed'
        sid,tid=seed_research(review.live)
        detail=await review.service.prepare(review.actor,sid,tid,EvidencePrepareRequest(idempotency_key='deadline'))
        await review.service.jobs[detail.review_id].task
        result=review.service.get(review.actor,detail.review_id)
        assert result.status=='failed' and result.reason=='review_deadline'
        assert not review.http.submitted
    asyncio.run(scenario())


def test_start_operation_and_state_commit_together(review,monkeypatch):
    async def scenario():
        from backend.clinical.models import AIJevReviewModel
        from backend.clinical.ai_evidence_repository import identity
        detail=await ready(review); request=start_request(detail)
        factory=review.service.repository.factory
        fail=True
        def sessions():
            db=factory(); original=db.commit
            def commit():
                nonlocal fail
                if fail and any(isinstance(row,AIJevReviewModel) and row.status=='reviewing' for row in db.dirty):
                    fail=False; raise OSError('synthetic storage failure')
                return original()
            db.commit=commit
            return db
        monkeypatch.setattr(review.service.repository,'factory',sessions)
        with pytest.raises(OSError): await review.service.start(review.actor,detail.review_id,request)
        digest=identity([detail.review_id,request.model_dump(mode='json',exclude={'idempotency_key'})])
        assert review.service.repository.existing_operation(review.actor,'start',request.idempotency_key,digest) is None
        result=await finish(review,detail,request)
        assert result.status=='completed' and len(review.http.submitted)==1
    asyncio.run(scenario())


def test_cancel_during_provider_backoff_does_not_retry(review,monkeypatch):
    async def scenario():
        detail=await ready(review)
        review.http.responses=[httpx.Response(529,headers={'Retry-After':'30'})]
        backoff=asyncio.Event(); original=review.service._on_commit
        def committed(job,view):
            original(job,view)
            if any(a.outcome and a.outcome.reason=='overloaded' for a in view.attempts): backoff.set()
        monkeypatch.setattr(review.service,'_on_commit',committed)
        await review.service.start(review.actor,detail.review_id,start_request(detail))
        await asyncio.wait_for(backoff.wait(),2)
        result=await review.service.cancel(review.actor,detail.review_id)
        assert result.status=='cancelled' and len(review.http.submitted)==1
        assert result.unknown_usage_attempts==1
    asyncio.run(scenario())


def test_model_change_stops_review(review):
    async def scenario():
        detail=await ready(review); review.http.block='jev'
        await review.service.start(review.actor,detail.review_id,start_request(detail))
        await review.http.started.wait()
        await review.live.service.change_research_settings(review.actor,'gemini','gemini-3.8-flash')
        assert review.service.get(review.actor,detail.review_id).status=='cancelled'
        assert not review.service.jobs and len(review.http.submitted)==1
    asyncio.run(scenario())


def test_shutdown_before_worker_starts_is_interrupted(review):
    async def scenario():
        from backend.clinical.ai_evidence_contracts import EvidencePrepareRequest
        sid,tid=seed_research(review.live)
        detail=await review.service.prepare(review.actor,sid,tid,EvidencePrepareRequest(idempotency_key='shutdown'))
        await review.service.shutdown()
        assert review.service.get(review.actor,detail.review_id).status=='interrupted'
        assert not review.http.requests
    asyncio.run(scenario())


def test_two_citation_aliases_for_one_pubmed_article_remain_reviewable(review):
    async def scenario():
        from backend.clinical.ai_evidence_contracts import EvidencePrepareRequest
        sid,tid=seed_research(review.live,summary='Synthetic finding [s1, s2].')
        result=review.live.service.repository.tool(sid,tid)['result']
        result['sources'].append({**result['sources'][0],'id':'s2'})
        review.live.service.repository.set_tool(sid,tid,'completed',result)
        detail=await review.service.prepare(review.actor,sid,tid,EvidencePrepareRequest(idempotency_key='aliases'))
        await review.service.jobs[detail.review_id].task
        detail=review.service.get(review.actor,detail.review_id)
        assert detail.status=='ready',detail.reason
        assert len(detail.abstracts)==2 and len({a.evidence_id for a in detail.abstracts})==2
        assert not review.http.submitted
    asyncio.run(scenario())
