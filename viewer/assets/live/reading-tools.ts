import type { Json } from './protocol.js';
import { READING_TOOLS, validateArguments, type ReadingAdapter } from './capabilities.js';
import { alive } from './series.js';
/** Semantic registry only: callers never choose a native command or selector. */
export async function executeReadingTool(adapter: ReadingAdapter,name: string,args: Json,signal: AbortSignal): Promise<Json> {
  alive(signal);const capability=READING_TOOLS[name];
  if(!capability)throw new Error('Unknown reading tool.');
  validateArguments(args,capability.schema);
  if(!adapter.readingAvailability(name,args).available)throw new Error('This reading control is unavailable in the current view.');
  const result=await adapter.performReadingTool(name,args,signal);
  alive(signal);return result;
}
