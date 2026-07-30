import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverSourceAuthority } from '../lib/source-authority.mjs';

const repositoryManifest = JSON.parse(fs.readFileSync(path.resolve('.harness/source-authority.json'), 'utf8'));
assert.equal(repositoryManifest.phase, '4.0');
assert.equal(repositoryManifest.validationProfile.schemaVersion, 2);
for (const capability of [
  'lint',
  'typecheck',
  'testUnit',
  'testIntegration',
  'testContract',
  'testE2E',
  'build',
  'generateClient',
  'fullCI'
]) {
  const steps = repositoryManifest.validationProfile.commands[capability];
  assert.equal(Array.isArray(steps), true, `${capability} must declare steps`);
  assert.equal(steps.length, 1, `${capability} must have one deterministic package profile`);
  assert.equal(steps[0].cwd, 'repo');
  assert.equal(steps[0].command, 'node');
  assert.equal(steps[0].args[0], 'harness/tests/run-all.mjs');
  assert.equal(steps[0].args[1], '--profile');
}
assert.equal(repositoryManifest.validationProfile.policyDefaults.network.mode, 'deny');
assert.deepEqual(repositoryManifest.validationProfile.policyDefaults.network.allowedDestinations, []);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-source-authority-'));
makePhase('Phase 3');
makePhase('Phase 8.5');
makePhase('Phase 10');
fs.mkdirSync(path.join(root, 'Project Codes', 'Phase 99'), { recursive: true });
fs.mkdirSync(path.join(root, 'Project Codes', 'Compelition Demo', 'Codes', 'app', 'backend'), { recursive: true });

const detected = discoverSourceAuthority({ root });
assert.equal(detected.status, 'detected');
assert.equal(detected.phase, '10');
assert.equal(detected.root, 'Project Codes/Phase 10/Codes');
assert.deepEqual(detected.version, [10]);
assert.equal(detected.candidates.some((item) => item.phase === '99'), false);

const manifestPath = path.join(root, '.harness', 'source-authority.json');
fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
fs.writeFileSync(manifestPath, `${JSON.stringify({
  schemaVersion: 1,
  status: 'ready',
  root: 'Project Codes/Phase 8.5/Codes',
  phase: '8.5',
  requiredMarkers: ['app/backend', 'app/frontend'],
  readinessFiles: ['app/backend/main.py', 'app/frontend/package.json'],
  validationProfile: {
    schemaVersion: 2,
    policyDefaults: {
      resources: {
        timeoutMs: 10000,
        maxOutputBytes: 1048576,
        maxMemoryMb: 128,
        maxProcesses: 4
      },
      network: {
        mode: 'deny',
        invariantPolicyId: null,
        allowedDestinations: []
      },
      environment: {
        allow: [],
        values: {}
      },
      writablePaths: []
    },
    commands: {
      lint: [{ cwd: 'repo', command: 'node', args: ['--version'] }]
    }
  }
}, null, 2)}\n`, 'utf8');
fs.writeFileSync(path.join(root, 'Project Codes', 'Phase 8.5', 'Codes', 'app', 'backend', 'main.py'), '', 'utf8');
fs.writeFileSync(path.join(root, 'Project Codes', 'Phase 8.5', 'Codes', 'app', 'frontend', 'package.json'), '{}\n', 'utf8');

const manifested = discoverSourceAuthority({ root, requireAuthorityManifest: true });
assert.equal(manifested.status, 'manifest-ready');
assert.equal(manifested.phase, '8.5');
assert.equal(manifested.root, 'Project Codes/Phase 8.5/Codes');
assert.equal(manifested.readinessStatus, 'ready');
assert.equal(manifested.validationProfile.commands.lint.length, 1);

removeTree(path.join(root, 'Project Codes', 'Phase 8.5', 'Codes', 'app', 'backend', 'main.py'));
const invalidManifest = discoverSourceAuthority({ root, requireAuthorityManifest: true });
assert.equal(invalidManifest.status, 'invalid-manifest');
assert.match(invalidManifest.errors.join('\n'), /readiness file/i);

const escapingData = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
escapingData.readinessFiles = ['../outside.txt'];
fs.writeFileSync(manifestPath, `${JSON.stringify(escapingData, null, 2)}\n`, 'utf8');
const escapingManifest = discoverSourceAuthority({ root, requireAuthorityManifest: true });
assert.equal(escapingManifest.status, 'invalid-manifest');
assert.match(escapingManifest.errors.join('\n'), /stay inside the source root/i);

removeTree(manifestPath);
const requiredManifest = discoverSourceAuthority({ root, requireAuthorityManifest: true });
assert.equal(requiredManifest.status, 'manifest-required');

const override = discoverSourceAuthority({ root, configuredRoot: 'Project Codes/Phase 3/Codes' });
assert.equal(override.status, 'configured');
assert.equal(override.root, 'Project Codes/Phase 3/Codes');

removeTree(root);
console.log('SOURCE_AUTHORITY_TEST_PASS');

function makePhase(name) {
  fs.mkdirSync(path.join(root, 'Project Codes', name, 'Codes', 'app', 'backend'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Project Codes', name, 'Codes', 'app', 'frontend'), { recursive: true });
}

function removeTree(target) {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const entry of fs.readdirSync(target)) removeTree(path.join(target, entry));
    fs.rmdirSync(target);
  } else {
    fs.unlinkSync(target);
  }
  assert.equal(fs.existsSync(target), false, `cleanup did not remove ${target}`);
}
