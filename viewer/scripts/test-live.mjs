import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventGate, TranscriptStore, parseEvent, safeUrl, toolFromWire } from '../.cache/live-runtime/protocol.js';
import { OHIFAdapter } from '../.cache/live-runtime/ohif.js';
import { LiveAudio } from '../.cache/live-runtime/audio.js';
import { LiveController } from '../.cache/live-runtime/controller.js';
import { credentialSettingsMarkup, renderToolResult, renderResearchActivity, researchStatus } from '../.cache/live-runtime/panel.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('research cards distinguish actual stages, recorded models, and terminal failures', () => {
  const tool = toolFromWire({ toolCallId: 'r1', name: 'research_run', status: 'running', args: { query: '<private>' }, research: { providerId: 'nvidia_nim', modelId: 'z-ai/glm-5.3-flash', recordedAt: 'synthetic timestamp' } });
  tool.progress = 'waiting_model';
  const html = renderResearchActivity(tool);
  assert.match(html, /NVIDIA NIM/); assert.match(html, /z-ai\/glm-5.3-flash/);
  assert.match(html, /Waiting for model response/); assert.match(html, /&lt;private&gt;/);
  assert.equal(researchStatus({ ...tool, progress: 'searching_pubmed' }), 'Searching PubMed');
  assert.equal(researchStatus({ ...tool, status: 'failed', result: { error: 'research_timeout' } }), 'Timed out');
  assert.equal(researchStatus({ ...tool, status: 'cancelled' }), 'Cancelled');
  assert.match(renderResearchActivity({ ...tool, research: undefined }), /Provider not recorded/);
});

test('wire gate rejects old context, another owner session, malformed sequence, and replay', () => {
  const gate = new EventGate('session-a', 2);
  assert.equal(parseEvent('{bad'), null);
  assert.equal(parseEvent(JSON.stringify({ kind: 'session', sessionId: 'a', sequence: '1', contextVersion: 2 })), null);
  const event = { kind: 'interaction', sessionId: 'session-a', contextVersion: 2, sequence: 4, status: 'IN_PROGRESS' };
  assert.equal(gate.accepts({ ...event, contextVersion: 1 }), false);
  assert.equal(gate.accepts({ ...event, sessionId: 'session-b' }), false);
  assert.equal(gate.accepts(event), true);
  assert.equal(gate.accepts(event), false);
  assert.equal(gate.accepts({ ...event, sequence: 5 }), true);
});

test('transcript roles, completion, and interrupt boundaries never merge stale speech into next turn', () => {
  const store = new TranscriptStore();
  store.append('user', 'Please ', 'one', false); store.append('user', 'help', 'one', true);
  store.append('assistant', 'Working', 'one', false); store.interrupt();
  store.append('assistant', 'New answer', 'one', true);
  assert.deepEqual(store.items.map(item => [item.role, item.text, item.finished]), [['user', 'Please help', true], ['assistant', 'Working', true], ['assistant', 'New answer', true]]);
});

test('citation URLs reject active schemes and embedded credentials', () => {
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('https://key:secret@example.org'), null);
  assert.equal(safeUrl('https://example.org/paper'), 'https://example.org/paper');
});

test('review controls appear only while approval is pending; receipts render escaped public research', () => {
  const input = { toolCallId: 'one', name: 'report_save', args: {}, requiresApproval: true };
  assert.equal(toolFromWire({ ...input, status: 'awaiting_approval' }).approval, true);
  for (const status of ['completed', 'denied', 'running', 'cancelled']) assert.equal(toolFromWire({ ...input, status }).approval, false);
  assert.equal(toolFromWire({ ...input, status: 'awaiting_approval' }, true).approval, false);
  const html = renderToolResult({ summary: '<script>private</script><SCRIPT>upper</SCRIPT>', limitations: ['Synthetic result only.'], sources: [{ title: 'Paper', url: 'https://example.org/paper' }, { title: 'Unsafe', url: 'javascript:alert(1)' }] });
  assert.match(html, /&lt;script&gt;/); assert.match(html, /Synthetic result only/); assert.match(html, /https:\/\/example.org\/paper/);
  assert.ok(html.includes('&lt;SCRIPT&gt;'));
  assert.ok(!html.toLowerCase().includes('<script'));
  assert.ok(!html.toLowerCase().includes('javascript:'));
});

function fixture() {
  const calls = [], listeners = new Map(); let index = 0;
  const browser = { location: { pathname: '/viewer/dicomlocal', origin: 'http://localhost:3000', protocol: 'http:', assign(url) { calls.push(['navigate', url]); } }, document: { querySelector() { return null; }, addEventListener(name, callback, capture) { listeners.set(name, { callback, capture }); }, removeEventListener(name) { listeners.delete(name); } } };
  const viewport = { getProperties: () => ({ voiRange: { lower: -160, upper: 239 } }), getCurrentImageIdIndex: () => index, getImageIds: () => ['one', 'two', 'three'], render() {}, element: { isConnected: true, getBoundingClientRect: () => ({ x: 100, y: 120, width: 800, height: 600 }) } };
  const grid = { displaySetInstanceUIDs: ['private-display-uid'] };
  const measurement = { uid: 'private-measurement-uid', displaySetInstanceUID: 'private-display-uid', toolName: 'Length', label: 'PRIVATE PATIENT LABEL', selected: true };
  const services = {
    viewportGridService: { getActiveViewportId: () => 'private-viewport-id', setActiveViewportId() {}, getState: () => ({ viewports: new Map([['private-viewport-id', grid]]) }) },
    cornerstoneViewportService: { getCornerstoneViewport: () => viewport },
    displaySetService: { activeDisplaySets: [{ displaySetInstanceUID: 'private-display-uid', SeriesInstanceUID: 'private-series-uid', StudyInstanceUID: 'private-study-uid', PatientName: 'PRIVATE PATIENT', Modality: 'CT', numImageFrames: 3 }] },
    measurementService: { getMeasurements: () => [measurement], getMeasurement: uid => uid === measurement.uid ? measurement : undefined, remove: uid => calls.push(['remove', uid]) },
    segmentationService: { getSegmentations: () => [] },
  };
  const managers = { servicesManager: { services }, extensionManager: {}, commandsManager: { runCommand(name, args, context) { calls.push([name, args, context]); if (name === 'jumpToImage') index = args.imageIndex; } } };
  const adapter = new OHIFAdapter(browser); adapter.bind(managers);
  return { adapter, calls, services, browser, listeners, viewport, managers };
}

test('model-visible OHIF state has only opaque handles and neutral labels', () => {
  const { adapter } = fixture(); const context = adapter.context();
  assert.equal(context.privacyClass, 'unknown');
  assert.equal(context.studyInstanceUID, undefined);
  assert.doesNotMatch(JSON.stringify(context), /private-|PRIVATE/);
  assert.equal(context.state.series[0].modality, 'CT');
  assert.equal(context.state.windowWidth, 400); assert.equal(context.state.windowCenter, 40);
  assert.match(adapter.attachments()[0].id, /^measurement-/);
});

test('manual active-viewport camera/image changes refresh context without forwarding other viewports', () => {
  const { adapter, listeners, viewport, managers } = fixture(); let changes = 0;
  adapter.onChange = () => changes++;
  const image = listeners.get('CORNERSTONE_STACK_NEW_IMAGE');
  assert.equal(image.capture, true);
  image.callback({ target: {} }); assert.equal(changes, 0);
  image.callback({ target: viewport.element }); assert.equal(changes, 1);
  adapter.bind(managers); assert.equal(listeners.size, 4);
});

test('viewer action uses the named OHIF seam and reports the resulting current slice', async () => {
  const { adapter, calls } = fixture();
  const result = await adapter.execute('viewer_jump_to_slice', { index: 2 });
  assert.equal(result.state.index, 2);
  assert.deepEqual(calls[0], ['jumpToImage', { imageIndex: 2 }, 'CORNERSTONE']);
  await assert.rejects(adapter.execute('viewer_jump_to_slice', { index: 3 }), /slice index/);
  await assert.rejects(adapter.execute('viewer_set_layout', { rows: 1.5, columns: 2 }), /integers/);
  await assert.rejects(adapter.execute('viewer_set_tool', { tool: 'storeSegmentation' }), /not available/);
  await assert.rejects(adapter.execute('run_javascript', { code: 'alert(1)' }), /Unsupported/);
});

test('selection resolves only an existing opaque series handle and capture uses active image bounds', async () => {
  const { adapter, calls } = fixture(); const context = adapter.context();
  await adapter.execute('viewer_open_series', { displaySetId: context.state.series[0].id });
  assert.equal(calls[0][0], 'setDisplaySetsForViewports');
  assert.equal(calls[0][1].viewportsToUpdate[0].displaySetInstanceUIDs[0], 'private-display-uid');
  await assert.rejects(adapter.execute('viewer_open_series', { displaySetId: 'private-display-uid' }), /Unknown/);
  assert.deepEqual(adapter.capture(), { viewportId: 'private-viewport-id', rect: { x: 100, y: 120, width: 800, height: 600 } });
});

test('local report draft remains unsaved and is reversible without a governed workspace', async () => {
  const { adapter } = fixture();
  assert.equal(adapter.draftReport, undefined);
  const result = await adapter.execute('report_draft', { findings: 'Synthetic finding.', impression: 'Synthetic impression.' });
  assert.equal(result.status, 'draft_only');
  assert.equal(adapter.draftReport.findings, 'Synthetic finding.');
  assert.equal(adapter.draftReport.targetId, adapter.context().targetId);
  await adapter.execute('viewer_undo', {}); assert.equal(adapter.draftReport, undefined);
  await adapter.execute('viewer_redo', {}); assert.equal(adapter.draftReport.impression, 'Synthetic impression.');
  await adapter.execute('viewer_undo', {}); assert.equal(adapter.draftReport, undefined);
});

test('report drafts and later annotation edits share undo and redo ordering', async () => {
  const { adapter, managers } = fixture(); const history = []; let position = 0;
  const memo = { push(entry) { history.splice(position); history.push(entry); position++; } };
  managers.extensionManager.getModuleEntry = () => ({ exports: { getCornerstoneLibraries: () => ({ cornerstone: { utilities: { HistoryMemo: { DefaultHistoryMemo: memo } } } }) } });
  managers.commandsManager.runCommand = name => {
    if (name === 'undo' && position) history[--position].restoreMemo(true);
    if (name === 'redo' && position < history.length) history[position++].restoreMemo(false);
  };
  await adapter.execute('report_draft', { findings: 'Synthetic draft.' });
  let annotationPresent = true; memo.push({ restoreMemo: undo => { annotationPresent = !undo; } });
  await adapter.execute('viewer_undo', {}); assert.equal(annotationPresent, false); assert.equal(adapter.draftReport.findings, 'Synthetic draft.');
  await adapter.execute('viewer_undo', {}); assert.equal(adapter.draftReport, undefined);
  await adapter.execute('viewer_redo', {}); assert.equal(adapter.draftReport.findings, 'Synthetic draft.'); assert.equal(annotationPresent, false);
  await adapter.execute('viewer_redo', {}); assert.equal(annotationPresent, true);
});

test('study navigation rejects arbitrary origins, routes, tokens and extra identifiers', async () => {
  const { adapter } = fixture();
  for (const url of ['https://external.example/viewer/?launch=opaque', '/worklist?launch=opaque', '/viewer/?launch=opaque&patient=123', '/viewer/?launch=opaque#bad', '/viewer/']) {
    await assert.rejects(adapter.execute('study_open', { url }), /Invalid governed viewer launch/);
  }
});

test('microphone worklet resamples 48 kHz into 20 ms little-endian PCM16 packets', () => {
  let Processor; const packets = [];
  vm.runInNewContext(fs.readFileSync(new URL('../.cache/live-runtime/audio-worklet.js', import.meta.url), 'utf8'), {
    sampleRate: 48000, AudioWorkletProcessor: class { port = { postMessage(data) { packets.push(data); } }; },
    registerProcessor(name, implementation) { assert.equal(name, 'radsysx-pcm-input'); Processor = implementation; },
  });
  const processor = new Processor();
  for (let index = 0; index < 75; index++) processor.process([[new Float32Array(128).fill(0.5)]]);
  assert.equal(packets.length, 10);
  assert.equal(packets[0].byteLength, 640);
  assert.equal(new DataView(packets[0]).getInt16(0, true), 16384);
});

class FakeAudioContext {
  state = 'running'; currentTime = 0; destination = {}; sources = []; buffers = [];
  async resume() {}
  createBuffer(_channels, length, rate) {
    const channel = new Float32Array(length);
    const buffer = { duration: length / rate, sampleRate: rate, getChannelData: () => channel };
    this.buffers.push(buffer); return buffer;
  }
  createBufferSource() {
    const source = { connect() {}, disconnect() {}, start(time) { this.startTime = time; }, stop() { this.stopped = true; }, stopped: false };
    this.sources.push(source); return source;
  }
}
test('ending a session replaces running research with owned terminal receipts or unconfirmed status', async () => {
  const originalFetch = globalThis.fetch;
  for (const unavailable of [false, true]) {
    globalThis.fetch = async url => {
      if (String(url).endsWith('/sessions/ending')) {
        if (unavailable) throw Error('offline');
        return new Response(JSON.stringify({ events: [], tools: [{ toolCallId: 'research', name: 'research_run', args: {}, status: 'cancelled' }] }));
      }
      return new Response(JSON.stringify({ availability: 'disabled', providers: [] }));
    };
    const { adapter, browser } = fixture();
    const controller = new LiveController(adapter, { ...browser, addEventListener() {} });
    try {
      await tick();
      controller.session = { sessionId: 'ending', contextVersion: 1, status: 'ready' };
      controller.tools.set('research', toolFromWire({ toolCallId: 'research', name: 'research_run', args: {}, status: 'running' }));
      await controller.end();
      assert.equal(controller.tools.get('research').status, unavailable ? 'outcome_unknown' : 'cancelled');
      assert.equal(controller.status, 'disconnected');
    } finally { controller.session = undefined; controller.dispose(); globalThis.fetch = originalFetch; }
  }
});
test('barge-in stops every scheduled audio buffer immediately', async () => {
  const previous = globalThis.AudioContext; globalThis.AudioContext = FakeAudioContext;
  try {
    const audio = new LiveAudio(); await audio.prepare(); audio.play(new ArrayBuffer(4800)); audio.play(new ArrayBuffer(4800));
    assert.equal(audio.context.sources.length, 2); audio.stopOutput();
    assert.equal(audio.context.sources.every(source => source.stopped), true);
    assert.equal(audio.queuedMilliseconds, 0);
  } finally { globalThis.AudioContext = previous; }
});

test('controller readiness, action receipts, provider reconnect, late capture and target changes are guarded', async () => {
  const originals = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket, AudioContext: globalThis.AudioContext };
  const sockets = [], requests = [];
  class Socket {
    static OPEN = 1; readyState = 1; bufferedAmount = 0; sent = [];
    constructor(url) { this.url = String(url); sockets.push(this); }
    send(data) { this.sent.push(data); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  globalThis.WebSocket = Socket; globalThis.AudioContext = FakeAudioContext;
  globalThis.fetch = async (url, init) => {
    requests.push([url, init]);
    const value = String(url).endsWith('/history-old') ? { events: [{ kind: 'transcript', role: 'user', turnId: 'old', text: 'Earlier question.', finished: true }, { kind: 'citations', sources: [{ title: 'Saved paper', url: 'https://example.org/saved' }] }], tools: [{ toolCallId: 'saved-tool', name: 'research_run', args: {}, status: 'completed', result: { summary: 'Saved evidence.' } }] } : String(url).endsWith('/capabilities') ? { availability: 'configured' } : String(url).endsWith('/context') ? { sessionId: 's', status: 'allocated', contextVersion: JSON.parse(init.body).viewerContext.targetId === 'target-1' ? 1 : 2 } : { sessionId: 's', status: 'allocated', contextVersion: 1, liveUrl: '/api/ai/sidebar/sessions/s/live' };
    return new Response(JSON.stringify(value), { status: 200 });
  };
  let target = 'target-1', index = 0, actions = 0, resolveLease;
  const stoppedLeases = [];
  const adapter = { context: () => ({ targetId: target, state: { index, imageCount: 3, modality: 'CT' }, captureTarget: 'viewer', privacyClass: 'unknown', route: '/viewer/dicomlocal' }), attachments: () => [], capture: () => ({ viewportId: 'viewport-one', rect: { x: 0, y: 0, width: 100, height: 100 } }), async execute() { actions++; index++; return { applied: true, state: { index } }; } };
  const events = new Map();
  const browser = { location: { origin: 'http://localhost:3000', protocol: 'http:' }, addEventListener: (name, callback) => events.set(name, callback), radsysxDesktop: { startViewerCapture: () => new Promise(resolve => { resolveLease = resolve; }), stopViewerCapture: async lease => { stoppedLeases.push(lease); } } };
  const controller = new LiveController(adapter, browser);
  try {
    await tick(); await controller.connect(); assert.equal(sockets.length, 0);
    await controller.connect('synthetic'); assert.equal(controller.ready, false);
    controller.audio.onInput(new ArrayBuffer(640)); assert.equal(sockets[0].sent.length, 0);
    sockets[0].onmessage({ data: JSON.stringify({ kind: 'session', sessionId: 's', sequence: 1, contextVersion: 1, status: 'ready' }) });
    assert.equal(controller.ready, true); controller.audio.onInput(new ArrayBuffer(640)); assert.equal(sockets[0].sent.length, 1);
    assert.match(controller.message, /microphone off.*image sharing off/);
    assert.equal(controller.captureScope, 'Active image only · CT · Image 1 of 3');
    sockets[0].onmessage({ data: JSON.stringify({ kind: 'viewer_action', sessionId: 's', sequence: 2, contextVersion: 1, toolCallId: 'tool-one', name: 'viewer_jump_to_slice', args: { index: 1 } }) });
    await controller.actionQueue;
    assert.equal(actions, 1);
    const receipt = JSON.parse(sockets[0].sent.at(-1));
    assert.equal(receipt.kind, 'action_result'); assert.equal(receipt.status, 'completed');
    controller.audio.play(new ArrayBuffer(4800));
    controller.stopSpeaking();
    sockets[0].onmessage({ data: new ArrayBuffer(4800) });
    assert.equal(controller.audio.queuedMilliseconds, 0);
    sockets[0].onmessage({ data: JSON.stringify({ kind: 'session', sessionId: 's', sequence: 3, contextVersion: 1, status: 'reconnecting' }) });
    assert.equal(controller.ready, false); assert.equal(controller.audio.queuedMilliseconds, 0);
    assert.equal(controller.audio.listening, false); assert.equal(controller.sharing, false);
    sockets[0].onmessage({ data: JSON.stringify({ kind: 'session', sessionId: 's', sequence: 4, contextVersion: 1, status: 'ready' }) });
    const startCapture = controller.toggleSharing();
    assert.equal(controller.sharing, true); await controller.stopSharing();
    resolveLease({ leaseId: 'late-lease', expiresAt: Date.now() + 15000 }); await startCapture;
    assert.equal(controller.sharing, false); assert.equal(stoppedLeases.at(-1).leaseId, 'late-lease');
    assert.equal(sockets[0].sent.filter(value => typeof value === 'string').map(value => JSON.parse(value)).some(value => value.kind === 'screen_sharing' && value.active), false);
    const shareImage = controller.toggleSharing();
    assert.match(controller.message, /starting image sharing/);
    resolveLease({ leaseId: 'current-lease', expiresAt: Date.now() + 15000 }); await shareImage;
    assert.equal(JSON.parse(sockets[0].sent.at(-1)).kind, 'screen_sharing');
    assert.equal(JSON.parse(sockets[0].sent.at(-1)).active, true);
    const screenStatus = (sequence, active, frameReceived) => sockets[0].onmessage({ data: JSON.stringify({ kind: 'screen_status', sessionId: 's', sequence, contextVersion: 1, active, frameReceived }) });
    screenStatus(5, true, false); assert.match(controller.message, /waiting for first image/);
    screenStatus(6, true, true); assert.equal(controller.imageReceived, true); assert.match(controller.message, /image sharing on · image sent/);
    await controller.stopSharing();
    assert.equal(JSON.parse(sockets[0].sent.at(-1)).active, false); assert.match(controller.message, /image sharing off/);
    screenStatus(7, true, true); assert.equal(controller.imageReceived, false); assert.equal(controller.sharingConfirmed, false);
    const shareAgain = controller.toggleSharing(); resolveLease({ leaseId: 'next-lease', expiresAt: Date.now() + 15000 }); await shareAgain;
    const sentBeforeStop = sockets[0].sent.length;
    screenStatus(8, false, false); await tick();
    assert.equal(controller.sharing, false); assert.equal(controller.imageReceived, false); assert.equal(sockets[0].sent.length, sentBeforeStop);
    index = 2; await controller.refreshContext();
    assert.equal(controller.captureScope, 'Active image only · CT · Image 3 of 3');
    assert.equal(controller.contextVersion, 1); assert.equal(controller.ready, true);
    assert.equal(JSON.parse(requests.at(-1)[1].body).viewerContext.state.index, 2);
    target = 'target-2'; await controller.refreshContext();
    assert.equal(controller.attestation, undefined); assert.equal(controller.ready, false); assert.equal(sockets[0].readyState, 3);
    assert.equal(requests.some(([url]) => String(url).endsWith('/context')), true);
    controller.tools.set('stale', { id: 'stale' }); controller.citations = [{ title: 'Stale', url: 'https://example.org/stale' }];
    await controller.readHistory('history-old');
    assert.equal(controller.historical, true); assert.equal(controller.tools.has('stale'), false);
    assert.equal(controller.tools.get('saved-tool').result.summary, 'Saved evidence.');
    assert.equal(controller.transcript.items[0].text, 'Earlier question.');
    assert.deepEqual(controller.citations, [{ title: 'Saved paper', url: 'https://example.org/saved' }]);
    await controller.clearHistory('history-old');
    assert.equal(controller.transcript.items.length, 0); assert.equal(controller.tools.size, 0); assert.equal(controller.citations.length, 0);
    controller.interaction = 'IN_PROGRESS'; await controller.end(); assert.equal(controller.interaction, 'IDLE');
  } finally {
    controller.session = undefined; controller.dispose();
    Object.assign(globalThis, originals);
  }
});

test('backend restart recovers same unexpired target after fresh attestation without replay; expiry and End allocate anew', async () => {
  const originals = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket, AudioContext: globalThis.AudioContext };
  const sockets = [], requests = []; let allocations = 0, expired = false, actions = 0;
  const saved = () => ({ session: { sessionId: 'saved-session', status: 'interrupted', contextVersion: 2, expiresAt: new Date(Date.now() + (expired ? -1000 : 60000)).toISOString(), viewerContext: { targetId: 'same-target' } },
    events: [{ kind: 'transcript', role: 'user', text: 'Earlier question.', turnId: 'turn-old', sequence: 4, finished: false }],
    tools: [{ toolCallId: 'old-action', name: 'viewer_set_view', status: 'completed', args: { zoom: 2 }, result: { applied: true } }] });
  class Socket {
    static OPEN = 1; readyState = 1; bufferedAmount = 0; sent = [];
    constructor(url) { sockets.push(this); }
    send(data) { this.sent.push(data); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  globalThis.WebSocket = Socket; globalThis.AudioContext = FakeAudioContext;
  globalThis.fetch = async (url, init) => {
    requests.push([String(url), init]); let result = {};
    if (String(url).endsWith('/capabilities')) result = { availability: 'configured' };
    else if (String(url).endsWith('/context')) result = { ...saved().session, status: 'allocated' };
    else if (String(url).endsWith('/saved-session') && init.method === 'GET') result = saved();
    else if (String(url).endsWith('/sessions') && init.method === 'POST') {
      allocations++;
      result = { ...saved().session, sessionId: allocations === 1 ? 'saved-session' : `new-${allocations}`, status: 'allocated', contextVersion: 1 };
    }
    return new Response(JSON.stringify(result), { status: 200 });
  };
  const adapter = { context: () => ({ targetId: 'same-target', state: {}, captureTarget: 'viewer', route: '/viewer/dicomlocal', privacyClass: 'unknown' }), attachments: () => [], async execute() { actions++; return { applied: true }; } };
  const browser = { location: { origin: 'http://localhost:3000', protocol: 'http:' }, addEventListener() {} };
  const controller = new LiveController(adapter, browser);
  const event = (socket, value) => socket.onmessage({ data: JSON.stringify({ sessionId: controller.session.sessionId, contextVersion: controller.contextVersion, ...value }) });
  try {
    await tick(); await controller.connect('synthetic');
    event(sockets[0], { kind: 'session', status: 'ready', sequence: 1 });
    controller.reconnectAttempts = 3; sockets[0].close();
    assert.equal(controller.status, 'disconnected'); assert.equal(controller.attestation, undefined);
    await controller.connect(); assert.equal(sockets.length, 1);
    await controller.connect('deidentified');
    assert.equal(allocations, 1); assert.equal(controller.session.sessionId, 'saved-session'); assert.equal(controller.contextVersion, 2);
    const update = requests.find(([url]) => url.endsWith('/context'));
    assert.equal(JSON.parse(update[1].body).attestation, 'deidentified');
    assert.equal(controller.transcript.items[0].text, 'Earlier question.');
    assert.equal(controller.transcript.items[0].finished, true);
    assert.equal(controller.tools.get('old-action').result.applied, true); assert.equal(controller.tools.get('old-action').approval, false);
    assert.equal(controller.audio.listening, false); assert.equal(controller.sharing, false);
    event(sockets[1], { kind: 'session', status: 'ready', sequence: 5 });
    event(sockets[1], { kind: 'viewer_action', toolCallId: 'old-action', name: 'viewer_set_view', args: { zoom: 2 }, sequence: 6 });
    await controller.actionQueue; assert.equal(actions, 0);
    expired = true; controller.reconnectAttempts = 3; sockets[1].close();
    await controller.connect('synthetic'); assert.equal(allocations, 2); assert.equal(controller.session.sessionId, 'new-2');
    assert.equal(controller.transcript.items.length, 0);
    await controller.end(); await controller.connect('synthetic'); assert.equal(allocations, 3);
  } finally { controller.session = undefined; controller.dispose(); Object.assign(globalThis, originals); }
});

test('OpenAI microphone worklet uses 24 kHz and 20 ms packets while default stays 16 kHz', () => {
  let Processor; const packets = [];
  vm.runInNewContext(fs.readFileSync(new URL('../.cache/live-runtime/audio-worklet.js', import.meta.url), 'utf8'), {
    sampleRate: 48000, AudioWorkletProcessor: class { port = { postMessage(data) { packets.push(data); } }; },
    registerProcessor(_name, implementation) { Processor = implementation; },
  });
  const processor = new Processor({ processorOptions: { sampleRate: 24000 } });
  for (let index = 0; index < 75; index++) processor.process([[new Float32Array(128).fill(-0.5)]]);
  assert.equal(packets.length, 10); assert.equal(packets[0].byteLength, 960);
  assert.equal(new DataView(packets[0]).getInt16(0, true), -16384);
});

test('playback receipts count audible per-item samples, excluding queued audio and device latency', async () => {
  const previous = globalThis.AudioContext; globalThis.AudioContext = FakeAudioContext;
  try {
    const audio = new LiveAudio(); await audio.prepare(); const receipts = [];
    audio.onPlaybackStopped = stops => receipts.push(...stops);
    audio.play(new ArrayBuffer(4800), { itemId: 'a', contentIndex: 0 });
    audio.play(new ArrayBuffer(4800), { itemId: 'a', contentIndex: 0 });
    audio.play(new ArrayBuffer(4800), { itemId: 'b', contentIndex: 1 });
    audio.context.currentTime = 0.5;
    audio.context.getOutputTimestamp = () => ({ contextTime: 0.06, performanceTime: 1 });
    audio.stopOutput();
    assert.equal(receipts.length, 2); assert.equal(receipts[0].itemId, 'a');
    assert.ok(receipts[0].audioEndMs >= 49 && receipts[0].audioEndMs <= 50);
    assert.deepEqual(receipts[1], { itemId: 'b', contentIndex: 1, audioEndMs: 0 });
    audio.stopOutput(); assert.equal(receipts.length, 2);
  } finally { globalThis.AudioContext = previous; }
});

test('a 45-second audio burst plays in order at the original rate and remains interruptible', async () => {
  const previous = globalThis.AudioContext; globalThis.AudioContext = FakeAudioContext;
  try {
    const audio = new LiveAudio(); await audio.prepare(); let overflow = 0; const receipts = [];
    audio.onOverflow = () => overflow++; audio.onPlaybackStopped = stops => receipts.push(...stops);
    for (let index = 0; index < 450; index++) {
      const data = new ArrayBuffer(4800); new DataView(data).setInt16(0, index - 225, true);
      audio.play(data, { itemId: 'burst', contentIndex: 0 });
    }
    assert.equal(overflow, 0); assert.equal(audio.context.sources.length, 450);
    assert.ok(Math.abs(audio.queuedMilliseconds - 45010) < 0.001);
    audio.context.sources.forEach((source, index) => {
      assert.equal(source.buffer.sampleRate, 24000); assert.equal(source.buffer.duration, 0.1);
      assert.equal(source.buffer.getChannelData(0)[0], (index - 225) / 32768);
      assert.ok(Math.abs(source.startTime - (0.01 + index * 0.1)) < 1e-8);
      assert.equal(source.stopped, false);
    });
    audio.context.currentTime = 2.51; audio.stopOutput();
    assert.equal(receipts.length, 1); assert.ok(receipts[0].audioEndMs >= 2499 && receipts[0].audioEndMs <= 2500);
    assert.equal(audio.context.sources.every(source => source.stopped), true); assert.equal(audio.queuedMilliseconds, 0);
    audio.play(new ArrayBuffer(4800), { itemId: 'new-reply', contentIndex: 0 });
    assert.ok(Math.abs(audio.context.sources.at(-1).startTime - 2.52) < 1e-8);
  } finally { globalThis.AudioContext = previous; }
});

test('played audio frees queue capacity for later bursts', async () => {
  const previous = globalThis.AudioContext; globalThis.AudioContext = FakeAudioContext;
  try {
    const audio = new LiveAudio(); await audio.prepare(); let overflow = 0;
    audio.onOverflow = () => overflow++;
    audio.play(new ArrayBuffer(60 * 48000), { itemId: 'first', contentIndex: 0 });
    audio.context.currentTime = 60.02; audio.context.sources[0].onended();
    audio.play(new ArrayBuffer(45 * 48000), { itemId: 'second', contentIndex: 0 });
    assert.equal(overflow, 0); assert.equal(audio.output.size, 1);
    assert.ok(Math.abs(audio.queuedMilliseconds - 45010) < 0.001);
    assert.deepEqual(audio.playbackPosition(), [{ itemId: 'second', contentIndex: 0, audioEndMs: 0 }]);
    audio.stopOutput();
  } finally { globalThis.AudioContext = previous; }
});

test('queue overflow includes the incoming chunk before allocation and truncates unheard items', async () => {
  const previous = globalThis.AudioContext; globalThis.AudioContext = FakeAudioContext;
  try {
    const audio = new LiveAudio(); await audio.prepare(); let overflow = 0; const receipts = [];
    audio.onOverflow = () => overflow++; audio.onPlaybackStopped = stops => receipts.push(...stops);
    audio.play(new ArrayBuffer(59 * 48000), { itemId: 'a', contentIndex: 0 });
    audio.play(new ArrayBuffer(2 * 48000), { itemId: 'b', contentIndex: 0 });
    assert.equal(overflow, 1); assert.equal(audio.queuedMilliseconds, 0);
    assert.equal(audio.context.buffers.length, 1);
    assert.equal(audio.context.sources.length, 1); assert.equal(audio.context.sources[0].stopped, true);
    assert.deepEqual(receipts, [{ itemId: 'a', contentIndex: 0, audioEndMs: 0 }, { itemId: 'b', contentIndex: 0, audioEndMs: 0 }]);
  } finally { globalThis.AudioContext = previous; }
});

test('an oversized first chunk is rejected without decoding or creating an audio source', async () => {
  const previous = globalThis.AudioContext; globalThis.AudioContext = FakeAudioContext;
  try {
    const audio = new LiveAudio(); await audio.prepare(); let overflow = 0; const receipts = [];
    audio.onOverflow = () => overflow++; audio.onPlaybackStopped = stops => receipts.push(...stops);
    audio.play(new ArrayBuffer(61 * 48000), { itemId: 'oversized', contentIndex: 0 });
    assert.equal(overflow, 1); assert.equal(audio.queuedMilliseconds, 0);
    assert.equal(audio.context.buffers.length, 0); assert.equal(audio.context.sources.length, 0);
    assert.deepEqual(receipts, [{ itemId: 'oversized', contentIndex: 0, audioEndMs: 0 }]);
  } finally { globalThis.AudioContext = previous; }
});

test('tiny audio chunks cannot create an unbounded number of scheduled source nodes', async () => {
  const previous = globalThis.AudioContext; globalThis.AudioContext = FakeAudioContext;
  try {
    const audio = new LiveAudio(); await audio.prepare(); let overflow = 0;
    audio.onOverflow = () => overflow++;
    for (let index = 0; index < 3000; index++) audio.play(new ArrayBuffer(2));
    assert.equal(overflow, 0); assert.equal(audio.output.size, 3000);
    audio.play(new ArrayBuffer(2));
    assert.equal(overflow, 1); assert.equal(audio.context.buffers.length, 3000);
    assert.equal(audio.context.sources.every(source => source.stopped), true); assert.equal(audio.queuedMilliseconds, 0);
  } finally { globalThis.AudioContext = previous; }
});

test('provider discovery can retry after authentication without allocating or attesting a conversation', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, '/api/ai/sidebar/capabilities'); assert.equal(init.method, 'GET');
    calls++;
    return calls === 1 ? new Response('{}', { status: 401 }) : new Response(JSON.stringify({ providers: [
      { id: 'gemini', label: 'Gemini Live', modelId: 'gemini-3.8-live-extended-thinking', availability: 'unavailable', reason: 'Not configured', inputSampleRate: 16000, outputSampleRate: 24000, screen: true, tools: true },
      { id: 'openai', label: 'OpenAI Realtime', modelId: 'gpt-realtime-2.1-mini', availability: 'configured', reason: '', inputSampleRate: 24000, outputSampleRate: 24000, screen: true, tools: true },
    ] }), { status: 200 });
  };
  const controller = new LiveController({ context: () => ({ targetId: 'same-target' }) }, { addEventListener() {} });
  try {
    await tick(); assert.equal(controller.status, 'unavailable'); assert.equal(controller.providers.length, 0);
    await controller.initialize();
    assert.equal(calls, 2); assert.deepEqual(controller.providers.map(profile => profile.id), ['gemini', 'openai']);
    assert.equal(controller.providerId, 'gemini'); assert.equal(controller.session, undefined); assert.equal(controller.attestation, undefined);
  } finally { controller.dispose(); globalThis.fetch = originalFetch; }
});

test('provider selection works with unavailable Gemini, freezes OpenAI audio, and does not recover a different model', async () => {
  const originals = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket, AudioContext: globalThis.AudioContext };
  const profiles = [
    { id: 'gemini', label: 'Gemini', modelId: 'gemini-3.8-live-extended-thinking', availability: 'unavailable', reason: 'Gemini not configured.', inputSampleRate: 16000, outputSampleRate: 24000, screen: true, tools: true },
    { id: 'openai', label: 'OpenAI', modelId: 'gpt-realtime-2.1-mini', availability: 'configured', reason: '', inputSampleRate: 24000, outputSampleRate: 24000, screen: true, tools: true },
  ];
  const requests = [], sockets = []; let allocations = 0;
  class Socket {
    static OPEN = 1; readyState = 1; bufferedAmount = 0; sent = [];
    constructor() { sockets.push(this); }
    send(value) { this.sent.push(value); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  globalThis.WebSocket = Socket; globalThis.AudioContext = FakeAudioContext;
  globalThis.fetch = async (url, init) => {
    requests.push([String(url), init]); let result = {};
    if (String(url).endsWith('/capabilities')) result = { defaultProviderId: 'gemini', providers: profiles };
    else if (String(url).endsWith('/sessions') && init.method === 'POST') {
      const body = JSON.parse(init.body); assert.equal(body.providerId, 'openai'); allocations++;
      result = { sessionId: `openai-${allocations}`, providerId: 'openai', modelId: profiles[1].modelId, inputSampleRate: 24000, outputSampleRate: 24000, contextVersion: 1, status: 'allocated' };
    } else if (init.method === 'GET') result = { session: { sessionId: 'openai-1', providerId: 'openai', modelId: 'different-model', status: 'interrupted', contextVersion: 2, expiresAt: new Date(Date.now() + 60000).toISOString(), viewerContext: { targetId: 'same-target' } }, events: [], tools: [] };
    return new Response(JSON.stringify(result), { status: 200 });
  };
  const adapter = { context: () => ({ targetId: 'same-target', state: {}, captureTarget: 'viewer', route: '/viewer/dicomlocal', privacyClass: 'unknown' }), attachments: () => [] };
  const browser = { location: { origin: 'http://localhost:3000', protocol: 'http:' }, addEventListener() {} };
  const controller = new LiveController(adapter, browser);
  const event = value => sockets.at(-1).onmessage({ data: JSON.stringify({ sessionId: controller.session.sessionId, contextVersion: controller.contextVersion, ...value }) });
  try {
    await tick(); assert.equal(controller.providerId, 'gemini'); assert.equal(controller.status, 'unavailable');
    await controller.selectProvider('openai'); assert.equal(controller.status, 'disconnected'); assert.equal(controller.attestation, undefined);
    await controller.connect('synthetic'); assert.equal(controller.audio.inputRate, 24000); assert.ok(Object.isFrozen(controller.activeProvider));
    event({ kind: 'session', status: 'ready', sequence: 1 });
    sockets[0].onmessage({ data: new ArrayBuffer(4800) }); assert.equal(controller.audio.context.sources.length, 0);
    event({ kind: 'audio_chunk', itemId: 'spoken', contentIndex: 0, sequence: 2 }); sockets[0].onmessage({ data: new ArrayBuffer(4800) });
    controller.audio.context.currentTime = 0.06;
    event({ kind: 'interrupted', sequence: 3 });
    const receipt = JSON.parse(sockets[0].sent.at(-1));
    assert.equal(receipt.kind, 'playback_stop'); assert.equal(receipt.itemId, 'spoken'); assert.ok(receipt.audioEndMs <= 50);
    controller.reconnectAttempts = 3; sockets[0].close(); await controller.connect('synthetic');
    assert.equal(allocations, 2); assert.equal(requests.some(([url]) => url.endsWith('/context')), false);
    event({ kind: 'session', status: 'ready', sequence: 1 });
    await controller.selectProvider('gemini');
    assert.equal(controller.providerId, 'gemini'); assert.equal(controller.status, 'unavailable');
    assert.equal(controller.session, undefined); assert.equal(controller.recoverySessionId, undefined); assert.equal(controller.attestation, undefined);
    assert.equal(sockets.at(-1).readyState, 3); assert.equal(controller.audio.listening, false); assert.equal(controller.sharing, false);
  } finally { controller.session = undefined; controller.dispose(); Object.assign(globalThis, originals); }
});

test('API key inputs are masked, never prefilled and separated from the message composer', () => {
  const html = credentialSettingsMarkup();
  assert.equal((html.match(/type="password"/g) ?? []).length, 2);
  assert.equal((html.match(/autocomplete="new-password"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /\bvalue=/);
  assert.match(html, /data-credential-provider="gemini"/); assert.match(html, /data-credential-provider="openai"/);
  assert.match(html, /Saving does not verify provider access/);
});

test('credential changes stop media/session, clear attestation and refresh provider catalog without retaining keys', async () => {
  const originalFetch = globalThis.fetch, originalSocket = globalThis.WebSocket;
  globalThis.WebSocket = { OPEN: 1 };
  const requests = []; let configured = false, saved = false;
  const statuses = () => ({ storageAvailable: true, providers: [
    { id: 'gemini', label: 'Gemini', configured: false, source: 'none', environmentConfigured: false },
    { id: 'openai', label: 'OpenAI', configured, source: saved ? 'saved' : configured ? 'environment' : 'none', environmentConfigured: true },
  ] });
  globalThis.fetch = async (url, init) => {
    const method = init.method; requests.push([url, method]);
    if (url.endsWith('/capabilities')) return Response.json({ providers: [{ id: 'openai', label: 'OpenAI', modelId: 'gpt-realtime-2.1-mini', availability: configured ? 'configured' : 'unavailable', reason: '', inputSampleRate: 24000, outputSampleRate: 24000, screen: true, tools: true }], defaultProviderId: 'openai' });
    if (url.endsWith('/credentials/openai')) {
      assert.equal(controller.audio.listening, false); assert.equal(controller.sharing, false); assert.equal(controller.attestation, undefined);
      assert.equal(controller.recoverySessionId, undefined); assert.equal(controller.session, undefined);
      if (method === 'PUT') { assert.deepEqual(JSON.parse(init.body), { apiKey: 'synthetic-test-key' }); saved = true; configured = true; }
      else { assert.equal(method, 'DELETE'); assert.equal(init.body, undefined); saved = false; }
    }
    return Response.json(url.includes('/credentials') ? statuses() : {});
  };
  const controller = new LiveController({ context: () => ({ targetId: 'same-target' }) }, { addEventListener() {} });
  try {
    await tick(); await controller.showCredentials();
    assert.equal(controller.credentialsOpen, true); assert.equal(controller.credentials.providers[1].source, 'none');
    controller.session = { sessionId: 'previous', contextVersion: 1 }; controller.recoverySessionId = 'previous'; controller.attestation = 'synthetic';
    controller.status = 'ready'; controller.audio = { listening: true, close() { this.listening = false; }, stopOutput() {} };
    controller.sharing = true; controller.stopSharing = async () => { controller.sharing = false; };
    controller.socket = { readyState: 1, close() { this.readyState = 3; }, send() {} };
    const epoch = controller.credentialInputEpoch;
    await controller.saveCredential('openai', 'synthetic-test-key');
    assert.equal(controller.credentialInputEpoch > epoch, true);
    assert.equal(controller.credentials.providers[1].source, 'saved'); assert.equal(controller.availability, 'configured');
    assert.match(controller.credentialMessage, /Key saved.*not been verified/);
    assert.equal(requests.findIndex(([url]) => url.endsWith('/close')) < requests.findIndex(([url, method]) => url.endsWith('/credentials/openai') && method === 'PUT'), true);
    assert.equal(requests.at(-1)[0], '/api/ai/sidebar/capabilities');
    assert.doesNotMatch(JSON.stringify([Object.values(controller).filter(value => typeof value === 'string'), controller.credentials, controller.transcript.items, [...controller.tools.values()]]), /synthetic-test-key/);
    await controller.removeCredential('openai'); assert.equal(controller.credentials.providers[1].source, 'environment');
    assert.match(controller.credentialMessage, /app-configured key will be used/);
    const closedEpoch = controller.credentialInputEpoch; controller.closeCredentials();
    assert.equal(controller.credentialsOpen, false); assert.equal(controller.credentialInputEpoch, closedEpoch + 1);
  } finally { controller.session = undefined; controller.dispose(); globalThis.fetch = originalFetch; globalThis.WebSocket = originalSocket; }
});

test('credential errors expose no request payload and prevent changes when secure storage is unavailable', async () => {
  const originalFetch = globalThis.fetch; let writes = 0, storageAvailable = false;
  globalThis.fetch = async (url, init) => {
    if (url.endsWith('/capabilities')) return Response.json({ availability: 'unavailable' });
    if (init.method === 'PUT') { writes++; return new Response('synthetic-sensitive-key', { status: 500 }); }
    return Response.json({ storageAvailable, providers: [{ id: 'gemini', label: 'Gemini', configured: false, source: 'none', environmentConfigured: false }] });
  };
  const controller = new LiveController({ context: () => ({ targetId: 'target' }) }, { addEventListener() {} });
  try {
    await tick(); await controller.showCredentials(); await controller.saveCredential('gemini', 'synthetic-sensitive-key');
    assert.equal(writes, 0); assert.match(controller.credentialMessage, /storage is unavailable/);
    storageAvailable = true; await controller.loadCredentials(); await controller.saveCredential('gemini', '   '); assert.equal(writes, 0);
    await controller.saveCredential('gemini', 'synthetic-sensitive-key'); assert.equal(writes, 1);
    assert.match(controller.credentialMessage, /could not be updated/); assert.doesNotMatch(controller.credentialMessage, /synthetic-sensitive-key/);
    assert.equal(controller.credentialsBusy, false); assert.equal(controller.status, 'disconnected'); assert.equal(controller.attestation, undefined);
  } finally { controller.dispose(); globalThis.fetch = originalFetch; }
});

test('an unreadable saved key can be removed even when secure key storage is unavailable', async () => {
  const originalFetch = globalThis.fetch; let removed = false;
  globalThis.fetch = async (url, init) => {
    if (url.endsWith('/capabilities')) return Response.json({ availability: 'configured' });
    if (init.method === 'DELETE') removed = true;
    return Response.json({ storageAvailable: false, providers: [{ id: 'gemini', label: 'Gemini', configured: removed, source: removed ? 'environment' : 'saved', environmentConfigured: true }] });
  };
  const controller = new LiveController({ context: () => ({ targetId: 'target' }) }, { addEventListener() {} });
  try {
    await tick(); await controller.showCredentials();
    assert.equal(controller.credentials.storageAvailable, false);
    await controller.removeCredential('gemini');
    assert.equal(removed, true); assert.equal(controller.credentials.providers[0].source, 'environment');
    assert.match(controller.credentialMessage, /app-configured key will be used/);
  } finally { controller.dispose(); globalThis.fetch = originalFetch; }
});

test('research settings load the saved model and save after ending the active session', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const settings = { providerId: 'nvidia_nim', modelId: 'z-ai/glm-5.3-flash', source: 'environment', providers: [{ id: 'gemini', label: 'Gemini', configured: true }, { id: 'nvidia_nim', label: 'NVIDIA NIM', configured: true }] };
  globalThis.fetch = async (url, init) => {
    calls.push([url, init.method]);
    if (url.includes('/models/')) return Response.json({ providerId: 'nvidia_nim', models: ['z-ai/glm-5.3-flash', 'openai/gpt-oss-20b'], capabilitiesVerified: false });
    if (url.endsWith('/research-settings')) {
      if (init.method === 'PUT') {
        assert.equal(controller.session, undefined);
        assert.equal(controller.attestation, undefined);
        assert.deepEqual(JSON.parse(init.body), { providerId: 'nvidia_nim', modelId: 'openai/gpt-oss-20b' });
        return Response.json({ ...settings, modelId: 'openai/gpt-oss-20b', source: 'saved' });
      }
      return Response.json(settings);
    }
    return Response.json({ availability: 'configured' });
  };
  const controller = new LiveController({ context: () => ({ targetId: 'same' }) }, { addEventListener() {} });
  try {
    await tick(); await controller.loadResearchSettings();
    assert.equal(controller.researchModelId, 'z-ai/glm-5.3-flash');
    controller.session = { sessionId: 'old', contextVersion: 1 }; controller.attestation = 'synthetic';
    controller.researchModelId = 'openai/gpt-oss-20b';
    await controller.saveResearchSettings();
    assert.equal(controller.researchSettings.source, 'saved');
    assert.equal(calls.findIndex(([url]) => url.endsWith('/close')) < calls.findIndex(([url, method]) => url.endsWith('/research-settings') && method === 'PUT'), true);
    assert.match(controller.researchMessage, /saved/i);
  } finally { controller.session = undefined; controller.dispose(); globalThis.fetch = originalFetch; }
});

test('late research catalog cannot replace another provider; catalog failure keeps the selected model', async () => {
  const originalFetch = globalThis.fetch;
  let release;
  globalThis.fetch = async (url) => {
    if (url.endsWith('/models/nvidia_nim')) return new Promise(resolve => { release = resolve; });
    if (url.endsWith('/models/gemini')) return Response.json({ providerId: 'gemini', models: ['gemini-3.8-flash'], capabilitiesVerified: false });
    return Response.json({ availability: 'configured' });
  };
  const controller = new LiveController({ context: () => ({ targetId: 'same' }) }, { addEventListener() {} });
  try {
    await tick();
    controller.researchSettings = { providerId: 'nvidia_nim', modelId: 'z-ai/glm-5.3-flash', source: 'saved', providers: [{ id: 'gemini', configured: true }, { id: 'nvidia_nim', configured: true }] };
    const first = controller.selectResearchProvider('nvidia_nim'); await tick();
    await controller.selectResearchProvider('gemini');
    release(Response.json({ providerId: 'nvidia_nim', models: ['wrong-model'] })); await first;
    assert.equal(controller.researchProviderId, 'gemini'); assert.deepEqual(controller.researchModels, ['gemini-3.8-flash']);
    globalThis.fetch = async () => new Response('failure', { status: 503 });
    await controller.selectResearchProvider('nvidia_nim');
    assert.equal(controller.researchModelId, 'z-ai/glm-5.3-flash');
    assert.deepEqual(controller.researchModels, []); assert.match(controller.researchMessage, /retry/i);
  } finally { controller.dispose(); globalThis.fetch = originalFetch; }
});

test('Gemini key changes immediately update research availability without replacing the pending model choice', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => Response.json(url.includes('/credentials') ? {
    storageAvailable: true, providers: [{ id: 'gemini', configured: true, source: 'saved', environmentConfigured: false }],
  } : { availability: 'configured' });
  const controller = new LiveController({ context: () => ({ targetId: 'same' }) }, { addEventListener() {} });
  try {
    await tick();
    controller.credentials = { storageAvailable: true, providers: [{ id: 'gemini', configured: false }] };
    controller.researchSettings = { providerId: 'gemini', modelId: 'gemini-3.8-flash', source: 'environment', providers: [{ id: 'gemini', configured: false }, { id: 'nvidia_nim', configured: true }] };
    controller.researchProviderId = 'nvidia_nim'; controller.researchModelId = 'openai/gpt-oss-20b';
    await controller.saveCredential('gemini', 'synthetic-key');
    assert.equal(controller.researchSettings.providers[0].configured, true);
    assert.equal(controller.researchProviderId, 'nvidia_nim'); assert.equal(controller.researchModelId, 'openai/gpt-oss-20b');
  } finally { controller.dispose(); globalThis.fetch = originalFetch; }
});

test('typed chat and explicit research work with voice unavailable, without audio or WebSocket allocation', async () => {
  const originalFetch = globalThis.fetch, originalSocket = globalThis.WebSocket;
  const requests = []; let currentTool;
  globalThis.WebSocket = class { static OPEN = 1; constructor() { throw Error('Voice must not open'); } };
  globalThis.fetch = async (url, init) => {
    const body = init?.body && JSON.parse(init.body); requests.push([String(url), body]);
    let value = {};
    if (String(url).endsWith('/capabilities')) value = { availability: 'unavailable' };
    else if (String(url).endsWith('/research-settings')) value = { providerId:'nvidia_nim',modelId:'z-ai/glm-5.3-flash',providers:[{id:'nvidia_nim',configured:true}] };
    else if (String(url).endsWith('/text-sessions')) value = { sessionId:'text-one',mode:'text',status:'ready',providerId:'nvidia_nim',modelId:'z-ai/glm-5.3-flash',contextVersion:1,liveUrl:null };
    else if (String(url).endsWith('/text-turns')) value = currentTool = { toolCallId:body.idempotencyKey,name:body.action === 'chat' ? 'text_chat' : 'research_run',status:'completed',args:{query:body.text},result:{summary:'Synthetic answer.',sources:[]} };
    else if (String(url).endsWith('/text-one')) value = { events:[{kind:'transcript',role:'assistant',text:'Synthetic answer.',finished:true}],tools:[currentTool] };
    return new Response(JSON.stringify(value));
  };
  const { adapter,browser } = fixture(); const c = new LiveController(adapter,{...browser,addEventListener(){}});
  try {
    await tick(); c.draft='Discuss synthetic CT'; await c.sendText();
    assert.equal(requests.some(([url])=>url.endsWith('/text-sessions')),false); assert.equal(c.draft,'Discuss synthetic CT');
    c.initializing=true; await c.sendText('synthetic'); assert.equal(c.session,undefined); c.initializing=false;
    await c.sendText('synthetic'); await tick();
    assert.equal(c.session.mode,'text'); assert.equal(c.ready,false); assert.equal(c.audio.context,undefined);
    assert.equal(c.textBusy,false); assert.equal(c.draft,''); assert.equal(c.transcript.items[0].text,'Synthetic answer.');
    c.draft='Find public evidence'; await c.research(); await tick();
    assert.equal(requests.filter(([url])=>url.endsWith('/text-sessions')).length,1);
    assert.equal(requests.filter(([url])=>url.endsWith('/text-turns')).at(-1)[1].action,'research');
  } finally { c.session=undefined;c.dispose(); globalThis.fetch=originalFetch;globalThis.WebSocket=originalSocket; }
});

test('uncertain typed sends retain one identity, preserve newer drafts, and discard late polling after End', async () => {
  const oldFetch=globalThis.fetch; let fail=true, resolveTurn, resolvePoll; const keys=[];
  globalThis.fetch=async (url,init)=>{
    const body=init?.body && JSON.parse(init.body); let value={availability:'unavailable'};
    if(String(url).endsWith('/text-sessions')) value={sessionId:'typed',mode:'text',contextVersion:1,status:'ready'};
    if(String(url).endsWith('/text-turns')) {
      keys.push(body.idempotencyKey); if(fail){fail=false;throw Error('offline');}
      return new Promise(resolve=>{resolveTurn=()=>resolve(new Response(JSON.stringify({toolCallId:body.idempotencyKey,name:'text_chat',status:'running',args:{}})));});
    }
    if(String(url).endsWith('/typed')) return new Promise(resolve=>{resolvePoll=()=>resolve(new Response(JSON.stringify({events:[{kind:'transcript',role:'assistant',text:'late'}],tools:[]})));});
    return new Response(JSON.stringify(value));
  };
  const {adapter,browser}=fixture();const c=new LiveController(adapter,{...browser,addEventListener(){}});
  try {
    await tick();c.draft='Question';await c.sendText('synthetic');assert.equal(c.draft,'Question');assert.equal(c.textBusy,false);
    const retry=c.sendText('synthetic');await tick();c.draft='New unsent draft';resolveTurn();await retry;await tick();
    assert.equal(keys[0],keys[1]);assert.equal(c.draft,'New unsent draft');
    const late=resolvePoll;const ended=c.end();await tick();resolvePoll();await ended;late();await tick();
    assert.equal(c.transcript.items.some(x=>x.text==='late'),false);assert.equal(c.textBusy,false);
  } finally {c.session=undefined;c.dispose();globalThis.fetch=oldFetch;}
});
