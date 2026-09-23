"""Selections cannot change source bytes, evade plan validation or leak excluded claims."""
import asyncio
import pytest
from backend.evidence_review.artifacts import ArtifactStore
from backend.evidence_review.contracts import Limits
from backend.evidence_review.units import build_review_plan
from backend.evidence_review.runner import evaluate_snapshot, LocalStorageFailure
from backend.tests.evidence_review.test_runner import ScriptedEvaluator


def test_selection_preserves_unicode_answer_and_source_pairs(snapshot_factory):
    from backend.evidence_review.units import select_review_plan
    snap = snapshot_factory(answer='Nodule ≤6 mm [s1][s2]. Follow-up differs [s1].', evidence_count=2)
    full = build_review_plan(snap, limits=Limits())
    chosen = select_review_plan(full, selected_unit_ids=(full.units[0].unit_id,))
    assert len(chosen.pairs) == 2 and chosen.units == full.units
    assert all(p.unit.text == snap.result.summary[p.unit.start:p.unit.end] for p in chosen.pairs)
    assert {p.evidence.citation_id for p in chosen.pairs} == {'s1', 's2'}
    assert any(p.reason == 'user_excluded' for p in chosen.excluded_pairs)
    assert select_review_plan(full, selected_unit_ids=None) == full


@pytest.mark.parametrize('kind', ['empty', 'unknown', 'duplicate'])
def test_invalid_selection_rejected(kind, snapshot_factory):
    from backend.evidence_review.units import select_review_plan
    full = build_review_plan(snapshot_factory(), limits=Limits())
    uid = full.units[0].unit_id
    values = {'empty': (), 'unknown': ('other',), 'duplicate': (uid, uid)}
    with pytest.raises(ValueError, match='invalid_unit_selection'):
        select_review_plan(full, selected_unit_ids=values[kind])


def test_selection_resume_and_forged_plan(snapshot_factory, tmp_path):
    from backend.evidence_review.units import select_review_plan
    async def scenario():
        snap = snapshot_factory(answer='First [s1]. PRIVATE_EXCLUDED [s1].')
        full = build_review_plan(snap, limits=Limits())
        selected = (full.units[0].unit_id,)
        plan = select_review_plan(full, selected_unit_ids=selected)
        adapter = ScriptedEvaluator()
        with ArtifactStore.create(tmp_path/'private', run_id='selected') as store:
            result = await evaluate_snapshot(snap, plan, adapter=adapter, store=store, limits=Limits(),
                cancel=asyncio.Event(), selected_unit_ids=selected)
            assert len(adapter.bodies) == 1 and b'PRIVATE_EXCLUDED' not in adapter.bodies[0]
            view = store.load_run()
            fresh = ScriptedEvaluator()
            await evaluate_snapshot(snap, plan, adapter=fresh, store=store, limits=Limits(),
                cancel=asyncio.Event(), selected_unit_ids=selected, resume=view)
            assert not fresh.bodies
            with pytest.raises(ValueError, match='evaluation_input_mismatch'):
                await evaluate_snapshot(snap, full, adapter=fresh, store=store, limits=Limits(),
                    cancel=asyncio.Event(), selected_unit_ids=tuple(u.unit_id for u in full.units), resume=view)
            with pytest.raises(ValueError, match='evaluation_input_mismatch'):
                await evaluate_snapshot(snap, plan, adapter=fresh, store=store, limits=Limits(), cancel=asyncio.Event())
            assert result.assessments[0].status == 'completed'
    asyncio.run(scenario())


def test_guard_and_committed_progress(snapshot_factory, tmp_path):
    async def scenario():
        snap = snapshot_factory(answer='First [s1]. Second [s1].')
        plan = build_review_plan(snap, limits=Limits())
        commits = []
        calls = 0
        def guard():
            nonlocal calls
            calls += 1
            return 'authorization_expired' if calls > 1 else None
        class Inspect(ScriptedEvaluator):
            async def attempt(self, request):
                assert commits[-1].interrupted_attempt_ids
                return await super().attempt(request)
        adapter = Inspect()
        with ArtifactStore.create(tmp_path/'private', run_id='guard') as store:
            result = await evaluate_snapshot(snap, plan, adapter=adapter, store=store,
                limits=Limits(concurrency=1), cancel=asyncio.Event(), before_attempt=guard, on_commit=commits.append)
            assert len(adapter.bodies) == 1
            assert [a.status for a in result.assessments] == ['completed', 'failed']
            assert result.attempts[-1].outcome.submitted is False
            assert result.attempts[-1].outcome.reason == 'authorization_expired'
            assert commits[-1].result == result
    asyncio.run(scenario())


def test_guard_blocks_first_attempt(snapshot_factory, tmp_path):
    async def scenario():
        snap = snapshot_factory(); adapter = ScriptedEvaluator()
        with ArtifactStore.create(tmp_path/'private', run_id='no-dispatch') as store:
            result = await evaluate_snapshot(snap, build_review_plan(snap, limits=Limits()), adapter=adapter,
                store=store, limits=Limits(), cancel=asyncio.Event(), before_attempt=lambda: 'authorization_expired')
            assert not adapter.bodies
            assert all(a.outcome and not a.outcome.submitted for a in result.attempts)
    asyncio.run(scenario())


def test_progress_storage_failure_stops_dispatch(snapshot_factory, tmp_path):
    async def scenario():
        snap = snapshot_factory(); adapter = ScriptedEvaluator()
        def broken(view):
            if view.attempts: raise OSError('private-database-path')
        with ArtifactStore.create(tmp_path/'private', run_id='broken') as store:
            with pytest.raises(LocalStorageFailure, match='local_storage_failure'):
                await evaluate_snapshot(snap, build_review_plan(snap, limits=Limits()), adapter=adapter,
                    store=store, limits=Limits(), cancel=asyncio.Event(), on_commit=broken)
            assert not adapter.bodies
            assert store.load_run().interrupted_attempt_ids
    asyncio.run(scenario())


def test_terminal_whitespace_preserves_original_claim_offsets(snapshot_factory):
    snap=snapshot_factory(answer='  First [s1]. Second [s1].  \n')
    plan=build_review_plan(snap,limits=Limits())
    assert len(plan.pairs)==2
    assert [u.text for u in plan.units]==['First [s1].','Second [s1].']
    assert all(u.text==snap.result.summary[u.start:u.end] for u in plan.units)
