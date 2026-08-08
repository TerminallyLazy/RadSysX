from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


class StudyModel(Base):
    __tablename__ = "clinical_studies"

    study_instance_uid: Mapped[str] = mapped_column(String(255), primary_key=True)
    accession_number: Mapped[str] = mapped_column(String(64), index=True)
    patient_ref: Mapped[str] = mapped_column(String(255), index=True)
    modality: Mapped[str] = mapped_column(String(32))
    description: Mapped[str] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(String(64), default="new")
    archive_ref: Mapped[str] = mapped_column(String(255))
    encounter_ref: Mapped[str | None] = mapped_column(String(255), nullable=True)
    prior_study_uids: Mapped[list[str]] = mapped_column(JSON, default=list)
    triage_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    workflow_status: Mapped[str] = mapped_column(String(64), default="new")
    review_status: Mapped[str] = mapped_column(String(64), default="new")
    source_of_truth: Mapped[str] = mapped_column(String(64), default="dicomweb")
    last_updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    reports: Mapped[list["ReportModel"]] = relationship(back_populates="study")
    ai_jobs: Mapped[list["AIJobModel"]] = relationship(back_populates="study")
    derived_results: Mapped[list["DerivedResultModel"]] = relationship(back_populates="study")
    audit_events: Mapped[list["AuditEventModel"]] = relationship(back_populates="study")
    clinical_tasks: Mapped[list["ClinicalTaskModel"]] = relationship(back_populates="study")
    launch_sessions: Mapped[list["ImagingLaunchSessionModel"]] = relationship(
        back_populates="study"
    )


class ReportModel(Base):
    __tablename__ = "clinical_reports"

    report_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    study_instance_uid: Mapped[str] = mapped_column(
        ForeignKey("clinical_studies.study_instance_uid"),
        index=True,
    )
    diagnostic_report_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    status: Mapped[str] = mapped_column(String(64), default="draft")
    author_user_id: Mapped[str] = mapped_column(String(128))
    reviewer_user_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    findings_summary: Mapped[str] = mapped_column(Text)
    impression: Mapped[str] = mapped_column(Text)
    derived_object_refs: Mapped[list[str]] = mapped_column(JSON, default=list)
    ai_contribution_refs: Mapped[list[str]] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    study: Mapped[StudyModel] = relationship(back_populates="reports")


class AIJobModel(Base):
    __tablename__ = "clinical_ai_jobs"

    job_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    study_instance_uid: Mapped[str] = mapped_column(
        ForeignKey("clinical_studies.study_instance_uid"),
        index=True,
    )
    series_instance_uid: Mapped[str | None] = mapped_column(String(255), nullable=True)
    kind: Mapped[str] = mapped_column(String(64))
    workflow_mode: Mapped[str] = mapped_column(String(64))
    model_id: Mapped[str] = mapped_column(String(128))
    model_version: Mapped[str] = mapped_column(String(64))
    input_hash: Mapped[str] = mapped_column(String(255))
    requested_by: Mapped[str] = mapped_column(String(128))
    status: Mapped[str] = mapped_column(String(64), default="queued")
    reviewer_decision: Mapped[str | None] = mapped_column(String(64), nullable=True)
    output_refs: Mapped[list[str]] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    study: Mapped[StudyModel] = relationship(back_populates="ai_jobs")


class DerivedResultModel(Base):
    __tablename__ = "clinical_derived_results"

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    study_instance_uid: Mapped[str] = mapped_column(
        ForeignKey("clinical_studies.study_instance_uid"),
        index=True,
    )
    series_instance_uid: Mapped[str | None] = mapped_column(String(255), nullable=True)
    sop_instance_uid: Mapped[str | None] = mapped_column(String(255), nullable=True)
    object_type: Mapped[str] = mapped_column(String(64))
    storage_class: Mapped[str] = mapped_column(String(64))
    content_type: Mapped[str] = mapped_column(String(128), default="application/dicom")
    payload_ref: Mapped[str | None] = mapped_column(String(255), nullable=True)
    metadata_json: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    study: Mapped[StudyModel] = relationship(back_populates="derived_results")


class ImagingLaunchSessionModel(Base):
    __tablename__ = "clinical_launch_sessions"

    launch_token: Mapped[str] = mapped_column(String(128), primary_key=True)
    study_instance_uid: Mapped[str] = mapped_column(
        ForeignKey("clinical_studies.study_instance_uid"),
        index=True,
    )
    actor_user_id: Mapped[str] = mapped_column(String(128))
    actor_role: Mapped[str] = mapped_column(String(128))
    signature: Mapped[str] = mapped_column(String(255))
    context_json: Mapped[dict] = mapped_column(JSON, default=dict)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    study: Mapped[StudyModel] = relationship(back_populates="launch_sessions")


class AuditEventModel(Base):
    __tablename__ = "clinical_audit_events"

    event_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    study_instance_uid: Mapped[str | None] = mapped_column(
        ForeignKey("clinical_studies.study_instance_uid"),
        index=True,
        nullable=True,
    )
    occurred_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    actor_user_id: Mapped[str] = mapped_column(String(128), index=True)
    actor_role: Mapped[str] = mapped_column(String(128))
    action: Mapped[str] = mapped_column(String(64))
    patient_ref: Mapped[str | None] = mapped_column(String(255), nullable=True)
    resource_type: Mapped[str] = mapped_column(String(64))
    resource_id: Mapped[str] = mapped_column(String(255))
    trace_id: Mapped[str] = mapped_column(String(128), index=True)
    source_ip: Mapped[str] = mapped_column(String(128))
    outcome: Mapped[str] = mapped_column(String(64))

    study: Mapped[StudyModel | None] = relationship(back_populates="audit_events")


class ClinicalTaskModel(Base):
    __tablename__ = "clinical_tasks"

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    study_instance_uid: Mapped[str] = mapped_column(
        ForeignKey("clinical_studies.study_instance_uid"),
        index=True,
    )
    task_type: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(64))
    owner_user_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    payload_json: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    study: Mapped[StudyModel] = relationship(back_populates="clinical_tasks")


class ModelRegistryModel(Base):
    __tablename__ = "clinical_model_registry"

    model_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    version: Mapped[str] = mapped_column(String(64))
    intended_use: Mapped[str] = mapped_column(Text)
    workflow_modes: Mapped[list[str]] = mapped_column(JSON, default=list)
    validation_evidence: Mapped[list[str]] = mapped_column(JSON, default=list)
    rollback_criteria: Mapped[str | None] = mapped_column(Text, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    governance_decisions: Mapped[list["GovernanceDecisionModel"]] = relationship(back_populates="model")


class GovernanceDecisionModel(Base):
    __tablename__ = "clinical_governance_decisions"

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    model_id: Mapped[str | None] = mapped_column(
        ForeignKey("clinical_model_registry.model_id"),
        nullable=True,
    )
    decision_type: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(64))
    rationale: Mapped[str] = mapped_column(Text)
    approved_by: Mapped[str | None] = mapped_column(String(128), nullable=True)
    evidence_ref: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    model: Mapped[ModelRegistryModel | None] = relationship(back_populates="governance_decisions")
