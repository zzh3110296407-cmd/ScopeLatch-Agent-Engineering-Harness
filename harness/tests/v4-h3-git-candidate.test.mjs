import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildRunManifest, writeRunManifest } from '../lib/manifest.mjs';
import { validatePlan } from '../lib/validator.mjs';
import {
  GitObservationError,
  captureGitCandidateSnapshot,
  computeIndexTreeOid,
  verifyGitCandidateBaseline
} from '../lib/v4/git-candidate.mjs';
import { normalizeCommandContract } from '../lib/v4/safe-executor.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDir, '..', '..');

const notARepository = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v4-h3-not-git-'));
try {
  assert.throws(
    () => captureGitCandidateSnapshot(notARepository),
    (error) => error instanceof GitObservationError && error.code === 'GIT_REPOSITORY_UNAVAILABLE'
  );
} finally {
  fs.rmSync(notARepository, { recursive: true, force: true });
}

const root = makeGitRepository();
try {
  const initial = captureGitCandidateSnapshot(root);
  assert.equal(initial.schemaVersion, 1);
  assert.equal(initial.contractVersion, 'harness-git-candidate-v4.0.0');
  assert.match(initial.headCommitOid, /^[a-f0-9]{40,64}$/);
  assert.match(initial.headTreeOid, /^[a-f0-9]{40,64}$/);
  assert.match(initial.indexTreeOid, /^[a-f0-9]{40,64}$/);
  assert.equal(initial.indexTreeOid, gitOutput(root, ['write-tree']));
  assert.match(initial.snapshotDigest, /^sha256:[a-f0-9]{64}$/);

  fs.writeFileSync(path.join(root, 'candidate.txt'), 'index-b\n', 'utf8');
  git(root, ['add', 'candidate.txt']);
  fs.writeFileSync(path.join(root, 'candidate.txt'), 'worktree-c\n', 'utf8');
  const stagedB = captureGitCandidateSnapshot(root);
  assert.equal(stagedB.indexTreeOid, gitOutput(root, ['write-tree']));

  fs.writeFileSync(path.join(root, 'candidate.txt'), 'index-d\n', 'utf8');
  git(root, ['add', 'candidate.txt']);
  fs.writeFileSync(path.join(root, 'candidate.txt'), 'worktree-c\n', 'utf8');
  const stagedD = captureGitCandidateSnapshot(root);
  assert.equal(stagedD.indexTreeOid, gitOutput(root, ['write-tree']));
  assert.notEqual(stagedB.indexTreeOid, stagedD.indexTreeOid);
  assert.notEqual(stagedB.indexDigest, stagedD.indexDigest);
  assert.equal(stagedB.worktreeDigest, stagedD.worktreeDigest);

  git(root, ['reset', '--hard', 'HEAD']);
  const baseline = captureGitCandidateSnapshot(root);
  const baselineCheck = verifyGitCandidateBaseline({ root, baseline });
  assert.equal(baselineCheck.valid, true);
  assert.deepEqual(baselineCheck.violations, []);

  const tampered = { ...baseline, snapshotDigest: `sha256:${'0'.repeat(64)}` };
  const tamperedCheck = verifyGitCandidateBaseline({ root, baseline: tampered });
  assert.equal(tamperedCheck.valid, false);
  assert.equal(tamperedCheck.violations.some((item) => item.code === 'GIT_CANDIDATE_DIGEST_MISMATCH'), true);

  const run = createRun(root, 'head-drift');
  fs.writeFileSync(path.join(root, 'candidate.txt'), 'later-commit\n', 'utf8');
  git(root, ['add', 'candidate.txt']);
  git(root, ['commit', '-m', 'later']);
  const result = validatePlan({
    root,
    planPath: path.join(run.runDir, 'validation-plan.json'),
    timeoutMs: 30000
  });
  assert.equal(Object.hasOwn(result.result, 'status'), false);
  assert.equal(result.result.outcome, 'INVALIDATED');
  assert.equal(result.result.results.length, 0);
  assert.equal(
    result.result.candidateValidation.violations.some((item) => item.code === 'GIT_HEAD_COMMIT_DRIFT'),
    true
  );
  assert.equal(fs.existsSync(path.join(root, 'command-executed.txt')), false);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

assert.throws(
  () => computeIndexTreeOid([{
    path: 'candidate.txt',
    mode: '100644',
    objectId: 'a'.repeat(40),
    stage: 1
  }]),
  (error) => error instanceof GitObservationError && error.code === 'GIT_INDEX_UNMERGED'
);
const gitCandidateSource = fs.readFileSync(path.join(repositoryRoot, 'harness', 'lib', 'v4', 'git-candidate.mjs'), 'utf8');
assert.doesNotMatch(gitCandidateSource, /['"]write-tree['"]/);

const reportPath = path.join(repositoryRoot, '.harness', 'docs', 'harness-v4-h3-git-candidate-report.json');
const predecessorPath = path.join(repositoryRoot, '.harness', 'docs', 'harness-v4-h2-evidence-chain-report.json');
assert.equal(fs.existsSync(reportPath), true, 'tracked H3 report is missing');
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
assert.equal(report.schemaVersion, 1);
assert.equal(report.milestone, 'H3');
assert.equal(report.contractVersion, 'harness-trust-v4.0.0');
assert.equal(report.predecessor.milestone, 'H2');
assert.equal(report.predecessor.reportDigest, sha256(predecessorPath));
assert.equal(report.predecessor.regressionStatus, 'PASS');
assert.equal(Object.values(report.acceptance).every((value) => value === true), true);
assert.deepEqual(report.hardFailures, []);
assert.equal(report.isolatedAcceptance.status, 'PASS');
assert.equal(report.isolatedAcceptance.networkUsed, false);
assert.equal(report.finalMarker, 'HARNESS_V4_H3_GIT_CANDIDATE: PASS');

const expectedHashPaths = [
  'harness/tests/pr10-report-ci.test.mjs',
  'harness/tests/run-command.test.mjs',
  'harness/tests/v4-h0-contract-baseline.test.mjs',
  'harness/tests/v4-h1-fail-closed.test.mjs',
  'harness/tests/v4-trust-contract.red.mjs',
  'harness/lib/guard.mjs',
  'harness/lib/manifest.mjs',
  'harness/lib/v4/evidence-store.mjs',
  'harness/lib/v4/git-candidate.mjs',
  'harness/lib/validator.mjs',
  'harness/tests/guard-cache.test.mjs',
  'harness/tests/guard.test.mjs',
  'harness/tests/manifest.test.mjs',
  'harness/tests/v4-h2-evidence-chain.test.mjs',
  'harness/tests/v4-h3-git-candidate.test.mjs'
].sort();
assert.deepEqual(Object.keys(report.sourceHashes).sort(), expectedHashPaths);
for (const relPath of expectedHashPaths) {
  assert.equal(report.sourceHashes[relPath], sha256(path.join(repositoryRoot, relPath)), `H3 source hash mismatch: ${relPath}`);
}
const successorPath = path.join(repositoryRoot, '.harness', 'docs', 'harness-v4-h4-invariant-catalog-report.json');
if (fs.existsSync(successorPath)) {
  const successor = JSON.parse(fs.readFileSync(successorPath, 'utf8'));
  assert.equal(successor.predecessor?.milestone, 'H3');
  assert.equal(successor.predecessor?.reportDigest, sha256(reportPath));
  assert.equal(successor.predecessor?.regressionStatus, 'PASS');
}

console.log('HARNESS_V4_H3_GIT_CANDIDATE: PASS');

function createRun(root, runId) {
  const runDir = path.join(root, '.harness', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  const impact = {
    baseRef: null,
    risk: { level: 'L1', score: 1 },
    riskSignals: [],
    writeTargets: ['candidate.txt'],
    directTargets: ['candidate.txt'],
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
      command: normalizeCommandContract(`${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync('command-executed.txt','yes')"`),
      available: true,
      required: true,
      reason: 'H3 no-execution-on-drift fixture.',
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
  writeJson(path.join(runDir, 'impact-report.json'), impact);
  writeJson(path.join(runDir, 'validation-plan.json'), plan);
  const manifest = buildRunManifest({
    root,
    config: { repoName: 'H3 fixture', policy: { planMaxAgeMinutes: 240 } },
    task: 'H3 head drift',
    runId,
    runDir,
    createdAt: '2026-07-29T00:00:00.000Z',
    impactReport: impact,
    validationPlan: plan,
    baselineSnapshot: []
  });
  assert.equal(manifest.schemaVersion, 6);
  assert.match(manifest.gitCandidate.baseline.snapshotDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(
    manifest.evidence.sealedBinding.gitCandidateBaselineDigest,
    manifest.gitCandidate.baseline.snapshotDigest
  );
  writeRunManifest({ runDir, manifest });
  return { runDir, manifest };
}

function makeGitRepository() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v4-h3-git-'));
  fs.writeFileSync(path.join(repo, 'candidate.txt'), 'initial\n', 'utf8');
  fs.mkdirSync(path.join(repo, 'nested'));
  fs.writeFileSync(path.join(repo, 'nested', 'unicode-故事.txt'), 'nested\n', 'utf8');
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'harness@example.invalid']);
  git(repo, ['config', 'user.name', 'Harness Test']);
  git(repo, ['add', 'candidate.txt']);
  git(repo, ['commit', '-m', 'initial']);
  return repo;
}

function gitOutput(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sha256(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}
