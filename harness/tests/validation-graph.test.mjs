import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { planValidation } from '../lib/validation-planner.mjs';
import { validatePlan } from '../lib/validator.mjs';
import { buildFailureDossier } from '../lib/prompt-builder.mjs';
import { buildRunManifest, writeRunManifest } from '../lib/manifest.mjs';
import { normalizeCommandContract } from '../lib/v4/safe-executor.mjs';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-validation-graph-'));
const runDir = path.join(tempRoot, '.harness', 'runs', 'graph-run');
fs.mkdirSync(runDir, { recursive: true });
const catalogTarget = path.join(tempRoot, 'harness', 'contracts', 'v4', 'invariant-catalog.json');
fs.mkdirSync(path.dirname(catalogTarget), { recursive: true });
fs.copyFileSync(
  path.join(process.cwd(), 'harness', 'contracts', 'v4', 'invariant-catalog.json'),
  catalogTarget
);
fs.writeFileSync(path.join(tempRoot, '.gitignore'), '.harness/\n', 'utf8');
git(['init']);
git(['config', 'user.email', 'harness@example.invalid']);
git(['config', 'user.name', 'Harness Validation Graph']);
git(['add', '.']);
git(['commit', '-m', 'fixture']);

const planned = planValidation({
  root: tempRoot,
  config: {
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
    },
    changeBudget: { maxRepairRounds: 3 }
  },
  impactReport: impactReportFixture()
});

assert.equal(planned.schemaVersion, 4);
assert.equal(planned.invariantCatalog.catalogId, 'harness-v4-invariant-catalog');
assert.match(planned.planningDigest, /^sha256:[a-f0-9]{64}$/);
assert.equal(planned.invariantPlan.acceptanceRequirements.length > 0, true);
assert.ok(Array.isArray(planned.commands));
assert.ok(Array.isArray(planned.graph.tiers));
assert.ok(Array.isArray(planned.graph.nodes));
assert.deepEqual(planned.graph.tiers.map((tier) => tier.id), [
  'tier0-guards',
  'tier1-static',
  'tier2-targeted',
  'tier3-integration'
]);
assert.equal(planned.graph.nodes.some((node) => node.id === 'diff-guard' && node.tier === 'tier0-guards'), true);
assert.equal(planned.graph.nodes.find((node) => node.id === 'lint').tier, 'tier1-static');
assert.equal(planned.graph.nodes.find((node) => node.id === 'test-contract').tier, 'tier2-targeted');
assert.equal(planned.graph.nodes.find((node) => node.id === 'test-integration').tier, 'tier3-integration');

const passRunDir = path.join(tempRoot, '.harness', 'runs', 'graph-pass-run');
fs.mkdirSync(passRunDir, { recursive: true });
const passingValidationPlan = {
  schemaVersion: 2,
  generatedAt: '2026-07-06T00:00:00.000Z',
  riskLevel: 'L2',
  packageManager: 'npm',
  requiredCheckCount: 2,
  commands: [
    command('lint', 'Lint', 'node -e "console.log(1)"', true),
    command('build', 'Build', 'node -e "console.log(2)"', true)
  ],
  graph: {
    schemaVersion: 1,
    mode: 'tiered',
    tiers: [
      { id: 'tier1-static', order: 1, label: 'Static validation' },
      { id: 'tier3-integration', order: 3, label: 'Integration validation' }
    ],
    nodes: [
      { id: 'lint', commandId: 'lint', tier: 'tier1-static', dependsOn: [] },
      { id: 'build', commandId: 'build', tier: 'tier3-integration', dependsOn: ['lint'] }
    ],
    policy: {
      skipLaterTiersOnRequiredFailure: true
    }
  },
  impactedTests: [],
  notes: [],
  policy: {
    runAvailableOnly: true,
    skipUnavailableWithReason: true,
    failIfRequiredCommandFails: true,
    maxRepairRounds: 3
  }
};

fs.writeFileSync(path.join(passRunDir, 'validation-plan.json'), `${JSON.stringify(passingValidationPlan, null, 2)}\n`, 'utf8');
const passingImpactReport = impactReportFixture();
fs.writeFileSync(path.join(passRunDir, 'impact-report.json'), `${JSON.stringify(passingImpactReport, null, 2)}\n`, 'utf8');
writeV4Manifest({
  runDir: passRunDir,
  runId: 'graph-pass-run',
  validationPlan: passingValidationPlan,
  impactReport: passingImpactReport
});

const { result: passingResult } = validatePlan({
  root: tempRoot,
  planPath: path.join(passRunDir, 'validation-plan.json'),
  timeoutMs: 30000
});

assert.equal(passingResult.outcome, 'PASS');
assert.equal(passingResult.developmentVerdict, 'PROVISIONAL_PASS');
assert.equal(passingResult.formalEligible, false);
assert.deepEqual(passingResult.results.map((item) => [item.id, item.outcome]), [
  ['lint', 'PASS'],
  ['build', 'PASS']
]);

const skippedMarker = path.join(tempRoot, 'should-not-run.txt');
const validationPlan = {
  schemaVersion: 2,
  generatedAt: '2026-07-06T00:00:00.000Z',
  riskLevel: 'L4',
  packageManager: 'npm',
  requiredCheckCount: 3,
  commands: [
    command('lint', 'Lint', 'node -e "process.exit(1)"', true),
    command('test-contract', 'Contract tests', `node -e "require('fs').writeFileSync(${JSON.stringify(skippedMarker)}, 'bad')"`, true),
    command('test-integration', 'Integration tests', `node -e "require('fs').writeFileSync(${JSON.stringify(skippedMarker)}, 'bad')"`, true)
  ],
  graph: {
    schemaVersion: 1,
    mode: 'tiered',
    tiers: [
      { id: 'tier1-static', order: 1, label: 'Static validation' },
      { id: 'tier2-targeted', order: 2, label: 'Targeted validation' },
      { id: 'tier3-integration', order: 3, label: 'Integration validation' }
    ],
    nodes: [
      { id: 'lint', commandId: 'lint', tier: 'tier1-static', dependsOn: [] },
      { id: 'test-contract', commandId: 'test-contract', tier: 'tier2-targeted', dependsOn: ['lint'] },
      { id: 'test-integration', commandId: 'test-integration', tier: 'tier3-integration', dependsOn: ['test-contract'] }
    ],
    policy: {
      skipLaterTiersOnRequiredFailure: true
    }
  },
  impactedTests: [],
  notes: [],
  policy: {
    runAvailableOnly: true,
    skipUnavailableWithReason: true,
    failIfRequiredCommandFails: true,
    maxRepairRounds: 3
  }
};

fs.writeFileSync(path.join(runDir, 'validation-plan.json'), `${JSON.stringify(validationPlan, null, 2)}\n`, 'utf8');
const failingImpactReport = impactReportFixture();
fs.writeFileSync(path.join(runDir, 'impact-report.json'), `${JSON.stringify(failingImpactReport, null, 2)}\n`, 'utf8');
writeV4Manifest({
  runDir,
  runId: 'graph-run',
  validationPlan,
  impactReport: failingImpactReport
});

const { result } = validatePlan({
  root: tempRoot,
  planPath: path.join(runDir, 'validation-plan.json'),
  timeoutMs: 30000
});

assert.equal(result.outcome, 'FAIL');
assert.equal(result.developmentVerdict, 'FAIL');
assert.equal(result.formalEligible, false);
assert.deepEqual(result.results.map((item) => [item.id, item.outcome]), [
  ['lint', 'FAIL'],
  ['test-contract', 'BLOCKED'],
  ['test-integration', 'BLOCKED']
]);
assert.equal(fs.existsSync(skippedMarker), false);
assert.equal(result.results[1].outcome, 'BLOCKED');
assert.equal(result.results[2].outcome, 'BLOCKED');

const syncPlanned = planValidation({
  root: tempRoot,
  config: {
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
    },
    changeBudget: { maxRepairRounds: 3 }
  },
  impactReport: {
    ...impactReportFixture(),
    risk: { level: 'L1', score: 1 },
    riskSignals: [],
    categories: {
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
    },
    requiredSynchronizations: [{
      domain: 'harness-control',
      required: true,
      validationChecks: ['typecheck', 'test-unit', 'test-integration', 'test-contract', 'test-e2e', 'generate-client', 'build', 'full-ci']
    }]
  }
});
const syncCommands = new Map(syncPlanned.commands.map((item) => [item.id, item]));
for (const id of ['typecheck', 'test-unit', 'test-integration', 'test-contract', 'test-e2e', 'generate-client', 'build', 'full-ci']) {
  assert.equal(syncCommands.get(id)?.required, true, `required synchronization command not compiled: ${id}`);
  assert.equal(syncPlanned.graph.nodes.some((node) => node.commandId === id && node.required), true);
}

const dossier = buildFailureDossier({
  validationResult: result,
  impactReport: impactReportFixture(),
  validationPlan
});
assert.match(dossier, /Required Synchronizations/);
assert.match(dossier, /public-api/);
assert.match(dossier, /generate-client/);

fs.rmSync(tempRoot, { recursive: true, force: true });

console.log('VALIDATION_GRAPH_TEST_PASS');

function command(id, label, cmd, required) {
  return {
    id,
    label,
    command: normalizeCommandContract(cmd),
    available: true,
    required,
    reason: `${id} reason`,
    candidates: []
  };
}

function git(args) {
  const result = spawnSync('git', args, {
    cwd: tempRoot,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 1024 * 1024
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function writeV4Manifest({ runDir: targetRunDir, runId, validationPlan: targetPlan, impactReport }) {
  const manifest = buildRunManifest({
    root: tempRoot,
    config: {
      stateDir: '.harness/state',
      policy: { planMaxAgeMinutes: 240 }
    },
    task: `validation graph fixture ${runId}`,
    runId,
    runDir: targetRunDir,
    impactReport,
    validationPlan: targetPlan,
    baselineSnapshot: [],
    sessionBinding: {
      required: false,
      fingerprint: null,
      source: 'test'
    }
  });
  writeRunManifest({ runDir: targetRunDir, manifest });
}

function impactReportFixture() {
  return {
    risk: { level: 'L4', score: 10 },
    riskSignals: [{ signal: 'public-api-change', source: 'path' }],
    categories: {
      publicApi: ['src/api/story.js'],
      database: [],
      auth: [],
      payment: [],
      shared: [],
      buildSystem: [],
      tests: [],
      frontend: [],
      backend: ['src/api/story.js'],
      docs: []
    },
    directTargets: ['src/api/story.js'],
    reverseDependents: [],
    impactedTests: [],
    escalationRequired: true,
    requiredSynchronizations: [
      {
        domain: 'public-api',
        title: 'Backend API / OpenAPI / frontend client',
        validationChecks: ['generate-client', 'test-contract'],
        review: ['OpenAPI/schema shape', 'frontend API client and consumers'],
        trigger: { files: ['src/api/story.js'] }
      }
    ]
  };
}
