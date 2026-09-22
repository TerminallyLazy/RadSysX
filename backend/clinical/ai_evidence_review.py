"""Explicit owned public-evidence jobs. No review is sent to the live assistant."""
from __future__ import annotations

import asyncio
import os
from contextlib import nullcontext
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace

from fastapi import HTTPException

from .ai_evidence_contracts import EvidenceReviewAvailability, EvidenceReviewDetail, EvidenceReviewList, EvidenceReviewSummary
from .ai_evidence_repository import EvidenceReviewRepository, identity
from .ai_evidence_artifacts import ReviewArtifacts, progress, project
from .contracts import parse_iso_z, utc_now
from ..evidence_review.contracts import Limits, ResearchResult, freeze_snapshot
from ..evidence_review.serialization import canonical_json
from ..evidence_review.units import build_review_plan, select_review_plan
from ..evidence_review.pubmed import canonical_pmid, fetch_pubmed_evidence
from ..evidence_review.transport import new_http_client
from ..evidence_review.typesafe import TypeSafeAdapter
from ..evidence_review.runner import evaluate_snapshot, LocalStorageFailure


@dataclass
class ReviewJob:
    actor: object
    row: object
    phase: str
    cancel: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task | None = None
    store: object = None
    reason: str | None = None


class EvidenceReviewService:
    def __init__(self, live):
        self.live = live
        self.repository = EvidenceReviewRepository(live)
        database = live.clinical_repository._engine.url
        configured = live.config.evidence_dir
        self.root = (Path(configured) if configured else Path(database.database).absolute().parent / '.ai-evidence'
            if database.get_backend_name() == 'sqlite' and database.database not in {None, '', ':memory:'} else None)
        self.jobs: dict[str, ReviewJob] = {}
        self.owner_epochs: dict[str, int] = {}
        self.admission = asyncio.Lock()
        self.limits = Limits()

    def require(self, actor):
        self.live.require_actor(actor)
        if not self.live.config.enabled or self.live.config.app_mode not in {'research','pilot'}:
            raise HTTPException(403, 'Evidence review is disabled in this runtime.')

    def availability(self):
        if not self.live.config.enabled or self.live.config.app_mode not in {'research','pilot'}:
            state,reason='disabled','Evidence review is disabled in this runtime.'
        elif self.root is None or not self.root.is_absolute() or os.name!='posix':
            state,reason='unavailable','Private evidence storage is unavailable.'
        elif not self.live.config.typesafe_api_key.get_secret_value():
            state,reason='missing','Add RADSYSX_TYPESAFE_AI_API_KEY to backend settings.'
        else:
            state,reason='configured','Configured; only a completed receipt proves Jev ran.'
        return EvidenceReviewAvailability(availability=state,reason=reason)

    def artifacts(self,row):
        if self.root is None or not self.root.is_absolute() or os.name!='posix':
            raise HTTPException(503, 'Private evidence storage is unavailable.')
        return ReviewArtifacts(self.root,row.run_id)

    def _summary(self,row):
        values={k:v for k,v in row.progress_json.items() if k in {
            'generation','totalPairs','completedPairs','settledPairs','submittedAttempts','unknownUsageAttempts'}}
        return EvidenceReviewSummary(review_id=row.id,session_id=row.session_id,tool_call_id=row.tool_id,
            source_context_version=row.context_version,status=row.status,created_at=row.created_at,
            updated_at=row.updated_at,reason=row.reason,**values)

    def list(self,actor,session_id):
        self.require(actor)
        rows=self.repository.list_owned(actor,session_id,limit=101)
        return EvidenceReviewList(reviews=[self._summary(r) for r in rows[:100]],truncated=len(rows)>100)

    def _preview(self,row,store=None):
        value=self.artifacts(row).read_preview(row.preview_ref,store=store)
        if value['preview_hash'] != row.preview_hash:
            raise ValueError('preview_identity_changed')
        return value

    def get(self,actor,review_id):
        self.require(actor)
        row=self.repository.owned(actor,review_id)
        detail=EvidenceReviewDetail(**self._summary(row).model_dump(),preview_sha256=row.preview_hash,
                                    selected_unit_ids=row.selection)
        if not row.preview_ref: return detail
        job=self.jobs.get(review_id)
        if row.status in {'preparing','reviewing'} and job is None:
            detail.status='interrupted'; detail.reason='review_execution_interrupted'
        try:
            with (nullcontext(job.store) if job and job.store else self.artifacts(row).open_run()) as store:
                return project(detail,self._preview(row,store),store.load_run())
        except (OSError,ValueError,HTTPException):
            detail.status='unavailable'; detail.reason='review_artifacts_unavailable'
            return detail

    def dispatch_block_reason(self,actor,review_id,generation):
        try:
            self.require(actor)
            row=self.repository.owned(actor,review_id)
            job=self.jobs.get(review_id)
            if row.generation != generation or (job and job.cancel.is_set()): return 'cancelled'
            tool=self.live.repository.tool(row.session_id,row.tool_id)
            if tool['name']!='research_run' or tool['status']!='completed' or identity(tool['result'])!=row.source_hash:
                return 'source_changed'
        except HTTPException:
            return 'review_authority_changed'
        return None

    def _capacity(self,actor):
        active=[j for j in self.jobs.values() if j.task is not None and not j.task.done()]
        if len(active)>=2 or any(j.actor.sub==actor.sub for j in active):
            raise HTTPException(409, 'An evidence review is already active. Wait or cancel it.')

    def _launch(self,actor,row,phase):
        job=ReviewJob(actor,row,phase)
        self.jobs[row.id]=job
        job.task=asyncio.create_task(self._work(job))

    async def prepare(self,actor,session_id,tool_id,request):
        self.require(actor)
        epoch=self.owner_epochs.get(actor.sub,0)
        async with self.live.owner_lock(actor):
            self.require(actor)
            if epoch!=self.owner_epochs.get(actor.sub,0):
                raise HTTPException(409,'Account settings changed. Review the action again.')
            self.live.repository.owned(session_id,actor)
            previous=self.repository.existing_operation(actor,'prepare',request.idempotency_key,identity([session_id,tool_id]))
            if previous: return self.get(actor,previous)
            tool=self.live.repository.tool(session_id,tool_id)
            if tool['name']!='research_run' or tool['status']!='completed' or not isinstance(tool['result'],dict):
                raise HTTPException(422,'Choose a completed public PubMed research result.')
            try:
                result=self._result(tool)
            except (ValueError,TypeError):
                raise HTTPException(422,'The research result cannot be reviewed.') from None
            if not any(canonical_pmid(s.url) for s in result.sources):
                raise HTTPException(422,'This research result has no canonical PubMed sources.')
            if self.availability().availability=='unavailable':
                raise HTTPException(503,'Private evidence storage is unavailable.')
            async with self.admission:
                self._capacity(actor)
                row=self.repository.create_owned(actor,session_id,tool_id,request)
                self._launch(actor,row,'preparing')
            return self.get(actor,row.id)

    @staticmethod
    def _result(tool):
        result=tool['result']
        return ResearchResult.model_validate_json(canonical_json({k:result[k] for k in ('summary','sources','limitations') if k in result}))

    async def start(self,actor,review_id,request):
        return await self._start(actor,review_id,request,retry=False)

    async def retry(self,actor,review_id,request):
        return await self._start(actor,review_id,request,retry=True)

    async def _start(self,actor,review_id,request,*,retry):
        self.require(actor)
        epoch=self.owner_epochs.get(actor.sub,0)
        async with self.live.owner_lock(actor):
            self.require(actor)
            if epoch!=self.owner_epochs.get(actor.sub,0):
                raise HTTPException(409,'Account settings changed. Review the action again.')
            row=self.repository.owned(actor,review_id)
            if self.dispatch_block_reason(actor,review_id,row.generation):
                raise HTTPException(409,'The original research result is no longer available.')
            if not row.preview_ref or request.preview_sha256!=row.preview_hash:
                raise HTTPException(409,'Review the current immutable preview before starting.')
            operation='retry' if retry else 'start'
            request_hash=identity([review_id,request.model_dump(mode='json',exclude={'idempotency_key'})])
            previous=self.repository.existing_operation(actor,operation,request.idempotency_key,request_hash)
            if previous:
                if previous!=review_id: raise HTTPException(409,'Review operation identity changed.')
                return self.get(actor,review_id)
            if row.status in {'reviewing','completed'}:
                if not retry and row.selection!=list(request.selected_unit_ids):
                    raise HTTPException(409,'The confirmed claim selection cannot change.')
                return self.get(actor,review_id)
            if row.status not in ({'partial','failed','interrupted'} if retry else {'ready'}):
                raise HTTPException(409,'This review cannot start in its current state.')
            try:
                preview=self._preview(row)
                selection=tuple(row.selection or ()) if retry else request.selected_unit_ids
                plan=select_review_plan(preview['plan'],selected_unit_ids=selection)
            except (OSError,ValueError):
                raise HTTPException(409,'The preview or selection is unavailable. Prepare a new review.') from None
            if not self.live.config.typesafe_api_key.get_secret_value():
                raise HTTPException(503,'Jev is not configured in backend settings.')
            selected=[u.unit_id for u in plan.units if u.unit_id in selection]
            async with self.admission:
                self._capacity(actor)
                values={**row.progress_json,'totalPairs':len(plan.pairs)}
                self.repository.claim_operation(actor,review_id,operation,request.idempotency_key,request_hash,
                    expected_generation=row.generation,values={'status':'reviewing','selection':selected,
                    'confirmation':request.confirmation,'generation':row.generation+1,'progress_json':values,'reason':None})
                row=self.repository.owned(actor,review_id)
                self._launch(actor,row,'retry' if retry else 'reviewing')
            return self.get(actor,review_id)

    async def _watch(self,job):
        while True:
            await asyncio.sleep(.1)
            reason=self.dispatch_block_reason(job.actor,job.row.id,job.row.generation)
            if reason:
                job.reason=reason; job.cancel.set(); job.task.cancel()
                return

    def _on_commit(self,job,view):
        values={**job.row.progress_json,**progress(view,job.row.progress_json['totalPairs'])}
        if not self.repository.update_if_current(job.row.id,job.row.generation,progress_json=values):
            raise ValueError('review_authority_changed')

    async def _work(self,job):
        watcher=asyncio.create_task(self._watch(job))
        status,reason='failed',None
        try:
            async with asyncio.timeout(20 if job.phase=='preparing' else 70):
                if self.dispatch_block_reason(job.actor,job.row.id,job.row.generation):
                    raise ValueError('review_authority_changed')
                if job.phase=='preparing':
                    tool=self.live.repository.tool(job.row.session_id,job.row.tool_id)
                    result=self._result(tool)
                    async with new_http_client() as client:
                        evidence,exclusions=await fetch_pubmed_evidence(result.sources,client=client,limits=self.limits,
                            before_request=lambda:self.dispatch_block_reason(job.actor,job.row.id,job.row.generation))
                    if self.dispatch_block_reason(job.actor,job.row.id,job.row.generation):
                        raise ValueError('review_authority_changed')
                    snapshot=freeze_snapshot({'snapshot_id':job.row.id,'created_at':job.row.created_at,
                        'data_class':'public_literature','generation':job.row.progress_json['generation'],
                        'result':result.model_dump(mode='json'),'evidence':[e.model_dump(mode='json') for e in evidence],
                        'capture_exclusions':[e.model_dump(mode='json') for e in exclusions]},limits=self.limits)
                    plan=build_review_plan(snapshot,limits=self.limits)
                    ref,digest=self.artifacts(job.row).create_preview(snapshot,plan,job.row.progress_json['generation'])
                    self.repository.update_if_current(job.row.id,job.row.generation,preview_ref=ref,preview_hash=digest,
                        progress_json={**job.row.progress_json,'totalPairs':len(plan.pairs)})
                    status='ready'
                else:
                    with self.artifacts(job.row).open_run() as store:
                        job.store=store
                        preview=self._preview(job.row,store)
                        plan=select_review_plan(preview['plan'],selected_unit_ids=tuple(job.row.selection))
                        resume=store.load_run() if job.phase=='retry' else None
                        async with new_http_client() as client:
                            result=await evaluate_snapshot(preview['snapshot'],plan,adapter=TypeSafeAdapter(self.live.config.typesafe_api_key,client),
                                store=store,limits=self.limits,cancel=job.cancel,resume=resume,
                                selected_unit_ids=tuple(job.row.selection),
                                before_attempt=lambda:self.dispatch_block_reason(job.actor,job.row.id,job.row.generation),
                                on_commit=lambda view:self._on_commit(job,view))
                        completed=sum(a.status=='completed' for a in result.assessments)
                        status='completed' if completed==len(plan.pairs) else 'partial' if completed else 'failed'
                        reason=result.evaluator_failure
        except asyncio.CancelledError:
            job.cancel.set(); reason=job.reason or 'cancelled'
        except TimeoutError:
            job.cancel.set(); reason='review_deadline'
        except LocalStorageFailure:
            reason='local_storage_failure'
        except Exception:
            reason='review_unavailable'
        finally:
            job.store=None
            watcher.cancel()
            await asyncio.gather(watcher,return_exceptions=True)
            if job.cancel.is_set():
                status=('failed' if reason=='review_deadline' and job.reason is None else
                        'interrupted' if job.reason=='backend_shutdown' else 'cancelled')
                reason=job.reason or reason or 'cancelled'
            try:
                self.repository.update_if_current(job.row.id,job.row.generation,status=status,reason=reason)
            except Exception:
                # GET derives interruption from the absent worker if persistence
                # is unavailable. Never leak DB paths through unhandled tasks.
                pass
            finally:
                if self.jobs.get(job.row.id) is job: self.jobs.pop(job.row.id,None)

    async def _stop_job(self,job,reason):
        job.reason=reason; job.cancel.set()
        job.task.cancel()
        try:
            await asyncio.wait_for(asyncio.shield(job.task),timeout=6)
        except asyncio.CancelledError:
            # A task cancelled before its first instruction has no finally block.
            self.repository.update_if_current(job.row.id,job.row.generation,
                status='interrupted' if reason=='backend_shutdown' else 'cancelled',reason=reason)
            if self.jobs.get(job.row.id) is job: self.jobs.pop(job.row.id,None)
        except TimeoutError:
            raise HTTPException(503,'Evidence review cleanup is still in progress.') from None

    async def cancel(self,actor,review_id):
        self.require(actor)
        async with self.live.owner_lock(actor):
            self.repository.owned(actor,review_id)
            if job:=self.jobs.get(review_id): await self._stop_job(job,'cancelled')
            return self.get(actor,review_id)

    async def stop_owner(self,owner,*,reason):
        self.owner_epochs[owner]=self.owner_epochs.get(owner,0)+1
        for job in list(self.jobs.values()):
            if job.actor.sub==owner: await self._stop_job(job,reason)

    async def shutdown(self):
        for job in list(self.jobs.values()): await self._stop_job(job,'backend_shutdown')

    async def delete_source(self,actor,session_id):
        self.live.require_actor(actor)
        async with self.live.owner_lock(actor):
            async with self.live.session_lock(session_id):
                self.live.repository.owned(session_id,actor)
                rows=self.repository.mark_source_deleting(actor.sub,session_id)
                for row in rows:
                    if job:=self.jobs.get(row.id): await self._stop_job(job,'source_deleted')
                await self.live._stop(session_id)
                try:
                    for row in rows: self.artifacts(row).delete()
                except (OSError,ValueError):
                    raise HTTPException(503,'Private review deletion could not finish. Retry deletion.') from None
                self.live.repository.clear(session_id,actor)
                self.repository.delete_source(actor.sub,session_id)

    def recover(self):
        rows=self.repository.recover()
        for owner,session_id in {(r.owner,r.session_id) for r in rows}:
            try:
                for row in rows:
                    if row.owner==owner and row.session_id==session_id: self.artifacts(row).delete()
                try: self.live.repository.clear(session_id,SimpleNamespace(sub=owner))
                except HTTPException as error:
                    if error.status_code!=404: raise
                self.repository.delete_source(owner,session_id)
            except (OSError,ValueError,HTTPException):
                # Preserve the deletion marker for an explicit retry; no inference.
                continue
