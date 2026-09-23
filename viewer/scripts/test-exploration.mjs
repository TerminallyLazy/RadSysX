import test from 'node:test';
import assert from 'node:assert/strict';
import { buildManifest, SeriesRegistry } from '../.cache/live-runtime/series.js';
import { ObservationService } from '../.cache/live-runtime/observations.js';

const frames = (count=34) => Array.from({length:count},(_,index)=>({imageId:`wadouri:PRIVATE_PATH?frame=${index}`,index,rows:64,columns:64,position:[0,0,index],spacing:[0.7,1.2],timeIndex:Math.floor(index/17),sliceIndex:index%17}));
const binding = {rendererId:'renderer-1',epoch:'epoch-1',contextVersion:1,revision:0,studyId:'study-1',seriesIds:['series-1']};
function adapter() {
  let data=frames(); let active={studyId:'study-1',seriesIds:['series-1']};
  return {studyBinding:()=>active,seriesFrames:()=>({studyId:'study-1',seriesId:'series-1',modality:'CT',frames:data,complete:true}),
    change:()=>{data=[...data].reverse().map((f,index)=>({...f,index}));}, other:()=>{active={studyId:'study-2',seriesIds:['series-2']};},
    presentation:()=>({windowWidth:400,windowCenter:40})};
}
test('complete manifest retains display ordering and temporal frames without private IDs',async()=>{
  const a=await buildManifest('study-1','series-1',frames());
  assert.equal(a.frameCount,34); assert.equal(a.frames[33].index,33); assert.equal(a.frames[33].timeIndex,1);
  assert.doesNotMatch(JSON.stringify(a),/PRIVATE_PATH|wadouri|frame=/);
  assert.equal(a.manifestId,(await buildManifest('study-1','series-1',frames())).manifestId);
  assert.notEqual(a.manifestId,(await buildManifest('study-1','series-1',frames(33))).manifestId);
  await assert.rejects(buildManifest('study-1','series-1',[{...frames(1)[0],spacing:[0,1]}]));
});
test('registry pages full inventory, rejects another study and invalidates reordered handles',async()=>{
  const host=adapter(); const registry=new SeriesRegistry(host); const a=await registry.manifest('series-1');
  assert.match(registry.resolve(a.frames[33].id),/frame=33/);
  host.change(); const b=await registry.manifest('series-1'); assert.notEqual(a.manifestId,b.manifestId);
  assert.throws(()=>registry.resolve(a.frames[0].id));
  host.other(); await assert.rejects(registry.manifest('series-1'));
  registry.invalidate(); assert.throws(()=>registry.resolve(b.frames[0].id));
});
test('bounded observations never advance the visible reader and report a failed late frame',async()=>{
  const host=adapter(); const registry=new SeriesRegistry(host); const manifest=await registry.manifest('series-1');
  let current, disposed=false; const calls=[];
  const renderer={async setFrame(id){current=id;calls.push(id);if(id.endsWith('=33')) throw Error('private loader failure');},async waitForRendered(id){assert.equal(id,current);},async encodeJpeg(){return {data:btoa('synthetic'),width:64,height:64};},geometry:()=>({rows:64,columns:64,presentation:{}}),dispose(){disposed=true;}};
  const service=new ObservationService(host,null,{registry,renderer});
  const request={kind:'series_frames',manifestId:manifest.manifestId,frameIds:[manifest.frames[0].id,manifest.frames[33].id],viewportIds:[],presentation:{}};
  const result=await service.observe(request,binding,new AbortController().signal);
  assert.equal(result.images.length,1);assert.equal(result.images[0].index,0);assert.equal(result.failures[0].id,manifest.frames[33].id);
  assert.equal(calls.length,2);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_PATH|private loader/);
  service.dispose();assert.equal(disposed,true);
});
test('abort during decode and changed study prevent any pixel result',async()=>{
  const host=adapter();const registry=new SeriesRegistry(host);const manifest=await registry.manifest('series-1');
  const abort=new AbortController();let encoded=0;
  const renderer={async setFrame(){abort.abort();},async waitForRendered(){},async encodeJpeg(){encoded++;return {data:'AA==',width:1,height:1};},geometry:()=>({rows:1,columns:1,presentation:{}}),dispose(){}};
  const service=new ObservationService(host,null,{registry,renderer});
  const request={kind:'series_frames',manifestId:manifest.manifestId,frameIds:[manifest.frames[0].id],viewportIds:[],presentation:{}};
  await assert.rejects(service.observe(request,binding,abort.signal));assert.equal(encoded,0);
  host.other();await assert.rejects(service.observe(request,binding,new AbortController().signal));service.dispose();
});

test('a reordered inventory is stale even before another manifest request',async()=>{
  const host=adapter(),registry=new SeriesRegistry(host);const manifest=await registry.manifest('series-1');
  host.change();assert.throws(()=>registry.resolve(manifest.frames[0].id));
});
test('manifest pages are bounded while preserving the full frame count',async()=>{
  const host=adapter();host.seriesFrames=()=>({studyId:'study-1',seriesId:'series-1',modality:'CT',frames:frames(600),complete:true});
  const registry=new SeriesRegistry(host);const first=await registry.manifest('series-1');
  assert.equal(first.frameCount,600);assert.ok(first.frames.length<=256);
  const next=await registry.manifest('series-1',first.frames.length);
  assert.equal(next.manifestId,first.manifestId);assert.equal(next.frames[0].index,first.frames.length);
  host.seriesFrames=()=>({studyId:'study-1',seriesId:'series-1',modality:'CT',frames:frames(5),complete:false});
  await assert.rejects(registry.manifest('series-1'));
});
test('wrong rendered frame, unsupported orientation and oversized encoding produce failures',async()=>{
  for(const failure of ['render','orientation','size']) {
    const host=adapter(),registry=new SeriesRegistry(host),manifest=await registry.manifest('series-1');let encodes=0;
    const renderer={async setFrame(id,presentation){if(presentation.orientation==='coronal')throw Error('unsupported');},async waitForRendered(){if(failure==='render')throw Error('wrong image');},async encodeJpeg(){encodes++;return {data:'A'.repeat(1024*1024+1),width:64,height:64};},geometry:()=>({rows:64,columns:64,presentation:{}}),dispose(){}};
    const service=new ObservationService(host,null,{registry,renderer});
    const result=await service.observe({kind:'series_frames',manifestId:manifest.manifestId,frameIds:[manifest.frames[0].id],viewportIds:[],presentation:failure==='orientation'?{orientation:'coronal'}:{}},binding,new AbortController().signal);
    assert.equal(result.images.length,0);assert.equal(result.failures.length,1);assert.equal(encodes,failure==='size'?1:0);service.dispose();
  }
});

test('capability registry rejects arbitrary commands and disabled reading controls',async()=>{
  const {capabilities}=await import('../.cache/live-runtime/capabilities.js');
  const {executeReadingTool}=await import('../.cache/live-runtime/reading-tools.js');
  const calls=[];
  const host={readingAvailability:name=>({available:name!=='viewer_set_cine',reason:'No temporal frames'}),async performReadingTool(name,args){calls.push([name,args]);return {state:{index:2},canUndo:true};}};
  const result=capabilities(host);assert.ok(result.every(item=>typeof item.available==='boolean'));
  assert.equal(result.find(item=>item.name==='viewer_set_cine').available,false);
  await assert.rejects(executeReadingTool(host,'runCommand',{name:'anything'},new AbortController().signal));
  await assert.rejects(executeReadingTool(host,'viewer_set_cine',{playing:true,fps:20},new AbortController().signal));
  await assert.rejects(executeReadingTool(host,'viewer_set_view',{zoom:Infinity},new AbortController().signal));
  await executeReadingTool(host,'viewer_select_viewport',{viewportId:'viewport-1'},new AbortController().signal);
  assert.equal(calls.length,1);
});

async function readingFixture(){
  const {OHIFAdapter}=await import('../.cache/live-runtime/ohif.js');
  let active='native-a',index=0;const cines={};const memos=[];
  const displays=[{displaySetInstanceUID:'private-series',StudyInstanceUID:'private-study',Modality:'CT',numImageFrames:34,isReconstructable:false},{displaySetInstanceUID:'private-other',StudyInstanceUID:'other-study',Modality:'CT',numImageFrames:3}];
  const grid=new Map([['native-a',{displaySetInstanceUIDs:['private-series']}],['native-b',{displaySetInstanceUIDs:['private-other']}]]);
  const pane={id:'native-a',element:{clientWidth:64,clientHeight:64,querySelectorAll:()=>[]},getImageIds:()=>Array(34).fill('private'),getCurrentImageIdIndex:()=>index,getProperties:()=>({}),getCamera:()=>({}),render(){},getPan:()=>[0,0],getZoom:()=>1,setProperties(){},setCamera(){}};
  const cine={getState:()=>({cines}),setIsCineEnabled(){},setCine({id,isPlaying,frameRate}){cines[id]={isPlaying,frameRate};},stopClip(){}};
  const services={viewportGridService:{getActiveViewportId:()=>active,setActiveViewportId:id=>active=id,getState:()=>({viewports:grid,layout:{numRows:1,numCols:2}})},cornerstoneViewportService:{getCornerstoneViewport:id=>id==='native-a'?pane:{...pane,id}},displaySetService:{activeDisplaySets:displays},measurementService:{getMeasurements:()=>[]},segmentationService:{getSegmentations:()=>[]},cineService:cine,hangingProtocolService:{getProtocolById:()=>({id:'mpr'})}};
  const browser={location:{pathname:'/viewer/local'},document:{addEventListener(){},removeEventListener(){},querySelector(){return null;}}};
  const managers={servicesManager:{services},extensionManager:{getModuleEntry:()=>({exports:{getCornerstoneLibraries:()=>({cornerstone:{utilities:{HistoryMemo:{DefaultHistoryMemo:{push:one=>memos.push(one)}}}},cornerstoneTools:{}})}})},commandsManager:{runCommand(name,args){if(name==='jumpToImage')index=args.imageIndex;}}};
  const adapter=new OHIFAdapter(browser);adapter.bind(managers);return {adapter,services,pane,displays,cines,memos,changeStudy(){active='native-b';}};
}
test('native reading dispatch validates pane study, MPR geometry and stops owned cine',async()=>{
  const f=await readingFixture();assert.equal(f.adapter.readingAvailability('viewer_set_mpr').available,false);
  await assert.rejects(f.adapter.execute('viewer_set_mpr',{layout:'mpr'}));
  await f.adapter.execute('viewer_jump_to_slice',{index:33});assert.equal(f.adapter.context().state.index,33);
  const other=f.adapter.context().state.viewports[1].id;
  await assert.rejects(f.adapter.execute('viewer_select_viewport',{viewportId:other}),/outside/);
  await f.adapter.execute('viewer_set_cine',{playing:true,fps:12});assert.equal(f.cines['native-a'].isPlaying,true);
  f.adapter.stopReadingActivity();assert.equal(f.cines['native-a'].isPlaying,false);
});
test('manual case change during an awaited native action prevents a success receipt',async()=>{
  const f=await readingFixture();f.adapter.browser.requestAnimationFrame=fn=>setTimeout(()=>{f.changeStudy();fn();},0);
  await assert.rejects(f.adapter.execute('viewer_select_viewport',{viewportId:f.adapter.context().state.viewportId}),/study changed/);
});

test('a native no-op cannot become a completed zoom action',async()=>{
  const f=await readingFixture();f.pane.setZoom=()=>{};
  await assert.rejects(f.adapter.execute('viewer_set_view',{zoom:2}),/settle/);
});

test('cine refuses native synchronization into another study',async()=>{
  const f=await readingFixture();
  f.services.cineService.getSyncedViewports=()=>[{viewportId:'native-b'}];
  await assert.rejects(f.adapter.execute('viewer_set_cine',{playing:true}),/outside/);
  assert.equal(f.cines['native-a'],undefined);
});
test('fusion rejects a layer absent from the selected pane before changing presentation',async()=>{
  const f=await readingFixture(); f.adapter.readingAvailability=()=>({available:true});
  const other=f.adapter.context().state.series[1].id;
  await assert.rejects(f.adapter.execute('viewer_set_fusion',{displaySetId:other,opacity:0.2}),/outside/);
  assert.equal(f.memos.length,0);
});

test('measurement geometry is native-specific, bounded and nondegenerate',async()=>{
  const {measurementSpecs,validateGeometry}=await import('../.cache/live-runtime/measurements.js');
  const pts=[[0.1,0.2],[0.5,0.2],[0.5,0.8],[0.1,0.8]];
  for(const [name,spec] of Object.entries(measurementSpecs)) {
    const valid=name==='RectangleROI' ? [[0.1,0.2],[0.5,0.8]] : pts.slice(0,spec.min);
    if(spec.min<=4)assert.equal(validateGeometry(name,valid,'canvas').length,spec.min);
    if(spec.min>1)assert.throws(()=>validateGeometry(name,Array(spec.min).fill([0.1,0.2]),'canvas'));
  }
  assert.throws(()=>validateGeometry('Length',[[0.1,0.2],[Infinity,0.8]],'canvas'));
  assert.throws(()=>validateGeometry('Angle',pts.slice(0,2),'canvas'));
  assert.throws(()=>validateGeometry('Length',[[0.1,0.2],[0.8,0.8]],'world'));
});

test('measurement readback omits labels and never fabricates calibrated units',async()=>{
  const {measurementValue}=await import('../.cache/live-runtime/measurements.js');
  const one=measurementValue({annotationUID:'secret',metadata:{toolName:'Length'},data:{label:'PRIVATE NAME',handles:{points:[[1,2,3],[2,3,4]]},cachedStats:{image:{length:8}}}},'measurement-1');
  assert.equal(one.unit,null);assert.equal(one.calculationStatus,'uncalibrated');
  assert.doesNotMatch(JSON.stringify(one),/PRIVATE|secret/);
  const calibrated=measurementValue({metadata:{toolName:'Length'},data:{cachedStats:{image:{length:8,unit:'mm'}}}},'measurement-2');
  assert.equal(calibrated.value,8);assert.equal(calibrated.unit,'mm');
});

function measurementFixture(){
  const annotations=new Map(), measurements=new Map(), memos=[];let register=true, revoked=false;
  const instance={constructor:{createAnnotationMemo(_element,annotation,options){memos.push({annotation,options});}},createAnnotation(_evt,points){return {metadata:{toolName:'Length'},data:{handles:{points},cachedStats:{}},invalidated:true};}};
  const element={clientWidth:100,clientHeight:100};
  const viewport={id:'native',element,getCurrentImageId:()=> 'native-frame',canvasToWorld:([x,y])=>[x,y,0],worldToCanvas:([x,y])=>[x,y],render(){}};
  const tools={Enums:{Events:{ANNOTATION_COMPLETED:'completed',ANNOTATION_MODIFIED:'modified'},ChangeTypes:{}},utilities:{},annotation:{state:{getAnnotation:id=>annotations.get(id),addAnnotation:a=>annotations.set(a.annotationUID,a),removeAnnotation:id=>annotations.delete(id)}}};
  const core={eventTarget:{},triggerEvent(_target,_event,{annotation}){if(register)measurements.set(annotation.annotationUID,{uid:annotation.annotationUID,displaySetInstanceUID:'native-series'});setTimeout(()=>{annotation.data.cachedStats={image:{length:14,unit:'mm'}};annotation.invalidated=false;},40);}};
  const services={measurementService:{getMeasurement:id=>measurements.get(id),getMeasurements:()=>[...measurements.values()]}};
  const host={viewport,viewportId:'native',tools,core,services,group:{getToolInstance:()=>instance},seriesIds:['native-series'],imageIds:['native-frame']};
  const aliases=new Map();
  const adapter={measurementHost:()=>host,measurementAlias:(_kind,id)=>{if(!aliases.has(id))aliases.set(id,`measurement-${aliases.size+1}`);return aliases.get(id);},resolveMeasurement:id=>[...aliases.entries()].find(([,alias])=>alias===id)?.[0],assertMeasurementFrame(){if(revoked)throw new Error('Capture again');},runMeasurementCommand:async()=>{}};
  return {adapter,annotations,measurements,memos,disableRegistration(){register=false;},revoke(){revoked=true;}};
}

test('measurement waits for native calculation and geometry edits discard stale statistics',async()=>{
  const {applyMeasurement}=await import('../.cache/live-runtime/measurements.js');const f=measurementFixture();
  const args={operation:'create',type:'Length',points:[[0.2,0.3],[0.6,0.7]]};
  const result=await applyMeasurement(f.adapter,args,new AbortController().signal);
  assert.equal(result.measurement.value,14);assert.equal(result.measurement.unit,'mm');
  const anno=[...f.annotations.values()][0];anno.data.cachedStats={image:{length:999,unit:'mm'}};
  const updated=await applyMeasurement(f.adapter,{...args,operation:'update',measurementId:result.measurement.id,points:[[0.1,0.1],[0.5,0.5]]},new AbortController().signal);
  assert.equal(updated.measurement.value,14);assert.equal(f.memos.length,2);
  await assert.rejects(applyMeasurement(f.adapter,{operation:'read',measurementId:'measurement-missing'},new AbortController().signal),/outside/);
});

test('a lost measurement registration cannot claim success and late revoked geometry stays stopped',async()=>{
  const {applyMeasurement}=await import('../.cache/live-runtime/measurements.js');let f=measurementFixture();f.disableRegistration();
  await assert.rejects(applyMeasurement(f.adapter,{operation:'create',type:'Length',points:[[0.2,0.3],[0.6,0.7]]},new AbortController().signal),/unconfirmed/);
  f=measurementFixture();const pending=applyMeasurement(f.adapter,{operation:'create',type:'Length',points:[[0.2,0.3],[0.6,0.7]]},new AbortController().signal);f.revoke();await assert.rejects(pending,/Capture/);
});

test('segmentation edits require attached same-study references and preserve native undo',async()=>{
  const {applySegmentation}=await import('../.cache/live-runtime/measurements.js');const f=measurementFixture();const host=f.adapter.measurementHost();
  let visible=true;const memos=[];
  const segmentation={segmentationId:'private-seg',segments:{1:{}},representationData:{Labelmap:{referencedImageIds:['foreign-image']}}};
  host.services.segmentationService={getSegmentation:()=>segmentation,getSegmentationRepresentations:()=>[{segmentationId:'private-seg',type:'Labelmap'}],setSegmentVisibility:(_v,_s,_i,value)=>{visible=value;}};
  host.tools.segmentation={config:{visibility:{getSegmentIndexVisibility:()=>visible}}};
  host.core.utilities={HistoryMemo:{DefaultHistoryMemo:{push:m=>memos.push(m)}}};
  f.adapter.resolveSegmentation=()=> 'private-seg';
  const args={operation:'segment_visibility',segmentationId:'segmentation-1',segmentIndex:1,visible:false};
  await assert.rejects(applySegmentation(f.adapter,args,new AbortController().signal),/outside/);
  assert.equal(visible,true);segmentation.representationData.Labelmap.referencedImageIds=['native-frame'];
  await applySegmentation(f.adapter,args,new AbortController().signal);assert.equal(visible,false);
  memos[0].restoreMemo();assert.equal(visible,true);
});

test('world-space rectangle corners convert to the native four handles and reject an off-plane edit',async()=>{
  const {applyMeasurement}=await import('../.cache/live-runtime/measurements.js');const f=measurementFixture();
  await applyMeasurement(f.adapter,{operation:'create',type:'RectangleROI',coordinateSpace:'world',points:[[10,20,0],[50,80,0]]},new AbortController().signal);
  assert.deepEqual([...f.annotations.values()][0].data.handles.points,[[10,20,0],[50,20,0],[10,80,0],[50,80,0]]);
  await assert.rejects(applyMeasurement(f.adapter,{operation:'create',type:'RectangleROI',coordinateSpace:'world',points:[[10,20,2],[50,80,2]]},new AbortController().signal),/plane/);
});

test('calibration undo restores absence of a prior calibration rather than inventing scale one',async()=>{
  const {applyCalibration}=await import('../.cache/live-runtime/measurements.js');const f=measurementFixture();const host=f.adapter.measurementHost();let calibration;const memos=[];
  host.core.metaData={get:()=>calibration};host.viewport.getRenderingEngine=()=>({});
  host.core.utilities={HistoryMemo:{DefaultHistoryMemo:{push:m=>memos.push(m)}}};
  host.tools.utilities.calibrateImageSpacing=(_image,_engine,value)=>{calibration=value;};
  await applyCalibration(f.adapter,{points:[[0.1,0.1],[0.6,0.1]],knownLengthMm:10},new AbortController().signal);
  assert.equal(calibration.scale,5);memos[0].restoreMemo();assert.equal(calibration,undefined);
});

test('Livewire traces native image edges between control points instead of drawing straight segments',async()=>{
  const {applyMeasurement}=await import('../.cache/live-runtime/measurements.js');const f=measurementFixture();const host=f.adapter.measurementHost();const tool=host.group.getToolInstance();let searches=0,cleared=false;
  tool.setupBaseEditData=()=>{tool.editData={worldToSlice:p=>p.slice(0,2),sliceToWorld:p=>[...p,0]};tool.scissors={findPathToPoint:p=>{searches++;return [[15,15],[p[0],p[1]]];},startSearch(){}};};
  tool.clearEditData=()=>{cleared=true;tool.editData=null;tool.scissors=null;};
  await applyMeasurement(f.adapter,{operation:'create',type:'LivewireContour',points:[[0.2,0.2],[0.6,0.2],[0.6,0.6]]},new AbortController().signal);
  assert.equal(searches,3);assert.equal(cleared,true);assert.equal([...f.annotations.values()][0].data.contour.polyline.length,6);
});

test('review status uses cumulative coverage and whole-view counts stay separate',async()=>{
  const {explorationMarkup}=await import('../.cache/live-runtime/exploration-panel.js');
  const snapshot={status:'paused',grant:{scope:{kind:'series'}},coverage:[{frameCount:34,delivered:Array.from({length:8},(_,i)=>i)}],actions:[],canContinue:true};
  const text=explorationMarkup(snapshot);
  assert.match(text,/Review paused/);assert.match(text,/8 of 34 frames sent/);assert.match(text,/Review remaining 26 frames/);assert.doesNotMatch(text,/No images delivered/);
  const view=explorationMarkup({...snapshot,status:'completed',grant:{scope:{kind:'entire_view'}},actions:[{status:'delivered',result:{images:[{},{}]}}]});
  assert.match(view,/2 images sent/);assert.doesNotMatch(view,/34|study-continue|frames sent/);
  assert.match(explorationMarkup({...snapshot,status:'failed'}),/Review failed/);
});

test('viewer state reads survive an adjacent unshared localizer and incidental statistic updates',async()=>{
  const {ExplorationController,studyFingerprint}=await import('../.cache/live-runtime/exploration.js');
  const old=globalThis.fetch,calls=[];
  const state={studyId:'study-1',seriesId:'series-1',viewportId:'viewport-1',index:1,viewports:[{id:'viewport-1',seriesIds:['series-1']},{id:'viewport-2',seriesIds:['series-localizer']}],series:[{id:'series-1'},{id:'series-localizer'}],measurements:[{value:10}],canvasWidth:500};
  const host={studyBinding:()=>({studyId:'study-1',seriesIds:['series-1','series-localizer']}),context:()=>({state}),execute:async()=>structuredClone(state)};
  const c=new ExplorationController(host,{addEventListener(){},removeEventListener(){}},()=>{});
  c.abort=new AbortController();c.snapshot={status:'running',grant:{sessionId:'session-1',taskId:'task-1',binding}};c.expected=studyFingerprint(state);c.poll=async()=>{};
  globalThis.fetch=async(url,init)=>{const body=JSON.parse(init.body);calls.push([url,body]);return new Response(JSON.stringify(url.endsWith('/claim')?{claimId:'claim-1'}:{revision:0}));};
  try {
    c.contextChanged();state.canvasWidth=600;state.measurements[0].value=11;c.contextChanged();assert.equal(c.active,true);
    await c.execute({operationId:'op-1',kind:'action',name:'viewer_get_state',args:{},expectedRevision:0,binding});
    const result=calls.find(([url])=>url.endsWith('/result'))[1].result;
    assert.equal(result.status,'completed');assert.equal(result.state.viewports.length,1);assert.equal(c.active,true);
  } finally {c.release();globalThis.fetch=old;}
});
