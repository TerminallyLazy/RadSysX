"""Conservative sentence/citation association over unchanged Unicode text."""
from __future__ import annotations

import re

from .contracts import (CitationSpan, CoverageItem, ExcludedPair, Limits, ReviewPair,
                        ReviewPlan, ReviewUnit, Snapshot, SpanAnnotation, load_snapshot)
from .serialization import canonical_json, sha256_bytes

BUILDER_VERSION = "sentence-citations-v1"
PASSAGE_BUILDER_VERSION = "cited-passages-v2"
_CITE = re.compile(r"\[(s[1-9][0-9]?)\]")
_CITE_GROUP = re.compile(r"\[(s[1-9][0-9]?(?:\s*,\s*s[1-9][0-9]?){0,19})\]")
_ABBREVIATION = re.compile(r"\b(?:et al\.|e\.g\.|i\.e\.|Fig\.|Dr\.|vs\.)", re.I)


def _identity(*parts):
    return sha256_bytes(canonical_json(parts))


def _sentences(text, offset, citation_pattern=_CITE):
    protected = {i for match in _ABBREVIATION.finditer(text) for i in range(match.start(),match.end())}
    numbered = re.match(r"\s*\d+\.\s", text)
    if numbered:
        protected.update(range(numbered.start(), numbered.end()))
    start, i, spans = 0, 0, []
    while i < len(text):
        if text[i] not in ".!?" or i in protected or (text[i] == "." and i+1 < len(text) and text[i+1].isdigit()):
            i += 1
            continue
        end = i + 1
        while end < len(text) and text[end] in "\"'”’)]":
            end += 1
        if end < len(text) and not text[end].isspace() and text[end] != "[":
            i += 1
            continue
        cursor = end
        while cursor < len(text):
            while cursor < len(text) and text[cursor].isspace():
                cursor += 1
            citation = citation_pattern.match(text,cursor)
            if not citation:
                break
            cursor = citation.end()
            end = cursor
        if end < len(text) and text[end] in ".!?":
            end += 1
        left = start
        while left < end and text[left].isspace():
            left += 1
        if left < end:
            spans.append((offset+left,offset+end))
        start = i = end
    left, right = start, len(text)
    while left < right and text[left].isspace():
        left += 1
    while right > left and text[right-1].isspace():
        right -= 1
    if left < right:
        spans.append((offset+left,offset+right))
    return spans


def _candidates(answer, *, group_passages=False):
    candidates = []
    citation_pattern = _CITE_GROUP if group_passages else _CITE
    for paragraph in re.finditer(r"\S(?:[\s\S]*?\S)?(?=\n\s*\n|\s*\Z)", answer):
        text, offset = paragraph.group(), paragraph.start()
        chunks = [(offset,text)]
        if re.search(r"(?m)^\s*(?:[-*]\s+|\d+\.\s+)", text):
            chunks = [(offset+m.start(),m.group()) for m in re.finditer(r"[^\n]+", text)]
        for position, chunk in chunks:
            if chunk.lstrip().startswith("#") or (chunk.rstrip().endswith(":") and not citation_pattern.search(chunk)):
                candidates.append((position,position+len(chunk),"formatting"))
                continue
            spans = _sentences(chunk,position,citation_pattern)
            with_cites = [index for index,(start,end) in enumerate(spans) if citation_pattern.search(answer[start:end])]
            ambiguous = len(spans) > 1 and with_cites == [len(spans)-1]
            if ambiguous and group_passages:
                # Review the whole cited passage. Never guess which individual
                # sentence the terminal citation supports or rewrite its text.
                candidates.append((spans[0][0],spans[-1][1],None))
                continue
            for index,(start,end) in enumerate(spans):
                candidates.append((start,end,"ambiguous_citation" if ambiguous and index == len(spans)-1 else None))
    return candidates


def build_review_plan(snapshot: Snapshot, *, limits: Limits, annotations: tuple[SpanAnnotation,...] = (),
                      builder_version: str = BUILDER_VERSION) -> ReviewPlan:
    if builder_version not in {BUILDER_VERSION, PASSAGE_BUILDER_VERSION}:
        raise ValueError("unsupported_unit_builder")
    snapshot = load_snapshot(canonical_json(snapshot.model_dump(mode="json")),limits=limits)
    answer = snapshot.result.summary
    citation_pattern = _CITE_GROUP if builder_version == PASSAGE_BUILDER_VERSION else _CITE
    def citations(start,end):
        return tuple(CitationSpan(start=m.start(),end=m.end(),source_id=source_id)
            for m in citation_pattern.finditer(answer,start,end)
            for source_id in re.findall(r's[1-9][0-9]?',m.group(1)))
    sources = {s.id:s for s in snapshot.result.sources}
    evidence = {e.citation_id:e for e in snapshot.evidence}
    annotated = sorted(annotations,key=lambda a:a.start)
    previous = -1
    for item in annotated:
        if not 0 <= item.start < item.end <= len(answer) or item.start < previous:
            raise ValueError("invalid_annotation_span")
        previous = item.end
        actual = {(c.start,c.end,c.source_id) for c in citations(item.start,item.end)}
        provided = {(c.start,c.end,c.source_id) for c in item.citation_spans}
        if not actual or provided != actual or any(c.source_id not in sources for c in item.citation_spans):
            raise ValueError("invalid_annotation_citation")
    candidates = _candidates(answer,group_passages=builder_version == PASSAGE_BUILDER_VERSION)
    # Explicit annotations override intersected automatic spans; remaining text
    # remains accounted for, conservatively unreviewed if a boundary was cut.
    for item in annotated:
        replaced = []
        for start,end,reason in candidates:
            if end <= item.start or start >= item.end:
                replaced.append((start,end,reason))
            else:
                if start < item.start and answer[start:item.start].strip():
                    replaced.append((start,item.start,"ambiguous_boundary"))
                if end > item.end and answer[item.end:end].strip():
                    replaced.append((item.end,end,"ambiguous_boundary"))
        candidates = replaced + [(item.start,item.end,None)]
    candidates.sort()
    units, pairs, coverage, excluded = [], [], [], []
    eligible_count = 0
    for start,end,reason in candidates:
        text = answer[start:end]
        spans = citations(start,end)
        if reason == "formatting":
            coverage.append(CoverageItem(start=start,end=end,reason=reason))
            continue
        eligible_count += 1
        if eligible_count > limits.unit_limit:
            reason = "unit_limit"
        if not spans and not reason:
            reason = "ambiguous_citation" if re.search(r"\[s\d",text) else "no_citation"
        if reason:
            coverage.append(CoverageItem(start=start,end=end,reason=reason))
            continue
        ids = list(dict.fromkeys(c.source_id for c in spans))
        unit = ReviewUnit(unit_id=_identity(snapshot.snapshot_sha256,start,end),snapshot_id=snapshot.snapshot_id,
            text=text,start=start,end=end,citation_spans=spans,evidence_ids=tuple(evidence[i].evidence_id for i in ids if i in evidence),
            builder_version=builder_version,origin="curated" if any(a.start==start and a.end==end for a in annotated) else "automatic")
        units.append(unit)
        pair_ids, reasons = [], []
        for source_id in ids:
            item = evidence.get(source_id)
            pair_id = _identity(snapshot.snapshot_sha256,unit.unit_id,source_id,item.text_sha256 if item else None)
            failure = None
            if source_id not in sources:
                failure = "unknown_citation"
            elif item is None:
                failure = "missing_evidence" if re.fullmatch(r"https://pubmed\.ncbi\.nlm\.nih\.gov/\d+/",sources[source_id].url) else "non_pubmed_source"
            elif item.completeness != "complete":
                failure = "evidence_" + item.completeness
            elif len(pairs) >= limits.pair_limit:
                failure = "pair_limit"
            if failure:
                excluded.append(ExcludedPair(pair_id=pair_id,unit_id=unit.unit_id,evidence_id=item.evidence_id if item else None,reason=failure))
                reasons.append(failure)
            else:
                pairs.append(ReviewPair(pair_id=pair_id,snapshot_sha256=snapshot.snapshot_sha256,unit=unit,evidence=item))
                pair_ids.append(pair_id)
        coverage.append(CoverageItem(start=start,end=end,unit_id=unit.unit_id,pair_ids=tuple(pair_ids),reason=reasons[0] if reasons else None))
    return ReviewPlan(snapshot_sha256=snapshot.snapshot_sha256,units=tuple(units),pairs=tuple(pairs),coverage=tuple(coverage),excluded_pairs=tuple(excluded))


def select_review_plan(plan: ReviewPlan, *, selected_unit_ids: tuple[str, ...] | None) -> ReviewPlan:
    """Project executable pairs without rewriting any original answer span."""
    if selected_unit_ids is None:
        return plan
    selected = set(selected_unit_ids)
    eligible = {pair.unit.unit_id for pair in plan.pairs}
    if not selected or len(selected) != len(selected_unit_ids) or not selected <= eligible:
        raise ValueError("invalid_unit_selection")
    removed = tuple(p for p in plan.pairs if p.unit.unit_id not in selected)
    pairs = tuple(p for p in plan.pairs if p.unit.unit_id in selected)
    removed_ids = {p.pair_id for p in removed}
    coverage = tuple(item.model_copy(update={
        "pair_ids": tuple(p for p in item.pair_ids if p not in removed_ids),
        "reason": item.reason or "user_excluded",
    }) if any(p in removed_ids for p in item.pair_ids) else item for item in plan.coverage)
    return plan.model_copy(update={"pairs": pairs, "coverage": coverage,
        "excluded_pairs": plan.excluded_pairs + tuple(ExcludedPair(pair_id=p.pair_id,
            unit_id=p.unit.unit_id, evidence_id=p.evidence.evidence_id, reason="user_excluded") for p in removed)})
