import { LiveAudio } from './audio.js';
import { OHIFAdapter } from './ohif.js';
import { EventGate, TranscriptStore, object, parseEvent, request, safeUrl, toolFromWire, type AICredentialStatusResponse, type Attestation, type ProviderId, type ProviderProfile, type AudioChunk, type CaptureRequest, type Citation, type DesktopCapture, type Json, type ServerEvent, type Session, type SavedConversation, type Tool } from './protocol.js';

export class LiveController {
  status = 'loading';
  message = 'Checking assistant configuration…';
  availability = 'unavailable';
  model = 'gemini-3.8-live-extended-thinking';
  providerId: ProviderId = 'gemini';
  providers: ProviderProfile[] = [];
  activeProvider?: Readonly<ProviderProfile>;
  credentials?: AICredentialStatusResponse;
  credentialsOpen = false;
  credentialsLoading = false;
  credentialsBusy = false;
  credentialInputEpoch = 0;
  credentialMessage = '';
  private providerChange = 0;
  private initializing = false;
  private nextAudioChunk?: AudioChunk;
  session?: Session;
  contextVersion = 0;
  targetId = '';
  attestation?: Attestation;
  attestationEpoch = 0;
  interaction = 'IDLE';
  draft = '';
  selected = new Set<string>();
  transcript = new TranscriptStore();
  tools = new Map<string, Tool>();
  citations: Citation[] = [];
  suggestionsHtml = '';
  history: Session[] = [];
  sharing = false;
  sharingConfirmed = false;
  imageReceived = false;
  historyOpen = false;
  historical = false;
  audio = new LiveAudio();
  private socket?: WebSocket;
  private recoverySessionId?: string;
  private viewedHistoryId?: string;
  private gate?: EventGate;
  private listeners = new Set<() => void>();
  private generation = 0;
  private captureTimer?: ReturnType<typeof setTimeout>;
  private contextTimer?: ReturnType<typeof setTimeout>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private transcriptTimers = new Set<ReturnType<typeof setTimeout>>();
  private leaseId?: string;
  private captureEpoch = 0;
  private suppressOutput = false;
  private reconnectAttempts = 0;
  private actionQueue: Promise<void> = Promise.resolve();
  private executed = new Set<string>();
  private syncedState = '';
  private stateSync: Promise<void> = Promise.resolve();
  private closed = false;
  private authTimer: ReturnType<typeof setInterval>;

  constructor(readonly adapter: OHIFAdapter, private browser: Window = window) {
    this.audio.onInput = data => {
      if (this.ready && this.socket!.bufferedAmount < 128000) this.socket!.send(data);
      else if (this.audio.listening && this.socket && this.socket.bufferedAmount >= 128000) {
        this.audio.stopInput(); this.message = 'Microphone paused: connection is falling behind.'; this.emit();
      }
    };
    this.audio.onInputEnded = () => { this.send({ kind: 'audio_end' }); this.updateMediaMessage(); this.emit(); };
    this.audio.onPlaybackStopped = stops => {
      if (this.activeProvider?.id === 'openai') stops.forEach(stop => this.send({ kind: 'playback_stop', ...stop }));
      this.nextAudioChunk = undefined;
    };
    this.audio.onOverflow = () => {
      this.suppressOutput = true; this.clearPendingTranscripts(); this.transcript.interrupt();
      this.message = 'Playback stopped because the audio buffer reached its limit. Ask for a shorter reply.'; this.emit();
    };
    adapter.onChange = () => {
      clearTimeout(this.contextTimer);
      if (this.targetId && adapter.context().targetId !== this.targetId) { void this.refreshContext(); return; }
      this.contextTimer = setTimeout(() => void this.refreshContext(), 200);
    };
    browser.addEventListener('pagehide', () => this.dispose());
    browser.addEventListener('beforeunload', () => this.dispose());
    // Cookie expiration/logout must stop an otherwise healthy long-running socket.
    this.authTimer = setInterval(async () => {
      if (!this.session || this.closed) return;
      try {
        const auth = await request<{ authenticated: boolean }>('/api/auth/session');
        if (!auth.authenticated) { await this.end(); this.status = 'unavailable'; this.message = 'Sign in to reconnect.'; this.emit(); }
      } catch { /* The WebSocket owns transient connection recovery. */ }
    }, 15000);
    void this.initialize();
  }
  get ready(): boolean { return this.status === 'ready' && this.socket?.readyState === WebSocket.OPEN; }
  get backendStatus(): string { return this.ready ? 'ready' : this.status; }
  get backendSessionId(): string | null { return this.session?.sessionId ?? null; }
  get captureScope(): string {
    const state = this.adapter.context().state;
    const count = Number(state?.imageCount), index = Number(state?.index);
    if (!Number.isSafeInteger(count) || count < 1) return 'Open an image to share its active viewport.';
    const modality = typeof state.modality === 'string' && /^[A-Z]{1,8}$/.test(state.modality) ? `${state.modality} · ` : '';
    const position = Number.isSafeInteger(index) && index >= 0 && index < count ? index + 1 : 1;
    return `Active image only · ${modality}Image ${position} of ${count}`;
  }
  private updateMediaMessage(): void {
    if (!this.ready) return;
    const image = !this.sharing ? 'image sharing off' : !this.sharingConfirmed ? 'starting image sharing' : this.imageReceived ? 'image sharing on · image sent' : 'image sharing on · waiting for first image';
    this.message = `Connected · microphone ${this.audio.listening ? 'on' : 'off'} · ${image}`;
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); listener(); return () => this.listeners.delete(listener); }
  emit(): void { this.listeners.forEach(listener => listener()); }
  private base(id = this.session?.sessionId): string {
    if (!id) throw new Error('Start a session first.');
    return `/api/ai/sidebar/sessions/${encodeURIComponent(id)}`;
  }
  private captureBridge(): DesktopCapture | undefined { return (this.browser as any).radsysxDesktop; }
  async initialize(): Promise<void> {
    if (this.initializing) return;
    this.initializing = true; this.status = 'loading'; this.message = 'Checking assistant configuration…'; this.emit();
    try {
      const capabilities = await request<Json>('/api/ai/sidebar/capabilities');
      this.providers = (Array.isArray(capabilities.providers) ? capabilities.providers : []).flatMap(value => {
        const profile = object(value);
        if (!['gemini', 'openai'].includes(String(profile.id)) || ![16000, 24000].includes(Number(profile.inputSampleRate)) || profile.outputSampleRate !== 24000 || typeof profile.modelId !== 'string') return [];
        return [{ id: profile.id as ProviderId, label: String(profile.label), modelId: profile.modelId, availability: ['configured', 'disabled'].includes(String(profile.availability)) ? profile.availability as 'configured' | 'disabled' : 'unavailable', reason: String(profile.reason ?? ''), inputSampleRate: profile.inputSampleRate as 16000 | 24000, outputSampleRate: 24000, screen: profile.screen === true, tools: profile.tools === true }];
      });
      // Legacy Gemini-only fixtures remain compatible; never fabricate an OpenAI profile.
      if (!this.providers.length) this.providers = [{ id: 'gemini', label: 'Gemini', modelId: String(capabilities.modelId ?? this.model), availability: capabilities.availability === 'configured' ? 'configured' : 'unavailable', reason: String(capabilities.reason ?? 'Configure the backend Gemini key to enable live conversation.'), inputSampleRate: 16000, outputSampleRate: 24000, screen: true, tools: true }];
      if (!this.providers.some(profile => profile.id === this.providerId)) this.providerId = capabilities.defaultProviderId === 'openai' ? 'openai' : 'gemini';
      this.applyProviderSelection();
    } catch (error) { this.fail(error); }
    finally { this.initializing = false; }
    this.targetId = this.adapter.context().targetId;
    this.emit();
  }
  get provider(): ProviderProfile | undefined { return this.providers.find(profile => profile.id === this.providerId); }
  private applyProviderSelection(): void {
    const profile = this.provider;
    this.availability = profile?.availability ?? 'unavailable'; this.model = profile?.modelId ?? '';
    this.status = this.availability === 'configured' ? 'disconnected' : 'unavailable';
    this.message = this.availability === 'configured' ? 'Confirm the displayed data to begin.' : profile?.reason ?? 'This provider is unavailable.';
  }
  async selectProvider(id: ProviderId): Promise<void> {
    if (this.credentialsBusy || id === this.providerId || !this.providers.some(profile => profile.id === id)) return;
    const change = ++this.providerChange;
    await this.end();
    if (change !== this.providerChange) return;
    this.session = undefined; this.activeProvider = undefined; this.nextAudioChunk = undefined;
    this.providerId = id; this.requireAttestation(); this.selected.clear();
    this.transcript = new TranscriptStore(); this.tools.clear(); this.citations = []; this.suggestionsHtml = '';
    this.historical = false; this.viewedHistoryId = undefined; this.historyOpen = false;
    this.applyProviderSelection(); this.emit();
  }
  private sessionProfile(session: Session): Readonly<ProviderProfile> {
    const profile = this.provider;
    if (!profile || (session.providerId ?? 'gemini') !== profile.id || (session.modelId ?? (profile.id === 'gemini' ? profile.modelId : '')) !== profile.modelId) throw new Error('The session provider changed. Start a new conversation.');
    const inputSampleRate = session.inputSampleRate ?? (profile.id === 'gemini' ? 16000 : undefined);
    const outputSampleRate = session.outputSampleRate ?? (profile.id === 'gemini' ? 24000 : undefined);
    if (inputSampleRate !== profile.inputSampleRate || outputSampleRate !== 24000) throw new Error('Unsupported session audio format.');
    return Object.freeze({ ...profile, inputSampleRate, outputSampleRate });
  }
  async connect(attestation?: Attestation): Promise<void> {
    if (this.credentialsBusy || ['connecting', 'ready', 'reconnecting'].includes(this.status)) return;
    if (!attestation) { this.message = 'Confirm that the displayed image is synthetic or deidentified.'; this.emit(); return; }
    if (this.availability !== 'configured') { await this.initialize(); if (this.availability !== 'configured') return; }
    this.closed = false; this.interaction = 'IDLE'; this.status = 'connecting'; this.message = `Connecting ${this.provider?.label ?? 'AI'}…`; this.emit();
    const generation = ++this.generation;
    clearTimeout(this.reconnectTimer); this.socket?.close();
    try {
      await this.audio.prepare();
      const context = this.adapter.context();
      this.targetId = context.targetId; this.attestation = attestation;
      let session: Session | undefined, recovered: SavedConversation | undefined;
      if (this.recoverySessionId) {
        try {
          const saved = await request<SavedConversation>(this.base(this.recoverySessionId));
          const previous = saved.session;
          if (previous?.sessionId === this.recoverySessionId && previous.status !== 'closed' &&
              (previous.providerId ?? 'gemini') === this.providerId && (previous.modelId ?? (this.providerId === 'gemini' ? this.model : '')) === this.model &&
              previous.viewerContext?.targetId === context.targetId && previous.expiresAt && Date.parse(previous.expiresAt) > Date.now()) {
            session = await request<Session>(this.base(previous.sessionId) + '/context', {
              contextVersion: previous.contextVersion, viewerContext: context, attestation, providerId: this.providerId,
            });
            recovered = saved;
          }
        } catch { /* Missing, expired or no-longer-owned history requires a fresh authenticated allocation. */ }
      }
      session ??= await request<Session>('/api/ai/sidebar/sessions', { viewerContext: context, attestation, providerId: this.providerId });
      if (generation !== this.generation) { void request(this.base(session.sessionId) + '/close', {}); return; }
      const profile = this.sessionProfile(session);
      this.activeProvider = profile; this.audio.configure(profile.inputSampleRate, profile.outputSampleRate);
      this.nextAudioChunk = undefined;
      this.session = session; this.recoverySessionId = session.sessionId; this.contextVersion = session.contextVersion;
      this.syncedState = JSON.stringify(context.state);
      this.gate = new EventGate(session.sessionId, session.contextVersion);
      this.executed.clear(); this.tools.clear(); this.reconnectAttempts = 0;
      this.transcript = new TranscriptStore(); this.citations = []; this.suggestionsHtml = ''; this.historical = false; this.viewedHistoryId = undefined;
      if (recovered) {
        this.restoreConversation(recovered);
        for (const tool of recovered.tools ?? []) this.executed.add(String(tool.toolCallId));
        this.gate.sequence = Math.max(-1, ...recovered.events.map(event => Number.isSafeInteger(event.sequence) ? Number(event.sequence) : -1));
      }
      if (session.status === 'unavailable') throw new Error(session.message ?? 'Gemini is unavailable.');
      this.openSocket(generation);
    } catch (error) { this.fail(error); }
  }
  private openSocket(generation: number): void {
    if (!this.session || this.closed || generation !== this.generation) return;
    const url = new URL(this.session.liveUrl ?? this.base() + '/live', this.browser.location.origin);
    // The backend cannot redirect browser credentials/media to another origin.
    const httpProtocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol;
    if (`${httpProtocol}//${url.host}` !== this.browser.location.origin || !url.pathname.startsWith('/api/ai/sidebar/sessions/')) { this.fail(new Error('Invalid assistant transport URL.')); return; }
    url.protocol = this.browser.location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.nextAudioChunk = undefined;
    const socket = new WebSocket(url); socket.binaryType = 'arraybuffer'; this.socket = socket;
    socket.onmessage = ({ data }) => {
      if (socket !== this.socket || generation !== this.generation) return;
      if (data instanceof ArrayBuffer) {
        const metadata = this.nextAudioChunk; this.nextAudioChunk = undefined;
        if (this.ready && !this.suppressOutput && (this.activeProvider?.id !== 'openai' || metadata)) this.audio.play(data, metadata);
        return;
      }
      const event = typeof data === 'string' ? parseEvent(data) : null;
      if (event && this.gate?.accepts(event)) this.handle(event);
    };
    socket.onclose = () => {
      if (socket !== this.socket || generation !== this.generation || this.closed) return;
      this.credentialInputEpoch += 1; this.audio.close(); this.clearPendingTranscripts(); void this.stopSharing();
      this.interaction = 'IDLE';
      if (++this.reconnectAttempts <= 3) {
        this.status = 'reconnecting'; this.message = 'Connection interrupted. Reconnecting; microphone and sharing are paused.';
        this.reconnectTimer = setTimeout(() => this.openSocket(generation), Math.min(1000 * 2 ** (this.reconnectAttempts - 1), 8000));
      } else { this.requireAttestation(); this.status = 'disconnected'; this.message = 'Connection lost. Confirm the displayed data to recover this conversation.'; }
      this.emit();
    };
    socket.onerror = () => { this.message = 'Unable to reach the live assistant.'; this.emit(); };
  }
  private handle(event: ServerEvent): void {
    switch (event.kind) {
      case 'screen_status':
        this.sharingConfirmed = this.sharing && event.active === true;
        this.imageReceived = this.sharingConfirmed && event.frameReceived === true;
        if (event.active === false && this.sharing) void this.stopSharing(false);
        this.updateMediaMessage();
        break;
      case 'audio_chunk':
        this.nextAudioChunk = this.activeProvider?.id === 'openai' && typeof event.itemId === 'string' && Number.isSafeInteger(event.contentIndex) && Number(event.contentIndex) >= 0 ? { itemId: event.itemId, contentIndex: Number(event.contentIndex) } : undefined;
        break;
      case 'session':
        this.status = String(event.status);
        this.message = String(event.message ?? (event.status === 'ready' ? 'Connected · microphone and image sharing are off' : `Connecting ${this.activeProvider?.label ?? 'AI'}…`));
        if (event.status === 'ready') { this.reconnectAttempts = 0; this.suppressOutput = false; this.updateMediaMessage(); }
        if (['connecting', 'reconnecting'].includes(String(event.status))) {
          this.credentialInputEpoch += 1; this.audio.close(); this.clearPendingTranscripts(); this.transcript.interrupt(); void this.stopSharing();
          this.interaction = 'IDLE';
          this.message = `Reconnecting ${this.activeProvider?.label ?? 'AI'}; microphone and image sharing are paused.`;
        }
        if (['closed', 'unavailable', 'failed'].includes(String(event.status))) { this.requireAttestation(); this.closed = true; this.interaction = 'IDLE'; this.audio.close(); void this.stopSharing(); this.socket?.close(); }
        break;
      case 'interaction': this.interaction = String(event.status); if (event.status === 'IDLE') this.suppressOutput = false; break;
      case 'interrupted': this.stopSpeaking(false); break;
      case 'transcript': {
        const append = () => { this.transcript.append(String(event.role), String(event.text ?? ''), String(event.turnId ?? event.sequence), event.finished === true); this.emit(); };
        if (event.role === 'assistant' || event.role === 'model') {
          if (this.suppressOutput) break;
          const timer = setTimeout(() => { this.transcriptTimers.delete(timer); append(); }, this.audio.queuedMilliseconds);
          this.transcriptTimers.add(timer);
        } else append();
        break;
      }
      case 'tool': {
        const id = String(event.toolCallId);
        this.tools.set(id, toolFromWire(event));
        break;
      }
      case 'viewer_action': {
        if (!this.activeProvider?.tools) break;
        const version = this.contextVersion, generation = this.generation, target = this.targetId;
        this.actionQueue = this.actionQueue.then(async () => {
          const id = String(event.toolCallId);
          if (this.executed.has(id)) return;
          this.executed.add(id);
          if (['cancelled', 'denied', 'failed', 'interrupted'].includes(this.tools.get(id)?.status ?? '')) return;
          if (!this.ready || generation !== this.generation || version !== this.contextVersion || target !== this.adapter.context().targetId) return;
          try {
            const result = await this.adapter.execute(String(event.name), object(event.args));
            if (target === this.adapter.context().targetId) await this.syncState();
            if (generation === this.generation && version === this.contextVersion) this.send({ kind: 'action_result', toolCallId: id, status: 'completed', result });
          } catch (error) { this.send({ kind: 'action_result', toolCallId: id, status: 'failed', result: { message: 'Viewer action could not be verified. Review the selected viewport.' } }); }
        });
        break;
      }
      case 'citations':
        this.citations = (Array.isArray(event.sources) ? event.sources : []).flatMap(item => {
          const source = object(item); const url = safeUrl(source.url ?? source.uri);
          return url ? [{ title: String(source.title ?? new URL(url).hostname), url }] : [];
        });
        this.suggestionsHtml = typeof event.suggestionsHtml === 'string' ? event.suggestionsHtml : '';
        break;
      case 'error': this.message = String(event.message ?? 'The assistant encountered an error.'); break;
    }
    this.emit();
  }
  send(event: Json): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ ...event, contextVersion: this.contextVersion }));
  }
  async sendText(): Promise<void> {
    const draft = this.draft.trim();
    if (!draft && !this.selected.size) return;
    if (!this.ready) { this.message = 'Your draft is kept here. Connect to send it.'; this.emit(); return; }
    const context = this.adapter.context();
    if (context.targetId !== this.targetId) { await this.refreshContext(); return; }
    try { await this.syncState(); } catch (error) { this.failMessage(error); this.emit(); return; }
    if (!this.ready || this.adapter.context().targetId !== this.targetId) return;
    const attachments = this.adapter.attachments().filter(item => this.selected.has(item.id));
    const suffix = attachments.length ? '\nSelected viewer context: ' + JSON.stringify(attachments.map(item => item.summary)) : '';
    this.suppressOutput = false; this.send({ kind: 'text', text: draft + suffix }); this.draft = ''; this.selected.clear(); this.emit();
  }
  async toggleMicrophone(): Promise<void> {
    if (this.audio.listening) { this.audio.stopInput(); this.send({ kind: 'audio_end' }); this.updateMediaMessage(); this.emit(); return; }
    if (!this.ready) { this.message = 'Connect before enabling the microphone.'; this.emit(); return; }
    try {
      const base = (this.browser as any).__RADSYSX_VIEWER_BASE_PATH__ ?? '/viewer';
      await this.audio.startInput(`${base}/radsysx-audio-worklet.js`);
      this.updateMediaMessage();
    } catch { this.message = 'Microphone could not start. Check system microphone access or use the text composer.'; }
    this.emit();
  }
  stopSpeaking(suppress = true): void { this.nextAudioChunk = undefined; this.suppressOutput = suppress; this.audio.stopOutput(); this.clearPendingTranscripts(); this.transcript.interrupt(); this.emit(); }
  private clearPendingTranscripts(): void { this.transcriptTimers.forEach(timer => clearTimeout(timer)); this.transcriptTimers.clear(); }
  async toggleSharing(): Promise<void> {
    if (this.sharing) return this.stopSharing();
    const bridge = this.captureBridge();
    if (!bridge?.startViewerCapture) { this.message = 'Image sharing is available in the RadSysX desktop app.'; this.emit(); return; }
    if (!this.activeProvider?.screen) { this.message = 'This provider does not support image sharing.'; this.emit(); return; }
    if (!this.ready || !this.attestation) { this.message = 'Confirm the displayed data and connect before sharing.'; this.emit(); return; }
    const generation = this.generation, epoch = ++this.captureEpoch;
    this.sharing = true; this.sharingConfirmed = false; this.imageReceived = false; this.updateMediaMessage(); this.emit();
    try {
      const capture = this.captureRequest();
      const lease = await bridge.startViewerCapture(capture);
      if (generation !== this.generation || epoch !== this.captureEpoch || !this.sharing || !this.ready) { await bridge.stopViewerCapture({ leaseId: lease.leaseId }); return; }
      this.leaseId = lease.leaseId; this.sharing = true;
      this.send({ kind: 'screen_sharing', active: true });
      this.captureTimer = setTimeout(() => void this.captureFrame(generation, epoch), 0); this.emit();
    } catch { if (epoch !== this.captureEpoch) return; await this.stopSharing(); this.message = 'The selected image could not be shared. Check the current image and data confirmation.'; this.emit(); }
  }
  private captureRequest(): CaptureRequest {
    if (!this.session || this.adapter.context().targetId !== this.targetId) throw new Error('Image context changed.');
    return { sessionId: this.session.sessionId, contextVersion: this.contextVersion, targetId: this.targetId, ...this.adapter.capture() };
  }
  private async captureFrame(generation: number, epoch: number): Promise<void> {
    if (!this.sharing || !this.ready || generation !== this.generation || epoch !== this.captureEpoch || !this.leaseId) return;
    try {
      const frame = await this.captureBridge()!.captureViewerFrame({ ...this.captureRequest(), leaseId: this.leaseId });
      if (!this.sharing || generation !== this.generation || epoch !== this.captureEpoch || frame.contextVersion !== this.contextVersion || frame.targetId !== this.targetId) return;
      if (this.socket!.bufferedAmount < 128000) this.send({ kind: 'screen', data: frame.data, mimeType: frame.mimeType });
      this.captureTimer = setTimeout(() => void this.captureFrame(generation, epoch), 1000);
    } catch { if (epoch !== this.captureEpoch) return; await this.stopSharing(); this.message = 'Image sharing stopped. Review the current viewport before sharing again.'; this.emit(); }
  }
  async stopSharing(notify = true): Promise<void> {
    const wasSharing = this.sharing || this.sharingConfirmed || Boolean(this.leaseId);
    this.captureEpoch += 1; this.sharing = false; clearTimeout(this.captureTimer);
    this.sharingConfirmed = false; this.imageReceived = false;
    if (notify && wasSharing) this.send({ kind: 'screen_sharing', active: false });
    const leaseId = this.leaseId; this.leaseId = undefined;
    this.updateMediaMessage();
    try { await this.captureBridge()?.stopViewerCapture?.({ leaseId }); } catch {}
    this.emit();
  }
  async refreshContext(): Promise<void> {
    const context = this.adapter.context();
    if (context.targetId === this.targetId) {
      if (this.ready) try { await this.syncState(); } catch (error) { this.failMessage(error); }
      this.emit(); return;
    }
    this.recoverySessionId = undefined; this.interaction = 'IDLE'; this.targetId = context.targetId; this.selected.clear(); this.requireAttestation();
    this.audio.close(); this.stopSpeaking(); await this.stopSharing();
    if (this.session && !this.closed) {
      const old = this.session;
      this.closed = true; this.generation += 1; this.socket?.close(); clearTimeout(this.reconnectTimer);
      try { this.session = await request<Session>(this.base(old.sessionId) + '/context', { contextVersion: this.contextVersion, viewerContext: context }); this.contextVersion = this.session.contextVersion; }
      catch { /* Reconnection allocates a clean session after fresh attestation. */ }
      this.status = 'disconnected'; this.message = 'Image changed. Confirm the new displayed data to reconnect.';
    }
    this.emit();
  }
  private async syncState(): Promise<void> {
    const work = this.stateSync.catch(() => {}).then(async () => {
      if (!this.session || !this.ready) return;
      const context = this.adapter.context();
      const signature = JSON.stringify(context.state);
      if (context.targetId !== this.targetId || signature === this.syncedState) return;
      const generation = this.generation;
      const session = await request<Session>(this.base() + '/context', { contextVersion: this.contextVersion, viewerContext: context });
      if (generation !== this.generation || context.targetId !== this.targetId) return;
      this.sessionProfile(session);
      this.session = session; this.contextVersion = session.contextVersion;
      if (this.gate) this.gate.contextVersion = session.contextVersion;
      this.syncedState = signature;
    });
    this.stateSync = work; return work;
  }
  async decide(id: string, approved: boolean): Promise<void> {
    try { await request(this.base() + `/tools/${encodeURIComponent(id)}/decision`, { contextVersion: this.contextVersion, approved }); const tool = this.tools.get(id); if (tool) { tool.approval = false; tool.status = approved ? 'approved' : 'declined'; } }
    catch (error) { this.failMessage(error); }
    this.emit();
  }
  async cancel(id: string): Promise<void> {
    try { await request(this.base() + `/tools/${encodeURIComponent(id)}/cancel`, { contextVersion: this.contextVersion }); const tool = this.tools.get(id); if (tool) tool.status = 'cancelled'; }
    catch (error) { this.failMessage(error); }
    this.emit();
  }
  async showHistory(): Promise<void> {
    this.historyOpen = !this.historyOpen;
    if (this.historyOpen) try { this.history = (await request<{ sessions: Session[] }>('/api/ai/sidebar/sessions')).sessions; } catch (error) { this.failMessage(error); }
    this.emit();
  }
  async readHistory(id: string): Promise<void> {
    try {
      // A historic transcript must never merge with audio from a live conversation.
      if (this.ready || this.status === 'connecting' || this.status === 'reconnecting') await this.end();
      const history = await request<SavedConversation>(this.base(id));
      this.restoreConversation(history);
      this.historyOpen = false; this.historical = true; this.viewedHistoryId = id; this.message = 'Viewing saved conversation. Audio and image frames are not recorded.';
    } catch (error) { this.failMessage(error); }
    this.emit();
  }
  private restoreConversation(history: SavedConversation): void {
    this.transcript = new TranscriptStore();
    history.events.filter(event => event.kind === 'transcript').slice(-600).forEach(event => this.transcript.append(String(event.role ?? 'assistant'), String(event.text ?? ''), String(event.turnId ?? event.sequence), Boolean(event.finished)));
    this.transcript.interrupt(); // A new provider may reuse turn IDs; never merge with interrupted saved speech.
    this.tools.clear();
    for (const entry of (history.tools ?? []).slice(-100)) this.tools.set(String(entry.toolCallId), toolFromWire(entry, true));
    this.citations = []; this.suggestionsHtml = '';
    const sources = history.events.filter(event => event.kind === 'citations').at(-1);
    if (sources) {
      this.citations = (Array.isArray(sources.sources) ? sources.sources : []).flatMap(item => {
        const source = object(item), url = safeUrl(source.url ?? source.uri);
        return url ? [{ title: String(source.title ?? new URL(url).hostname), url }] : [];
      });
      this.suggestionsHtml = typeof sources.suggestionsHtml === 'string' ? sources.suggestionsHtml : '';
    }
  }
  private requireAttestation(): void { this.attestation = undefined; this.attestationEpoch += 1; this.credentialInputEpoch += 1; }
  async showCredentials(): Promise<void> {
    this.credentialsOpen = true; this.emit();
    await this.loadCredentials();
  }
  closeCredentials(): void {
    this.credentialsOpen = false; this.credentialInputEpoch += 1; this.emit();
  }
  async loadCredentials(): Promise<void> {
    if (this.credentialsLoading || this.credentialsBusy) return;
    this.credentialsLoading = true; this.credentialMessage = 'Checking saved key status…'; this.emit();
    try {
      this.credentials = await request<AICredentialStatusResponse>('/api/ai/sidebar/credentials');
      this.credentialMessage = this.credentials.storageAvailable ? 'Keys are stored by the backend for your signed-in account. Saving a key does not verify provider access.' : 'Secure key storage is unavailable. Check local key storage permissions, then retry. Unreadable saved keys can still be removed.';
    } catch {
      this.credentials = undefined;
      this.credentialMessage = 'Unable to load API key settings. Check that you are signed in, then retry.';
    } finally { this.credentialsLoading = false; this.emit(); }
  }
  /** The key exists only in the caller's password input and this request, never controller state. */
  async saveCredential(id: ProviderId, apiKey: string): Promise<void> {
    await this.changeCredential(id, apiKey);
  }
  async removeCredential(id: ProviderId): Promise<void> { await this.changeCredential(id); }
  private async changeCredential(id: ProviderId, apiKey?: string): Promise<void> {
    const saving = apiKey !== undefined;
    this.credentialInputEpoch += 1;
    if (this.credentialsBusy || !['gemini', 'openai'].includes(id)) { this.emit(); return; }
    if (apiKey !== undefined && !apiKey.trim()) { this.credentialMessage = 'Enter an API key before saving.'; this.emit(); return; }
    if (saving && !this.credentials?.storageAvailable) { this.credentialMessage = 'Secure key storage is unavailable. Retry key settings before saving.'; this.emit(); return; }
    if (apiKey === undefined && this.credentials?.providers.find(provider => provider.id === id)?.source !== 'saved') { this.credentialMessage = 'There is no saved key to remove.'; this.emit(); return; }
    this.credentialsBusy = true; this.credentialMessage = 'Ending the current session and updating your key…'; this.requireAttestation(); this.emit();
    try {
      await this.end();
      this.session = undefined; this.activeProvider = undefined;
      this.credentials = await request<AICredentialStatusResponse>(`/api/ai/sidebar/credentials/${id}`, apiKey === undefined ? undefined : { apiKey: apiKey.trim() }, apiKey === undefined ? 'DELETE' : 'PUT');
      apiKey = undefined;
      await this.initialize();
      const provider = this.credentials.providers.find(profile => profile.id === id);
      this.credentialMessage = saving ? 'Key saved. Provider access has not been verified. Confirm the displayed data to connect.' : provider?.environmentConfigured ? 'Saved key removed. The app-configured key will be used for new sessions.' : 'Saved key removed. Add a key to use this provider.';
    } catch {
      this.credentialMessage = 'The key could not be updated. Check your sign-in, key format and secure storage configuration, then retry. Your session has ended.';
    } finally { apiKey = undefined; this.credentialsBusy = false; this.emit(); }
  }
  async clearHistory(id: string): Promise<void> {
    try {
      if (id === this.session?.sessionId) await this.end();
      await request(this.base(id), undefined, 'DELETE');
      if (id === this.viewedHistoryId || id === this.session?.sessionId) {
        this.transcript = new TranscriptStore(); this.tools.clear(); this.citations = []; this.suggestionsHtml = '';
        this.viewedHistoryId = undefined; this.historical = false; this.message = 'Conversation cleared.';
        if (id === this.session?.sessionId) this.session = undefined;
      }
      this.history = this.history.filter(session => session.sessionId !== id); this.emit();
    } catch (error) { this.failMessage(error); this.emit(); }
  }
  async end(): Promise<void> {
    this.credentialInputEpoch += 1; this.emit();
    this.recoverySessionId = undefined;
    this.closed = true; this.interaction = 'IDLE'; this.generation += 1; clearTimeout(this.reconnectTimer);
    this.audio.close(); this.stopSpeaking(); await this.stopSharing(); this.socket?.close(); this.socket = undefined;
    if (this.session) try { await request(this.base() + '/close', {}); } catch {}
    this.status = 'disconnected'; this.message = 'Session ended. Conversation history is saved locally.'; this.emit();
  }
  private failMessage(error: unknown): void { this.message = error instanceof Error ? error.message : 'The assistant is unavailable.'; }
  private fail(error: unknown): void { this.failMessage(error); this.status = 'unavailable'; this.audio.close(); this.emit(); }
  dispose(): void {
    this.credentialInputEpoch += 1; this.emit();
    clearInterval(this.authTimer);
    this.closed = true; this.generation += 1; clearTimeout(this.captureTimer); clearTimeout(this.contextTimer); clearTimeout(this.reconnectTimer);
    this.audio.close(); this.clearPendingTranscripts(); void this.stopSharing(); this.socket?.close();
    if (this.session) navigator.sendBeacon(this.base() + '/close', new Blob(['{}'], { type: 'application/json' }));
  }
}
