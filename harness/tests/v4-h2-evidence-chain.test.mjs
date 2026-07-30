import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildRunManifest, writeRunManifest } from '../lib/manifest.mjs';
import { validatePlan } from '../lib/validator.mjs';
import { canonicalJson, digestCanonicalJson } from '../lib/v4/canonical-json.mjs';
import {
  recordEvidenceObject,
  verifyRunEvidenceBindings
} from '../lib/v4/evidence-store.mjs';
import { normalizeCommandContract } from '../lib/v4/safe-executor.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDir, '..', '..');

assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
assert.equal(digestCanonicalJson({ b: 2, a: 1 }), digestCanonicalJson({ a: 1, b: 2 }));
assert.throws(() => canonicalJson({ invalid: Number.NaN }), /non-finite/);
const cyclic = {};
cyclic.self = cyclic;
assert.throws(() => canonicalJson(cyclic), /cyclic/);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v4-h2-'));
try {
  fs.writeFileSync(path.join(root, 'repository-seed.txt'), 'seed\n', 'utf8');
  git(root, ['init']);
  git(root, ['config', 'user.email', 'harness@example.invalid']);
  git(root, ['config', 'user.name', 'Harness Test']);
  git(root, ['add', 'repository-seed.txt']);
  git(root, ['commit', '-m', 'initial']);

  const valid = createSealedRun(root, 'valid-run');
  const validResult = validatePlan({
    root,
    planPath: path.join(valid.runDir, 'validation-plan.json'),
    timeoutMs: 30000
  });
  assert.equal(Object.hasOwn(validResult.result, 'status'), false);
  assert.equal(validResult.result.outcome, 'PASS');
  assert.equal(validResult.result.evidenceValidation.mode, 'sealed');
  assert.equal(validResult.result.evidenceValidation.valid, true);
  assert.equal(validResult.result.results[0].evidenceBinding.runId, 'valid-run');
  assert.match(validResult.result.results[0].evidenceBinding.bindingDigest, /^sha256:[a-f0-9]{64}$/);
  const evidenceIndex = JSON.parse(fs.readFileSync(path.join(valid.runDir, 'evidence-index.json'), 'utf8'));
  assert.equal(evidenceIndex.runId, 'valid-run');
  assert.equal(evidenceIndex.entries.length, 1);
  assert.equal(fs.existsSync(path.join(valid.runDir, evidenceIndex.entries[0].path)), true);

  const idempotent = recordEvidenceObject({
    runDir: valid.runDir,
    runId: 'valid-run',
    kind: 'validation-result',
    value: validResult.result,
    parentDigests: validResult.result.results.map((item) => item.evidenceBinding.bindingDigest)
  });
  const idempotentAgain = recordEvidenceObject({
    runDir: valid.runDir,
    runId: 'valid-run',
    kind: 'validation-result',
    value: validResult.result,
    parentDigests: validResult.result.results.map((item) => item.evidenceBinding.bindingDigest)
  });
  assert.equal(idempotent.digest, idempotentAgain.digest);

  assertInvalidatedAfter(root, 'plan-drift', ({ runDir, plan }) => {
    writeJson(path.join(runDir, 'validation-plan.json'), {
      ...plan,
      commands: plan.commands.map((item) => ({ ...item, label: 'tampered-but-structurally-valid' }))
    });
  }, 'EVIDENCE_VALIDATION_PLAN_DRIFT');

  assertInvalidatedAfter(root, 'impact-drift', ({ runDir, impact }) => {
    writeJson(path.join(runDir, 'impact-report.json'), {
      ...impact,
      directTargets: ['tampered.js']
    });
  }, 'EVIDENCE_IMPACT_REPORT_DRIFT');

  assertInvalidatedAfter(root, 'policy-drift', ({ configPath }) => {
    fs.writeFileSync(configPath, '{"policy":"changed"}\n', 'utf8');
  }, 'EVIDENCE_POLICY_SOURCE_DRIFT');

  assertInvalidatedAfter(root, 'authority-drift', ({ authorityPath }) => {
    fs.writeFileSync(authorityPath, '{"status":"changed"}\n', 'utf8');
  }, 'EVIDENCE_SOURCE_AUTHORITY_DRIFT');

  assertInvalidatedAfter(root, 'engine-drift', () => {
    fs.writeFileSync(path.join(root, 'harness', 'lib', 'probe.mjs'), 'export const changed = true;\n', 'utf8');
  }, 'EVIDENCE_ENGINE_DRIFT');
  fs.writeFileSync(path.join(root, 'harness', 'lib', 'probe.mjs'), 'export const stable = true;\n', 'utf8');

  const runA = createSealedRun(root, 'run-a');
  const runB = createSealedRun(root, 'run-b');
  fs.copyFileSync(path.join(runA.runDir, 'run-binding.json'), path.join(runB.runDir, 'run-binding.json'));
  const crossRun = validatePlan({
    root,
    planPath: path.join(runB.runDir, 'validation-plan.json'),
    timeoutMs: 30000
  });
  assert.equal(crossRun.result.outcome, 'INVALIDATED');
  assert.equal(Object.hasOwn(crossRun.result, 'status'), false);
  assert.equal(
    crossRun.result.evidenceValidation.violations.some((item) => ['EVIDENCE_BINDING_RECORD_MISMATCH', 'EVIDENCE_RUN_ID_MISMATCH'].includes(item.code)),
    true
  );

  const missingBinding = createSealedRun(root, 'missing-binding');
  removeTree(path.join(missingBinding.runDir, 'run-binding.json'));
  const missingResult = validatePlan({
    root,
    planPath: path.join(missingBinding.runDir, 'validation-plan.json'),
    timeoutMs: 30000
  });
  assert.equal(missingResult.result.outcome, 'INVALIDATED');
  assert.equal(Object.hasOwn(missingResult.result, 'status'), false);
  assert.equal(missingResult.result.evidenceValidation.violations.some((item) => item.code === 'EVIDENCE_BINDING_RECORD_MISSING'), true);

  const indexRun = createSealedRun(root, 'index-run');
  writeJson(path.join(indexRun.runDir, 'evidence-index.json'), {
    schemaVersion: 1,
    runId: 'another-run',
    entries: []
  });
  assert.throws(
    () => recordEvidenceObject({
      runDir: indexRun.runDir,
      runId: 'index-run',
      kind: 'probe',
      value: { ok: true }
    }),
    /CROSS_RUN/
  );
} finally {
  removeTree(root);
}

const reportPath = path.join(repositoryRoot, '.harness', 'docs', 'harness-v4-h2-evidence-chain-report.json');
const predecessorPath = path.join(repositoryRoot, '.harness', 'docs', 'harness-v4-h1-fail-closed-report.json');
assert.equal(fs.existsSync(reportPath), true, 'tracked H2 report is missing');
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
assert.equal(report.schemaVersion, 1);
assert.equal(report.milestone, 'H2');
assert.equal(report.contractVersion, 'harness-trust-v4.0.0');
assert.equal(report.predecessor.milestone, 'H1');
assert.equal(report.predecessor.reportDigest, sha256(predecessorPath));
assert.equal(report.predecessor.regressionStatus, 'PASS');
assert.equal(Object.values(report.acceptance).every((value) => value === true), true);
assert.deepEqual(report.hardFailures, []);
assert.equal(report.isolatedAcceptance.status, 'PASS');
assert.equal(report.isolatedAcceptance.networkUsed, false);
assert.equal(report.finalMarker, 'HARNESS_V4_H2_EVIDENCE_CHAIN: PASS');

const expectedHashPaths = [
  'harness/lib/manifest.mjs',
  'harness/lib/v4/canonical-json.mjs',
  'harness/lib/v4/evidence-store.mjs',
  'harness/lib/validator.mjs',
  'harness/tests/manifest.test.mjs',
  'harness/tests/v4-h2-evidence-chain.test.mjs'
].sort();
assert.deepEqual(Object.keys(report.sourceHashes).sort(), expectedHashPaths);
for (const relPath of expectedHashPaths) {
  assert.equal(report.sourceHashes[relPath], sha256(path.join(repositoryRoot, relPath)), `H2 source hash mismatch: ${relPath}`);
}
const successorPath = path.join(repositoryRoot, '.harness', 'docs', 'harness-v4-h3-git-candidate-report.json');
if (fs.existsSync(successorPath)) {
  const successor = JSON.parse(fs.readFileSync(successorPath, 'utf8'));
  assert.equal(successor.predecessor?.milestone, 'H2');
  assert.equal(successor.predecessor?.reportDigest, sha256(reportPath));
  assert.equal(successor.predecessor?.regressionStatus, 'PASS');
}

console.log('HARNESS_V4_H2_EVIDENCE_CHAIN: PASS');

function assertInvalidatedAfter(root, runId, mutate, expectedCode) {
  const fixture = createSealedRun(root, runId);
  mutate(fixture);
  const verification = verifyRunEvidenceBindings({
    root,
    runDir: fixture.runDir,
    manifest: fixture.manifest,
    validationPlan: JSON.parse(fs.readFileSync(path.join(fixture.runDir, 'validation-plan.json'), 'utf8')),
    impactReport: JSON.parse(fs.readFileSync(path.join(fixture.runDir, 'impact-report.json'), 'utf8'))
  });
  assert.equal(verification.valid, false);
  assert.equal(verification.violations.some((item) => item.code === expectedCode), true, `missing ${expectedCode}`);
  const result = validatePlan({
    root,
    planPath: path.join(fixture.runDir, 'validation-plan.json'),
    timeoutMs: 30000
  });
  assert.equal(Object.hasOwn(result.result, 'status'), false);
  assert.equal(result.result.outcome, 'INVALIDATED');
  assert.equal(result.result.results.length, 0);
}

function createSealedRun(root, runId) {
  fs.mkdirSync(path.join(root, 'harness', 'lib'), { recursive: true });
  const engineProbe = path.join(root, 'harness', 'lib', 'probe.mjs');
  if (!fs.existsSync(engineProbe)) fs.writeFileSync(engineProbe, 'export const stable = true;\n', 'utf8');
  const runDir = path.join(root, '.harness', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  const configPath = path.join(root, '.harness', 'harness.config.json');
  const authorityPath = path.join(root, '.harness', 'source-authority.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, '{"policy":"stable"}\n', 'utf8');
  fs.writeFileSync(authorityPath, '{"status":"ready"}\n', 'utf8');
  const impact = {
    baseRef: null,
    risk: { level: 'L1', score: 1 },
    riskSignals: [],
    writeTargets: ['candidate.js'],
    directTargets: ['candidate.js'],
    reverseDependents: [],
    impactedTests: [],
    requiredSynchronizations: []
  };
  const plan = {
    schemaVersion: 2,
    generatedAt: '2026-07-29T00:00:00.000Z',
    riskLevel: 'L1',
    packageManager: 'npm',
    requiredCheckCount: 1,
    commands: [{
      id: 'test',
      label: 'test',
      command: normalizeCommandContract(`${JSON.stringify(process.execPath)} -e "process.exit(0)"`),
      available: true,
      required: true,
      reason: 'H2 fixture.',
      candidates: []
    }],
    graph: {
      schemaVersion: 1,
      mode: 'tiered',
      tiers: [{ id: 'tier2-targeted', order: 2, label: 'Targeted' }],
      nodes: [{
        id: 'test',
        commandId: 'test',
        kind: 'command',
        tier: 'tier2-targeted',
        dependsOn: [],
        required: true
      }],
      policy: {}
    },
    impactedTests: [],
    requiredSynchronizations: [],
    notes: [],
    policy: {}
  };
  const config = {
    repoName: 'H2 fixture',
    configFile: configPath,
    policy: { planMaxAgeMinutes: 240 },
    sourceAuthority: {
      status: 'manifest-ready',
      manifestPath: authorityPath
    }
  };
  writeJson(path.join(runDir, 'impact-report.json'), impact);
  writeJson(path.join(runDir, 'validation-plan.json'), plan);
  const manifest = buildRunManifest({
    root,
    config,
    task: `H2 ${runId}`,
    runId,
    runDir,
    createdAt: '2026-07-29T00:00:00.000Z',
    impactReport: impact,
    validationPlan: plan,
    baselineSnapshot: [],
    artifacts: {
      impactReport: path.join(runDir, 'impact-report.json'),
      validationPlan: path.join(runDir, 'validation-plan.json')
    }
  });
  writeRunManifest({ runDir, manifest });
  return { runDir, manifest, impact, plan, configPath, authorityPath };
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sha256(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function removeTree(target) {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const entry of fs.readdirSync(target)) removeTree(path.join(target, entry));
    fs.rmdirSync(target);
  } else {
    fs.unlinkSync(target);
  }
  assert.equal(fs.existsSync(target), false, `cleanup did not remove ${target}`);
}
