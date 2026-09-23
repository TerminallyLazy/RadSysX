import asyncio
from dataclasses import replace

import pytest

from backend.evidence_review.artifacts import ArtifactStore
from backend.evidence_review.contracts import AttemptOutcome, Judgment, Limits, LABELS
from backend.evidence_review.rubric import prepare_jev
from backend.evidence_review.units import build_review_plan


def supported_outcome():
    return AttemptOutcome(judgment=Judgment(label='supported',requested_model='jev-1.13.0',resolved_model='jev-1.13.0',
        probabilities={label:float(label=='supported') for label in LABELS},confidence=1.0),submitted=True,usage={'input_tokens':10,'output_tokens':1})


class ScriptedEvaluator:
    evaluator_id='jev'
    model='jev-1.13.0'
    def __init__(self,outcomes=()):
        self.outcomes=list(outcomes); self.bodies=[]; self.active=0; self.max_active=0
    def prepare(self,pair): return prepare_jev(pair)
    async def attempt(self,request):
        self.bodies.append(request.body); self.active+=1; self.max_active=max(self.active,self.max_active)
        try:
            value=self.outcomes.pop(0) if self.outcomes else supported_outcome()
            return await value() if callable(value) else value
        finally: self.active-=1


def test_retry_identical_and_completed_resume(snapshot_factory,tmp_path):
    from backend.evidence_review.runner import evaluate_snapshot
    async def scenario():
        snap=snapshot_factory(); plan=build_review_plan(snap,limits=Limits())
        adapter=ScriptedEvaluator([AttemptOutcome(reason='overloaded',retryable=True,submitted=True,retry_after_seconds=0),supported_outcome()])
        with ArtifactStore.create(tmp_path/'private',run_id='retry') as store:
            result=await evaluate_snapshot(snap,plan,adapter=adapter,store=store,limits=Limits(),cancel=asyncio.Event())
            assert adapter.bodies[0]==adapter.bodies[1]
            assert result.assessments[0].status=='completed' and len(result.attempts)==2
            fresh=ScriptedEvaluator()
            reused=await evaluate_snapshot(snap,plan,adapter=fresh,store=store,limits=Limits(),cancel=asyncio.Event(),resume=store.load_run())
            assert fresh.bodies==[] and reused.assessments[0].reused_from
            assert reused.attempts==result.attempts
    asyncio.run(scenario())


@pytest.mark.parametrize('stage',['before','during','backoff'])
def test_cancellation_is_durable(stage,snapshot_factory,tmp_path):
    from backend.evidence_review.runner import evaluate_snapshot
    async def scenario():
        cancel=asyncio.Event()
        async def waiting():
            cancel.set()
            await asyncio.Event().wait()
        if stage=='before': cancel.set()
        outcome=AttemptOutcome(reason='overloaded',retryable=True,submitted=True,retry_after_seconds=30)
        class Backoff(ScriptedEvaluator):
            async def attempt(self,request):
                result=await super().attempt(request)
                cancel.set()
                return result
        adapter=Backoff([outcome]) if stage=='backoff' else ScriptedEvaluator([waiting])
        snap=snapshot_factory(answer='First [s1]. Second [s1]. Third [s1].')
        with ArtifactStore.create(tmp_path/'private',run_id='cancel') as store:
            result=await evaluate_snapshot(snap,build_review_plan(snap,limits=Limits()),adapter=adapter,store=store,limits=Limits(),cancel=cancel)
            assert all(a.status=='cancelled' for a in result.assessments)
            assert adapter.active==0 and adapter.max_active<=2
            assert len(adapter.bodies)==(0 if stage=='before' else 1)
            assert store.load_run().result==result
    asyncio.run(scenario())


def test_fatal_stops_queued_but_preserves_inflight(snapshot_factory,tmp_path):
    from backend.evidence_review.runner import evaluate_snapshot
    async def scenario():
        second_started=asyncio.Event()
        async def fatal():
            await second_started.wait()
            return AttemptOutcome(reason='credential_rejected',stop_evaluator=True,submitted=True)
        async def finish():
            second_started.set(); await asyncio.sleep(0)
            return supported_outcome()
        adapter=ScriptedEvaluator([fatal,finish])
        snap=snapshot_factory(answer='First [s1]. Second [s1]. Third [s1]. Fourth [s1].')
        with ArtifactStore.create(tmp_path/'private',run_id='fatal') as store:
            result=await evaluate_snapshot(snap,build_review_plan(snap,limits=Limits()),adapter=adapter,store=store,limits=Limits(),cancel=asyncio.Event())
            assert len(adapter.bodies)==2 and adapter.max_active==2
            assert [a.status for a in result.assessments]==['failed','completed','skipped','skipped']
            assert result.evaluator_failure=='credential_rejected'
    asyncio.run(scenario())


def test_snapshot_deadline_dispatched_vs_queued(snapshot_factory,tmp_path):
    from backend.evidence_review.runner import evaluate_snapshot
    async def scenario():
        async def never(): await asyncio.Event().wait()
        adapter=ScriptedEvaluator([never,never])
        limits=Limits(snapshot_seconds=.025,attempt_seconds=1)
        snap=snapshot_factory(answer='First [s1]. Second [s1]. Third [s1].')
        with ArtifactStore.create(tmp_path/'private',run_id='deadline') as store:
            result=await evaluate_snapshot(snap,build_review_plan(snap,limits=limits),adapter=adapter,store=store,limits=limits,cancel=asyncio.Event())
            assert [a.status for a in result.assessments]==['failed','failed','skipped']
            assert all(a.reason=='snapshot_deadline' for a in result.assessments)
            assert all(a.outcome.submitted and a.outcome.usage is None for a in result.attempts)
    asyncio.run(scenario())


def test_input_and_storage_rejection_prevent_dispatch(snapshot_factory,tmp_path,monkeypatch):
    from backend.evidence_review.runner import evaluate_snapshot, LocalStorageFailure
    async def scenario():
        snap=snapshot_factory(); plan=build_review_plan(snap,limits=Limits()); adapter=ScriptedEvaluator()
        with ArtifactStore.create(tmp_path/'private',run_id='reject') as store:
            with pytest.raises(ValueError):
                await evaluate_snapshot(snap.model_copy(update={'answer_sha256':'0'*64}),plan,adapter=adapter,store=store,limits=Limits(),cancel=asyncio.Event())
            def failed(*a,**k): raise OSError('sensitive-path')
            monkeypatch.setattr(store,'commit_manifest',failed)
            with pytest.raises(LocalStorageFailure,match='local_storage_failure'):
                await evaluate_snapshot(snap,plan,adapter=adapter,store=store,limits=Limits(),cancel=asyncio.Event())
            assert adapter.bodies==[]
    asyncio.run(scenario())


def test_request_change_prevents_reuse(snapshot_factory,tmp_path):
    from backend.evidence_review.runner import evaluate_snapshot
    from backend.evidence_review.serialization import sha256_bytes
    async def scenario():
        snap=snapshot_factory(); plan=build_review_plan(snap,limits=Limits())
        with ArtifactStore.create(tmp_path/'private',run_id='change') as store:
            await evaluate_snapshot(snap,plan,adapter=ScriptedEvaluator(),store=store,limits=Limits(),cancel=asyncio.Event())
            class Changed(ScriptedEvaluator):
                def prepare(self,pair):
                    old=prepare_jev(pair); body=old.body+b' '
                    return replace(old,body=body,request_sha256=sha256_bytes(body))
            adapter=Changed()
            result=await evaluate_snapshot(snap,plan,adapter=adapter,store=store,limits=Limits(),cancel=asyncio.Event(),resume=store.load_run())
            assert len(adapter.bodies)==1 and result.assessments[0].reused_from is None
    asyncio.run(scenario())


def test_dispatch_has_durable_start_and_overflow_is_excluded(snapshot_factory,tmp_path):
    from backend.evidence_review.runner import evaluate_snapshot
    async def scenario():
        snap=snapshot_factory(answer=' '.join(f'Claim {i} [s1].' for i in range(45)))
        with ArtifactStore.create(tmp_path/'private',run_id='bounded') as store:
            class Inspect(ScriptedEvaluator):
                async def attempt(self,request):
                    assert store.load_run().interrupted_attempt_ids
                    return await super().attempt(request)
            adapter=Inspect()
            result=await evaluate_snapshot(snap,build_review_plan(snap,limits=Limits()),adapter=adapter,store=store,limits=Limits(),cancel=asyncio.Event())
            assert len(adapter.bodies)==40 and len(result.excluded_pairs)==5
            assert all(p.reason=='pair_limit' for p in result.excluded_pairs)
    asyncio.run(scenario())


def test_interrupted_resume_preserves_unknown_attempt(snapshot_factory,tmp_path):
    from backend.evidence_review.runner import evaluate_snapshot
    from backend.evidence_review.contracts import AttemptRecord
    from datetime import datetime,timezone
    async def scenario():
        snap=snapshot_factory(); plan=build_review_plan(snap,limits=Limits())
        with ArtifactStore.create(tmp_path/'private',run_id='interrupted') as store:
            ref=store.put_record(snap,kind='snapshot')
            old=AttemptRecord(attempt_id='interrupted',pair_id=plan.pairs[0].pair_id,
                request_sha256=prepare_jev(plan.pairs[0]).request_sha256,started_at=datetime.now(timezone.utc))
            attempt_ref=store.put_record(old,kind='attempt')
            store.commit_manifest({'schema_version':1,'objects':[ref,attempt_ref],'snapshot_ref':ref,'attempt_refs':[attempt_ref]})
            result=await evaluate_snapshot(snap,plan,adapter=ScriptedEvaluator(),store=store,limits=Limits(),cancel=asyncio.Event(),resume=store.load_run())
            assert len(result.attempts)==2 and result.attempts[0].outcome is None
            assert result.assessments[0].status=='completed'
    asyncio.run(scenario())


def test_cancellation_during_start_commit_never_dispatches(snapshot_factory,tmp_path,monkeypatch):
    from backend.evidence_review.runner import evaluate_snapshot
    async def scenario():
        cancel=asyncio.Event(); snap=snapshot_factory(); adapter=ScriptedEvaluator()
        with ArtifactStore.create(tmp_path/'private',run_id='commit-cancel') as store:
            commit=store.commit_manifest
            def wrapped(manifest):
                ref=commit(manifest)
                if manifest.get('attempt_refs'): cancel.set()
                return ref
            monkeypatch.setattr(store,'commit_manifest',wrapped)
            result=await evaluate_snapshot(snap,build_review_plan(snap,limits=Limits()),adapter=adapter,store=store,limits=Limits(),cancel=cancel)
            assert adapter.bodies==[] and result.assessments[0].status=='cancelled'
            assert result.attempts[0].outcome.submitted is False
    asyncio.run(scenario())
