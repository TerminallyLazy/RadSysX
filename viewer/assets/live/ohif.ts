import { object, type CaptureRequest, type Json, type ViewerContext } from './protocol.js';

// OHIF's runtime-loaded extension API is dynamic; contain its untyped boundary here.
type Host = Record<string, any>;
export type Managers = { servicesManager: { services: Host }; commandsManager: Host; extensionManager: Host };
export type Attachment = { id: string; kind: 'measurement' | 'roi' | 'segmentation'; label: string; summary: Json };

const TOOL_NAMES = new Set(['WindowLevel', 'Pan', 'Zoom', 'StackScroll', 'Length', 'RectangleROI', 'EllipticalROI', 'ArrowAnnotate', 'Probe', 'Angle', 'Crosshairs']);
function number(value: unknown, min: number, max: number, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${name}.`);
  return value;
}
function text(value: unknown, max = 500): string {
  if (typeof value !== 'string' || value.length > max) throw new Error('Invalid text argument.');
  return value;
}
function list(value: unknown): Host[] { return Array.isArray(value) ? value : []; }

/** Semantic adapter; no model-provided JavaScript, selectors, paths, or arbitrary commands. */
export class OHIFAdapter {
  private managers?: Managers;
  private aliases = new Map<string, string>();
  private actual = new Map<string, string>();
  private subscriptions: Array<{ unsubscribe(): void }> = [];
  onChange?: () => void;
  draftReport?: { findings: string; impression: string; targetId: string };
  private undoActions: Array<() => void> = [];
  private redoActions: Array<() => void> = [];
  constructor(private browser: Window = window) {}
  bind(managers: Managers): void {
    this.subscriptions.forEach(sub => sub.unsubscribe()); this.subscriptions = [];
    this.managers = managers;
    // Cornerstone image/camera events are dispatched on the canvas element without bubbling.
    // Capture listeners keep voice-only turns current after a user scrolls or changes presentation.
    for (const event of ['CORNERSTONE_STACK_NEW_IMAGE', 'CORNERSTONE_VOLUME_NEW_IMAGE', 'CORNERSTONE_CAMERA_MODIFIED', 'CORNERSTONE_VOI_MODIFIED']) {
      const changed = (notification: Event) => {
        try { if (notification.target === this.viewport().viewport.element) this.onChange?.(); } catch {}
      };
      this.browser.document.addEventListener?.(event, changed, true);
      this.subscriptions.push({ unsubscribe: () => this.browser.document.removeEventListener?.(event, changed, true) });
    }
    for (const name of ['viewportGridService', 'cornerstoneViewportService', 'displaySetService', 'measurementService', 'segmentationService']) {
      const service = managers.servicesManager.services[name];
      if (!service?.subscribe || !service.EVENTS) continue;
      for (const event of new Set(Object.values(service.EVENTS))) {
        const sub = service.subscribe(event, () => this.onChange?.());
        if (sub?.unsubscribe) this.subscriptions.push(sub);
      }
    }
    this.onChange?.();
  }
  private get services(): Host {
    if (!this.managers) throw new Error('Open an image to use viewer tools.');
    return this.managers.servicesManager.services;
  }
  private alias(kind: string, id: unknown): string {
    const key = `${kind}:${String(id ?? '')}`;
    if (!this.aliases.has(key)) {
      const alias = `${kind}-${this.aliases.size + 1}`;
      this.aliases.set(key, alias); this.actual.set(alias, String(id ?? ''));
    }
    return this.aliases.get(key)!;
  }
  private resolve(value: unknown, kind: string): string {
    if (typeof value !== 'string' || !value.startsWith(`${kind}-`) || !this.actual.has(value)) throw new Error(`Unknown ${kind} selection.`);
    return this.actual.get(value)!;
  }
  private viewport(id?: unknown): { id: string; viewport: Host; grid: Host } {
    const service = this.services.viewportGridService;
    const actualId = id === undefined ? service.getActiveViewportId() : this.resolve(id, 'viewport');
    const viewport = this.services.cornerstoneViewportService?.getCornerstoneViewport(actualId);
    const grid = service.getState().viewports.get(actualId);
    if (!viewport || !grid) throw new Error('The selected viewport is no longer available.');
    return { id: actualId, viewport, grid };
  }
  private run(name: string, args: Json = {}, context = 'CORNERSTONE'): unknown {
    return this.managers!.commandsManager.runCommand(name, args, context);
  }
  private history(): Host | undefined {
    const module = this.managers?.extensionManager.getModuleEntry?.('@ohif/extension-cornerstone.utilityModule.common');
    return module?.exports?.getCornerstoneLibraries?.()?.cornerstone?.utilities?.HistoryMemo?.DefaultHistoryMemo;
  }
  context(): ViewerContext {
    const fallback: ViewerContext = { targetId: this.alias('target', this.browser.location.pathname), captureTarget: 'viewer', route: this.browser.location.pathname, privacyClass: 'unknown', state: { viewports: [], series: [], measurements: [], segmentations: [] } };
    if (!this.managers) return fallback;
    try {
      const { id, viewport, grid } = this.viewport();
      const displays = list(this.services.displaySetService?.activeDisplaySets);
      const display = displays.find(item => grid.displaySetInstanceUIDs.includes(item.displaySetInstanceUID));
      const activeSource = this.managers.extensionManager.getActiveDataSource?.()?.getConfig?.()?.name ?? this.browser.location.pathname;
      const targetKey = `${activeSource}:${id}:${display?.StudyInstanceUID ?? ''}:${display?.SeriesInstanceUID ?? ''}:${display?.displaySetInstanceUID ?? ''}`;
      const properties = viewport.getProperties?.() ?? {};
      const camera = viewport.getCamera?.() ?? {};
      const pan = viewport.getPan?.() ?? [0, 0];
      const layout = this.services.viewportGridService.getState().layout ?? {};
      const state: Json = {
        viewportId: this.alias('viewport', id), index: viewport.getCurrentImageIdIndex?.() ?? viewport.getSliceIndex?.() ?? 0,
        imageCount: viewport.getImageIds?.()?.length ?? display?.numImageFrames ?? 0,
        modality: display?.Modality ?? null,
        ...(properties.voiRange ? { windowWidth: Math.abs(properties.voiRange.upper - properties.voiRange.lower) + 1, windowCenter: (properties.voiRange.upper + properties.voiRange.lower + 1) / 2 } : {}),
        zoom: viewport.getZoom?.() ?? 1, panX: pan[0], panY: pan[1], rotation: viewport.getRotation?.() ?? properties.rotation ?? 0,
        invert: Boolean(properties.invert), flipHorizontal: Boolean(camera.flipHorizontal), flipVertical: Boolean(camera.flipVertical),
        layout: { rows: layout.numRows, columns: layout.numCols },
        canvasWidth: viewport.element?.clientWidth ?? 0, canvasHeight: viewport.element?.clientHeight ?? 0,
        series: displays.map((item, index) => ({ id: this.alias('series', item.displaySetInstanceUID), label: `Series ${index + 1}`, modality: item.Modality, imageCount: item.numImageFrames ?? item.images?.length ?? 0 })),
        viewports: [...this.services.viewportGridService.getState().viewports.keys()].map((key: string) => ({ id: this.alias('viewport', key), active: key === id })),
        measurements: this.attachments().filter(item => item.kind !== 'segmentation').map(item => item.summary),
        segmentations: this.attachments().filter(item => item.kind === 'segmentation').map(item => item.summary),
      };
      // Only resolved launch identifiers go to the backend; none are sent as tool-readable state.
      const launch = (this.browser as any).__RADSYSX_LAUNCH__?.context;
      return { ...fallback, targetId: this.alias('target', targetKey), state,
        ...(launch?.studyInstanceUID ? { studyInstanceUID: launch.studyInstanceUID, seriesInstanceUID: launch.seriesInstanceUIDs?.[0] } : {}),
      };
    } catch { return fallback; }
  }
  attachments(): Attachment[] {
    if (!this.managers) return [];
    const services = this.managers.servicesManager.services;
    let activeDisplayIds: string[] = [];
    try { activeDisplayIds = this.viewport().grid.displaySetInstanceUIDs; } catch { return []; }
    const measurements = list(services.measurementService?.getMeasurements?.()).filter(item => !item.displaySetInstanceUID || activeDisplayIds.includes(item.displaySetInstanceUID));
    const result: Attachment[] = measurements.map((item, index) => {
      const id = this.alias('measurement', item.uid);
      const kind = /ROI/.test(item.toolName ?? '') ? 'roi' : 'measurement';
      // User labels may carry identifiers; use neutral attachment names.
      return { id, kind, label: `${item.toolName ?? 'Measurement'} ${index + 1}`, summary: { id, kind, type: item.toolName, selected: Boolean(item.selected) } };
    });
    for (const [index, item] of list(services.segmentationService?.getSegmentations?.()).entries()) {
      const id = this.alias('segmentation', item.segmentationId);
      result.push({ id, kind: 'segmentation', label: `Segmentation ${index + 1}`, summary: { id, kind: 'segmentation', segments: Object.keys(item.segments ?? {}).length } });
    }
    return result;
  }
  capture(): Pick<CaptureRequest, 'viewportId' | 'rect'> {
    const { id, viewport } = this.viewport();
    const element = viewport.element as HTMLElement;
    if (!element?.isConnected) throw new Error('The active image is not visible.');
    const bounds = element.getBoundingClientRect();
    return { viewportId: id, rect: { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) } };
  }
  async execute(name: string, args: Json): Promise<Json> {
    if (name === 'viewer_get_state') return this.context().state;
    if (name === 'viewer_open_worklist') { setTimeout(() => this.browser.location.assign('/worklist'), 150); return { applied: true }; }
    if (name === 'study_open') {
      const url = new URL(text(args.url, 2000), this.browser.location.origin);
      const keys = [...url.searchParams.keys()];
      if (url.origin !== this.browser.location.origin || !/^\/viewer\/?$/.test(url.pathname) || url.hash || url.username || url.password || keys.length !== 1 || keys[0] !== 'launch' || !url.searchParams.get('launch')) throw new Error('Invalid governed viewer launch.');
      setTimeout(() => this.browser.location.assign(url.href), 150);
      return { applied: true };
    }
    if (name === 'report_draft') {
      const findings = text(args.findings ?? '', 20000), impression = text(args.impression ?? '', 10000);
      const targetId = this.context().targetId;
      const before = this.draftReport;
      const workspace = this.browser.document.querySelector('radsysx-workspace-panel') as any;
      const workspaceBefore = workspace?.state ? { findings: workspace.state.draftFindings, impression: workspace.state.draftImpression } : undefined;
      const after = { findings, impression, targetId };
      const apply = (value: typeof after | undefined, workspaceValue: { findings: string; impression: string } | undefined = value) => {
        this.draftReport = value;
        const panel = this.browser.document.querySelector('radsysx-workspace-panel') as any;
        if (panel?.state && targetId === this.context().targetId) {
          panel.state.draftFindings = workspaceValue?.findings ?? '';
          panel.state.draftImpression = workspaceValue?.impression ?? '';
          panel.render();
        }
        this.onChange?.();
      };
      apply(after);
      const history = this.history();
      if (history) {
        // Use the same history as annotations so the latest edit is undone first,
        // including edits made manually with the viewer's own tools.
        history.push({ restoreMemo: (undo = true) => undo ? apply(before, workspaceBefore) : apply(after) });
      } else {
        // A local draft can exist before the Cornerstone extension is available.
        this.redoActions = [];
        const undo = () => { apply(before, workspaceBefore); this.redoActions.push(redo); };
        const redo = () => { apply(after); this.undoActions.push(undo); };
        this.undoActions.push(undo);
        if (this.undoActions.length > 50) this.undoActions.shift();
      }
      return { applied: true, status: 'draft_only' };
    }
    if (name === 'viewer_undo' && !this.history() && this.undoActions.length) { this.undoActions.pop()!(); return { undone: true }; }
    if (name === 'viewer_redo' && !this.history() && this.redoActions.length) { this.redoActions.pop()!(); return { redone: true }; }
    const { id, viewport } = this.viewport(args.viewportId);
    this.services.viewportGridService.setActiveViewportId(id);
    switch (name) {
      case 'viewer_set_window_level':
        if (args.preset) await this.run('setWindowLevelPreset', { presetName: text(args.preset, 80) });
        else await this.run('setViewportWindowLevel', { viewportId: id, windowWidth: number(args.windowWidth, 0.01, 100000, 'window width'), windowCenter: number(args.windowCenter, -100000, 100000, 'window center') });
        break;
      case 'viewer_set_layout': {
        const rows = number(args.rows, 1, 4, 'rows'), columns = number(args.columns, 1, 4, 'columns');
        if (!Number.isInteger(rows) || !Number.isInteger(columns)) throw new Error('Layout dimensions must be integers.');
        await this.run('setViewportGridLayout', { numRows: rows, numCols: columns }, 'DEFAULT'); break;
      }
      case 'viewer_open_series': {
        const displaySetInstanceUID = this.resolve(args.displaySetId, 'series');
        if (!list(this.services.displaySetService.activeDisplaySets).some(item => item.displaySetInstanceUID === displaySetInstanceUID)) throw new Error('Series is no longer loaded.');
        await this.run('setDisplaySetsForViewports', { viewportsToUpdate: [{ viewportId: id, displaySetInstanceUIDs: [displaySetInstanceUID] }] }); break;
      }
      case 'viewer_jump_to_slice': {
        const count = viewport.getImageIds?.()?.length;
        const index = number(args.index, 0, typeof count === 'number' ? count - 1 : 100000, 'slice index');
        if (!Number.isInteger(index)) throw new Error('Slice index must be an integer.');
        await this.run('jumpToImage', { imageIndex: index }); break;
      }
      case 'viewer_set_tool': {
        const toolName = text(args.tool, 80);
        if (!TOOL_NAMES.has(toolName)) throw new Error('This tool is not available to the assistant.');
        await this.run('setToolActive', { toolName }); break;
      }
      case 'viewer_set_view':
        if (args.reset === true) await this.run('resetViewport');
        if (args.zoom !== undefined) { if (!viewport.setZoom) throw new Error('Zoom is not supported here.'); viewport.setZoom(number(args.zoom, 0.1, 20, 'zoom')); }
        if (args.panX !== undefined || args.panY !== undefined) { if (!viewport.setPan) throw new Error('Pan is not supported here.'); viewport.setPan([number(args.panX ?? 0, -5000, 5000, 'pan'), number(args.panY ?? 0, -5000, 5000, 'pan')]); }
        if (args.rotation !== undefined) await this.run('rotateViewportCWSet', { rotation: number(args.rotation, -360, 360, 'rotation') });
        if (typeof args.flipHorizontal === 'boolean') await this.run('setViewportHorizontalFlip', { flipped: args.flipHorizontal });
        if (typeof args.flipVertical === 'boolean') await this.run('setViewportVerticalFlip', { flipped: args.flipVertical });
        if (typeof args.invert === 'boolean') viewport.setProperties({ invert: args.invert });
        viewport.render(); break;
      case 'viewer_measurement': await this.measurement(args, viewport, id); break;
      case 'viewer_segmentation': {
        const segmentationId = this.resolve(args.segmentationId, 'segmentation');
        if (!this.services.segmentationService.getSegmentation(segmentationId)) throw new Error('Segmentation no longer exists.');
        if (args.operation === 'select') await this.run('setActiveSegmentation', { segmentationId, viewportId: id });
        else if (args.operation === 'visibility' && typeof args.visible === 'boolean') {
          const service = this.services.segmentationService;
          const libs = this.libraries();
          const visibility = libs.cornerstoneTools.segmentation.config.visibility;
          const reps = service.getSegmentationRepresentations(id).filter((rep: Host) => rep.segmentationId === segmentationId);
          if (!reps.length) throw new Error('Segmentation is not attached to this viewport.');
          reps.forEach((rep: Host) => visibility.setSegmentationRepresentationVisibility(id, { segmentationId, type: rep.type }, args.visible));
          viewport.render();
        } else throw new Error('Unsupported segmentation operation.');
        break;
      }
      case 'viewer_undo': await this.run('undo'); break;
      case 'viewer_redo': await this.run('redo'); break;
      default: throw new Error('Unsupported viewer action.');
    }
    this.onChange?.();
    return { applied: true, state: this.context().state };
  }
  private libraries(): Host {
    const module = this.managers!.extensionManager.getModuleEntry('@ohif/extension-cornerstone.utilityModule.common');
    const libraries = module?.exports?.getCornerstoneLibraries?.();
    if (!libraries?.cornerstoneTools) throw new Error('Annotation tools are unavailable.');
    return libraries;
  }
  private async measurement(args: Json, viewport: Host, viewportId: string): Promise<void> {
    const service = this.services.measurementService;
    if (args.operation !== 'create') {
      const uid = this.resolve(args.measurementId, 'measurement');
      const measurement = service.getMeasurement(uid);
      if (!measurement) throw new Error('Measurement no longer exists.');
      if (args.operation === 'jump') await this.run('jumpToMeasurement', { uid });
      else if (args.operation === 'delete') service.remove(uid);
      else if (args.operation === 'update') await this.run('updateMeasurement', { uid, textLabel: text(args.label ?? '') });
      else throw new Error('Unsupported measurement operation.');
      return;
    }
    const type = args.type ?? 'Length';
    if (!['Length', 'RectangleROI', 'ArrowAnnotate'].includes(String(type))) throw new Error('Use Length, RectangleROI, or ArrowAnnotate.');
    if (!Array.isArray(args.points) || args.points.length !== 2) throw new Error('Provide two normalized image points.');
    let points = args.points.map(point => {
      if (!Array.isArray(point) || point.length !== 2) throw new Error('Invalid image point.');
      return [number(point[0], 0, 1, 'x coordinate'), number(point[1], 0, 1, 'y coordinate')];
    });
    if (type === 'RectangleROI') { const [a, b] = points; points = [a, [b[0], a[1]], [a[0], b[1]], b]; }
    const canvas = viewport.element as HTMLElement;
    const world = points.map(([x, y]) => viewport.canvasToWorld([x * canvas.clientWidth, y * canvas.clientHeight]));
    const { cornerstone, cornerstoneTools } = this.libraries();
    const ToolClass = cornerstoneTools[`${type}Tool`];
    if (!ToolClass?.createAnnotationForViewport) throw new Error('This annotation cannot be created in the current viewport.');
    const label = text(args.label ?? '');
    const annotation = ToolClass.createAnnotationForViewport(viewport, {
      annotationUID: crypto.randomUUID(), highlighted: false, invalidated: true,
      data: { handles: { points: world, activeHandleIndex: null, textBox: { hasMoved: false, worldPosition: [0, 0, 0], worldBoundingBox: {} } }, label, text: label, cachedStats: {} },
    });
    cornerstoneTools.annotation.state.addAnnotation(annotation, canvas);
    cornerstone.triggerEvent(cornerstone.eventTarget, cornerstoneTools.Enums.Events.ANNOTATION_COMPLETED, { annotation, viewportId, renderingEngineId: viewport.renderingEngineId });
    await this.run('triggerCreateAnnotationMemo', { annotation, FrameOfReferenceUID: annotation.metadata.FrameOfReferenceUID, options: { newAnnotation: true } });
    viewport.render();
    if (!service.getMeasurement(annotation.annotationUID)) throw new Error('Annotation was added, but measurement registration needs review.');
  }
}
