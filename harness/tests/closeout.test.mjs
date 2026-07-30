import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { closeRun } from '../lib/closeout.mjs';
import { readChangesSinceRunBaseline } from '../lib/guard.mjs';
import { buildRunManifest, writeRunManifest } from '../lib/manifest.mjs';
import { normalizeCommandContract } from '../lib/v4/safe-executor.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-closeout-'));
const runDir = path.join(root, '.harness', 'runs', 'closeout-run');
const source = path.join(root, 'src', 'app.js');
fs.mkdirSync(path.dirname(source), { recursive: true });
fs.mkdirSync(runDir, { recursive: true });
fs.writeFileSync(source, 'export const value = 1;\n', 'utf8');
git(['init']);
git(['config', 'user.email', 'harness@example.invalid']);
git(['config', 'user.name', 'Harness Test']);
git(['add', '.']);
git(['commit', '-m', 'initial']);

const impactReport = {
  task: 'update src app',
  risk: { level: 'L1', score: 1 },
  riskSignals: [],
  directTargets: ['src/app.js'],
  reverseDependents: [],
  impactedTests: [],
  changedFiles: [],
  requiredSynchronizations: []
};
const validationPlan = {
  requiredCheckCount: 1,
  commands: [{
    id: 'lint',
    label: 'Lint',
    required: true,
    available: true,
    command: normalizeCommandContract('node -e "console.log(\'CLOSEOUT_PASS\')"')
  }]
};
writeJson('context-pack.json', { mustRead: ['src/app.js'] });
writeJson('impact-report.json', impactReport);
writeJson('validation-plan.json', validationPlan);
writeJson('working-tree-baseline.json', []);
const manifest = buildRunManifest({
  root,
  config: { policy: { planMaxAgeMinutes: 60 } },
  task: impactReport.task,
  runId: 'closeout-run',
  runDir,
  impactReport,
  validationPlan,
  baselineSnapshot: [],
  artifacts: {
    contextPackJson: path.join(runDir, 'context-pack.json'),
    impactReport: path.join(runDir, 'impact-report.json'),
    validationPlan: path.join(runDir, 'validation-plan.json'),
    baselineSnapshot: path.join(runDir, 'working-tree-baseline.json')
  }
});
writeRunManifest({ runDir, manifest });

fs.writeFileSync(source, 'export const value = 2;\n', 'utf8');
const result = closeRun({
  root,
  runDir,
  config: { changeBudget: { forbiddenDirs: [] } }
});

assert.equal(result.status, 'passed');
assert.equal(result.guard.result.status, 'passed');
assert.equal(result.validation.result.outcome, 'PASS');
assert.equal(result.postValidationGuard.result.status, 'passed');
assert.equal(fs.existsSync(path.join(runDir, 'pr-report.md')), true);
assert.equal(fs.existsSync(path.join(runDir, 'metrics.json')), true);
const closedManifest = JSON.parse(fs.readFileSync(path.join(runDir, 'run-manifest.json'), 'utf8'));
assert.equal(closedManifest.status, 'passed');
assert.equal(closedManifest.phase, 'closeout-complete');

writeJson('working-tree-baseline.json', [{ path: 'tampered.txt', hash: 'bad' }]);
assert.throws(
  () => readChangesSinceRunBaseline({ root, runDir }),
  /baseline snapshot hash mismatch/
);

fs.rmSync(root, { recursive: true, force: true });
console.log('CLOSEOUT_TEST_PASS');

function writeJson(name, value) {
  fs.writeFileSync(path.join(runDir, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}
