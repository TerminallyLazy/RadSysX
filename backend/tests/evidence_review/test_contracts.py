import hashlib
import json

import pytest


def test_exact_unicode_hash_and_tamper_rejection(snapshot_factory):
    from backend.evidence_review.contracts import Limits, load_snapshot
    from backend.evidence_review.serialization import canonical_json
    snapshot = snapshot_factory(answer="α😀: response 3.5 [s1].")
    assert snapshot.answer_sha256 == hashlib.sha256("α😀: response 3.5 [s1].".encode()).hexdigest()
    raw = canonical_json(snapshot.model_dump(mode="json"))
    assert load_snapshot(raw, limits=Limits()) == snapshot
    with pytest.raises(ValueError):
        load_snapshot(raw.replace(b"3.5", b"3.6"), limits=Limits())


@pytest.mark.parametrize("value", [float("nan"), float("inf"), "\ud800"])
def test_unsafe_json_is_rejected(value):
    from backend.evidence_review.serialization import canonical_json
    with pytest.raises(ValueError):
        canonical_json({"value": value})


@pytest.mark.parametrize("mutation", [
    lambda p: p.update(data_class="patient"),
    lambda p: p.update(created_at="2026-09-22T00:00:00"),
    lambda p: p["result"].update(summary="x" * 12001),
    lambda p: p["result"]["usage"].update(input_tokens=True),
    lambda p: p["result"]["sources"].append(dict(p["result"]["sources"][0])),
    lambda p: p["evidence"][0].update(citation_id="s99"),
    lambda p: p["evidence"][0].update(source_kind="pubmed_abstract", pmid="123"),
    lambda p: p["evidence"][0]["sections"][0].update(text="x" * 10001),
    lambda p: p.update(extra="not allowed"),
])
def test_invalid_snapshot_cannot_be_sealed(payload_factory, mutation):
    from backend.evidence_review.contracts import Limits, freeze_snapshot
    payload = payload_factory()
    mutation(payload)
    with pytest.raises(ValueError):
        freeze_snapshot(payload, limits=Limits())


def test_nested_snapshot_is_immutable(snapshot_factory):
    snapshot = snapshot_factory()
    with pytest.raises((TypeError, ValueError)):
        snapshot.generation["origin"] = "altered"
    with pytest.raises((TypeError, ValueError)):
        snapshot.result.usage["input_tokens"] = 8


def test_duplicate_keys_and_oversized_input_rejected():
    from backend.evidence_review.contracts import Limits, load_snapshot
    for raw in (b'{"snapshot_id":"a","snapshot_id":"b"}', b" " * (2 * 1024 * 1024 + 1)):
        with pytest.raises(ValueError):
            load_snapshot(raw, limits=Limits())


def test_failed_assessment_cannot_carry_judgment():
    from backend.evidence_review.contracts import Assessment, Judgment
    judgment = Judgment(label="supported", requested_model="gemini-3.8-flash", resolved_model="gemini-3.8-flash")
    fields = dict(pair_id="p1", snapshot_sha256="0" * 64, unit_id="u1", evidence_id="e1",
        evidence_sha256="0" * 64, evaluator="gemini", model="gemini-3.8-flash",
        rubric_sha256="0" * 64, request_sha256="0" * 64)
    assert Assessment(**fields, status="completed", judgment=judgment).status == "completed"
    with pytest.raises(ValueError):
        Assessment(**fields, status="failed", reason="timeout", judgment=judgment)
