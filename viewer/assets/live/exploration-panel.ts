import type { TaskSnapshot } from './protocol.js';
const escape=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function explorationMarkup(snapshot?:TaskSnapshot):string {
  if(!snapshot)return '';
  const running=['prepared','running'].includes(snapshot.status),series=snapshot.grant.scope.kind==='series'||snapshot.coverage.some(c=>c.requested.length>0);
  const total=snapshot.coverage.reduce((n,c)=>n+c.frameCount,0),delivered=snapshot.coverage.reduce((n,c)=>n+c.delivered.length,0);
  const images=snapshot.actions.filter(a=>a.status==='delivered').reduce((n,a)=>n+(Array.isArray((a.result as {images?:unknown[]})?.images)?(a.result as {images:unknown[]}).images.length:0),0);
  const title=snapshot.status==='prepared'?'Loading images':running?images?'Reviewing images':'Capturing images':!images?'No images delivered':series&&delivered<total?'Partial series coverage':snapshot.status==='completed'?'Images delivered':'Study task '+snapshot.status;
  const approvals=snapshot.actions.filter(a=>a.status==='awaiting_approval');
  return `<div class="radsysx-study-status" role="status"><div class="radsysx-study-status-line"><strong>${escape(title)}</strong><span>${series?`${delivered}/${total} frames`: `${images} images`}</span></div>
    ${running?'<div class="radsysx-study-actions"><button type="button" data-action="study-stop">Stop</button><button type="button" data-action="study-takeover">Take over</button></div>':snapshot.canContinue&&series?'<button type="button" data-action="study-continue">Continue review</button>':''}
    ${approvals.map(a=>`<div class="radsysx-study-proposal"><strong>Review ${escape(String(a.name).replaceAll('_',' '))}</strong><pre>${escape(JSON.stringify(a.args,null,2))}</pre><button type="button" data-action="study-approve" data-operation="${escape(a.operationId)}">Approve exact change</button><button type="button" data-action="study-deny" data-operation="${escape(a.operationId)}">Decline</button></div>`).join('')}
    <details><summary>Activity &amp; delivery details</summary><p>${escape(running?snapshot.activity:series&&delivered<total?'Not every frame was delivered. Continue review to examine the remainder.':'Image delivery does not establish diagnostic validation.')}</p>${snapshot.actions.filter(a=>a.status!=='awaiting_approval').slice(-12).map(a=>`<p>${escape(String(a.name).replaceAll('_',' '))} · ${escape(a.status)}</p>`).join('')}</details></div>`;
}
