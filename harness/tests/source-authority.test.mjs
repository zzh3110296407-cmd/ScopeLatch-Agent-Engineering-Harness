import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverSourceAuthority } from '../lib/source-authority.mjs';

const repositoryManifest = JSON.parse(fs.readFileSync(path.resolve('.harness/source-authority.json'), 'utf8'));
const e2eCommand = repositoryManifest.validationProfile.commands.testE2E[0];
const e2eArgs = e2eCommand.args.join(' ');
assert.equal(e2eCommand.cwd, 'repo');
assert.match(e2eArgs, /codex-process-e2e\.test\.mjs/);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-source-authority-'));
makePhase('Phase 3');
makePhase('Phase 8.5');
makePhase('Phase 10');
fs.mkdirSync(path.join(root, 'versions', 'Phase 99'), { recursive: true });
fs.mkdirSync(path.join(root, 'versions', 'Incomplete Demo', 'Codes', 'app', 'backend'), { recursive: true });

const detected = discoverSourceAuthority({ root, searchRoot: 'versions' });
assert.equal(detected.status, 'detected');
assert.equal(detected.phase, '10');
assert.equal(detected.root, 'versions/Phase 10/Codes');
assert.deepEqual(detected.version, [10]);
assert.equal(detected.candidates.some((item) => item.phase === '99'), false);

const manifestPath = path.join(root, '.harness', 'source-authority.json');
fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
fs.writeFileSync(manifestPath, `${JSON.stringify({
  schemaVersion: 1,
  status: 'ready',
  root: 'versions/Phase 8.5/Codes',
  phase: '8.5',
  requiredMarkers: ['app/backend', 'app/frontend'],
  readinessFiles: ['app/backend/main.py', 'app/frontend/package.json'],
  validationProfile: {
    schemaVersion: 1,
    commands: {
      lint: [{ cwd: 'repo', command: 'node', args: ['--version'] }]
    }
  }
}, null, 2)}\n`, 'utf8');
fs.writeFileSync(path.join(root, 'versions', 'Phase 8.5', 'Codes', 'app', 'backend', 'main.py'), '', 'utf8');
fs.writeFileSync(path.join(root, 'versions', 'Phase 8.5', 'Codes', 'app', 'frontend', 'package.json'), '{}\n', 'utf8');

const manifested = discoverSourceAuthority({ root, requireAuthorityManifest: true });
assert.equal(manifested.status, 'manifest-ready');
assert.equal(manifested.phase, '8.5');
assert.equal(manifested.root, 'versions/Phase 8.5/Codes');
assert.equal(manifested.readinessStatus, 'ready');
assert.equal(manifested.validationProfile.commands.lint.length, 1);

fs.rmSync(path.join(root, 'versions', 'Phase 8.5', 'Codes', 'app', 'backend', 'main.py'));
const invalidManifest = discoverSourceAuthority({ root, requireAuthorityManifest: true });
assert.equal(invalidManifest.status, 'invalid-manifest');
assert.match(invalidManifest.errors.join('\n'), /readiness file/i);

const escapingData = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
escapingData.readinessFiles = ['../outside.txt'];
fs.writeFileSync(manifestPath, `${JSON.stringify(escapingData, null, 2)}\n`, 'utf8');
const escapingManifest = discoverSourceAuthority({ root, requireAuthorityManifest: true });
assert.equal(escapingManifest.status, 'invalid-manifest');
assert.match(escapingManifest.errors.join('\n'), /stay inside the source root/i);

fs.rmSync(manifestPath);
const requiredManifest = discoverSourceAuthority({ root, requireAuthorityManifest: true });
assert.equal(requiredManifest.status, 'manifest-required');

const override = discoverSourceAuthority({ root, configuredRoot: 'versions/Phase 3/Codes' });
assert.equal(override.status, 'configured');
assert.equal(override.root, 'versions/Phase 3/Codes');

fs.rmSync(root, { recursive: true, force: true });
console.log('SOURCE_AUTHORITY_TEST_PASS');

function makePhase(name) {
  fs.mkdirSync(path.join(root, 'versions', name, 'Codes', 'app', 'backend'), { recursive: true });
  fs.mkdirSync(path.join(root, 'versions', name, 'Codes', 'app', 'frontend'), { recursive: true });
}
