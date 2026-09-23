import { escape, object, type EvidenceLabel, type EvidenceReviewDetail, type EvidenceReviewSummary, type Tool } from './protocol.js';
import { EvidenceController } from './evidence.js';
import { answerMarkup, inlineMarkup } from './presentation.js';

const labels: Record<EvidenceLabel, string> = { supported: 'Supported by this abstract', partially_supported: 'Partially supported', contradicted: 'Contradicted by this abstract', mixed: 'Mixed', not_addressed: 'Not addressed' };
const statuses: Record<string, string> = { preparing: 'Preparing', ready: 'Ready to review', reviewing: 'Reviewing', completed: 'Completed', partial: 'Partially completed', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted', unavailable: 'Unavailable' };
const canonicalPubMed = (url: unknown): url is string => typeof url === 'string' && /^https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/[0-9]{1,12}\/$/.test(url);
const shown = (value: unknown) => escape(value === null || value === undefined || value === '' ? 'Unknown' : value);
const row = (label: string, value: unknown) => `<dt>${escape(label)}</dt><dd>${shown(value)}</dd>`;

export function evidenceEligibility(tool: Tool): string | null {
  if (tool.name !== 'research_run') return 'Evidence review is available on public PubMed research results.';
  if (tool.status !== 'completed') return 'Complete public PubMed research before reviewing evidence.';
  if (typeof tool.result?.summary !== 'string' || !Array.isArray(tool.result.sources) || !tool.result.sources.some(source => canonicalPubMed(object(source).url))) return 'Jev review requires a cited public PubMed abstract.';
  return null;
}
export function renderEvidenceSummary(summary: EvidenceReviewSummary): string {
  const empty = summary.status === 'ready' && !summary.totalPairs || summary.reason === 'no_reviewable_claims';
  const title = empty ? 'No reviewable passages' : summary.status === 'ready' ? 'Ready for your confirmation' : `Jev · ${statuses[summary.status] ?? summary.status}`;
  const progress = empty ? 'Nothing has been sent to Jev.' : summary.status === 'ready' ? `${summary.totalPairs} abstract check${summary.totalPairs === 1 ? '' : 's'} prepared. Jev has not run yet.` : summary.status === 'preparing' ? 'Fetching the cited abstracts. Jev has not run yet.' : `${summary.completedPairs} of ${summary.totalPairs} abstract checks completed`;
  return `<strong>${escape(title)}</strong><span>${escape(progress)}</span>${summary.unknownUsageAttempts ? `<span>${summary.unknownUsageAttempts} attempts with unknown usage/billing</span>` : ''}`;
}

/** Public text is escaped; receipts distinguish execution from abstract support. */
export function renderEvidenceDetail(detail: EvidenceReviewDetail, selection?: Set<string>): string {
  const selected = selection ?? new Set(detail.selectedUnitIds ?? detail.claims.filter(claim => claim.eligible).map(claim => claim.unitId));
  const sourceIds = new Set(detail.claims.filter(claim => selected.has(claim.unitId)).flatMap(claim => claim.evidenceIds));
  const sources = detail.abstracts.filter(source => sourceIds.has(source.evidenceId));
  const abstracts = sources.map(source => `<details class="radsysx-evidence-source" data-detail-key="source-${escape(source.evidenceId)}"><summary>${escape(source.citationId)} · ${escape(source.title)}</summary>
    ${canonicalPubMed(source.url) ? `<a href="${escape(source.url)}" target="_blank" rel="noopener noreferrer">PubMed ${escape(source.pmid)} ↗</a>` : ''}
    <p>Abstract fetched for this review · ${escape(source.retrievedAt)}. It may differ from the text seen during research.</p>
    ${source.completeness !== 'complete' ? '<p>Not reviewed · complete evidence is unavailable.</p>' : ''}
    ${source.sections.map(section => `<section>${section.label ? `<strong>${escape(section.label)}</strong>` : ''}<p class="radsysx-evidence-text">${escape(section.text)}</p></section>`).join('')}
    <details><summary>Source provenance</summary><dl>${row('Abstract SHA-256', source.textSha256)}${row('Extraction version', source.extractionVersion)}</dl></details></details>`).join('');
  const judgments = detail.assessments.map(assessment => {
    const claim = detail.claims.find(value => value.unitId === assessment.unitId);
    const source = detail.abstracts.find(value => value.evidenceId === assessment.evidenceId);
    return `<article class="radsysx-evidence-judgment"><strong class="radsysx-evidence-verdict">${assessment.label ? labels[assessment.label] : 'Not reviewed'}</strong><div class="radsysx-evidence-text">${answerMarkup(claim?.text ?? 'Claim unavailable')}</div>
      <p>${escape(source?.citationId ?? assessment.evidenceId)} · ${escape(source?.title ?? 'Source unavailable')}${assessment.reason ? ` · ${escape(assessment.reason)}` : ''}</p>
      <details><summary>Execution receipt · ${assessment.reused ? 'Reused' : 'New'}</summary><dl>${row('Pair ID', assessment.pairId)}${row('Status',assessment.status)}${row('Requested reviewer',assessment.requestedModel)}${row('Resolved reviewer',assessment.resolvedModel)}${row('Rubric',assessment.rubricVersion)}${row('Rubric SHA-256',assessment.rubricSha256)}${row('Answer SHA-256',assessment.answerSha256)}${row('Abstract SHA-256',assessment.abstractSha256)}${row('Request SHA-256',assessment.requestSha256)}${row('Attempt IDs',assessment.attemptIds.join(', '))}</dl></details>
      ${assessment.probabilities ? `<details><summary>Model probabilities</summary><p>Model output; not a probability of clinical truth.</p><dl>${Object.entries(assessment.probabilities).map(([key,value]) => row(labels[key as EvidenceLabel],value)).join('')}</dl></details>` : ''}</article>`;
  }).join('');
  return `${judgments}<details data-detail-key="abstracts"><summary>Source abstracts · ${sources.length}</summary><p>These are the original abstracts linked to the selected passages.</p>${abstracts}</details>
    <details data-detail-key="answer"><summary>Original answer · unchanged</summary><div class="radsysx-evidence-text">${answerMarkup(detail.originalAnswer ?? '')}</div></details>
    ${detail.exclusions.length ? `<details><summary>Not reviewed · exclusions (${detail.exclusions.length})</summary><ul>${detail.exclusions.map(exclusion => `<li>${escape(detail.claims.find(c => c.unitId === exclusion.unitId)?.text ?? exclusion.citationId ?? 'Source')} · ${escape(exclusion.reason)}</li>`).join('')}</ul></details>` : ''}
    <details data-detail-key="receipt"><summary>Execution details</summary><dl>${row('Review ID',detail.reviewId)}${row('Source context version',detail.sourceContextVersion)}${row('Generation provider',detail.generation.providerId)}${row('Generation model',detail.generation.modelId)}${row('Generation recorded',detail.generation.recordedAt)}${row('Reviewer',detail.modelId)}${row('Preview SHA-256',detail.previewSha256)}${row('Answer SHA-256',detail.answerSha256)}${row('Snapshot SHA-256',detail.snapshotSha256)}${row('Created',detail.createdAt)}${row('Updated',detail.updatedAt)}${row('Reason',detail.reason)}${row('Submitted attempts',detail.submittedAttempts)}${row('Unknown usage/billing',detail.unknownUsageAttempts)}</dl>
    ${detail.earlierAttemptCount ? `<p>${detail.earlierAttemptCount} earlier attempts retained in private storage; latest ${detail.attempts.length} shown.</p>` : ''}
    ${detail.attempts.map(attempt => `<details><summary>Attempt ${escape(attempt.attemptId)}</summary><dl>${row('Pair ID',attempt.pairId)}${row('Submitted',attempt.submitted)}${row('Started',attempt.startedAt)}${row('Ended',attempt.endedAt)}${row('Reason',attempt.reason)}${row('Request SHA-256',attempt.requestSha256)}${row('Reported usage',attempt.usage ? JSON.stringify(attempt.usage) : 'Unknown usage/billing')}</dl></details>`).join('')}</details>`;
}

/** One stable host per research card; only status/receipt regions change during polling. */
export function mountEvidencePanel(host: HTMLElement, controller: EvidenceController, onClose?: () => void): {update(): void; dispose(): void} {
  const toolId = host.dataset.evidenceTool!;
  host.classList.add('radsysx-evidence');
  host.innerHTML = `<div data-evidence-status role="status" aria-live="polite"></div><button type="button" data-evidence-action="open">Review evidence with Jev</button>
    <div data-evidence-detail hidden><p data-evidence-message role="status" aria-live="polite"></p>
    <p class="radsysx-evidence-scope">Checks support in cited abstracts. This is not clinical validation.</p>
    <p data-evidence-guidance></p>
    <details data-evidence-selection><summary>Passages to review</summary><div data-evidence-consent></div></details><div data-evidence-actions><button type="button" data-evidence-action="start">Start Jev review</button><button type="button" data-evidence-action="retry">Retry unfinished review</button><button type="button" data-evidence-action="prepare">Prepare review again</button><button type="button" data-evidence-action="cancel">Cancel review</button><button type="button" data-evidence-action="refresh">Refresh status</button><button type="button" data-evidence-action="close">Close review</button></div>
    <div data-evidence-result></div></div>`;
  const query = <T extends HTMLElement = HTMLElement>(selector: string) => host.querySelector<T>(selector)!;
  const button = (action: string) => query<HTMLButtonElement>(`[data-evidence-action="${action}"]`);
  let preview = '', resultSignature = '', selectionState = '';
  const click = (event: Event) => {
    const target = (event.target as Element).closest<HTMLButtonElement>('[data-evidence-action]');
    if (!target || target.disabled) return;
    switch (target.dataset.evidenceAction) {
      case 'open': void controller.openTool(toolId); break;
      case 'close': controller.close(); if (onClose) onClose(); else button('open').focus(); break;
      case 'start': void controller.start(); break;
      case 'retry': void controller.retry(); break;
      case 'prepare': void controller.prepareAgain(); break;
      case 'cancel': void controller.cancel(); break;
      case 'refresh': void controller.refresh(); break;
    }
  };
  const change = (event: Event) => {
    const target = event.target as HTMLInputElement;
    if (target.dataset.evidenceUnit) controller.setSelected(target.dataset.evidenceUnit, target.checked);
    if (target.matches('[data-evidence-confirmation]')) controller.setConfirmation(target.value === 'public_literature' || target.value === 'synthetic' ? target.value : null);
  };
  host.addEventListener('click',click); host.addEventListener('change',change);
  const update = () => {
    const summary = controller.reviewForTool(toolId);
    query('[data-evidence-status]').innerHTML = summary ? renderEvidenceSummary(summary) : '';
    const detail = controller.detail?.toolCallId === toolId ? controller.detail : undefined;
    query('[data-evidence-detail]').hidden = !detail || !controller.open;
    button('open').textContent = summary ? 'Open Jev review' : 'Review evidence with Jev';
    button('open').hidden = Boolean(detail && controller.open);
    button('open').disabled = controller.busy;
    if (!detail) {
      // Make failures from preparation visible even when no detail was returned.
      if (controller.message && !summary) query('[data-evidence-status]').textContent = controller.message;
      return;
    }
    query('[data-evidence-message]').textContent = controller.message || (detail.status === 'preparing' ? 'Fetching original public abstracts. Nothing has been sent to TypeSafe.' : '');
    const identity = `${detail.reviewId}:${detail.previewSha256}`;
    if (identity !== preview) {
      preview = identity;
      query('[data-evidence-consent]').innerHTML = detail.previewSha256 && detail.claims.length ? `<fieldset><legend>Select passages</legend>${detail.claims.map((claim,index) => `<label for="${escape(detail.reviewId)}-claim-${index}"><input id="${escape(detail.reviewId)}-claim-${index}" type="checkbox" data-evidence-unit="${escape(claim.unitId)}"${claim.eligible ? '' : ' disabled'}><span class="radsysx-evidence-text">${inlineMarkup(claim.text)}${claim.eligible ? '' : ` · Not reviewed: ${escape(claim.exclusionReason ?? 'No eligible abstract')}`}</span></label>`).join('')}</fieldset>
      <div data-evidence-confirm><p>Only selected passages and their cited abstracts go to TypeSafe.</p><label for="${escape(detail.reviewId)}-confirmation">Confirm no patient information</label><select id="${escape(detail.reviewId)}-confirmation" data-evidence-confirmation><option value="">Choose before sending…</option><option value="public_literature">Public literature only · no patient information</option><option value="synthetic">Synthetic only · no patient information</option></select></div>` : '';
    }
    query('[data-evidence-consent]').querySelectorAll<HTMLInputElement>('[data-evidence-unit]').forEach(input => {
      input.checked = controller.selectedUnitIds.has(input.dataset.evidenceUnit!);
      input.disabled = controller.busy || detail.status !== 'ready' || !detail.claims.find(c => c.unitId === input.dataset.evidenceUnit)?.eligible;
    });
    const confirmation = host.querySelector<HTMLSelectElement>('[data-evidence-confirmation]');
    const retryable = ['partial','failed','interrupted'].includes(detail.status) && Boolean(detail.selectedUnitIds?.length);
    const selection = query<HTMLDetailsElement>('[data-evidence-selection]');
    selection.hidden = !detail.claims.length;
    const empty = !detail.claims.some(claim => claim.eligible);
    query('[data-evidence-guidance]').textContent = empty && !['preparing', 'reviewing'].includes(detail.status)
      ? 'No cited passage could be paired with a complete abstract. Prepare the review again to use the current extractor, or return to Research for an answer with PubMed citations.'
      : detail.status === 'ready' ? 'Select passages and inspect their abstracts below.'
      : detail.status === 'completed' ? 'Your original answer is unchanged.' : '';
    const nextSelectionState = `${detail.reviewId}:${detail.status}`;
    if (selectionState !== nextSelectionState) { selection.open = detail.status === 'ready' || retryable; selectionState = nextSelectionState; }
    const consent = host.querySelector<HTMLElement>('[data-evidence-confirm]');
    if (consent) consent.hidden = detail.status !== 'ready' && !retryable;
    if (confirmation) { confirmation.value = controller.confirmation ?? ''; confirmation.disabled = controller.busy || (detail.status !== 'ready' && !retryable); }
    button('start').hidden = detail.status !== 'ready' || empty; button('start').disabled = controller.busy || !controller.confirmation || !controller.selectedUnitIds.size;
    button('retry').hidden = !retryable; button('retry').disabled = controller.busy || !controller.confirmation;
    button('prepare').hidden = !controller.canPrepareAgain; button('prepare').disabled = controller.busy;
    button('cancel').hidden = !['preparing','reviewing'].includes(detail.status);
    // Cancellation can abort a GET currently in flight.
    button('refresh').disabled = controller.busy;
    const signature = JSON.stringify([detail,[...controller.selectedUnitIds]]);
    if (signature !== resultSignature) {
      resultSignature = signature;
      const region = query('[data-evidence-result]');
      // Preserve expanded source/receipt details while progress updates.
      const expanded = new Set(Array.from(region.querySelectorAll<HTMLDetailsElement>('details[data-detail-key]')).filter(node => node.open).map(node => node.dataset.detailKey));
      region.innerHTML = renderEvidenceDetail(detail, controller.selectedUnitIds);
      region.querySelectorAll<HTMLDetailsElement>('details[data-detail-key]').forEach(node => { node.open = expanded.has(node.dataset.detailKey); });
    }
  };
  update();
  return { update, dispose() { host.removeEventListener('click',click); host.removeEventListener('change',change); } };
}
