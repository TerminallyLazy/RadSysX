import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const viewerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inputs = path.join(viewerRoot, 'ohif-build');
const source = JSON.parse(fs.readFileSync(path.join(inputs, 'source.json'), 'utf8'));
const sourceRoot = path.join(viewerRoot, '.cache', `ohif-${source.commit}`);
const sourceDist = path.join(sourceRoot, 'platform', 'app', 'dist');
const stampPath = path.join(sourceRoot, 'radsysx-build.json');
const pnpmCli = path.resolve(viewerRoot, '..', 'node_modules', 'pnpm', 'bin', 'pnpm.mjs');

export function ohifBuildFingerprint() {
  const hash = createHash('sha256');
  for (const name of ['source.json', 'source.patch', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']) {
    hash.update(name).update(fs.readFileSync(path.join(inputs, name)));
  }
  hash.update(fs.readFileSync(path.join(viewerRoot, 'package.json')));
  hash.update(fs.readFileSync(path.resolve(viewerRoot, '..', 'package-lock.json')));
  hash.update(fs.readFileSync(fileURLToPath(import.meta.url)));
  return hash.digest('hex');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: sourceRoot, stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`OHIF build command failed: ${command} ${args.join(' ')}`, { cause: result.error });
  }
  return result;
}

function pnpm(args) {
  // Upstream build scripts invoke pnpm themselves. Use this workspace's pinned CLI.
  const env = { ...process.env, PATH: `${path.dirname(pnpmCli)}${path.delimiter}${process.env.PATH}` };
  // bin/pnpm.mjs is not named pnpm: npm's bin directory provides the nested executable.
  env.PATH = `${path.resolve(viewerRoot, '..', 'node_modules', '.bin')}${path.delimiter}${env.PATH}`;
  return run(process.execPath, [pnpmCli, ...args], { env });
}

export function buildOhifSource() {
  const version = JSON.parse(fs.readFileSync(path.join(viewerRoot, 'package.json'), 'utf8')).dependencies['@ohif/app'];
  if (version !== source.version) throw new Error('Update the pinned OHIF source inputs with the viewer dependency.');
  const fingerprint = ohifBuildFingerprint();
  let stamp;
  try { stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8')); } catch { /* First build. */ }
  if (stamp?.fingerprint === fingerprint && fs.existsSync(path.join(sourceDist, 'index.html'))) {
    return { sourceDist, receipt: stamp };
  }

  fs.mkdirSync(sourceRoot, { recursive: true });
  if (!fs.existsSync(path.join(sourceRoot, '.git'))) {
    run('git', ['init', '--quiet']);
    run('git', ['remote', 'add', 'origin', source.repository]);
    run('git', ['fetch', '--depth', '1', 'origin', source.commit]);
    run('git', ['checkout', '--detach', 'FETCH_HEAD']);
  }
  const head = run('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' }).stdout.trim();
  if (head !== source.commit) throw new Error('OHIF cache does not match the pinned source commit.');
  const patch = path.join(inputs, 'source.patch');
  const alreadyApplied = spawnSync('git', ['apply', '--reverse', '--check', patch], { cwd: sourceRoot, stdio: 'pipe' }).status === 0;
  if (!alreadyApplied) run('git', ['apply', patch]);
  for (const name of ['pnpm-workspace.yaml', 'pnpm-lock.yaml']) {
    fs.copyFileSync(path.join(inputs, name), path.join(sourceRoot, name));
  }
  pnpm(['install', '--frozen-lockfile', '--ignore-scripts']);
  const publicRoot = path.join(sourceRoot, 'platform', 'app', 'public');
  fs.rmSync(path.join(publicRoot, 'oidc-client.min.js'), { force: true });
  fs.copyFileSync(
    path.join(sourceRoot, 'node_modules', 'oidc-client-ts', 'dist', 'browser', 'oidc-client-ts.min.js'),
    path.join(publicRoot, 'oidc-client-ts.min.js'),
  );
  pnpm(['--filter', '@ohif/app', 'run', 'build:viewer']);
  const receipt = { ...source, fingerprint };
  fs.writeFileSync(stampPath, JSON.stringify(receipt, null, 2) + '\n');
  return { sourceDist, receipt };
}

if (process.argv.includes('--audit')) {
  buildOhifSource();
  pnpm(['audit']);
}
