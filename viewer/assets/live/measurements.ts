import type { Json } from './protocol.js';
import { alive, abortable } from './series.js';

// Only this adapter boundary sees native annotations, identifiers and services.
type Native = Record<string, any> & { constructor: any };
export const measurementSpecs: Record<string, { min: number; max: number; contour?: boolean }> = {
  Length: { min: 2, max: 2 }, ArrowAnnotate: { min: 2, max: 2 }, Angle: { min: 3, max: 3 },
  CobbAngle: { min: 4, max: 4 }, Bidirectional: { min: 4, max: 4 }, Probe: { min: 1, max: 1 },
  RectangleROI: { min: 2, max: 2 }, EllipticalROI: { min: 4, max: 4 }, CircleROI: { min: 2, max: 2 },
  PlanarFreehandROI: { min: 3, max: 256, contour: true }, SplineROI: { min: 3, max: 256, contour: true },
  LivewireContour: { min: 3, max: 256, contour: true }, UltrasoundDirectional: { min: 2, max: 2 },
};
export interface MeasurementAdapter {
  measurementHost(args: Json): { viewport: Native; viewportId: string; services: Native; core: Native; tools: Native; group: Native; seriesIds: string[]; imageIds: string[] };
  measurementAlias(kind: string, id: string): string;
  resolveMeasurement(id: unknown): string;
  resolveSegmentation(id: unknown): string;
  ownReadingResource(key: string, cleanup?: () => void): void;
  assertMeasurementFrame(args: Json): void;
  runMeasurementCommand(name: string, args: Json): Promise<unknown>;
}
export type MeasurementValue = {
  id: string; type: string; coordinateSpace: 'world'; points: number[][]; pointCount: number; geometryComplete: boolean; value: number | null; unit: string | null;
  values: Array<{ type: string; value: number; unit: string | null }>;
  calculationStatus: 'calculated' | 'pending' | 'uncalibrated' | 'annotation';
};
export function validateGeometry(type: string, input: unknown, space: string): number[][] {
  const spec = measurementSpecs[type];
  if (!spec || !['canvas','world'].includes(space) || !Array.isArray(input) || input.length < spec.min || input.length > spec.max) throw new Error('Invalid native measurement geometry.');
  const dimensions = space === 'canvas' ? 2 : 3;
  const points = input.map(point => {
    if (!Array.isArray(point) || point.length !== dimensions || point.some(v => typeof v !== 'number' || !Number.isFinite(v) || (space === 'canvas' ? v < 0 || v > 1 : Math.abs(v) > 1000000))) throw new Error('Invalid measurement coordinates.');
    return [...point] as number[];
  });
  if (new Set(points.map(p => JSON.stringify(p))).size !== points.length) throw new Error('Degenerate measurement geometry.');
  if (type === 'RectangleROI' && space === 'canvas' && (points[0][0] === points[1][0] || points[0][1] === points[1][1])) throw new Error('Rectangle must have nonzero area.');
  return points;
}
const canonicalTool = (type: string) => type === 'UltrasoundDirectionalTool' ? 'UltrasoundDirectional' : type;
const nativeTool = (type: string) => type === 'UltrasoundDirectional' ? 'UltrasoundDirectionalTool' : type;
const units = new Set(['mm','cm','m','mm²','mm2','cm²','cm2','px','px²','px2','deg','°','HU','SUV','SUVbw','raw','US','cm/s','s']);
/** Read native numeric statistics only; imported labels and target IDs never leave the adapter. */
export function measurementValue(annotation: Native, id: string): MeasurementValue {
  const type = canonicalTool(String(annotation.metadata?.toolName ?? ''));
  const values: MeasurementValue['values'] = [];
  const stats = Object.values(annotation.data?.cachedStats ?? {}) as Native[];
  for (const entry of stats.slice(0,8)) {
    for (const [key, unitKey] of [['length','unit'],['area','areaUnit'],['angle','angleUnit'],['longestDiameter','unit'],['shortestDiameter','unit'],['mean','modalityUnit'],['max','modalityUnit'],['value','modalityUnit'],['xValues','xUnits'],['yValues','yUnits']]) {
      const rawUnit = entry[unitKey];
      // Cornerstone angle statistics have no string unit; the native quantity is explicitly degrees.
      const unit = key === 'angle' && rawUnit === undefined ? 'deg' : units.has(rawUnit) ? rawUnit : null;
      if (typeof entry[key] === 'number' && Number.isFinite(entry[key])) values.push({ type: key, value: entry[key], unit });
    }
  }
  for (const entry of stats.slice(0,8)) {
    for (const [i,key] of ['xValues','yValues'].entries()) {
      const endpoints = entry[key], unit = entry.units?.[i];
      if (Array.isArray(endpoints) && endpoints.length === 2 && endpoints.every(v => typeof v === 'number' && Number.isFinite(v))) values.push({type:i ? 'yDifference' : 'xDifference',value:Math.abs(endpoints[1]-endpoints[0]),unit:!entry.isUnitless && units.has(unit) ? unit : null});
    }
  }
  const points = annotation.data?.contour?.polyline ?? annotation.data?.handles?.points ?? [];
  const geometry = Array.isArray(points) ? points.slice(0,256).filter((p: unknown) => Array.isArray(p) && p.length === 3 && p.every(v => typeof v === 'number' && Number.isFinite(v))).map((p: number[]) => [...p]) : [];
  if (annotation.invalidated) values.length = 0;
  return { id, type, pointCount:Array.isArray(points) ? points.length : 0, geometryComplete:Array.isArray(points) && points.length === geometry.length, coordinateSpace: 'world', points: geometry, value: values[0]?.value ?? null, unit: values[0]?.unit ?? null, values:values.slice(0,16),
    calculationStatus: type === 'ArrowAnnotate' ? 'annotation' : !values.length ? 'pending' : values.some(v => !v.unit || /^px/.test(v.unit)) ? 'uncalibrated' : 'calculated' };
}
function worldGeometry(viewport: Native, type: string, args: Json): number[][] {
  const space = String(args.coordinateSpace ?? 'canvas');
  let points = validateGeometry(type, args.points, space);
  if (type === 'RectangleROI' && space === 'world') {
    const normalized = points.map(point => {
      const canvas = viewport.worldToCanvas(point), plane = viewport.canvasToWorld(canvas);
      if (Math.hypot(...point.map((v,i) => v-plane[i])) > 0.1) throw new Error('Measurement is outside the current image plane.');
      return [canvas[0]/viewport.element.clientWidth,canvas[1]/viewport.element.clientHeight];
    });
    return worldGeometry(viewport,type,{...args,coordinateSpace:'canvas',points:normalized});
  }
  if (type === 'RectangleROI' && space === 'canvas') { const [a,b] = points; points = [a,[b[0],a[1]],[a[0],b[1]],b]; }
  const width = viewport.element.clientWidth, height = viewport.element.clientHeight;
  const world = space === 'canvas' ? points.map(([x,y]) => Array.from(viewport.canvasToWorld([x * width,y * height])) as number[]) : points;
  const data = viewport.getImageData?.();
  for (const p of world) {
    if (p.length !== 3 || p.some(v => !Number.isFinite(v))) throw new Error('Native frame geometry is unavailable.');
    const canvas = viewport.worldToCanvas(p), plane = viewport.canvasToWorld(canvas);
    if (canvas[0] < 0 || canvas[0] > width || canvas[1] < 0 || canvas[1] > height || Math.hypot(...p.map((v,i) => v - plane[i])) > 0.1) throw new Error('Measurement is outside the current image plane.');
    if (data?.imageData?.worldToIndex) {
      const index = data.imageData.worldToIndex(p), dims = data.imageData.getDimensions();
      if (index.some((v: number,i: number) => !Number.isFinite(v) || v < -0.5 || v > dims[i] - 0.5)) throw new Error('Measurement is outside the image.');
    }
  }
  return world;
}
async function traceLivewire(instance: Native, annotation: Native, world: number[][], viewport: Native, signal: AbortSignal): Promise<number[][]> {
  if (instance.editData || instance.isDrawing) throw new Error('Finish the current native contour before continuing.');
  const polyline: number[][] = [];
  try {
    instance.setupBaseEditData(world[0],viewport.element,annotation,undefined,false);
    const {worldToSlice,sliceToWorld} = instance.editData;
    for (const point of [...world.slice(1),world[0]]) {
      alive(signal);
      const target = worldToSlice(point);
      const edge = instance.scissors.findPathToPoint(target);
      if (!Array.isArray(edge) || polyline.length + edge.length > 16384) throw new Error('Native contour exceeded its bounded path size.');
      polyline.push(...edge.map((p: number[]) => Array.from(sliceToWorld(p)) as number[]));
      instance.scissors.startSearch(target);
      await abortable(new Promise(resolve => setTimeout(resolve,0)),signal,1000);
    }
    return polyline;
  } finally { instance.clearEditData(); }
}
function setGeometry(annotation: Native, instance: Native, type: string, world: number[][], contour = world): void {
  annotation.data.cachedStats = {};
  if (measurementSpecs[type].contour) {
    annotation.data.contour = { ...annotation.data.contour, polyline: contour, closed: true };
    annotation.data.handles.points = type === 'PlanarFreehandROI' ? [] : world;
    if (type === 'SplineROI') annotation.data.spline.instance.closed = true;
  } else annotation.data.handles.points = world;
  annotation.invalidated = true;
  annotation.highlighted = false;
}
function publish(core: Native, tools: Native, viewport: Native, annotation: Native, completed: boolean): void {
  core.triggerEvent(core.eventTarget, completed ? tools.Enums.Events.ANNOTATION_COMPLETED : tools.Enums.Events.ANNOTATION_MODIFIED,
    { annotation, viewportId: viewport.id, renderingEngineId: viewport.renderingEngineId, changeType: tools.Enums.ChangeTypes?.HandlesUpdated });
  tools.utilities.triggerAnnotationRenderForViewportIds?.([viewport.id]);
  viewport.render();
}
export function readMeasurements(adapter: MeasurementAdapter, seriesIds: string[]): MeasurementValue[] {
  const host = adapter.measurementHost({});
  return (host.services.measurementService.getMeasurements() ?? []).filter((m: Native) => seriesIds.includes(m.displaySetInstanceUID)).slice(0,100).map((m: Native) => {
    const annotation = host.tools.annotation.state.getAnnotation(m.uid);
    return measurementValue(annotation ?? { metadata: { toolName: m.toolName }, data: { handles: { points: m.points }, cachedStats: m.data } }, adapter.measurementAlias('measurement',m.uid));
  });
}
export async function applyMeasurement(adapter: MeasurementAdapter, args: Json, signal: AbortSignal): Promise<Json> {
  alive(signal);
  const host = adapter.measurementHost(args), { viewport, services, core, tools, group } = host;
  const source = viewport.getCurrentImageId?.();
  const check = () => { alive(signal); adapter.assertMeasurementFrame(args);
    const current = adapter.measurementHost(args);
    if (current.viewport !== viewport || viewport.getCurrentImageId?.() !== source || JSON.stringify(current.seriesIds) !== JSON.stringify(host.seriesIds)) throw new Error('The study or frame changed during the measurement.');
  };
  check();
  let annotation: Native, instance: Native, type: string;
  const created = args.operation === 'create';
  if (!created) {
    const uid = adapter.resolveMeasurement(args.measurementId);
    const measurement = services.measurementService.getMeasurement(uid);
    if (!measurement || !host.seriesIds.includes(measurement.displaySetInstanceUID)) throw new Error('Measurement is outside the current study.');
    annotation = tools.annotation.state.getAnnotation(uid);
    if (!annotation) throw new Error('Native annotation is unavailable.');
    type = canonicalTool(annotation.metadata.toolName);
    instance = group?.getToolInstance(nativeTool(type));
    if (args.operation === 'read') return { measurement: measurementValue(annotation, String(args.measurementId)) };
    if (args.operation === 'jump') { await adapter.runMeasurementCommand('jumpToMeasurement', { uid }); alive(signal); return { applied: true }; }
    if (args.operation === 'visibility') {
      const visibility = tools.annotation.visibility;
      const before = visibility.isAnnotationVisible(uid), after = Boolean(args.visible);
      const apply = (visible: boolean) => { visibility.setAnnotationVisibility(uid,visible); viewport.render(); };
      apply(after); core.utilities.HistoryMemo.DefaultHistoryMemo.push({ restoreMemo: (undo = true) => apply(undo ? before : after) });
      if (visibility.isAnnotationVisible(uid) !== after) throw new Error('Annotation visibility is unconfirmed.');
      return { applied:true, visible:after };
    }
    if (!instance?.constructor?.createAnnotationMemo) throw new Error('Native annotation history is unavailable.');
    if (args.operation === 'delete') {
      instance.constructor.createAnnotationMemo(viewport.element,annotation,{ deleting: true });
      tools.annotation.state.removeAnnotation(uid); viewport.render();
      if (tools.annotation.state.getAnnotation(uid)) throw new Error('Annotation deletion is unconfirmed.');
      return { applied: true, status: 'deleted' };
    }
    if (args.type && args.type !== type) throw new Error('An edit cannot change the native annotation type.');
  } else {
    type = String(args.type); instance = group?.getToolInstance(nativeTool(type));
    if (!measurementSpecs[type] || !instance?.createAnnotation) throw new Error('This native measurement is unavailable.');
  }
  const world = args.points === undefined ? undefined : worldGeometry(viewport,type,args);
  check();
  if (created) {
    const evt = { detail: { element: viewport.element, currentPoints: { world: world![0] } } };
    annotation = instance.createAnnotation(evt, world);
    annotation.annotationUID = crypto.randomUUID();
    annotation.data.handles ??= { points: [], textBox: { hasMoved: false } };
  } else instance.constructor.createAnnotationMemo(viewport.element,annotation!,{});
  const contour = world && type === 'LivewireContour' ? await traceLivewire(instance,annotation!,world,viewport,signal) : world;
  check();
  if (world) setGeometry(annotation!,instance,type,world,contour);
  if (typeof args.label === 'string') { annotation!.data.label = args.label; if (type === 'ArrowAnnotate') annotation!.data.text = args.label; }
  if (created) {
    if (instance.addAnnotation) instance.addAnnotation(annotation!,viewport.element); else tools.annotation.state.addAnnotation(annotation!,viewport.element);
    instance.constructor.createAnnotationMemo(viewport.element,annotation!,{ newAnnotation: true });
  }
  publish(core,tools,viewport,annotation!,created);
  const id = adapter.measurementAlias('measurement',annotation!.annotationUID);
  // Wait for registration and native render/calculation. No screenshot-derived unit conversion.
  const deadline = Date.now() + 3000;
  let registered = false, value: MeasurementValue;
  do {
    await abortable(new Promise(resolve => setTimeout(resolve,25)),signal,3000); check();
    registered = Boolean(services.measurementService.getMeasurement(annotation!.annotationUID));
    value = measurementValue(annotation!,id);
    if (registered && !annotation!.invalidated && value.calculationStatus !== 'pending') break;
  } while (Date.now() < deadline);
  if (!registered) throw new Error('Annotation was changed, but native registration is unconfirmed.');
  return { applied: true, measurement: value!, canUndo: true };
}

/** Calibration is separately reviewed by the broker; the reference length is never inferred. */
export async function applyCalibration(adapter: MeasurementAdapter,args: Json,signal: AbortSignal): Promise<Json> {
  alive(signal); adapter.assertMeasurementFrame(args);
  const { viewport, core, tools } = adapter.measurementHost(args);
  const world = worldGeometry(viewport,'Length',{ ...args, coordinateSpace:'canvas' });
  const imageId = viewport.getCurrentImageId?.();
  if (!imageId || !tools.utilities.calibrateImageSpacing) throw new Error('This frame cannot be calibrated.');
  const distance = Math.hypot(...world[0].map((v,i) => v - world[1][i]));
  const known = Number(args.knownLengthMm);
  if (!Number.isFinite(known) || known <= 0 || known > 10000 || !Number.isFinite(distance) || distance <= 0) throw new Error('A known physical reference is required.');
  const previous = core.metaData.get('calibratedPixelSpacing',imageId);
  const next = { type:'User', scale:distance / known };
  const engine = viewport.getRenderingEngine();
  const apply = (calibration: unknown) => { tools.utilities.calibrateImageSpacing(imageId,engine,calibration); viewport.render(); };
  alive(signal); adapter.assertMeasurementFrame(args); apply(next);
  core.utilities.HistoryMemo.DefaultHistoryMemo.push({ restoreMemo: (undo = true) => apply(undo ? previous : next) });
  const observed = core.metaData.get('calibratedPixelSpacing',imageId);
  if (observed?.scale !== next.scale) throw new Error('Native calibration could not be confirmed.');
  return { applied:true, status:'user_calibrated', canUndo:true };
}

export async function applySegmentation(adapter: MeasurementAdapter,args: Json,signal: AbortSignal): Promise<Json> {
  alive(signal); adapter.assertMeasurementFrame(args);
  const { viewport, viewportId, services, core, tools, group, imageIds } = adapter.measurementHost(args);
  const service = services.segmentationService, id = adapter.resolveSegmentation(args.segmentationId);
  const segmentation = service.getSegmentation(id);
  const reps = service.getSegmentationRepresentations(viewportId).filter((r: Native) => r.segmentationId === id);
  if (!segmentation || !reps.length) throw new Error('Segmentation is not attached to the selected pane.');
  const data = Object.values(segmentation.representationData ?? {}) as Native[];
  const refs = data.flatMap(rep => rep.referencedImageIds ?? (rep.referencedVolumeId ? core.cache.getVolume(rep.referencedVolumeId)?.imageIds : undefined) ?? (rep.imageIds ?? []).map((image: string) => core.cache.getImage(image)?.referencedImageId)).filter(Boolean);
  if (!refs.length || refs.some((image: string) => !imageIds.includes(image))) throw new Error('Segmentation references are outside the current study or unavailable.');
  const index = Number(args.segmentIndex), segments = segmentation.segments ?? {};
  if (!['select','visibility'].includes(String(args.operation)) && (!Number.isInteger(index) || !segments[index])) throw new Error('Unknown segment in this study.');
  const visibility = tools.segmentation.config.visibility;
  const history = core.utilities.HistoryMemo.DefaultHistoryMemo;
  const change = (before: unknown, after: unknown, apply: (value: any) => void, read: () => unknown) => {
    alive(signal); adapter.assertMeasurementFrame(args); apply(after); viewport.render();
    if (JSON.stringify(read()) !== JSON.stringify(after)) throw new Error('Native segment edit is unconfirmed.');
    history.push({ restoreMemo: (undo = true) => { apply(undo ? before : after); viewport.render(); } });
  };
  switch (args.operation) {
    case 'select': {
      const previous = service.getActiveSegmentation(viewportId)?.segmentationId;
      if (!previous) throw new Error('Native active segmentation is unavailable.');
      change(previous,id,value => service.setActiveSegmentation(viewportId,value),() => service.getActiveSegmentation(viewportId)?.segmentationId); break;
    }
    case 'visibility': {
      const read = () => reps.map((rep: Native) => visibility.getSegmentationRepresentationVisibility(viewportId,{segmentationId:id,type:rep.type}));
      change(read(),reps.map(() => Boolean(args.visible)),values => reps.forEach((rep: Native,i: number) => visibility.setSegmentationRepresentationVisibility(viewportId,{segmentationId:id,type:rep.type},values[i])),read); break;
    }
    case 'active_segment': {
      const previous = tools.segmentation.segmentIndex.getActiveSegmentIndex(id);
      change(previous,index,value => service.setActiveSegment(id,value),() => tools.segmentation.segmentIndex.getActiveSegmentIndex(id)); break;
    }
    case 'segment_visibility': {
      const read = () => reps.map((rep: Native) => visibility.getSegmentIndexVisibility(viewportId,{segmentationId:id,type:rep.type},index));
      change(read(),reps.map(() => Boolean(args.visible)),values => reps.forEach((rep: Native,i: number) => service.setSegmentVisibility(viewportId,id,index,values[i],rep.type)),read); break;
    }
    case 'segment_lock': {
      const read = () => tools.segmentation.segmentLocking.isSegmentIndexLocked(id,index);
      change(read(),Boolean(args.locked),value => service.setSegmentLocked(id,index,value),read); break;
    }
    case 'segment_color': {
      const color = args.color;
      if (!Array.isArray(color) || color.length !== 4 || color.some(v => !Number.isInteger(v) || Number(v)<0 || Number(v)>255)) throw new Error('Invalid segment color.');
      const read = () => Array.from(service.getSegmentColor(viewportId,id,index));
      change(read(),color,value => service.setSegmentColor(viewportId,id,index,value),read); break;
    }
    case 'segment_label': {
      if (typeof args.label !== 'string' || args.label.length > 256) throw new Error('Invalid segment label.');
      const read = () => service.getSegmentation(id)?.segments[index]?.label;
      change(read(),args.label,value => service.setSegmentLabel(id,index,value),read); break;
    }
    case 'contour': {
      const instance = group?.getToolInstance('PlanarFreehandContourSegmentationTool');
      if (!instance || service.getActiveSegmentation(viewportId)?.segmentationId !== id || tools.segmentation.segmentIndex.getActiveSegmentIndex(id) !== index || tools.segmentation.segmentLocking.isSegmentIndexLocked(id,index)) throw new Error('Select an unlocked native contour segment first.');
      const world = worldGeometry(viewport,'PlanarFreehandROI',args);
      const annotation = instance.createAnnotation({ detail:{ element:viewport.element, currentPoints:{ world:world[0] } } });
      if (annotation.data?.segmentation?.segmentationId !== id || annotation.data.segmentation.segmentIndex !== index) throw new Error('Contour segment binding changed.');
      annotation.annotationUID = crypto.randomUUID();
      setGeometry(annotation,instance,'PlanarFreehandROI',world);
      instance.addAnnotation(annotation,viewport.element);
      instance.constructor.createAnnotationMemo(viewport.element,annotation,{newAnnotation:true});
      tools.utilities.triggerAnnotationRenderForViewportIds?.([viewportId]);viewport.render();
      if (!tools.annotation.state.getAnnotation(annotation.annotationUID)) throw new Error('Native contour registration is unconfirmed.');
      break;
    }
    default: throw new Error('Unsupported segment edit.');
  }
  alive(signal);
  return { applied:true, segmentationId:args.segmentationId, ...(Number.isInteger(index) ? {segmentIndex:index} : {}), canUndo:true };
}

/** Pinned native interaction entry points; no arbitrary DOM pointer or command execution. */
export async function applyRegion(adapter: MeasurementAdapter,args: Json,signal: AbortSignal): Promise<Json> {
  alive(signal); adapter.assertMeasurementFrame(args);
  const {viewport,group,core,tools} = adapter.measurementHost(args);
  const type = String(args.tool), instance = group?.getToolInstance(type);
  if (!['WindowLevelRegion','Magnify','AdvancedMagnify','TrackballRotate'].includes(type) || !instance) throw new Error('This region tool is unavailable.');
  const key = `${viewport.id}:${type}`;
  if (args.close) { adapter.ownReadingResource(key); return {applied:true,visible:false}; }
  const geometry = type === 'WindowLevelRegion' ? 'RectangleROI' : type === 'TrackballRotate' ? 'Length' : 'Probe';
  const points = worldGeometry(viewport,geometry,{...args,coordinateSpace:'canvas'});
  const first = {world:points[0],canvas:viewport.worldToCanvas(points[0])};
  const evt = {detail:{element:viewport.element,currentPoints:first,lastPoints:first},preventDefault(){}};
  const zoom = Number(args.zoom ?? 3);
  if (!Number.isFinite(zoom) || zoom<1 || zoom>10) throw new Error('Invalid magnification.');
  alive(signal);adapter.assertMeasurementFrame(args);
  if (type === 'WindowLevelRegion' || type === 'TrackballRotate') {
    const before = {properties:structuredClone(viewport.getProperties?.() ?? {}),camera:structuredClone(viewport.getCamera?.() ?? {})};
    if (type === 'WindowLevelRegion') instance.applyWindowLevelRegion({data:{handles:{points}}},viewport.element);
    else instance.mouseDragCallback({...evt,detail:{...evt.detail,currentPoints:{world:points[1],canvas:viewport.worldToCanvas(points[1])}}});
    const after = {properties:structuredClone(viewport.getProperties?.() ?? {}),camera:structuredClone(viewport.getCamera?.() ?? {})};
    if (!Object.keys(after.properties).length && !Object.keys(after.camera).length) throw new Error('Native presentation readback is unavailable.');
    const restore = (value: typeof before) => {viewport.setProperties?.(value.properties);viewport.setCamera?.(value.camera);viewport.render();};
    core.utilities.HistoryMemo.DefaultHistoryMemo.push({restoreMemo:(undo = true) => restore(undo ? before : after)});
    const range = after.properties.voiRange;
    return {applied:true,canUndo:true,...(range ? {windowWidth:Math.abs(range.upper-range.lower)+1,windowCenter:(range.upper+range.lower+1)/2} : {})};
  }
  adapter.ownReadingResource(key);
  let cleanup: () => void;
  if (type === 'Magnify') {
    if (viewport.element.querySelector('.magnifyTool')) throw new Error('Close the existing magnifier first.');
    const old = instance.configuration.magnifySize;
    try { instance.configuration.magnifySize=zoom; instance.preMouseDownCallback(evt); }
    finally { instance.configuration.magnifySize=old; }
    // Keep the lens for inspection without leaving a synthetic mouse drag active.
    instance._deactivateDraw(viewport.element);
    cleanup=()=>{if(viewport.element.querySelector('.magnifyTool'))instance._dragEndCallback(evt);};
  } else {
    const old=instance.configuration.magnifyingGlass;
    let annotation: Native;
    try {instance.configuration.magnifyingGlass={...old,zoomFactor:zoom};annotation=instance.addNewAnnotation(evt);}
    finally {instance.configuration.magnifyingGlass=old;}
    if(!annotation!)throw new Error('Native magnifier creation is unconfirmed.');
    cleanup=()=>tools.annotation.state.removeAnnotation(annotation.annotationUID);
  }
  const onAbort=()=>adapter.ownReadingResource(key);
  adapter.ownReadingResource(key,()=>{signal.removeEventListener('abort',onAbort);cleanup();});
  signal.addEventListener('abort',onAbort,{once:true});
  alive(signal);
  return {applied:true,visible:true,zoom};
}
