import { applyMeasurement, applyCalibration, applySegmentation, applyRegion, readMeasurements, measurementSpecs } from './measurements.js';
import { capabilities, READING_TOOLS, ANNOTATION_TOOLS, validateArguments } from './capabilities.js';
import { executeReadingTool } from './reading-tools.js';
import { alive, abortable, CornerstoneSeriesRenderer, type SeriesSource, type PrivateFrame } from './series.js';
import type { Presentation, RendererBinding } from './protocol.js';
import { object, type CaptureRequest, type Json, type ViewerContext } from './protocol.js';

// OHIF's runtime-loaded extension API is dynamic; contain its untyped boundary here.
type Host = Record<string, any>;
export type Managers = { servicesManager: { services: Host }; commandsManager: Host; extensionManager: Host };
export type Attachment = { id: string; kind: 'measurement' | 'roi' | 'segmentation'; label: string; summary: Json };

const TOOL_NAMES = new Set(['WindowLevel', 'Pan', 'Zoom', 'StackScroll', 'Length', 'RectangleROI', 'EllipticalROI', 'CircleROI', 'ArrowAnnotate', 'Probe', 'Angle', 'CobbAngle', 'Bidirectional', 'PlanarFreehandROI', 'SplineROI', 'LivewireContour', 'UltrasoundDirectionalTool', 'CalibrationLine', 'Magnify', 'AdvancedMagnify', 'WindowLevelRegion', 'TrackballRotate', 'Crosshairs', 'PlanarFreehandContourSegmentationTool', 'SegmentLabelTool']);
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
  private readingResources = new Map<string, () => void>();
  private cineOwned = new Map<string, Host>();
  private geometryFrames = new Map<string, { frameId: string; revision: number; fingerprint: string }>();
  private aliases = new Map<string, string>();
  private actual = new Map<string, string>();
  private subscriptions: Array<{ unsubscribe(): void }> = [];
  onChange?: () => void;
  draftReport?: { findings: string; impression: string; targetId: string };
  explorationSeries?: string[];
  private undoActions: Array<() => void> = [];
  private redoActions: Array<() => void> = [];
  constructor(private browser: Window = window) {}
  private activeDataSource(): Host | undefined {
    const active = this.managers?.extensionManager.getActiveDataSource?.();
    return Array.isArray(active) ? active[0] : active;
  }
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
      const activeSource = this.activeDataSource()?.getConfig?.()?.name ?? this.browser.location.pathname;
      const targetKey = `${activeSource}:${id}:${display?.StudyInstanceUID ?? ''}:${display?.SeriesInstanceUID ?? ''}:${display?.displaySetInstanceUID ?? ''}`;
      const properties = viewport.getProperties?.() ?? {};
      const camera = viewport.getCamera?.() ?? {};
      const pan = viewport.getPan?.() ?? [0, 0];
      const layout = this.services.viewportGridService.getState().layout ?? {};
      const state: Json = {
        studyId: this.alias('study', display?.StudyInstanceUID), seriesId: this.alias('series', display?.displaySetInstanceUID),
        viewportId: this.alias('viewport', id), index: viewport.getCurrentImageIdIndex?.() ?? viewport.getSliceIndex?.() ?? 0,
        imageCount: viewport.getImageIds?.()?.length ?? display?.numImageFrames ?? 0,
        modality: display?.Modality ?? null,
        ...(properties.voiRange ? { windowWidth: Math.abs(properties.voiRange.upper - properties.voiRange.lower) + 1, windowCenter: (properties.voiRange.upper + properties.voiRange.lower + 1) / 2 } : {}),
        zoom: viewport.getZoom?.() ?? 1, panX: pan[0], panY: pan[1], rotation: viewport.getRotation?.() ?? properties.rotation ?? 0,
        invert: Boolean(properties.invert), flipHorizontal: Boolean(camera.flipHorizontal), flipVertical: Boolean(camera.flipVertical),
        layout: { rows: layout.numRows, columns: layout.numCols },
        canvasWidth: viewport.element?.clientWidth ?? 0, canvasHeight: viewport.element?.clientHeight ?? 0,
        series: displays.map((item, index) => ({ id: this.alias('series', item.displaySetInstanceUID), studyId: this.alias('study', item.StudyInstanceUID), label: `Series ${index + 1}`, modality: item.Modality, imageCount: item.numImageFrames ?? item.images?.length ?? 0 })),
        viewports: [...this.services.viewportGridService.getState().viewports.entries()].map(([key,pane]: [string,Host]) => ({ id: this.alias('viewport', key), active: key === id, seriesIds: (pane.displaySetInstanceUIDs??[]).map((uid:string)=>this.alias('series',uid)) })),
        measurements: this.measurementValues(),
        segmentations: this.attachments().filter(item => item.kind === 'segmentation').map(item => item.summary),
      };
      // Only resolved launch identifiers go to the backend; none are sent as tool-readable state.
      const launch = (this.browser as any).__RADSYSX_LAUNCH__?.context;
      return { ...fallback, targetId: this.alias('target', targetKey), state,
        ...(launch?.studyInstanceUID ? { studyInstanceUID: launch.studyInstanceUID, seriesInstanceUID: launch.seriesInstanceUIDs?.[0] } : {}),
      };
    } catch { return fallback; }
  }
  studyBinding(): { studyId: string; seriesIds: string[] } {
    const { grid } = this.viewport();
    const displays = list(this.services.displaySetService?.activeDisplaySets);
    const selected = displays.filter(item => grid.displaySetInstanceUIDs.includes(item.displaySetInstanceUID));
    if (!selected.length || !selected[0].StudyInstanceUID || selected.some(item => item.StudyInstanceUID !== selected[0].StudyInstanceUID)) throw new Error('Choose one study to share.');
    return { studyId: this.alias('study', selected[0].StudyInstanceUID), seriesIds: displays.filter(item => item.StudyInstanceUID === selected[0].StudyInstanceUID).map(item => this.alias('series', item.displaySetInstanceUID)) };
  }
  presentation(): Presentation {
    const properties = this.viewport().viewport.getProperties?.() ?? {};
    return { invert: Boolean(properties.invert), ...(properties.voiRange ? {
      windowWidth: Math.abs(properties.voiRange.upper - properties.voiRange.lower) + 1,
      windowCenter: (properties.voiRange.upper + properties.voiRange.lower + 1) / 2,
    } : {}) };
  }
  seriesFrames(seriesId: string): SeriesSource {
    const uid = this.resolve(seriesId, 'series');
    const display = list(this.services.displaySetService?.activeDisplaySets).find(item => item.displaySetInstanceUID === uid);
    if (!display || !this.studyBinding().seriesIds.includes(seriesId)) throw new Error('Series is outside the current study.');
    const dataSource = this.activeDataSource();
    const imageIds: unknown = dataSource?.getImageIdsForDisplaySet?.(display);
    if (!Array.isArray(imageIds) || imageIds.some(id => typeof id !== 'string') || !imageIds.length) throw new Error('A complete image inventory is unavailable.');
    const expected = display.numImageFrames ?? list(display.images).reduce((count, image) => count + (image.NumberOfFrames ?? 1), 0);
    const { cornerstone } = this.libraries();
    const frames: PrivateFrame[] = imageIds.map((imageId: string, index: number) => {
      const plane = cornerstone.metaData.get('imagePlaneModule', imageId) ?? {};
      const pixels = cornerstone.metaData.get('imagePixelModule', imageId) ?? {};
      const general = cornerstone.metaData.get('generalImageModule', imageId) ?? {};
      return { imageId, index, rows: plane.rows ?? pixels.rows, columns: plane.columns ?? pixels.columns,
        ...(plane.imagePositionPatient ? { position: Array.from(plane.imagePositionPatient) as number[] } : {}),
        ...(plane.rowCosines && plane.columnCosines ? { orientation: [...plane.rowCosines, ...plane.columnCosines] } : {}),
        ...(plane.rowPixelSpacing && plane.columnPixelSpacing ? { spacing: [plane.rowPixelSpacing, plane.columnPixelSpacing] } : {}),
        ...(Number.isInteger(general.temporalPositionIndex) ? { timeIndex: general.temporalPositionIndex } : {}),
      };
    });
    const modality = ['CT','MR','US','PT','CR','DX','XA','RF','MG','NM','OT','SEG'].includes(display.Modality) ? display.Modality : 'OT';
    return { studyId: this.alias('study', display.StudyInstanceUID), seriesId, modality, frames, complete: expected === imageIds.length };
  }
  registerCaptureSurface(binding: RendererBinding): void {
    const study = this.studyBinding();
    if (study.studyId !== binding.studyId || binding.seriesIds.some(id => !study.seriesIds.includes(id))) throw new Error('The study changed.');
    const grid = this.browser.document.querySelector('[data-cy="viewport-grid"]') as HTMLElement | null;
    if (!grid) throw new Error('The reading workspace is unavailable.');
    grid.dataset.radsysxStudy = study.studyId; grid.dataset.radsysxRenderer = binding.rendererId;
    grid.dataset.radsysxEpoch = binding.epoch; grid.dataset.radsysxRevision = String(binding.revision);
    const displays = list(this.services.displaySetService?.activeDisplaySets);
    for (const element of Array.from(grid.querySelectorAll<HTMLElement>('[data-viewportid]'))) {
      const id = element.getAttribute('data-viewportid')!;
      const native = this.services.viewportGridService.getState().viewports.get(id);
      const included = displays.filter(item => native?.displaySetInstanceUIDs.includes(item.displaySetInstanceUID));
      if (!included.length || included.some(item => item.StudyInstanceUID !== included[0].StudyInstanceUID)) throw new Error('The pane has no single study.');
      element.dataset.radsysxViewport = this.alias('viewport', id); element.dataset.radsysxStudy = this.alias('study',included[0].StudyInstanceUID);
      element.dataset.radsysxSeries = JSON.stringify(included.map(item => this.alias('series', item.displaySetInstanceUID)));
      const properties = this.services.cornerstoneViewportService.getCornerstoneViewport(id)?.getProperties?.() ?? {};
      element.dataset.radsysxPresentation = JSON.stringify({ invert: Boolean(properties.invert), ...(properties.voiRange ? {
        windowWidth: Math.abs(properties.voiRange.upper - properties.voiRange.lower) + 1,
        windowCenter: (properties.voiRange.upper + properties.voiRange.lower + 1) / 2,
      } : {}) });
    }
  }
  createSeriesRenderer(): CornerstoneSeriesRenderer {
    return new CornerstoneSeriesRenderer(this.libraries().cornerstone, this.browser.document);
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
  private measurementValues(): Json[] {
    try { return readMeasurements(this,(this.explorationSeries??this.studyBinding().seriesIds).map(id => this.resolve(id,'series'))).slice(0,20).map(value => ({...value,points:value.points.slice(0,8),pointCount:value.pointCount,geometryComplete:value.geometryComplete && value.points.length<=8,values:value.values.slice(0,8)})) as unknown as Json[]; }
    catch { return this.attachments().filter(item => item.kind !== 'segmentation').map(item => item.summary); }
  }
  capture(): Pick<CaptureRequest, 'viewportId' | 'rect'> {
    const { id, viewport } = this.viewport();
    const element = viewport.element as HTMLElement;
    if (!element?.isConnected) throw new Error('The active image is not visible.');
    const bounds = element.getBoundingClientRect();
    return { viewportId: id, rect: { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) } };
  }
  private viewportAdapter(viewport: Host): Host | undefined {
    return this.managers?.extensionManager.getModuleEntry?.('@ohif/extension-cornerstone.utilityModule.common')?.exports?.getViewportAdapter?.(viewport);
  }
  private panelId(panel: unknown): string | undefined {
    const choices: Record<string, string[]> = {
      series: ['@ohif/extension-default.panelModule.seriesList'],
      measurements: ['@ohif/extension-measurement-tracking.panelModule.trackedMeasurements', '@ohif/extension-cornerstone.panelModule.panelMeasurement'],
      segmentation: ['@ohif/extension-cornerstone.panelModule.panelSegmentation', '@ohif/extension-cornerstone.panelModule.panelSegmentationWithToolsLabelMap'],
      report: ['@radsysx/extension-clinical.panelModule.workspace'],
    };
    const panels = ['left','right'].flatMap(side => this.services.panelService?.getPanels?.(side) ?? []);
    return choices[String(panel)]?.find(id => panels.some((entry: Host) => entry.id === id));
  }
  readingAvailability(name: string, args: Json = {}): { available: boolean; reason?: string } {
    try {
      const { id, viewport, grid } = this.viewport(args.viewportId);
      const native = this.viewportAdapter(viewport);
      const displays = list(this.services.displaySetService?.activeDisplaySets).filter(ds => grid.displaySetInstanceUIDs.includes(ds.displaySetInstanceUID));
      const reconstructable = displays.some(ds => ds.isReconstructable === true);
      const toolbar = this.services.toolbarService?.state?.buttons ?? {};
      const disabled = (button: string) => toolbar[button]?.props?.disabled === true || toolbar[button]?.props?.visible === false;
      let available = true;
      switch (name) {
        case 'viewer_region': available = (args.tool ? [String(args.tool)] : ['WindowLevelRegion','Magnify','AdvancedMagnify','TrackballRotate']).some(tool => !disabled(tool) && this.services.toolGroupService?.getToolGroupForViewport(id)?.hasTool(tool)); break;
        case 'viewer_calibrate': available = Boolean(viewport.getCurrentImageId?.() && this.libraries().cornerstoneTools.utilities?.calibrateImageSpacing); break;
        case 'viewer_segmentation': available = Boolean(this.services.segmentationService?.getSegmentationRepresentations?.(id)?.length); break;
        case 'viewer_measurement': { const tool = args.type === 'UltrasoundDirectional' ? 'UltrasoundDirectionalTool' : args.type; available = Boolean(this.services.measurementService && this.services.toolGroupService?.getToolGroupForViewport(id) && (!tool || !disabled(String(tool)) && this.services.toolGroupService.getToolGroupForViewport(id).hasTool(tool))); break; }
        case 'viewer_set_orientation': available = Boolean(reconstructable && native?.canReorientInPlace() && !disabled('orientationMenu')); break;
        case 'viewer_set_mpr': available = Boolean(reconstructable && this.services.hangingProtocolService?.getProtocolById?.(String(args.layout ?? 'mpr'))); break;
        case 'viewer_set_crosshair': available = Boolean(native?.isVolumeRendering() && viewport.jumpToWorld && this.services.toolGroupService?.getToolGroupForViewport?.(id)?.hasTool('Crosshairs')); break;
        case 'viewer_set_cine': available = Boolean(this.services.cineService?.setCine && (viewport.getImageIds?.()?.length ?? displays[0]?.numImageFrames ?? 0) > 1 && !disabled('Cine')); break;
        case 'viewer_set_sync': available = Boolean(this.services.syncGroupService?.addViewportToSyncGroup && this.services.viewportGridService.getState().viewports.size > 1); break;
        case 'viewer_open_panel': available = args.panel ? Boolean(this.panelId(args.panel)) : ['series','measurements','segmentation','report'].some(panel => this.panelId(panel)); break;
        case 'viewer_set_fusion': available = Boolean(native?.isVolumeRendering() && displays.length > 1 && displays.every(ds => ds.StudyInstanceUID === displays[0].StudyInstanceUID)); break;
        case 'viewer_set_rendering': available = Boolean(native?.hasContent()); break;
        case 'viewer_set_volume': available = Boolean(native && ['volume','volume3d'].includes(native.getShape())); break;
      }
      return { available, ...(available ? {} : { reason: 'Unavailable for the current pane, data or native tool group.' }) };
    } catch { return { available: false, reason: 'Open a supported image in the current study.' }; }
  }
  private assertPaneStudy(id: string, studyId: string): void {
    const grid = this.services.viewportGridService.getState().viewports.get(id);
    const displays = list(this.services.displaySetService?.activeDisplaySets).filter(ds => grid?.displaySetInstanceUIDs.includes(ds.displaySetInstanceUID));
    if (!displays.length || displays.some(ds => this.alias('study', ds.StudyInstanceUID) !== studyId)) throw new Error('This pane is outside the shared study.');
    if(this.explorationSeries && displays.some(ds=>!this.explorationSeries!.includes(this.alias('series',ds.displaySetInstanceUID))))throw new Error('This pane is outside the shared series.');
  }
  private async settleReading(signal: AbortSignal, predicate: () => boolean = () => true, guard: () => void = () => {}): Promise<void> {
    const started = Date.now(); let frames = 0;
    do {
      alive(signal);
      await abortable(new Promise<void>(resolve => this.browser.requestAnimationFrame ? this.browser.requestAnimationFrame(() => resolve()) : setTimeout(resolve, 0)), signal, 8000);
      alive(signal); guard(); frames++;
      if (frames >= 2 && predicate()) return;
    } while (Date.now() - started < 8000);
    throw new Error('Native reading state did not settle.');
  }
  private presentationMemo(viewport: Host, id: string): () => void {
    const native = this.viewportAdapter(viewport);
    const overlays = Array.from(viewport.element.querySelectorAll('.viewport-overlay')) as HTMLElement[];
    const visibility = overlays.map(element => !element.classList.contains('hidden'));
    const group = this.services.toolGroupService?.getToolGroupForViewport(id);
    const modes = ['ReferenceLines','ImageOverlayViewer'].filter(tool => group?.hasTool(tool)).map(tool => ({ tool, mode: group.getToolInstance(tool)?.mode }));
    const view = structuredClone(native?.getViewState() ?? viewport.getCamera?.() ?? {});
    const grid = this.services.viewportGridService.getState().viewports.get(id);
    const layers = native ? (grid?.displaySetInstanceUIDs ?? []).map((uid: string) => { const dataId = native.getDataIdForDisplaySet(uid); return { dataId, properties: structuredClone(native.getPresentation(dataId)) }; }) : [];
    const properties = structuredClone(viewport.getProperties?.() ?? {});
    const pan = viewport.getPan?.(), zoom = viewport.getZoom?.();
    const actor = viewport.getActors?.()?.[0]?.actor, mapper = actor?.getMapper?.(), lighting = actor?.getProperty?.();
    const light = Object.fromEntries(['Ambient','Diffuse','Specular','Shade'].filter(key => lighting?.[`get${key}`]).map(key => [key, lighting[`get${key}`]() ]));
    const mapping = Object.fromEntries(['SampleDistance','MaximumSamplesPerRay','BlendMode'].filter(key => mapper?.[`get${key}`]).map(key => [key, mapper[`get${key}`]() ]));
    const slab = viewport.getSlabThickness?.(), opacity = lighting?.getScalarOpacity?.(0);
    const opacityPoints = opacity && Array.from({ length: opacity.getSize() }, (_, index) => { const point = [0,0,0,0]; opacity.getNodeValue(index, point); return point; });
    return () => {
      overlays.forEach((element,index) => element.classList.toggle('hidden', !visibility[index]));
      modes.forEach(({ tool, mode }) => { if (mode === 'Enabled') group.setToolEnabled(tool); else if (mode === 'Disabled') group.setToolDisabled(tool); });
      if (native) { native.setViewState(view); layers.forEach((layer: Host) => native.setPresentation(layer.properties, layer.dataId)); }
      else { viewport.setCamera?.(view); viewport.setProperties?.(properties); }
      if (pan) viewport.setPan?.(pan); if (zoom) viewport.setZoom?.(zoom);
      Object.entries(light).forEach(([key,value]) => lighting[`set${key}`]?.(value));
      Object.entries(mapping).forEach(([key,value]) => mapper[`set${key}`]?.(value));
      if (slab !== undefined) viewport.setSlabThickness?.(slab);
      if (opacityPoints) { opacity.removeAllPoints(); opacityPoints.forEach((point: number[]) => opacity.addPoint(...point)); }
      viewport.render();
    };
  }
  ownReadingResource(key: string, cleanup?: () => void): void {
    this.readingResources.get(key)?.(); this.readingResources.delete(key); if (cleanup) this.readingResources.set(key,cleanup);
  }
  stopReadingActivity(): void {
    this.readingResources.forEach(cleanup => { try { cleanup(); } catch {} }); this.readingResources.clear();
    for (const [id, viewport] of this.cineOwned) {
      try { this.services.cineService?.setCine?.({ id, isPlaying: false }); this.services.cineService?.stopClip?.(viewport.element); } catch {}
    }
    this.cineOwned.clear();
  }
  async performReadingTool(name: string, args: Json, signal: AbortSignal): Promise<Json> {
    alive(signal);
    const study = this.studyBinding();
    const { id, viewport, grid } = this.viewport(args.viewportId);
    this.assertPaneStudy(id, study.studyId);
    const native = this.viewportAdapter(viewport);
    const affected = [id];
    const before = new Map([[id, this.presentationMemo(viewport, id)]]);
    const guard = () => { alive(signal); const current = this.context().state.studyId; if (current && current !== study.studyId) throw new Error('The study changed during the action.'); };
    const run = async (command: string, options: Json = {}, context = 'CORNERSTONE') => { guard(); const value = await this.run(command, options, context); guard(); return value; };

    let predicate = () => true;
    let result: Json = {};
    let presentationChanged = false;
    this.services.viewportGridService.setActiveViewportId(id);
    switch (name) {
      case 'viewer_select_viewport': predicate = () => this.services.viewportGridService.getActiveViewportId() === id; break;
      case 'viewer_set_orientation':
        await run('setViewportOrientation', { viewportId: id, orientation: args.orientation });
        predicate = () => { const normal = native?.getViewPlaneNormal(); const expected = ({ axial: [0,0,1], coronal: [0,1,0], sagittal: [1,0,0] } as Record<string,number[]>)[String(args.orientation)]; return Boolean(normal && Math.abs(normal.reduce((sum: number, v: number, i: number) => sum + v * expected[i], 0)) > 0.999); };
        presentationChanged = true; break;
      case 'viewer_set_overlays': {
        if (typeof args.visible === 'boolean') {
          for (const element of Array.from(viewport.element.querySelectorAll('.viewport-overlay')) as HTMLElement[]) element.classList.toggle('hidden', !args.visible);
        }
        const group = this.services.toolGroupService?.getToolGroupForViewport(id);
        for (const [key, tool] of [['referenceLines','ReferenceLines'],['imageOverlay','ImageOverlayViewer']] as const) {
          if (typeof args[key] !== 'boolean') continue;
          if (!group?.hasTool(tool)) throw new Error('This overlay is unavailable.');
          for (const pane of group.getViewportsInfo()) this.assertPaneStudy(pane.viewportId, study.studyId);
          if (args[key]) group.setToolEnabled(tool); else group.setToolDisabled(tool);
        }
        viewport.render();
        predicate = () => {
          const overlays = Array.from(viewport.element.querySelectorAll('.viewport-overlay')) as HTMLElement[];
          return (args.visible === undefined || overlays.every(element => element.classList.contains('hidden') !== args.visible)) && [['referenceLines','ReferenceLines'],['imageOverlay','ImageOverlayViewer']].every(([key,tool]) => args[key] === undefined || group.getToolInstance(tool)?.mode === (args[key] ? 'Enabled' : 'Disabled'));
        };
        presentationChanged = true; break;
      }
      case 'viewer_set_sync': {
        const ids = (args.viewportIds as string[]).map(value => this.resolve(value, 'viewport'));
        if (new Set(ids).size !== ids.length) throw new Error('Choose distinct panes.');
        ids.forEach(selected => this.assertPaneStudy(selected, study.studyId));
        const sync = this.services.syncGroupService;
        const syncId = `radsysx-${args.type}-${(args.viewportIds as string[]).slice().sort().join('-')}`;
        if (args.enabled) for (const selected of ids) {
          const pane = this.services.cornerstoneViewportService.getCornerstoneViewport(selected);
          sync.addViewportToSyncGroup(selected, pane.getRenderingEngine().id, { id: syncId, type: args.type, source: true, target: true });
        }
        const synchronizer = sync.getSynchronizer(syncId);
        if (!synchronizer && args.enabled) throw new Error('Synchronization did not start.');
        synchronizer?.setEnabled(Boolean(args.enabled));
        predicate = () => !synchronizer ? !args.enabled : synchronizer.isDisabled() !== args.enabled;
        break;
      }
      case 'viewer_open_panel': {
        const panel = this.panelId(args.panel); if (!panel) throw new Error('This panel is unavailable.');
        this.services.panelService.activatePanel(panel, true);
        const panelName = this.services.panelService.getPanelData(panel).name;
        predicate = () => Array.from(this.browser.document.querySelectorAll('[data-radsysx-open-panel]')).some(node => (node as HTMLElement).dataset.radsysxOpenPanel === panelName);
        result = { panel: args.panel }; break;
      }
      case 'viewer_set_cine': {
        const cine = this.services.cineService;
        for (const linked of cine.getSyncedViewports?.(id) ?? []) this.assertPaneStudy(linked.viewportId, study.studyId);
        cine.setIsCineEnabled(true); cine.setCine({ id, isPlaying: args.playing, frameRate: args.fps ?? 24 });
        if (args.playing) this.cineOwned.set(id, viewport); else { this.cineOwned.delete(id); cine.stopClip?.(viewport.element); }
        predicate = () => Boolean(cine.getState().cines?.[id]?.isPlaying) === args.playing;
        result = { playing: args.playing, fps: args.fps ?? 24 }; break;
      }
      case 'viewer_set_mpr': {
        const display = list(this.services.displaySetService.activeDisplaySets).find(ds => grid.displaySetInstanceUIDs.includes(ds.displaySetInstanceUID));
        if (!display) throw new Error('The selected series is unavailable.');
        const applied = await run('setHangingProtocol', { protocolId: args.layout, activeStudyUID: display.StudyInstanceUID }, 'DEFAULT');
        if (applied === false) throw new Error('The requested layout cannot be applied to this study.');
        predicate = () => this.services.hangingProtocolService.getState().protocolId === args.layout;
        break;
      }
      case 'viewer_set_crosshair': {
        const point = args.worldPoint as number[];
        const data = viewport.getImageData?.(); const imageData = data?.imageData;
        const index = imageData?.worldToIndex?.(point); const dimensions = imageData?.getDimensions?.() ?? data?.dimensions;
        if (!index || !dimensions || index.some((n: number, i: number) => !Number.isFinite(n) || n < 0 || n > dimensions[i] - 1)) throw new Error('Crosshair point is outside the volume.');
        const group = this.services.toolGroupService.getToolGroupForViewport(id);
        for (const info of group.getViewportsInfo()) {
          this.assertPaneStudy(info.viewportId, study.studyId);
          const pane = this.services.cornerstoneViewportService.getCornerstoneViewport(info.viewportId);
          if (pane.jumpToWorld) {
            if (!before.has(info.viewportId)) { affected.push(info.viewportId); before.set(info.viewportId, this.presentationMemo(pane, info.viewportId)); }
            pane.jumpToWorld(point); pane.render();
          }
        }
        group.getToolInstance('Crosshairs')?.computeToolCenter?.();
        predicate = () => affected.every(paneId => { const pane = this.services.cornerstoneViewportService.getCornerstoneViewport(paneId); const adapter = this.viewportAdapter(pane); const focal = adapter?.getFocalPoint(), normal = adapter?.getViewPlaneNormal(); return focal && normal && Math.abs(normal.reduce((sum: number, v: number, i: number) => sum + (point[i] - focal[i]) * v, 0)) < 0.1; });
        result = { worldPoint: point }; presentationChanged = true; break;
      }
      case 'viewer_set_fusion': {
        const displaySetInstanceUID = this.resolve(args.displaySetId, 'series');
        if (!grid.displaySetInstanceUIDs.includes(displaySetInstanceUID)) throw new Error('Fusion layer is outside this pane.');
        if (args.preset) await run('setViewportColormap', { viewportId: id, displaySetInstanceUID, colormap: { name: args.preset }, opacity: args.opacity, immediate: true });
        if (!native?.setLayerOpacity(displaySetInstanceUID, args.opacity)) throw new Error('This layer does not support opacity.');
        viewport.render(); predicate = () => native?.getColormap(displaySetInstanceUID)?.opacity === args.opacity;
        result = { opacity: args.opacity }; presentationChanged = true; break;
      }
      case 'viewer_set_rendering': {
        const uid = this.resolve(args.displaySetId, 'series');
        if (!native || !grid.displaySetInstanceUIDs.includes(uid)) throw new Error('Layer is outside this pane.');
        if (args.threshold !== undefined && !native.setLayerThreshold(uid, args.threshold)) throw new Error('Threshold is unavailable for this layer.');
        if (args.opacity !== undefined && !native.setLayerOpacity(uid, args.opacity)) throw new Error('Opacity is unavailable for this layer.');
        if (args.preset) native.setPresentation({ colormap: { ...native.getColormap(uid), name: args.preset } }, native.getDataIdForDisplaySet(uid));
        if (typeof args.colorbar === 'boolean') {
          const colors = this.services.colorbarService;
          if (!colors) throw new Error('Colorbar controls are unavailable.');
          if (colors.hasColorbar(id) !== args.colorbar) await run('toggleViewportColorbar', { viewportId: id, displaySetInstanceUIDs: [uid] });
        }
        viewport.render();
        predicate = () => { const color = native.getColormap(uid); return (args.opacity === undefined || color?.opacity === args.opacity) && (args.threshold === undefined || color?.threshold === args.threshold) && (!args.preset || color?.name === args.preset) && (args.colorbar === undefined || this.services.colorbarService.hasColorbar(id) === args.colorbar); };
        presentationChanged = true; break;
      }
      case 'viewer_set_volume': {
        const actor = viewport.getActors?.()?.[0]?.actor, mapper = actor?.getMapper?.(), lighting = actor?.getProperty?.();
        const opacity = lighting?.getScalarOpacity?.(0);
        const opacityBefore = opacity && Array.from({ length: opacity.getSize() }, (_, index) => { const point = [0,0,0,0]; opacity.getNodeValue(index, point); return point; });
        if (args.opacityShift !== undefined) { if (!opacityBefore?.length) throw new Error('Volume opacity is unavailable.'); await run('shiftVolumeOpacityPoints', { viewportId: id, shift: args.opacityShift }); }
        if (args.blend !== undefined) {
          const key = ({ composite: 'COMPOSITE', maximum: 'MAXIMUM_INTENSITY_BLEND', minimum: 'MINIMUM_INTENSITY_BLEND', average: 'AVERAGE_INTENSITY_BLEND' } as Record<string,string>)[String(args.blend)];
          const mode = this.libraries().cornerstone.Enums.BlendModes[key];
          if (!viewport.setBlendMode || mode === undefined) throw new Error('Volume blending is unavailable.');
          viewport.setBlendMode(mode);
        }
        if (args.slabThickness !== undefined) { if (!viewport.setSlabThickness) throw new Error('Slab controls are unavailable.'); viewport.setSlabThickness(args.slabThickness); }
        if (args.quality !== undefined) await run('setVolumeRenderingQulaity', { viewportId: id, volumeQuality: args.quality });
        if (['ambient','diffuse','specular','shade'].some(key => args[key] !== undefined)) {
          const options = Object.fromEntries(['ambient','diffuse','specular','shade'].filter(key => args[key] !== undefined).map(key => [key,args[key]]));
          await run('setVolumeLighting', { viewportId: id, options });
        }
        if (args.preset) await run('setViewportPreset', { viewportId: id, preset: args.preset });
        viewport.render();
        predicate = () => {
          const blend = ({ composite: 'COMPOSITE', maximum: 'MAXIMUM_INTENSITY_BLEND', minimum: 'MINIMUM_INTENSITY_BLEND', average: 'AVERAGE_INTENSITY_BLEND' } as Record<string,string>)[String(args.blend)];
          if (args.blend !== undefined && mapper?.getBlendMode?.() !== this.libraries().cornerstone.Enums.BlendModes[blend]) return false;
          if (args.slabThickness !== undefined && Math.abs(Number(viewport.getSlabThickness?.()) - Number(args.slabThickness)) > 0.001) return false;
          if (args.quality !== undefined) { const spacing = mapper?.getInputData?.()?.getSpacing?.(); const expected = spacing?.reduce((sum: number, v: number) => sum + v, 0) / 3; if (!Number.isFinite(expected) || Math.abs(Number(mapper.getSampleDistance()) - expected) > 0.001) return false; }
          if (args.preset && native?.getPresentation()?.preset !== args.preset) return false;
          for (const field of ['ambient','diffuse','specular','shade']) if (args[field] !== undefined && lighting?.[`get${field[0].toUpperCase()}${field.slice(1)}`]?.() !== args[field]) return false;
          if (args.opacityShift !== undefined && !opacityBefore?.every((point: number[], index: number) => { const current = [0,0,0,0]; opacity.getNodeValue(index, current); return Math.abs(current[0] - point[0] - Number(args.opacityShift)) < 0.001; })) return false;
          return true;
        };
        presentationChanged = true; break;
      }
      default: {
        if (name === 'viewer_open_series' && !study.seriesIds.includes(String(args.displaySetId))) throw new Error('Choose a series in the current study.');
        result = await this.executeLegacy(name, args, signal);
        presentationChanged = ['viewer_set_view','viewer_set_window_level'].includes(name);
        if (name === 'viewer_set_view') predicate = () => {
          const state = this.context().state;
          return ['zoom','panX','panY','rotation','invert','flipHorizontal','flipVertical'].filter(key => args[key] !== undefined).every(key => typeof args[key] === 'number' ? Math.abs(Number(state[key]) - Number(args[key])) < 0.001 : state[key] === args[key]);
        };
        if (name === 'viewer_set_window_level') {
          const modality = this.context().state.modality;
          const preset = args.preset ? this.services.customizationService?.getCustomization?.('cornerstone.windowLevelPresets')?.[String(modality)]?.[String(args.preset)] : undefined;
          const width = args.windowWidth ?? preset?.window, center = args.windowCenter ?? preset?.level;
          predicate = () => { const state = this.context().state; return Math.abs(Number(state.windowWidth) - Number(width)) < 0.001 && Math.abs(Number(state.windowCenter) - Number(center)) < 0.001; };
        }
        if (name === 'viewer_jump_to_slice') predicate = () => this.viewport(args.viewportId).viewport.getCurrentImageIdIndex?.() === args.index;
        if (name === 'viewer_open_series') predicate = () => this.viewport(args.viewportId).grid.displaySetInstanceUIDs.includes(this.resolve(args.displaySetId,'series'));
        if (name === 'viewer_set_layout') predicate = () => { const layout=this.services.viewportGridService.getState().layout; return layout.numRows===args.rows && layout.numCols===args.columns; };
      }
    }
    await this.settleReading(signal, predicate, () => { if (this.studyBinding().studyId !== study.studyId) throw new Error('The study changed during the action.'); });
    if (this.studyBinding().studyId !== study.studyId) throw new Error('The study changed during the action.');
    if (presentationChanged && this.history()) {
      const after = affected.map(paneId => this.presentationMemo(this.services.cornerstoneViewportService.getCornerstoneViewport(paneId), paneId));
      this.history()!.push({ restoreMemo: (undo = true) => {
        affected.forEach(paneId => this.assertPaneStudy(paneId, study.studyId));
        if (undo) before.forEach(restore => restore()); else after.forEach(restore => restore());
      } });
    }
    this.onChange?.();
    const { state: _oldState, applied: _oldApplied, ...details } = result;
    return { ...details, applied: true, state: this.context().state, canUndo: presentationChanged && Boolean(this.history()) };
  }
  async execute(name: string, args: Json, signal = new AbortController().signal): Promise<Json> {
    if(name==='viewer_set_crosshair')this.assertMeasurementFrame(args);
    if (name === 'viewer_get_capabilities') return { capabilities: capabilities(this) };
    if (ANNOTATION_TOOLS[name as keyof typeof ANNOTATION_TOOLS]) {
      validateArguments(args,ANNOTATION_TOOLS[name as keyof typeof ANNOTATION_TOOLS].schema);
      if (!this.readingAvailability(name,args).available) throw new Error('This reading tool is unavailable for the current pane.');
    }
    if (name === 'viewer_measurement') return applyMeasurement(this,args,signal);
    if (name === 'viewer_region') return applyRegion(this,args,signal);
    if (name === 'viewer_calibrate') return applyCalibration(this,args,signal);
    if (name === 'viewer_segmentation') return applySegmentation(this,args,signal);
    if (READING_TOOLS[name]) return executeReadingTool(this, name, args, signal);
    alive(signal); const result = await this.executeLegacy(name, args, signal); alive(signal); return result;
  }
  private async executeLegacy(name: string, args: Json, signal = new AbortController().signal): Promise<Json> {
    const run = async (command: string, options: Json = {}, context = 'CORNERSTONE') => { alive(signal); const value = await this.run(command, options, context); alive(signal); return value; };
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
        if (args.preset) await run('setWindowLevelPreset', { presetName: text(args.preset, 80) });
        else await run('setViewportWindowLevel', { viewportId: id, windowWidth: number(args.windowWidth, 0.01, 100000, 'window width'), windowCenter: number(args.windowCenter, -100000, 100000, 'window center') });
        break;
      case 'viewer_set_layout': {
        const rows = number(args.rows, 1, 4, 'rows'), columns = number(args.columns, 1, 4, 'columns');
        if (!Number.isInteger(rows) || !Number.isInteger(columns)) throw new Error('Layout dimensions must be integers.');
        await run('setViewportGridLayout', { numRows: rows, numCols: columns }, 'DEFAULT'); break;
      }
      case 'viewer_open_series': {
        const displaySetInstanceUID = this.resolve(args.displaySetId, 'series');
        if (!list(this.services.displaySetService.activeDisplaySets).some(item => item.displaySetInstanceUID === displaySetInstanceUID)) throw new Error('Series is no longer loaded.');
        await run('setDisplaySetsForViewports', { viewportsToUpdate: [{ viewportId: id, displaySetInstanceUIDs: [displaySetInstanceUID] }] }); break;
      }
      case 'viewer_jump_to_slice': {
        const count = viewport.getImageIds?.()?.length;
        const index = number(args.index, 0, typeof count === 'number' ? count - 1 : 100000, 'slice index');
        if (!Number.isInteger(index)) throw new Error('Slice index must be an integer.');
        await run('jumpToImage', { imageIndex: index }); break;
      }
      case 'viewer_set_tool': {
        const toolName = text(args.tool, 80);
        if (!TOOL_NAMES.has(toolName)) throw new Error('This tool is not available to the assistant.');
        const group = this.services.toolGroupService?.getToolGroupForViewport(id);
        if (!group?.hasTool(toolName) || this.services.toolbarService?.state?.buttons?.[toolName]?.props?.disabled) throw new Error('This native tool is unavailable.');
        for (const pane of group.getViewportsInfo()) this.assertPaneStudy(pane.viewportId,this.studyBinding().studyId);
        await run('setToolActive', { toolName, toolGroupId:group.id });
        if (group.getActivePrimaryMouseButtonTool() !== toolName) throw new Error('Native tool activation is unconfirmed.');
        break;
      }
      case 'viewer_set_view':
        if (args.reset === true) await run('resetViewport');
        if (args.zoom !== undefined) { if (!viewport.setZoom) throw new Error('Zoom is not supported here.'); viewport.setZoom(number(args.zoom, 0.1, 20, 'zoom')); }
        if (args.panX !== undefined || args.panY !== undefined) { if (!viewport.setPan) throw new Error('Pan is not supported here.'); viewport.setPan([number(args.panX ?? 0, -5000, 5000, 'pan'), number(args.panY ?? 0, -5000, 5000, 'pan')]); }
        if (args.rotation !== undefined) await run('rotateViewportCWSet', { rotation: number(args.rotation, -360, 360, 'rotation') });
        if (typeof args.flipHorizontal === 'boolean') await run('setViewportHorizontalFlip', { flipped: args.flipHorizontal });
        if (typeof args.flipVertical === 'boolean') await run('setViewportVerticalFlip', { flipped: args.flipVertical });
        if (typeof args.invert === 'boolean') viewport.setProperties({ invert: args.invert });
        viewport.render(); break;
      case 'viewer_measurement': return applyMeasurement(this,args,signal);
      case 'viewer_undo': await run('undo'); break;
      case 'viewer_redo': await run('redo'); break;
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
  measurementHost(args: Json): { viewport: Host; viewportId: string; services: Host; core: Host; tools: Host; group: Host; seriesIds: string[]; imageIds: string[] } {
    const { id, viewport } = this.viewport(args.viewportId);
    this.assertPaneStudy(id,this.studyBinding().studyId);
    const { cornerstone, cornerstoneTools } = this.libraries();
    return { viewport, viewportId: id, services: this.services, core: cornerstone, tools: cornerstoneTools,
      group: this.services.toolGroupService?.getToolGroupForViewport(id), seriesIds: (this.explorationSeries??this.studyBinding().seriesIds).map(alias => this.resolve(alias,'series')),
      imageIds: list(this.services.displaySetService.activeDisplaySets).filter(ds => (this.explorationSeries??this.studyBinding().seriesIds).includes(this.alias('series',ds.displaySetInstanceUID))).flatMap(ds => this.activeDataSource()?.getImageIdsForDisplaySet?.(ds) ?? ds.imageIds ?? []) };
  }
  measurementAlias(kind: string, id: string): string { return this.alias(kind,id); }
  resolveMeasurement(id: unknown): string { return this.resolve(id,'measurement'); }
  resolveSegmentation(id: unknown): string { return this.resolve(id,'segmentation'); }
  async runMeasurementCommand(name: string, args: Json): Promise<unknown> { return this.run(name,args); }
  private measurementFingerprint(viewport: Host): string {
    return JSON.stringify({ image: viewport.getCurrentImageId?.(), reference: viewport.getViewReference?.(), camera: viewport.getCamera?.(), view: this.viewportAdapter(viewport)?.getViewState(), width: viewport.element.clientWidth, height: viewport.element.clientHeight });
  }
  registerMeasurementObservation(viewportId: string, frameId: string, revision: number): void {
    const { viewport, id } = this.viewport(viewportId);
    this.geometryFrames.set(id,{ frameId, revision, fingerprint: this.measurementFingerprint(viewport) });
  }
  clearMeasurementObservations(): void { this.geometryFrames.clear(); }
  assertMeasurementFrame(args: Json): void {
    if (args.frameId === undefined && args.revision === undefined) return; // Existing voice tools retain their context-version policy.
    const { viewport, id } = this.viewport(args.viewportId), bound = this.geometryFrames.get(id);
    if (!bound || bound.frameId !== args.frameId || bound.revision !== args.revision || bound.fingerprint !== this.measurementFingerprint(viewport)) throw new Error('Capture this frame again before placing or editing geometry.');
  }
}
