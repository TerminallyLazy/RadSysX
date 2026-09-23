"""Receipt-only study task persistence; executable leases are never restored."""
import copy
from sqlalchemy import select, delete
from fastapi import HTTPException
from .models import AIExplorationModel
from .ai_exploration_contracts import TaskSnapshot

TERMINAL = {'completed','failed','cancelled','interrupted','paused'}

class ExplorationRepository:
    def __init__(self, clinical): self.factory=clinical._session_factory

    def save(self, snapshot, owner, *, manifests, turn_id=None):
        payload={'snapshot':snapshot.wire(),'manifests':manifests,'turnId':turn_id}
        with self.factory() as db:
            row=db.get(AIExplorationModel,snapshot.grant.task_id)
            if row is None:
                row=AIExplorationModel(id=snapshot.grant.task_id,owner=owner,session_id=snapshot.grant.session_id,status=snapshot.status,payload_json=payload)
                db.add(row)
            else:
                if row.owner!=owner: raise HTTPException(404,'Study task not found.')
                row.status=snapshot.status; row.payload_json=payload
            db.commit()

    def owned(self, task_id, actor):
        with self.factory() as db:
            row=db.get(AIExplorationModel,task_id)
            if row is None or row.owner!=actor.sub: raise HTTPException(404,'Study task not found.')
            return copy.deepcopy(row.payload_json)

    def recover(self):
        with self.factory() as db:
            for row in db.scalars(select(AIExplorationModel).where(AIExplorationModel.status.not_in(TERMINAL))):
                data=copy.deepcopy(row.payload_json)
                state=data['snapshot']; state['status']='interrupted'; state['grant']['status']='revoked'; state['activity']=None
                for action in state['actions']:
                    if action['status'] in {'pending','claimed'}:
                        action['status']='outcome_unknown' if action['status']=='claimed' and action['kind']=='action' else 'interrupted'
                row.status='interrupted'; row.payload_json=data
            db.commit()

    def delete_source(self, session_id):
        with self.factory() as db:
            db.execute(delete(AIExplorationModel).where(AIExplorationModel.session_id==session_id)); db.commit()
