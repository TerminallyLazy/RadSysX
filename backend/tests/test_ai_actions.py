"""Shared action policy catches duplicate, revoked and unreviewed execution."""
import asyncio
from datetime import timedelta
from types import SimpleNamespace
import pytest
from fastapi import HTTPException
from backend.tests.test_ai_live import live, runtime_for
from backend.clinical.ai_actions import ActionBroker
from backend.clinical.contracts import AILiveDecision, utc_now, to_iso_z

@pytest.fixture
def anyio_backend(): return 'asyncio'

@pytest.mark.anyio
async def test_duplicate_has_one_effect_and_changed_arguments_fail(live):
    runtime = runtime_for(live); broker = live.service.actions
    calls=[]
    async def dispatch(op, name, args):
        calls.append(op); return {'status':'completed','state':{'index':args['index']}}
    first, fresh = broker.prepare(runtime.id,'call-1','viewer_jump_to_slice',{'index':2},live.actor,context_version=1)
    assert fresh
    _, fresh = broker.prepare(runtime.id,'call-1','viewer_jump_to_slice',{'index':2},live.actor,context_version=1)
    assert not fresh
    with pytest.raises(HTTPException): broker.prepare(runtime.id,'call-1','viewer_jump_to_slice',{'index':3},live.actor,context_version=1)
    result = await broker.execute(runtime.id,'call-1',live.actor,check=runtime.check,dispatch=dispatch)
    again = await broker.execute(runtime.id,'call-1',live.actor,check=runtime.check,dispatch=dispatch)
    assert result == again and result['state']['index'] == 2
    assert calls == ['call-1']

@pytest.mark.anyio
async def test_deletion_review_denial_and_context_prevent_dispatch(live):
    runtime = runtime_for(live); broker=live.service.actions; calls=[]
    async def dispatch(*args): calls.append(args); return {}
    tool,_=broker.prepare(runtime.id,'delete-1','viewer_measurement',{'operation':'delete','measurementId':'measurement-1'},live.actor,context_version=1)
    assert tool['status']=='awaiting_approval'
    with pytest.raises(HTTPException): await broker.execute(runtime.id,'delete-1',live.actor,check=runtime.check,dispatch=dispatch)
    broker.decide(runtime.id,'delete-1',AILiveDecision(contextVersion=1,approved=False),live.actor)
    assert await broker.execute(runtime.id,'delete-1',live.actor,check=runtime.check,dispatch=dispatch)=={'status':'denied'}
    assert not calls

@pytest.mark.anyio
async def test_revoke_after_dispatch_is_unknown_and_never_retried(live):
    runtime=runtime_for(live); broker=live.service.actions
    broker.prepare(runtime.id,'call-1','viewer_jump_to_slice',{'index':2},live.actor,context_version=1)
    revoked=False; calls=[]
    def check():
        if revoked: raise HTTPException(409,'Scope revoked')
        return runtime.check()
    async def dispatch(*args):
        nonlocal revoked
        calls.append(args); revoked=True
        return {'status':'completed','state':{'index':2}}
    result=await broker.execute(runtime.id,'call-1',live.actor,check=check,dispatch=dispatch)
    assert result['status']=='outcome_unknown'
    assert broker.repo.tool(runtime.id,'call-1')['status']=='outcome_unknown'
    assert len(calls)==1

@pytest.mark.anyio
async def test_exploration_mutation_owner_blocks_voice_but_not_read(live):
    runtime=runtime_for(live); broker=live.service.actions
    broker.claim_viewer(live.actor,'grant-1')
    broker.prepare(runtime.id,'call-1','viewer_jump_to_slice',{'index':2},live.actor,context_version=1)
    calls=[]
    async def dispatch(*args): calls.append(args); return {'status':'completed'}
    result=await broker.execute(runtime.id,'call-1',live.actor,check=runtime.check,dispatch=dispatch)
    assert result['status']=='failed' and not calls
    broker.release_viewer(live.actor,'grant-other')
    assert broker.mutation_owners[live.actor.sub]=='grant-1'
    broker.release_viewer(live.actor,'grant-1')
    assert live.actor.sub not in broker.mutation_owners

@pytest.mark.anyio
async def test_report_save_keeps_backend_permission_and_study_authority(live):
    runtime=runtime_for(live); broker=live.service.actions
    broker.prepare(runtime.id,'report-1','report_save',{'findings':'Synthetic','impression':'Synthetic'},live.actor,context_version=1)
    broker.decide(runtime.id,'report-1',AILiveDecision(contextVersion=1,approved=True),live.actor)
    async def dispatch(*args): raise AssertionError('Saving cannot go through renderer')
    result=await broker.execute(runtime.id,'report-1',live.actor,check=runtime.check,dispatch=dispatch)
    assert result['status']=='failed'
    assert 'worklist' in result['message']

@pytest.mark.anyio
async def test_completion_delivery_failure_preserves_observed_action(live):
    runtime=runtime_for(live)
    async def dispatch(*args): return {'status':'completed','state':{'index':2}}
    runtime.renderer_action=dispatch
    async def emit(kind, **payload):
        if payload.get('status')=='completed': raise ConnectionError('Disconnected')
    runtime.emit=emit
    await runtime.schedule_tool(SimpleNamespace(id='move-1',name='viewer_jump_to_slice',args={'index':2}))
    await asyncio.gather(*list(runtime.tasks.values()))
    assert runtime.repo.tool(runtime.id,'move-1')['status']=='completed'


def test_new_grant_approval_expires_at_two_minutes(live, monkeypatch):
    from backend.clinical import ai_actions
    runtime=runtime_for(live); broker=live.service.actions
    broker.prepare(runtime.id,'report-1','report_save',{'findings':'Synthetic','impression':'Synthetic'},live.actor,context_version=1,grant='grant-1')
    later=utc_now()+timedelta(seconds=121)
    monkeypatch.setattr(ai_actions,'utc_now',lambda:later)
    with pytest.raises(HTTPException): broker.decide(runtime.id,'report-1',AILiveDecision(contextVersion=1,approved=True),live.actor,grant='grant-1')
    assert broker.repo.tool(runtime.id,'report-1')['status']=='awaiting_approval'
