from datetime import datetime,timezone

import pytest

from backend.evidence_review.contracts import Limits
from backend.evidence_review.units import build_review_plan


def tiny_study(snapshot_factory):
    from backend.evidence_review.study import StudyCase,StudyManifest
    snap=snapshot_factory(); pair=build_review_plan(snap,limits=Limits()).pairs[0]
    case=StudyCase(case_id='case-1',snapshot_sha256=snap.snapshot_sha256,unit_id=pair.unit.unit_id,
        evidence_id=pair.evidence.evidence_id,pair_id=pair.pair_id,pmid=None,topic_family='fixture',partition='development',origin='constructed')
    return StudyManifest(version='v1',cases=(case,)),{snap.snapshot_sha256:snap}


def review(case,reviewer,label='supported',**kwargs):
    from backend.evidence_review.study import HumanLabel
    return HumanLabel(case_id=case.case_id,pair_hash=case.pair_hash,reviewer_id=reviewer,
        qualification_attested=True,blind_review_attested=True,label=label,notes='',version='v1',
        submitted_at=datetime.now(timezone.utc),**kwargs)


def test_synthetic_fixture_is_not_real_corpus(snapshot_factory):
    from backend.evidence_review.study import validate_study
    manifest,snapshots=tiny_study(snapshot_factory)
    validation=validate_study(manifest,snapshots,require_target=False)
    assert validation.input_ready and not validation.references_ready
    validation=validate_study(manifest,snapshots,require_target=True)
    assert not validation.input_ready and 'target_pairs' in validation.issues and 'target_pmids' in validation.issues


def test_reference_agreement_disagreement_and_adjudication(snapshot_factory):
    from backend.evidence_review.study import freeze_references,Adjudication,validate_study
    manifest,snapshots=tiny_study(snapshot_factory); case=manifest.cases[0]
    reviews=(review(case,'a'),review(case,'b','contradicted'))
    refs=freeze_references(manifest,reviews,())
    assert refs.cases[0].label is None and refs.cases[0].adjudication_status=='unresolved'
    adjudication=Adjudication(case_id=case.case_id,pair_hash=case.pair_hash,adjudicator_id='c',qualification_attested=True,
        label='mixed',reason='Distinct supported and contradicted clauses',submitted_at=datetime.now(timezone.utc))
    refs=freeze_references(manifest,reviews,(adjudication,))
    assert refs.cases[0].label=='mixed' and validate_study(manifest,snapshots,references=refs,require_target=False).references_ready
    with pytest.raises(ValueError): freeze_references(manifest,reviews,(adjudication.model_copy(update={'adjudicator_id':'a'}),))


@pytest.mark.parametrize('mutation',['same_reviewer','unqualified','not_blind','wrong_hash','wrong_case'])
def test_bad_reviewer_records_rejected(snapshot_factory,mutation):
    from backend.evidence_review.study import freeze_references
    manifest,_=tiny_study(snapshot_factory); case=manifest.cases[0]
    second=review(case,'b')
    changes={'same_reviewer':{'reviewer_id':'a'},'unqualified':{'qualification_attested':False},
        'not_blind':{'blind_review_attested':False},'wrong_hash':{'pair_hash':'0'*64},'wrong_case':{'case_id':'unknown'}}
    with pytest.raises(ValueError): freeze_references(manifest,(review(case,'a'),second.model_copy(update=changes[mutation])),())


def test_split_leakage_duplicates_and_reference_tampering(snapshot_factory):
    from backend.evidence_review.study import validate_study,freeze_references
    manifest,snapshots=tiny_study(snapshot_factory)
    other=manifest.cases[0].model_copy(update={'case_id':'second','partition':'held_out'})
    bad=manifest.model_copy(update={'cases':manifest.cases+(other,)})
    result=validate_study(bad,snapshots,require_target=False)
    assert 'topic_leakage' in result.issues and 'duplicate_pair' in result.issues
    case=manifest.cases[0]; refs=freeze_references(manifest,(review(case,'a'),review(case,'b')),())
    refs=refs.model_copy(update={'sha256':'0'*64})
    with pytest.raises(ValueError): validate_study(manifest,snapshots,references=refs,require_target=False)
