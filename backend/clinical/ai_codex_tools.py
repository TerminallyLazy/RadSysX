"""Scoped dynamic tools. Only receipts survive a Codex image acknowledgment."""
from __future__ import annotations
import asyncio
import json
import re
import time
from dataclasses import dataclass, field
from uuid import uuid4
from fastapi import HTTPException
from pydantic import Field
from .ai_exploration_contracts import Record, Handle, ObservationRequest, Presentation, ObservationResult
from .ai_exploration import identity
from .ai_tools import TOOL_MODELS, DESCRIPTIONS, validate_tool, bound_json
from .contracts import parse_iso_z, utc_now
from .ai_radiology import MetadataRequest, StructureReportRequest, series_metadata, structure_report

READ_TOOLS = {'viewer_get_state','viewer_get_capabilities'}
ACTION_TOOLS = {name for name in TOOL_MODELS if name.startswith('viewer_')} - {'viewer_open_worklist'}
ACTION_TOOLS |= {'report_draft','report_save'}

class ManifestRequest(Record):
    series_id: Handle
    offset: int = Field(default=0, ge=0, le=9999)

class FramesRequest(Record):
    manifest_id: Handle
    frame_ids: list[Handle] = Field(min_length=1,max_length=8)
    presentation: Presentation = Field(default_factory=Presentation)

@dataclass
class DynamicToolResult:
    success: bool
    content_items: list = field(repr=False)
    receipt: dict = field(default_factory=dict)

    @classmethod
    def text(cls, receipt, *, success=True):
        return cls(success,[{'type':'inputText','text':json.dumps(receipt,separators=(',',':'),allow_nan=False)}],receipt)

class CodexToolBridge:
    def __init__(self, exploration, task_id, actor):
        self.service,self.task_id,self.actor=exploration,task_id,actor
        self.records={}
        self.inflight=None
        self.closed=False
        self.lock=asyncio.Lock()
        self.observed={}

    def check(self):
        if self.closed: raise HTTPException(409,'Study exploration stopped.')
        task=self.service.check(self.task_id,self.actor)
        row=self.service.live.repository.owned(task.snapshot.grant.session_id,self.actor,active=True)
        if (task.snapshot.grant.status!='active' or row['modelId']!=task.snapshot.grant.model_id
                or not self.service.live.codex.ready(self.actor.sub)):
            raise HTTPException(409,'Subscription or image scope is no longer authorized.')
        task.budget.check(time.monotonic())
        return task

    def count_call(self):
        task=self.check()
        reservation=task.budget.reserve(images=0,calls=1,encoded_bytes=0,now=time.monotonic())
        task.budget.mark_sent(reservation)

    async def initial_observation(self):
        task = self.check()
        if task.snapshot.grant.scope.kind == 'series':
            manifest, ledger = next(iter(task.ledgers.items()))
            delivered = set(ledger.receipt().delivered)
            frames = [frame for frame, index in ledger.indices.items() if index not in delivered][:8]
            if not frames: frames = list(ledger.indices)[:1]
            result = await self.call('initial-images', 'series_read_frames', {'manifest_id': manifest, 'frame_ids': frames})
        else:
            result = await self.call('initial-images', 'viewer_observe', {'kind': 'workspace'})
        if not result.success or not any(item['type'] == 'inputImage' for item in result.content_items):
            raise HTTPException(409, 'No images could be captured. Nothing was sent to the model; retry sharing.')
        return result

    def delivered_images(self):
        return sum(len(record['receipt'].get('images', [])) for record in self.records.values() if record['acknowledged'])

    def declarations(self):
        task=self.check()
        names=ACTION_TOOLS if 'mutate' in task.snapshot.grant.permissions else READ_TOOLS
        declarations=[{'type':'function','name':name,'description':DESCRIPTIONS[name],
                       'inputSchema':TOOL_MODELS[name].model_json_schema()} for name in sorted(names)]
        for name,model,description in (
            ('series_get_metadata',MetadataRequest,'Get identifier-free technical DICOM metadata from the shared series: modality, frame count, dimensions, pixel spacing in mm and orientation. No image findings or PHI audit.'),
            ('structure_radiology_report',StructureReportRequest,'Structure supplied report text into its literal sections and measurements with exact source offsets. Preserve negation, uncertainty and recommendations; infer no diagnosis. Then use report_draft for a visible unsaved draft.'),
            ('series_get_manifest',ManifestRequest,'Read the complete ordered inventory page of an explicitly shared series. Use its opaque frame IDs; subsequent pages start at offset plus returned frame count.'),
            ('series_read_frames',FramesRequest,'Observe one to eight ordered full frames from a shared manifest. Request every frame for a full-series review. Repeated deliveries consume budget. Image acknowledgment is delivery, not diagnostic validation.'),
            ('viewer_observe',ObservationRequest,'Observe the shared reading workspace or selected visible panes. This is the only current screen awareness. Pane frameId plus revision authorizes geometry on that pane; refresh after any change.')):
            if name == 'series_read_frames' and task.snapshot.grant.scope.kind != 'series':
                continue
            declarations.append({'type':'function','name':name,'description':description,'inputSchema':model.model_json_schema(by_alias=True)})
        return declarations

    def geometry(self,name,args,task):
        needs=(name=='viewer_calibrate' or (name in {'viewer_measurement','viewer_segmentation'} and bool(args.get('points')))
               or (name=='viewer_region' and not args.get('close')) or name=='viewer_set_crosshair')
        if not needs: return
        # Crosshair uses calibrated world geometry and is also bound to a current observation.
        current=self.observed.get(args.get('frameId'))
        if not current or args.get('revision')!=task.snapshot.grant.binding.revision or current!= (args.get('viewportId'),args.get('revision')):
            raise HTTPException(409,'Observe and acknowledge the current pane before using its geometry.')

    async def call(self,call_id,name,arguments):
        self.count_call()
        if not isinstance(call_id,str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,128}',call_id): raise ValueError('Invalid call identity')
        digest=identity({'name':name,'arguments':bound_json(arguments,16384)})
        async with self.lock:
            task=self.check()
            old=self.records.get(call_id)
            if old:
                if old['identity']!=digest: raise ValueError('Call identity changed')
                return DynamicToolResult.text({**old['receipt'],**({'pixelsUnavailable':True} if old['image'] else {})},success=old['success'])
            operation='op-'+uuid4().hex
            record={'identity':digest,'operation':operation,'receipt':{'status':'outcome_unknown'},'success':False,'image':False,'submitted':False,'acknowledged':False}
            self.records[call_id]=record
            if name=='structure_radiology_report':
                args=StructureReportRequest.model_validate(arguments)
                result=DynamicToolResult.text(structure_report(args.text))
            elif name=='series_get_metadata':
                args=MetadataRequest.model_validate(arguments)
                pages=next((p for p in task.manifests.values() if p[0]['seriesId']==args.series_id),None)
                if not pages: raise ValueError('Series is outside the shared inventory')
                result=DynamicToolResult.text(series_metadata(pages))
            elif name=='series_get_manifest':
                args=ManifestRequest.model_validate(arguments)
                pages=next((p for p in task.manifests.values() if p[0]['seriesId']==args.series_id),None)
                page=next((p for p in pages or [] if p['offset']==args.offset),None)
                if not page: raise ValueError('Unknown inventory page')
                result=DynamicToolResult.text(page)
            elif name in {'viewer_observe','series_read_frames'}:
                if self.inflight: raise HTTPException(409,'Wait for the previous image acknowledgment.')
                if name=='series_read_frames':
                    args=FramesRequest.model_validate(arguments)
                    request=ObservationRequest(kind='series_frames',**args.wire())
                else:
                    request=ObservationRequest.model_validate(arguments)
                    if request.kind=='series_frames': raise ValueError('Use series_read_frames')
                if task.budget.images+len(request.frame_ids)>128: raise HTTPException(409,'Image budget reached. Continue explicitly in a new run.')
                record['image']=True
                observed=await self.service.dispatch(self.task_id,operation,name,request.wire(),self.actor,kind='observe')
                task=self.check()
                if not isinstance(observed,ObservationResult): raise ValueError('Fresh pixels unavailable')
                reservation=task.budget.reserve(images=len(observed.images),calls=0,encoded_bytes=sum(len(i.data) for i in observed.images),now=time.monotonic())
                task.budget.mark_sent(reservation)
                receipt={'operationId':operation,'revision':observed.revision,'images':[i.receipt() for i in observed.images],'failures':[f.wire() for f in observed.failures],'status':'captured'}
                result=DynamicToolResult.text(receipt,success=bool(observed.images))
                result.content_items.extend(i.input_item() for i in observed.images)
                record['manifest']=request.manifest_id
                record['frames']=[i.frame_id for i in observed.images if i.kind=='frame']
                if request.manifest_id:
                    ledger=task.ledgers[request.manifest_id]
                    ledger.captured(record['frames'])
                    ledger.failed([f.id for f in observed.failures],'render_failed')
                self.inflight=(call_id,result)
                self.service.persist(task)
            elif name in ACTION_TOOLS:
                if name not in READ_TOOLS and 'mutate' not in task.snapshot.grant.permissions: raise HTTPException(403,'Viewer tools were not granted.')
                args=validate_tool(name,arguments)
                self.geometry(name,args,task)
                if name=='viewer_open_series' and args.get('displaySetId') not in task.snapshot.grant.scope.series_ids: raise HTTPException(403,'Series is outside the shared scope.')
                grant=task.snapshot.grant
                if name in READ_TOOLS:
                    receipt=await self.service.dispatch(self.task_id,operation,name,args,self.actor)
                else:
                    broker=self.service.live.actions
                    tool,_=broker.prepare(grant.session_id,operation,name,args,self.actor,context_version=grant.binding.context_version,grant=grant.grant_id)
                    if tool['status']=='awaiting_approval':
                        task.snapshot.actions.append({'operationId':operation,'name':name,'kind':'action','status':'awaiting_approval','args':args,'expiresAt':tool['expiresAt']})
                        task.snapshot.actions=task.snapshot.actions[-64:]; self.service.persist(task)
                        while tool['status']=='awaiting_approval':
                            self.check()
                            if parse_iso_z(tool['expiresAt'])<=utc_now():
                                self.service.live.repository.set_tool(grant.session_id,operation,'cancelled'); break
                            await asyncio.sleep(0.2)
                            tool=self.service.live.repository.tool(grant.session_id,operation)
                    def check_action():
                        self.check()
                        return broker.require(grant.session_id,self.actor,grant.binding.context_version)
                    receipt=await broker.execute(grant.session_id,operation,self.actor,check=check_action,
                        dispatch=lambda op,n,a:self.service.dispatch(self.task_id,op,n,a,self.actor),grant=grant.grant_id)
                self.check()
                self.service.action_status(task,operation,receipt.get('status','completed'))
                self.service.persist(task)
                result=DynamicToolResult.text(receipt,success=receipt.get('status') not in {'failed','outcome_unknown','cancelled','denied'})
            else: raise ValueError('Unknown study tool')
            if name in {'series_get_metadata', 'structure_radiology_report'}:
                task.snapshot.actions.append({'operationId': operation, 'name': name, 'kind': 'read', 'status': 'completed'})
                task.snapshot.actions = task.snapshot.actions[-64:]
                self.service.persist(task)
            record.update(receipt=result.receipt,success=result.success)
            return result

    def submitted(self,call_id):
        task=self.check()
        record=self.records.get(call_id)
        if not record or not record['image'] or record['submitted']: return
        record['submitted']=True; record['receipt']['status']='submitted'
        self.service.action_status(task,record['operation'],'submitted')
        if record.get('manifest'):
            task.ledgers[record['manifest']].submitted(record['operation'],record['frames'],'frame')
        self.service.persist(task)

    def acknowledge(self,call_id):
        if self.closed: return
        record=self.records.get(call_id)
        if not record or not record['submitted'] or record['acknowledged']: return
        try: task=self.check()
        except (ValueError,HTTPException): self.close(); return
        record['acknowledged']=True; record['receipt']['status']='acknowledged'
        self.service.action_status(task,record['operation'],'delivered')
        if record.get('manifest'): task.ledgers[record['manifest']].acknowledge(record['operation'])
        for image in record['receipt'].get('images',[]):
            if image['kind']=='pane' and image.get('frameId') and image.get('viewportId'):
                self.observed[image['frameId']]=(image['viewportId'],record['receipt']['revision'])
        if self.inflight and self.inflight[0]==call_id:
            self.inflight[1].content_items.clear(); self.inflight=None
        self.service.persist(task)

    def close(self):
        self.closed=True; self.observed.clear()
        if self.inflight: self.inflight[1].content_items.clear(); self.inflight=None
