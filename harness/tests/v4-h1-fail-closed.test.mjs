import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  aggregateExecutionOutcome,
  validateExecutionPlan
} from '../lib/v4/outcome-engine.mjs';
import { buildRunManifest, writeRunManifest } from '../lib/manifest.mjs';
import { normalizeCommandContract } from '../lib/v4/safe-executor.mjs';
import { validatePlan } from '../lib/validator.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDir, '..', '..');

assertPlanViolation({
  plan: planFixture({
    requiredCheckCount: 2
  }),
  code: 'PLAN_REQUIRED_COUNT_MISMATCH'
});

assertPlanViolation({
  plan: planFixture({
    commands: [
      check('duplicate', true),
      check('duplicate', true)
    ],
    requiredCheckCount: 2,
    graph: graph([
      node('duplicate'),
      node('duplicate-copy', 'duplicate')
    ])
  }),
  code: 'PLAN_ID_DUPLICATE'
});

assertPlanViolation({
  plan: planFixture({
    graph: graph([])
  }),
  code: 'PLAN_REQUIRED_COMMAND_NODE_MISSING'
});

assertPlanViolation({
  plan: planFixture({
    graph: graph([
      node('required', 'required', ['later']),
      node('later', 'later', ['required'])
    ]),
    commands: [
      check('required', true),
      check('later', true)
    ],
    requiredCheckCount: 2
  }),
  code: 'PLAN_GRAPH_CYCLE'
});

const zeroRequired = aggregateExecutionOutcome({
  plan: planFixture({
    commands: [],
    requiredCheckCount: 0,
    graph: graph([])
  }),
  results: []
});
assert.equal(zeroRequired.outcome, 'BLOCKED');
assert.equal(zeroRequired.reasonCode, 'ZERO_APPLICABLE_REQUIRED_CHECKS');
assert.equal(zeroRequired.formalEligible, false);

const provisional = aggregateExecutionOutcome({
  plan: planFixture(),
  results: [{
    id: 'required',
    commandId: 'required',
    required: true,
    outcome: 'PASS'
  }]
});
assert.equal(provisional.outcome, 'PASS');
assert.equal(Object.hasOwn(provisional, 'status'), false);
assert.equal(provisional.developmentVerdict, 'PROVISIONAL_PASS');
assert.equal(provisional.formalEligible, false);

const optionalFailure = aggregateExecutionOutcome({
  plan: planFixture(),
  results: [
    {
      id: 'required',
      commandId: 'required',
      required: true,
      outcome: 'PASS'
    },
    {
      id: 'optional',
      commandId: 'optional',
      required: false,
      outcome: 'FAIL'
    }
  ]
});
assert.equal(optionalFailure.outcome, 'FAIL');
assert.equal(optionalFailure.formalEligible, false);

const missingRequiredResult = aggregateExecutionOutcome({
  plan: planFixture(),
  results: []
});
assert.equal(missingRequiredResult.outcome, 'BLOCKED');
assert.equal(missingRequiredResult.reasonCode, 'REQUIRED_RESULT_MISSING');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v4-h1-'));
try {
  fs.writeFileSync(path.join(tempRoot, 'repository-seed.txt'), 'seed\n', 'utf8');
  git(tempRoot, ['init']);
  git(tempRoot, ['config', 'user.email', 'harness@example.invalid']);
  git(tempRoot, ['config', 'user.name', 'Harness Test']);
  git(tempRoot, ['add', 'repository-seed.txt']);
  git(tempRoot, ['commit', '-m', 'initial']);

  const blockedRun = executePlan(tempRoot, 'required-unavailable', planFixture({
    commands: [{
      ...check('required', true),
      command: null,
      available: false
    }]
  }));
  assert.equal(blockedRun.result.outcome, 'BLOCKED');
  assert.equal(Object.hasOwn(blockedRun.result, 'status'), false);
  assert.equal(blockedRun.result.developmentVerdict, 'BLOCKED');
  assert.equal(blockedRun.result.formalEligible, false);
  assert.equal(blockedRun.result.results[0].outcome, 'BLOCKED');
  assert.equal(blockedRun.manifest.status, 'blocked');
  assert.equal(blockedRun.manifest.validation.formalEligible, false);
  const blockedRunDir = path.join(tempRoot, '.harness', 'runs', 'required-unavailable');
  const blockedCli = spawnSync(
    process.execPath,
    [path.join(repositoryRoot, 'harness', 'cli.mjs'), 'closeout', '--run', blockedRunDir],
    {
      cwd: tempRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120000,
      maxBuffer: 20 * 1024 * 1024
    }
  );
  assert.notEqual(blockedCli.status, 0);
  assert.match(blockedCli.stdout, /Validation outcome: BLOCKED/);
  const closeoutManifest = JSON.parse(fs.readFileSync(path.join(blockedRunDir, 'run-manifest.json'), 'utf8'));
  assert.equal(closeoutManifest.status, 'blocked');
  assert.equal(closeoutManifest.phase, 'closeout-blocked');

  const emptyRun = executePlan(tempRoot, 'empty-plan', planFixture({
    commands: [],
    requiredCheckCount: 0,
    graph: graph([])
  }));
  assert.equal(emptyRun.result.outcome, 'BLOCKED');
  assert.equal(emptyRun.result.reasonCode, 'ZERO_APPLICABLE_REQUIRED_CHECKS');

  const tamperedRun = executePlan(tempRoot, 'tampered-plan', planFixture({
    requiredCheckCount: 0
  }));
  assert.equal(tamperedRun.result.outcome, 'BLOCKED');
  assert.equal(tamperedRun.result.reasonCode, 'PLAN_CONTRACT_INVALID');
  assert.equal(tamperedRun.result.planViolations.some((item) => item.code === 'PLAN_REQUIRED_COUNT_MISMATCH'), true);
  assert.equal(tamperedRun.result.results.length, 0);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

const h1CaseIds = [
  'empty-plan-blocked',
  'missing-required-graph-node-blocked',
  'optional-failure-not-formal-pass',
  'required-sync-checks-compiled',
  'required-unavailable-blocked'
].sort();
const targetRun = spawnSync(process.execPath, [path.join(testDir, 'v4-trust-contract.red.mjs')], {
  cwd: repositoryRoot,
  encoding: 'utf8',
  windowsHide: true,
  timeout: 120000
});
const targetOutput = `${targetRun.stdout || ''}\n${targetRun.stderr || ''}`;
const targetObservations = parseTargetObservations(targetOutput);
for (const id of h1CaseIds) {
  assert.equal(targetObservations.get(id), 'PASS', `H1 target case is not green: ${id}`);
}
const currentTargetFailures = [...targetObservations.entries()]
  .filter(([, status]) => status === 'FAIL')
  .map(([id]) => id)
  .sort();
assert.deepEqual(currentTargetFailures.filter((id) => h1CaseIds.includes(id)), []);

const reportPath = path.join(repositoryRoot, '.harness', 'docs', 'harness-v4-h1-fail-closed-report.json');
const predecessorReportPath = path.join(repositoryRoot, '.harness', 'docs', 'harness-v4-h0-baseline-report.json');
assert.equal(fs.existsSync(reportPath), true, 'tracked H1 report is missing');
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const expectedAcceptance = [
  'all_applicable_required_checks_have_exactly_one_plan_node_and_result',
  'blocked_error_canceled_and_missing_required_evidence_cannot_pass',
  'cli_and_closeout_return_nonzero_terminal_status_for_blocked_validation',
  'development_success_is_explicitly_provisional_and_not_formal_eligible',
  'executed_optional_assertion_failure_cannot_pass',
  'l1_plans_have_at_least_one_required_behavior_check',
  'repair_cannot_relabel_blocked_validation_as_not_needed',
  'required_synchronization_checks_are_compiled_as_required_nodes',
  'zero_applicable_required_checks_are_blocked'
].sort();
assert.equal(report.schemaVersion, 1);
assert.equal(report.milestone, 'H1');
assert.equal(report.contractVersion, 'harness-trust-v4.0.0');
assert.equal(report.predecessor?.milestone, 'H0');
assert.equal(report.predecessor?.reportDigest, sha256(predecessorReportPath));
assert.equal(report.predecessor?.regressionStatus, 'PASS');
assert.deepEqual([...report.requiredTargetCaseIds].sort(), h1CaseIds);
assert.deepEqual([...report.observedPassingTargetCaseIds].sort(), h1CaseIds);
assert.deepEqual(Object.keys(report.acceptance).sort(), expectedAcceptance);
assert.equal(Object.values(report.acceptance).every((value) => value === true), true);
assert.deepEqual(report.hardFailures, []);
assert.equal(report.isolatedAcceptance.status, 'PASS');
assert.equal(report.isolatedAcceptance.networkUsed, false);
assert.equal(report.isolatedAcceptance.externalServicesCalled, false);
assert.equal(report.finalMarker, 'HARNESS_V4_H1_FAIL_CLOSED: PASS');

const expectedHashPaths = [
  'harness/cli.mjs',
  'harness/lib/closeout.mjs',
  'harness/lib/repair.mjs',
  'harness/lib/report.mjs',
  'harness/lib/v4/outcome-engine.mjs',
  'harness/lib/validation-planner.mjs',
  'harness/lib/validator.mjs',
  'harness/tests/codex-process-e2e.test.mjs',
  'harness/tests/repair-loop.test.mjs',
  'harness/tests/v4-h1-fail-closed.test.mjs',
  'harness/tests/validation-graph.test.mjs'
].sort();
assert.deepEqual(Object.keys(report.sourceHashes).sort(), expectedHashPaths);
for (const relPath of expectedHashPaths) {
  assert.equal(report.sourceHashes[relPath], sha256(path.join(repositoryRoot, relPath)), `H1 source hash mismatch: ${relPath}`);
}
const successorReportPath = path.join(repositoryRoot, '.harness', 'docs', 'harness-v4-h2-evidence-chain-report.json');
if (fs.existsSync(successorReportPath)) {
  const successor = JSON.parse(fs.readFileSync(successorReportPath, 'utf8'));
  assert.equal(successor.predecessor?.milestone, 'H1');
  assert.equal(successor.predecessor?.reportDigest, sha256(reportPath));
  assert.equal(successor.predecessor?.regressionStatus, 'PASS');
}

console.log('HARNESS_V4_H1_FAIL_CLOSED: PASS');

function executePlan(root, runId, plan) {
  const runDir = path.join(root, '.harness', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  const impactReport = {
    risk: { level: 'L1', score: 1 },
    riskSignals: [],
    requiredSynchronizations: []
  };
  writeJson(path.join(runDir, 'impact-report.json'), impactReport);
  writeJson(path.join(runDir, 'validation-plan.json'), plan);
  const manifest = buildRunManifest({
    root,
    config: {
      stateDir: '.harness/state',
      policy: { planMaxAgeMinutes: 240 }
    },
    task: `H1 fixture ${runId}`,
    runId,
    runDir,
    impactReport,
    validationPlan: plan,
    baselineSnapshot: [],
    sessionBinding: {
      required: false,
      fingerprint: null,
      source: 'test'
    }
  });
  writeRunManifest({ runDir, manifest });
  return validatePlan({
    root,
    planPath: path.join(runDir, 'validation-plan.json'),
    timeoutMs: 30000
  });
}

function assertPlanViolation({ plan, code }) {
  const validation = validateExecutionPlan(plan);
  assert.equal(validation.valid, false);
  assert.equal(validation.violations.some((item) => item.code === code), true, `missing plan violation ${code}`);
}

function planFixture(overrides = {}) {
  const base = {
    schemaVersion: 2,
    generatedAt: '2026-07-29T00:00:00.000Z',
    riskLevel: 'L1',
    packageManager: 'npm',
    requiredCheckCount: 1,
    commands: [check('required', true)],
    graph: graph([node('required')]),
    impactedTests: [],
    requiredSynchronizations: [],
    notes: [],
    policy: {
      runAvailableOnly: true,
      skipUnavailableWithReason: true,
      failIfRequiredCommandFails: true,
      maxRepairRounds: 0
    }
  };
  return {
    ...base,
    ...overrides
  };
}

function check(id, required) {
  return {
    id,
    label: id,
    command: normalizeCommandContract(`${JSON.stringify(process.execPath)} -e "process.exit(0)"`),
    available: true,
    required,
    reason: 'H1 contract test.',
    candidates: []
  };
}

function graph(nodes) {
  return {
    schemaVersion: 1,
    mode: 'tiered',
    tiers: [{ id: 'tier1-static', order: 1, label: 'Static' }],
    nodes,
    policy: {
      skipLaterTiersOnRequiredFailure: true,
      skipDependentsOnFailedDependency: true
    }
  };
}

function node(id, commandId = id, dependsOn = []) {
  return {
    id,
    commandId,
    kind: 'command',
    tier: 'tier1-static',
    dependsOn,
    required: true
  };
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseTargetObservations(output) {
  const observations = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = /^HARNESS_V4_RED_CASE ([a-z0-9-]+): (PASS|FAIL)(?:\s|$)/.exec(line);
    if (!match) continue;
    assert.equal(observations.has(match[1]), false, `duplicate target observation: ${match[1]}`);
    observations.set(match[1], match[2]);
  }
  return observations;
}

function sha256(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}
