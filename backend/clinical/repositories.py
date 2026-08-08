from __future__ import annotations

from datetime import datetime
from uuid import uuid4

from sqlalchemy import select

from .contracts import (
    AIJobCreateRequest,
    AIJobRecord,
    AIJobStatus,
    AuditEvent,
    DerivedDicomObject,
    DerivedResultRecord,
    LaunchSessionRecord,
    LocalImagingImportedStudy,
    ReportDraftRequest,
    ReportRecord,
    ReportStatus,
    StudyWorkspace,
    WorklistRow,
    parse_iso_z,
    to_iso_z,
)
from .db import Base, create_session_factory, create_sqlalchemy_engine
from .models import (
    AIJobModel,
    AuditEventModel,
    ClinicalTaskModel,
    DerivedResultModel,
    GovernanceDecisionModel,
    ImagingLaunchSessionModel,
    ModelRegistryModel,
    ReportModel,
    StudyModel,
)


class ClinicalRepository:
    def __init__(self, database_url: str) -> None:
        self._engine = create_sqlalchemy_engine(database_url)
        self._session_factory = create_session_factory(self._engine)

    def initialize(self) -> None:
        Base.metadata.create_all(self._engine)
        self._seed_if_empty()

    def list_worklist(self) -> list[WorklistRow]:
        with self._session_factory() as session:
            rows = session.scalars(select(StudyModel)).all()
            return [self._to_worklist_row(row) for row in rows]

    def get_worklist_row(self, study_uid: str) -> WorklistRow | None:
        with self._session_factory() as session:
            row = session.get(StudyModel, study_uid)
            return self._to_worklist_row(row) if row else None

    def register_local_imported_study(self, imported: LocalImagingImportedStudy) -> WorklistRow:
        with self._session_factory() as session:
            now = datetime.utcnow()
            model = session.get(StudyModel, imported.study_instance_uid)
            if model is None:
                model = StudyModel(
                    study_instance_uid=imported.study_instance_uid,
                    created_at=now,
                )
                session.add(model)

            model.accession_number = imported.accession_number
            model.patient_ref = "Patient/local-import"
            model.modality = imported.modality
            model.description = imported.description
            model.status = ReportStatus.NEW.value
            model.archive_ref = imported.archive_ref
            model.encounter_ref = "Encounter/local-import"
            model.prior_study_uids = []
            model.triage_score = None
            model.workflow_status = ReportStatus.NEW.value
            model.review_status = ReportStatus.NEW.value
            model.source_of_truth = "local-import"
            model.last_updated_at = now
            session.commit()
            session.refresh(model)
            return self._to_worklist_row(model)

    def create_launch_session(
        self,
        *,
        context,
        actor_user_id: str,
        actor_role: str,
        signature: str,
    ) -> str:
        with self._session_factory() as session:
            study = self._ensure_study(session, context.study_instance_uid)
            launch_token = f"launch-{uuid4()}"
            session.add(
                ImagingLaunchSessionModel(
                    launch_token=launch_token,
                    study_instance_uid=study.study_instance_uid,
                    actor_user_id=actor_user_id,
                    actor_role=actor_role,
                    signature=signature,
                    context_json=context.model_dump(by_alias=True),
                    expires_at=parse_iso_z(context.expires_at),
                    created_at=datetime.utcnow(),
                )
            )
            session.commit()
            return launch_token

    def get_launch_session(self, launch_token: str) -> LaunchSessionRecord | None:
        with self._session_factory() as session:
            model = session.get(ImagingLaunchSessionModel, launch_token)
            if model is None:
                return None

            model.resolved_at = datetime.utcnow()
            session.commit()

            return LaunchSessionRecord(
                launch_token=model.launch_token,
                context=model.context_json,
                signature=model.signature,
                actor_user_id=model.actor_user_id,
                actor_role=model.actor_role,
                expires_at=to_iso_z(model.expires_at),
                created_at=to_iso_z(model.created_at),
                resolved_at=to_iso_z(model.resolved_at) if model.resolved_at else None,
            )

    def save_report(
        self,
        request: ReportDraftRequest,
        *,
        author_user_id: str,
    ) -> ReportRecord:
        with self._session_factory() as session:
            study = self._ensure_study(session, request.study_instance_uid)
            model = session.get(ReportModel, request.report_id) if request.report_id else None
            now = datetime.utcnow()
            request_status = self._enum_value(request.status)

            if model is None:
                model = ReportModel(
                    report_id=request.report_id or f"report-{uuid4()}",
                    study_instance_uid=study.study_instance_uid,
                    created_at=now,
                )
                session.add(model)

            model.study_instance_uid = study.study_instance_uid
            model.diagnostic_report_id = request.diagnostic_report_id
            model.status = request_status
            model.author_user_id = author_user_id
            model.reviewer_user_id = request.reviewer_user_id
            model.findings_summary = request.findings_summary
            model.impression = request.impression
            model.derived_object_refs = request.derived_object_refs
            model.ai_contribution_refs = request.ai_contribution_refs
            model.updated_at = now

            study_status = (
                ReportStatus.DRAFTED.value
                if request_status == ReportStatus.DRAFT.value
                else request_status
            )
            study.status = study_status
            study.workflow_status = study_status
            study.review_status = study_status
            study.last_updated_at = now

            session.commit()
            session.refresh(model)
            return self._to_report_record(model)

    def create_ai_job(
        self,
        request: AIJobCreateRequest,
        *,
        requested_by: str,
    ) -> AIJobRecord:
        with self._session_factory() as session:
            study = self._ensure_study(session, request.study_instance_uid)
            now = datetime.utcnow()
            model = AIJobModel(
                job_id=f"job-{uuid4()}",
                study_instance_uid=study.study_instance_uid,
                series_instance_uid=request.series_instance_uid,
                kind=self._enum_value(request.kind),
                workflow_mode=self._enum_value(request.workflow_mode),
                model_id=request.model_id,
                model_version=request.model_version,
                input_hash=request.input_hash,
                requested_by=requested_by,
                status=AIJobStatus.QUEUED.value,
                output_refs=request.output_refs,
                created_at=now,
            )
            study.last_updated_at = now
            session.add(model)
            session.commit()
            session.refresh(model)
            return self._to_ai_job_record(model)

    def store_derived_result(
        self,
        object_: DerivedDicomObject,
        stored_ref: str,
    ) -> DerivedResultRecord:
        with self._session_factory() as session:
            study = self._ensure_study(session, object_.study_instance_uid)
            now = datetime.utcnow()
            model = DerivedResultModel(
                id=f"derived-{uuid4()}",
                study_instance_uid=study.study_instance_uid,
                series_instance_uid=object_.series_instance_uid,
                sop_instance_uid=object_.sop_instance_uid,
                object_type=object_.object_type,
                storage_class=object_.storage_class,
                content_type=object_.content_type,
                payload_ref=stored_ref,
                metadata_json=object_.metadata,
                created_at=now,
            )
            study.last_updated_at = now
            session.add(model)
            session.commit()
            session.refresh(model)
            return self._to_derived_result_record(model)

    def add_audit_event(self, event: AuditEvent) -> None:
        with self._session_factory() as session:
            if event.study_instance_uid:
                self._ensure_study(session, event.study_instance_uid)

            session.add(
                AuditEventModel(
                    event_id=event.event_id,
                    occurred_at=parse_iso_z(event.occurred_at),
                    actor_user_id=event.actor_user_id,
                    actor_role=event.actor_role,
                    action=event.action,
                    patient_ref=event.patient_ref,
                    study_instance_uid=event.study_instance_uid,
                    resource_type=event.resource_type,
                    resource_id=event.resource_id,
                    trace_id=event.trace_id,
                    source_ip=event.source_ip,
                    outcome=event.outcome,
                )
            )
            session.commit()

    def list_audit_events(self, study_uid: str) -> list[AuditEvent]:
        with self._session_factory() as session:
            rows = session.scalars(
                select(AuditEventModel)
                .where(AuditEventModel.study_instance_uid == study_uid)
                .order_by(AuditEventModel.occurred_at.desc())
            ).all()
            return [self._to_audit_event(row) for row in rows]

    def get_study_workspace(self, study_uid: str) -> StudyWorkspace:
        with self._session_factory() as session:
            study = session.get(StudyModel, study_uid)
            reports = session.scalars(
                select(ReportModel)
                .where(ReportModel.study_instance_uid == study_uid)
                .order_by(ReportModel.updated_at.desc())
            ).all()
            ai_jobs = session.scalars(
                select(AIJobModel)
                .where(AIJobModel.study_instance_uid == study_uid)
                .order_by(AIJobModel.created_at.desc())
            ).all()
            derived_results = session.scalars(
                select(DerivedResultModel)
                .where(DerivedResultModel.study_instance_uid == study_uid)
                .order_by(DerivedResultModel.created_at.desc())
            ).all()
            audit = session.scalars(
                select(AuditEventModel)
                .where(AuditEventModel.study_instance_uid == study_uid)
                .order_by(AuditEventModel.occurred_at.desc())
            ).all()
            return StudyWorkspace(
                worklist_row=self._to_worklist_row(study) if study else None,
                reports=[self._to_report_record(report) for report in reports],
                ai_jobs=[self._to_ai_job_record(job) for job in ai_jobs],
                derived_results=[
                    self._to_derived_result_record(result) for result in derived_results
                ],
                audit=[self._to_audit_event(event) for event in audit],
            )

    def _seed_if_empty(self) -> None:
        with self._session_factory() as session:
            existing = session.scalar(select(StudyModel.study_instance_uid).limit(1))
            if existing:
                return

            now = datetime.utcnow()
            session.add_all(
                [
                    StudyModel(
                        study_instance_uid="1.2.840.113619.2.55.3.604688123.1234.1700000001.101",
                        accession_number="ACC-CT-24001",
                        patient_ref="Patient/example-ct-01",
                        modality="CT",
                        description="Chest CT with contrast",
                        status=ReportStatus.NEW.value,
                        archive_ref="orthanc://default",
                        encounter_ref="Encounter/example-enc-01",
                        prior_study_uids=["1.2.840.113619.2.55.3.604688123.1234.1699999000.100"],
                        triage_score=0.23,
                        workflow_status=ReportStatus.NEW.value,
                        review_status=ReportStatus.NEW.value,
                        last_updated_at=now,
                        created_at=now,
                    ),
                    StudyModel(
                        study_instance_uid="1.2.840.113619.2.55.3.604688123.1234.1700000002.201",
                        accession_number="ACC-MR-24017",
                        patient_ref="Patient/example-mr-02",
                        modality="MR",
                        description="Brain MRI follow-up",
                        status=ReportStatus.IN_REVIEW.value,
                        archive_ref="orthanc://default",
                        encounter_ref="Encounter/example-enc-02",
                        prior_study_uids=["1.2.840.113619.2.55.3.604688123.1234.1699997000.150"],
                        triage_score=0.81,
                        workflow_status=ReportStatus.IN_REVIEW.value,
                        review_status=ReportStatus.IN_REVIEW.value,
                        last_updated_at=now,
                        created_at=now,
                    ),
                ]
            )
            session.add(
                ModelRegistryModel(
                    model_id="triage-model",
                    version="1.0.0",
                    intended_use="Shadow-mode prioritization research and internal validation.",
                    workflow_modes=["shadow", "assistive"],
                    validation_evidence=["validation-packet/pending"],
                    rollback_criteria="Disable model if false-negative review exceeds clinical threshold.",
                    active=True,
                    created_at=now,
                    updated_at=now,
                )
            )
            session.add(
                GovernanceDecisionModel(
                    id=f"gov-{uuid4()}",
                    model_id="triage-model",
                    decision_type="initial_enablement",
                    status="shadow_only",
                    rationale="Default posture remains shadow mode until clinical validation is complete.",
                    approved_by="governance-board",
                    evidence_ref="validation-packet/pending",
                    created_at=now,
                    updated_at=now,
                )
            )
            session.add(
                ClinicalTaskModel(
                    id=f"task-{uuid4()}",
                    study_instance_uid="1.2.840.113619.2.55.3.604688123.1234.1700000002.201",
                    task_type="peer_review",
                    status="open",
                    owner_user_id="demo-radiologist",
                    payload_json={"reason": "high triage score requires structured review"},
                    created_at=now,
                    updated_at=now,
                )
            )
            session.commit()

    def _ensure_study(self, session, study_uid: str) -> StudyModel:
        study = session.get(StudyModel, study_uid)
        if study:
            return study

        now = datetime.utcnow()
        study = StudyModel(
            study_instance_uid=study_uid,
            accession_number=f"ACC-{study_uid[-6:]}",
            patient_ref="Patient/unknown",
            modality="OT",
            description="Externally referenced study",
            status=ReportStatus.NEW.value,
            archive_ref="orthanc://default",
            prior_study_uids=[],
            workflow_status=ReportStatus.NEW.value,
            review_status=ReportStatus.NEW.value,
            last_updated_at=now,
            created_at=now,
        )
        session.add(study)
        session.flush()
        return study

    @staticmethod
    def _to_worklist_row(model: StudyModel) -> WorklistRow:
        return WorklistRow(
            study_instance_uid=model.study_instance_uid,
            accession_number=model.accession_number,
            patient_ref=model.patient_ref,
            modality=model.modality,
            description=model.description,
            status=model.status,
            archive_ref=model.archive_ref,
            encounter_ref=model.encounter_ref,
            prior_study_uids=model.prior_study_uids or [],
            triage_score=model.triage_score,
            last_updated_at=to_iso_z(model.last_updated_at),
        )

    @staticmethod
    def _to_report_record(model: ReportModel) -> ReportRecord:
        return ReportRecord(
            report_id=model.report_id,
            study_instance_uid=model.study_instance_uid,
            diagnostic_report_id=model.diagnostic_report_id,
            status=model.status,
            author_user_id=model.author_user_id,
            reviewer_user_id=model.reviewer_user_id,
            findings_summary=model.findings_summary,
            impression=model.impression,
            derived_object_refs=model.derived_object_refs or [],
            ai_contribution_refs=model.ai_contribution_refs or [],
            created_at=to_iso_z(model.created_at),
            updated_at=to_iso_z(model.updated_at),
        )

    @staticmethod
    def _to_ai_job_record(model: AIJobModel) -> AIJobRecord:
        return AIJobRecord(
            job_id=model.job_id,
            kind=model.kind,
            workflow_mode=model.workflow_mode,
            study_instance_uid=model.study_instance_uid,
            series_instance_uid=model.series_instance_uid,
            model_id=model.model_id,
            model_version=model.model_version,
            input_hash=model.input_hash,
            requested_by=model.requested_by,
            status=model.status,
            output_refs=model.output_refs or [],
            reviewer_decision=model.reviewer_decision,
            created_at=to_iso_z(model.created_at),
        )

    @staticmethod
    def _to_derived_result_record(model: DerivedResultModel) -> DerivedResultRecord:
        return DerivedResultRecord(
            id=model.id,
            study_instance_uid=model.study_instance_uid,
            series_instance_uid=model.series_instance_uid,
            sop_instance_uid=model.sop_instance_uid,
            object_type=model.object_type,
            storage_class=model.storage_class,
            content_type=model.content_type,
            payload_ref=model.payload_ref,
            metadata=model.metadata_json or {},
            created_at=to_iso_z(model.created_at),
        )

    @staticmethod
    def _to_audit_event(model: AuditEventModel) -> AuditEvent:
        return AuditEvent(
            event_id=model.event_id,
            occurred_at=to_iso_z(model.occurred_at),
            actor_user_id=model.actor_user_id,
            actor_role=model.actor_role,
            action=model.action,
            patient_ref=model.patient_ref,
            study_instance_uid=model.study_instance_uid,
            resource_type=model.resource_type,
            resource_id=model.resource_id,
            trace_id=model.trace_id,
            source_ip=model.source_ip,
            outcome=model.outcome,
        )

    @staticmethod
    def _enum_value(value) -> str:
        return value.value if hasattr(value, "value") else str(value)
