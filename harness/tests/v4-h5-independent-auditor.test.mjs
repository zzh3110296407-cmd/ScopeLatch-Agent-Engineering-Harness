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
import { auditRun } from '../auditor/lib/auditor.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDir, '..', '..');
const auditorSource = fs.readFileSync(path.join(repositoryRoot, 'harness', 'auditor', 'lib', 'auditor.mjs'), 'utf8');
assert.doesNotMatch(auditorSource, /['"]write-tree['"]/);
const auditorCli = path.join(repositoryRoot, 'harness', 'auditor', 'cli.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v4-h5-'));

try {
  prepareRepository(root);
  const run = createValidatedRun(root, 'audit-pass');
  const audited = auditRun({ root, runDir: run.runDir, mode: 'formal-local' });
  assert.equal(audited.status, 'attested');
  assert.equal(audited.outcome, 'LOCAL_ATTESTED');
  assert.equal(audited.executorVerdictIgnored, true);
  assert.deepEqual(audited.violations, []);
  assert.equal(audited.attestation.artifactType, 'FormalAttestation');
  assert.match(audited.attestation.attestationDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(audited.attestation.auditor.engineDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(audited.attestation.candidateTreeOid, run.manifest.gitCandidate.baseline.indexTreeOid);

  const planPath = path.join(run.runDir, 'validation-plan.json');
  const originalPlan = fs.readFileSync(planPath);
  const legacyPlan = JSON.parse(originalPlan.toString('utf8'));
  legacyPlan.commands[0].command = 'node --version';
  writeJson(planPath, legacyPlan);
  const legacyCommand = auditRun({ root, runDir: run.runDir, mode: 'formal-local' });
  assert.equal(
    legacyCommand.violations.some((item) => item.code === 'AUDITOR_COMMAND_CONTRACT_INVALID'),
    true
  );
  fs.writeFileSync(planPath, originalPlan);

  const standaloneResultPath = path.join(run.runDir, 'validation-result.json');
  const standalone = readJson(standaloneResultPath);
  standalone.outcome = 'FORMAL_PASS';
  standalone.status = 'passed';
  writeJson(standaloneResultPath, standalone);
  const executorVerdictIgnored = auditRun({ root, runDir: run.runDir, mode: 'formal-local' });
  assert.equal(executorVerdictIgnored.outcome, 'LOCAL_ATTESTED');

  const manifestPath = path.join(run.runDir, 'run-manifest.json');
  const mutableManifest = readJson(manifestPath);
  mutableManifest.status = 'passed';
  mutableManifest.validation.resultOutcome = 'FORMAL_PASS';
  writeJson(manifestPath, mutableManifest);
  const mutableManifestIgnored = auditRun({ root, runDir: run.runDir, mode: 'formal-local' });
  assert.equal(mutableManifestIgnored.outcome, 'LOCAL_ATTESTED');

  const beforeCli = snapshotFiles(root);
  const cli = spawnSync(process.execPath, [
    auditorCli,
    'audit',
    '--root',
    root,
    '--run',
    path.relative(root, run.runDir),
    '--mode',
    'formal-local'
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 20 * 1024 * 1024
  });
  assert.equal(cli.status, 0, `${cli.stdout}\n${cli.stderr}`);
  const cliResult = JSON.parse(cli.stdout);
  assert.equal(cliResult.outcome, 'LOCAL_ATTESTED');
  assert.deepEqual(snapshotFiles(root), beforeCli, 'read-only auditor changed repository files');

  const index = readJson(path.join(run.runDir, 'evidence-index.json'));
  const validationEntry = index.entries.find((item) => item.kind === 'validation-result');
  const objectPath = path.join(run.runDir, validationEntry.path);
  const originalObject = fs.readFileSync(objectPath);
  const tamperedObject = JSON.parse(originalObject.toString('utf8'));
  tamperedObject.value.results[0].outcome = 'FAIL';
  writeJson(objectPath, tamperedObject);
  const tampered = auditRun({ root, runDir: run.runDir, mode: 'formal-local' });
  assert.equal(tampered.outcome, 'INVALIDATED');
  assert.equal(
    tampered.violations.some((item) => item.code === 'AUDITOR_EVIDENCE_OBJECT_DIGEST_MISMATCH'),
    true
  );
  fs.writeFileSync(objectPath, originalObject);

  const wrongMode = auditRun({ root, runDir: run.runDir, mode: 'formal-ci' });
  assert.equal(wrongMode.outcome, 'BLOCKED');
  assert.equal(wrongMode.attestation, null);

  for (const runtimeFile of [
    path.join(repositoryRoot, 'harness', 'cli.mjs'),
    ...walk(path.join(repositoryRoot, 'harness', 'lib')).filter((file) => file.endsWith('.mjs'))
  ]) {
    const content = fs.readFileSync(runtimeFile, 'utf8');
    assert.doesNotMatch(content, /\b(?:LOCAL_ATTESTED|FORMAL_PASS|FORMAL_EXCEPTION)\b/);
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

const reportPath = path.join(repositoryRoot, '.harness', 'docs', 'harness-v4-h5-independent-auditor-report.json');
const predecessorPath = path.join(repositoryRoot, '.harness', 'docs', 'harness-v4-h4-invariant-catalog-report.json');
assert.equal(fs.existsSync(reportPath), true, 'tracked H5 report is missing');
const report = readJson(reportPath);
assert.equal(report.schemaVersion, 1);
assert.equal(report.milestone, 'H5');
assert.equal(report.contractVersion, 'harness-trust-v4.0.0');
assert.equal(report.predecessor.milestone, 'H4');
assert.equal(report.predecessor.reportDigest, sha256(predecessorPath));
assert.equal(report.predecessor.regressionStatus, 'PASS');
assert.equal(report.isolatedAcceptance.status, 'PASS');
assert.equal(report.isolatedAcceptance.networkUsed, false);
assert.deepEqual(report.hardFailures, []);
assert.equal(report.finalMarker, 'HARNESS_V4_H5_INDEPENDENT_AUDITOR: PASS');

const expectedHashPaths = [
  'harness/auditor/cli.mjs',
  'harness/auditor/lib/auditor.mjs',
  'harness/tests/v4-h5-independent-auditor.test.mjs'
].sort();
assert.deepEqual(Object.keys(report.sourceHashes).sort(), expectedHashPaths);
for (const relPath of expectedHashPaths) {
  assert.equal(report.sourceHashes[relPath], sha256(path.join(repositoryRoot, relPath)), `H5 source hash mismatch: ${relPath}`);
}
const successorPath = path.join(repositoryRoot, '.harness', 'docs', 'harness-v4-h6-concurrent-atomic-state-report.json');
if (fs.existsSync(successorPath)) {
  const successor = readJson(successorPath);
  assert.equal(successor.predecessor?.milestone, 'H5');
  assert.equal(successor.predecessor?.reportDigest, sha256(reportPath));
  assert.equal(successor.predecessor?.regressionStatus, 'PASS');
}

console.log('HARNESS_V4_H5_INDEPENDENT_AUDITOR: PASS');

function prepareRepository(root) {
  copyPath(path.join(repositoryRoot, 'harness', 'cli.mjs'), path.join(root, 'harness', 'cli.mjs'));
  copyPath(path.join(repositoryRoot, 'harness', 'lib'), path.join(root, 'harness', 'lib'));
  copyPath(
    path.join(repositoryRoot, 'harness', 'contracts', 'v4', 'invariant-catalog.json'),
    path.join(root, 'harness', 'contracts', 'v4', 'invariant-catalog.json')
  );
  fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
  writeJson(path.join(root, '.harness', 'harness.config.json'), { policy: 'stable' });
  writeJson(path.join(root, '.harness', 'source-authority.json'), { status: 'ready' });
  fs.writeFileSync(path.join(root, '.gitignore'), '.harness/runs/\n.harness/state/\n.harness/cache/\n', 'utf8');
  fs.writeFileSync(path.join(root, 'candidate.txt'), 'candidate\n', 'utf8');
  git(root, ['init']);
  git(root, ['config', 'user.email', 'harness@example.invalid']);
  git(root, ['config', 'user.name', 'Harness Auditor Test']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'frozen candidate']);
}

function createValidatedRun(root, runId) {
  const runDir = path.join(root, '.harness', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  const impact = {
    risk: { level: 'L1', score: 1 },
    riskSignals: [],
    categories: emptyCategories(),
    changedFiles: [],
    impactedTests: [],
    requiredSynchronizations: [],
    escalationRequired: false
  };
  const pass = `${JSON.stringify(process.execPath)} -e "process.exit(0)"`;
  const config = {
    packageManager: 'npm',
    configFile: path.join(root, '.harness', 'harness.config.json'),
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
    changeBudget: { maxRepairRounds: 0 },
    policy: { planMaxAgeMinutes: 240 },
    sourceAuthority: {
      status: 'ready',
      manifestPath: path.join(root, '.harness', 'source-authority.json')
    }
  };
  const plan = planValidation({ root, config, impactReport: impact });
  writeJson(path.join(runDir, 'impact-report.json'), impact);
  writeJson(path.join(runDir, 'validation-plan.json'), plan);
  const manifest = buildRunManifest({
    root,
    config,
    task: 'H5 frozen candidate audit',
    runId,
    runDir,
    createdAt: '2026-07-29T00:00:00.000Z',
    impactReport: impact,
    validationPlan: plan,
    baselineSnapshot: []
  });
  writeRunManifest({ runDir, manifest });
  const validation = validatePlan({
    root,
    planPath: path.join(runDir, 'validation-plan.json'),
    timeoutMs: 30000
  });
  assert.equal(validation.result.outcome, 'PASS');
  assert.equal(Object.hasOwn(validation.result, 'status'), false);
  return { runDir, manifest, validation };
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

function snapshotFiles(root) {
  const entries = {};
  for (const file of walk(root).filter((item) => !item.includes(`${path.sep}.git${path.sep}`)).sort()) {
    entries[path.relative(root, file).replace(/\\/g, '/')] = sha256(file);
  }
  return entries;
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function copyPath(source, target) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    throw new Error(`H5 fixture copy rejects symbolic links: ${source}`);
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source).sort()) {
      copyPath(path.join(source, entry), path.join(target, entry));
    }
    return;
  }
  if (!stat.isFile()) {
    throw new Error(`H5 fixture copy rejects unsupported entries: ${source}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sha256(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}
