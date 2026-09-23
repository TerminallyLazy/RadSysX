import type { DesktopStudyCapture, FrameDescriptor, ImageObservation, ObservationRequest, ObservationResult, RendererBinding } from './protocol.js';
import { alive, digest, SeriesRegistry, type EncodedFrame, type RenderGeometry, type SeriesHost, type SeriesRenderer } from './series.js';

export interface WorkspaceObserver {
  observe(request: ObservationRequest, binding: RendererBinding, signal: AbortSignal): Promise<Pick<ObservationResult, 'images' | 'failures'>>;
  dispose(): void;
}
export async function makeFrameObservation(frame: FrameDescriptor, manifestId: string, jpeg: EncodedFrame, geometry: RenderGeometry): Promise<ImageObservation> {
  if (!jpeg.data || jpeg.data.length > 1024 * 1024 || !Number.isInteger(jpeg.width) || !Number.isInteger(jpeg.height) || jpeg.width < 1 || jpeg.height < 1 || jpeg.width > 2048 || jpeg.height > 2048) throw new Error('Frame exceeds the image budget.');
  const bytes = Uint8Array.from(atob(jpeg.data), c => c.charCodeAt(0));
  return { imageId: `image-${crypto.randomUUID()}`, kind: 'frame', frameId: frame.id, manifestId, index: frame.index,
    width: jpeg.width, height: jpeg.height, originalWidth: geometry.columns, originalHeight: geometry.rows,
    presentation: geometry.presentation, capturedAt: new Date().toISOString(), sha256: await digest(bytes), data: jpeg.data };
}
export class ObservationService {
  readonly registry: SeriesRegistry;
  private renderer?: SeriesRenderer;
  private disposed = false;
  private busy = false;
  constructor(private adapter: SeriesHost, private desktop: WorkspaceObserver | null, options: { registry?: SeriesRegistry; renderer?: SeriesRenderer } = {}) {
    this.registry = options.registry ?? new SeriesRegistry(adapter); this.renderer = options.renderer;
  }
  private check(binding: RendererBinding, signal: AbortSignal): void {
    alive(signal); if (this.disposed) throw new Error('Capture stopped.');
    const now = this.adapter.studyBinding();
    if (now.studyId !== binding.studyId || binding.seriesIds.some(id => !now.seriesIds.includes(id))) throw new Error('The shared study changed.');
  }
  async observe(request: ObservationRequest, binding: RendererBinding, signal: AbortSignal): Promise<ObservationResult> {
    this.check(binding, signal);
    if (this.busy) throw new Error('An observation is already running.');
    this.busy = true;
    // Claim identity is supplied by the controller after it executes this service.
    const result: ObservationResult = { operationId: 'op-pending', claimId: 'claim-pending', revision: binding.revision, images: [], failures: [] };
    try {
      if (request.kind !== 'series_frames') {
        if (!this.desktop) throw new Error('Workspace capture is unavailable.');
        const observed = await this.desktop.observe(request, binding, signal); this.check(binding, signal);
        return { ...result, ...observed };
      }
      if (!request.frameIds.length || request.frameIds.length > 8 || new Set(request.frameIds).size !== request.frameIds.length || !request.manifestId) throw new Error('Choose one to eight distinct frames.');
      const selected = request.frameIds.map(id => this.registry.frame(id, request.manifestId));
      if (selected.some(({ manifest }) => !binding.seriesIds.includes(manifest.seriesId))) throw new Error('Frames are outside the shared study.');
      this.renderer ??= this.adapter.createSeriesRenderer?.();
      if (!this.renderer) throw new Error('Native series rendering is unavailable.');
      let remaining = 8 * 1024 * 1024;
      for (const { frame, manifest } of selected) {
        this.check(binding, signal);
        try {
          const imageId = this.registry.resolve(frame.id);
          const presentation = { ...this.adapter.presentation(), ...request.presentation };
          await this.renderer.setFrame(imageId, presentation, signal); this.check(binding, signal);
          await this.renderer.waitForRendered(imageId, signal); this.check(binding, signal);
          const jpeg = await this.renderer.encodeJpeg({ maxEdge: 2048, maxEncodedBytes: Math.min(1024 * 1024, remaining) }); this.check(binding, signal);
          const image = await makeFrameObservation(frame, manifest.manifestId, jpeg, this.renderer.geometry()); this.check(binding, signal);
          if(this.registry.resolve(frame.id)!==imageId)throw new Error('The series changed during capture.');
          remaining -= image.data.length; if (remaining < 0) throw new Error('Image budget exceeded.');
          result.images.push(image);
        } catch {
          this.check(binding, signal);
          result.failures.push({ id: frame.id, reason: 'render_failed' });
        }
      }
      return result;
    } finally { this.busy = false; }
  }
  dispose(): void { this.disposed = true; this.renderer?.dispose(); this.renderer = undefined; this.registry.invalidate(); this.desktop?.dispose(); }
}

/** One capture lease per claimed operation; it never survives a revision change. */
export class DesktopWorkspaceObserver implements WorkspaceObserver {
  private lease?: string;
  private disposed = false;
  constructor(private desktop: DesktopStudyCapture, private task: { sessionId: string; taskId: string; operationId: string }, private prepareSurface: (binding: RendererBinding) => void) {}
  async observe(request: ObservationRequest, binding: RendererBinding, signal: AbortSignal): Promise<Pick<ObservationResult, 'images' | 'failures'>> {
    if (request.kind === 'series_frames') throw new Error('Use the native series renderer.');
    alive(signal); if (this.disposed || this.lease) throw new Error('Capture is unavailable.');
    this.prepareSurface(binding);
    const stop = () => { if (this.lease) void this.desktop.stopStudyCapture({ leaseId: this.lease }).catch(() => {}); };
    signal.addEventListener('abort', stop, { once: true });
    try {
      const lease = await this.desktop.startStudyCapture({ sessionId: this.task.sessionId, taskId: this.task.taskId, binding });
      this.lease = lease.leaseId; alive(signal); if (this.disposed) throw new Error('Capture stopped.');
      const result = await this.desktop.captureStudyObservation({ leaseId: lease.leaseId, operationId: this.task.operationId, kind: request.kind, viewportIds: request.viewportIds });
      alive(signal); if (this.disposed) throw new Error('Capture stopped.');
      return result;
    } finally {
      signal.removeEventListener('abort', stop);
      if (this.lease) await this.desktop.stopStudyCapture({ leaseId: this.lease }).catch(() => {});
      this.lease = undefined;
    }
  }
  dispose(): void { this.disposed = true; if (this.lease) void this.desktop.stopStudyCapture({ leaseId: this.lease }).catch(() => {}); }
}
