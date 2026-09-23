import { measurementSpecs } from './measurements.js';
import type { Json } from './protocol.js';
export type Schema = { type?: string; properties?: Record<string,Schema>; required?: string[]; additionalProperties?: boolean; enum?: (string|number|boolean)[]; minimum?: number; maximum?: number; minItems?: number; maxItems?: number; items?: Schema; pattern?: string };
export type ViewerCapability = { name: string; schema: Schema; permission: 'observe'|'mutate'; available: boolean; reason?: string; nativeHandler: string };
export interface ReadingAdapter {
  readingAvailability(name: string, args?: Json): { available: boolean; reason?: string };
  performReadingTool(name: string, args: Json, signal: AbortSignal): Promise<Json>;
}
const n=(min:number,max:number):Schema=>({type:'number',minimum:min,maximum:max});
const b:Schema={type:'boolean'}, v:Schema={type:'string',pattern:'^viewport-[A-Za-z0-9_-]{1,110}$'}, series:Schema={type:'string',pattern:'^series-[A-Za-z0-9_-]{1,110}$'};
const choice=(...values:string[]):Schema=>({type:'string',enum:values});
const schema=(properties:Record<string,Schema>,required:string[]=[]):Schema=>({type:'object',properties:{viewportId:v,...properties},required,additionalProperties:false});
const entry=(nativeHandler:string,properties:Record<string,Schema>,required:string[]=[])=>({nativeHandler,schema:schema(properties,required)});
const point: Schema = {type:'array',minItems:2,maxItems:3,items:n(-1000000,1000000)};
export const MEASUREMENT_SCHEMA = schema({operation:choice('create','update','delete','jump','read','visibility'), measurementId:{type:'string',pattern:'^measurement-[A-Za-z0-9_-]{1,110}$'}, type:choice(...Object.keys(measurementSpecs)), label:{type:'string'}, points:{type:'array',minItems:1,maxItems:256,items:point}, coordinateSpace:choice('canvas','world'), frameId:{type:'string',pattern:'^frame-[A-Za-z0-9_-]{1,110}$'}, revision:{type:'integer',minimum:0}, visible:b},['operation']);
const capture = {frameId:{type:'string',pattern:'^frame-[A-Za-z0-9_-]{1,110}$'} as Schema,revision:{type:'integer',minimum:0} as Schema};
const shapePoints: Schema = {type:'array',minItems:1,maxItems:256,items:point};
export const ANNOTATION_TOOLS = {
  viewer_measurement: {nativeHandler:'Cornerstone annotation / measurementService',schema:MEASUREMENT_SCHEMA},
  viewer_calibrate: entry('calibrateImageSpacing',{...capture,points:{...shapePoints,minItems:2,maxItems:2},knownLengthMm:n(0.001,10000)},['points','knownLengthMm']),
  viewer_region: entry('native WindowLevelRegion / Magnify / Trackball',{...capture,tool:choice('WindowLevelRegion','Magnify','AdvancedMagnify','TrackballRotate'),points:{...shapePoints,maxItems:2},zoom:n(1,10),close:b},['tool']),
  viewer_segmentation: entry('segmentationService and native contour tools',{...capture,operation:choice('select','visibility','active_segment','segment_visibility','segment_lock','segment_color','segment_label','contour'),segmentationId:{type:'string',pattern:'^segmentation-[A-Za-z0-9_-]{1,110}$'},segmentIndex:{type:'integer',minimum:1,maximum:65535},visible:b,locked:b,color:{type:'array',minItems:4,maxItems:4,items:{type:'integer',minimum:0,maximum:255}},label:{type:'string'},points:{...shapePoints,minItems:3}},['operation','segmentationId']),
};
export const READING_TOOLS: Record<string,{nativeHandler:string;schema:Schema}> = {
  viewer_select_viewport:entry('viewportGridService.setActiveViewportId',{},['viewportId']),
  viewer_set_orientation:entry('setViewportOrientation',{orientation:choice('axial','coronal','sagittal')},['orientation']),
  viewer_set_overlays:entry('native overlay classes and ToolGroup modes',{visible:b,referenceLines:b,imageOverlay:b}),
  viewer_set_sync:entry('toggleSynchronizer',{enabled:b,type:choice('imageSlice','voi'),viewportIds:{type:'array',minItems:2,maxItems:16,items:v}},['enabled','type','viewportIds']),
  viewer_open_panel:entry('panelService.activatePanel',{panel:choice('series','measurements','segmentation','report')},['panel']),
  viewer_set_cine:entry('cineService.setCine',{playing:b,fps:n(1,60)},['playing']),
  viewer_set_mpr:entry('setHangingProtocol',{layout:choice('mpr','mprAnd3DVolume','default')},['layout']),
  viewer_set_crosshair:entry('volume viewport jumpToWorld / camera intersection',{frameId:{type:'string',pattern:'^frame-[A-Za-z0-9_-]+$'},revision:n(0,1000000),worldPoint:{type:'array',minItems:3,maxItems:3,items:{type:'number'}}},['worldPoint']),
  viewer_set_fusion:entry('setViewportColormap',{displaySetId:series,opacity:n(0,1),preset:choice('Grayscale','Hot Iron','PET','PET 20 Step','Cool to Warm')},['displaySetId','opacity']),
  viewer_set_rendering:entry('native layer presentation',{displaySetId:series,threshold:n(-1000000,1000000),opacity:n(0,1),colorbar:b,preset:choice('Grayscale','Hot Iron','PET','PET 20 Step','Cool to Warm')},['displaySetId']),
  viewer_set_volume:entry('native volume presentation',{opacityShift:n(-1000000,1000000),quality:n(0,1),ambient:n(0,1),diffuse:n(0,1),specular:n(0,1),shade:b,blend:choice('composite','maximum','minimum','average'),slabThickness:n(0.01,1000),preset:choice('CT-Bone','CT-Soft-Tissue','CT-Lung','CT-Coronary-Arteries','MR-Default')}),
  viewer_set_window_level:entry('setViewportWindowLevel',{preset:choice('lung','soft_tissue','bone','brain','abdomen','liver'),windowWidth:n(0.01,100000),windowCenter:n(-100000,100000)}),
  viewer_set_layout:entry('setViewportGridLayout',{rows:{type:'integer',minimum:1,maximum:3},columns:{type:'integer',minimum:1,maximum:4}},['rows','columns']),
  viewer_open_series:entry('setDisplaySetsForViewports',{displaySetId:series},['displaySetId']),
  viewer_jump_to_slice:entry('jumpToImage',{index:{type:'integer',minimum:0,maximum:100000}},['index']),
  viewer_set_view:entry('native viewport presentation',{zoom:n(0.1,20),panX:n(-5000,5000),panY:n(-5000,5000),rotation:n(-360,360),invert:b,flipHorizontal:b,flipVertical:b,reset:b}),
};
export function capabilities(adapter: ReadingAdapter): ViewerCapability[] {
  return Object.entries({...READING_TOOLS,...ANNOTATION_TOOLS}).map(([name,entry])=>({name,...entry,permission:'mutate',...adapter.readingAvailability(name)}));
}
export function validateArguments(value: unknown, schema: Schema): void {
  if(schema.type==='object') {
    if(!value || typeof value!=='object' || Array.isArray(value))throw new Error('Invalid reading arguments.');
    const obj=value as Json;
    if(Object.keys(obj).some(key=>!schema.properties?.[key]) || schema.required?.some(key=>obj[key]===undefined))throw new Error('Invalid reading arguments.');
    for(const [key,child] of Object.entries(obj))validateArguments(child,schema.properties![key]);
  } else if(schema.type==='array') {
    if(!Array.isArray(value) || value.length<(schema.minItems??0) || value.length>(schema.maxItems??100))throw new Error('Invalid reading selection.');
    value.forEach(item=>validateArguments(item,schema.items!));
  } else if(schema.type==='number' || schema.type==='integer') {
    if(schema.type==='integer' && typeof value==='number' && !Number.isInteger(value))throw new Error('Reading dimensions must be integers.');
    if(typeof value!=='number' || !Number.isFinite(value) || (schema.type==='integer'&&!Number.isInteger(value)) || value<(schema.minimum??-Infinity) || value>(schema.maximum??Infinity))throw new Error('Invalid reading value.');
  } else if(typeof value!==schema.type || (schema.enum&&!schema.enum.includes(value as string)) || (schema.pattern&&!new RegExp(schema.pattern).test(String(value))))throw new Error('Unknown or invalid reading selection.');
}
