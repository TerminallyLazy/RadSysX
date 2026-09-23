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
export const READING_TOOLS: Record<string,{nativeHandler:string;schema:Schema}> = {
  viewer_select_viewport:entry('viewportGridService.setActiveViewportId',{},['viewportId']),
  viewer_set_orientation:entry('setViewportOrientation',{orientation:choice('axial','coronal','sagittal')},['orientation']),
  viewer_set_overlays:entry('native overlay classes and ToolGroup modes',{visible:b,referenceLines:b,imageOverlay:b}),
  viewer_set_sync:entry('toggleSynchronizer',{enabled:b,type:choice('imageSlice','voi'),viewportIds:{type:'array',minItems:2,maxItems:16,items:v}},['enabled','type','viewportIds']),
  viewer_open_panel:entry('panelService.activatePanel',{panel:choice('series','measurements','segmentation','report')},['panel']),
  viewer_set_cine:entry('cineService.setCine',{playing:b,fps:n(1,60)},['playing']),
  viewer_set_mpr:entry('setHangingProtocol',{layout:choice('mpr','mprAnd3DVolume','default')},['layout']),
  viewer_set_crosshair:entry('volume viewport jumpToWorld / camera intersection',{worldPoint:{type:'array',minItems:3,maxItems:3,items:{type:'number'}}},['worldPoint']),
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
  return Object.entries(READING_TOOLS).map(([name,entry])=>({name,...entry,permission:'mutate',...adapter.readingAvailability(name)}));
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
