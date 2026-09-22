import assert from 'node:assert/strict';
import test from 'node:test';
import { EvidenceController } from '../.cache/live-runtime/evidence.js';
import { renderEvidenceDetail, renderEvidenceSummary } from '../.cache/live-runtime/evidence-panel.js';

function reviewFixture(overrides = {}) {
  const hash = 'a'.repeat(64), time = '2026-09-22T00:00:00Z';
  const text = 'Synthetic finding [s1].';
  return {
    reviewId: 'jer-fixture', sessionId: 'ais-fixture', toolCallId: 'research-fixture',
    sourceContextVersion: 1, status: 'completed', createdAt: time, updatedAt: time,
    modelId: 'jev-1.13.0', generation: { providerId: null, modelId: null, recordedAt: null },
    totalPairs: 1, completedPairs: 1, settledPairs: 1, submittedAttempts: 1,
    unknownUsageAttempts: 0, reason: null, previewSha256: hash, answerSha256: hash,
    snapshotSha256: hash, originalAnswer: text,
    claims: [{ unitId: 'u1', text, start: 0, end: text.length, evidenceIds: ['e1'],
               eligible: true, exclusionReason: null }],
    abstracts: [{ evidenceId: 'e1', citationId: 's1', title: 'Synthetic fixture', pmid: '123',
      url: 'https://pubmed.ncbi.nlm.nih.gov/123/', retrievedAt: time, completeness: 'complete',
      sections: [{ label: null, text: 'Synthetic finding.' }], textSha256: hash,
      extractionVersion: 'ncbi-abstract-v1' }],
    exclusions: [], selectedUnitIds: ['u1'],
    assessments: [{ pairId: 'p1', unitId: 'u1', evidenceId: 'e1', status: 'completed', reason: null,
      label: 'supported', requestedModel: 'jev-1.13.0', resolvedModel: 'jev-1.13.0',
      rubricVersion: 'abstract-support-v1', rubricSha256: hash, answerSha256: hash,
      abstractSha256: hash, requestSha256: hash, attemptIds: ['a1'], reused: false,
      probabilities: { supported: 1, partially_supported: 0, contradicted: 0, mixed: 0, not_addressed: 0 } }],
    attempts: [{ attemptId: 'a1', pairId: 'p1', requestSha256: hash, startedAt: time,
      endedAt: time, submitted: true, reason: null, usage: { input_tokens: 10, output_tokens: 1 } }],
    earlierAttemptCount: 0, ...overrides,
  };
}
const response = value => new Response(JSON.stringify(value));
const flush = async () => { for (let i=0;i<20;i++) await Promise.resolve(); };
function harness(detail=reviewFixture({status:'ready',selectedUnitIds:null,assessments:[],attempts:[]})) {
  const calls=[]; let current=detail;
  const fetcher=async (url,init={}) => {
    calls.push({url,init});
    if(url.includes('/sessions/') && init.method!=='POST') return response({reviews:[],truncated:false});
    if(url.endsWith('/start')) current={...current,status:'completed',selectedUnitIds:JSON.parse(init.body).selectedUnitIds};
    return response(current);
  };
  return {calls,controller:new EvidenceController(()=>{},fetcher),set:value=>{current=value;}};
}

test('exact selection and confirmation precede one start; reopening and refresh never infer', async()=>{
  const {controller:c,calls}=harness(); await c.selectSession('ais-fixture'); await c.openTool('research-fixture');
  await c.start(); assert.equal(calls.filter(x=>x.url.endsWith('/start')).length,0);
  c.setSelected('u1',false); c.setConfirmation('synthetic'); await c.start();
  assert.equal(calls.filter(x=>x.url.endsWith('/start')).length,0);
  c.setSelected('u1',true); c.setConfirmation('synthetic'); await Promise.all([c.start(),c.start()]);
  const starts=calls.filter(x=>x.url.endsWith('/start')); assert.equal(starts.length,1);
  assert.deepEqual(Object.keys(JSON.parse(starts[0].init.body)).sort(),['confirmation','idempotencyKey','previewSha256','selectedUnitIds']);
  assert.equal(c.confirmation,null); c.close(); await c.openTool('research-fixture'); await c.refresh();
  assert.equal(calls.filter(x=>x.url.endsWith('/start')).length,1);
  for(const {init} of calls) { assert.equal(init.credentials,'include'); assert.equal(init.cache,'no-store'); assert.ok(init.signal); }
  c.dispose();
});

test('old session and old detail replies cannot replace current state, even if abort is ignored',async()=>{
  let resolveOld;const old=new Promise(resolve=>{resolveOld=resolve;});
  const c=new EvidenceController(()=>{},async url=>url.includes('/old/')?old:response({reviews:[],truncated:false}));
  const pending=c.selectSession('old'); await c.selectSession('new'); resolveOld(response({reviews:[reviewFixture()],truncated:false})); await pending;
  assert.equal(c.sessionId,'new'); assert.equal(c.reviews.size,0); c.dispose();
  let resolveDetail;const blocked=new Promise(resolve=>{resolveDetail=resolve;});
  const d=new EvidenceController(()=>{},async url=>url.endsWith('/first')?blocked:url.includes('/sessions/')?response({reviews:[reviewFixture({reviewId:'first'}),reviewFixture({reviewId:'second',toolCallId:'two'})],truncated:false}):response(reviewFixture({reviewId:'second',toolCallId:'two'})));
  await d.selectSession('ais-fixture');const pendingDetail=d.openTool('research-fixture');await d.openTool('two');resolveDetail(response(reviewFixture({reviewId:'first'})));await pendingDetail;
  assert.equal(d.detail.reviewId,'second');d.dispose();
});

test('failed start retransmission retains operation identity and requires renewed confirmation',async()=>{
  const calls=[];let failures=1;
  const c=new EvidenceController(()=>{},async(url,init)=>{
    if(url.includes('/sessions/')&&init.method==='GET') return response({reviews:[reviewFixture()],truncated:false});
    if(url.endsWith('/start')){calls.push(JSON.parse(init.body));if(failures--)throw Error('SECRET');return response(reviewFixture());}
    return response(reviewFixture({status:'ready',selectedUnitIds:null}));
  });
  await c.selectSession('ais-fixture');await c.openTool('research-fixture');c.setConfirmation('synthetic');await c.start();
  assert.equal(c.confirmation,null);assert.ok(!c.message.includes('SECRET'));await c.start();assert.equal(calls.length,1);
  c.setConfirmation('synthetic');await c.start();assert.equal(calls.length,2);assert.equal(calls[0].idempotencyKey,calls[1].idempotencyKey);c.dispose();
});

test('retry freezes selection and submits only hash and renewed confirmation',async()=>{
 const {controller:c,calls}=harness(reviewFixture({status:'partial'}));await c.selectSession('ais-fixture');await c.openTool('research-fixture');
 c.setSelected('u1',false);assert.deepEqual([...c.selectedUnitIds],['u1']);await c.retry();assert.ok(!calls.some(x=>x.url.endsWith('/retry')));
 c.setConfirmation('public_literature');await c.retry();const sent=JSON.parse(calls.find(x=>x.url.endsWith('/retry')).init.body);
 assert.equal(sent.confirmation,'public_literature');assert.ok(!('selectedUnitIds' in sent));assert.equal(c.confirmation,null);c.dispose();
});

test('poll backoff is bounded, closing keeps it active, disposal and auth failure stop it',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:0});
 const {controller:c,calls}=harness(reviewFixture({status:'reviewing'}));await c.selectSession('ais-fixture');await c.openTool('research-fixture');c.close();
 const count=calls.length;t.mock.timers.tick(999);await flush();assert.equal(calls.length,count);
 t.mock.timers.tick(1);await flush();assert.equal(calls.length,count+1);
 t.mock.timers.tick(1999);await flush();assert.equal(calls.length,count+1);
 t.mock.timers.tick(1);await flush();assert.equal(calls.length,count+2);
 for(let i=0;i<27;i++){t.mock.timers.tick(4000);await flush();}
 const stopped=calls.length;t.mock.timers.tick(10000);await flush();assert.equal(calls.length,stopped);assert.match(c.message,/Refresh/);c.dispose();
 let countAuth=0;const a=new EvidenceController(()=>{},async(url)=>{countAuth++;if(url.includes('/sessions/'))return response({reviews:[reviewFixture({status:'reviewing'})],truncated:false});return new Response('{}',{status:401});});
 await a.selectSession('ais-fixture');await a.openTool('research-fixture');const before=countAuth;t.mock.timers.tick(100000);await flush();assert.equal(countAuth,before);a.dispose();
});

test('late failure after unmount cannot alter cleared state',async()=>{
 let reject;const c=new EvidenceController(()=>{},()=>new Promise((_,r)=>{reject=r;}));const pending=c.selectSession('one');c.dispose();reject(Error('PRIVATE'));await pending;assert.equal(c.message,'');assert.equal(c.busy,false);
});

test('markup escapes text, separates all judgments, exclusions and unknown usage',()=>{
 const labels=['supported','partially_supported','contradicted','mixed','not_addressed'];const base=reviewFixture();
 const detail=reviewFixture({originalAnswer:'<img src=x onerror=alert(1)> [s1].',status:'partial',unknownUsageAttempts:1,earlierAttemptCount:2,
 exclusions:[{unitId:null,citationId:'s2',reason:'abstract_truncated'}],assessments:labels.map((label,i)=>({...base.assessments[0],pairId:'p'+i,label,reused:i===1}))});
 const html=renderEvidenceDetail(detail);assert.match(html,/&lt;img/);assert.ok(!html.includes('<img src=x'));assert.match(html,/Not reviewed/);assert.ok(!html.includes('Verified'));
 for(const text of ['Supported by this abstract','Partially supported','Contradicted by this abstract','Mixed','Not addressed','fetched for this review','Model output; not a probability of clinical truth.','Unknown','Reused','2 earlier attempts','https://pubmed.ncbi.nlm.nih.gov/123/'])assert.ok(html.includes(text),text);
 assert.match(renderEvidenceSummary(detail),/Partially completed/);
 assert.ok(!renderEvidenceDetail({...detail,abstracts:[{...base.abstracts[0],url:'javascript:alert(1)'}]}).includes('href="javascript:'));
});
