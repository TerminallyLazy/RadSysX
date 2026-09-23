import test from 'node:test';
import assert from 'node:assert/strict';
import { StudyCapture } from '../src/study-capture.mjs';
const origin='http://127.0.0.1:3000';
function fixture(){
  let clock=1000,calls=0;
  const binding={rendererId:'renderer-1',epoch:'epoch-1',contextVersion:1,revision:0,studyId:'study-1',seriesIds:['series-1']};
  const session={status:'ready',attestation:'synthetic',contextVersion:1,viewerContext:{captureTarget:'viewer'}};
  const task={status:'running',grant:{taskId:'task-1',sessionId:'session-1',status:'active',binding,scope:{kind:'entire_view',studyId:'study-1',seriesIds:['series-1']},permissions:['observe'],expiresAt:new Date(clock+60000).toISOString()},actions:[{operationId:'op-1',kind:'observe',status:'claimed'}],session};
  const surface={studyId:'study-1',settingsOpen:false,revision:0,epoch:'epoch-1',rendererId:'renderer-1',bounds:{width:1440,height:980},rect:{x:30,y:50,width:1000,height:800},panes:[{id:'viewport-1',seriesIds:['series-1'],studyId:'study-1',rect:{x:30,y:50,width:1000,height:800},presentation:{windowWidth:400,windowCenter:40}}]};
  const image=(width=3000,height=2400)=>({isEmpty:()=>false,getSize:()=>({width,height}),resize:o=>image(o.width,o.height),toJPEG:()=>Buffer.from('synthetic-jpeg')});
  const contents={id:1,mainFrame:{url:origin+'/viewer/dicomlocal'},isDestroyed:()=>false,getURL:()=>contents.mainFrame.url,getZoomFactor:()=>1.25,capturePage:async rect=>{calls++;assert.deepEqual(rect,{x:38,y:63,width:1250,height:1000});return image();}};
  const event={sender:contents,senderFrame:contents.mainFrame}, input={sessionId:'session-1',taskId:'task-1',binding};
  const capture=new StudyCapture({getWindow:()=>({webContents:contents}),getOrigin:()=>origin,getTask:async()=>task,getSurface:async()=>structuredClone(surface),now:()=>clock});
  return {capture,event,input,task,surface,contents,image,tick:n=>clock+=n,calls:()=>calls};
}
test('whole-view capture is scoped, bounded and returns pane and overview receipts',async()=>{
  const f=fixture(),lease=await f.capture.start(f.event,f.input);
  const result=await f.capture.capture(f.event,{leaseId:lease.leaseId,operationId:'op-1',kind:'workspace',viewportIds:[]});
  assert.deepEqual(result.images.map(i=>i.kind),['overview','pane']);assert.equal(result.images[0].width,2048);assert.equal(result.images[0].originalWidth,3000);
  assert.deepEqual(result.images[0].crop,[38,63,1250,1000]);assert.equal(f.calls(),2);
  assert.match(result.images[0].sha256,/^[a-f0-9]{64}$/);
});
test('foreign frame, origin, expired grant and extra capture inputs are rejected',async()=>{
  const f=fixture();await assert.rejects(f.capture.start({...f.event,sender:{}},f.input));
  await assert.rejects(f.capture.start({...f.event,senderFrame:{url:origin+'/viewer/'}},f.input));
  for(const key of ['rect','selector','path','url'])await assert.rejects(f.capture.start(f.event,{...f.input,[key]:'private'}),/invalid/i);
  const lease=await f.capture.start(f.event,f.input);
  for(const key of ['rect','selector','path','url'])await assert.rejects(f.capture.capture(f.event,{leaseId:lease.leaseId,operationId:'op-1',kind:'workspace',viewportIds:[],[key]:'private'}),/invalid/i);
  f.task.grant.status='revoked';await assert.rejects(f.capture.capture(f.event,{leaseId:lease.leaseId,operationId:'op-1',kind:'workspace',viewportIds:[]}));assert.equal(f.calls(),0);
});
test('settings, hidden/mixed-study panes and unrelated scope cannot be captured',async()=>{
  for(const change of [f=>f.surface.settingsOpen=true,f=>f.surface.panes[0].rect.width=0,f=>f.surface.panes[0].studyId='study-other',f=>f.task.grant.scope.seriesIds=['series-other']]){
    const f=fixture();change(f);await assert.rejects(f.capture.start(f.event,f.input));assert.equal(f.calls(),0);
  }
});
test('Stop, navigation, settings and revision changes during capture discard pixels',async()=>{
  for(const change of [f=>f.capture.revoke(),f=>f.contents.mainFrame.url=origin+'/worklist',f=>f.surface.settingsOpen=true,f=>f.surface.revision++]){
    const f=fixture(),lease=await f.capture.start(f.event,f.input);f.contents.capturePage=async()=>{change(f);return f.image();};
    await assert.rejects(f.capture.capture(f.event,{leaseId:lease.leaseId,operationId:'op-1',kind:'workspace',viewportIds:[]}));
  }
});
test('expired leases and overlapping captures fail; more panes require explicit paging',async()=>{
  const f=fixture(),lease=await f.capture.start(f.event,f.input);f.tick(15001);
  await assert.rejects(f.capture.capture(f.event,{leaseId:lease.leaseId,operationId:'op-1',kind:'workspace',viewportIds:[]}));
  const g=fixture(),other=await g.capture.start(g.event,g.input);let release;g.contents.capturePage=()=>new Promise(r=>release=r);
  const work=g.capture.capture(g.event,{leaseId:other.leaseId,operationId:'op-1',kind:'workspace',viewportIds:[]});
  await new Promise(r=>setImmediate(r));await assert.rejects(g.capture.capture(g.event,{leaseId:other.leaseId,operationId:'op-1',kind:'workspace',viewportIds:[]}));g.capture.revoke();release(g.image());await assert.rejects(work);
});

test('large grids use explicit groups under one frozen revision; oversized JPEGs fail',async()=>{
  const f=fixture();f.surface.panes=Array.from({length:9},(_,i)=>({...f.surface.panes[0],id:`viewport-${i+1}`}));
  let lease=await f.capture.start(f.event,f.input);
  await assert.rejects(f.capture.capture(f.event,{leaseId:lease.leaseId,operationId:'op-1',kind:'workspace',viewportIds:[]}));
  lease=await f.capture.start(f.event,f.input);
  const first=await f.capture.capture(f.event,{leaseId:lease.leaseId,operationId:'op-1',kind:'workspace',viewportIds:f.surface.panes.slice(0,7).map(p=>p.id)});
  assert.equal(first.images.length,8);
  const next=await f.capture.capture(f.event,{leaseId:lease.leaseId,operationId:'op-1',kind:'panes',viewportIds:f.surface.panes.slice(7).map(p=>p.id)});
  assert.equal(next.images.length,2);
  f.surface.revision++;
  await assert.rejects(f.capture.capture(f.event,{leaseId:lease.leaseId,operationId:'op-1',kind:'panes',viewportIds:['viewport-1']}));
  const g=fixture(),large=await g.capture.start(g.event,g.input);
  g.contents.capturePage=async()=>({isEmpty:()=>false,getSize:()=>({width:64,height:64}),toJPEG:()=>Buffer.alloc(1024*1024)});
  await assert.rejects(g.capture.capture(g.event,{leaseId:large.leaseId,operationId:'op-1',kind:'panes',viewportIds:['viewport-1']}));
});

test('series pane capture excludes adjacent localizer and refuses its explicit selection',async()=>{
  const f=fixture();f.task.grant.scope.kind='series';
  f.surface.panes.push({...f.surface.panes[0],id:'viewport-localizer',seriesIds:['series-localizer']});
  let lease=await f.capture.start(f.event,f.input);
  const result=await f.capture.capture(f.event,{leaseId:lease.leaseId,operationId:'op-1',kind:'panes',viewportIds:['viewport-1']});
  assert.equal(result.images.length,1);assert.equal(f.calls(),1);assert.equal(result.images[0].viewportId,'viewport-1');
  lease=await f.capture.start(f.event,f.input);
  await assert.rejects(f.capture.capture(f.event,{leaseId:lease.leaseId,operationId:'op-1',kind:'panes',viewportIds:['viewport-localizer']}));
  assert.equal(f.calls(),1);
  f.task.grant.scope.kind='entire_view';await assert.rejects(f.capture.start(f.event,f.input));
});
