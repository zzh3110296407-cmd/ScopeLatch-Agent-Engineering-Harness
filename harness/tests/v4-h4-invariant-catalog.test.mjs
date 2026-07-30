import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildRunManifest, writeRunManifest } from '../lib/manifest.mjs';
import { planValidation } from '../lib/validation-planner.mjs';
import { validatePlan } from '../lib/validator.mjs';
import {
  deriveAcceptanceEvidence,
  loadInvariantCatalog,
  validateAcceptanceEvidence,
  validateInvariantCatalog
} from '../lib/v4/invariant-catalog.mjs';
import { normalizeCommandContract } from '../lib/v4/safe-executor.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDir, '..', '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v4-h4-'));

try {
  copyCatalog(repositoryRoot, root);
  fs.writeFileSync(path.join(root, '.gitignore'), '.harness/\n', 'utf8');
  git(['init']);
  git(['config', 'user.email', 'harness@example.invalid']);
  git(['config', 'user.name', 'Harness H4 Test']);
  git(['add', '.']);
  git(['commit', '-m', 'fixture']);
  const loaded = loadInvariantCatalog(root);
  assert.equal(loaded.catalog.catalogId, 'harness-v4-invariant-catalog');
  assert.equal(loaded.catalog.contractVersion, 'harness-invariants-v4.0.0');
  assert.deepEqual(validateInvariantCatalog(loaded.catalog), []);

  const duplicateAcceptance = structuredClone(loaded.catalog);
  duplicateAcceptance.invariants[1].acceptanceId = duplicateAcceptance.invariants[0].acceptanceId;
  assert.equal(
    validateInvariantCatalog(duplicateAcceptance).some((item) => item.code === 'INVARIANT_ACCEPTANCE_ID_INVALID'),
    true
  );
  const cycle = structuredClone(loaded.catalog);
  cycle.invariants[0].dependencies = ['full-ci-l4'];
  assert.equal(validateInvariantCatalog(cycle).some((item) => item.code === 'INVARIANT_DEPENDENCY_CYCLE'), true);
  const unknownField = structuredClone(loaded.catalog);
  unknownField.invariants[0].fabricated = true;
  assert.equal(validateInvariantCatalog(unknownField).some((item) => item.code === 'INVARIANT_SHAPE_INVALID'), true);

  const config = configFixture();
  const knownImpact = impactFixture();
  const first = planValidation({ root, config, impactReport: knownImpact });
  const second = planValidation({ root, config, impactReport: structuredClone(knownImpact) });
  assert.equal(first.schemaVersion, 4);
  assert.equal(first.graph.mode, 'catalog');
  assert.equal(first.planningDigest, second.planningDigest);
  assert.deepEqual(first.invariantPlan, second.invariantPlan);
  assert.deepEqual(first.commands.map((item) => item.id), second.commands.map((item) => item.id));
  assert.equal(first.invariantPlan.applicableInvariants.some((item) => item.invariantId === 'public-api-contract'), true);
  assert.equal(first.invariantPlan.applicableInvariants.some((item) => item.invariantId === 'type-safety'), true);
  assert.equal(first.invariantPlan.applicableInvariants.some((item) => item.invariantId === 'static-lint'), true);
  assert.equal(first.invariantPlan.acceptanceRequirements.every((item) => item.resultIds.length > 0), true);

  const unknownImpact = impactFixture({
    risk: { level: 'L1', score: 1 },
    riskSignals: [],
    changedFiles: ['mystery/input.unknown'],
    categories: emptyCategories(),
    impactedTests: []
  });
  const unknownPlan = planValidation({ root, config, impactReport: unknownImpact });
  assert.deepEqual(unknownPlan.invariantPlan.unknownChangedFiles, ['mystery/input.unknown']);
  for (const id of ['lint', 'typecheck', 'test-unit', 'test-integration', 'build']) {
    assert.equal(unknownPlan.commands.some((item) => item.id === id && item.required), true, `missing conservative command ${id}`);
  }

  const selectorImpact = impactFixture({
    impactedTests: ['tests/b.test.mjs', 'tests/a.test.mjs']
  });
  const selectorPlan = planValidation({ root, config, impactReport: selectorImpact });
  assert.deepEqual(
    selectorPlan.invariantPlan.testSelectorBindings.map((item) => item.selector),
    ['tests/a.test.mjs', 'tests/b.test.mjs']
  );
  assert.equal(
    selectorPlan.invariantPlan.testSelectorBindings.every((item) => selectorPlan.graph.nodes.some((node) => node.commandId === item.resultId)),
    true
  );

  const syncImpact = impactFixture({
    requiredSynchronizations: [{
      domain: 'custom',
      required: true,
      validationChecks: ['test-contract', 'custom-unregistered']
    }]
  });
  const syncPlan = planValidation({ root, config, impactReport: syncImpact });
  assert.equal(syncPlan.commands.some((item) => item.id === 'test-contract' && item.required), true);
  assert.equal(syncPlan.commands.some((item) => item.id === 'custom-unregistered' && !item.available && item.required), true);
  const syncAcceptance = syncPlan.invariantPlan.acceptanceRequirements
    .find((item) => item.invariantId === 'required-synchronizations');
  assert.deepEqual(syncAcceptance.resultIds, ['custom-unregistered', 'test-contract']);

  const runDir = path.join(root, '.harness', 'runs', 'catalog-pass');
  writeRunFixture(runDir, knownImpact, first);
  const passed = validatePlan({
    root,
    planPath: path.join(runDir, 'validation-plan.json'),
    timeoutMs: 30000
  });
  assert.equal(passed.result.outcome, 'PASS');
  assert.equal(Object.hasOwn(passed.result, 'status'), false);
  assert.equal(passed.result.invariantValidation.valid, true);
  assert.equal(passed.result.invariantResults.length, first.invariantPlan.acceptanceRequirements.length);
  assert.equal(passed.result.invariantResults.every((item) => item.outcome === 'PASS'), true);
  const acceptanceEvidence = deriveAcceptanceEvidence(passed.result.invariantResults);
  assert.equal(validateAcceptanceEvidence({
    acceptanceEvidence,
    invariantResults: passed.result.invariantResults
  }).valid, true);
  assert.equal(validateAcceptanceEvidence({
    acceptanceEvidence: [...acceptanceEvidence, {
      acceptanceId: 'fabricated_unobserved_claim',
      invariantResultId: `sha256:${'0'.repeat(64)}`,
      outcome: 'PASS'
    }],
    invariantResults: passed.result.invariantResults
  }).valid, false);

  const driftImpact = impactFixture();
  const driftPlan = planValidation({ root, config, impactReport: driftImpact });
  const driftRunDir = path.join(root, '.harness', 'runs', 'catalog-drift');
  const sentinel = path.join(root, 'catalog-drift-command-executed.txt');
  driftPlan.commands = driftPlan.commands.map((item) => ({
    ...item,
    command: normalizeCommandContract(`${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync(${JSON.stringify(sentinel)},'bad')"`)
  }));
  driftPlan.planningDigest = recomputePlanningDigestForTest(driftPlan);
  writeRunFixture(driftRunDir, driftImpact, driftPlan);
  const changedCatalog = structuredClone(loaded.catalog);
  changedCatalog.invariants[0].description = 'Changed after planning.';
  writeJson(path.join(root, 'harness', 'contracts', 'v4', 'invariant-catalog.json'), changedCatalog);
  const invalidated = validatePlan({
    root,
    planPath: path.join(driftRunDir, 'validation-plan.json'),
    timeoutMs: 30000
  });
  assert.equal(invalidated.result.outcome, 'INVALIDATED');
  assert.equal(Object.hasOwn(invalidated.result, 'status'), false);
  assert.equal(invalidated.result.results.length, 0);
  assert.equal(
    invalidated.result.invariantValidation.violations.some((item) => item.code === 'INVARIANT_CATALOG_BINDING_DRIFT'),
    true
  );
  assert.equal(fs.existsSync(sentinel), false);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

const reportPath = path.join(repositoryRoot, '.harness', 'docs', 'harness-v4-h4-invariant-catalog-report.json');
const predecessorPath = path.join(repositoryRoot, '.harness', 'docs', 'harness-v4-h3-git-candidate-report.json');
assert.equal(fs.existsSync(reportPath), true, 'tracked H4 report is missing');
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
assert.equal(report.schemaVersion, 1);
assert.equal(report.milestone, 'H4');
assert.equal(report.contractVersion, 'harness-trust-v4.0.0');
assert.equal(report.predecessor.milestone, 'H3');
assert.equal(report.predecessor.reportDigest, sha256(predecessorPath));
assert.equal(report.predecessor.regressionStatus, 'PASS');
assert.deepEqual(report.hardFailures, []);
assert.equal(report.isolatedAcceptance.status, 'PASS');
assert.equal(report.isolatedAcceptance.networkUsed, false);
assert.equal(report.finalMarker, 'HARNESS_V4_H4_INVARIANT_CATALOG: PASS');
assert.equal(Object.hasOwn(report, 'acceptance'), false, 'H4 report must not contain handwritten acceptance booleans');
const observationById = new Map(report.observations.map((item) => [item.invariantResultId, item]));
assert.equal(new Set(report.observations.map((item) => item.invariantResultId)).size, report.observations.length);
for (const item of report.acceptanceEvidence) {
  assert.equal(item.outcome, 'PASS');
  assert.equal(item.invariantResultIds.length > 0, true);
  for (const resultId of item.invariantResultIds) {
    assert.equal(observationById.get(resultId)?.outcome, 'PASS', `missing observed invariant result ${resultId}`);
  }
}
assert.deepEqual(
  [...new Set(report.acceptanceEvidence.flatMap((item) => item.invariantResultIds))].sort(),
  [...observationById.keys()].sort()
);

const expectedHashPaths = [
  'harness/contracts/v4/invariant-catalog.json',
  'harness/lib/v4/invariant-catalog.mjs',
  'harness/lib/validation-planner.mjs',
  'harness/lib/validator.mjs',
  'harness/tests/codex-process-e2e.test.mjs',
  'harness/tests/pr10-report-ci.test.mjs',
  'harness/tests/run-command.test.mjs',
  'harness/tests/synchronizations.test.mjs',
  'harness/tests/v4-h3-git-candidate.test.mjs',
  'harness/tests/v4-h4-invariant-catalog.test.mjs',
  'harness/tests/v4-trust-contract.red.mjs',
  'harness/tests/validation-graph.test.mjs'
].sort();
assert.deepEqual(Object.keys(report.sourceHashes).sort(), expectedHashPaths);
for (const relPath of expectedHashPaths) {
  assert.equal(report.sourceHashes[relPath], sha256(path.join(repositoryRoot, relPath)), `H4 source hash mismatch: ${relPath}`);
}
const successorPath = path.join(repositoryRoot, '.harness', 'docs', 'harness-v4-h5-independent-auditor-report.json');
if (fs.existsSync(successorPath)) {
  const successor = JSON.parse(fs.readFileSync(successorPath, 'utf8'));
  assert.equal(successor.predecessor?.milestone, 'H4');
  assert.equal(successor.predecessor?.reportDigest, sha256(reportPath));
  assert.equal(successor.predecessor?.regressionStatus, 'PASS');
}

console.log('HARNESS_V4_H4_INVARIANT_CATALOG: PASS');

function configFixture() {
  const pass = `${JSON.stringify(process.execPath)} -e "process.exit(0)"`;
  return {
    packageManager: 'npm',
    commands: {
      lint: pass,
      typecheck: pass,
      testUnit: pass,
      testIntegration: pass,
      testContract: pass,
      testE2E: pass,
      build: pass,
      generateClient: pass,
      fullCI: pass
    },
    changeBudget: { maxRepairRounds: 3 }
  };
}

function impactFixture(overrides = {}) {
  return {
    risk: { level: 'L3', score: 6 },
    riskSignals: [{ signal: 'public-api-change', source: 'path' }],
    categories: {
      ...emptyCategories(),
      publicApi: ['src/api/story.mjs'],
      backend: ['src/api/story.mjs']
    },
    changedFiles: ['src/api/story.mjs'],
    impactedTests: [],
    requiredSynchronizations: [],
    escalationRequired: false,
    ...overrides
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

function writeRunFixture(runDir, impact, plan) {
  fs.mkdirSync(runDir, { recursive: true });
  writeJson(path.join(runDir, 'impact-report.json'), impact);
  writeJson(path.join(runDir, 'validation-plan.json'), plan);
  const fixtureRoot = path.resolve(runDir, '..', '..', '..');
  const runId = path.basename(runDir);
  const manifest = buildRunManifest({
    root: fixtureRoot,
    config: {
      stateDir: '.harness/state',
      policy: { planMaxAgeMinutes: 240 }
    },
    task: `H4 fixture ${runId}`,
    runId,
    runDir,
    impactReport: impact,
    validationPlan: plan,
    baselineSnapshot: [],
    sessionBinding: {
      required: false,
      fingerprint: null,
      source: 'test'
    }
  });
  writeRunManifest({ runDir, manifest });
}

function copyCatalog(sourceRoot, targetRoot) {
  const source = path.join(sourceRoot, 'harness', 'contracts', 'v4', 'invariant-catalog.json');
  const target = path.join(targetRoot, 'harness', 'contracts', 'v4', 'invariant-catalog.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function recomputePlanningDigestForTest(plan) {
  const stable = structuredClone(plan);
  delete stable.generatedAt;
  delete stable.planningDigest;
  return `sha256:${crypto.createHash('sha256').update(canonicalForTest(stable)).digest('hex')}`;
}

function canonicalForTest(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalForTest).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalForTest(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sha256(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function git(args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 1024 * 1024
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}
