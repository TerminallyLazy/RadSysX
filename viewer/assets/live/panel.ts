import { LiveController } from './controller.js';
import { escape, object, safeUrl, type Attestation, type Json, type ProviderId } from './protocol.js';

const MIC = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg>';

/** Inputs are created once; live transcript updates must never replace an edited password field. */
export function credentialSettingsMarkup(): string {
  return `<section class="radsysx-live-credentials" data-role="credentials" role="dialog" aria-modal="true" aria-label="API keys" hidden>
    <header><div><span class="radsysx-panel-kicker">ASSISTANT SETTINGS</span><h3>API keys</h3></div><button type="button" data-action="close-credentials" aria-label="Close API key settings">×</button></header>
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
    private toolSignature = '';
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
              <div><span class="radsysx-panel-kicker">RADSYSX AI</span><h2>Talk it through.</h2></div>
              <div class="radsysx-live-header-actions"><button type="button" class="radsysx-live-settings-button" data-action="credentials" aria-haspopup="dialog">API keys</button><button type="button" class="radsysx-live-icon" data-action="history" title="Conversation history" aria-label="Conversation history">↺</button></div>
            </header>
            <div class="radsysx-live-model"><span class="radsysx-live-dot"></span><select data-role="provider" aria-label="AI provider" style="max-width:6.5rem;background:#102523;color:#dffcf4;border:1px solid #46625e;border-radius:4px;padding:3px"></select><span data-role="model"></span></div>
            <section class="radsysx-live-setup" data-role="setup">
              <label for="radsysx-live-attestation">The displayed data is</label>
              <select id="radsysx-live-attestation" aria-label="Displayed data confirmation">
                <option value="">Choose before connecting</option><option value="synthetic">Synthetic / test data</option><option value="deidentified">Deidentified data</option>
              </select>
              <p data-role="disclosure"></p>
              <button type="button" class="radsysx-live-primary" data-action="connect">Connect assistant</button>
            </section>
            <section class="radsysx-ai-voice-card radsysx-live-voice" data-listening="false">
              <button type="button" class="radsysx-ai-voice-button" data-action="voice" title="Enable microphone" aria-label="Enable microphone">${MIC}</button>
              <div class="radsysx-ai-voice-copy"><strong data-role="voice-label">Microphone off</strong><div data-role="interaction">Ready when you are</div></div>
              <button type="button" class="radsysx-live-icon" data-action="stop-speaking" title="Stop speaking" aria-label="Stop speaking">■</button>
            </section>
            <div class="radsysx-live-controls"><button type="button" data-action="share">Share active image</button><button type="button" data-action="end">End session</button></div>
            <p class="radsysx-live-status" data-role="capture-scope" title="Shares the selected image viewport, not the whole app screen or other windows."></p>
            <p class="radsysx-live-status" role="status" aria-live="polite" data-role="status"></p>
            <div class="radsysx-live-conversation" data-role="conversation">
            <section class="radsysx-live-history" data-role="history" hidden></section>
            <div class="radsysx-ai-thread" role="log" aria-label="RadSysX AI conversation" data-role="thread"><div class="radsysx-live-empty">A second set of hands.<br><span>Discuss the image, change a view, or research a question.</span></div></div>
            <section class="radsysx-live-report" data-role="report" aria-label="Draft report" hidden></section>
            <section class="radsysx-live-tools" data-role="tools" aria-label="Assistant actions"></section>
            <section class="radsysx-live-sources" data-role="sources" aria-label="Research sources"></section>
            <div data-role="suggestions"></div>
            </div>
            <form class="radsysx-ai-composer">
              <div class="radsysx-ai-attachment-row" data-role="selected"></div>
              <div class="radsysx-ai-mention-menu" data-role="attachments" data-open="false"></div>
              <textarea rows="3" aria-label="RadSysX AI message" placeholder="Ask about the image, or use @ to attach context"></textarea>
              <div class="radsysx-ai-composer-footer"><button class="radsysx-ai-icon-button" type="button" data-action="toggle-mention" aria-label="Attach viewer context" title="Attach viewer context">@</button><span class="radsysx-live-hint">Enter to send</span><button class="radsysx-ai-send-button" type="submit" aria-label="Send message">↑</button></div>
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
          else if (action === 'end') void controller.end();
          else if (action === 'credentials') { void controller.showCredentials(); this.button('close-credentials').focus(); }
          else if (action === 'close-credentials') { this.clearKeyInputs(); controller.closeCredentials(); this.button('credentials').focus(); }
          else if (action === 'reload-credentials') void controller.loadCredentials();
          else if (action === 'remove-key') { this.clearKeyInputs(); void controller.removeCredential(button.dataset.provider as ProviderId); }
          else if (action === 'undo-draft') void controller.adapter.execute('viewer_undo', {}).then(() => controller.emit());
          else if (action === 'history') void controller.showHistory();
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
        this.node<HTMLSelectElement>('provider').addEventListener('change', event => void controller.selectProvider((event.target as HTMLSelectElement).value as ProviderId));
        this.querySelector('#radsysx-live-attestation')!.addEventListener('change', event => { this.attestation = (event.target as HTMLSelectElement).value as Attestation || undefined; });
        this.querySelector('textarea')!.addEventListener('input', event => { controller.draft = (event.target as HTMLTextAreaElement).value; if (/(^|\s)@$/.test(controller.draft)) { this.mentionOpen = true; this.render(); } });
        this.querySelector('textarea')!.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void controller.sendText(); } });
        this.querySelector('.radsysx-ai-composer')!.addEventListener('submit', event => { event.preventDefault(); void controller.sendText(); });
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
            const controls = Array.from(this.node('credentials').querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')).filter(node => !node.hidden && !node.closest('[hidden]'));
            const first = controls[0], last = controls.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
          }
        });
      }
      this.unsubscribe = controller.subscribe(() => this.render());
    }
    disconnectedCallback(): void { this.clearKeyInputs(); this.unsubscribe?.(); this.unsubscribe = undefined; }
    private clearKeyInputs(): void { this.querySelectorAll<HTMLInputElement>('input[data-key-provider]').forEach(input => { input.value = ''; }); }
    private renderCredentials(): void {
      if (this.credentialInputEpoch !== controller.credentialInputEpoch) { this.credentialInputEpoch = controller.credentialInputEpoch; this.clearKeyInputs(); }
      this.node('credentials').hidden = !controller.credentialsOpen;
      this.querySelectorAll<HTMLElement>('.radsysx-live-shell > *').forEach(node => { if (node !== this.node('credentials')) node.inert = controller.credentialsOpen; });
      this.button('credentials').setAttribute('aria-expanded', String(controller.credentialsOpen));
      this.node('credential-message').textContent = controller.credentialMessage;
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
      this.node('model').textContent = controller.model.replace('gemini-', '').replace(/-/g, ' ');
      this.node('disclosure').textContent = `Voice, text and shared images are sent to ${controller.provider?.label ?? 'the selected provider'}. Audio and screen frames are not saved to history.`;
      this.dataset.connection = controller.status;
      this.node('setup').hidden = ['connecting', 'ready', 'reconnecting'].includes(controller.status);
      this.button('connect').disabled = controller.credentialsBusy || controller.status === 'loading';
      this.button('connect').textContent = controller.providers.length ? 'Connect assistant' : 'Retry assistant setup';
      this.node('status').textContent = controller.message;
      this.node('voice-label').textContent = controller.audio.listening ? 'Listening to you' : 'Microphone off';
      this.node('interaction').textContent = controller.ready && controller.interaction === 'IN_PROGRESS' ? 'Thinking and working with you' : controller.ready ? 'Connected · interrupt anytime' : 'Ready when you are';
      this.querySelector('.radsysx-ai-voice-card')!.setAttribute('data-listening', String(controller.audio.listening));
      this.button('voice').disabled = !controller.ready;
      this.button('voice').setAttribute('aria-pressed', String(controller.audio.listening));
      this.button('voice').setAttribute('aria-label', controller.audio.listening ? 'Pause microphone' : 'Enable microphone');
      this.button('share').disabled = !controller.ready || !controller.activeProvider?.screen;
      this.button('share').textContent = controller.sharing ? '● Stop image sharing' : 'Share active image';
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
      const visibleTools = [...controller.tools.values()].slice(-12);
      const toolSignature = JSON.stringify([visibleTools, controller.historical]);
      if (toolSignature !== this.toolSignature) {
        this.toolSignature = toolSignature;
        this.node('tools').innerHTML = visibleTools.map(tool => {
          const pending = !controller.historical && !['completed', 'failed', 'cancelled', 'declined', 'rejected', 'denied', 'interrupted', 'outcome_unknown'].includes(tool.status);
          return `<article class="radsysx-live-tool"><div><strong>${escape(tool.name.replace(/_/g, ' '))}</strong><span>${escape(tool.status)}</span></div><details${tool.approval ? ' open' : ''}><summary>${tool.approval ? 'Review this action' : 'Details'}</summary><pre>${escape(JSON.stringify(tool.args, null, 2))}</pre></details>${renderToolResult(tool.result)}${tool.approval ? `<div class="radsysx-live-review"><button type="button" data-action="approve" data-id="${escape(tool.id)}">Approve</button><button type="button" data-action="decline" data-id="${escape(tool.id)}">Decline</button></div>` : pending ? `<button type="button" data-action="cancel" data-id="${escape(tool.id)}">Cancel task</button>` : ''}</article>`;
        }).join('');
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
