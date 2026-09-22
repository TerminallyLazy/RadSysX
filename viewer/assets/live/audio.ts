import type { AudioChunk, PlaybackStop } from './protocol.js';

type AudioSpan = { start: number; end: number; frames: number; rate: number };
type PlaybackItem = AudioChunk & { heardSeconds: number; spans: AudioSpan[] };

export const MAX_QUEUED_AUDIO_SECONDS = 60;
export const MAX_QUEUED_AUDIO_SOURCES = 3000;
const START_LEAD_SECONDS = 0.01;

/** PCM output is queued independently of HTTP requests, tools, and panel rendering. */
export class LiveAudio {
  private context?: AudioContext;
  private stream?: MediaStream;
  private input?: MediaStreamAudioSourceNode;
  private worklet?: AudioWorkletNode;
  private silence?: GainNode;
  private output = new Set<AudioBufferSourceNode>();
  private nextTime = 0;
  private inputGeneration = 0;
  private loaded = false;
  private inputRate: 16000 | 24000 = 16000;
  private outputRate: 24000 = 24000;
  private items = new Map<string, PlaybackItem>();
  private lastItem?: string;
  onPlaybackStopped?: (stops: PlaybackStop[]) => void;
  onOverflow?: () => void;
  configure(inputRate: 16000 | 24000, outputRate: 24000): void {
    if (![16000, 24000].includes(inputRate) || outputRate !== 24000) throw new Error('Unsupported session audio format.');
    this.inputRate = inputRate; this.outputRate = outputRate;
  }
  onInput?: (data: ArrayBuffer) => void;
  onInputEnded?: () => void;
  get listening(): boolean { return Boolean(this.stream); }
  get queuedMilliseconds(): number { return this.context ? Math.max(0, (this.nextTime - this.context.currentTime) * 1000) : 0; }

  async prepare(): Promise<void> {
    this.context ??= new AudioContext({ latencyHint: 'interactive' });
    if (this.context.state !== 'running') await this.context.resume();
  }
  async startInput(workletUrl: string): Promise<void> {
    if (this.stream) return;
    const generation = ++this.inputGeneration;
    await this.prepare();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: {
      channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
    }, video: false });
    if (generation !== this.inputGeneration) { stream.getTracks().forEach(track => track.stop()); return; }
    try {
      if (!this.loaded) {
        await this.context!.audioWorklet.addModule(workletUrl);
        this.loaded = true;
      }
      if (generation !== this.inputGeneration) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      this.input = this.context!.createMediaStreamSource(stream);
      this.worklet = new AudioWorkletNode(this.context!, 'radsysx-pcm-input', { processorOptions: { sampleRate: this.inputRate } });
      this.worklet.port.onmessage = ({ data }: MessageEvent<ArrayBuffer>) => {
        if (generation === this.inputGeneration && data instanceof ArrayBuffer) this.onInput?.(data);
      };
      // A zero-gain output keeps the worklet clock running without mic feedback.
      this.silence = this.context!.createGain();
      this.silence.gain.value = 0;
      this.input.connect(this.worklet).connect(this.silence).connect(this.context!.destination);
      stream.getAudioTracks().forEach(track => track.onended = () => { this.stopInput(); this.onInputEnded?.(); });
    } catch (error) {
      stream.getTracks().forEach(track => track.stop());
      this.stopInput();
      throw error;
    }
  }
  stopInput(): void {
    this.inputGeneration += 1;
    this.stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    if (this.worklet) { this.worklet.port.onmessage = null; this.worklet.port.close(); }
    this.input?.disconnect(); this.worklet?.disconnect(); this.silence?.disconnect();
    this.stream = undefined; this.input = undefined; this.worklet = undefined; this.silence = undefined;
  }
  play(data: ArrayBuffer, metadata?: AudioChunk): void {
    if (!this.context || !data.byteLength || data.byteLength % 2) return;
    const key = metadata ? JSON.stringify([metadata.itemId, metadata.contentIndex]) : undefined;
    if (key && metadata) {
      this.lastItem = key; this.pruneItems();
      if (!this.items.has(key)) this.items.set(key, { ...metadata, heardSeconds: 0, spans: [] });
    }
    const frames = data.byteLength / 2;
    const duration = frames / this.outputRate;
    const now = this.context.currentTime;
    const start = Math.max(now + START_LEAD_SECONDS, this.nextTime);
    // Providers can deliver a whole reply faster than real time. Buffer normal bursts
    // at the original rate, but bound decoded audio and tiny-chunk node overhead.
    // Include the incoming chunk before allocating; allow only the scheduling lead.
    if (start + duration - now > MAX_QUEUED_AUDIO_SECONDS + START_LEAD_SECONDS + 1e-8
      || this.output.size >= MAX_QUEUED_AUDIO_SOURCES) {
      this.stopOutput(); this.onOverflow?.(); return;
    }
    const samples = new DataView(data);
    const buffer = this.context.createBuffer(1, frames, this.outputRate);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < channel.length; index++) channel[index] = samples.getInt16(index * 2, true) / 32768;
    const source = this.context.createBufferSource();
    source.buffer = buffer; source.connect(this.context.destination);
    this.output.add(source);
    source.onended = () => { this.output.delete(source); source.disconnect(); };
    source.start(start); this.nextTime = start + buffer.duration;
    if (key) this.items.get(key)!.spans.push({ start, end: this.nextTime, frames, rate: this.outputRate });
  }
  private audibleTime(): number {
    if (!this.context) return 0;
    const timestamp = this.context.getOutputTimestamp?.();
    if (timestamp && Number.isFinite(timestamp.contextTime) && Number.isFinite(timestamp.performanceTime) && Number(timestamp.performanceTime) > 0) return Math.min(this.context.currentTime, Math.max(0, timestamp.contextTime!));
    return Math.max(0, this.context.currentTime - (this.context.baseLatency ?? 0) - (this.context.outputLatency ?? 0));
  }
  private pruneItems(): void {
    const now = this.audibleTime();
    for (const [key, item] of this.items) {
      while (item.spans.length && item.spans[0].end <= now) item.heardSeconds += item.spans.shift()!.frames / this.outputRate;
      if (!item.spans.length && key !== this.lastItem) this.items.delete(key);
    }
  }
  playbackPosition(): PlaybackStop[] {
    const now = this.audibleTime();
    return [...this.items.values()].map(item => ({ itemId: item.itemId, contentIndex: item.contentIndex,
      audioEndMs: Math.max(0, Math.floor(1000 * (item.heardSeconds + item.spans.reduce((sum, span) => sum + Math.min(span.frames, Math.max(0, Math.floor((now - span.start) * span.rate))) / span.rate, 0)))),
    }));
  }
  stopOutput(): void {
    const stopped = this.playbackPosition();
    this.items.clear(); this.lastItem = undefined;
    if (stopped.length) this.onPlaybackStopped?.(stopped);
    this.output.forEach(source => { source.onended = null; try { source.stop(); } catch {} source.disconnect(); });
    this.output.clear(); this.nextTime = 0;
  }
  close(): void { this.stopInput(); this.stopOutput(); }
}
