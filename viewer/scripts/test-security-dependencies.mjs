import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { ohifBuildFingerprint } from './build-ohif-source.mjs';

const viewerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const receipt = JSON.parse(fs.readFileSync(path.join(viewerRoot, 'dist', 'radsysx-build.json'), 'utf8'));
assert.equal(receipt.fingerprint, ohifBuildFingerprint(), 'viewer must match the security build inputs');
const sourceRoot = path.join(viewerRoot, '.cache', `ohif-${receipt.commit}`);
const require = createRequire(path.join(sourceRoot, 'platform', 'app', 'package.json'));
const queryString = (await import(require.resolve('query-string'))).default;
assert.equal(queryString.parse('name=synthetic%20value').name, 'synthetic value');
assert.equal(queryString.parse('path=%2Fviewer%2Flocal').path, '/viewer/local');
assert.equal(queryString.stringify({ name: 'synthetic value' }), 'name=synthetic%20value');

const coreRequire = createRequire(path.join(sourceRoot, 'platform', 'core', 'package.json'));
const validatorPath = coreRequire.resolve('validate.js');
// Run the published CVE-2020-26308 input in a child so a regression cannot hang CI.
const validation = spawnSync(process.execPath, ['--input-type=commonjs', '-e', `
  const assert = require('node:assert/strict');
  const validate = require(${JSON.stringify(validatorPath)});
  assert.equal(validate.single('person@example.com', { email: true }), undefined);
  const bad = 'name@[192.168.168.1:80' + '\\\\a'.repeat(10000);
  assert.ok(validate.single(bad, { email: true }));
  assert.ok(validate({ count: 'bad' }, { count: { numericality: true } }));
`], { timeout: 5000, encoding: 'utf8' });
assert.equal(validation.status, 0, validation.stderr || validation.error?.message);

assert.ok(!fs.existsSync(path.join(viewerRoot, 'dist', 'oidc-client.min.js')), 'retired prebundled OIDC client must not ship');
assert.ok(fs.existsSync(path.join(viewerRoot, 'dist', 'oidc-client-ts.min.js')));
const index = fs.readFileSync(path.join(viewerRoot, 'dist', 'index.html'), 'utf8');
assert.ok(index.includes('resolveViewerBasePath'), 'minification must not remove the deployment base bootstrap');
assert.ok(!/window\.PUBLIC_URL\s*=\s*["']\/["']/.test(index), 'no later assignment may reset the viewer base');
console.log('Security dependency compatibility and build provenance checks passed.');
