import { isDeepStrictEqual } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { assertDesktopSender, validatedRectangle } from './live-capture.mjs';
const LEASE_MS = 15000;
const TOKEN = /^[A-Za-z0-9._:-]{1,200}$/;
const same = isDeepStrictEqual;
function strict(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key=>!keys.includes(key))) throw new Error('Invalid study capture request.');
}
function token(value) { if (typeof value !== 'string' || !TOKEN.test(value)) throw new Error('Invalid study capture identity.'); }
function overlaps(a,b) { return a.x < b.x+b.width && b.x < a.x+a.width && a.y < b.y+b.height && b.y < a.y+a.height; }

/** Fixed app-owned DOM regions. No input can supply selectors or executable code. */
export async function readStudySurface(contents) {
  return contents.executeJavaScript(`(() => {
    const grid = document.querySelector('[data-cy="viewport-grid"][data-radsysx-study]');
    if (!grid) return null;
    const rect = el => { const r=el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; };
    const visible = el => {const s=getComputedStyle(el),r=rect(el);return !el.hidden && s.visibility!=='hidden' && s.display!=='none' && r.width>0 && r.height>0;};
    const sensitive = [...document.querySelectorAll('[data-role="credentials"], [role="dialog"], dialog[open], input[type="password"]')].some(visible);
    const excluded = [...document.querySelectorAll('.radsysx-live-shell, radsysx-workspace-panel')].filter(visible).map(rect);
    const panes = [...grid.querySelectorAll('[data-viewportid]')].filter(el=>el.querySelector('canvas')).map(el=>({
      id:el.dataset.radsysxViewport, studyId:el.dataset.radsysxStudy, seriesIds:JSON.parse(el.dataset.radsysxSeries||'[]'),
      visible:visible(el),rect:rect(el),presentation:JSON.parse(el.dataset.radsysxPresentation||'{}')
    }));
    return {studyId:grid.dataset.radsysxStudy, rendererId:grid.dataset.radsysxRenderer, epoch:grid.dataset.radsysxEpoch,
      revision:Number(grid.dataset.radsysxRevision), settingsOpen:sensitive, excluded,
      rect:rect(grid),bounds:{width:innerWidth,height:innerHeight},panes};
  })()`);
}

export class StudyCapture {
  constructor({getWindow,getOrigin,getTask,getSurface=readStudySurface,now=Date.now}) {
    Object.assign(this,{getWindow,getOrigin,getTask,getSurface,now});this.leases=new Map();
  }
  sender(event,viewerOnly=true) { assertDesktopSender(event,this.getWindow()?.webContents,this.getOrigin(),viewerOnly); }
  revoke(contents) { if(contents)this.leases.delete(contents.id);else this.leases.clear(); }
  async validate(event,input) {
    this.sender(event);
    const task=await this.getTask(event.sender,input.sessionId,input.taskId);
    this.sender(event);
    const grant=task?.grant,session=task?.session;
    if (!grant || grant.taskId!==input.taskId || grant.sessionId!==input.sessionId || grant.status!=='active' || task.status!=='running' ||
      !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt)<=this.now() || !same(grant.binding,input.binding) || !grant.permissions?.includes('observe') ||
      !['synthetic','deidentified'].includes(session?.attestation) || session.status!=='ready' || session.contextVersion!==input.binding.contextVersion || session.viewerContext?.captureTarget!=='viewer') throw new Error('Study capture requires a current attested task.');
    const surface=await this.getSurface(event.sender);this.sender(event);
    if (!surface || surface.settingsOpen) throw new Error('Close sensitive settings before sharing the reading view.');
    if (surface.studyId!==grant.scope.studyId || surface.rendererId!==input.binding.rendererId || surface.epoch!==input.binding.epoch || surface.revision!==input.binding.revision ||
        !Array.isArray(surface.panes) || !surface.panes.length || surface.panes.length>16) throw new Error('The shared reading view changed.');
    const rect=validatedRectangle(surface.rect,surface.rect,surface.bounds);
    if((surface.excluded??[]).some(excluded=>overlaps(rect,excluded))) throw new Error('The reading view is covered by an excluded panel.');
    for(const pane of surface.panes) {
      token(pane.id);
      if(pane.visible===false || !pane.seriesIds.length) throw new Error('Visible pane inventory is unavailable.');
      if(grant.scope.kind==='entire_view' && (pane.studyId!==grant.scope.studyId || pane.seriesIds.some(id=>!grant.scope.seriesIds.includes(id)))) throw new Error('Visible panes are outside the shared scope.');
      const p=validatedRectangle(pane.rect,pane.rect,surface.bounds);
      if(p.x<rect.x || p.y<rect.y || p.x+p.width>rect.x+rect.width || p.y+p.height>rect.y+rect.height)throw new Error('Pane is outside the reading workspace.');
    }
    if(new Set(surface.panes.map(p=>p.id)).size!==surface.panes.length)throw new Error('Invalid visible pane inventory.');
    return {task,surface};
  }
  async start(event,input) {
    strict(input,['sessionId','taskId','binding']);token(input.sessionId);token(input.taskId);
    strict(input.binding,['rendererId','epoch','contextVersion','revision','studyId','seriesIds']);
    const {surface}=await this.validate(event,input);
    const lease={...structuredClone(input),leaseId:randomUUID(),expiresAt:this.now()+LEASE_MS,pending:false,surface};
    this.leases.set(event.sender.id,lease);return {leaseId:lease.leaseId,expiresAt:lease.expiresAt};
  }
  stop(event,input={}) {
    this.sender(event,false);strict(input,['leaseId']);
    const lease=this.leases.get(event.sender.id);if(!input.leaseId || lease?.leaseId===input.leaseId)this.revoke(event.sender);
    return {stopped:true};
  }
  async capture(event,input) {
    this.sender(event);strict(input,['leaseId','operationId','kind','viewportIds']);token(input.leaseId);token(input.operationId);
    if(!['workspace','panes'].includes(input.kind) || !Array.isArray(input.viewportIds) || input.viewportIds.length>8 || new Set(input.viewportIds).size!==input.viewportIds.length)throw new Error('Invalid study capture selection.');
    input.viewportIds.forEach(token);
    const lease=this.leases.get(event.sender.id);
    const check=()=>{this.sender(event);if(this.leases.get(event.sender.id)!==lease || !lease || lease.expiresAt<=this.now())throw new Error('Study capture has stopped.');};
    check();if(lease.pending)throw new Error('Study capture is already running.');lease.pending=true;
    try {
      const {task,surface}=await this.validate(event,lease);check();
      if(!same(surface,lease.surface))throw new Error('The reading view changed.');
      if(!task.actions.some(a=>a.operationId===input.operationId && a.kind==='observe' && a.status==='claimed'))throw new Error('Capture operation is not claimed.');
      if(input.kind==='workspace' && task.grant.scope.kind!=='entire_view')throw new Error('The reading overview was not shared.');
      const inScope=p=>p && p.studyId===task.grant.scope.studyId && p.seriesIds.every(id=>task.grant.scope.seriesIds.includes(id));
      const panes=input.viewportIds.length?input.viewportIds.map(id=>surface.panes.find(p=>p.id===id)):surface.panes.filter(inScope);
      if(!panes.length || panes.some(p=>!inScope(p)))throw new Error('Selected panes are outside the shared scope.');
      if(panes.some(p=>!p) || panes.length+(input.kind==='workspace'?1:0)>8)throw new Error('Choose a bounded group of visible panes.');
      const regions=[...(input.kind==='workspace'?[{kind:'overview',rect:surface.rect,presentation:{}}]:[]),...panes.map(p=>({...p,kind:'pane'}))];
      const images=[];let bytes=0;
      for(const region of regions) {
        check();const zoom=event.sender.getZoomFactor?.()??1;
        if(!Number.isFinite(zoom)||zoom<=0||zoom>10)throw new Error('Invalid viewer zoom.');
        const clipped=validatedRectangle(region.rect,region.rect,surface.bounds);
        const crop=Object.fromEntries(Object.entries(clipped).map(([key,value])=>[key,Math.round(value*zoom)]));
        let picture=await event.sender.capturePage(crop);check();
        const after=await this.validate(event,lease);check();
        if(!same(after.surface,surface) || !(after.task.actions.some(a=>a.operationId===input.operationId && a.kind==='observe' && a.status==='claimed')))throw new Error('The reading view changed during capture.');
        if(picture.isEmpty())throw new Error('The reading view did not produce an image.');
        const original=picture.getSize();
        if(!Number.isInteger(original.width)||!Number.isInteger(original.height)||original.width<1||original.height<1||original.width>65535||original.height>65535)throw new Error('Invalid image dimensions.');
        const ratio=Math.min(1,2048/original.width,2048/original.height);
        if(ratio<1)picture=picture.resize({width:Math.max(1,Math.round(original.width*ratio)),height:Math.max(1,Math.round(original.height*ratio))});
        let jpeg,data;
        for(const quality of [90,80,70]) {jpeg=picture.toJPEG(quality);data=jpeg.toString('base64');if(data.length<=1024*1024)break;}
        bytes+=data.length;if(data.length>1024*1024 || bytes>8*1024*1024)throw new Error('The reading view exceeds the image budget.');
        const size=picture.getSize();
        images.push({imageId:'image-'+randomUUID(),kind:region.kind,...(region.id?{viewportId:region.id,frameId:'frame-'+randomUUID()}:{}),data,
          width:size.width,height:size.height,originalWidth:original.width,originalHeight:original.height,crop:[crop.x,crop.y,crop.width,crop.height],
          presentation:region.presentation??{},capturedAt:new Date(this.now()).toISOString(),sha256:createHash('sha256').update(jpeg).digest('hex')});
      }
      check();lease.expiresAt=this.now()+LEASE_MS;return {images,failures:[]};
    } catch {this.revoke(event.sender);throw new Error('Study capture failed or the shared view changed.');}
    finally {lease.pending=false;}
  }
}
