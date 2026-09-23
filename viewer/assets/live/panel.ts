import { explorationMarkup } from './exploration-panel.js';
import { evidenceEligibility, mountEvidencePanel } from './evidence-panel.js';
import { LiveController } from './controller.js';
import { answerMarkup } from './presentation.js';
import { escape, object, safeUrl, type Attestation, type Json, type ProviderId, type ResearchProviderId, type Tool } from './protocol.js';

const MIC = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg>';
const HISTORY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10a9 9 0 1 1 2 8M3 4v6h6M12 7v5l3 2"/></svg>';

export function researchStatus(tool: Tool): string {
  if (tool.status === 'failed' && tool.result?.error === 'research_timeout') return 'Timed out';
  if (tool.status !== 'running') return ({ pending: 'Queued', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted', outcome_unknown: 'Status unconfirmed' } as Record<string, string>)[tool.status] ?? tool.status;
  return ({ queued: 'Waiting for a model slot', starting: 'Starting research', waiting_model: 'Waiting for model response', searching_web: 'Searching the web', searching_pubmed: 'Searching PubMed', reading_source: 'Reading a source', synthesizing: 'Preparing the cited answer' } as Record<string, string>)[tool.progress ?? ''] ?? 'Research running';
}

export function renderResearchActivity(tool: Tool): string {
  const provider = tool.research?.providerId === 'codex' ? 'ChatGPT / Codex subscription' : tool.research?.providerId === 'nvidia_nim' ? 'NVIDIA NIM' : tool.research?.providerId === 'gemini' ? 'Gemini' : 'Provider not recorded';
  return `<p class="radsysx-research-model">${escape(tool.research?.modelId ?? 'Model not recorded')}</p>
    <p role="status" aria-live="polite">${escape(researchStatus(tool))}</p>
    <details class="radsysx-execution"><summary>Execution details</summary><p>${escape(provider)}</p><p>${escape(tool.args.query)}</p><p>Requested model recorded: ${escape(tool.research?.recordedAt ?? 'Not recorded')}</p></details>`;
}

/** Inputs are created once; live transcript updates must never replace an edited password field. */
export function credentialSettingsMarkup(): string {
  return `<section class="radsysx-live-credentials" data-role="credentials" role="dialog" aria-modal="true" aria-label="Assistant settings" hidden>
    <header><h3>Assistant settings</h3><button type="button" data-action="close-credentials" aria-label="Close assistant settings">×</button></header>
    <section aria-label="ChatGPT subscription">
      <h4>ChatGPT / Codex subscription</h4>
      <p data-role="codex-account">Checking account…</p>
      <p data-role="codex-message" role="status" aria-live="polite"></p>
      <div><button type="button" data-action="codex-login">Sign in with ChatGPT</button><button type="button" data-action="codex-refresh">Refresh status</button><button type="button" data-action="codex-logout" hidden>Sign out</button></div>
      <a data-role="codex-login-link" target="_blank" rel="noopener noreferrer" hidden>Continue sign-in in browser ↗</a>
      <p>Uses your plan’s Codex allowance for text and research. Realtime voice uses API billing. Sign-in is separate from your other Codex apps; credentials stay in the OS keyring.</p>
    </section>
    <form data-role="research-settings-form">
      <h4>Text &amp; research models</h4>
      <p>Choose the model for typed chat and literature research. Voice is optional. Saving ends active sessions and tasks; your next conversation uses this selection.</p>
      <label for="radsysx-research-provider">Research provider</label>
      <select id="radsysx-research-provider" data-role="research-provider"></select>
      <label for="radsysx-research-model">Research model</label>
      <select id="radsysx-research-model" data-role="research-model"></select>
      <p data-role="research-current"></p>
      <p role="status" aria-live="polite" data-role="research-message"></p>
      <div><button type="submit" data-action="save-research-model">Save research model</button><button type="button" data-action="refresh-research-models">Refresh models</button><button type="button" data-action="reload-research-settings">Reload settings</button></div>
    </form>
    <p data-role="jev-availability"></p>
    <h4>API keys</h4>
    <p>Add your own provider keys. Changing a key ends all your active assistant sessions and background tasks. Your next conversation requires fresh data confirmation.</p>
    ${(['gemini', 'openai'] as const).map(id => `<form data-credential-provider="${id}" autocomplete="off">
      <h4>${id === 'gemini' ? 'Gemini' : 'OpenAI'}</h4><p data-role="credential-status-${id}">Status not loaded</p>
      <label for="radsysx-api-key-${id}">New ${id === 'gemini' ? 'Gemini' : 'OpenAI'} API key</label>
      <input id="radsysx-api-key-${id}" data-key-provider="${id}" type="password" autocomplete="new-password" spellcheck="false" autocapitalize="none" aria-describedby="radsysx-api-key-note" placeholder="Paste an API key" maxlength="4096">
      <div><button type="submit" data-save-provider="${id}">Save key</button><button type="button" data-action="remove-key" data-provider="${id}" hidden>Remove saved key</button></div>
      <p data-role="credential-fallback-${id}" hidden>Removing your saved key restores the app-configured key.</p>
    </form>`).join('')}
    <p id="radsysx-api-key-note">Keys are stored securely by the backend for your signed-in account. Saved keys are never shown here. Saving does not verify provider access.</p>
    <p role="status" aria-live="polite" data-role="credential-message"></p>
    <button type="button" data-action="reload-credentials">Retry key settings</button>
  </section>`;
}

/** Backend receipts and public research output remain visible independently of spoken summaries. */
export function renderToolResult(result?: Json): string {
  if (!result || !Object.keys(result).length) return '';
  if (typeof result.summary !== 'string') return `<details><summary>Observed result</summary><pre>${escape(JSON.stringify(result, null, 2))}</pre></details>`;
  const limitations = Array.isArray(result.limitations) ? result.limitations.filter(item => typeof item === 'string') : [];
  const sources = (Array.isArray(result.sources) ? result.sources : []).flatMap(item => {
    const source = object(item), url = safeUrl(source.url);
    return url ? [`<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(source.title ?? new URL(url).hostname)} ↗</a>`] : [];
  });
  const receipt = renderImageReceipt(result);
  const searches = (Array.isArray(result.pubmedSearches) ? result.pubmedSearches : []).map(object);
  return `<div class="radsysx-live-research-result">${receipt}${answerMarkup(result.summary)}${sources.length ? `<details><summary>Sources · ${sources.length}</summary>${sources.join('')}</details>` : ''}${searches.length ? `<details><summary>PubMed search record</summary>${searches.map(s => `<p>${escape(s.query)}</p><p>${escape(s.totalMatches ?? 'Unknown')} matches · ${Array.isArray(s.returnedPmids) ? s.returnedPmids.length : 0} abstracts retrieved · ${escape(s.retrievedAt)}</p><p>NCBI query: ${escape(s.translatedQuery)}</p>`).join('')}</details>` : ''}${limitations.length ? `<details><summary>Scope and limitations</summary><ul>${limitations.map(item => `<li>${escape(item)}</li>`).join('')}</ul></details>` : ''}</div>`;
}

export function renderImageReceipt(result?: Json): string {
  const study = object(result?.explorationReceipt);
  if (study.taskId) {
    const coverage = (Array.isArray(study.coverage) ? study.coverage : []).map(object);
    const frames = coverage.reduce((n, c) => n + (Array.isArray(c.delivered) ? c.delivered.length : 0), 0);
    const total = coverage.reduce((n, c) => n + Number(c.frameCount ?? 0), 0);
    return `<p class="radsysx-image-receipt">${escape(study.imagesDelivered ?? 0)} images delivered${study.scopeKind === 'series' ? ` · ${frames}/${total} series frames` : ' · reading view'}</p>`;
  }
  const image = object(result?.imageReceipt);
  return image.status === 'submitted' ? `<p class="radsysx-image-receipt">One viewport image submitted · ${escape(image.modelId)}</p><details><summary>Image receipt</summary><p>Active viewport only · ${escape(image.width)} × ${escape(image.height)} · ${escape(image.capturedAt)}</p><p>Image bytes are not saved in history.</p><code>${escape(image.sha256)}</code></details>` : '';

}

export function registerPanel(controller: LiveController): void {
  class LivePanel extends HTMLElement {
    private unsubscribe?: () => void;
    private attestation?: Attestation;
    private lastTarget = '';
    private attestationEpoch = -1;
    private mentionOpen = false;
    private voiceOptionsOpen = false;
    private threadSignature = '';
    private evidenceCards = new Map<string, { article: HTMLElement; body: HTMLElement; signature: string; reviewHost?: HTMLElement; review?: ReturnType<typeof mountEvidencePanel> }>();
    private providerSignature = '';
    private suggestionSignature = '';
    private credentialInputEpoch = -1;
    /** Existing synthetic desktop probes may inspect this compatibility view. */
    get state() { return { backendStatus: controller.backendStatus, backendSessionId: controller.backendSessionId }; }
    connectedCallback(): void {
      if (!this.dataset.initialized) {
        this.dataset.initialized = 'true'; this.classList.add('radsysx-panel-root', 'radsysx-ai-chat-root');
        this.innerHTML = `
          <div class="radsysx-ai-shell radsysx-live-shell">
            <header class="radsysx-live-header">
              <div class="radsysx-live-brand"><span class="radsysx-assistant-title">Assistant</span></div>
              <div class="radsysx-live-header-actions"><button type="button" class="radsysx-live-settings-button" data-action="voice-options" aria-expanded="false">Voice</button><button type="button" class="radsysx-live-settings-button" data-action="credentials" aria-haspopup="dialog">Settings</button><button type="button" class="radsysx-live-icon" data-action="history" title="Conversation history" aria-label="Conversation history">${HISTORY}</button></div>
            </header>
            <div class="radsysx-model-row"><p class="radsysx-sidebar-model" data-role="text-model"></p><button type="button" data-action="end-text" hidden>End chat</button></div>
            <nav class="radsysx-sidebar-tabs" aria-label="Assistant workspace">
              <button type="button" data-action="view-chat" aria-pressed="true">Chat</button>
              <button type="button" data-action="view-research" aria-pressed="false">Research <span data-role="research-count"></span></button>
              <button type="button" data-action="view-review" aria-pressed="false">Jev review</button>
            </nav>
            <details class="radsysx-live-setup radsysx-voice-options" data-role="voice-options">
              <summary>Voice <span data-role="voice-state">Optional</span></summary>
              <div class="radsysx-live-connect-row" data-role="setup">
              <select data-role="provider" aria-label="AI provider"></select>
              <button type="button" class="radsysx-live-primary" data-action="connect">Connect voice</button>
              </div>
              <p>Confirm the displayed data below before connecting. Microphone and image sharing are separate controls.</p>
            <section class="radsysx-live-session" data-role="session-controls" hidden>
              <div class="radsysx-live-controls" data-role="media-controls" data-listening="false">
                <button type="button" data-action="voice" title="Enable microphone" aria-label="Enable microphone">${MIC}<span data-role="voice-label">Mic off</span></button>
                <button type="button" data-action="share">Share image</button>
                <button type="button" data-action="stop-speaking" title="Stop speaking" aria-label="Stop speaking">■</button>
                <button type="button" data-action="end" title="End session">End</button>
              </div>
              <p class="radsysx-live-status" data-role="interaction"></p>
              <p class="radsysx-live-status" data-role="capture-scope" title="Shares the selected image viewport, not the whole app screen or other windows."></p>
            </section>
            </details>
            <p class="radsysx-live-status" role="status" aria-live="polite" data-role="status"></p>
            <div class="radsysx-live-conversation" data-role="conversation">
            <section class="radsysx-live-history" data-role="history" hidden></section>
            <section data-role="review-view" aria-label="Jev evidence review" hidden>
            <div class="radsysx-section-heading"><h3>Evidence review</h3><button type="button" data-action="view-research">Back to research</button></div>
            <section class="radsysx-evidence-entry" data-role="evidence-entry">
              <strong>Check an answer against its sources</strong>
              <p>Jev checks whether cited abstracts support the answer. Your original answer stays unchanged.</p>
              <button type="button" data-action="review-latest">Review latest research</button>
              <button type="button" data-action="history">Saved research</button>
              <p data-role="evidence-next" role="status" aria-live="polite"></p>
            </section>
            <p class="radsysx-live-status" data-role="review-message" role="status"></p>
            <div data-role="review-panels"></div>
            </section>
            <section data-role="research-view" aria-label="Literature research" hidden>
            <div class="radsysx-section-heading"><h3>Literature research</h3><p>Answers, cited sources, and evidence checks.</p></div>
            <div class="radsysx-live-empty" data-role="research-empty">Find evidence for your question.<span>Enter a public literature question below, then choose Research.</span></div>
            <section class="radsysx-live-tools" data-role="research-tools" aria-label="Research activity"></section>
            <div data-role="suggestions"></div>
            </section>
            <section data-role="chat-view" aria-label="Chat">
            <div class="radsysx-ai-thread" role="log" aria-label="RadSysX AI conversation" data-role="thread"><div class="radsysx-live-empty">A second set of hands.<br><span>Discuss the image, change a view, or research a question.</span></div></div>
            <section class="radsysx-live-report" data-role="report" aria-label="Draft report" hidden></section>
            <details class="radsysx-tool-history" data-role="tool-history"><summary>Task details &amp; viewer activity</summary><section class="radsysx-live-tools" data-role="tools" aria-label="Assistant actions"></section></details>
            <section class="radsysx-live-sources" data-role="sources" aria-label="Research sources"></section>
            </section>
            </div>
            <section data-role="study-progress" aria-label="Image delivery and viewer activity"></section>
            <form class="radsysx-ai-composer" data-role="composer">
              <label class="radsysx-data-confirmation" for="radsysx-live-attestation">Data
                <select id="radsysx-live-attestation" aria-label="Displayed data confirmation"><option value="">Choose before sending…</option><option value="synthetic">Synthetic / test data</option><option value="deidentified">Deidentified data</option></select>
              </label>
              <div class="radsysx-ai-attachment-row" data-role="selected"></div>
              <div class="radsysx-ai-mention-menu" data-role="attachments" data-open="false"></div>
              <div class="radsysx-study-share" data-role="study-share" hidden>
                <label class="radsysx-image-select">Images<select data-role="share-kind" aria-label="Images to send"><option value="off">None · text only</option><option value="current_image">Active viewport</option><option value="entire_view">Whole reading view</option><option value="series">Active series · all frames</option></select></label>
                <label class="radsysx-study-permission" data-role="viewer-permission"><input type="checkbox" data-role="share-tools"><span>Let AI use viewer tools <small>Navigate &amp; edit; saves require review</small></span></label>
              </div>
              <button type="button" class="radsysx-attach-view" data-action="attach-view" hidden>Attach current view</button>
              <div class="radsysx-view-attachment" data-role="view-attachment" hidden><details><summary>Preview image</summary><div data-role="image-preview"></div></details><div><span data-role="view-attachment-scope"></span><button type="button" data-action="remove-view">Remove image</button></div><p>Check the preview for patient information. Only this view and its visible overlays will be sent with your question.</p></div>
              <textarea rows="2" aria-label="RadSysX AI message" placeholder="Ask about this case, or enter a literature question"></textarea>
              <div class="radsysx-ai-composer-footer"><button class="radsysx-ai-icon-button" type="button" data-action="toggle-mention" aria-label="Attach viewer context" title="Attach viewer context">@</button><span class="radsysx-live-hint">Enter to send</span><button type="button" data-action="research">Research</button><button class="radsysx-ai-send-button" type="submit" aria-label="Send message">Send</button></div>
              <p data-role="disclosure"></p>
            </form>
            ${credentialSettingsMarkup()}
          </div>`;
        this.addEventListener('click', event => {
          const button = (event.target as Element).closest<HTMLButtonElement>('button');
          if (!button || button.disabled) return;
          const action = button.dataset.action;
          if (action?.startsWith('view-')) { this.showView(action.slice(5) as 'chat' | 'research' | 'review'); }
          else if (action === 'voice-options') { this.voiceOptionsOpen = !this.voiceOptionsOpen; this.node<HTMLDetailsElement>('voice-options').open = true; this.render(); }
          else if (action === 'connect') void (controller.providers.length ? controller.connect(this.attestation) : controller.initialize());
          else if (action === 'study-stop') void controller.exploration.stop();
          else if (action === 'study-takeover') void controller.exploration.takeover();
          else if (action === 'study-continue') { const scope=controller.exploration.snapshot?.grant.scope;if(scope){controller.shareKind=scope.kind;controller.allowViewerTools=scope.allowViewerTools;void controller.prepareStudy(this.attestation,true);} }
          else if (action === 'study-approve' || action === 'study-deny') void controller.exploration.decide(button.dataset.operation!,action==='study-approve');
          else if (action === 'attach-view') void controller.attachCurrentView(this.attestation);
          else if (action === 'remove-view') controller.removeView();
          else if (action === 'voice') void controller.toggleMicrophone();
          else if (action === 'stop-speaking') controller.stopSpeaking();
          else if (action === 'share') void controller.toggleSharing();
          else if (action === 'end' || action === 'end-text') void controller.end();
          else if (action === 'research') { this.showView('research'); void controller.research(this.attestation); }
          else if (action === 'credentials') { void controller.showCredentials(); this.button('close-credentials').focus(); }
          else if (action === 'close-credentials') { this.clearKeyInputs(); controller.closeCredentials(); this.button('credentials').focus(); }
          else if (action === 'refresh-research-models') void controller.loadResearchModels(true);
          else if (action === 'reload-research-settings') void controller.loadResearchSettings();
          else if (action === 'codex-login') void controller.subscription.login();
          else if (action === 'codex-refresh') void controller.subscription.refresh();
          else if (action === 'codex-logout') void controller.subscription.logout();
          else if (action === 'reload-credentials') void controller.loadCredentials();
          else if (action === 'remove-key') { this.clearKeyInputs(); void controller.removeCredential(button.dataset.provider as ProviderId); }
          else if (action === 'undo-draft') void controller.adapter.execute('viewer_undo', {}).then(() => controller.emit());
          else if (action === 'history') void controller.showHistory();
          else if (action === 'review-latest') {
            const tool = [...controller.tools.values()].slice(-12).reverse().find(tool => !evidenceEligibility(tool));
            if (tool) this.openReview(tool.id);
          }
          else if (action === 'open-review' && button.dataset.id) this.openReview(button.dataset.id);
          else if (action === 'toggle-mention') { this.mentionOpen = !this.mentionOpen; this.render(); }
          else if (action === 'attach' && button.dataset.id) { controller.selected.add(button.dataset.id); this.mentionOpen = false; this.render(); }
          else if (action === 'remove' && button.dataset.id) { controller.selected.delete(button.dataset.id); this.render(); }
          else if (action === 'approve') void controller.decide(button.dataset.id!, true);
          else if (action === 'decline') void controller.decide(button.dataset.id!, false);
          else if (action === 'cancel') void controller.cancel(button.dataset.id!);
          else if (action === 'read-history') void controller.readHistory(button.dataset.id!).then(() => this.showView([...controller.tools.values()].some(tool => tool.name === 'research_run') ? 'research' : 'chat'));
          else if (action === 'clear-history') {
            // Clearing durable history is explicit and separate from ending a call.
            if (window.confirm('Clear this saved conversation and its tool history?')) void controller.clearHistory(button.dataset.id!);
          }
        });
        this.node<HTMLSelectElement>('share-kind').addEventListener('change',event=>{controller.shareKind=(event.target as HTMLSelectElement).value as typeof controller.shareKind;void controller.exploration.stop();controller.removeView();controller.emit();});
        this.node<HTMLInputElement>('share-tools').addEventListener('change',event=>{controller.allowViewerTools=(event.target as HTMLInputElement).checked;void controller.exploration.stop();});
        this.node<HTMLSelectElement>('research-provider').addEventListener('change', event => void controller.selectResearchProvider((event.target as HTMLSelectElement).value as ResearchProviderId));
        this.node<HTMLSelectElement>('research-model').addEventListener('change', event => { controller.researchModelId = (event.target as HTMLSelectElement).value; controller.emit(); });
        this.node<HTMLFormElement>('research-settings-form').addEventListener('submit', event => { event.preventDefault(); void controller.saveResearchSettings(); });
        this.node<HTMLSelectElement>('provider').addEventListener('change', event => void controller.selectProvider((event.target as HTMLSelectElement).value as ProviderId));
        this.querySelector('#radsysx-live-attestation')!.addEventListener('change', event => { this.attestation = (event.target as HTMLSelectElement).value as Attestation || undefined; controller.removeView(); void controller.exploration.stop(); });
        this.querySelector('textarea')!.addEventListener('input', event => { controller.draft = (event.target as HTMLTextAreaElement).value; if (/(^|\s)@$/.test(controller.draft)) { this.mentionOpen = true; this.render(); } });
        this.querySelector('textarea')!.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); this.submit(); } });
        this.querySelector('.radsysx-ai-composer')!.addEventListener('submit', event => { event.preventDefault(); this.submit(); });
        this.querySelectorAll<HTMLFormElement>('form[data-credential-provider]').forEach(form => {
          form.addEventListener('submit', event => {
            event.preventDefault();
            const id = form.dataset.credentialProvider as ProviderId;
            const input = form.querySelector<HTMLInputElement>('input')!;
            const apiKey = input.value;
            this.clearKeyInputs();
            void controller.saveCredential(id, apiKey);
          });
          form.addEventListener('input', () => this.renderCredentials());
        });
        this.node('credentials').addEventListener('keydown', event => {
          if (event.key === 'Escape') { event.stopPropagation(); this.clearKeyInputs(); controller.closeCredentials(); this.button('credentials').focus(); }
          if (event.key === 'Tab') {
            const controls = Array.from(this.node('credentials').querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)')).filter(node => !node.hidden && !node.closest('[hidden]'));
            const first = controls[0], last = controls.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
          }
        });
      }
      void controller.evidence.selectSession(controller.evidenceSessionId);
      this.unsubscribe = controller.subscribe(() => this.render());
    }
    disconnectedCallback(): void { controller.subscription.stop(); controller.evidence.dispose(); this.evidenceCards.forEach(card => { card.review?.dispose(); card.article.remove(); card.reviewHost?.remove(); }); this.evidenceCards.clear(); this.clearKeyInputs(); this.unsubscribe?.(); this.unsubscribe = undefined; }
    private showView(view: 'chat' | 'research' | 'review'): void {
      controller.sidebarView = view; this.render(); this.node('conversation').scrollTop = 0;
    }
    private openReview(id: string): void { this.showView('review'); void controller.evidence.openTool(id); }
    private submit(): void {
      if (controller.sidebarView === 'research') void controller.research(this.attestation);
      else void controller.sendText(this.attestation);
    }
    private clearKeyInputs(): void { this.querySelectorAll<HTMLInputElement>('input[data-key-provider]').forEach(input => { input.value = ''; }); }
    private renderCredentials(): void {
      if (this.credentialInputEpoch !== controller.credentialInputEpoch) { this.credentialInputEpoch = controller.credentialInputEpoch; this.clearKeyInputs(); }
      this.node('credentials').hidden = !controller.credentialsOpen;
      this.querySelectorAll<HTMLElement>('.radsysx-live-shell > *').forEach(node => { if (node !== this.node('credentials')) node.inert = controller.credentialsOpen; });
      this.button('credentials').setAttribute('aria-expanded', String(controller.credentialsOpen));
      this.node('credential-message').textContent = controller.credentialMessage;
      const subscription = controller.subscription, account = subscription.account;
      this.node('codex-account').textContent = account?.signedIn ? `${account.email || 'ChatGPT account'}${account.plan ? ` · ${account.plan}` : ''}` : 'Not signed in';
      this.node('codex-message').textContent = subscription.message;
      this.button('codex-login').hidden = Boolean(account?.signedIn || account?.loginState === 'pending');
      this.button('codex-login').disabled = subscription.busy || !account?.available || controller.credentialsBusy;
      this.button('codex-refresh').disabled = subscription.busy || controller.credentialsBusy;
      this.button('codex-logout').hidden = !account?.signedIn && account?.loginState !== 'pending';
      this.button('codex-logout').disabled = subscription.busy || controller.credentialsBusy;
      this.button('codex-logout').textContent = account?.signedIn ? 'Sign out' : 'Cancel sign-in';
      const loginLink = this.node<HTMLAnchorElement>('codex-login-link');
      loginLink.hidden = !subscription.loginUrl || account?.signedIn === true;
      if (subscription.loginUrl) loginLink.href = subscription.loginUrl; else loginLink.removeAttribute('href');
      const jev = controller.evidenceAvailability;
      this.node('jev-availability').textContent = jev ? `Jev · ${jev.modelId} · ${jev.availability.charAt(0).toUpperCase() + jev.availability.slice(1)}. ${jev.reason} Open a completed PubMed research card to review its evidence.` : 'Jev · availability not loaded.';
      const provider = this.node<HTMLSelectElement>('research-provider'), model = this.node<HTMLSelectElement>('research-model');
      const providerOptions = (controller.researchSettings?.providers ?? []).map(item => `<option value="${escape(item.id)}">${escape(item.label)}${item.configured ? '' : ' · not configured'}</option>`).join('');
      if (provider.innerHTML !== providerOptions) provider.innerHTML = providerOptions;
      provider.value = controller.researchProviderId;
      const choices = controller.researchModels;
      const modelOptions = '<option value="">Choose a model</option>' + (controller.researchModelId && !choices.includes(controller.researchModelId) ? `<option value="${escape(controller.researchModelId)}" disabled>${escape(controller.researchModelId)} · catalog unavailable</option>` : '') + choices.map(id => `<option value="${escape(id)}">${escape(id)}</option>`).join('');
      if (model.innerHTML !== modelOptions) model.innerHTML = modelOptions;
      model.value = controller.researchModelId;
      provider.disabled = controller.credentialsBusy || controller.researchLoading || !controller.researchSettings;
      model.disabled = controller.credentialsBusy || controller.researchLoading || !choices.length;
      this.button('save-research-model').disabled = model.disabled || !choices.includes(controller.researchModelId) || !controller.researchSettings?.providers.find(item => item.id === controller.researchProviderId)?.configured;
      this.button('refresh-research-models').disabled = controller.credentialsBusy || controller.researchLoading || !controller.researchSettings;
      this.button('reload-research-settings').disabled = controller.credentialsBusy || controller.researchLoading;
      this.node('research-message').textContent = controller.researchMessage;
      this.node('research-current').textContent = controller.researchSettings ? `${controller.researchSettings.source === 'saved' ? 'Saved for your account' : 'App default'}: ${controller.researchSettings.modelId}` : '';
      const busy = controller.credentialsBusy || controller.credentialsLoading;
      this.button('reload-credentials').disabled = busy;
      this.querySelectorAll<HTMLFormElement>('form[data-credential-provider]').forEach(form => {
        const id = form.dataset.credentialProvider as ProviderId;
        const provider = controller.credentials?.providers.find(profile => profile.id === id);
        this.node(`credential-status-${id}`).textContent = provider?.source === 'saved' ? provider.configured ? 'Saved key · configured' : 'Saved key cannot be read · remove it or restore key storage' : provider?.source === 'environment' ? 'App-configured key' : provider ? 'Not configured' : 'Status not loaded';
        const input = form.querySelector<HTMLInputElement>('input')!;
        input.disabled = busy || !controller.credentials?.storageAvailable;
        const save = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
        save.disabled = input.disabled || !input.value.trim();
        save.textContent = provider?.source === 'saved' ? 'Replace saved key' : 'Save key';
        const remove = form.querySelector<HTMLButtonElement>('[data-action="remove-key"]')!;
        remove.hidden = provider?.source !== 'saved'; remove.disabled = busy;
        this.node(`credential-fallback-${id}`).hidden = provider?.source !== 'saved' || !provider.environmentConfigured;
      });
    }
    private node<T extends HTMLElement = HTMLElement>(role: string): T { return this.querySelector(`[data-role="${role}"]`)!; }
    private button(action: string): HTMLButtonElement { return this.querySelector(`[data-action="${action}"]`)!; }
    private render(): void {
      this.renderCredentials();
      if (!controller.credentialsBusy && (controller.evidence.suspended || controller.evidence.sessionId !== controller.evidenceSessionId)) void controller.evidence.selectSession(controller.evidenceSessionId);
      if (this.lastTarget !== controller.targetId || this.attestationEpoch !== controller.attestationEpoch) {
        this.attestationEpoch = controller.attestationEpoch;
        this.lastTarget = controller.targetId; this.attestation = undefined;
        this.querySelector<HTMLSelectElement>('#radsysx-live-attestation')!.value = '';
      }
      const providerSelect = this.node<HTMLSelectElement>('provider');
      const profilesSignature = JSON.stringify(controller.providers);
      if (profilesSignature !== this.providerSignature) {
        this.providerSignature = profilesSignature;
        providerSelect.innerHTML = controller.providers.map(profile => `<option value="${profile.id}">${escape(profile.label)}</option>`).join('');
      }
      providerSelect.value = controller.providerId;
      providerSelect.disabled = controller.credentialsBusy || controller.status === 'loading' || !controller.providers.length;
      providerSelect.title = controller.model;
      this.node('text-model').textContent = (controller.session?.mode === 'text' && controller.status === 'text_ready' ? controller.session.modelId : controller.researchSettings?.modelId) ?? 'Choose a model in Settings';
      this.node('disclosure').textContent = controller.canShareStudy && controller.shareKind !== 'off' ? 'Send captures fresh images. Image pixels stay out of saved history.' : controller.viewAttachment ? 'Sends the previewed image with your question.' : 'Text and neutral context only. Select images to give the model sight.';
      this.node('study-share').hidden=!controller.canShareStudy;
      this.node<HTMLSelectElement>('share-kind').value = controller.shareKind;
      this.node<HTMLSelectElement>('share-kind').disabled = controller.textBusy || controller.shareBusy;
      this.node<HTMLInputElement>('share-tools').disabled = controller.textBusy || controller.shareBusy;
      this.node('viewer-permission').hidden = !['series', 'entire_view'].includes(controller.shareKind);
      const studyHost=this.node('study-progress'), studyHtml=explorationMarkup(controller.exploration.snapshot);
      if(studyHost.dataset.rendered!==studyHtml){const open=studyHost.querySelector('details')?.open;studyHost.innerHTML=studyHtml;studyHost.dataset.rendered=studyHtml;if(open&&studyHost.querySelector('details'))studyHost.querySelector('details')!.open=true;}
      this.button('attach-view').hidden = !controller.canAttachView || controller.canShareStudy;
      this.button('attach-view').disabled = controller.textBusy || controller.viewCaptureBusy || controller.credentialsBusy;
      this.button('attach-view').textContent = controller.viewCaptureBusy ? 'Capturing view…' : controller.viewAttachment ? 'Replace with current view' : 'Attach current view';
      const attachment = this.node('view-attachment'), previewHost = this.node('image-preview');
      attachment.hidden = !controller.viewAttachment;
      if (controller.viewAttachment) {
        const src = `data:image/jpeg;base64,${controller.viewAttachment.image.data}`;
        let preview = previewHost.querySelector('img');
        if (!preview) { preview = document.createElement('img'); preview.alt = 'Active image to send'; preview.src = src; previewHost.append(preview); }
        else if (preview.getAttribute('src') !== src) preview.src = src;
        this.node('view-attachment-scope').textContent = controller.viewAttachment.scope;
      } else previewHost.replaceChildren();
      this.button('remove-view').disabled = controller.textBusy;
      this.button('end-text').hidden = controller.session?.mode !== 'text' || controller.status !== 'text_ready';
      this.button('research').disabled = controller.textBusy || controller.viewCaptureBusy || controller.credentialsBusy || controller.status === 'loading';
      const sendButton = this.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!;
      sendButton.disabled = controller.textBusy || controller.viewCaptureBusy || controller.credentialsBusy || controller.status === 'loading';
      sendButton.textContent = controller.textBusy ? 'Working…' : controller.canShareStudy && controller.shareKind !== 'off' ? 'Send with images' : 'Send';
      this.dataset.connection = controller.status;
      const active = ['connecting', 'ready', 'reconnecting'].includes(controller.status);
      this.node('voice-state').textContent = active ? controller.ready ? 'Connected' : 'Connecting' : 'Optional';
      this.node('setup').hidden = active;
      this.node('session-controls').hidden = !active;
      this.button('connect').disabled = controller.credentialsBusy || controller.status === 'loading';
      this.button('connect').textContent = controller.providers.length ? 'Connect voice' : 'Retry setup';
      this.node('status').textContent = controller.message === 'Viewing saved conversation. Audio and image frames are not recorded.' ? 'Saved conversation' : controller.message;
      this.node('status').hidden = !controller.message || controller.message === 'Confirm the displayed data to begin.' || (controller.exploration.active && controller.textBusy);
      this.node('voice-label').textContent = controller.audio.listening ? 'Mic on' : 'Mic off';
      this.node('interaction').textContent = controller.ready && controller.interaction === 'IN_PROGRESS' ? 'Thinking and working…' : controller.ready ? 'Connected · interrupt anytime' : active ? 'Connecting…' : '';
      this.node('media-controls').setAttribute('data-listening', String(controller.audio.listening));
      this.button('voice').disabled = !controller.ready;
      this.button('voice').setAttribute('aria-pressed', String(controller.audio.listening));
      this.button('voice').setAttribute('aria-label', controller.audio.listening ? 'Pause microphone' : 'Enable microphone');
      this.button('share').disabled = !controller.ready || !controller.activeProvider?.screen;
      this.button('voice').title = controller.audio.listening ? 'Pause microphone' : 'Enable microphone';
      this.button('share').textContent = controller.sharing ? '● Stop sharing' : 'Share image';
      this.button('share').title = controller.sharing ? 'Stop sharing the active image' : 'Share the active image viewport';
      this.button('share').setAttribute('aria-pressed', String(controller.sharing));
      this.node('capture-scope').textContent = controller.captureScope;
      this.button('end').disabled = !controller.session || controller.status === 'disconnected';
      this.button('stop-speaking').disabled = !controller.ready;
      const textarea = this.querySelector('textarea')!;
      if (textarea.value !== controller.draft) textarea.value = controller.draft;
      const transcripts = controller.transcript.items;
      const imageReceipts = [...controller.tools.values()].filter(tool => tool.name === 'text_chat' && (tool.result?.imageReceipt || tool.result?.explorationReceipt));
      const signature = JSON.stringify([transcripts, imageReceipts.map(tool => [tool.id, tool.result?.imageReceipt, tool.result?.explorationReceipt])]);
      if (signature !== this.threadSignature) {
        const thread = this.node('thread'); const scrollContainer = this.node('conversation'); const scroll = scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight < 80;
        thread.innerHTML = transcripts.length ? transcripts.map(item => `<article class="radsysx-ai-message" data-role="${item.role === 'user' ? 'user' : 'assistant'}"><div class="radsysx-ai-message-role">${item.role === 'user' ? 'You' : 'RadSysX AI'}</div><div class="radsysx-ai-message-body">${item.role === 'user' ? escape(item.text) : answerMarkup(item.text)}${item.role === 'user' ? renderImageReceipt(imageReceipts.find(tool => item.id.endsWith(':' + tool.id))?.result) : ''}</div></article>`).join('') : '<div class="radsysx-live-empty">Discuss this case.<span>Ask a question or describe a finding. Voice is optional. Attach the current view when you want the model to see it.</span></div>';
        if (scroll) scrollContainer.scrollTop = scrollContainer.scrollHeight;
        this.threadSignature = signature;
      }
      const attachments = controller.adapter.attachments();
      this.node('attachments').dataset.open = String(this.mentionOpen);
      this.node('attachments').innerHTML = attachments.length ? attachments.map(item => `<button class="radsysx-ai-mention-option" type="button" data-action="attach" data-id="${escape(item.id)}" data-attachment-kind="${item.kind}"><span>${escape(item.label)}</span><small>${escape(item.kind)} · current image</small></button>`).join('') : '<div class="radsysx-live-empty">Create a measurement or load a segmentation to attach it.</div>';
      this.node('selected').innerHTML = attachments.filter(item => controller.selected.has(item.id)).map(item => `<span class="radsysx-ai-chip">@${escape(item.label)}<button type="button" data-action="remove" data-id="${escape(item.id)}" aria-label="Remove ${escape(item.label)}">×</button></span>`).join('');
      const report = controller.adapter.draftReport;
      this.node('report').hidden = !report;
      this.node('report').innerHTML = report ? `<strong>Draft report · unsaved</strong><p>${report.targetId === controller.targetId ? 'Review before saving. Local files must be imported through the worklist and opened as a study to save a report.' : 'This draft belongs to a previously selected image.'}</p><details open><summary>Findings and impression</summary><div class="radsysx-live-report-text">${escape(report.findings)}<hr>${escape(report.impression)}</div></details><button type="button" data-action="undo-draft">Undo latest edit</button>` : '';
      const allTools = [...controller.tools.values()];
      const visibleTools = allTools.filter((tool, index) => index >= allTools.length - 12 || ['pending', 'running', 'awaiting_approval'].includes(tool.status));
      const eligible = [...visibleTools].reverse().find(tool => !evidenceEligibility(tool));
      const researching = visibleTools.some(tool => tool.name === 'research_run' && ['pending', 'running'].includes(tool.status));
      this.button('review-latest').disabled = !eligible || controller.evidence.busy || controller.credentialsBusy;
      this.node('evidence-next').textContent = eligible ? 'Preview the exact passages and their cited abstracts before sending to Jev.' : researching ? 'Research is in progress. Review becomes available when cited abstracts arrive.' : 'Start with a literature question in Research, or open saved research.';
      const visibleIds = new Set(visibleTools.map(tool => tool.id));
      for (const [id, card] of this.evidenceCards) if (!visibleIds.has(id)) { card.review?.dispose(); card.reviewHost?.remove(); card.article.remove(); this.evidenceCards.delete(id); }
      for (const tool of visibleTools) {
        let card = this.evidenceCards.get(tool.id);
        if (!card) {
          const article = document.createElement('article'); article.className = 'radsysx-live-tool';
          const body = document.createElement('div'); body.className = 'radsysx-live-tool-body'; article.append(body); this.node(tool.name === 'research_run' ? 'research-tools' : 'tools').append(article);
          card = { article, body, signature: '' }; this.evidenceCards.set(tool.id, card);
        }
        const reviewSummary = controller.evidence.reviewForTool(tool.id);
        const signature = JSON.stringify([tool, controller.historical, reviewSummary]);
        if (signature !== card.signature) {
          card.signature = signature;
          const pending = !controller.historical && !['completed', 'failed', 'cancelled', 'declined', 'rejected', 'denied', 'interrupted', 'outcome_unknown'].includes(tool.status);
          card.body.innerHTML = `<h4>${tool.name === 'research_run' ? escape(tool.args.query || 'Literature research') : escape(tool.name.replace(/_/g, ' '))}</h4>${['research_run', 'text_chat'].includes(tool.name) ? renderResearchActivity(tool) : `<details${tool.approval ? ' open' : ''}><summary>${tool.approval ? 'Review this action' : 'Details'}</summary><pre>${escape(JSON.stringify(tool.args, null, 2))}</pre></details>`}${tool.name === 'text_chat' && tool.status === 'completed' ? '' : renderToolResult(tool.result)}${tool.approval ? `<div class="radsysx-live-review"><button type="button" data-action="approve" data-id="${escape(tool.id)}">Approve</button><button type="button" data-action="decline" data-id="${escape(tool.id)}">Decline</button></div>` : pending ? `<button type="button" data-action="cancel" data-id="${escape(tool.id)}">Cancel task</button>` : ''}${!evidenceEligibility(tool) ? `<button type="button" class="radsysx-review-link" data-action="open-review" data-id="${escape(tool.id)}">Review evidence with Jev →</button>` : ''}`;
          if (tool.name === 'research_run' && !card.review) {
            const reason = evidenceEligibility(tool);
            if (!reason) {
              const host = document.createElement('section'); host.dataset.evidenceTool = tool.id; this.node('review-panels').append(host); card.reviewHost = host;
              card.review = mountEvidencePanel(host, controller.evidence, () => this.showView('research'));
            } else { const note = document.createElement('p'); note.textContent = reason; card.body.append(note); }
          }
          const reviewLink = card.body.querySelector<HTMLButtonElement>('[data-action="open-review"]');
          if (reviewLink && reviewSummary) reviewLink.textContent = reviewSummary.status === 'completed'
            ? `View Jev result · ${reviewSummary.completedPairs} checked →`
            : reviewSummary.status === 'reviewing' ? 'Jev is reviewing · View progress →' : 'Open Jev review →';
        }
        card.review?.update();
        card.article.hidden = tool.name === 'text_chat' && tool.status === 'completed';
        if (card.reviewHost) card.reviewHost.hidden = !controller.evidence.open || controller.evidence.detail?.toolCallId !== tool.id;
      }
      const taskDetails = this.node<HTMLDetailsElement>('tool-history');
      taskDetails.hidden = !visibleTools.some(tool => tool.name !== 'research_run' && !(tool.name === 'text_chat' && tool.status === 'completed'));
      const attention = visibleTools.filter(tool => tool.name !== 'research_run' && (tool.approval || tool.status === 'failed')).map(tool => tool.id).join(',');
      if (attention && taskDetails.dataset.attention !== attention) taskDetails.open = true;
      taskDetails.dataset.attention = attention;
      const view = controller.sidebarView;
      for (const name of ['chat', 'research', 'review'] as const) {
        this.node(`${name}-view`).hidden = view !== name;
        this.querySelector(`nav [data-action="view-${name}"]`)!.setAttribute('aria-pressed', String(view === name));
      }
      this.node('composer').hidden = view === 'review';
      this.node('voice-options').hidden = !active && (!this.voiceOptionsOpen || view !== 'chat');
      this.button('voice-options').setAttribute('aria-expanded', String(!this.node('voice-options').hidden));
      this.button('research').hidden = view !== 'research';
      this.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.hidden = view === 'research';
      this.querySelector<HTMLElement>('.radsysx-live-hint')!.textContent = view === 'research' ? 'Enter to research' : 'Enter to send';
      textarea.placeholder = view === 'research' ? 'Enter a public literature question…' : 'Ask about this case or describe a finding…';
      this.node('research-empty').hidden = visibleTools.some(tool => tool.name === 'research_run');
      this.node('research-count').textContent = allTools.filter(tool => tool.name === 'research_run').length ? String(allTools.filter(tool => tool.name === 'research_run').length) : '';
      this.node('evidence-entry').hidden = Boolean(controller.evidence.open && controller.evidence.detail);
      this.node('review-message').textContent = controller.evidence.open && !controller.evidence.detail ? controller.evidence.busy ? 'Preparing the review…' : controller.evidence.message : '';
      this.node('sources').innerHTML = controller.citations.length ? '<strong>Sources</strong>' + controller.citations.map(source => `<a href="${escape(source.url)}" target="_blank" rel="noopener noreferrer">${escape(source.title)} ↗</a>`).join('') : '';
      if (this.suggestionSignature !== controller.suggestionsHtml) {
        this.suggestionSignature = controller.suggestionsHtml; this.node('suggestions').replaceChildren();
        if (controller.suggestionsHtml) {
          const frame = document.createElement('iframe'); frame.title = 'Google Search suggestions';
          frame.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox'); frame.referrerPolicy = 'no-referrer';
          frame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; base-uri 'none'; form-action 'none'"><body>${controller.suggestionsHtml}</body>`;
          this.node('suggestions').append(frame);
        }
      }
      this.node('history').hidden = !controller.historyOpen;
      this.node('history').innerHTML = '<strong>Saved conversations</strong>' + (controller.history.length ? controller.history.map((session, index) => `<div><button type="button" data-action="read-history" data-id="${escape(session.sessionId)}">Conversation ${index + 1} · ${escape(session.status)}</button><button type="button" data-action="clear-history" data-id="${escape(session.sessionId)}" aria-label="Clear conversation ${index + 1}">Clear</button></div>`).join('') : '<p>No saved conversations yet.</p>');
    }
  }
  if (!customElements.get('radsysx-ai-chat-panel')) customElements.define('radsysx-ai-chat-panel', LivePanel);
}
