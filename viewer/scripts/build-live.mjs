import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const viewerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function compile() {
  for (const config of ['tsconfig.live-contracts.json', 'tsconfig.live.json']) {
    const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', path.join(viewerRoot, config)], { stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error(`Live assistant TypeScript compilation failed: ${config}.`);
  }
}

export async function buildLiveRuntime(output = path.join(viewerRoot, 'dist')) {
  compile();
  const webpack = require('webpack');
  await new Promise((resolve, reject) => {
    const compiler = webpack({ mode: 'production', target: 'web', devtool: false,
      entry: path.join(viewerRoot, '.cache/live-runtime/index.js'),
      output: { path: output, filename: 'radsysx-live.js' },
      optimization: { minimize: true },
    });
    compiler.run((error, stats) => compiler.close(() => {
      if (error || stats?.hasErrors()) reject(error ?? new Error(stats.toString({ errors: true, warnings: false })));
      else resolve();
    }));
  });
  fs.copyFileSync(path.join(viewerRoot, '.cache/live-runtime/audio-worklet.js'), path.join(output, 'radsysx-audio-worklet.js'));
}

if (process.argv.includes('--compile')) {
  compile();
}
