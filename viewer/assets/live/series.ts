import type { FrameDescriptor, Presentation, SeriesManifest } from './protocol.js';

export type PrivateFrame = Omit<FrameDescriptor, 'id'> & { imageId: string };
export type SeriesSource = { studyId: string; seriesId: string; modality: SeriesManifest['modality']; frames: PrivateFrame[]; complete: boolean };
export interface SeriesHost {
  studyBinding(): { studyId: string; seriesIds: string[] };
  seriesFrames(seriesId: string): SeriesSource;
  presentation(): Presentation;
  createSeriesRenderer?(): SeriesRenderer;
}
export async function digest(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, '0')).join('');
}
function vector(value: number[] | undefined, count: number, positive = false): number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== count || value.some(n => !Number.isFinite(n) || (positive && n <= 0))) throw new Error('Invalid frame geometry.');
  return [...value];
}
/** Uses the data source's complete display-set ordering, including temporal frames. */
export async function buildManifest(studyId: string, seriesId: string, frames: PrivateFrame[], modality: SeriesManifest['modality'] = 'OT'): Promise<SeriesManifest> {
  if (!frames.length || frames.length > 10000 || new Set(frames.map(f => f.imageId)).size !== frames.length) throw new Error('Series inventory is incomplete or exceeds capacity.');
  const descriptors = frames.map((frame, index) => {
    if (frame.index !== index || !frame.imageId || !Number.isInteger(frame.rows) || !Number.isInteger(frame.columns) || frame.rows < 1 || frame.rows > 65536 || frame.columns < 1 || frame.columns > 65536) throw new Error('Invalid frame inventory.');
    const result: Omit<FrameDescriptor, 'id'> = { index, rows: frame.rows, columns: frame.columns };
    for (const [key, count] of [['position', 3], ['orientation', 6], ['spacing', 2]] as const) {
      const data = vector(frame[key], count, key === 'spacing'); if (data) result[key] = data;
    }
    for (const key of ['timeIndex', 'sliceIndex'] as const) {
      const n = frame[key]; if (n !== undefined) { if (!Number.isInteger(n) || n < 0) throw new Error('Invalid frame ordering.'); result[key] = n; }
    }
    return result;
  });
  const hash = await digest(JSON.stringify([studyId, seriesId, modality, frames.map(f => f.imageId), descriptors]));
  return { manifestId: `manifest-${hash}`, studyId, seriesId, modality, frameCount: frames.length, ordering: 'display_set', offset: 0,
    frames: descriptors.map((frame, i) => ({ ...frame, id: `frame-${hash}-${i}` })) };
}

export class SeriesRegistry {
  private entries = new Map<string, { manifest: SeriesManifest; privateFrames: PrivateFrame[]; fingerprint: string }>();
  constructor(private adapter: SeriesHost) {}
  async manifest(seriesId: string, offset = 0): Promise<SeriesManifest> {
    const binding = this.adapter.studyBinding();
    if (!binding.seriesIds.includes(seriesId)) throw new Error('Series is outside the current study.');
    const source = this.adapter.seriesFrames(seriesId);
    if (!source.complete || source.studyId !== binding.studyId || source.seriesId !== seriesId) throw new Error('Complete series inventory is unavailable.');
    const manifest = await buildManifest(source.studyId, seriesId, source.frames, source.modality);
    if (this.adapter.studyBinding().studyId !== binding.studyId) throw new Error('The study changed.');
    const other = [...this.entries.entries()].filter(([id]) => id !== seriesId);
    if (other.length >= 32 || other.reduce((sum, [, entry]) => sum + entry.manifest.frameCount, manifest.frameCount) > 10000) throw new Error('Series inventory capacity reached.');
    this.entries.set(seriesId, { manifest, privateFrames: structuredClone(source.frames), fingerprint: JSON.stringify([source.modality, source.frames]) });
    if (!Number.isInteger(offset) || offset < 0 || offset >= manifest.frameCount) throw new Error('Invalid manifest cursor.');
    const page = { ...manifest, offset, frames: manifest.frames.slice(offset, offset + 256) };
    // Leave room for the claim/binding envelope within the 64 KiB HTTP boundary.
    while (JSON.stringify(page).length > 58000 && page.frames.length > 1) page.frames.pop();
    return page;
  }
  frame(frameId: string, manifestId?: string): { frame: FrameDescriptor; manifest: SeriesManifest } {
    const binding = this.adapter.studyBinding();
    for (const entry of this.entries.values()) {
      if (entry.manifest.studyId !== binding.studyId || !binding.seriesIds.includes(entry.manifest.seriesId) || (manifestId && entry.manifest.manifestId !== manifestId)) continue;
      const source = this.adapter.seriesFrames(entry.manifest.seriesId);
      if (!source.complete || source.studyId !== binding.studyId || JSON.stringify([source.modality, source.frames]) !== entry.fingerprint) throw new Error('The series inventory changed.');
      const frame = entry.manifest.frames.find(f => f.id === frameId);
      if (frame) return { frame, manifest: entry.manifest };
    }
    throw new Error('Frame is outside the current inventory.');
  }
  resolve(frameId: string): string {
    const { frame, manifest } = this.frame(frameId);
    return this.entries.get(manifest.seriesId)!.privateFrames[frame.index].imageId;
  }
  invalidate(): void { this.entries.clear(); }
}

export type EncodedFrame = { data: string; width: number; height: number };
export type RenderGeometry = { rows: number; columns: number; presentation: Presentation };
export interface SeriesRenderer {
  setFrame(imageId: string, presentation: Presentation, signal: AbortSignal): Promise<void>;
  waitForRendered(imageId: string, signal: AbortSignal): Promise<void>;
  encodeJpeg(options: { maxEdge: number; maxEncodedBytes: number }): Promise<EncodedFrame>;
  geometry(): RenderGeometry;
  dispose(): void;
}
export function alive(signal: AbortSignal): void { if (signal.aborted) throw new DOMException('Capture stopped.', 'AbortError'); }
export function abortable<T>(work: Promise<T>, signal: AbortSignal, timeoutMs = 10000): Promise<T> {
  alive(signal);
  return new Promise((resolve, reject) => {
    const end = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); };
    const cancel = () => { end(); reject(new DOMException('Capture stopped.', 'AbortError')); };
    const timer = setTimeout(() => { end(); reject(new Error('Image rendering timed out.')); }, timeoutMs);
    signal.addEventListener('abort', cancel, { once: true });
    work.then(value => { end(); resolve(value); }, () => { end(); reject(new Error('Image rendering failed.')); });
  });
}

// Pinned Cornerstone boundary. The engine and element belong only to this task.
type Native = Record<string, any>;
export class CornerstoneSeriesRenderer implements SeriesRenderer {
  private engine: Native;
  private viewport: Native;
  private element: HTMLDivElement;
  private disposed = false;
  private current = '';
  private requested: Presentation = {};
  private dimensions = { rows: 0, columns: 0 };
  constructor(private cornerstone: Native, private document: Document) {
    if (!cornerstone.RenderingEngine || !cornerstone.Enums?.ViewportType?.STACK) throw new Error('Native image rendering is unavailable.');
    this.element = document.createElement('div');
    Object.assign(this.element.style, { position: 'fixed', left: '-10000px', top: '0', width: '1024px', height: '1024px', visibility: 'hidden', pointerEvents: 'none' });
    this.element.setAttribute('aria-hidden', 'true'); document.body.append(this.element);
    const id = `radsysx-observation-${crypto.randomUUID()}`;
    try {
      this.engine = new cornerstone.RenderingEngine(id);
      this.engine.enableElement({ viewportId: id, type: cornerstone.Enums.ViewportType.STACK, element: this.element, defaultOptions: { background: [0, 0, 0] } });
      this.viewport = this.engine.getViewport(id);
    } catch { this.element.remove(); throw new Error('Native image rendering is unavailable.'); }
  }
  async setFrame(imageId: string, presentation: Presentation, signal: AbortSignal): Promise<void> {
    alive(signal); if (this.disposed) throw new Error('Capture stopped.');
    if (presentation.orientation && presentation.orientation !== 'native') throw new Error('Series frames use native acquisition orientation.');
    this.current = ''; this.requested = { ...presentation };
    await abortable(this.viewport.setStack([imageId], 0), signal);
    alive(signal); if (this.disposed) throw new Error('Capture stopped.');
    const plane = this.cornerstone.metaData.get('imagePlaneModule', imageId);
    const rows = plane?.rows, columns = plane?.columns;
    if (!Number.isInteger(rows) || !Number.isInteger(columns) || rows < 1 || columns < 1) throw new Error('Image geometry is unavailable.');
    this.dimensions = { rows, columns };
    const scale = Math.min(1, 2048 / Math.max(rows, columns));
    this.element.style.width = `${Math.max(1, Math.round(columns * scale))}px`;
    this.element.style.height = `${Math.max(1, Math.round(rows * scale))}px`;
    this.engine.resize(true, false);
    const properties: Native = { invert: presentation.invert ?? false };
    if (presentation.windowWidth !== undefined && presentation.windowCenter !== undefined) {
      properties.voiRange = { lower: presentation.windowCenter - 0.5 - (presentation.windowWidth - 1) / 2, upper: presentation.windowCenter - 0.5 + (presentation.windowWidth - 1) / 2 };
    }
    this.viewport.setProperties(properties); this.viewport.resetCamera(); this.current = imageId;
  }
  async waitForRendered(imageId: string, signal: AbortSignal): Promise<void> {
    alive(signal); if (this.current !== imageId || this.disposed) throw new Error('Unexpected rendered image.');
    let listener: EventListener = () => {};
    const rendered = new Promise<void>(resolve => {
      listener = (event: Event) => {
        const detail = (event as CustomEvent).detail;
        if (detail?.viewportId === this.viewport.id && this.viewport.getCurrentImageId() === imageId) resolve();
      };
      this.element.addEventListener(this.cornerstone.Enums.Events.IMAGE_RENDERED, listener);
      this.viewport.render();
    });
    try { await abortable(rendered, signal); alive(signal); }
    finally { this.element.removeEventListener(this.cornerstone.Enums.Events.IMAGE_RENDERED, listener); }
    if (this.disposed || this.current !== imageId || this.viewport.getCurrentImageId() !== imageId) throw new Error('Unexpected rendered image.');
  }
  async encodeJpeg({ maxEdge, maxEncodedBytes }: { maxEdge: number; maxEncodedBytes: number }): Promise<EncodedFrame> {
    if (this.disposed || !this.current) throw new Error('No rendered image.');
    const source = this.viewport.getCanvas();
    const scale = Math.min(1, maxEdge / Math.max(source.width, source.height));
    const canvas = this.document.createElement('canvas'); canvas.width = Math.max(1, Math.round(source.width * scale)); canvas.height = Math.max(1, Math.round(source.height * scale));
    const context = canvas.getContext('2d'); if (!context) throw new Error('Capture is unavailable.');
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    try {
      for (const quality of [0.9, 0.8, 0.7]) {
        const data = canvas.toDataURL('image/jpeg', quality).split(',')[1];
        if (data && data.length <= maxEncodedBytes) return { data, width: canvas.width, height: canvas.height };
      }
      throw new Error('Frame exceeds the image budget.');
    } finally { canvas.width = 0; canvas.height = 0; }
  }
  geometry(): RenderGeometry {
    const properties = this.viewport.getProperties();
    const presentation = { ...this.requested, invert: Boolean(properties.invert) };
    if (properties.voiRange) {
      presentation.windowWidth = Math.abs(properties.voiRange.upper - properties.voiRange.lower) + 1;
      presentation.windowCenter = (properties.voiRange.upper + properties.voiRange.lower + 1) / 2;
    }
    return { ...this.dimensions, presentation };
  }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.current = ''; try { this.engine.destroy(); } finally { this.element.remove(); } }
}
