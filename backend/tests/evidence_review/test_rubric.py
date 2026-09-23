import json
import hashlib


def test_request_contains_exact_pair_not_local_metadata(snapshot_factory):
    from backend.evidence_review.contracts import Limits
    from backend.evidence_review.units import build_review_plan
    from backend.evidence_review.rubric import prepare_jev
    snap=snapshot_factory()
    pair=build_review_plan(snap,limits=Limits()).pairs[0]
    request=prepare_jev(pair)
    body=json.loads(request.body)
    assert set(body)=={"model","state","questions"}
    assert body["state"]=={"claim":"Synthetic evidence [s1].","abstract_sections":[{"label":None,"text":"Synthetic evidence."}]}
    assert set(body["questions"]["relationship"]["criteria"])=={"supported","partially_supported","contradicted","mixed","not_addressed"}
    assert snap.snapshot_id.encode() not in request.body
    assert pair.evidence.evidence_id.encode() not in request.body
    assert request.request_sha256==hashlib.sha256(request.body).hexdigest()
