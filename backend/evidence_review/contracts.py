"""Strict immutable input and result contracts; hashes bind bytes, not truth."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Annotated, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, JsonValue, field_validator, model_validator

from .serialization import canonical_json, immutable, parse_json, sha256_bytes

Hash = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
Identifier = Annotated[str, Field(min_length=1, max_length=160)]
TokenCount = Annotated[int, Field(ge=0, lt=100_000_000)]
Label = Literal["supported", "partially_supported", "contradicted", "mixed", "not_addressed"]
LABELS = ("supported", "partially_supported", "contradicted", "mixed", "not_addressed")


class Record(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True, allow_inf_nan=False)
    schema_version: Literal[1] = 1

    @field_validator("*", mode="after")
    @classmethod
    def freeze_fields(cls, value):
        if isinstance(value, datetime) and value.utcoffset() != timedelta(0):
            raise ValueError("utc_required")
        if isinstance(value, str):
            try:
                value.encode("utf-8")
            except UnicodeError:
                raise ValueError("invalid_unicode") from None
        return immutable(value)


class Limits(Record):
    concurrency: int = Field(default=2, ge=1, le=2)
    attempt_seconds: float = Field(default=10, gt=0, le=10)
    retries: int = Field(default=1, ge=0, le=1)
    snapshot_seconds: float = Field(default=60, gt=0, le=60)
    cleanup_seconds: float = Field(default=5, gt=0, le=5)
    evidence_records: int = Field(default=20, ge=1, le=20)
    abstract_chars: int = Field(default=10000, ge=1, le=10000)
    answer_chars: int = Field(default=12000, ge=1, le=12000)
    unit_limit: int = Field(default=200, ge=1, le=200)
    pair_limit: int = Field(default=40, ge=1, le=40)
    snapshot_bytes: int = Field(default=2097152, ge=1, le=2097152)
    wire_bytes: int = Field(default=131072, ge=1, le=131072)


class AbstractSection(Record):
    label: str | None = Field(default=None, max_length=256)
    text: str = Field(max_length=10000)


class Evidence(Record):
    evidence_id: Identifier
    citation_id: Annotated[str, Field(pattern=r"^s[1-9][0-9]?$")]
    source_kind: Literal["pubmed_abstract", "synthetic"]
    pmid: str | None = None
    url: str = Field(max_length=4096)
    title: str = Field(max_length=500)
    retrieved_at: AwareDatetime
    sections: tuple[AbstractSection, ...] = Field(max_length=64)
    extraction_version: Identifier
    text_sha256: Hash
    completeness: Literal["complete", "truncated", "absent", "unavailable"]
    original_chars: int | None = Field(default=None, ge=0, le=2097152)

    @model_validator(mode="after")
    def provenance(self):
        import re
        if self.source_kind == "pubmed_abstract":
            if not self.pmid or not re.fullmatch(r"[0-9]{1,12}", self.pmid) or self.url != f"https://pubmed.ncbi.nlm.nih.gov/{self.pmid}/":
                raise ValueError("invalid_pubmed_provenance")
        elif self.pmid is not None:
            raise ValueError("synthetic_pmid")
        retained = sum(len(section.text) for section in self.sections)
        if retained > 10000:
            raise ValueError("abstract_too_large")
        if self.completeness == "complete" and (not retained or self.original_chars != retained):
            raise ValueError("incomplete_abstract")
        if self.completeness == "truncated" and (self.original_chars is None or self.original_chars <= retained):
            raise ValueError("invalid_truncation")
        if self.completeness == "absent" and retained:
            raise ValueError("absent_with_text")
        if self.text_sha256 != sha256_bytes(canonical_json([s.model_dump(mode="json") for s in self.sections])):
            raise ValueError("evidence_hash_mismatch")
        return self


class Source(Record):
    id: Annotated[str, Field(pattern=r"^s[1-9][0-9]?$")]
    title: str = Field(max_length=300)
    url: str = Field(max_length=4096)


class ResearchResult(Record):
    summary: str = Field(min_length=1, max_length=12000)
    sources: tuple[Source, ...] = Field(max_length=20)
    limitations: tuple[Annotated[str, Field(max_length=500)], ...] = Field(default=(), max_length=9)
    usage: dict[str, TokenCount] = Field(default_factory=dict)
    suggestionsHtml: str | None = Field(default=None, max_length=32000)


class CaptureExclusion(Record):
    citation_id: str | None = None
    reason: Identifier


class Snapshot(Record):
    canonical_version: Literal["json-v1"] = "json-v1"
    snapshot_id: Identifier
    created_at: AwareDatetime
    data_class: Literal["public_literature", "synthetic"]
    generation: dict[str, JsonValue]
    result: ResearchResult
    evidence: tuple[Evidence, ...] = Field(max_length=20)
    capture_exclusions: tuple[CaptureExclusion, ...] = Field(default=(), max_length=40)
    answer_sha256: Hash
    snapshot_sha256: Hash

    @model_validator(mode="after")
    def mappings(self):
        sources = {s.id: s for s in self.result.sources}
        if len(sources) != len(self.result.sources):
            raise ValueError("duplicate_source")
        ids, citations = set(), set()
        for item in self.evidence:
            if item.evidence_id in ids or item.citation_id in citations:
                raise ValueError("duplicate_evidence")
            ids.add(item.evidence_id)
            citations.add(item.citation_id)
            if item.citation_id not in sources or sources[item.citation_id].url != item.url:
                raise ValueError("evidence_source_mismatch")
            if self.data_class == "public_literature" and item.source_kind != "pubmed_abstract":
                raise ValueError("synthetic_evidence_in_public_snapshot")
        if self.answer_sha256 != sha256_bytes(self.result.summary.encode("utf-8")):
            raise ValueError("answer_hash_mismatch")
        return self


class CitationSpan(Record):
    start: int = Field(ge=0)
    end: int = Field(gt=0)
    source_id: Identifier


class SpanAnnotation(Record):
    start: int = Field(ge=0)
    end: int = Field(gt=0)
    citation_spans: tuple[CitationSpan, ...]
    origin: Literal["curated"] = "curated"


class ReviewUnit(Record):
    unit_id: Identifier
    snapshot_id: Identifier
    text: str = Field(min_length=1, max_length=12000)
    start: int = Field(ge=0)
    end: int = Field(gt=0)
    citation_spans: tuple[CitationSpan, ...]
    evidence_ids: tuple[Identifier, ...]
    builder_version: Identifier
    origin: Literal["automatic", "curated"]


class CoverageItem(Record):
    start: int
    end: int
    unit_id: Identifier | None = None
    reason: Identifier | None = None
    pair_ids: tuple[Identifier, ...] = ()


class ReviewPair(Record):
    pair_id: Identifier
    snapshot_sha256: Hash
    unit: ReviewUnit
    evidence: Evidence


class ExcludedPair(Record):
    pair_id: Identifier
    unit_id: Identifier
    evidence_id: Identifier | None
    reason: Identifier


class ReviewPlan(Record):
    snapshot_sha256: Hash
    units: tuple[ReviewUnit, ...]
    pairs: tuple[ReviewPair, ...]
    coverage: tuple[CoverageItem, ...]
    excluded_pairs: tuple[ExcludedPair, ...] = ()


@dataclass(frozen=True)
class PreparedRequest:
    evaluator: str
    model: str
    rubric_version: str
    rubric_sha256: str
    request_sha256: str
    body: bytes


class Judgment(Record):
    label: Label
    requested_model: Identifier
    resolved_model: Identifier
    probabilities: dict[Label, Annotated[float, Field(ge=0, le=1)]] | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)

    @model_validator(mode="after")
    def distribution(self):
        if self.requested_model.startswith("jev-"):
            if self.requested_model != self.resolved_model:
                raise ValueError("model_mismatch")
            if self.probabilities is None or self.confidence is None or set(self.probabilities) != set(LABELS):
                raise ValueError("invalid_distribution")
            if abs(sum(self.probabilities.values()) - 1) > 0.0001 or self.probabilities[self.label] != max(self.probabilities.values()):
                raise ValueError("invalid_distribution")
        elif self.probabilities is not None or self.confidence is not None:
            raise ValueError("unsupported_probabilities")
        return self


class AttemptOutcome(Record):
    judgment: Judgment | None = None
    reason: Identifier | None = None
    retryable: bool = False
    stop_evaluator: bool = False
    submitted: bool = False
    retry_after_seconds: float | None = Field(default=None, ge=0, le=86400)
    usage: dict[str, TokenCount] | None = None
    elapsed_seconds: float = Field(default=0, ge=0)

    @model_validator(mode="after")
    def outcome(self):
        if (self.judgment is None) == (self.reason is None):
            raise ValueError("invalid_outcome")
        if self.judgment is not None and (self.retryable or self.stop_evaluator):
            raise ValueError("invalid_success")
        return self


class AttemptRecord(Record):
    attempt_id: Identifier
    pair_id: Identifier
    request_sha256: Hash
    started_at: AwareDatetime
    ended_at: AwareDatetime | None = None
    outcome: AttemptOutcome | None = None


class Assessment(Record):
    pair_id: Identifier
    snapshot_sha256: Hash
    unit_id: Identifier
    evidence_id: Identifier
    evidence_sha256: Hash
    evaluator: Identifier
    model: Identifier
    rubric_sha256: Hash
    request_sha256: Hash | None = None
    status: Literal["completed", "skipped", "failed", "cancelled"]
    reason: Identifier | None = None
    judgment: Judgment | None = None
    attempt_ids: tuple[Identifier, ...] = ()
    elapsed_seconds: float = Field(default=0, ge=0)
    reused_from: str | None = None

    @model_validator(mode="after")
    def terminal(self):
        if self.status == "completed":
            if self.judgment is None or self.reason is not None or self.request_sha256 is None:
                raise ValueError("invalid_completed_assessment")
        elif self.judgment is not None or self.reason is None:
            raise ValueError("invalid_noncompleted_assessment")
        return self


class RunResult(Record):
    started_at: AwareDatetime | None = None
    experiment_sha256: Hash | None = None
    evaluator_config_sha256: Hash | None = None
    run_id: Identifier
    snapshot_sha256: Hash
    evaluator: Identifier
    model: Identifier
    limits: Limits
    assessments: tuple[Assessment, ...]
    coverage: tuple[CoverageItem, ...]
    excluded_pairs: tuple[ExcludedPair, ...] = ()
    attempts: tuple[AttemptRecord, ...] = ()
    evaluator_failure: str | None = None
    elapsed_seconds: float = Field(ge=0)
    finalization_seconds: float = Field(default=0, ge=0)


class CaptureResult(Record):
    result: ResearchResult
    evidence: tuple[Evidence, ...]
    capture_exclusions: tuple[CaptureExclusion, ...]
    generation: dict[str, JsonValue]


def _limits(snapshot: Snapshot, limits: Limits):
    if len(snapshot.result.summary) > limits.answer_chars or len(snapshot.evidence) > limits.evidence_records:
        raise ValueError("snapshot_limit")
    if any(sum(len(s.text) for s in e.sections) > limits.abstract_chars for e in snapshot.evidence):
        raise ValueError("abstract_limit")
    if len(canonical_json(snapshot.model_dump(mode="json"))) > limits.snapshot_bytes:
        raise ValueError("snapshot_too_large")


def freeze_snapshot(payload: dict, *, limits: Limits) -> Snapshot:
    data = parse_json(canonical_json(payload), max_bytes=limits.snapshot_bytes)
    for evidence in data.get("evidence", []):
        sections = [AbstractSection.model_validate_json(canonical_json(s)).model_dump(mode="json")
                    for s in evidence.get("sections", [])]
        evidence["sections"] = sections
        evidence["text_sha256"] = sha256_bytes(canonical_json(sections))
    data["answer_sha256"] = sha256_bytes(data["result"]["summary"].encode("utf-8"))
    data["snapshot_sha256"] = "0" * 64
    snapshot = Snapshot.model_validate_json(canonical_json(data))
    data = snapshot.model_dump(mode="json")
    data["snapshot_sha256"] = sha256_bytes(canonical_json({k: v for k, v in data.items() if k != "snapshot_sha256"}))
    return load_snapshot(canonical_json(data), limits=limits)


def load_snapshot(data: bytes, *, limits: Limits) -> Snapshot:
    payload = parse_json(data, max_bytes=limits.snapshot_bytes)
    snapshot = Snapshot.model_validate_json(canonical_json(payload))
    expected = sha256_bytes(canonical_json(snapshot.model_dump(mode="json", exclude={"snapshot_sha256"})))
    if expected != snapshot.snapshot_sha256:
        raise ValueError("snapshot_hash_mismatch")
    _limits(snapshot, limits)
    return snapshot
