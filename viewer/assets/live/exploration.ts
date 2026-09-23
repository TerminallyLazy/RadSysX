import { OHIFAdapter } from './ohif.js';
import { ObservationService, DesktopWorkspaceObserver } from './observations.js';
import { request, type DesktopStudyCapture, type ExplorationGrant, type TaskSnapshot, type ShareSelection, type RendererCommand, type ObservationRequest, type RendererBinding } from './protocol.js';

// Derived measurement statistics and panel resizing are not a change of shared images.
export function studyFingerprint(state: Record<string,unknown>): string {
  const keys=['studyId','seriesId','viewportId','index','windowWidth','windowCenter','zoom','panX','panY','rotation','invert','flipHorizontal','flipVertical','layout','viewports'];
  return JSON.stringify(Object.fromEntries(keys.map(key=>[key,state[key]])));
}

/** A renderer lease, never a replay of commands stored in history. */
export class ExplorationController {
  snapshot?: TaskSnapshot;
  working = false;
  private abort?: AbortController;
  private observations?: ObservationService;
  private heartbeat?: ReturnType<typeof setInterval>;
  private polling = false;
  private generation = 0;
  private expected = '';
  private readonly rendererId = `renderer-${crypto.randomUUID()}`;
  private onManual = (event: Event) => {
    if (event.isTrusted && event.target instanceof Element && !event.target.closest('radsysx-live-panel,.radsysx-live-shell') && this.active) void this.takeover();
  };
  constructor(private adapter: OHIFAdapter, private browser: Window, private changed: () => void) {
    for (const type of ['pointerdown','wheel','keydown']) browser.addEventListener(type,this.onManual,true);
  }
  get active(): boolean { return !!this.abort && !this.abort.signal.aborted && ['prepared','running'].includes(this.snapshot?.status ?? ''); }
  get prepared(): boolean { return this.active && this.snapshot?.status === 'prepared' && this.snapshot.activity === 'Ready to share'; }
  private base(): string {
    const grant=this.snapshot!.grant;
    return `/api/ai/sidebar/sessions/${encodeURIComponent(grant.sessionId)}/explorations/${encodeURIComponent(grant.taskId)}`;
  }
  private check(): RendererBinding {
    if (!this.active) throw new Error('Study task stopped.');
    const binding=this.snapshot!.grant.binding, study=this.adapter.studyBinding();
    if (study.studyId!==binding.studyId || binding.seriesIds.some(id=>!study.seriesIds.includes(id))) throw new Error('The shared study changed.');
    return structuredClone(binding);
  }
  contextChanged(): void {
    if (!this.active || this.working) return;
    if (studyFingerprint(this.adapter.context().state)!==this.expected) void this.takeover();
  }
  async prepare(sessionId: string, contextVersion: number, selection: ShareSelection, previous?: TaskSnapshot): Promise<void> {
    await this.stop();
    const generation=++this.generation;
    const binding: RendererBinding={rendererId:this.rendererId,epoch:`epoch-${crypto.randomUUID()}`,contextVersion,revision:0,studyId:selection.studyId,seriesIds:selection.seriesIds};
    this.abort=new AbortController();
    const path=`/api/ai/sidebar/sessions/${encodeURIComponent(sessionId)}/explorations`+(previous?`/${encodeURIComponent(previous.grant.taskId)}/continue`:'');
    const grant=await request<ExplorationGrant>(path,{selection,binding});
    if (generation!==this.generation) { void request(`/api/ai/sidebar/sessions/${encodeURIComponent(sessionId)}/explorations/${encodeURIComponent(grant.taskId)}/stop`,{}).catch(()=>{}); return; }
    this.snapshot={grant,status:'prepared',activity:'Reading series inventory',coverage:[],actions:[],canContinue:false};
    this.adapter.explorationSeries=selection.seriesIds;
    this.observations=new ObservationService(this.adapter,null);
    this.expected=studyFingerprint(this.adapter.context().state);
    this.heartbeat=setInterval(()=>void this.poll(),1500);
    this.changed(); void this.poll();
  }
  async start(): Promise<string> {
    if (!this.prepared) throw new Error('Wait for the shared series inventory.');
    this.check(); return this.snapshot!.grant.taskId;
  }
  async waitUntilPrepared(): Promise<void> {
    const generation = this.generation, deadline = Date.now() + 20000;
    while (generation === this.generation && this.active && !this.prepared && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (generation !== this.generation || !this.prepared) throw new Error('Image inventory could not be loaded. Your question has not been sent.');
  }
  private async poll(): Promise<void> {
    if (!this.active || this.polling) return;
    this.polling=true; const generation=this.generation;
    try {
      const binding=this.check();
      const response=await request<{commands:RendererCommand[]}>(this.base()+'/poll',{binding,waitSeconds:0});
      if (generation!==this.generation || !this.active) return;
      if (!this.working && response.commands.length) void this.execute(response.commands[0]);
      if (!this.working) {
        const snapshot=await request<TaskSnapshot>(this.base());
        if (generation!==this.generation) return;
        this.snapshot=snapshot; this.changed();
        if (!['prepared','running'].includes(snapshot.status)) this.release();
      }
    } catch {
      if (generation!==this.generation) return;
      // A command completion may advance revision while this heartbeat is in flight.
      if (this.working) return;
      try { const snapshot=await request<TaskSnapshot>(this.base()); if(generation===this.generation){this.snapshot=snapshot;this.changed();if(['prepared','running'].includes(snapshot.status))return;} } catch {}
      if (generation===this.generation) { this.release(); this.changed(); }
    } finally { this.polling=false; }
  }
  private async execute(command: RendererCommand): Promise<void> {
    if (this.working || !this.active) return;
    this.working=true; const generation=this.generation, signal=this.abort!.signal;
    let observer: DesktopWorkspaceObserver | undefined;
    try {
      const binding=this.check();
      if (command.expectedRevision!==binding.revision || command.binding.epoch!==binding.epoch || command.binding.rendererId!==binding.rendererId || command.binding.contextVersion!==binding.contextVersion) throw new Error('Stale viewer command.');
      const claimed=await request<RendererCommand>(this.base()+`/commands/${command.operationId}/claim`,{binding});
      this.check(); if(signal.aborted || generation!==this.generation) return;
      const current=()=>{this.check();if(signal.aborted || generation!==this.generation)throw new Error('Study task stopped.');};
      let result: unknown;
      if (command.kind==='manifest') {
        const manifest=await this.observations!.registry.manifest(String(command.args.seriesId),Number(command.args.offset)); current();
        await request(this.base()+`/commands/${command.operationId}/manifest`,{binding,operationId:command.operationId,claimId:claimed.claimId,manifest});
      } else {
        if (command.kind==='observe') {
          const selection=command.args as unknown as ObservationRequest;
          if(selection.kind==='series_frames') result=await this.observations!.observe(selection,binding,signal);
          else {
            try {
              this.assertVisibleScope(binding,selection.kind==='workspace'?undefined:selection.viewportIds.length?selection.viewportIds:[String(this.adapter.context().state.viewportId)]);
              const desktop=(this.browser as any).radsysxDesktop as DesktopStudyCapture;
              if(desktop?.studyCaptureVersion!==1)throw new Error('Desktop observation is unavailable.');
              observer=new DesktopWorkspaceObserver(desktop,{sessionId:this.snapshot!.grant.sessionId,taskId:this.snapshot!.grant.taskId,operationId:command.operationId},b=>this.adapter.registerCaptureSurface(b));
              const observed=await observer.observe(selection,binding,signal); current();
              for(const image of observed.images)if(image.kind==='pane' && image.frameId && image.viewportId)this.adapter.registerMeasurementObservation(image.viewportId,image.frameId,binding.revision);
              result={...observed,revision:binding.revision};
            } catch {
              current();
              result={revision:binding.revision,images:[],failures:(selection.viewportIds.length?selection.viewportIds:[String(this.adapter.context().state.viewportId)]).map(id=>({id,reason:'unsupported'}))};
            }
          }
          current(); result={...(result as object),operationId:command.operationId,claimId:claimed.claimId};
        } else {
          const reading=['viewer_get_state','viewer_get_capabilities'].includes(command.name);
          let permitted=true;
          try { if(!reading)this.assertVisibleScope(binding,[String(command.args.viewportId??this.adapter.context().state.viewportId)]); } catch {permitted=false;}
          try {
            if(!permitted)throw new Error('Selected pane is outside the shared scope.');
            const raw=await this.adapter.execute(command.name,command.args,signal); current();
            const revision=binding.revision+(command.name==='viewer_get_state' || command.name==='viewer_get_capabilities'?0:1);
            result={operationId:command.operationId,claimId:claimed.claimId,status:'completed',beforeRevision:binding.revision,revision,state:{...raw,...(raw.state?{state:this.scopedState(raw.state as Record<string,unknown>,binding)}:this.scopedState(raw,binding))},canUndo:raw.canUndo===true};
          } catch {
            current(); result={operationId:command.operationId,claimId:claimed.claimId,status:!permitted||reading?'failed':'outcome_unknown',beforeRevision:binding.revision,revision:binding.revision, state:{},canUndo:false,error:!permitted||reading?'unavailable':'unknown'};
          }
        }
        current();
        const accepted=await request<{revision?:number}>(this.base()+`/commands/${command.operationId}/result`,{binding,result});
        current(); if(accepted.revision!==undefined)this.snapshot!.grant.binding.revision=accepted.revision;
        if((result as {status?:string}).status==='outcome_unknown'){await this.takeover();return;}
      }
      this.expected=studyFingerprint(this.adapter.context().state);
    } catch {
      if(generation===this.generation && !signal.aborted)void this.takeover();
    } finally { observer?.dispose(); if(generation===this.generation){this.working=false;this.changed();void this.poll();} }
  }
  private scopedState(state:Record<string,unknown>,binding:RendererBinding):Record<string,unknown> {
    return {...state,...(Array.isArray(state.series)?{series:state.series.filter(s=>binding.seriesIds.includes(s.id))}:{}),
      ...(Array.isArray(state.viewports)?{viewports:state.viewports.filter(p=>p.seriesIds?.length&&p.seriesIds.every((id:string)=>binding.seriesIds.includes(id)))}:{})};
  }
  private assertVisibleScope(binding: RendererBinding, viewportIds?:string[]): void {
    const all=this.adapter.context().state.viewports as {id:string;seriesIds?:string[]}[];
    const panes=viewportIds?viewportIds.map(id=>all.find(p=>p.id===id)):all;
    if(!panes?.length || panes.some(p=>!p?.seriesIds?.length || p.seriesIds.some(id=>!binding.seriesIds.includes(id))))throw new Error('A selected pane is outside the shared scope.');
  }
  async decide(operationId:string,approved:boolean): Promise<void> {
    this.check(); await request(this.base()+`/decisions/${encodeURIComponent(operationId)}`,{contextVersion:this.snapshot!.grant.binding.contextVersion,approved}); void this.poll();
  }
  private release(): void {
    this.abort?.abort(); this.abort=undefined; clearInterval(this.heartbeat); this.observations?.dispose(); this.observations=undefined;
    this.adapter.explorationSeries=undefined;this.adapter.clearMeasurementObservations?.();this.adapter.stopReadingActivity?.();
  }
  async stop(kind:'stop'|'takeover'='stop'): Promise<void> {
    const path=this.active?this.base()+'/'+kind:undefined;
    const generation=++this.generation;this.release();this.working=false;this.polling=false;
    if(path)try{const snapshot=await request<TaskSnapshot>(path,{});if(generation===this.generation)this.snapshot=snapshot;}catch{if(generation===this.generation&&this.snapshot)this.snapshot.status='interrupted';}
    this.changed();
  }
  async refresh(): Promise<void> {
    if(!this.snapshot)return;
    const generation=this.generation;
    const snapshot=await request<TaskSnapshot>(this.base());
    if(generation!==this.generation)return;
    this.snapshot=snapshot;
    if(!['prepared','running'].includes(snapshot.status))this.release();
    this.changed();
  }
  async takeover():Promise<void>{await this.stop('takeover');}
  async continueReview(sessionId:string,contextVersion:number):Promise<void>{const previous=this.snapshot;if(previous)await this.prepare(sessionId,contextVersion,previous.grant.scope,previous);}
  dispose():void { void this.stop();for(const type of ['pointerdown','wheel','keydown'])this.browser.removeEventListener(type,this.onManual,true); }
}
