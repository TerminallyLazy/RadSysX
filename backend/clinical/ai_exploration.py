"""Owned, revocable HTTP renderer work independent of voice transport."""
from __future__ import annotations
import asyncio
import hashlib
import json
import time
from dataclasses import dataclass, field
from datetime import timedelta
from uuid import uuid4
from fastapi import HTTPException
from .ai_exploration_contracts import (ExplorationGrant, TaskSnapshot, RendererCommand,
    RendererBinding, SeriesManifest, ObservationRequest, ObservationResult, ActionResult)
from .ai_exploration_coverage import CoverageLedger, RunBudget
from .ai_exploration_repository import ExplorationRepository
from .ai_tools import validate_tool, safe_state, bound_json
from .contracts import parse_iso_z, to_iso_z, utc_now


def identity(value):
    if hasattr(value,'wire'): value=value.wire()
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()


@dataclass
class Pending:
    command: RendererCommand
    future: asyncio.Future
    claim_id: str | None = None
    result_digest: str | None = None
    result_receipt: dict | None = None


@dataclass
class Task:
    snapshot: TaskSnapshot
    actor: object
    last_seen: float = field(default_factory=time.monotonic)
    manifests: dict = field(default_factory=dict)
    ledgers: dict = field(default_factory=dict)
    operations: dict = field(default_factory=dict)
    queue: asyncio.Event = field(default_factory=asyncio.Event)
    serial: asyncio.Lock = field(default_factory=asyncio.Lock)
    budget: RunBudget | None = None
    inventory_task: asyncio.Task | None = None
    watcher: asyncio.Task | None = None
    turn_id: str | None = None
    closing: bool = False
    continuation: dict | None = None


class ExplorationService:
    def __init__(self, live):
        self.live=live
        self.repo=ExplorationRepository(live.clinical_repository)
        self.repo.recover()
        self.tasks={}
        self.admission=asyncio.Lock()

    def persist(self, task):
        if self.tasks.get(task.snapshot.grant.task_id) is not task: return
        task.snapshot.coverage=[ledger.receipt() for ledger in task.ledgers.values()]
        task.snapshot.can_continue=any(c.status!='complete' for c in task.snapshot.coverage)
        self.repo.save(task.snapshot,task.actor.sub,manifests=task.manifests,turn_id=task.turn_id)

    def owned(self, task_id, actor):
        self.live.require_research_settings(actor)
        data=self.repo.owned(task_id,actor)
        self.live.repository.owned(data['snapshot']['grant']['sessionId'],actor)
        return data

    def check(self, task_id, actor, *, binding=None):
        self.live.require_research_settings(actor)
        task=self.tasks.get(task_id)
        if not task or task.actor.sub!=actor.sub:
            self.owned(task_id,actor)
            raise HTTPException(409,'Study task is no longer active.')
        grant=task.snapshot.grant
        self.live.text.require(grant.session_id,actor,grant.binding.context_version)
        if task.closing or grant.status not in {'prepared','active'} or parse_iso_z(grant.expires_at)<=utc_now() or time.monotonic()-task.last_seen>15:
            raise HTTPException(409,'Study task expired or was stopped.')
        if binding is not None and binding != grant.binding:
            raise HTTPException(409,'The viewer changed. Share the current scope again.')
        return task

    async def prepare(self, session_id, selection, binding, actor, *, continuation=None):
        async with self.admission:
            await self.sweep()
            row=self.live.text.require(session_id,actor,binding.context_version)
            if row['providerId']!='codex': raise HTTPException(409,'Choose a ChatGPT / Codex image model.')
            state=row['viewerContext'].get('state',{})
            known={s.get('id') for s in state.get('series',[]) if s.get('studyId')==selection.study_id}
            if state.get('studyId')!=selection.study_id or not set(binding.series_ids)<=known or not set(selection.series_ids)<=known or binding.study_id!=selection.study_id:
                raise HTTPException(409,'Share a single currently loaded study.')
            if any(t.actor.sub==actor.sub for t in self.tasks.values()) or len(self.tasks)>=2:
                raise HTTPException(409,'Finish or stop the active study task first.')
            if not await self.live.codex.supports_images(actor,row['modelId']):
                raise HTTPException(409,'The selected subscription model does not advertise images.')
            self.live.text.require(session_id,actor,binding.context_version)
            now=utc_now()
            grant=ExplorationGrant(grantId='grant-'+uuid4().hex,sessionId=session_id,taskId='task-'+uuid4().hex,
                modelId=row['modelId'],scope=selection,binding=binding,
                permissions=['observe','mutate','propose_durable'] if selection.allow_viewer_tools else ['observe'],
                createdAt=to_iso_z(now),expiresAt=to_iso_z(min(now+timedelta(seconds=60),parse_iso_z(actor.expires_at))),status='prepared')
            task=Task(TaskSnapshot(grant=grant,status='prepared',activity='Reading series inventory'),actor,continuation=continuation)
            self.tasks[grant.task_id]=task
            self.persist(task)
            task.inventory_task=asyncio.create_task(self.inventory(grant.task_id,actor))
            task.watcher=asyncio.create_task(self.watch(grant.task_id,actor))
            return grant.model_copy(deep=True)

    async def inventory(self, task_id, actor):
        try:
            task=self.check(task_id,actor)
            total=0
            for series_id in task.snapshot.grant.scope.series_ids:
                pages=[]; offset=0; all_ids=[]; manifest_id=None; frame_count=None
                while True:
                    page=await self.dispatch(task_id,'op-'+uuid4().hex,'series_get_manifest',{'seriesId':series_id,'offset':offset},actor,kind='manifest')
                    task=self.check(task_id,actor)
                    if page.series_id!=series_id or page.study_id!=task.snapshot.grant.scope.study_id or page.offset!=offset:
                        raise ValueError('Mismatched manifest')
                    if manifest_id is not None and (page.manifest_id!=manifest_id or page.frame_count!=frame_count): raise ValueError('Changing inventory')
                    manifest_id,frame_count=page.manifest_id,page.frame_count
                    all_ids.extend(f.id for f in page.frames); total+=len(page.frames)
                    if total>10000 or len(set(all_ids))!=len(all_ids): raise ValueError('Inventory budget or duplicate')
                    pages.append(page.wire()); offset+=len(page.frames)
                    if offset==frame_count: break
                task.manifests[manifest_id]=pages
                task.ledgers[manifest_id]=CoverageLedger(manifest_id,tuple(all_ids))
                prior=(task.continuation or {}).get('manifests',{}).get(manifest_id)
                if prior is not None and prior==pages:
                    from .ai_exploration_contracts import CoverageReceipt
                    for saved in task.continuation['snapshot']['coverage']:
                        if saved['manifestId']==manifest_id: task.ledgers[manifest_id]=CoverageLedger.restore(CoverageReceipt.model_validate(saved))
            task.snapshot.activity='Ready to share'
            self.persist(task)
        except asyncio.CancelledError:
            raise
        except Exception:
            if task_id in self.tasks: await self.revoke(task_id,actor,status='failed')

    async def activate(self, task_id, tool_id, actor):
        task=self.check(task_id,actor)
        grant=task.snapshot.grant
        if grant.status=='active':
            if task.turn_id==tool_id: return grant
            raise HTTPException(409,'Scope belongs to another request.')
        if task.inventory_task and not task.inventory_task.done(): raise HTTPException(409,'Series inventory is still loading.')
        if not task.manifests: raise HTTPException(409,'No complete image inventory is available.')
        row=self.live.repository.tool(grant.session_id,tool_id)
        if row['name'] not in {'text_chat','research_run'} or row['status'] not in {'pending','running'}:
            raise HTTPException(409,'Start an owned text request first.')
        if grant.scope.allow_viewer_tools: self.live.actions.claim_viewer(actor,grant.grant_id)
        grant.status='active'; grant.expires_at=to_iso_z(min(utc_now()+timedelta(seconds=600),parse_iso_z(actor.expires_at)))
        task.turn_id=tool_id; task.snapshot.status='running'; task.snapshot.activity='Starting study exploration'
        task.budget=RunBudget(time.monotonic()); self.persist(task)
        return grant

    async def snapshot(self, task_id, actor):
        data=self.owned(task_id,actor)
        return TaskSnapshot.model_validate(data['snapshot'])

    async def poll(self, task_id, binding, actor, *, wait_seconds=5):
        task=self.check(task_id,actor,binding=binding); task.last_seen=time.monotonic()
        available=lambda:[op.command.model_copy(deep=True) for op in task.operations.values() if not op.claim_id and not op.future.done()]
        if not available() and wait_seconds:
            task.queue.clear()
            try: await asyncio.wait_for(task.queue.wait(),min(5,wait_seconds))
            except asyncio.TimeoutError: pass
        self.check(task_id,actor,binding=binding); task.last_seen=time.monotonic()
        return available()

    async def dispatch(self, task_id, operation_id, name, args, actor, *, kind='action'):
        task=self.check(task_id,actor)
        if kind=='action':
            if task.snapshot.grant.status!='active' or 'mutate' not in task.snapshot.grant.permissions:
                raise HTTPException(403,'Viewer tools were not granted.')
            args=validate_tool(name,args)
        elif kind=='observe':
            if task.snapshot.grant.status!='active': raise HTTPException(409,'Send the shared scope first.')
            request=ObservationRequest.model_validate(args)
            if request.kind=='series_frames':
                ledger=task.ledgers.get(request.manifest_id)
                if not ledger or not set(request.frame_ids)<=set(ledger.frames): raise HTTPException(403,'Frames are outside the shared inventory.')
                ledger.requested(request.frame_ids)
            args=request.wire()
        elif kind!='manifest' or task.snapshot.grant.status!='prepared': raise HTTPException(409,'Inventory is not being prepared.')
        async with task.serial:
            self.check(task_id,actor)
            previous=task.operations.get(operation_id)
            if previous:
                if previous.command.name!=name or previous.command.args!=args or previous.command.kind!=kind:
                    raise HTTPException(409,'Operation identity changed.')
                if previous.result_receipt is not None: return previous.result_receipt
                raise HTTPException(409,'Operation is already pending or unknown.')
            if len(task.operations)>=128: raise HTTPException(409,'Viewer operation budget reached.')
            grant=task.snapshot.grant
            command=RendererCommand(operationId=operation_id,grantId=grant.grant_id,taskId=task_id,name=name,args=args,
                expectedRevision=grant.binding.revision,deadline=to_iso_z(min(utc_now()+timedelta(seconds=15),parse_iso_z(grant.expires_at))),
                binding=grant.binding.model_copy(deep=True),kind=kind)
            pending=Pending(command,asyncio.get_running_loop().create_future()); task.operations[operation_id]=pending
            task.snapshot.actions.append({'operationId':operation_id,'name':name,'kind':kind,'status':'pending'})
            task.snapshot.actions=task.snapshot.actions[-64:]
            self.persist(task); task.queue.set()
            try:
                result=await asyncio.wait_for(pending.future,15)
                self.check(task_id,actor)
                # A Future retains its result; replace it with metadata before
                # returning the only transient image reference to the caller.
                if isinstance(result,ObservationResult):
                    pending.future=asyncio.get_running_loop().create_future()
                    pending.future.set_result(pending.result_receipt)
                return result
            except (asyncio.CancelledError,asyncio.TimeoutError):
                self.action_status(task,operation_id,'outcome_unknown' if pending.claim_id and kind=='action' else 'cancelled')
                self.persist(task)
                raise

    def action_status(self, task, operation_id, status, **details):
        for action in task.snapshot.actions:
            if action['operationId']==operation_id:
                action.update(status=status,**details)

    async def claim(self, task_id, operation_id, binding, actor):
        task=self.check(task_id,actor,binding=binding)
        op=task.operations.get(operation_id)
        if not op or op.claim_id or op.future.done() or parse_iso_z(op.command.deadline)<=utc_now():
            raise HTTPException(409,'This command cannot be claimed.')
        op.claim_id='claim-'+uuid4().hex
        self.action_status(task,operation_id,'claimed'); self.persist(task)
        return op.command.model_copy(update={'claim_id':op.claim_id},deep=True)

    def pending_result(self, task_id, operation_id, claim_id, binding, actor, payload):
        task=self.check(task_id,actor)
        op=task.operations.get(operation_id)
        if not op or op.claim_id!=claim_id or parse_iso_z(op.command.deadline)<=utc_now(): raise HTTPException(409,'Result is no longer expected.')
        digest=identity(payload)
        if op.result_digest:
            if digest!=op.result_digest or binding!=op.command.binding: raise HTTPException(409,'Result identity changed.')
            return task,op,True
        self.check(task_id,actor,binding=binding)
        if op.future.done(): raise HTTPException(409,'Result is no longer expected.')
        return task,op,False

    async def complete_manifest(self, task_id, operation_id, claim_id, binding, page, actor):
        task,op,duplicate=self.pending_result(task_id,operation_id,claim_id,binding,actor,page)
        if op.command.kind!='manifest': raise HTTPException(409,'Unexpected inventory result.')
        if duplicate: return {'accepted':True}
        op.result_digest=identity(page)
        op.result_receipt={'manifestId':page.manifest_id,'offset':page.offset,'count':len(page.frames)}
        op.future.set_result(page); self.action_status(task,operation_id,'completed'); self.persist(task)
        return {'accepted':True}

    async def complete(self, task_id, binding, result, actor):
        task,op,duplicate=self.pending_result(task_id,result.operation_id,result.claim_id,binding,actor,result)
        if op.command.kind!='action' or result.before_revision!=op.command.expected_revision or result.revision not in {result.before_revision,result.before_revision+1}:
            raise HTTPException(409,'Unexpected action result.')
        if duplicate: return {'accepted':True}
        state=bound_json(safe_state(result.state),32768)
        if state.get('studyId',binding.study_id)!=binding.study_id: raise HTTPException(409,'The study changed.')
        receipt={'status':result.status,'state':state,'canUndo':result.can_undo,'revision':result.revision}
        op.result_digest=identity(result)
        op.result_receipt=receipt; op.future.set_result(receipt)
        task.snapshot.grant.binding=task.snapshot.grant.binding.model_copy(update={'revision':result.revision})
        row=self.live.repository.owned(task.snapshot.grant.session_id,actor,active=True)
        context=row['viewerContext']
        self.live.repository.change(row['sessionId'],context_json={**context,'state':{**context.get('state',{}),**state}})
        self.action_status(task,result.operation_id,result.status,result=receipt); self.persist(task)
        return {'accepted':True,'revision':result.revision}

    async def complete_observation(self, task_id, binding, result, actor):
        task,op,duplicate=self.pending_result(task_id,result.operation_id,result.claim_id,binding,actor,result)
        if op.command.kind!='observe' or result.revision!=op.command.expected_revision: raise HTTPException(409,'Unexpected observation result.')
        if duplicate: return {'accepted':True}
        request=ObservationRequest.model_validate(op.command.args)
        expected=set(request.frame_ids)
        if request.kind=='series_frames':
            for image in result.images:
                if image.kind!='frame' or image.manifest_id!=request.manifest_id or image.frame_id not in expected:
                    raise HTTPException(409,'Image is outside the requested scope.')
            succeeded={i.frame_id for i in result.images}; failed={f.id for f in result.failures}
            if len(succeeded)!=len(result.images) or succeeded & failed or succeeded | failed != expected:
                raise HTTPException(409,'Incomplete or duplicate frame receipt.')
            ledger=task.ledgers[request.manifest_id]
            if any(i.index!=ledger.indices[i.frame_id] for i in result.images): raise HTTPException(409,'Mismatched frame index.')
        elif any(image.kind not in {'overview','pane'} for image in result.images): raise HTTPException(409,'Unexpected image kind.')
        for image in result.images:
            if not -5 <= (utc_now()-parse_iso_z(image.captured_at)).total_seconds() <= 30: raise HTTPException(409,'Capture expired.')
        op.result_digest=identity(result)
        op.result_receipt={'images':[i.receipt() for i in result.images],'failures':[f.wire() for f in result.failures],'pixelsUnavailable':True}
        op.future.set_result(result)
        self.action_status(task,result.operation_id,'completed',result=op.result_receipt); self.persist(task)
        return {'accepted':True}

    async def decide(self, task_id, operation_id, decision, actor):
        task=self.check(task_id,actor)
        if 'propose_durable' not in task.snapshot.grant.permissions: raise HTTPException(403,'Viewer tools were not granted.')
        return self.live.actions.decide(task.snapshot.grant.session_id,operation_id,decision,actor,grant=task.snapshot.grant.grant_id)

    async def revoke(self, task_id, actor, *, status='cancelled'):
        self.owned(task_id,actor)
        task=self.tasks.get(task_id)
        if not task or task.closing: return await self.snapshot(task_id,actor)
        task.closing=True
        task.snapshot.status=status; task.snapshot.grant.status='revoked'; task.snapshot.activity=None
        self.live.actions.release_viewer(actor,task.snapshot.grant.grant_id)
        for key,op in task.operations.items():
            if not op.future.done():
                self.action_status(task,key,'outcome_unknown' if op.claim_id and op.command.kind=='action' else 'cancelled')
                op.future.cancel()
        task.queue.set(); self.persist(task)
        current=asyncio.current_task()
        cleanup=[t for t in (task.inventory_task,task.watcher) if t and t is not current and not t.done()]
        for t in cleanup: t.cancel()
        await asyncio.gather(*cleanup,return_exceptions=True)
        if task.turn_id:
            worker=self.live.text.tasks.get((task.snapshot.grant.session_id,task.turn_id))
            if worker and worker is not current:
                await self.live.text.cancel(task.snapshot.grant.session_id,task.turn_id)
        self.tasks.pop(task_id,None)
        return task.snapshot.model_copy(deep=True)

    async def takeover(self, task_id, actor): return await self.revoke(task_id,actor,status='paused')

    async def continue_run(self, previous_task_id, selection, binding, actor):
        previous=self.owned(previous_task_id,actor)
        if previous_task_id in self.tasks: raise HTTPException(409,'Stop the current task before continuing.')
        grant=previous['snapshot']['grant']
        if grant['scope']!=selection.wire(): raise HTTPException(409,'Choose the same scope to continue coverage.')
        return await self.prepare(grant['sessionId'],selection,binding,actor,continuation=previous)

    async def sweep(self):
        for task_id,task in list(self.tasks.items()):
            try: self.check(task_id,task.actor)
            except HTTPException:
                # Internal revocation must work after account expiry/disablement.
                await self._expire(task_id,task)

    async def _expire(self, task_id, task, *, status='interrupted'):
        task.closing=True; task.snapshot.status=status; task.snapshot.grant.status='revoked'; task.snapshot.activity=None
        self.live.actions.release_viewer(task.actor,task.snapshot.grant.grant_id)
        for key,op in task.operations.items():
            if not op.future.done():
                self.action_status(task,key,'outcome_unknown' if op.claim_id and op.command.kind=='action' else 'interrupted'); op.future.cancel()
        self.persist(task); task.queue.set()
        current=asyncio.current_task()
        for job in (task.inventory_task,task.watcher,self.live.text.tasks.get((task.snapshot.grant.session_id,task.turn_id))):
            if job and job is not current and not job.done(): job.cancel()
        self.tasks.pop(task_id,None)

    async def watch(self, task_id, actor):
        try:
            while task_id in self.tasks:
                await asyncio.sleep(1)
                await self.sweep()
        except asyncio.CancelledError: pass

    async def stop_owner(self, actor):
        for task_id,task in list(self.tasks.items()):
            if task.actor.sub==actor.sub: await self._expire(task_id,task)

    async def stop_session(self, session_id, *, status='cancelled'):
        for task_id,task in list(self.tasks.items()):
            if task.snapshot.grant.session_id==session_id:
                await self._expire(task_id,task,status=status)

    async def delete_source(self, session_id, actor):
        self.live.repository.owned(session_id,actor)
        await self.stop_session(session_id)
        self.repo.delete_source(session_id)

    async def shutdown(self):
        jobs=[t.watcher for t in self.tasks.values() if t.watcher]+[t.inventory_task for t in self.tasks.values() if t.inventory_task]
        for task_id,task in list(self.tasks.items()): await self._expire(task_id,task)
        await asyncio.gather(*jobs,return_exceptions=True)
