import pytest


def test_rates_explicit_denominators_and_matrix():
    from backend.evidence_review.metrics import classification_metrics
    result=classification_metrics(['supported','supported','not_addressed','mixed'],['supported','contradicted','mixed','not_addressed'])
    assert result['incorrect_support']=={'numerator':1,'denominator':2,'value':.5}
    assert result['missed_contradiction']=={'numerator':2,'denominator':2,'value':1.0}
    assert result['false_contradiction_alert']=={'numerator':1,'denominator':2,'value':.5}
    assert result['per_label']['supported']['precision']['value']==.5
    assert result['per_label']['supported']['recall']['value']==1
    assert sum(map(sum,result['confusion_matrix']))==4
    assert result['per_label']['partially_supported']['recall']['value'] is None


def test_empty_invalid_and_unaligned():
    from backend.evidence_review.metrics import classification_metrics
    assert classification_metrics([],[])['incorrect_support']['value'] is None
    with pytest.raises(ValueError): classification_metrics(['unknown'],['supported'])
    with pytest.raises(ValueError): classification_metrics(['supported'],[])


def test_bootstrap_repeated_cluster_draws_are_deterministic():
    from backend.evidence_review.metrics import paired_bootstrap
    rows=[{'topic_family':str(i//2),'left':'supported','right':'not_addressed','reference':'supported'} for i in range(6)]
    first=paired_bootstrap(rows,seed=42)
    assert first==paired_bootstrap(rows,seed=42)
    assert first['accuracy']['difference']==1.0
    assert first['accuracy']['interval']==[1.0,1.0]
    assert first['incorrect_support']['interval'] is None
    assert paired_bootstrap(rows[:2],seed=42)['accuracy']['interval'] is None


def test_accounting_preserves_unknown_and_cached_latency():
    from datetime import datetime,timezone
    from backend.evidence_review.contracts import AttemptRecord,AttemptOutcome
    from backend.evidence_review.metrics import usage_summary,latencies
    attempts=[AttemptRecord(attempt_id='a',pair_id='p',request_sha256='0'*64,started_at=datetime.now(timezone.utc)),
        AttemptRecord(attempt_id='b',pair_id='p',request_sha256='0'*64,started_at=datetime.now(timezone.utc),
            outcome=AttemptOutcome(reason='timeout',submitted=True,usage={'input_tokens':10}))]
    result=usage_summary(attempts,pricing=None)
    assert result['unknown_usage_attempts']==1 and result['known_usage']['input_tokens']==10
    assert result['known_cost_usd'] is None and result['cost_is_complete'] is False
    assert latencies([1,2,3,4])=={'count':4,'p50':2,'p95':4}


def test_comparison_alignment_failed_contradictions_and_cache(snapshot_factory,tmp_path):
    import asyncio
    from backend.evidence_review.artifacts import ArtifactStore
    from backend.evidence_review.contracts import Limits,RunResult,AttemptOutcome
    from backend.evidence_review.runner import evaluate_snapshot
    from backend.evidence_review.study import freeze_references
    from backend.evidence_review.metrics import compare_runs
    from backend.evidence_review.units import build_review_plan
    from backend.tests.evidence_review.test_study import tiny_study,review
    from backend.tests.evidence_review.test_runner import ScriptedEvaluator
    async def scenario():
        manifest,snapshots=tiny_study(snapshot_factory); snap=next(iter(snapshots.values())); case=manifest.cases[0]
        refs=freeze_references(manifest,(review(case,'a','contradicted'),review(case,'b','contradicted')),())
        with ArtifactStore.create(tmp_path/'private',run_id='failed') as store:
            run=await evaluate_snapshot(snap,build_review_plan(snap,limits=Limits()),adapter=ScriptedEvaluator([AttemptOutcome(reason='timeout',submitted=True)]),
                store=store,limits=Limits(),cancel=asyncio.Event())
        comparison=compare_runs(manifest,refs,(run,),snapshots=snapshots)
        result=comparison.evaluators['jev:jev-1.13.0']
        assert result['unreviewed_reference_contradictions']==1
        assert result['classification']['missed_contradiction']['value'] is None
        assert result['accounting']['unknown_usage_attempts']==1
        with pytest.raises(ValueError): compare_runs(manifest,refs,(run,run),snapshots=snapshots)
    asyncio.run(scenario())


def test_held_out_comparison_requires_frozen_experiment(snapshot_factory):
    from backend.evidence_review.metrics import compare_runs
    from backend.evidence_review.study import freeze_references
    from backend.tests.evidence_review.test_study import tiny_study,review
    manifest,snapshots=tiny_study(snapshot_factory)
    manifest=manifest.model_copy(update={'cases':(manifest.cases[0].model_copy(update={'partition':'held_out'}),)})
    case=manifest.cases[0]
    refs=freeze_references(manifest,(review(case,'a'),review(case,'b')),())
    with pytest.raises(ValueError,match='held_out_experiment_required'):
        compare_runs(manifest,refs,(),snapshots=snapshots)
