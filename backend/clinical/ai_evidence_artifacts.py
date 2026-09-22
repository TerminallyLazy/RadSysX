"""Hash-verified private review previews and positive public result projection."""
from pathlib import Path
from contextlib import nullcontext
from .ai_evidence_contracts import (EvidenceClaim, EvidenceAbstract, EvidenceAssessment, EvidenceAttempt, EvidenceExclusion)
if __package__ == "clinical":  # Supported direct backend/server.py launch.
    from evidence_review.artifacts import ArtifactStore
    from evidence_review.contracts import Limits, ReviewPlan, load_snapshot
    from evidence_review.serialization import canonical_json, parse_json, sha256_bytes
    from evidence_review.rubric import RUBRIC_VERSION, RUBRIC_SHA256
else:
    from ..evidence_review.artifacts import ArtifactStore
    from ..evidence_review.contracts import Limits, ReviewPlan, load_snapshot
    from ..evidence_review.serialization import canonical_json, parse_json, sha256_bytes
    from ..evidence_review.rubric import RUBRIC_VERSION, RUBRIC_SHA256


def preview_hash(snapshot, plan, generation):
    return sha256_bytes(canonical_json({'snapshotSha256':snapshot.snapshot_sha256,'plan':plan.model_dump(mode='json'),
        'generation':generation,'modelId':'jev-1.13.0','rubricVersion':RUBRIC_VERSION,'rubricSha256':RUBRIC_SHA256}))


class ReviewArtifacts:
    def __init__(self,root: Path,run_id: str): self.root,self.run_id=root,run_id

    def create_preview(self,snapshot,plan,generation):
        with ArtifactStore.create(self.root,run_id=self.run_id) as store:
            sref=store.put_record(snapshot,kind='snapshot'); pref=store.put_record(plan,kind='plan')
            payload={'snapshot_ref':sref,'plan_ref':pref,'generation':generation,
                'modelId':'jev-1.13.0','rubricVersion':RUBRIC_VERSION,'rubricSha256':RUBRIC_SHA256}
            ref=store.put_bytes(canonical_json(payload),kind='preview')
            store.commit_manifest({'schema_version':1,'objects':[ref,sref,pref],'preview_ref':ref,'snapshot_ref':sref,'plan_ref':pref})
        return ref,preview_hash(snapshot,plan,generation)

    def read_preview(self,ref,*,store=None):
        with (nullcontext(store) if store is not None else self.open_run()) as handle:
            value=parse_json(handle.read_bytes(ref))
            snapshot=load_snapshot(handle.read_bytes(value['snapshot_ref'],max_bytes=Limits().snapshot_bytes),limits=Limits())
            plan=ReviewPlan.model_validate_json(handle.read_bytes(value['plan_ref']))
        if value['modelId']!='jev-1.13.0' or value['rubricVersion']!=RUBRIC_VERSION or value['rubricSha256']!=RUBRIC_SHA256:
            raise ValueError('review_configuration_changed')
        return {'snapshot':snapshot,'plan':plan,'generation':value['generation'],
                'preview_hash':preview_hash(snapshot,plan,value['generation'])}

    def open_run(self): return ArtifactStore.open(self.root,run_id=self.run_id)
    def delete(self): ArtifactStore.delete_run(self.root,run_id=self.run_id)

    def evaluation_resume(self,store,preview_ref):
        view=store.load_run()
        preview=parse_json(store.read_bytes(preview_ref))
        # Only the exact committed preparation manifest proves no evaluation began.
        # Missing selection in any evaluator manifest must still fail strict resume.
        preparation={'schema_version':1,'objects':[preview_ref,preview['snapshot_ref'],preview['plan_ref']],
            'preview_ref':preview_ref,'snapshot_ref':preview['snapshot_ref'],'plan_ref':preview['plan_ref']}
        return None if view.manifest==preparation else view


def progress(view, total):
    return {'totalPairs':total,'completedPairs':sum(a.status=='completed' for a in view.assessments),
        'settledPairs':len(view.assessments),'submittedAttempts':sum(bool(a.outcome and a.outcome.submitted) for a in view.attempts),
        'unknownUsageAttempts':sum(a.outcome is None or (a.outcome.submitted and a.outcome.usage is None) for a in view.attempts)}


def project(detail, preview, view):
    snapshot,plan=preview['snapshot'],preview['plan']
    detail.original_answer=snapshot.result.summary
    detail.answer_sha256=snapshot.answer_sha256
    detail.snapshot_sha256=snapshot.snapshot_sha256
    eligible={p.unit.unit_id for p in plan.pairs}
    detail.claims=[EvidenceClaim(unit_id=u.unit_id,text=u.text,start=u.start,end=u.end,evidence_ids=list(u.evidence_ids),
        eligible=u.unit_id in eligible, exclusion_reason=next((e.reason for e in plan.excluded_pairs if e.unit_id==u.unit_id),None)) for u in plan.units]
    detail.abstracts=[EvidenceAbstract(evidence_id=e.evidence_id,citation_id=e.citation_id,title=e.title,pmid=e.pmid,url=e.url,
        retrieved_at=e.retrieved_at.isoformat(),completeness=e.completeness,
        sections=[{'label':s.label,'text':s.text} for s in e.sections],text_sha256=e.text_sha256,extraction_version=e.extraction_version) for e in snapshot.evidence]
    detail.exclusions=[EvidenceExclusion(citation_id=e.citation_id,reason=e.reason) for e in snapshot.capture_exclusions]
    detail.exclusions += [EvidenceExclusion(unit_id=e.unit_id,reason=e.reason) for e in plan.excluded_pairs]
    detail.exclusions += [EvidenceExclusion(unit_id=c.unit_id,reason=c.reason) for c in plan.coverage if c.reason and not c.unit_id]
    if detail.selected_unit_ids is not None:
        detail.exclusions += [EvidenceExclusion(unit_id=u.unit_id,reason='user_excluded') for u in plan.units if u.unit_id in eligible and u.unit_id not in detail.selected_unit_ids]
    detail.assessments=[EvidenceAssessment(pair_id=a.pair_id,unit_id=a.unit_id,evidence_id=a.evidence_id,status=a.status,reason=a.reason,
        label=a.judgment.label if a.judgment else None,requested_model=a.model,resolved_model=a.judgment.resolved_model if a.judgment else None,
        rubric_version=RUBRIC_VERSION,rubric_sha256=a.rubric_sha256,answer_sha256=snapshot.answer_sha256,abstract_sha256=a.evidence_sha256,
        request_sha256=a.request_sha256,attempt_ids=list(a.attempt_ids),reused=a.reused_from is not None,
        probabilities=dict(a.judgment.probabilities) if a.judgment and a.judgment.probabilities else None) for a in view.assessments]
    detail.attempts=[EvidenceAttempt(attempt_id=a.attempt_id,pair_id=a.pair_id,request_sha256=a.request_sha256,
        started_at=a.started_at.isoformat(),ended_at=a.ended_at.isoformat() if a.ended_at else None,
        submitted=a.outcome.submitted if a.outcome else None,reason=a.outcome.reason if a.outcome else 'interrupted_unknown',
        usage=dict(a.outcome.usage) if a.outcome and a.outcome.usage is not None else None) for a in view.attempts[-200:]]
    detail.earlier_attempt_count=max(0,len(view.attempts)-200)
    for key,value in progress(view,detail.total_pairs).items():
        field=next(name for name,info in detail.__class__.model_fields.items() if info.alias==key)
        setattr(detail,field,value)
    return detail
