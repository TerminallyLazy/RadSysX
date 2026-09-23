import asyncio
import json
import pytest
from fastapi import HTTPException
from backend.tests.test_ai_live import live
from backend.tests.exploration_helpers import make_task
from backend.clinical.ai_exploration import ExplorationService
from backend.clinical.ai_exploration_contracts import ActionResult

@pytest.fixture
def anyio_backend(): return 'asyncio'

@pytest.mark.anyio
async def test_command_claim_is_once_and_receipt_is_context_bound(live):
    service,task,binding=await make_task(live)
    job=asyncio.create_task(service.dispatch(task.task_id,'op-1','viewer_jump_to_slice',{'index':2},live.actor))
    first=await service.poll(task.task_id,binding,live.actor,wait_seconds=1)
    second=await service.poll(task.task_id,binding,live.actor,wait_seconds=0)
    assert first[0].operation_id==second[0].operation_id=='op-1'
    claimed=await service.claim(task.task_id,'op-1',binding,live.actor)
    with pytest.raises(HTTPException): await service.claim(task.task_id,'op-1',binding,live.actor)
    result=ActionResult(operationId='op-1',claimId=claimed.claim_id,status='completed',beforeRevision=0,revision=1,state={'index':2},canUndo=True)
    with pytest.raises(HTTPException):
        await service.complete(task.task_id,binding.model_copy(update={'epoch':'epoch-other'}),result,live.actor)
    await service.complete(task.task_id,binding,result,live.actor)
    assert (await job)['state']['index']==2
    assert (await service.snapshot(task.task_id,live.actor)).grant.binding.revision==1
    assert 'claimId' not in json.dumps((await service.snapshot(task.task_id,live.actor)).wire())
    await service.shutdown()

@pytest.mark.anyio
@pytest.mark.parametrize('claimed',[False,True])
async def test_stop_cancels_dispatch_and_retains_unknown_if_claimed(live,claimed):
    service,task,binding=await make_task(live)
    job=asyncio.create_task(service.dispatch(task.task_id,'op-1','viewer_jump_to_slice',{'index':2},live.actor))
    await service.poll(task.task_id,binding,live.actor,wait_seconds=1)
    if claimed: await service.claim(task.task_id,'op-1',binding,live.actor)
    await service.revoke(task.task_id,live.actor)
    await asyncio.gather(job,return_exceptions=True)
    state=await service.snapshot(task.task_id,live.actor)
    assert state.status=='cancelled'
    assert state.actions[-1]['status']==('outcome_unknown' if claimed else 'cancelled')
    with pytest.raises(HTTPException): await service.claim(task.task_id,'op-1',binding,live.actor)
    assert not service.tasks

@pytest.mark.anyio
async def test_heartbeat_expiry_and_restart_revoke_without_replay(live):
    service,task,binding=await make_task(live)
    service.tasks[task.task_id].last_seen-=16
    await service.sweep()
    assert (await service.snapshot(task.task_id,live.actor)).status=='interrupted'
    restarted=ExplorationService(live.service)
    assert not restarted.tasks
    with pytest.raises(HTTPException): await restarted.poll(task.task_id,binding,live.actor)
    await service.shutdown(); await restarted.shutdown()

@pytest.mark.anyio
async def test_wrong_scope_read_only_and_capacity_fail_before_dispatch(live):
    service,task,binding=await make_task(live,allow_tools=False)
    with pytest.raises(HTTPException): await service.dispatch(task.task_id,'op-1','viewer_jump_to_slice',{'index':2},live.actor)
    with pytest.raises(HTTPException): await service.prepare(task.session_id,task.scope,binding,live.actor)
    with pytest.raises(HTTPException): await service.poll(task.task_id,binding.model_copy(update={'study_id':'study-other'}),live.actor)
    await service.shutdown()

@pytest.mark.anyio
async def test_account_stop_and_history_delete_remove_owned_work(live):
    service,task,binding=await make_task(live)
    await live.service.stop_owner(live.actor)
    assert not service.tasks
    assert (await service.snapshot(task.task_id,live.actor)).status=='cancelled'
    await service.delete_source(task.session_id,live.actor)
    with pytest.raises(HTTPException): await service.snapshot(task.task_id,live.actor)

@pytest.mark.anyio
async def test_invalid_result_does_not_poison_valid_retry_and_duplicate_is_read_only(live):
    service,task,binding=await make_task(live)
    job=asyncio.create_task(service.dispatch(task.task_id,'op-1','viewer_jump_to_slice',{'index':2},live.actor))
    await service.poll(task.task_id,binding,live.actor,wait_seconds=1)
    command=await service.claim(task.task_id,'op-1',binding,live.actor)
    result=ActionResult(operationId='op-1',claimId=command.claim_id,status='completed',beforeRevision=0,revision=1,state={'index':2},canUndo=True)
    with pytest.raises(HTTPException): await service.complete(task.task_id,binding,result.model_copy(update={'revision':999}),live.actor)
    await service.complete(task.task_id,binding,result,live.actor)
    assert (await job)['state']['index']==2
    assert (await service.complete(task.task_id,binding,result,live.actor))['accepted']
    with pytest.raises(HTTPException): await service.complete(task.task_id,binding,result.model_copy(update={'state':{'index':3}}),live.actor)
    await service.shutdown()

@pytest.mark.anyio
async def test_history_deletion_cannot_be_recreated_by_late_dispatch(live):
    service,task,binding=await make_task(live)
    job=asyncio.create_task(service.dispatch(task.task_id,'op-1','viewer_jump_to_slice',{'index':2},live.actor))
    await service.poll(task.task_id,binding,live.actor,wait_seconds=1)
    await service.claim(task.task_id,'op-1',binding,live.actor)
    await service.delete_source(task.session_id,live.actor)
    await asyncio.gather(job,return_exceptions=True)
    with pytest.raises(HTTPException): await service.snapshot(task.task_id,live.actor)

@pytest.mark.anyio
@pytest.mark.parametrize('reason',['context','model','expiry','prepared_expiry'])
async def test_context_model_and_deadlines_invalidate_grants(live,reason):
    from datetime import timedelta
    from backend.clinical.contracts import AILiveContextUpdate, to_iso_z, utc_now
    service,task,binding=await make_task(live,active=reason!='prepared_expiry')
    if reason=='context':
        row=live.service.repository.owned(task.session_id,live.actor)
        context={**row['viewerContext'],'targetId':'different-case'}
        await live.service.update_context(task.session_id,AILiveContextUpdate(viewerContext=context,contextVersion=binding.context_version),live.actor)
    elif reason=='model':
        await live.service.change_research_settings(live.actor,'gemini','gemini-3.8-flash')
    else:
        service.tasks[task.task_id].snapshot.grant.expires_at=to_iso_z(utc_now()-timedelta(seconds=1))
        await service.sweep()
    with pytest.raises(HTTPException): await service.poll(task.task_id,binding,live.actor)
    assert not service.tasks

@pytest.mark.anyio
async def test_observation_receipt_validates_frame_index_and_releases_pixels(live):
    from backend.tests.test_ai_exploration_contracts import observation
    from backend.clinical.ai_exploration_contracts import ObservationResult
    from backend.clinical.contracts import to_iso_z, utc_now
    service,task,binding=await make_task(live)
    job=asyncio.create_task(service.dispatch(task.task_id,'op-1','series_read_frames',{'kind':'series_frames','manifestId':'manifest-1','frameIds':['frame-0']},live.actor,kind='observe'))
    await service.poll(task.task_id,binding,live.actor,wait_seconds=1)
    claim=await service.claim(task.task_id,'op-1',binding,live.actor)
    value={**observation(),'capturedAt':to_iso_z(utc_now())}
    result=ObservationResult(operationId='op-1',claimId=claim.claim_id,revision=0,images=[value])
    invalid=result.model_copy(update={'images':[result.images[0].model_copy(update={'index':1})]})
    with pytest.raises(HTTPException): await service.complete_observation(task.task_id,binding,invalid,live.actor)
    await service.complete_observation(task.task_id,binding,result,live.actor)
    assert (await job).images[0].data==value['data']
    pending=service.tasks[task.task_id].operations['op-1']
    assert value['data'] not in json.dumps(pending.future.result())
    assert value['data'] not in json.dumps(service.repo.owned(task.task_id,live.actor))
    assert (await service.snapshot(task.task_id,live.actor)).coverage[0].delivered==[]
    await service.shutdown()

@pytest.mark.anyio
async def test_global_two_task_limit_and_restart_keeps_unknown_actions(live):
    from types import SimpleNamespace
    from backend.tests.test_ai_text import session_request
    from backend.clinical.ai_exploration_contracts import ShareSelection, RendererBinding
    service,first,binding=await make_task(live)
    # Unit policy receives verified claims; HTTP owner validation is tested separately.
    second_actor=live.actor.model_copy(update={'sub':'synthetic-second'})
    second_live=SimpleNamespace(**{**vars(live),'actor':second_actor})
    await make_task(second_live)
    third_actor=live.actor.model_copy(update={'sub':'synthetic-third'})
    client=await live.service.codex.client(third_actor); client.signed_in=True
    await live.service.codex.status(third_actor)
    await live.service.change_research_settings(third_actor,'codex','synthetic-codex-model')
    request=session_request(); request.viewer_context.state.update({'studyId':'study-1','series':[{'id':'series-1','studyId':'study-1'}]})
    row=await live.service.text.create(request,third_actor)
    with pytest.raises(HTTPException):
        await service.prepare(row['sessionId'],first.scope,binding,third_actor)
    assert len(service.tasks)==2
    job=asyncio.create_task(service.dispatch(first.task_id,'op-1','viewer_jump_to_slice',{'index':2},live.actor))
    await service.poll(first.task_id,binding,live.actor,wait_seconds=1)
    await service.claim(first.task_id,'op-1',binding,live.actor)
    restarted=ExplorationService(live.service)
    assert (await restarted.snapshot(first.task_id,live.actor)).actions[-1]['status']=='outcome_unknown'
    assert not restarted.tasks
    await service.shutdown(); await asyncio.gather(job,return_exceptions=True)
