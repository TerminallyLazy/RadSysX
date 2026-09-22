"""Strict owned evidence-review HTTP contracts; never provider credentials or paths."""
from typing import Annotated, Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel
from ..evidence_review.contracts import Hash, Label

Id = Annotated[str, Field(min_length=1, max_length=160)]
Key = Annotated[str, Field(pattern=r'^[A-Za-z0-9_-]{1,80}$')]
Confirmation = Literal['public_literature', 'synthetic']
Status = Literal['preparing','ready','reviewing','completed','partial','failed','cancelled','interrupted','unavailable']


class APIRecord(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, populate_by_name=True, alias_generator=to_camel)


class EvidencePrepareRequest(APIRecord):
    idempotency_key: Key


class EvidenceRetryRequest(EvidencePrepareRequest):
    preview_sha256: Hash
    confirmation: Confirmation


class EvidenceStartRequest(EvidenceRetryRequest):
    selected_unit_ids: tuple[Id, ...] = Field(min_length=1, max_length=40)

    @model_validator(mode='after')
    def unique(self):
        if len(set(self.selected_unit_ids)) != len(self.selected_unit_ids):
            raise ValueError('invalid_unit_selection')
        return self


class EvidenceReviewAvailability(APIRecord):
    model_id: Literal['jev-1.13.0'] = 'jev-1.13.0'
    availability: Literal['configured','missing','disabled','unavailable']
    reason: str


class EvidenceGeneration(APIRecord):
    provider_id: str | None = None
    model_id: str | None = None
    recorded_at: str | None = None


class EvidenceReviewSummary(APIRecord):
    review_id: Id
    session_id: Id
    tool_call_id: Id
    source_context_version: int
    status: Status
    created_at: str
    updated_at: str
    model_id: Literal['jev-1.13.0'] = 'jev-1.13.0'
    generation: EvidenceGeneration = Field(default_factory=EvidenceGeneration)
    total_pairs: int = 0
    completed_pairs: int = 0
    settled_pairs: int = 0
    submitted_attempts: int = 0
    unknown_usage_attempts: int = 0
    reason: str | None = None


class EvidenceClaim(APIRecord):
    unit_id: Id
    text: str
    start: int
    end: int
    evidence_ids: list[str]
    eligible: bool
    exclusion_reason: str | None = None


class EvidenceSection(APIRecord):
    label: str | None
    text: str


class EvidenceAbstract(APIRecord):
    evidence_id: Id
    citation_id: Id
    title: str
    pmid: str | None
    url: str
    retrieved_at: str
    completeness: Literal['complete','truncated','absent','unavailable']
    sections: list[EvidenceSection]
    text_sha256: Hash
    extraction_version: str


class EvidenceAttempt(APIRecord):
    attempt_id: Id
    pair_id: Id
    request_sha256: Hash
    started_at: str
    ended_at: str | None
    submitted: bool | None
    reason: str | None
    usage: dict[str, int] | None


class EvidenceAssessment(APIRecord):
    pair_id: Id
    unit_id: Id
    evidence_id: Id
    status: Literal['completed','skipped','failed','cancelled']
    reason: str | None
    label: Label | None
    requested_model: str
    resolved_model: str | None
    rubric_version: str
    rubric_sha256: Hash
    answer_sha256: Hash
    abstract_sha256: Hash
    request_sha256: Hash | None
    attempt_ids: list[str]
    reused: bool
    probabilities: dict[Label,float] | None


class EvidenceExclusion(APIRecord):
    unit_id: str | None = None
    citation_id: str | None = None
    reason: str


class EvidenceReviewDetail(EvidenceReviewSummary):
    preview_sha256: str | None = None
    answer_sha256: str | None = None
    snapshot_sha256: str | None = None
    original_answer: str | None = None
    claims: list[EvidenceClaim] = Field(default_factory=list, max_length=200)
    abstracts: list[EvidenceAbstract] = Field(default_factory=list, max_length=20)
    exclusions: list[EvidenceExclusion] = Field(default_factory=list, max_length=400)
    selected_unit_ids: list[str] | None = None
    assessments: list[EvidenceAssessment] = Field(default_factory=list, max_length=40)
    attempts: list[EvidenceAttempt] = Field(default_factory=list, max_length=200)
    earlier_attempt_count: int = 0


class EvidenceReviewList(APIRecord):
    reviews: list[EvidenceReviewSummary]
    truncated: bool
