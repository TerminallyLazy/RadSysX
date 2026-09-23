import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicChildEnvironment } from '../src/environment.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Keep only host/runtime settings from the filtered environment, never user credentials/configuration.
const filtered = publicChildEnvironment(process.env);
const syntheticEnvironment = Object.fromEntries(Object.entries(filtered).filter(([name]) =>
  ['PATH','HOME','TMPDIR','TEMP','TMP','USER','LOGNAME','SHELL','LANG','LC_ALL','DISPLAY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR'].includes(name)));
Object.assign(syntheticEnvironment, { RADSYSX_KEEP_UI_IMPORT_SMOKE_TMP:'1', RADSYSX_DESKTOP_REBUILD_FRONTEND:'0' });
const result = spawnSync(process.execPath, ['desktop/scripts/ui-import-smoke.mjs','--local-start','--ai-live','--openai','--evidence-review'],
  { cwd:repoRoot, env:syntheticEnvironment, stdio:'inherit' });
process.exitCode = result.status ?? 1;
