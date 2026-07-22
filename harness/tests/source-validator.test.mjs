import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runValidationCapability } from '../lib/source-validator.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-source-validator-'));
const sourceRoot = path.join(root, 'source');
fs.mkdirSync(sourceRoot, { recursive: true });

const authority = {
  root: 'source',
  validationProfile: {
    commands: {
      smoke: [
        { cwd: 'source', command: 'node', args: ['-e', "process.stdout.write(process.cwd())"] },
        { cwd: 'repo', command: 'node', args: ['-e', "process.stdout.write('PROFILE_PASS')"] }
      ],
      failing: [
        { cwd: 'repo', command: 'node', args: ['-e', 'process.exit(7)'] },
        { cwd: 'repo', command: 'node', args: ['-e', 'process.exit(0)'] }
      ],
      packageManager: [
        { cwd: 'repo', command: 'npm', args: ['--version'] }
      ]
    }
  }
};

const passed = runValidationCapability({ root, authority, capability: 'smoke' });
assert.equal(passed.status, 'passed');
assert.equal(passed.steps.length, 2);
assert.match(passed.steps[0].stdout, /source$/i);
assert.match(passed.steps[1].stdout, /PROFILE_PASS/);

const failed = runValidationCapability({ root, authority, capability: 'failing' });
assert.equal(failed.status, 'failed');
assert.equal(failed.exitCode, 7);
assert.equal(failed.steps.length, 1);

const packageManager = runValidationCapability({ root, authority, capability: 'packageManager' });
assert.equal(packageManager.status, 'passed', JSON.stringify(packageManager));
assert.match(packageManager.steps[0].stdout, /^\d+\.\d+/);

assert.throws(
  () => runValidationCapability({ root, authority, capability: 'missing' }),
  /Unknown validation capability/
);

const escapingAuthority = {
  ...authority,
  validationProfile: {
    commands: {
      escape: [{ cwd: 'repo:../outside', command: 'node', args: ['--version'] }]
    }
  }
};
assert.throws(
  () => runValidationCapability({ root, authority: escapingAuthority, capability: 'escape' }),
  /escapes the repository/
);

fs.rmSync(root, { recursive: true, force: true });
console.log('SOURCE_VALIDATOR_TEST_PASS');
