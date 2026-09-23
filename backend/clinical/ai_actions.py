"""Transport-independent authority for reviewed, idempotent native viewer actions."""
from __future__ import annotations
import asyncio
import re
from fastapi import HTTPException
from .ai_repository import TERMINAL_TOOLS
from .ai_tools import validate_tool, requires_approval, bound_json, safe_state
from .contracts import ReportDraftRequest, parse_iso_z, utc_now


class ActionBroker:
    def __init__(self, live):
        self.live, self.repo = live, live.repository
        self.locks = {}
        self.mutation_owners = {}

    def lock(self, actor):
        return self.locks.setdefault(actor.sub, asyncio.Lock())

    def claim_viewer(self, actor, grant_id):
        if self.lock(actor).locked() or self.mutation_owners.get(actor.sub) not in (None, grant_id):
            raise HTTPException(409, 'Another task is changing this viewer.')
        self.mutation_owners[actor.sub] = grant_id

    def release_viewer(self, actor, grant_id):
        if self.mutation_owners.get(actor.sub) == grant_id: self.mutation_owners.pop(actor.sub, None)

    def require(self, session_id, actor, context_version=None):
        self.live.require_research_settings(actor)
        row = self.repo.owned(session_id, actor, active=True)
        if not row['attestation'] or row['status'] in {'closed','interrupted'} or (context_version is not None and row['contextVersion'] != context_version):
            raise HTTPException(409, 'AI context is no longer authorized.')
        return row

    def prepare(self, session_id, call_id, name, args, actor, *, context_version, grant=None):
        row = self.require(session_id, actor, context_version)
        if not isinstance(call_id,str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,128}',call_id):
            raise ValueError('Invalid tool call identity')
        args = validate_tool(name, args)
        bound_json(args)
        tool, fresh = self.repo.add_tool(session_id,call_id,name,args,context_version,requires_approval(name,args),
                                        approval_seconds=120 if grant else 300)
        if not fresh and (tool['contextVersion'] != context_version or tool['name'] != name or tool['args'] != args):
            raise HTTPException(409, 'Tool call identity belongs to another request.')
        if fresh: self.live.audit(row, actor, f'{session_id}:{call_id}')
        return tool, fresh

    def decide(self, session_id, call_id, decision, actor, *, grant=None):
        self.require(session_id, actor, decision.context_version)
        tool = self.repo.tool(session_id,call_id)
        if tool['contextVersion'] != decision.context_version or tool['status'] != 'awaiting_approval' or parse_iso_z(tool['expiresAt']) <= utc_now():
            raise HTTPException(409, 'Approval expired or belongs to another context.')
        return self.repo.set_tool(session_id,call_id,'pending' if decision.approved else 'denied')

    async def execute(self, session_id, call_id, actor, *, check, dispatch, grant=None):
        self.require(session_id, actor)
        async with self.lock(actor):
            tool = self.repo.tool(session_id,call_id)
            if tool['status'] in TERMINAL_TOOLS: return tool['result'] or {'status':tool['status']}
            if tool['status'] == 'awaiting_approval': raise HTTPException(409,'Review this exact proposal before execution.')
            if tool['status'] not in {'pending','running'}: raise HTTPException(409,'Action unavailable.')
            dispatched = False
            try:
                row = check()
                self.require(session_id,actor,tool['contextVersion'])
                if self.mutation_owners.get(actor.sub) not in (None, grant):
                    raise HTTPException(409,'Another task owns viewer tools. Take over or finish it first.')
                self.repo.set_tool(session_id,call_id,'running')
                if tool['name'] == 'report_save':
                    if 'report.write' not in actor.scopes: raise HTTPException(403,'Report write permission required.')
                    uid = row['viewerContext'].get('studyInstanceUID')
                    if not uid or not self.live.clinical_repository.get_worklist_row(uid):
                        raise HTTPException(409,'Import or associate this local study through the worklist before saving a report.')
                    record = self.live.clinical.save_report(ReportDraftRequest(studyInstanceUID=uid,
                        findingsSummary=tool['args']['findings'], impression=tool['args']['impression']),actor=actor,source_ip='ai-sidebar')
                    result = {'reportId':record.report_id,'status':'draft_saved'}
                else:
                    dispatched = True
                    raw = bound_json(await dispatch(call_id,tool['name'],tool['args']),32768)
                    check()
                    result = safe_state(raw)
                    if 'result' in raw: result['result'] = safe_state(raw['result'])
                    if raw.get('error'): result = {'status':'failed','message':'The native tool could not complete.'}
                current = self.repo.tool(session_id,call_id)
                if current['status'] in TERMINAL_TOOLS: return current['result'] or {'status':current['status']}
                status = 'failed' if result.get('status') == 'failed' else 'outcome_unknown' if result.get('status') == 'outcome_unknown' else 'completed'
                self.repo.set_tool(session_id,call_id,status,result)
                return result
            except asyncio.CancelledError:
                self.repo.set_tool(session_id,call_id,'outcome_unknown' if dispatched else 'cancelled')
                raise
            except Exception as error:
                status = 'outcome_unknown' if dispatched else 'failed'
                message = 'No valid completion receipt. The action was not retried.' if dispatched else error.detail if isinstance(error,HTTPException) else 'The native tool could not complete.'
                result = {'status':status,'message':message}
                self.repo.set_tool(session_id,call_id,status,result)
                return result
