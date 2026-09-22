"""Owned review rows and operation identities; updates never recreate missing history."""
from uuid import uuid4
from fastapi import HTTPException
from sqlalchemy import delete, select, update
from .models import AIJevReviewModel, AIJevOperationModel, AILiveSessionModel
from .contracts import to_iso_z, utc_now
from ..evidence_review.serialization import canonical_json, sha256_bytes


def identity(value): return sha256_bytes(canonical_json(value))


class EvidenceReviewRepository:
    def __init__(self, live):
        self.factory = live.repository.factory
        self.live = live.repository

    def existing_operation(self, actor, operation, key, request_hash):
        with self.factory() as db:
            row = db.get(AIJevOperationModel, identity([actor.sub, operation, key]))
            if row is None: return None
            if row.request_hash != request_hash:
                raise HTTPException(409, 'Review operation identity changed.')
            return row.review_id

    def create_owned(self, actor, session_id, tool_id, request):
        self.live.owned(session_id, actor)
        tool = self.live.tool(session_id, tool_id)
        with self.factory() as db:
            if db.scalar(select(AIJevReviewModel.id).where(AIJevReviewModel.session_id==session_id, AIJevReviewModel.deleting.is_(True))):
                raise HTTPException(409, 'Conversation deletion is still in progress.')
            now = to_iso_z(utc_now())
            row = AIJevReviewModel(id='jer-'+uuid4().hex, owner=actor.sub, session_id=session_id, tool_id=tool_id,
                context_version=tool['contextVersion'], source_hash=identity(tool['result']), run_id='jev-'+uuid4().hex,
                status='preparing', generation=1, created_at=now, updated_at=now,
                progress_json={'generation': self.live.research_generation(session_id,tool_id)})
            db.add(row)
            db.add(AIJevOperationModel(id=identity([actor.sub,'prepare',request.idempotency_key]), owner=actor.sub,
                operation='prepare', idempotency_key=request.idempotency_key,
                request_hash=identity([session_id,tool_id]), review_id=row.id))
            db.commit()
            return row

    def owned(self, actor, review_id):
        with self.factory() as db:
            row = db.get(AIJevReviewModel, review_id)
            source = db.get(AILiveSessionModel, row.session_id) if row else None
            if row is None or row.owner != actor.sub or source is None or source.owner != actor.sub or row.deleting:
                raise HTTPException(404, 'Evidence review not found.')
            return row

    def list_owned(self, actor, session_id, limit=100):
        self.live.owned(session_id,actor)
        with self.factory() as db:
            return list(db.scalars(select(AIJevReviewModel).where(AIJevReviewModel.owner==actor.sub,
                AIJevReviewModel.session_id==session_id, AIJevReviewModel.deleting.is_(False))
                .order_by(AIJevReviewModel.created_at.desc()).limit(limit)))

    def claim_operation(self, actor, review_id, operation, key, request_hash, *, expected_generation, values):
        existing = self.existing_operation(actor,operation,key,request_hash)
        if existing:
            if existing != review_id: raise HTTPException(409, 'Review operation identity changed.')
            return False
        with self.factory() as db:
            row=db.get(AIJevReviewModel,review_id)
            source=db.get(AILiveSessionModel,row.session_id) if row else None
            if (row is None or row.owner!=actor.sub or row.deleting or row.generation!=expected_generation
                    or source is None or source.owner!=actor.sub):
                raise HTTPException(409,'Review authority changed.')
            for name,value in values.items(): setattr(row,name,value)
            row.updated_at=to_iso_z(utc_now())
            db.add(AIJevOperationModel(id=identity([actor.sub,operation,key]),owner=actor.sub,operation=operation,
                idempotency_key=key,request_hash=request_hash,review_id=review_id))
            db.commit()
        return True

    def update_if_current(self, review_id, expected_generation, **values):
        with self.factory() as db:
            row=db.get(AIJevReviewModel,review_id)
            if row is None or row.deleting or row.generation != expected_generation or db.get(AILiveSessionModel,row.session_id) is None:
                return False
            for key,value in values.items(): setattr(row,key,value)
            row.updated_at=to_iso_z(utc_now())
            db.commit()
            return True

    def mark_source_deleting(self, owner, session_id):
        with self.factory() as db:
            rows=list(db.scalars(select(AIJevReviewModel).where(AIJevReviewModel.owner==owner,AIJevReviewModel.session_id==session_id)))
            for row in rows:
                row.deleting=True; row.generation+=1
            db.commit()
            return rows

    def delete_source(self, owner, session_id):
        with self.factory() as db:
            ids=select(AIJevReviewModel.id).where(AIJevReviewModel.owner==owner,AIJevReviewModel.session_id==session_id)
            db.execute(delete(AIJevOperationModel).where(AIJevOperationModel.review_id.in_(ids)))
            db.execute(delete(AIJevReviewModel).where(AIJevReviewModel.owner==owner,AIJevReviewModel.session_id==session_id))
            db.commit()

    def recover(self):
        with self.factory() as db:
            db.execute(update(AIJevReviewModel).where(AIJevReviewModel.status.in_(['preparing','reviewing']),
                AIJevReviewModel.deleting.is_(False)).values(status='interrupted',reason='backend_restarted',updated_at=to_iso_z(utc_now())))
            db.commit()
            return list(db.scalars(select(AIJevReviewModel).where(AIJevReviewModel.deleting.is_(True))))
