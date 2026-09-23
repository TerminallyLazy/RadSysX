import type { Json } from './protocol.js';
import { READING_TOOLS, validateArguments, type ReadingAdapter } from './capabilities.js';
import { alive } from './series.js';
export class ReadingToolUnavailable extends Error {}

/** Semantic registry only: callers never choose a native command or selector. */
export async function executeReadingTool(adapter: ReadingAdapter,name: string,args: Json,signal: AbortSignal): Promise<Json> {
  alive(signal);const capability=READING_TOOLS[name];
  if(!capability)throw new Error('Unknown reading tool.');
  try { validateArguments(args,capability.schema); } catch (error) { throw new ReadingToolUnavailable(error instanceof Error ? error.message : 'Invalid reading tool arguments.'); }
  if(!adapter.readingAvailability(name,args).available)throw new ReadingToolUnavailable('This reading control is unavailable in the current view.');
  const result=await adapter.performReadingTool(name,args,signal);
  alive(signal);return result;
}
