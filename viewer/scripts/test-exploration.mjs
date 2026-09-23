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
