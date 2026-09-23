"""Synthetic Codex tool lifecycle: pixels must be acknowledged, never replayed."""
import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock
import pytest
from fastapi import HTTPException
from backend.tests.test_ai_live import live
from backend.tests.exploration_helpers import make_task
from backend.tests.test_ai_exploration_contracts import observation
from backend.clinical.ai_exploration_contracts import ObservationResult, ActionResult
from backend.clinical.ai_codex_tools import CodexToolBridge
from backend.clinical.ai_codex import CodexProcess
from backend.clinical.contracts import utc_now, to_iso_z

@pytest.mark.anyio
async def test_scoped_turn_contains_real_initial_images_and_authorized_instructions(live):
    service,grant,binding=await make_task(live,frames=2)
    client=await live.service.codex.client(live.actor)
    original_call=client.call
    captured=[]
    async def record_call(method,params=None):
        if method=='turn/start': captured.extend(json.loads(json.dumps(params['input'])))
        return await original_call(method,params)
    client.call=record_call
    run=asyncio.create_task(live.service.codex.run(live.actor,'synthetic-codex-model','Inspect these images',research=False,
        on_progress=AsyncMock(),exploration=grant.task_id))
    observed=await capture(service,grant,binding,live.actor)
    result=await run
    thread=next(params for method,params in client.calls if method=='thread/start')
    assert [item['type'] for item in captured]==['text','image','image']
    assert captured[1]['url']=='data:image/jpeg;base64,'+observed.images[0].data
    assert 'Discussion of supplied context only' not in thread['developerInstructions']
    assert 'Do not call other tools' not in thread['baseInstructions']
    assert {'viewer_observe','series_read_frames','search_pubmed','series_get_metadata','structure_radiology_report'} <= {tool['name'] for tool in thread['dynamicTools']}
    assert result['explorationReceipt']['imagesDelivered']==2
    assert result['explorationReceipt']['coverage'][0]['delivered']==[0,1]
    assert observed.images[0].data not in json.dumps(service.repo.owned(grant.task_id,live.actor))
    await service.shutdown(); await live.service.codex.shutdown()

@pytest.fixture
def anyio_backend(): return 'asyncio'

async def capture(service, grant, binding, actor, *, count=2):
    command=(await service.poll(grant.task_id,binding,actor,wait_seconds=1))[0]
    claim=await service.claim(grant.task_id,command.operation_id,binding,actor)
    images=[{**observation(),'imageId':f'image-{i}','frameId':f'frame-{i}','index':i,'capturedAt':to_iso_z(utc_now())} for i in range(count)]
    result=ObservationResult(operationId=command.operation_id,claimId=claim.claim_id,revision=binding.revision,images=images)
    await service.complete_observation(grant.task_id,binding,result,actor)
    return result

@pytest.mark.anyio
async def test_images_acknowledged_by_exact_call_and_navigation_runs_once(live):
    service,grant,binding=await make_task(live)
    bridge=CodexToolBridge(service,grant.task_id,live.actor)
    args={'manifestId':'manifest-1','frameIds':['frame-0','frame-1']}
    work=asyncio.create_task(bridge.call('image-call','series_read_frames',args))
    observed=await capture(service,grant,binding,live.actor)
    result=await work
    assert [i['type'] for i in result.content_items]==['inputText','inputImage','inputImage']
    assert result.content_items[1]==observed.images[0].input_item()
    assert (await service.snapshot(grant.task_id,live.actor)).coverage[0].delivered==[]
    bridge.submitted('image-call')
    assert (await service.snapshot(grant.task_id,live.actor)).coverage[0].unconfirmed==[0,1]
    bridge.acknowledge('foreign')
    assert (await service.snapshot(grant.task_id,live.actor)).coverage[0].delivered==[]
    bridge.acknowledge('image-call')
    assert result.content_items==[]
    assert (await service.snapshot(grant.task_id,live.actor)).coverage[0].delivered==[0,1]
    duplicate=await bridge.call('image-call','series_read_frames',args)
    assert duplicate.receipt['pixelsUnavailable'] and len(duplicate.content_items)==1
    with pytest.raises((ValueError,HTTPException)):
        await bridge.call('image-call','series_read_frames',{**args,'frameIds':['frame-2']})
    work=asyncio.create_task(bridge.call('navigate','viewer_jump_to_slice',{'index':3}))
    command=(await service.poll(grant.task_id,binding,live.actor,wait_seconds=1))[0]
    claim=await service.claim(grant.task_id,command.operation_id,binding,live.actor)
    await service.complete(grant.task_id,binding,ActionResult(operationId=command.operation_id,claimId=claim.claim_id,status='completed',beforeRevision=0,revision=1,state={'index':3}),live.actor)
    action=await work
    assert action.success and (await bridge.call('navigate','viewer_jump_to_slice',{'index':3})).receipt==action.receipt
    assert len(service.tasks[grant.task_id].operations)==3 # inventory, images, mutation
    assert observed.images[0].data not in json.dumps(service.repo.owned(grant.task_id,live.actor))
    bridge.close(); await service.shutdown()

@pytest.mark.anyio
async def test_read_only_grant_and_expiry_during_capture_fail_closed(live):
    service,grant,binding=await make_task(live,allow_tools=False)
    bridge=CodexToolBridge(service,grant.task_id,live.actor)
    names={d['name'] for d in bridge.declarations()}
    assert 'viewer_get_state' in names and 'series_read_frames' in names and 'viewer_jump_to_slice' not in names
    with pytest.raises((ValueError,HTTPException)): await bridge.call('bad','viewer_jump_to_slice',{'index':1})
    work=asyncio.create_task(bridge.call('capture','series_read_frames',{'manifestId':'manifest-1','frameIds':['frame-0']}))
    await capture(service,grant,binding,live.actor,count=1)
    service.tasks[grant.task_id].last_seen-=16
    with pytest.raises(HTTPException): await work
    bridge.close(); await service.shutdown()

@pytest.mark.anyio
async def test_geometry_requires_acknowledged_current_pane_and_revision(live):
    service,grant,binding=await make_task(live)
    bridge=CodexToolBridge(service,grant.task_id,live.actor)
    args={'operation':'create','tool':'Length','points':[[0.3,0.3],[0.6,0.6]],'viewportId':'viewport-1'}
    for change in ({},{'frameId':'frame-0','revision':0}):
        with pytest.raises((ValueError,HTTPException)): await bridge.call('geometry-'+str(len(change)),'viewer_measurement',{**args,**change})
    bridge.close(); await service.shutdown()

@pytest.mark.anyio
async def test_unconfirmed_pixels_released_on_close_and_late_ack_ignored(live):
    service,grant,binding=await make_task(live)
    bridge=CodexToolBridge(service,grant.task_id,live.actor)
    work=asyncio.create_task(bridge.call('images','series_read_frames',{'manifestId':'manifest-1','frameIds':['frame-0']}))
    await capture(service,grant,binding,live.actor,count=1)
    result=await work; bridge.submitted('images'); bridge.close(); bridge.acknowledge('images')
    assert result.content_items==[]
    assert (await service.snapshot(grant.task_id,live.actor)).coverage[0].unconfirmed==[0]
    await service.shutdown()

@pytest.mark.anyio
async def test_protocol_identity_and_duplicate_search_are_bound(tmp_path):
    client=CodexProcess(tmp_path); client.send=AsyncMock()
    client.account={'type':'chatgpt'}
    tools=SimpleNamespace(search_pubmed=AsyncMock(return_value={'sources':[]}))
    client.job={'thread':'thread-1','turn':'turn-1','check':lambda:None,'research':True,'calls':0,'all_calls':0,'records':{},'tools':tools,'progress':AsyncMock(),'bridge':None}
    params={'threadId':'thread-1','turnId':'turn-1','callId':'call-1','namespace':None,'tool':'search_pubmed','arguments':{'query':'public'}}
    for change in ({'threadId':'foreign'},{'turnId':'foreign'},{'callId':''},{'namespace':'shell'}):
        await client.dispatch({'id':1,'method':'item/tool/call','params':{**params,**change}})
        assert 'error' in client.send.call_args.args[0]
    assert not tools.search_pubmed.await_count
    await client.dispatch({'id':2,'method':'item/tool/call','params':params})
    await client.dispatch({'id':3,'method':'item/tool/call','params':params})
    assert tools.search_pubmed.await_count==1
    await client.dispatch({'id':4,'method':'item/tool/call','params':{**params,'arguments':{'query':'different'}}})
    assert 'error' in client.send.call_args.args[0]

@pytest.mark.anyio
async def test_writer_is_bounded_and_private(tmp_path,monkeypatch):
    from backend.clinical import ai_codex
    monkeypatch.setattr(ai_codex,'WRITE_TIMEOUT',0.02)
    writer=SimpleNamespace(write=lambda _:None,drain=AsyncMock(side_effect=lambda:asyncio.sleep(5)))
    # AsyncMock does not await a returned coroutine; use a real stalled drain.
    async def stall(): await asyncio.sleep(5)
    writer.drain=stall
    process=SimpleNamespace(stdin=writer,returncode=None,terminate=lambda:None,kill=lambda:None,wait=AsyncMock(return_value=0))
    client=CodexProcess(tmp_path); client.process=process
    with pytest.raises(RuntimeError,match='Codex transport unavailable'):
        await asyncio.wait_for(client.send({'private':'secret'}),1)
    client.process=process
    with pytest.raises(RuntimeError,match='Codex message exceeds limit'):
        await client.send({'private':'a'*ai_codex.MAX_LINE_BYTES})

@pytest.mark.anyio
async def test_reading_view_has_no_offscreen_frame_tool_or_continuation(live):
    service,grant,binding=await make_task(live)
    task=service.tasks[grant.task_id]
    task.snapshot.grant.scope.kind='entire_view'
    bridge=CodexToolBridge(service,grant.task_id,live.actor)
    assert 'series_read_frames' not in {t['name'] for t in bridge.declarations()}
    with pytest.raises(HTTPException,match='Active series'):
        await bridge.call('bad-scope','series_read_frames',{'manifestId':'manifest-1','frameIds':['frame-0']})
    await service.revoke(grant.task_id,live.actor)
    assert not (await service.snapshot(grant.task_id,live.actor)).can_continue
    await service.shutdown()

@pytest.mark.anyio
async def test_continuation_initial_batch_starts_after_acknowledged_frames(live):
    from backend.clinical.ai_exploration_coverage import CoverageLedger
    from backend.clinical.ai_exploration_contracts import CoverageReceipt
    service,grant,binding=await make_task(live,frames=34)
    task=service.tasks[grant.task_id]
    ledger=task.ledgers['manifest-1']
    first=list(ledger.frames)[:8];ledger.requested(first);ledger.captured(first)
    ledger.submitted('prior',first,'frame');ledger.acknowledge('prior')
    task.ledgers['manifest-1']=CoverageLedger.restore(CoverageReceipt.model_validate(ledger.receipt().wire()))
    bridge=CodexToolBridge(service,grant.task_id,live.actor)
    requested=[]
    async def record(_call,name,args):
        requested.extend(args['frame_ids'])
        return SimpleNamespace(success=True,content_items=[{'type':'inputImage'}])
    bridge.call=record
    await bridge.initial_observation()
    assert requested==[f'frame-{i}' for i in range(8,16)]
    await service.revoke(grant.task_id,live.actor,status='paused')
    snapshot=await service.snapshot(grant.task_id,live.actor)
    assert snapshot.can_continue and snapshot.coverage[0].delivered==list(range(8))
    assert snapshot.status=='paused' and snapshot.activity
    await service.shutdown()

@pytest.mark.anyio
async def test_pubmed_optional_limit_and_invalid_arguments_have_actionable_receipts(tmp_path):
    client=CodexProcess(tmp_path);client.send=AsyncMock();client.account={'type':'chatgpt'}
    tools=SimpleNamespace(search_pubmed=AsyncMock(return_value={'sources':[]}))
    client.job={'thread':'thread-1','turn':'turn-1','check':lambda:None,'research':True,'calls':0,'all_calls':0,'records':{},'tools':tools,'progress':AsyncMock(),'bridge':None}
    for i,limit in enumerate([None,10,True]):
        await client.dispatch({'id':i,'method':'item/tool/call','params':{'threadId':'thread-1','turnId':'turn-1','callId':f'search-{i}','namespace':None,'tool':'search_pubmed','arguments':{'query':'public synthetic question','limit':limit}}})
    assert [call.args[1] for call in tools.search_pubmed.await_args_list]==[5,10]
    result=client.send.call_args.args[0]['result']
    assert not result['success'] and 'integer limit' in result['contentItems'][0]['text']
