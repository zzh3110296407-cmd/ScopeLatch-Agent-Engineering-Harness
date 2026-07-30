import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveCodexCommand, runCodex } from '../lib/codex-runner.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, '..', 'cli.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-codex-process-'));
const mockPath = path.join(root, 'mock-codex.mjs');
fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
fs.mkdirSync(path.join(root, 'src'), { recursive: true });
const catalogTarget = path.join(root, 'harness', 'contracts', 'v4', 'invariant-catalog.json');
fs.mkdirSync(path.dirname(catalogTarget), { recursive: true });
fs.copyFileSync(path.join(testDir, '..', 'contracts', 'v4', 'invariant-catalog.json'), catalogTarget);
fs.writeFileSync(path.join(root, 'src', 'app.js'), 'export const value = 1;\n', 'utf8');
fs.writeFileSync(
  mockPath,
  "import fs from 'node:fs'; if (process.argv.includes('--version')) console.log('mock-codex 1.0.0'); else fs.writeFileSync('src/app.js', 'export const value = 2;\\n', 'utf8');\n",
  'utf8'
);
const pass = 'node -e "console.log(\'MOCK_VALIDATION_PASS\')"';
fs.writeFileSync(path.join(root, '.harness', 'harness.config.json'), `${JSON.stringify({
  repoName: 'Codex Process E2E',
  policy: { requireSessionBinding: true },
  commands: {
    lint: pass,
    typecheck: pass,
    test: pass,
    testUnit: pass,
    testIntegration: pass,
    testContract: pass,
    testE2E: pass,
    build: pass,
    generateClient: pass,
    fullCI: pass
  }
}, null, 2)}\n`, 'utf8');
git(['init']);
git(['config', 'user.email', 'harness@example.invalid']);
git(['config', 'user.name', 'Harness Test']);
git(['add', '.']);
git(['commit', '-m', 'initial']);

const result = spawnSync(process.execPath, [cliPath, 'codex', 'update src/app.js'], {
  cwd: root,
  encoding: 'utf8',
  timeout: 120000,
  maxBuffer: 20 * 1024 * 1024,
  env: {
    ...process.env,
    CODEX_THREAD_ID: 'mock-thread-e2e',
    HARNESS_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, mockPath])
  }
});
assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
const latest = JSON.parse(fs.readFileSync(path.join(root, '.harness', 'state', 'latest-run.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(latest.files.runManifest, 'utf8'));
assert.equal(manifest.status, 'passed');
assert.equal(manifest.phase, 'closeout-complete');
assert.equal(manifest.validation.developmentVerdict, 'PROVISIONAL_PASS');
assert.equal(manifest.validation.formalEligible, false);
assert.match(manifest.binding.sessionFingerprint, /^sha256:[a-f0-9]{64}$/);
assert.equal(JSON.stringify(manifest).includes('mock-thread-e2e'), false);
assert.equal(fs.existsSync(path.join(root, '.harness', 'state', 'session-leases', `${manifest.runId}.json`)), false);
for (const name of ['codex-result.json', 'guard-result.json', 'validation-result.json', 'post-validation-guard-result.json', 'pr-report.md', 'metrics.json']) {
  assert.equal(fs.existsSync(path.join(latest.runDir, name)), true, name);
}
assert.equal(fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8'), 'export const value = 2;\n');

const resolved = resolveCodexCommand({
  HARNESS_CODEX_COMMAND_JSON: JSON.stringify([process.execPath, mockPath])
});
assert.equal(resolved.executable, process.execPath);
assert.deepEqual(resolved.args, [mockPath]);
assert.throws(
  () => resolveCodexCommand({ HARNESS_CODEX_COMMAND_JSON: '{"not":"an-array"}' }),
  /must contain 1 to 32 command tokens/
);

const sentinel = path.join(root, 'shell-injection-sentinel.txt');
const injection = runCodex({
  root,
  input: '',
  env: {
    HARNESS_CODEX_COMMAND_JSON: '',
    HARNESS_CODEX_COMMAND: `${process.execPath} ${mockPath} & node -e "require('node:fs').writeFileSync('${sentinel.replace(/\\/g, '\\\\')}', 'unsafe')"`
  },
  timeoutMs: 10000
});
assert.notEqual(injection.exitCode, 0);
assert.equal(fs.existsSync(sentinel), false);

fs.rmSync(root, { recursive: true, force: true });
console.log('CODEX_PROCESS_E2E_TEST_PASS');

function git(args) {
  const res = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
}
