import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const harnessRoot = path.resolve(testDir, '..');
const cliPath = path.join(harnessRoot, 'cli.mjs');

const passRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-run-pass-'));
writeHarnessConfig(passRoot);
fs.writeFileSync(path.join(passRoot, 'README.md'), '# Temp project\n', 'utf8');

const pass = runCli(passRoot, ['run', '更新 README 文档']);
assert.equal(pass.status, 0, `${pass.stdout}\n${pass.stderr}`);
assert.match(pass.stdout, /Harness run:/);
assert.match(pass.stdout, /Guard status: passed/);
assert.match(pass.stdout, /Validation status: passed/);

const passManifest = latestManifest(passRoot);
assert.equal(passManifest.status, 'passed');
assert.equal(passManifest.phase, 'closeout-complete');
assert.equal(passManifest.guard.status, 'passed');
assert.equal(passManifest.validation.resultStatus, 'passed');
assert.ok(passManifest.artifacts.guardResult);
assert.ok(passManifest.artifacts.validationResult);
assert.ok(passManifest.artifacts.postValidationGuardResult);
assert.ok(passManifest.artifacts.prReport);

const skipped = runCli(passRoot, ['run', '--skip-validate', 'must not bypass closeout']);
assert.notEqual(skipped.status, 0);
assert.match(`${skipped.stdout}\n${skipped.stderr}`, /skip-validate.*not supported/i);

const failRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-run-guard-fail-'));
writeHarnessConfig(failRoot);
fs.writeFileSync(path.join(failRoot, 'README.md'), '# Temp project\n', 'utf8');
git(failRoot, ['init']);
git(failRoot, ['add', '.']);
git(failRoot, ['-c', 'user.name=Harness Test', '-c', 'user.email=harness@example.test', 'commit', '-m', 'init']);
fs.mkdirSync(path.join(failRoot, 'secrets'), { recursive: true });
fs.writeFileSync(path.join(failRoot, 'secrets', 'token.txt'), 'not-a-real-secret\n', 'utf8');

const fail = runCli(failRoot, ['run', '更新 README 文档']);
assert.notEqual(fail.status, 0);
assert.match(fail.stdout, /Guard status: failed/);
assert.doesNotMatch(fail.stdout, /Validation status:/);

const failManifest = latestManifest(failRoot);
assert.equal(failManifest.status, 'failed');
assert.equal(failManifest.phase, 'guard-failed');
assert.equal(failManifest.guard.status, 'failed');
assert.ok(failManifest.artifacts.guardResult);
assert.equal(Object.hasOwn(failManifest.artifacts, 'validationResult'), false);

fs.rmSync(passRoot, { recursive: true, force: true });
fs.rmSync(failRoot, { recursive: true, force: true });

console.log('RUN_COMMAND_TEST_PASS');

function writeHarnessConfig(root) {
  const configDir = path.join(root, '.harness');
  fs.mkdirSync(configDir, { recursive: true });
  const passCommand = 'node -e "console.log(\'HARNESS_CHECK_PASS\')"';
  fs.writeFileSync(path.join(configDir, 'harness.config.json'), `${JSON.stringify({
    repoName: 'Harness Run Test',
    packageManager: 'npm',
    commands: {
      lint: passCommand,
      typecheck: passCommand,
      test: passCommand,
      testUnit: passCommand,
      testIntegration: passCommand,
      testContract: passCommand,
      testE2E: passCommand,
      build: passCommand,
      generateClient: passCommand,
      fullCI: passCommand
    }
  }, null, 2)}\n`, 'utf8');
}

function runCli(root, args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 20 * 1024 * 1024
  });
}

function git(root, args) {
  const res = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 5 * 1024 * 1024
  });
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  return res;
}

function latestManifest(root) {
  const latest = JSON.parse(fs.readFileSync(path.join(root, '.harness', 'state', 'latest-run.json'), 'utf8'));
  return JSON.parse(fs.readFileSync(latest.files.runManifest, 'utf8'));
}
