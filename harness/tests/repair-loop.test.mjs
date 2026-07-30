import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { failureSignature, repairRun } from '../lib/repair.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const harnessRoot = path.resolve(testDir, '..');
const cliPath = path.join(harnessRoot, 'cli.mjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-repair-loop-'));
const runDir = path.join(root, '.harness', 'runs', 'failed-run');
fs.mkdirSync(runDir, { recursive: true });
writeHarnessConfig(root);
writeFailedRun(root, runDir);

const first = repairRun({
  root,
  runDir,
  config: { changeBudget: { maxRepairRounds: 3 } },
  options: { promptOnly: true }
});

assert.equal(first.result.status, 'prompt-ready');
assert.equal(first.result.round, 1);
assert.ok(fs.existsSync(first.promptPath));

const prompt = fs.readFileSync(first.promptPath, 'utf8');
assert.match(prompt, /# Harness Repair Prompt/);
assert.match(prompt, /Failed checks/);
assert.match(prompt, /lint/);
assert.match(prompt, /failure-dossier.md/);
assert.doesNotMatch(prompt, /RAW_STDOUT_SHOULD_NOT_BE_IN_PROMPT/);
assert.doesNotMatch(prompt, /RAW_STDERR_SHOULD_NOT_BE_IN_PROMPT/);

const stateAfterFirst = readJson(path.join(runDir, 'repair-state.json'));
assert.equal(stateAfterFirst.rounds.length, 1);
assert.equal(stateAfterFirst.rounds[0].status, 'prompt-ready');
assert.equal(stateAfterFirst.rounds[0].inputSignature, failureSignature(failedValidationResult()));

const cli = spawnSync(process.execPath, [cliPath, 'repair', '--run', runDir, '--prompt-only'], {
  cwd: root,
  encoding: 'utf8',
  timeout: 120000,
  maxBuffer: 20 * 1024 * 1024
});
assert.equal(cli.status, 0, `${cli.stdout}\n${cli.stderr}`);
assert.match(cli.stdout, /Repair status: prompt-ready/);

const state = readJson(path.join(runDir, 'repair-state.json'));
state.rounds.push({
  round: 99,
  status: 'failed',
  inputSignature: 'different-input',
  outputSignature: failureSignature(failedValidationResult())
});
fs.writeFileSync(path.join(runDir, 'repair-state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8');

const repeated = repairRun({
  root,
  runDir,
  config: { changeBudget: { maxRepairRounds: 10 } },
  options: { promptOnly: true }
});
assert.equal(repeated.result.status, 'blocked');
assert.equal(repeated.result.reason, 'repeated-failure-signature');

const manifest = readJson(path.join(runDir, 'run-manifest.json'));
assert.equal(manifest.repair.status, 'blocked');
assert.equal(manifest.repair.reason, 'repeated-failure-signature');

const blockedRunDir = path.join(root, '.harness', 'runs', 'blocked-run');
fs.mkdirSync(blockedRunDir, { recursive: true });
fs.writeFileSync(path.join(blockedRunDir, 'validation-result.json'), `${JSON.stringify({
  outcome: 'BLOCKED',
  results: []
}, null, 2)}\n`, 'utf8');
fs.writeFileSync(path.join(blockedRunDir, 'run-manifest.json'), `${JSON.stringify({
  schemaVersion: 4,
  runId: 'blocked-run',
  status: 'blocked',
  phase: 'validation-blocked',
  repo: { root },
  artifacts: {},
  validation: { resultOutcome: 'BLOCKED' }
}, null, 2)}\n`, 'utf8');

const blockedRepair = repairRun({
  root,
  runDir: blockedRunDir,
  config: { changeBudget: { maxRepairRounds: 3 } },
  options: { promptOnly: true }
});
assert.equal(blockedRepair.result.status, 'blocked');
assert.equal(blockedRepair.result.reason, 'validation-blocked-is-not-repairable');

const blockedCli = spawnSync(process.execPath, [cliPath, 'repair', '--run', blockedRunDir, '--prompt-only'], {
  cwd: root,
  encoding: 'utf8',
  timeout: 120000,
  maxBuffer: 20 * 1024 * 1024
});
assert.notEqual(blockedCli.status, 0);
assert.match(blockedCli.stdout, /Repair status: blocked/);

fs.rmSync(root, { recursive: true, force: true });

console.log('REPAIR_LOOP_TEST_PASS');

function writeHarnessConfig(projectRoot) {
  fs.mkdirSync(path.join(projectRoot, '.harness'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.harness', 'harness.config.json'), `${JSON.stringify({
    repoName: 'Harness Repair Test',
    packageManager: 'npm',
    commands: {
      lint: 'node -e "console.log(1)"',
      typecheck: 'node -e "console.log(2)"',
      testUnit: 'node -e "console.log(3)"',
      testIntegration: 'node -e "console.log(4)"',
      testContract: 'node -e "console.log(5)"',
      testE2E: 'node -e "console.log(6)"',
      build: 'node -e "console.log(7)"',
      generateClient: 'node -e "console.log(8)"',
      fullCI: 'node -e "console.log(9)"'
    }
  }, null, 2)}\n`, 'utf8');
}

function writeFailedRun(projectRoot, targetRunDir) {
  const validation = failedValidationResult();
  fs.writeFileSync(path.join(targetRunDir, 'context-pack.md'), '# Context\n', 'utf8');
  fs.writeFileSync(path.join(targetRunDir, 'impact-report.json'), `${JSON.stringify({
    risk: { level: 'L3', score: 5 },
    directTargets: ['harness/cli.mjs'],
    reverseDependents: [],
    impactedTests: ['harness/tests/repair-loop.test.mjs'],
    riskSignals: [{ signal: 'build-system-change' }],
    requiredSynchronizations: []
  }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(targetRunDir, 'validation-plan.json'), `${JSON.stringify({
    schemaVersion: 2,
    riskLevel: 'L3',
    commands: [{ id: 'lint', command: 'node -e "process.exit(1)"', available: true, required: true }],
    requiredSynchronizations: []
  }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(targetRunDir, 'validation-result.json'), `${JSON.stringify(validation, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(targetRunDir, 'failure-dossier.md'), '# Failure Dossier\n\nRaw logs live here.\n', 'utf8');
  fs.writeFileSync(path.join(targetRunDir, 'run-manifest.json'), `${JSON.stringify({
    schemaVersion: 2,
    runId: 'failed-run',
    createdAt: '2026-07-06T00:00:00.000Z',
    updatedAt: '2026-07-06T00:00:00.000Z',
    status: 'failed',
    phase: 'validation-complete',
    task: { raw: 'repair failed run', intent: null },
    repo: { root: projectRoot },
    risk: { level: 'L3', score: 5, signals: ['build-system-change'] },
    synchronizations: { requiredCount: 0, domains: [] },
    validation: { resultOutcome: 'FAIL', failedCount: 1 },
    artifacts: {
      contextPack: '.harness/runs/failed-run/context-pack.md',
      impactReport: '.harness/runs/failed-run/impact-report.json',
      validationPlan: '.harness/runs/failed-run/validation-plan.json',
      validationResult: '.harness/runs/failed-run/validation-result.json',
      failureDossier: '.harness/runs/failed-run/failure-dossier.md'
    }
  }, null, 2)}\n`, 'utf8');
}

function failedValidationResult() {
  return {
    generatedAt: '2026-07-06T00:00:00.000Z',
    planPath: '.harness/runs/failed-run/validation-plan.json',
    outcome: 'FAIL',
    results: [
      {
        id: 'lint',
        commandId: 'lint',
        label: 'Lint',
        tier: 'tier1-static',
        command: 'node -e "process.exit(1)"',
        required: true,
        outcome: 'FAIL',
        exitCode: 1,
        durationMs: 10,
        stdout: 'RAW_STDOUT_SHOULD_NOT_BE_IN_PROMPT',
        stderr: 'RAW_STDERR_SHOULD_NOT_BE_IN_PROMPT'
      }
    ]
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
