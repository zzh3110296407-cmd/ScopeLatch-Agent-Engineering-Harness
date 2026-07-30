import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { closeRun } from '../lib/closeout.mjs';
import { readGuardedWorkingTreeSnapshot, readWorkingTreeChanges } from '../lib/guard.mjs';
import { buildRunManifest, writeRunManifest } from '../lib/manifest.mjs';
import { planValidation } from '../lib/validation-planner.mjs';
import { validatePlan } from '../lib/validator.mjs';
import { normalizeCommandContract } from '../lib/v4/safe-executor.mjs';

const targetFailures = [];

runCase('empty-plan-blocked', () => {
  const observed = executeValidation({
    commands: [],
    graph: { schemaVersion: 1, mode: 'tiered', tiers: [], nodes: [], policy: {} }
  });
  requireCondition(observed.outcome === 'BLOCKED', `observed=${observed.outcome}`);
});

runCase('required-unavailable-blocked', () => {
  const observed = executeValidation({
    commands: [command('required-tool', '', true, false)],
    graph: graphFor('required-tool')
  });
  requireCondition(observed.outcome === 'BLOCKED', `observed=${observed.outcome}`);
});

runCase('optional-failure-not-formal-pass', () => {
  const observed = executeValidation({
    commands: [command('optional-assertion', `${nodeCommand()} -e "process.exit(1)"`, false, true)],
    graph: graphFor('optional-assertion')
  });
  requireCondition(observed.outcome !== 'PASS', `observed=${observed.outcome}`);
});

runCase('missing-required-graph-node-blocked', () => {
  const observed = executeValidation({
    commands: [command('required-orphan', `${nodeCommand()} -e "process.exit(0)"`, true, true)],
    graph: {
      schemaVersion: 1,
      mode: 'tiered',
      tiers: [{ id: 'tier0-guards', order: 0, label: 'Guards' }],
      nodes: [{ id: 'diff-guard', kind: 'manual-guard', tier: 'tier0-guards', dependsOn: [] }],
      policy: {}
    }
  });
  requireCondition(observed.outcome === 'BLOCKED', `observed=${observed.outcome}`);
});

runCase('required-sync-checks-compiled', () => {
  const root = makePackageRoot();
  try {
    const requiredIds = ['generate-client', 'test-contract', 'test-integration', 'test-e2e', 'full-ci'];
    const planned = planValidation({
      root,
      config: plannerConfig(),
      impactReport: {
        risk: { level: 'L1', score: 1 },
        riskSignals: [],
        categories: emptyCategories(),
        impactedTests: [],
        escalationRequired: false,
        requiredSynchronizations: [{
          domain: 'formal-contract',
          validationChecks: requiredIds
        }]
      }
    });
    const compiled = new Map(planned.commands.map((item) => [item.id, item]));
    const missing = requiredIds.filter((id) => !compiled.get(id)?.required);
    requireCondition(missing.length === 0, `missing=${missing.join(',')}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

runCase('git-status-error-blocked', () => {
  const notARepository = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v4-not-git-'));
  try {
    let blocked = false;
    try {
      const observed = readWorkingTreeChanges(notARepository);
      blocked = Boolean(observed?.status === 'blocked' || observed?.outcome === 'BLOCKED');
    } catch {
      blocked = true;
    }
    requireCondition(blocked, 'observed=empty-change-set');
  } finally {
    fs.rmSync(notARepository, { recursive: true, force: true });
  }
});

runCase('staged-index-content-bound', () => {
  const repo = makeGitRepository();
  try {
    const file = path.join(repo, 'candidate.txt');
    fs.writeFileSync(file, 'index-b\n', 'utf8');
    git(repo, ['add', 'candidate.txt']);
    fs.writeFileSync(file, 'worktree-c\n', 'utf8');
    const before = readGuardedWorkingTreeSnapshot(repo, { cacheEnabled: false });

    fs.writeFileSync(file, 'index-d\n', 'utf8');
    git(repo, ['add', 'candidate.txt']);
    fs.writeFileSync(file, 'worktree-c\n', 'utf8');
    const after = readGuardedWorkingTreeSnapshot(repo, { cacheEnabled: false });

    requireCondition(JSON.stringify(before) !== JSON.stringify(after), 'candidate identity unchanged after index blob changed');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

runCase('candidate-commit-binding-enforced', () => {
  const repo = makeGitRepository();
  try {
    const runDir = path.join(repo, '.harness', 'runs', 'candidate-binding');
    fs.mkdirSync(runDir, { recursive: true });
    const impact = minimalImpact();
    const validation = passingPlan();
    writeJson(path.join(runDir, 'impact-report.json'), impact);
    writeJson(path.join(runDir, 'validation-plan.json'), validation);
    writeRunManifest({
      runDir,
      manifest: buildRunManifest({
        root: repo,
        config: minimalConfig(),
        task: 'candidate binding red probe',
        runId: 'candidate-binding',
        runDir,
        impactReport: impact,
        validationPlan: validation
      })
    });

    fs.writeFileSync(path.join(repo, 'candidate.txt'), 'later-commit\n', 'utf8');
    git(repo, ['add', 'candidate.txt']);
    git(repo, ['commit', '-m', 'later']);
    const observed = closeRun({
      root: repo,
      runDir,
      config: minimalConfig(),
      guardOptions: { allowOutOfScope: true }
    });
    requireCondition(['blocked', 'invalidated'].includes(observed.status), `observed=${observed.status}`);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

runCase('plan-digest-tamper-detected', () => {
  const tempRoot = makeGitRepository();
  try {
    const runDir = path.join(tempRoot, '.harness', 'runs', 'plan-tamper');
    fs.mkdirSync(runDir, { recursive: true });
    const initialPlan = passingPlan();
    const impact = minimalImpact();
    writeJson(path.join(runDir, 'impact-report.json'), impact);
    writeJson(path.join(runDir, 'validation-plan.json'), initialPlan);
    writeRunManifest({
      runDir,
      manifest: buildRunManifest({
        root: tempRoot,
        config: minimalConfig(),
        task: 'plan tamper red probe',
        runId: 'plan-tamper',
        runDir,
        impactReport: impact,
        validationPlan: initialPlan
      })
    });
    writeJson(path.join(runDir, 'validation-plan.json'), {
      ...initialPlan,
      requiredCheckCount: 0,
      commands: [],
      graph: { ...initialPlan.graph, nodes: [] }
    });
    let observed;
    try {
      observed = validatePlan({
        root: tempRoot,
        planPath: path.join(runDir, 'validation-plan.json'),
        timeoutMs: 30000
      }).result.outcome;
    } catch {
      observed = 'BLOCKED';
    }
    requireCondition(['BLOCKED', 'INVALIDATED'].includes(observed), `observed=${observed}`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

if (targetFailures.length) {
  console.log('HARNESS_V4_TARGET_CONTRACT: FAIL');
  console.log(`HARNESS_V4_TARGET_FAILURES: ${targetFailures.map((item) => item.id).join(',')}`);
  process.exitCode = 1;
} else {
  console.log('HARNESS_V4_TARGET_CONTRACT: PASS');
}

function runCase(id, probe) {
  try {
    probe();
    console.log(`HARNESS_V4_RED_CASE ${id}: PASS`);
  } catch (error) {
    const message = sanitize(error instanceof Error ? error.message : String(error));
    targetFailures.push({ id, message });
    console.log(`HARNESS_V4_RED_CASE ${id}: FAIL ${message}`);
  }
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function executeValidation({ commands, graph }) {
  const tempRoot = makeGitRepository();
  try {
    const runDir = path.join(tempRoot, '.harness', 'runs', 'red-probe');
    fs.mkdirSync(runDir, { recursive: true });
    const plan = {
      schemaVersion: 2,
      generatedAt: '2026-07-29T00:00:00.000Z',
      riskLevel: 'L1',
      packageManager: 'npm',
      requiredCheckCount: commands.filter((item) => item.required).length,
      commands,
      graph,
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
    const impact = minimalImpact();
    writeJson(path.join(runDir, 'impact-report.json'), impact);
    writeJson(path.join(runDir, 'validation-plan.json'), plan);
    writeRunManifest({
      runDir,
      manifest: buildRunManifest({
        root: tempRoot,
        config: minimalConfig(),
        task: 'V4 validation red probe',
        runId: 'red-probe',
        runDir,
        impactReport: impact,
        validationPlan: plan
      })
    });
    try {
      return validatePlan({
        root: tempRoot,
        planPath: path.join(runDir, 'validation-plan.json'),
        timeoutMs: 30000
      }).result;
    } catch (error) {
      return { outcome: 'BLOCKED', reason: error instanceof Error ? error.message : String(error) };
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function command(id, executable, required, available) {
  return {
    id,
    label: id,
    command: executable ? normalizeCommandContract(executable) : null,
    available,
    required,
    reason: 'Harness v4 adversarial probe.',
    candidates: []
  };
}

function graphFor(id) {
  return {
    schemaVersion: 1,
    mode: 'tiered',
    tiers: [{ id: 'tier1-static', order: 1, label: 'Static' }],
    nodes: [{
      id,
      commandId: id,
      kind: 'command',
      tier: 'tier1-static',
      dependsOn: [],
      required: true
    }],
    policy: { skipLaterTiersOnRequiredFailure: true }
  };
}

function passingPlan() {
  return {
    schemaVersion: 2,
    generatedAt: '2026-07-29T00:00:00.000Z',
    riskLevel: 'L1',
    packageManager: 'npm',
    requiredCheckCount: 1,
    commands: [command('lint', `${nodeCommand()} -e "process.exit(0)"`, true, true)],
    graph: graphFor('lint'),
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
}

function minimalImpact() {
  return {
    intent: 'Harness v4 adversarial probe',
    baseRef: null,
    risk: { level: 'L1', score: 1 },
    riskSignals: [],
    categories: emptyCategories(),
    writeTargets: [],
    directTargets: [],
    reverseDependents: [],
    impactedTests: [],
    requiredSynchronizations: [],
    escalationRequired: false
  };
}

function emptyCategories() {
  return {
    publicApi: [],
    database: [],
    auth: [],
    payment: [],
    shared: [],
    buildSystem: [],
    tests: [],
    frontend: [],
    backend: [],
    docs: []
  };
}

function plannerConfig() {
  const executable = `${nodeCommand()} -e "process.exit(0)"`;
  return {
    packageManager: 'npm',
    commands: {
      lint: executable,
      typecheck: executable,
      testUnit: executable,
      testIntegration: executable,
      testContract: executable,
      testE2E: executable,
      build: executable,
      generateClient: executable,
      fullCI: executable
    },
    changeBudget: { maxRepairRounds: 0 }
  };
}

function minimalConfig() {
  return {
    repoName: 'harness-v4-red-probe',
    packageManager: 'npm',
    commands: {},
    changeBudget: { maxRepairRounds: 0, forbiddenDirs: [] },
    policy: { planMaxAgeMinutes: 240 },
    security: { scanSecrets: false, scanLocalAbsolutePaths: false }
  };
}

function makePackageRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v4-planner-'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"scripts":{}}\n', 'utf8');
  const catalog = path.join(root, 'harness', 'contracts', 'v4', 'invariant-catalog.json');
  fs.mkdirSync(path.dirname(catalog), { recursive: true });
  fs.copyFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'contracts', 'v4', 'invariant-catalog.json'),
    catalog
  );
  return root;
}

function makeGitRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v4-git-'));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'harness-v4@example.invalid']);
  git(root, ['config', 'user.name', 'Harness v4 Probe']);
  fs.writeFileSync(path.join(root, 'candidate.txt'), 'initial\n', 'utf8');
  git(root, ['add', 'candidate.txt']);
  git(root, ['commit', '-m', 'initial']);
  return root;
}

function git(root, args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed`);
  }
  return result.stdout.trim();
}

function nodeCommand() {
  return JSON.stringify(process.execPath);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sanitize(message) {
  return String(message)
    .replace(/[A-Z]:\\[^\s]+/gi, '<path>')
    .replace(/\/tmp\/[^\s]+/g, '<path>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}
