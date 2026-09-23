import pytest


@pytest.mark.parametrize("answer,expected", [
    ("The response was 3.5 and toxicity increased [s1].",1),
    ("Smith et al. found an effect [s1].",1),
    ("Effects, e.g. improvement, occurred [s1].",1),
    ("A finding. [s1]",1),
    ("A finding [s1][s1].",1),
    ("A finding [s1]. Another [s1].",2),
    ("First sentence. Second sentence [s1].",0),
    ("Uncited evidence.",0),
    ("😀 α evidence [s1].",1),
])
def test_sentence_rules_preserve_exact_offsets(snapshot_factory, answer, expected):
    from backend.evidence_review.contracts import Limits
    from backend.evidence_review.units import build_review_plan
    plan = build_review_plan(snapshot_factory(answer=answer),limits=Limits())
    assert len(plan.pairs) == expected
    for unit in plan.units:
        assert answer[unit.start:unit.end] == unit.text
    assert all(c.reason or c.pair_ids for c in plan.coverage)


def test_two_citations_are_separate_pairs_and_limits_accounted(snapshot_factory):
    from backend.evidence_review.contracts import Limits
    from backend.evidence_review.units import build_review_plan
    snap=snapshot_factory(answer="A [s1][s2]. B [s1][s2].",evidence_count=2)
    plan=build_review_plan(snap,limits=Limits(pair_limit=3))
    assert len(plan.units)==2 and len(plan.pairs)==3
    assert len(plan.excluded_pairs)==1 and plan.excluded_pairs[0].reason=="pair_limit"
    assert plan.pairs[0].unit.text=="A [s1][s2]."


def test_unit_limit_does_not_hide_overflow(snapshot_factory):
    from backend.evidence_review.contracts import Limits
    from backend.evidence_review.units import build_review_plan
    plan=build_review_plan(snapshot_factory(answer="A [s1]. B [s1]."),limits=Limits(unit_limit=1))
    assert len(plan.pairs)==1
    assert plan.coverage[1].reason=="unit_limit"


def test_truncated_evidence_never_gets_a_request(payload_factory):
    from backend.evidence_review.contracts import Limits, freeze_snapshot
    from backend.evidence_review.units import build_review_plan
    p=payload_factory()
    p["evidence"][0].update(completeness="truncated",original_chars=20000)
    plan=build_review_plan(freeze_snapshot(p,limits=Limits()),limits=Limits())
    assert not plan.pairs
    assert plan.excluded_pairs[0].reason=="evidence_truncated"


def test_curated_annotation_resolves_ambiguity_but_cannot_rewrite(snapshot_factory):
    from backend.evidence_review.contracts import Limits, SpanAnnotation, CitationSpan
    from backend.evidence_review.units import build_review_plan
    snap=snapshot_factory(answer="First. Second [s1].")
    annotation=SpanAnnotation(start=7,end=19,citation_spans=(CitationSpan(start=14,end=18,source_id="s1"),))
    plan=build_review_plan(snap,limits=Limits(),annotations=(annotation,))
    assert plan.pairs[0].unit.text=="Second [s1]."
    bad=SpanAnnotation(start=7,end=19,citation_spans=(CitationSpan(start=13,end=18,source_id="s1"),))
    with pytest.raises(ValueError):
        build_review_plan(snap,limits=Limits(),annotations=(bad,))
