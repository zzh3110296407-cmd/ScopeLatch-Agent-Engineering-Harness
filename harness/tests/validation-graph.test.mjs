import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planValidation } from '../lib/validation-planner.mjs';
import { validatePlan } from '../lib/validator.mjs';
import { buildFailureDossier } from '../lib/prompt-builder.mjs';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-validation-graph-'));
const runDir = path.join(tempRoot, '.harness', 'runs', 'graph-run');
fs.mkdirSync(runDir, { recursive: true });

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

assert.equal(planned.schemaVersion, 2);
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
fs.writeFileSync(path.join(passRunDir, 'impact-report.json'), `${JSON.stringify(impactReportFixture(), null, 2)}\n`, 'utf8');

const { result: passingResult } = validatePlan({
  root: tempRoot,
  planPath: path.join(passRunDir, 'validation-plan.json'),
  timeoutMs: 30000
});

assert.equal(passingResult.status, 'passed');
assert.deepEqual(passingResult.results.map((item) => [item.id, item.status]), [
  ['lint', 'passed'],
  ['build', 'passed']
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
fs.writeFileSync(path.join(runDir, 'impact-report.json'), `${JSON.stringify(impactReportFixture(), null, 2)}\n`, 'utf8');

const { result } = validatePlan({
  root: tempRoot,
  planPath: path.join(runDir, 'validation-plan.json'),
  timeoutMs: 30000
});

assert.equal(result.status, 'failed');
assert.deepEqual(result.results.map((item) => [item.id, item.status]), [
  ['lint', 'failed'],
  ['test-contract', 'skipped'],
  ['test-integration', 'skipped']
]);
assert.equal(fs.existsSync(skippedMarker), false);

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
    command: cmd,
    available: true,
    required,
    reason: `${id} reason`,
    candidates: []
  };
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
