import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { failureSignature } from '../lib/repair.mjs';
import { writePrReport } from '../lib/report.mjs';
import {
  backfillFailureKnowledge,
  loadApplicableRules,
  promoteRuleCandidate,
  recordFailureKnowledge
} from '../lib/knowledge.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const harnessRoot = path.resolve(testDir, '..');
const cliPath = path.join(harnessRoot, 'cli.mjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-pr10-'));
const runDir = path.join(root, '.harness', 'runs', 'report-run');
fs.mkdirSync(runDir, { recursive: true });
writeReportRun(root, runDir);

const report = writePrReport({ root, runDir });
assert.ok(fs.existsSync(report.reportPath));
assert.ok(fs.existsSync(report.metricsPath));

const reportText = fs.readFileSync(report.reportPath, 'utf8');
assert.match(reportText, /# Harness PR Report/);
assert.match(reportText, /Task/);
assert.match(reportText, /Risk/);
assert.match(reportText, /Changed Files/);
assert.match(reportText, /Validation/);
assert.match(reportText, /Repair Rounds/);
assert.match(reportText, /Remaining Risks/);
assert.match(reportText, /test-contract/);
assert.match(reportText, /Skipped because dependency failed/);

const metrics = JSON.parse(fs.readFileSync(report.metricsPath, 'utf8'));
assert.equal(metrics.taskType, 'public-api');
assert.equal(metrics.riskLevel, 'L4');
assert.equal(metrics.mustReadCount, 2);
assert.equal(metrics.changedFileCount, 2);
assert.equal(metrics.requiredValidationCount, 2);
assert.equal(metrics.unavailableValidationCount, 1);
assert.equal(metrics.firstPassValidationResult, 'failed');
assert.equal(metrics.repairRounds, 2);
assert.equal(metrics.finalStatus, 'failed');
assert.equal(metrics.outOfScopeModificationCount, 3);
assert.deepEqual(metrics.topFailureSignatures, [failureSignature(validationResultFixture())]);

const firstKnowledge = recordFailureKnowledge({ root, runDir });
assert.equal(firstKnowledge.count, 1);
const runtimeKnowledgeDir = path.join(root, '.harness', 'state', 'failure-knowledge');
assert.ok(fs.existsSync(path.join(runtimeKnowledgeDir, 'failures.jsonl')));
assert.equal(fs.existsSync(path.join(root, '.harness', 'knowledge', 'failures.jsonl')), false);

const duplicateKnowledge = recordFailureKnowledge({ root, runDir });
assert.equal(duplicateKnowledge.status, 'already-recorded');
assert.equal(duplicateKnowledge.count, 1);
const secondRunDir = cloneFailureRun(root, runDir, 'report-run-2');
const thirdRunDir = cloneFailureRun(root, runDir, 'report-run-3');
recordFailureKnowledge({ root, runDir: secondRunDir });
const thirdKnowledge = recordFailureKnowledge({ root, runDir: thirdRunDir });
assert.equal(thirdKnowledge.count, 3);
assert.ok(fs.existsSync(path.join(runtimeKnowledgeDir, 'rule-candidates.yaml')));
assert.equal(fs.existsSync(path.join(root, '.harness', 'rules.yaml')), false);
const candidateText = fs.readFileSync(path.join(runtimeKnowledgeDir, 'rule-candidates.yaml'), 'utf8');
const candidateId = candidateText.match(/id: "([^"]+)"/)?.[1];
assert.ok(candidateId);
const promotion = promoteRuleCandidate({
  root,
  candidateId,
  reviewer: 'Harness Test Reviewer',
  reason: 'Three matching failures with stable API contract evidence.'
});
assert.equal(promotion.status, 'promoted');
const stableRules = fs.readFileSync(path.join(root, '.harness', 'rules.yaml'), 'utf8');
assert.match(stableRules, /backend route\/schema/);
assert.match(stableRules, /stable-reviewed/);
assert.match(stableRules, /Harness Test Reviewer/);
const applicableRules = loadApplicableRules({
  root,
  impactReport: { requiredSynchronizations: [{ domain: 'public-api' }], riskSignals: [] }
});
assert.equal(applicableRules.some((rule) => rule.source === 'failure-knowledge'), true);
const backfill = backfillFailureKnowledge({ root });
assert.equal(backfill.scanned, 3);
assert.equal(backfill.recorded, 0);
assert.equal(backfill.existing, 3);

const readOnlyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-pr10-read-only-'));
const readOnlyRunDir = path.join(readOnlyRoot, '.harness', 'runs', 'read-only-run');
fs.mkdirSync(readOnlyRunDir, { recursive: true });
writeReportRun(readOnlyRoot, readOnlyRunDir);
const readOnlyKnowledge = recordFailureKnowledge({
  root: readOnlyRoot,
  runDir: readOnlyRunDir,
  mode: 'read-only'
});
assert.deepEqual(readOnlyKnowledge, {
  status: 'skipped',
  reason: 'knowledge-read-only',
  count: 0
});
assert.equal(fs.existsSync(path.join(readOnlyRoot, '.harness', 'state', 'failure-knowledge')), false);

const ciRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-pr10-ci-'));
writeCiProject(ciRoot);
const ci = spawnSync(process.execPath, [cliPath, 'ci', '--base', 'HEAD'], {
  cwd: ciRoot,
  encoding: 'utf8',
  timeout: 120000,
  maxBuffer: 20 * 1024 * 1024
});
assert.equal(ci.status, 0, `${ci.stdout}\n${ci.stderr}`);
assert.match(ci.stdout, /CI status: passed/);
assert.match(ci.stdout, /PR report:/);

const latest = JSON.parse(fs.readFileSync(path.join(ciRoot, '.harness', 'state', 'latest-run.json'), 'utf8'));
const ciManifest = JSON.parse(fs.readFileSync(latest.files.runManifest, 'utf8'));
assert.equal(ciManifest.status, 'passed');
assert.equal(ciManifest.phase, 'closeout-complete');
assert.ok(ciManifest.artifacts.prReport);
assert.ok(ciManifest.artifacts.metrics);

const dirtyCiRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-pr10-ci-dirty-'));
writeDirtyCiProject(dirtyCiRoot);
const dirtyCi = spawnSync(process.execPath, [cliPath, 'ci', '--base', 'HEAD'], {
  cwd: dirtyCiRoot,
  encoding: 'utf8',
  timeout: 120000,
  maxBuffer: 20 * 1024 * 1024
});
assert.equal(dirtyCi.status, 1, `${dirtyCi.stdout}\n${dirtyCi.stderr}`);
assert.match(dirtyCi.stdout, /Post-validation guard/);
assert.match(dirtyCi.stdout, /Validation outcome: BLOCKED/);
assert.match(dirtyCi.stdout, /CI status: blocked/);
assert.equal(fs.readFileSync(path.join(dirtyCiRoot, 'tracked.txt'), 'utf8'), 'clean\n');

removeTree(root);
removeTree(readOnlyRoot);
removeTree(ciRoot);
removeTree(dirtyCiRoot);

console.log('PR10_REPORT_CI_TEST_PASS');

function writeReportRun(projectRoot, targetRunDir) {
  fs.writeFileSync(path.join(targetRunDir, 'context-pack.json'), `${JSON.stringify({
    taskInfo: { primaryTerms: ['api'], domains: ['public-api'] },
    mustRead: ['src/api/story.py', 'src/client/story.ts']
  }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(targetRunDir, 'impact-report.json'), `${JSON.stringify({
    task: 'update public API',
    risk: { level: 'L4', score: 9 },
    changedFiles: ['src/api/story.py', 'src/client/story.ts'],
    directTargets: ['src/api/story.py'],
    reverseDependents: ['src/client/story.ts'],
    impactedTests: ['tests/test_story_api.py'],
    riskSignals: [{ signal: 'public-api-change', source: 'path' }],
    requiredSynchronizations: [
      {
        domain: 'public-api',
        title: 'API and client sync',
        validationChecks: ['generate-client', 'test-contract'],
        review: ['OpenAPI/schema shape'],
        trigger: { files: ['src/api/story.py'] }
      }
    ]
  }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(targetRunDir, 'validation-plan.json'), `${JSON.stringify({
    requiredCheckCount: 2,
    commands: [
      { id: 'lint', required: true, available: true, command: 'node -e "process.exit(1)"' },
      { id: 'test-contract', required: true, available: true, command: 'node -e "console.log(1)"' },
      { id: 'test-e2e', required: false, available: false, command: null }
    ]
  }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(targetRunDir, 'validation-result.json'), `${JSON.stringify(validationResultFixture(), null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(targetRunDir, 'guard-result.json'), `${JSON.stringify({
    status: 'failed',
    summary: { changedFileCount: 5, blockerCount: 1, warningCount: 0 },
    findings: [
      { id: 'out-of-scope-change', severity: 'blocker', files: ['a.js', 'b.js', 'c.js'] }
    ]
  }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(targetRunDir, 'repair-state.json'), `${JSON.stringify({
    schemaVersion: 1,
    status: 'failed',
    rounds: [
      { round: 1, status: 'failed' },
      { round: 2, status: 'blocked' }
    ]
  }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(targetRunDir, 'run-manifest.json'), `${JSON.stringify({
    schemaVersion: 2,
    runId: 'report-run',
    createdAt: '2026-07-06T00:00:00.000Z',
    updatedAt: '2026-07-06T00:01:00.000Z',
    status: 'failed',
    phase: 'validation-complete',
    task: { raw: 'update public API', intent: { primary: 'public-api' } },
    repo: { root: projectRoot, baseRef: 'origin/main' },
    risk: { level: 'L4', score: 9, signals: ['public-api-change'] },
    synchronizations: { requiredCount: 1, domains: ['public-api'] },
    validation: { resultStatus: 'failed', requiredCheckCount: 2 },
    artifacts: {
      contextPackJson: '.harness/runs/report-run/context-pack.json',
      impactReport: '.harness/runs/report-run/impact-report.json',
      validationPlan: '.harness/runs/report-run/validation-plan.json',
      validationResult: '.harness/runs/report-run/validation-result.json',
      guardResult: '.harness/runs/report-run/guard-result.json'
    }
  }, null, 2)}\n`, 'utf8');
}

function validationResultFixture() {
  return {
    generatedAt: '2026-07-06T00:01:00.000Z',
    status: 'failed',
    results: [
      {
        id: 'lint',
        commandId: 'lint',
        status: 'failed',
        required: true,
        exitCode: 1,
        stdout: 'lint failed',
        stderr: 'bad syntax'
      },
      {
        id: 'test-contract',
        commandId: 'test-contract',
        status: 'skipped',
        required: true,
        reason: 'Skipped because dependency failed: lint.'
      }
    ]
  };
}

function cloneFailureRun(projectRoot, sourceRunDir, name) {
  const target = path.join(projectRoot, '.harness', 'runs', name);
  copyTree(sourceRunDir, target);
  const manifestPath = path.join(target, 'run-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.runId = name;
  for (const [key, value] of Object.entries(manifest.artifacts || {})) {
    manifest.artifacts[key] = String(value).replace('report-run', name);
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return target;
}

function copyTree(source, target) {
  const stat = fs.lstatSync(source);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      copyTree(path.join(source, entry), path.join(target, entry));
    }
    return;
  }
  fs.copyFileSync(source, target);
}

function writeCiProject(projectRoot) {
  fs.mkdirSync(path.join(projectRoot, '.harness'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'README.md'), '# CI project\n', 'utf8');
  const pass = 'node -e "console.log(\'PASS\')"';
  fs.writeFileSync(path.join(projectRoot, '.harness', 'harness.config.json'), `${JSON.stringify({
    repoName: 'Harness CI Test',
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
    }
  }, null, 2)}\n`, 'utf8');
  copyInvariantCatalog(projectRoot);
  runGit(projectRoot, ['init']);
  runGit(projectRoot, ['config', 'user.email', 'harness@example.invalid']);
  runGit(projectRoot, ['config', 'user.name', 'Harness Test']);
  runGit(projectRoot, ['add', '.']);
  runGit(projectRoot, ['commit', '-m', 'initial']);
}

function writeDirtyCiProject(projectRoot) {
  fs.mkdirSync(path.join(projectRoot, '.harness'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'README.md'), '# Dirty CI project\n', 'utf8');
  fs.writeFileSync(path.join(projectRoot, 'tracked.txt'), 'clean\n', 'utf8');
  const pass = 'node -e "console.log(\'PASS\')"';
  const dirty = 'node -e "require(\'fs\').writeFileSync(\'tracked.txt\',\'dirty\\\\n\')"';
  fs.writeFileSync(path.join(projectRoot, '.harness', 'harness.config.json'), `${JSON.stringify({
    repoName: 'Harness Dirty CI Test',
    packageManager: 'npm',
    commands: {
      lint: dirty,
      typecheck: pass,
      testUnit: pass,
      testIntegration: pass,
      testContract: pass,
      testE2E: pass,
      build: pass,
      generateClient: pass,
      fullCI: pass
    }
  }, null, 2)}\n`, 'utf8');
  copyInvariantCatalog(projectRoot);

  runGit(projectRoot, ['init']);
  runGit(projectRoot, ['config', 'user.email', 'harness@example.invalid']);
  runGit(projectRoot, ['config', 'user.name', 'Harness Test']);
  runGit(projectRoot, ['add', '.']);
  runGit(projectRoot, ['commit', '-m', 'initial']);
}

function runGit(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
}

function copyInvariantCatalog(root) {
  const target = path.join(root, 'harness', 'contracts', 'v4', 'invariant-catalog.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(harnessRoot, 'contracts', 'v4', 'invariant-catalog.json'), target);
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
