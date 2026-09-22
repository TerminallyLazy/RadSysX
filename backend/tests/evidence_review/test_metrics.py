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


def test_paired_comparison_separates_opposing_partitions(snapshot_factory):
    from datetime import datetime,timezone
    from backend.evidence_review.contracts import Limits,Assessment,Judgment,RunResult,LABELS
    from backend.evidence_review.units import build_review_plan
    from backend.evidence_review.study import StudyCase,StudyManifest,ExperimentConfig,freeze_references
    from backend.evidence_review.metrics import compare_runs
    from backend.evidence_review.rubric import RUBRIC_SHA256
    from backend.tests.evidence_review.test_study import review
    snapshots={};cases=[];plans=[]
    for i in range(4):
        snap=snapshot_factory(answer=f'Claim {i} [s1].');snapshots[snap.snapshot_sha256]=snap
        pair=build_review_plan(snap,limits=Limits()).pairs[0];plans.append(pair)
        cases.append(StudyCase(case_id=f'case-{i}',snapshot_sha256=snap.snapshot_sha256,unit_id=pair.unit.unit_id,
            evidence_id=pair.evidence.evidence_id,pair_id=pair.pair_id,pmid=None,topic_family=f'family-{i}',
            partition='development' if i<2 else 'held_out',origin='constructed'))
    models={'jev':'jev-1.13.0','gemini':'gemini-3.8-flash'}
    experiment=ExperimentConfig(version='v1',frozen_at=datetime(2026,1,1,tzinfo=timezone.utc),models=models,resolved_models=models,
        rubric_sha256=RUBRIC_SHA256,config_hashes={e:'a'*64 for e in models},limits=Limits(),comparison_margins={'accuracy':.05})
    manifest=StudyManifest(version='v1',cases=tuple(cases),experiment=experiment,experiment_sha256=experiment.sha256)
    refs=freeze_references(manifest,tuple(review(c,r) for c in cases for r in ('a','b')),())
    runs=[]
    for evaluator,model in models.items():
        for i,pair in enumerate(plans):
            label='supported' if (i<2)==(evaluator=='jev') else 'contradicted'
            judgment=Judgment(label=label,requested_model=model,resolved_model=model,
                probabilities={l:float(l==label) for l in LABELS} if evaluator=='jev' else None,confidence=1.0 if evaluator=='jev' else None)
            assessment=Assessment(pair_id=pair.pair_id,snapshot_sha256=pair.snapshot_sha256,unit_id=pair.unit.unit_id,
                evidence_id=pair.evidence.evidence_id,evidence_sha256=pair.evidence.text_sha256,evaluator=evaluator,model=model,
                rubric_sha256=RUBRIC_SHA256,request_sha256='b'*64,status='completed',judgment=judgment)
            runs.append(RunResult(run_id=f'{evaluator}-{i}',snapshot_sha256=pair.snapshot_sha256,evaluator=evaluator,model=model,
                limits=Limits(),assessments=(assessment,),coverage=(),elapsed_seconds=1,started_at=datetime(2026,9,22,tzinfo=timezone.utc),
                experiment_sha256=experiment.sha256,evaluator_config_sha256='a'*64))
    comparison=compare_runs(manifest,refs,tuple(runs),snapshots=snapshots)
    # Sorted provider order is Gemini minus Jev: development negative, held-out positive.
    paired=next(iter(comparison.paired.values()))
    assert paired['development']['differences']['accuracy']['difference']==-1
    assert paired['held_out']['differences']['accuracy']['difference']==1
    assert paired['held_out']['completion']['eligible_shared']==2
