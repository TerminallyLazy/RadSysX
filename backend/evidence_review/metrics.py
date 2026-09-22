"""Denominator-explicit metrics and deterministic paired topic-family bootstrap."""
from collections import Counter, defaultdict
import math
import random
from itertools import combinations

from pydantic import JsonValue

from .contracts import LABELS, Record
from .study import validate_study, study_pairs

NEGATIVE = {'contradicted','mixed'}
METRICS = ('accuracy','incorrect_support','missed_contradiction','false_contradiction_alert')


def rate(numerator,denominator):
    return {'numerator':numerator,'denominator':denominator,'value':numerator/denominator if denominator else None}


def classification_metrics(predicted,reference):
    if len(predicted) != len(reference): raise ValueError('unaligned_cases')
    if any(label not in LABELS for label in [*predicted,*reference]): raise ValueError('invalid_metric_label')
    rows = list(zip(predicted,reference))
    matrix = [[sum(p==prediction and r==truth for p,r in rows) for prediction in LABELS] for truth in LABELS]
    return {
        'accuracy':rate(sum(p==r for p,r in rows),len(rows)),
        'incorrect_support':rate(sum(p=='supported' and r!='supported' for p,r in rows),sum(p=='supported' for p,r in rows)),
        'missed_contradiction':rate(sum(r in NEGATIVE and p not in NEGATIVE for p,r in rows),sum(r in NEGATIVE for p,r in rows)),
        'false_contradiction_alert':rate(sum(r not in NEGATIVE and p in NEGATIVE for p,r in rows),sum(r not in NEGATIVE for p,r in rows)),
        'label_order':list(LABELS), 'confusion_matrix':matrix,
        'per_label':{label:{'precision':rate(sum(p==r==label for p,r in rows),sum(p==label for p,r in rows)),
                            'recall':rate(sum(p==r==label for p,r in rows),sum(r==label for p,r in rows))} for label in LABELS},
    }


def _quantile(values,quantile):
    ordered = sorted(values)
    return ordered[max(0,math.ceil(quantile*len(ordered))-1)] if ordered else None


def latencies(values):
    return {'count':len(values),'p50':_quantile(values,.5),'p95':_quantile(values,.95)}


def paired_bootstrap(rows, *, seed=20260922):
    def differences(sample):
        left = classification_metrics([r['left'] for r in sample],[r['reference'] for r in sample])
        right = classification_metrics([r['right'] for r in sample],[r['reference'] for r in sample])
        return {key:left[key]['value']-right[key]['value'] if left[key]['value'] is not None and right[key]['value'] is not None else None for key in METRICS}
    observed = differences(rows)
    groups = defaultdict(list)
    for row in rows: groups[row['topic_family']].append(row)
    families = sorted(groups)
    samples = {key:[] for key in METRICS}
    if len(families) >= 2:
        generator = random.Random(seed)
        for _ in range(2000):
            sample = [row for family in generator.choices(families,k=len(families)) for row in groups[family]]
            for key,value in differences(sample).items():
                samples[key].append(value)
    return {key:{'difference':value,'interval':[_quantile(samples[key],.025),_quantile(samples[key],.975)]
                if len(samples[key]) == 2000 and None not in samples[key] else None,
                'families':len(families),'cases':len(rows),'resamples':2000,'seed':seed} for key,value in observed.items()}


def usage_summary(attempts, *, pricing):
    known = Counter(); unknown = 0; cost_unknown = 0; cost = 0.0
    for attempt in attempts:
        outcome = attempt.outcome
        if outcome is not None and not outcome.submitted:
            continue
        if outcome is None or outcome.usage is None:
            unknown += 1; cost_unknown += 1
            continue
        known.update(outcome.usage)
        rates = pricing.usd_per_million if pricing is not None else {}
        if not rates or any(key not in outcome.usage for key in rates):
            cost_unknown += 1
        else:
            cost += sum(outcome.usage[key]*value/1_000_000 for key,value in rates.items())
    return {'known_usage':dict(known),'unknown_usage_attempts':unknown,'unknown_cost_attempts':cost_unknown,
            'known_cost_usd':cost if pricing else None,'cost_is_complete':pricing is not None and cost_unknown==0,
            'pricing':pricing.model_dump(mode='json') if pricing else None}


class Comparison(Record):
    reference_sha256: str
    experiment_sha256: str | None
    rows: tuple[dict[str,JsonValue],...]
    evaluators: dict[str,JsonValue]
    paired: dict[str,JsonValue]
    unresolved_exclusions: tuple[str,...]
    metadata: dict[str,JsonValue]


def compare_runs(manifest, references, runs, *, snapshots, bootstrap_seed=20260922):
    validation = validate_study(manifest,snapshots,references=references,require_target=False)
    if not validation.input_ready: raise ValueError('invalid_study')
    experiment = manifest.experiment
    if any(c.partition=='held_out' for c in manifest.cases) and experiment is None:
        raise ValueError('held_out_experiment_required')
    pairs = study_pairs(manifest,snapshots)
    labels = {r.case_id:r.label for r in references.cases}
    grouped = defaultdict(list)
    for run in runs:
        if experiment is not None:
            if (run.experiment_sha256 != experiment.sha256 or experiment.models.get(run.evaluator) != run.model
                    or experiment.config_hashes.get(run.evaluator) != run.evaluator_config_sha256 or run.limits != experiment.limits
                    or run.started_at is None or run.started_at < experiment.frozen_at):
                raise ValueError('experiment_mismatch')
        grouped[run.evaluator+':'+run.model].append(run)
    indexed = {}
    for evaluator, evaluator_runs in grouped.items():
        index = {}
        for run in evaluator_runs:
            for assessment in run.assessments:
                identity = (run.snapshot_sha256,assessment.pair_id)
                if identity in index: raise ValueError('duplicate_evaluation')
                pair = pairs.get(identity)
                if pair is None: raise ValueError('unknown_evaluation_pair')
                if (assessment.snapshot_sha256 != run.snapshot_sha256 or assessment.unit_id != pair.unit.unit_id
                        or assessment.evidence_id != pair.evidence.evidence_id or assessment.evidence_sha256 != pair.evidence.text_sha256
                        or assessment.evaluator != run.evaluator or assessment.model != run.model):
                    raise ValueError('evaluation_identity_mismatch')
                if assessment.judgment is not None:
                    if assessment.judgment.requested_model != run.model:
                        raise ValueError('evaluation_model_mismatch')
                    if experiment is not None and (assessment.judgment.resolved_model != experiment.resolved_models.get(run.evaluator)
                            or assessment.rubric_sha256 != experiment.rubric_sha256):
                        raise ValueError('experiment_mismatch')
                index[identity] = assessment
        indexed[evaluator] = index
    rows = []
    for case in manifest.cases:
        row = {'case_id':case.case_id,'pair_id':case.pair_id,'evidence_id':case.evidence_id,'pmid':case.pmid,
               'partition':case.partition,'topic_family':case.topic_family,'reference':labels[case.case_id],'evaluators':{}}
        for evaluator,index in indexed.items():
            assessment = index.get((case.snapshot_sha256,case.pair_id))
            row['evaluators'][evaluator] = {'status':assessment.status if assessment else 'unreviewed',
                'label':assessment.judgment.label if assessment and assessment.judgment else None,
                'reason':assessment.reason if assessment else 'not_evaluated',
                'reused':bool(assessment and assessment.reused_from)}
        rows.append(row)
    metrics = {}
    for evaluator,index in indexed.items():
        complete = [r for r in rows if r['reference'] is not None and r['evaluators'][evaluator]['label'] is not None]
        assessments = list(index.values()); evaluator_runs = grouped[evaluator]
        attempts = {a.attempt_id:a for run in evaluator_runs for a in run.attempts}
        cached_attempts = {identifier for a in assessments if a.reused_from for identifier in a.attempt_ids}
        fresh = [a for a in attempts.values() if a.attempt_id not in cached_attempts and
                 any(a in run.attempts and (run.started_at is None or a.started_at >= run.started_at) for run in evaluator_runs)]
        metrics[evaluator] = {
            'completed_reference_cases':len(complete),
            'classification':classification_metrics([r['evaluators'][evaluator]['label'] for r in complete],[r['reference'] for r in complete]),
            'partitions':{partition:classification_metrics([r['evaluators'][evaluator]['label'] for r in complete if r['partition']==partition],
                [r['reference'] for r in complete if r['partition']==partition]) for partition in ('development','held_out')},
            'workload':dict(Counter(r['evaluators'][evaluator]['status'] for r in rows)),
            'unreviewed_reference_contradictions':sum(r['reference'] in NEGATIVE and r['evaluators'][evaluator]['label'] is None for r in rows),
            'cached_pairs':sum(bool(a.reused_from) for a in assessments),
            'latency_seconds':{
                'successful_attempts':latencies([a.outcome.elapsed_seconds for a in fresh if a.outcome and a.outcome.judgment]),
                'completed_pairs':latencies([a.elapsed_seconds for a in assessments if a.status=='completed' and not a.reused_from]),
                'failed_attempts':latencies([a.outcome.elapsed_seconds for a in fresh if a.outcome and not a.outcome.judgment]),
                'snapshots':latencies([run.elapsed_seconds for run in evaluator_runs])},
            'accounting':usage_summary(attempts.values(),pricing=experiment.pricing.get(evaluator_runs[0].evaluator) if experiment else None),
        }
    paired = {}
    for left,right in combinations(sorted(indexed),2):
        shared = [dict(topic_family=r['topic_family'],left=r['evaluators'][left]['label'],right=r['evaluators'][right]['label'],reference=r['reference'])
            for r in rows if r['reference'] is not None and r['evaluators'][left]['label'] is not None and r['evaluators'][right]['label'] is not None]
        paired[left+' minus '+right] = {'differences':paired_bootstrap(shared,seed=bootstrap_seed),
            'left':classification_metrics([r['left'] for r in shared],[r['reference'] for r in shared]),
            'right':classification_metrics([r['right'] for r in shared],[r['reference'] for r in shared])}
    return Comparison(reference_sha256=references.sha256,experiment_sha256=manifest.experiment_sha256,rows=tuple(rows),
        evaluators=metrics,paired=paired,unresolved_exclusions=tuple(r.case_id for r in references.cases if r.label is None),
        metadata={'study_version':manifest.version,'experiment':experiment.model_dump(mode='json') if experiment else None,
                  'counts':dict(validation.counts),'exclusions':list(manifest.exclusions),
                  'quantiles':'nearest-rank','interval_method':'2000 paired topic-family resamples; 2.5/97.5 percentiles',
                  'promotion':'No automatic promotion; qualified references and declared practical margins are required.'})
