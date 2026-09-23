import { evidenceEligibility, mountEvidencePanel } from './evidence-panel.js';
import { LiveController } from './controller.js';
import { escape, object, safeUrl, type Attestation, type Json, type ProviderId, type ResearchProviderId, type Tool } from './protocol.js';

const MIC = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg>';

export function researchStatus(tool: Tool): string {
  if (tool.status === 'failed' && tool.result?.error === 'research_timeout') return 'Timed out';
  if (tool.status !== 'running') return ({ pending: 'Queued', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted', outcome_unknown: 'Status unconfirmed' } as Record<string, string>)[tool.status] ?? tool.status;
  return ({ queued: 'Waiting for a model slot', starting: 'Starting research', waiting_model: 'Waiting for model response', searching_web: 'Searching the web', searching_pubmed: 'Searching PubMed', reading_source: 'Reading a source', synthesizing: 'Preparing the cited answer' } as Record<string, string>)[tool.progress ?? ''] ?? 'Research running';
}

export function renderResearchActivity(tool: Tool): string {
  const provider = tool.research?.providerId === 'nvidia_nim' ? 'NVIDIA NIM' : tool.research?.providerId === 'gemini' ? 'Gemini' : 'Provider not recorded';
  return `<p class="radsysx-research-model">${escape(provider)}${tool.research?.modelId ? ` · ${escape(tool.research.modelId)}` : ''}</p>
    <p role="status" aria-live="polite">${escape(researchStatus(tool))}</p>
    <details><summary>Request and model</summary><p>${escape(tool.args.query)}</p><p>Requested model recorded: ${escape(tool.research?.recordedAt ?? 'Not recorded')}</p></details>`;
}

/** Inputs are created once; live transcript updates must never replace an edited password field. */
export function credentialSettingsMarkup(): string {
  return `<section class="radsysx-live-credentials" data-role="credentials" role="dialog" aria-modal="true" aria-label="Assistant settings" hidden>
    <header><div><span class="radsysx-panel-kicker">ASSISTANT SETTINGS</span><h3>Settings</h3></div><button type="button" data-action="close-credentials" aria-label="Close assistant settings">×</button></header>
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
  return `<div class="radsysx-live-research-result"><p>${escape(result.summary)}</p>${limitations.length ? `<ul>${limitations.map(item => `<li>${escape(item)}</li>`).join('')}</ul>` : ''}${sources.join('')}</div>`;
}

export function registerPanel(controller: LiveController): void {
  class LivePanel extends HTMLElement {
    private unsubscribe?: () => void;
    private attestation?: Attestation;
    private lastTarget = '';
    private attestationEpoch = -1;
    private mentionOpen = false;
    private threadSignature = '';
    private evidenceCards = new Map<string, { article: HTMLElement; body: HTMLElement; signature: string; review?: ReturnType<typeof mountEvidencePanel> }>();
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
              <div class="radsysx-live-brand"><span class="radsysx-live-dot"></span><span class="radsysx-panel-kicker">RADSYSX AI</span></div>
              <select data-role="provider" aria-label="AI provider"></select>
              <div class="radsysx-live-header-actions"><button type="button" class="radsysx-live-settings-button" data-action="credentials" aria-haspopup="dialog">Settings</button><button type="button" class="radsysx-live-icon" data-action="history" title="Conversation history" aria-label="Conversation history">↺</button></div>
            </header>
            <section class="radsysx-live-setup" data-role="setup">
              <div class="radsysx-live-connect-row">
              <select id="radsysx-live-attestation" aria-label="Displayed data confirmation">
                <option value="">Confirm displayed data…</option><option value="synthetic">Synthetic / test data</option><option value="deidentified">Deidentified data</option>
              </select>
              <button type="button" class="radsysx-live-primary" data-action="connect">Connect voice</button>
              </div>
              <p data-role="disclosure"></p><button type="button" data-action="end-text" hidden>End text conversation</button>
            </section>
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
            <p class="radsysx-live-status" role="status" aria-live="polite" data-role="status"></p>
            <div class="radsysx-live-conversation" data-role="conversation">
            <section class="radsysx-live-history" data-role="history" hidden></section>
            <section class="radsysx-evidence-entry" aria-label="Jev evidence review">
              <strong>Jev evidence review</strong>
              <p>Check claims for support, contradictions and gaps in their cited abstracts.</p>
              <button type="button" data-action="review-latest">Review latest evidence with Jev</button>
              <button type="button" data-action="history">Saved research</button>
              <p data-role="evidence-next" role="status" aria-live="polite"></p>
            </section>
            <section class="radsysx-live-tools" data-role="research-tools" aria-label="Research activity"></section>
            <div class="radsysx-ai-thread" role="log" aria-label="RadSysX AI conversation" data-role="thread"><div class="radsysx-live-empty">A second set of hands.<br><span>Discuss the image, change a view, or research a question.</span></div></div>
            <section class="radsysx-live-report" data-role="report" aria-label="Draft report" hidden></section>
            <section class="radsysx-live-tools" data-role="tools" aria-label="Assistant actions"></section>
            <section class="radsysx-live-sources" data-role="sources" aria-label="Research sources"></section>
            <div data-role="suggestions"></div>
            </div>
            <form class="radsysx-ai-composer">
              <div class="radsysx-ai-attachment-row" data-role="selected"></div>
              <div class="radsysx-ai-mention-menu" data-role="attachments" data-open="false"></div>
              <textarea rows="3" aria-label="RadSysX AI message" placeholder="Ask about this case, or enter a literature question"></textarea>
              <div class="radsysx-ai-composer-footer"><button class="radsysx-ai-icon-button" type="button" data-action="toggle-mention" aria-label="Attach viewer context" title="Attach viewer context">@</button><span class="radsysx-live-hint">Enter to send</span><button type="button" data-action="research">Research</button><button class="radsysx-ai-send-button" type="submit" aria-label="Send message">Send</button></div>
            </form>
            ${credentialSettingsMarkup()}
          </div>`;
        this.addEventListener('click', event => {
          const button = (event.target as Element).closest<HTMLButtonElement>('button');
          if (!button || button.disabled) return;
          const action = button.dataset.action;
          if (action === 'connect') void (controller.providers.length ? controller.connect(this.attestation) : controller.initialize());
          else if (action === 'voice') void controller.toggleMicrophone();
          else if (action === 'stop-speaking') controller.stopSpeaking();
          else if (action === 'share') void controller.toggleSharing();
          else if (action === 'end' || action === 'end-text') void controller.end();
          else if (action === 'research') void controller.research(this.attestation);
          else if (action === 'credentials') { void controller.showCredentials(); this.button('close-credentials').focus(); }
          else if (action === 'close-credentials') { this.clearKeyInputs(); controller.closeCredentials(); this.button('credentials').focus(); }
          else if (action === 'refresh-research-models') void controller.loadResearchModels(true);
          else if (action === 'reload-research-settings') void controller.loadResearchSettings();
          else if (action === 'reload-credentials') void controller.loadCredentials();
          else if (action === 'remove-key') { this.clearKeyInputs(); void controller.removeCredential(button.dataset.provider as ProviderId); }
          else if (action === 'undo-draft') void controller.adapter.execute('viewer_undo', {}).then(() => controller.emit());
          else if (action === 'history') void controller.showHistory();
          else if (action === 'review-latest') {
            const tool = [...controller.tools.values()].slice(-12).reverse().find(tool => !evidenceEligibility(tool));
            if (tool) void controller.evidence.openTool(tool.id).then(() => this.evidenceCards.get(tool.id)?.article.scrollIntoView({ block: 'nearest' }));
          }
          else if (action === 'toggle-mention') { this.mentionOpen = !this.mentionOpen; this.render(); }
          else if (action === 'attach' && button.dataset.id) { controller.selected.add(button.dataset.id); this.mentionOpen = false; this.render(); }
          else if (action === 'remove' && button.dataset.id) { controller.selected.delete(button.dataset.id); this.render(); }
          else if (action === 'approve') void controller.decide(button.dataset.id!, true);
          else if (action === 'decline') void controller.decide(button.dataset.id!, false);
          else if (action === 'cancel') void controller.cancel(button.dataset.id!);
          else if (action === 'read-history') void controller.readHistory(button.dataset.id!);
          else if (action === 'clear-history') {
            // Clearing durable history is explicit and separate from ending a call.
            if (window.confirm('Clear this saved conversation and its tool history?')) void controller.clearHistory(button.dataset.id!);
          }
        });
        this.node<HTMLSelectElement>('research-provider').addEventListener('change', event => void controller.selectResearchProvider((event.target as HTMLSelectElement).value as ResearchProviderId));
        this.node<HTMLSelectElement>('research-model').addEventListener('change', event => { controller.researchModelId = (event.target as HTMLSelectElement).value; controller.emit(); });
        this.node<HTMLFormElement>('research-settings-form').addEventListener('submit', event => { event.preventDefault(); void controller.saveResearchSettings(); });
        this.node<HTMLSelectElement>('provider').addEventListener('change', event => void controller.selectProvider((event.target as HTMLSelectElement).value as ProviderId));
        this.querySelector('#radsysx-live-attestation')!.addEventListener('change', event => { this.attestation = (event.target as HTMLSelectElement).value as Attestation || undefined; });
        this.querySelector('textarea')!.addEventListener('input', event => { controller.draft = (event.target as HTMLTextAreaElement).value; if (/(^|\s)@$/.test(controller.draft)) { this.mentionOpen = true; this.render(); } });
        this.querySelector('textarea')!.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void controller.sendText(this.attestation); } });
        this.querySelector('.radsysx-ai-composer')!.addEventListener('submit', event => { event.preventDefault(); void controller.sendText(this.attestation); });
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
    disconnectedCallback(): void { controller.evidence.dispose(); this.evidenceCards.forEach(card => card.review?.dispose()); this.evidenceCards.clear(); this.node('tools').replaceChildren(); this.clearKeyInputs(); this.unsubscribe?.(); this.unsubscribe = undefined; }
    private clearKeyInputs(): void { this.querySelectorAll<HTMLInputElement>('input[data-key-provider]').forEach(input => { input.value = ''; }); }
    private renderCredentials(): void {
      if (this.credentialInputEpoch !== controller.credentialInputEpoch) { this.credentialInputEpoch = controller.credentialInputEpoch; this.clearKeyInputs(); }
      this.node('credentials').hidden = !controller.credentialsOpen;
      this.querySelectorAll<HTMLElement>('.radsysx-live-shell > *').forEach(node => { if (node !== this.node('credentials')) node.inert = controller.credentialsOpen; });
      this.button('credentials').setAttribute('aria-expanded', String(controller.credentialsOpen));
      this.node('credential-message').textContent = controller.credentialMessage;
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
      this.node('disclosure').textContent = `Text · ${controller.session?.mode === 'text' && controller.status === 'text_ready' ? controller.session.modelId : controller.researchSettings?.modelId ?? 'model in Settings'}. Sends your question and neutral case/series metadata; no image pixels. Optional voice · ${controller.provider?.label ?? 'choose a provider'}.`;
      this.button('end-text').hidden = controller.session?.mode !== 'text' || controller.status !== 'text_ready';
      this.button('research').disabled = controller.textBusy || controller.credentialsBusy || controller.status === 'loading';
      this.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.disabled = controller.textBusy || controller.credentialsBusy || controller.status === 'loading';
      this.dataset.connection = controller.status;
      const active = ['connecting', 'ready', 'reconnecting'].includes(controller.status);
      this.node('setup').hidden = active;
      this.node('session-controls').hidden = !active;
      this.button('connect').disabled = controller.credentialsBusy || controller.status === 'loading';
      this.button('connect').textContent = controller.providers.length ? 'Connect voice' : 'Retry setup';
      this.node('status').textContent = controller.message;
      this.node('status').hidden = !controller.message || controller.message === 'Confirm the displayed data to begin.';
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
      const signature = JSON.stringify(transcripts);
      if (signature !== this.threadSignature) {
        const thread = this.node('thread'); const scrollContainer = this.node('conversation'); const scroll = scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight < 80;
        thread.innerHTML = transcripts.length ? transcripts.map(item => `<article class="radsysx-ai-message" data-role="${item.role === 'user' ? 'user' : 'assistant'}"><div class="radsysx-ai-message-role">${item.role === 'user' ? 'You' : 'RadSysX AI'}</div><div class="radsysx-ai-message-body">${escape(item.text)}</div></article>`).join('') : '<div class="radsysx-live-empty">Start a conversation to see its transcript.</div>';
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
      this.node('evidence-next').textContent = eligible ? 'Preview the selected claims and original abstracts before anything is sent to Jev.' : researching ? 'Research is in progress below. Jev review becomes available when cited abstracts arrive.' : 'Enter a public literature question and choose Research. Then review its cited abstracts here.';
      const visibleIds = new Set(visibleTools.map(tool => tool.id));
      for (const [id, card] of this.evidenceCards) if (!visibleIds.has(id)) { card.review?.dispose(); card.article.remove(); this.evidenceCards.delete(id); }
      for (const tool of visibleTools) {
        let card = this.evidenceCards.get(tool.id);
        if (!card) {
          const article = document.createElement('article'); article.className = 'radsysx-live-tool';
          const body = document.createElement('div'); body.className = 'radsysx-live-tool-body'; article.append(body); this.node(['research_run', 'text_chat'].includes(tool.name) ? 'research-tools' : 'tools').append(article);
          card = { article, body, signature: '' }; this.evidenceCards.set(tool.id, card);
        }
        const signature = JSON.stringify([tool, controller.historical]);
        if (signature !== card.signature) {
          card.signature = signature;
          const pending = !controller.historical && !['completed', 'failed', 'cancelled', 'declined', 'rejected', 'denied', 'interrupted', 'outcome_unknown'].includes(tool.status);
          card.body.innerHTML = `<div><strong>${tool.name === 'research_run' ? 'Literature research' : escape(tool.name.replace(/_/g, ' '))}</strong><span>${escape(tool.status)}</span></div>${['research_run', 'text_chat'].includes(tool.name) ? renderResearchActivity(tool) : `<details${tool.approval ? ' open' : ''}><summary>${tool.approval ? 'Review this action' : 'Details'}</summary><pre>${escape(JSON.stringify(tool.args, null, 2))}</pre></details>`}${tool.name === 'text_chat' && tool.status === 'completed' ? '' : renderToolResult(tool.result)}${tool.approval ? `<div class="radsysx-live-review"><button type="button" data-action="approve" data-id="${escape(tool.id)}">Approve</button><button type="button" data-action="decline" data-id="${escape(tool.id)}">Decline</button></div>` : pending ? `<button type="button" data-action="cancel" data-id="${escape(tool.id)}">Cancel task</button>` : ''}`;
          if (tool.name === 'research_run' && !card.review) {
            const reason = evidenceEligibility(tool);
            if (!reason) {
              const host = document.createElement('section'); host.dataset.evidenceTool = tool.id; card.article.append(host);
              card.review = mountEvidencePanel(host, controller.evidence);
            } else { const note = document.createElement('p'); note.textContent = reason; card.body.append(note); }
          }
        }
        card.review?.update();
      }
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
