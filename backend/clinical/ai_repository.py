"""Durable application journal, independent of provider resumption handles."""
from __future__ import annotations

from datetime import timedelta
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import delete, select, update

from .contracts import SessionClaims, to_iso_z, utc_now, parse_iso_z
from .models import AILiveEventModel, AILiveSessionModel, AILiveToolModel, AIResearchPreferenceModel, AIResearchGenerationModel
from .ai_config import profile_for_model

TERMINAL_TOOLS = {"completed", "failed", "cancelled", "interrupted", "outcome_unknown", "denied"}


class AILiveRepository:
    def __init__(self, clinical_repository):
        self.factory = clinical_repository._session_factory

    def research_preference(self, owner):
        with self.factory() as db:
            row = db.get(AIResearchPreferenceModel, owner)
            return (row.provider, row.model_id) if row else None

    def save_research_preference(self, owner, provider, model):
        with self.factory() as db:
            row = db.get(AIResearchPreferenceModel, owner)
            if row is None:
                db.add(AIResearchPreferenceModel(owner=owner, provider=provider, model_id=model))
            else:
                row.provider, row.model_id = provider, model
            db.commit()

    def record_research_generation(self, session_id, tool_id, *, provider, model):
        with self.factory() as db:
            key = f"{session_id}:{tool_id}"
            tool = db.get(AILiveToolModel, key)
            if tool is None or tool.name != "research_run" or tool.status != "running":
                raise HTTPException(409, "Research dispatch is unavailable.")
            existing = db.get(AIResearchGenerationModel, key)
            if existing:
                if (existing.provider, existing.model_id) != (provider, model):
                    raise HTTPException(409, "Research generation identity changed.")
                return
            db.add(AIResearchGenerationModel(id=key, session_id=session_id, provider=provider,
                model_id=model, recorded_at=to_iso_z(utc_now())))
            db.commit()

    def research_generation(self, session_id, tool_id):
        with self.factory() as db:
            row = db.get(AIResearchGenerationModel, f"{session_id}:{tool_id}")
            return {"providerId": row.provider if row else None,
                "modelId": row.model_id if row else None, "recordedAt": row.recorded_at if row else None}

    def recover(self):
        with self.factory() as db:
            db.execute(update(AILiveSessionModel).where(
                AILiveSessionModel.status != "closed"
            ).values(status="interrupted", attestation=None))
            db.execute(update(AILiveToolModel).where(
                AILiveToolModel.status.not_in(TERMINAL_TOOLS)
            ).values(status="interrupted"))
            db.commit()

    def create(self, actor, context, attestation, status, model):
        with self.factory() as db:
            row = AILiveSessionModel(id=f"ais-{uuid4().hex}", owner=actor.sub,
                created_at=to_iso_z(utc_now()), expires_at=actor.expires_at,
                status=status, model_id=model, context_json=context, attestation=attestation,
                context_version=1, sequence=0)
            db.add(row)
            db.commit()
            return self.session_dict(row)

    def owned(self, session_id: str, actor: SessionClaims, *, active=False):
        with self.factory() as db:
            row = db.get(AILiveSessionModel, session_id)
            if row is None or row.owner != actor.sub:
                raise HTTPException(404, "AI session not found.")
            if active and (row.status == "closed" or parse_iso_z(row.expires_at) <= utc_now()):
                raise HTTPException(409, "AI session is closed or expired. Start a new session.")
            return self.session_dict(row)

    def get(self, session_id):
        with self.factory() as db:
            row = db.get(AILiveSessionModel, session_id)
            if row is None:
                raise HTTPException(404, "AI session not found.")
            return self.session_dict(row)

    def list(self, actor):
        with self.factory() as db:
            rows = db.scalars(select(AILiveSessionModel).where(AILiveSessionModel.owner == actor.sub)
                              .order_by(AILiveSessionModel.created_at.desc()).limit(100)).all()
            return [self.session_dict(row) for row in rows]

    def change(self, session_id, **values):
        with self.factory() as db:
            row = db.get(AILiveSessionModel, session_id)
            if row is None:
                raise HTTPException(404, "AI session not found.")
            for key, value in values.items():
                setattr(row, key, value)
            db.commit()
            return self.session_dict(row)

    def active_sessions(self, actor):
        with self.factory() as db:
            rows = db.scalars(select(AILiveSessionModel).where(
                AILiveSessionModel.owner == actor.sub,
                AILiveSessionModel.status != "closed")).all()
            return [self.session_dict(row) for row in rows]

    def event(self, session_id, kind, payload, *, persist=True):
        # This method deliberately cannot accept audio/screen blobs.
        if kind not in {"session", "transcript", "interaction", "interrupted", "tool", "viewer_action", "citations", "error", "pong", "audio_chunk", "screen_status", "research_progress"}:
            raise ValueError("Unsupported journal event")
        if kind in {"audio_chunk", "screen_status"}:
            persist = False
        with self.factory() as db:
            row = db.get(AILiveSessionModel, session_id)
            if row is None:
                raise HTTPException(404, "AI session not found.")
            row.sequence += 1
            event = {**payload, "kind": kind, "sessionId": session_id,
                     "sequence": row.sequence, "contextVersion": row.context_version}
            if persist:
                db.add(AILiveEventModel(id=uuid4().hex, session_id=session_id,
                                       sequence=row.sequence, event_json=event))
            db.commit()
            return event

    def history(self, session_id, actor):
        session = self.owned(session_id, actor)
        with self.factory() as db:
            events = db.scalars(select(AILiveEventModel).where(AILiveEventModel.session_id == session_id)
                               .order_by(AILiveEventModel.sequence.desc()).limit(2000)).all()
            tools = db.scalars(select(AILiveToolModel).where(AILiveToolModel.session_id == session_id)
                              .order_by(AILiveToolModel.created_at.desc()).limit(200)).all()
            return {"session": session, "events": [x.event_json for x in reversed(events)],
                    "tools": [self.tool_dict(x, db) for x in reversed(tools)]}

    def clear(self, session_id, actor):
        self.owned(session_id, actor)
        with self.factory() as db:
            for cls in (AILiveEventModel, AILiveToolModel, AIResearchGenerationModel):
                db.execute(delete(cls).where(cls.session_id == session_id))
            db.execute(delete(AILiveSessionModel).where(AILiveSessionModel.id == session_id))
            db.commit()

    def active_tools(self, session_id):
        with self.factory() as db:
            rows = db.scalars(select(AILiveToolModel).where(
                AILiveToolModel.session_id == session_id,
                AILiveToolModel.status.not_in(TERMINAL_TOOLS))).all()
            return [self.tool_dict(row, db) for row in rows]

    def add_tool(self, session_id, provider_id, name, arguments, context_version, approval):
        # Provider IDs only identify calls within one application session.
        record_id = f"{session_id}:{provider_id}"
        with self.factory() as db:
            previous = db.get(AILiveToolModel, record_id)
            if previous:
                return self.tool_dict(previous, db), False
            row = AILiveToolModel(id=record_id, session_id=session_id, provider_id=provider_id,
                name=name, arguments=arguments, context_version=context_version,
                status="awaiting_approval" if approval else "pending", requires_approval=approval,
                created_at=to_iso_z(utc_now()), expires_at=to_iso_z(utc_now() + timedelta(minutes=5)))
            db.add(row)
            db.commit()
            return self.tool_dict(row, db), True

    def tool(self, session_id, tool_id):
        with self.factory() as db:
            row = db.get(AILiveToolModel, f"{session_id}:{tool_id}")
            if row is None:
                raise HTTPException(404, "AI tool call not found.")
            return self.tool_dict(row, db)

    def set_tool(self, session_id, tool_id, status, result=None):
        with self.factory() as db:
            row = db.get(AILiveToolModel, f"{session_id}:{tool_id}")
            if row is None:
                raise HTTPException(404, "AI tool call not found.")
            row.status = status
            row.result_json = result
            db.commit()
            return self.tool_dict(row, db)

    @staticmethod
    def session_dict(row):
        profile = profile_for_model(row.model_id)
        return {"sessionId": row.id, "status": row.status, "createdAt": row.created_at,
                "expiresAt": row.expires_at, "backendBound": True, "voiceFirst": True,
                "orchestrationMode": "api", "message": f"Synthetic/deidentified {profile['label']} session.",
                "providerId": profile["id"], "inputSampleRate": profile["inputSampleRate"],
                "outputSampleRate": profile["outputSampleRate"],
                "contextVersion": row.context_version, "attestation": row.attestation,
                "viewerContext": row.context_json,
                "liveUrl": f"/api/ai/sidebar/sessions/{row.id}/live", "modelId": row.model_id}

    @staticmethod
    def tool_dict(row, db):
        generation = db.get(AIResearchGenerationModel, row.id) if row.name == "research_run" else None
        return {"toolCallId": row.provider_id, "name": row.name, "args": row.arguments,
                "contextVersion": row.context_version, "status": row.status,
                "requiresApproval": row.requires_approval, "result": row.result_json,
                "expiresAt": row.expires_at,
                "research": {"providerId": generation.provider, "modelId": generation.model_id,
                    "recordedAt": generation.recorded_at} if generation else None}
