"""Immutable study grouping and attested, independently reviewed reference labels."""
from collections import Counter, defaultdict
from datetime import datetime, timezone
from typing import Annotated, Literal

from pydantic import AwareDatetime, Field, JsonValue

from .contracts import (Hash, Identifier, Label, Limits, Record, Snapshot, SpanAnnotation, load_snapshot)
from .serialization import canonical_json, sha256_bytes
from .units import build_review_plan


class StudyCase(Record):
    case_id: Identifier
    snapshot_sha256: Hash
    unit_id: Identifier
    evidence_id: Identifier
    pair_id: Identifier
    pmid: str | None
    topic_family: Identifier
    partition: Literal['development','held_out']
    origin: Literal['natural','constructed']
    challenge_tags: tuple[Identifier, ...] = ()

    @property
    def pair_hash(self):
        return sha256_bytes(canonical_json({k:getattr(self,k) for k in ('snapshot_sha256','unit_id','evidence_id','pair_id')}))


class Pricing(Record):
    source: str = Field(max_length=2048)
    checked_at: AwareDatetime
    usd_per_million: dict[str,Annotated[float, Field(ge=0)]]


class ExperimentConfig(Record):
    version: Identifier
    frozen_at: AwareDatetime
    models: dict[str,Identifier]
    resolved_models: dict[str,Identifier]
    rubric_sha256: Hash
    generation_configs: dict[str,dict[str,JsonValue]] = {}
    config_hashes: dict[str,Hash]
    limits: Limits
    pricing: dict[str,Pricing] = {}
    comparison_margins: dict[str,float]
    metric_definitions: Literal['abstract-review-metrics-v1'] = 'abstract-review-metrics-v1'

    @property
    def sha256(self):
        return sha256_bytes(canonical_json(self.model_dump(mode='json')))


class StudyManifest(Record):
    version: Identifier
    cases: tuple[StudyCase, ...] = Field(max_length=10000)
    declared_target: int = Field(default=200,ge=1,le=10000)
    exclusions: tuple[str, ...] = ()
    experiment_sha256: Hash | None = None
    experiment: ExperimentConfig | None = None
    # Local paths are resolved by the CLI inside the suite's private directory.
    snapshots: dict[str,str] = {}
    annotations: dict[str,tuple[SpanAnnotation,...]] = {}


class HumanLabel(Record):
    case_id: Identifier
    pair_hash: Hash
    reviewer_id: Identifier
    qualification_attested: bool
    blind_review_attested: bool
    label: Label
    notes: str = Field(default='',max_length=10000)
    version: Identifier
    submitted_at: AwareDatetime


class Adjudication(Record):
    case_id: Identifier
    pair_hash: Hash
    adjudicator_id: Identifier
    qualification_attested: bool
    label: Label
    reason: str = Field(min_length=1,max_length=10000)
    submitted_at: AwareDatetime


class ReferenceCase(Record):
    case_id: Identifier
    pair_hash: Hash
    label: Label | None
    reviewer_ids: tuple[Identifier,...]
    adjudication_status: Literal['agreement','adjudicated','unresolved']
    adjudicator_id: Identifier | None = None
    reason: str | None = None


class ReferenceSet(Record):
    version: Identifier
    cases: tuple[ReferenceCase,...]
    frozen_at: AwareDatetime
    sha256: Hash


class StudyValidation(Record):
    counts: dict[str,int]
    issues: tuple[str,...]
    reference_issues: tuple[str,...]
    input_ready: bool
    references_ready: bool


def validate_references(manifest, references):
    expected = sha256_bytes(canonical_json(references.model_dump(mode='json',exclude={'sha256'})))
    if expected != references.sha256:
        raise ValueError('reference_hash_mismatch')
    cases = {c.case_id:c for c in manifest.cases}
    if len(references.cases) != len(cases) or len({r.case_id for r in references.cases}) != len(cases):
        raise ValueError('reference_case_mismatch')
    for ref in references.cases:
        if ref.case_id not in cases or ref.pair_hash != cases[ref.case_id].pair_hash:
            raise ValueError('reference_pair_mismatch')
        if len(set(ref.reviewer_ids)) != len(ref.reviewer_ids):
            raise ValueError('duplicate_reviewer')
        if ref.label is not None:
            if len(ref.reviewer_ids) < 2 or ref.adjudication_status == 'unresolved':
                raise ValueError('invalid_resolved_reference')
            if ref.adjudication_status == 'adjudicated' and (not ref.adjudicator_id or ref.adjudicator_id in ref.reviewer_ids):
                raise ValueError('invalid_adjudicator')
        elif ref.adjudication_status != 'unresolved':
            raise ValueError('invalid_unresolved_reference')


def study_pairs(manifest, snapshots):
    pairs = {}
    for digest, snapshot in snapshots.items():
        checked = load_snapshot(canonical_json(snapshot.model_dump(mode='json')),limits=Limits())
        if checked.snapshot_sha256 != digest:
            raise ValueError('study_snapshot_mismatch')
        plan = build_review_plan(checked,limits=Limits(),annotations=manifest.annotations.get(digest,()))
        for pair in plan.pairs:
            pairs[(digest,pair.pair_id)] = pair
    return pairs


def validate_study(manifest: StudyManifest, snapshots: dict[str,Snapshot], *, references: ReferenceSet | None = None,
                   require_target: bool) -> StudyValidation:
    # Revalidate even when a caller has used Pydantic's unchecked model_copy.
    manifest = StudyManifest.model_validate_json(canonical_json(manifest.model_dump(mode='json')))
    pairs = study_pairs(manifest,snapshots)
    issues = set()
    identifiers, identities = set(), set()
    groups = {'pmid':defaultdict(set),'topic':defaultdict(set)}
    counts = Counter({'cases':len(manifest.cases),'real_pmids':0,'development':0,'held_out':0,'resolved_references':0})
    real_pmids = set()
    for case in manifest.cases:
        if case.case_id in identifiers: issues.add('duplicate_case')
        if case.pair_hash in identities: issues.add('duplicate_pair')
        identifiers.add(case.case_id); identities.add(case.pair_hash)
        counts[case.partition] += 1
        groups['topic'][case.topic_family].add(case.partition)
        if case.pmid:
            groups['pmid'][case.pmid].add(case.partition)
        pair = pairs.get((case.snapshot_sha256,case.pair_id))
        if pair is None or (pair.unit.unit_id,pair.evidence.evidence_id,pair.evidence.pmid) != (case.unit_id,case.evidence_id,case.pmid):
            issues.add('case_evidence_mismatch')
        elif pair.evidence.source_kind == 'pubmed_abstract':
            real_pmids.add(pair.evidence.pmid)
        elif require_target:
            issues.add('synthetic_corpus_case')
    counts['real_pmids'] = len(real_pmids)
    for kind, values in groups.items():
        if any(len(partitions)>1 for partitions in values.values()): issues.add(kind+'_leakage')
    if manifest.experiment is not None and manifest.experiment_sha256 != manifest.experiment.sha256:
        issues.add('experiment_hash_mismatch')
    if require_target:
        if len(manifest.cases) < max(200,manifest.declared_target): issues.add('target_pairs')
        if len(real_pmids) < 50: issues.add('target_pmids')
        if counts['development'] != 50 or counts['held_out'] != 150: issues.add('target_partition_counts')
    reference_issues = set()
    if references is None:
        reference_issues.add('human_labels_pending')
    else:
        validate_references(manifest,references)
        labels = {r.case_id:r.label for r in references.cases}
        counts['resolved_references'] = sum(label is not None for label in labels.values())
        if counts['resolved_references'] != len(manifest.cases): reference_issues.add('unresolved_references')
        if require_target:
            from .contracts import LABELS
            for partition in ('development','held_out'):
                if {labels[c.case_id] for c in manifest.cases if c.partition == partition} - {None} != set(LABELS):
                    reference_issues.add('label_coverage_'+partition)
    return StudyValidation(counts=dict(counts),issues=tuple(sorted(issues)),reference_issues=tuple(sorted(reference_issues)),
        input_ready=not issues,references_ready=not issues and not reference_issues)


def freeze_references(manifest: StudyManifest, reviews: tuple[HumanLabel,...], adjudications: tuple[Adjudication,...]) -> ReferenceSet:
    cases = {c.case_id:c for c in manifest.cases}
    if len(cases) != len(manifest.cases): raise ValueError('duplicate_case')
    by_case = defaultdict(list)
    seen = set()
    for raw in reviews:
        review = HumanLabel.model_validate_json(canonical_json(raw.model_dump(mode='json')))
        if (review.case_id not in cases or review.pair_hash != cases[review.case_id].pair_hash
                or not review.qualification_attested or not review.blind_review_attested):
            raise ValueError('invalid_human_review')
        identity = (review.case_id,review.reviewer_id)
        if identity in seen: raise ValueError('duplicate_reviewer')
        seen.add(identity); by_case[review.case_id].append(review)
    adjudicated = {}
    for raw in adjudications:
        adjudication = Adjudication.model_validate_json(canonical_json(raw.model_dump(mode='json')))
        if (adjudication.case_id not in cases or adjudication.pair_hash != cases[adjudication.case_id].pair_hash
                or not adjudication.qualification_attested or adjudication.case_id in adjudicated
                or adjudication.adjudicator_id in {r.reviewer_id for r in by_case[adjudication.case_id]}):
            raise ValueError('invalid_adjudication')
        adjudicated[adjudication.case_id] = adjudication
    refs = []
    for case in manifest.cases:
        labels = by_case[case.case_id]
        label = None; status = 'unresolved'; adjudicator = None; reason = 'independent_reviews_pending'
        if len(labels) >= 2:
            if len({r.label for r in labels}) == 1:
                label = labels[0].label; status = 'agreement'; reason = None
            elif case.case_id in adjudicated:
                item = adjudicated[case.case_id]
                label = item.label; status = 'adjudicated'; adjudicator = item.adjudicator_id; reason = item.reason
            else:
                reason = 'adjudication_pending'
        if case.case_id in adjudicated and status != 'adjudicated':
            raise ValueError('unexpected_adjudication')
        refs.append(ReferenceCase(case_id=case.case_id,pair_hash=case.pair_hash,label=label,
            reviewer_ids=tuple(sorted(r.reviewer_id for r in labels)),adjudication_status=status,adjudicator_id=adjudicator,reason=reason))
    result = ReferenceSet(version=manifest.version,cases=tuple(refs),frozen_at=datetime.now(timezone.utc),sha256='0'*64)
    result = result.model_copy(update={'sha256':sha256_bytes(canonical_json(result.model_dump(mode='json',exclude={'sha256'})))})
    validate_references(manifest,result)
    return result
