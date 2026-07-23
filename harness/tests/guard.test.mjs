import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { changesSinceSnapshot, evaluateDiffGuard } from '../lib/guard.mjs';

const config = {
  changeBudget: {
    forbiddenDirs: ['secrets', '**/app/data']
  },
  riskRules: {
    buildSystemPatterns: ['package.json', 'package-lock.json', '.github/workflows/**']
  }
};

const baseImpactReport = {
  risk: { level: 'L3', score: 5 },
  riskSignals: [{ signal: 'public-api-change', source: 'path' }],
  writeTargets: [
    'src/api/story.js',
    'src/api/story-consumer.js',
    'tests/story.test.js'
  ],
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
  reverseDependents: ['src/api/story-consumer.js'],
  impactedTests: ['tests/story.test.js'],
  changedFiles: ['src/api/story.js'],
  requiredSynchronizations: [
    {
      domain: 'public-api',
      trigger: { files: ['src/api/story.js'] },
      validationChecks: ['generate-client', 'test-contract']
    }
  ]
};

const failed = evaluateDiffGuard({
  config,
  impactReport: baseImpactReport,
  changes: [
    { path: 'src/api/story.js', kind: 'modified' },
    { path: 'tests/story.test.js', kind: 'deleted' },
    { path: 'versions/Phase 8.5/Codes/app/data/local-project.json', kind: 'modified' },
    { path: 'package-lock.json', kind: 'modified' },
    { path: '.github/workflows/ci.yml', kind: 'modified' },
    { path: 'src/generated/client.generated.js', kind: 'modified' },
    { path: 'src/unrelated.js', kind: 'modified' }
  ]
});

assert.equal(failed.status, 'failed');
assert.deepEqual(failed.summary, {
  changedFileCount: 7,
  blockerCount: 5,
  warningCount: 1
});
assert.equal(failed.findings.some((finding) => finding.id === 'hard-change-budget-exceeded'), false);
assert.equal(failed.findings.some((finding) => finding.id === 'soft-change-budget-exceeded'), false);
assert.ok(failed.findings.some((finding) => finding.id === 'runtime-data-change' && finding.severity === 'blocker'));
assert.ok(failed.findings.some((finding) => finding.id === 'deleted-test' && finding.severity === 'blocker'));
assert.ok(failed.findings.some((finding) => finding.id === 'lockfile-change' && finding.severity === 'blocker'));
assert.ok(failed.findings.some((finding) => finding.id === 'ci-workflow-change' && finding.severity === 'blocker'));
assert.ok(failed.findings.some((finding) => finding.id === 'out-of-scope-change' && finding.severity === 'blocker'));
assert.ok(failed.findings.some((finding) => finding.id === 'generated-artifact-change' && finding.severity === 'warning'));

const apiDrift = evaluateDiffGuard({
  config,
  impactReport: baseImpactReport,
  changes: [
    { path: 'src/api/story.js', kind: 'modified' }
  ]
});

assert.equal(apiDrift.status, 'failed');
assert.ok(apiDrift.findings.some((finding) => finding.id === 'api-frontend-drift' && finding.severity === 'blocker'));

const approved = evaluateDiffGuard({
  config,
  impactReport: {
    ...baseImpactReport,
    writeTargets: [
      'src/api/story.js',
      'src/api/story-consumer.js',
      'tests/story.test.js',
      'versions/Phase 8.5/Codes/app/frontend/src/api/ordersApi.js',
      'package-lock.json',
      'harness/lib/guard.mjs'
    ],
    riskSignals: [
      { signal: 'public-api-change', source: 'path' },
      { signal: 'build-system-change', source: 'task' }
    ],
    requiredSynchronizations: [
      ...baseImpactReport.requiredSynchronizations,
      { domain: 'harness-control', trigger: { files: [] }, validationChecks: ['lint'] }
    ]
  },
  options: {
    allowLockfile: true,
    allowTestDeletion: true
  },
  changes: [
    { path: 'src/api/story.js', kind: 'modified' },
    { path: 'src/api/story-consumer.js', kind: 'modified' },
    { path: 'tests/story.test.js', kind: 'deleted' },
    { path: 'versions/Phase 8.5/Codes/app/frontend/src/api/ordersApi.js', kind: 'modified' },
    { path: 'package-lock.json', kind: 'modified' },
    { path: 'harness/lib/guard.mjs', kind: 'modified' }
  ]
});

assert.equal(approved.status, 'passed');
assert.equal(approved.summary.blockerCount, 0);
assert.equal(approved.findings.some((finding) => finding.severity === 'blocker'), false);

const quotedHarnessPath = evaluateDiffGuard({
  config,
  impactReport: {
    ...baseImpactReport,
    writeTargets: ['harness/lib/guard.mjs'],
    requiredSynchronizations: [
      { domain: 'harness-control', trigger: { files: [] }, validationChecks: ['lint'] }
    ]
  },
  changes: [
    { path: '"harness/lib/guard.mjs"', kind: 'modified' }
  ]
});

assert.equal(quotedHarnessPath.status, 'passed');
assert.equal(quotedHarnessPath.changes[0].path, 'harness/lib/guard.mjs');

const readContextIsNotWriteAuthority = evaluateDiffGuard({
  config,
  impactReport: {
    ...baseImpactReport,
    writeTargets: ['src/api/story.js'],
    directTargets: ['src/api/story.js', 'src/read-only-context.js'],
    reverseDependents: ['src/read-only-dependent.js'],
    impactedTests: ['tests/read-only-related.test.js'],
    requiredSynchronizations: [
      { domain: 'frontend', trigger: { files: [] }, validationChecks: ['build'] },
      { domain: 'harness-control', trigger: { files: [] }, validationChecks: ['lint'] }
    ]
  },
  changes: [
    { path: 'src/read-only-context.js', kind: 'modified' },
    { path: 'src/read-only-dependent.js', kind: 'modified' },
    { path: 'tests/read-only-related.test.js', kind: 'modified' },
    { path: 'versions/Phase 8.5/Codes/app/frontend/src/App.jsx', kind: 'modified' },
    { path: 'harness/lib/guard.mjs', kind: 'modified' }
  ]
});
assert.equal(readContextIsNotWriteAuthority.status, 'failed');
assert.deepEqual(
  readContextIsNotWriteAuthority.findings.find((finding) => finding.id === 'out-of-scope-change')?.files,
  [
    'src/read-only-context.js',
    'src/read-only-dependent.js',
    'tests/read-only-related.test.js',
    'versions/Phase 8.5/Codes/app/frontend/src/App.jsx',
    'harness/lib/guard.mjs'
  ]
);

const legacyRunCompatibility = evaluateDiffGuard({
  config,
  impactReport: {
    ...baseImpactReport,
    writeTargets: undefined,
    riskSignals: [],
    requiredSynchronizations: []
  },
  changes: [{ path: 'src/api/story.js', kind: 'modified' }]
});
assert.equal(legacyRunCompatibility.findings.some((finding) => finding.id === 'out-of-scope-change'), false);

const baselineDelta = changesSinceSnapshot(
  [
    { path: 'already-dirty.txt', kind: 'modified', hash: 'before' },
    { path: 'unchanged-dirty.txt', kind: 'modified', hash: 'same' }
  ],
  [
    { path: 'already-dirty.txt', kind: 'modified', hash: 'after' },
    { path: 'unchanged-dirty.txt', kind: 'modified', hash: 'same' },
    { path: 'new-change.txt', kind: 'untracked', hash: 'new' }
  ]
);
assert.deepEqual(baselineDelta.map((change) => change.path), ['already-dirty.txt', 'new-change.txt']);

const securityRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-guard-security-'));
const fakeSecret = ['sk', 'abcdefghijklmnopqrstuvwxyz123456'].join('-');
fs.writeFileSync(path.join(securityRoot, 'secret.js'), `const apiKey = "${fakeSecret}";\n`, 'utf8');
const localExamplePath = ['C:', 'Users', 'ExampleUser', 'private', 'project'].join('\\');
fs.writeFileSync(path.join(securityRoot, 'guide.md'), `Use ${localExamplePath} locally.\n`, 'utf8');
const securityImpact = {
  risk: { level: 'L1', score: 1 },
  riskSignals: [],
  writeTargets: ['secret.js', 'guide.md'],
  directTargets: ['secret.js', 'guide.md'],
  reverseDependents: [],
  impactedTests: [],
  changedFiles: [],
  requiredSynchronizations: []
};
const securityResult = evaluateDiffGuard({
  root: securityRoot,
  config: {
    changeBudget: { forbiddenDirs: [] },
    security: {
      scanSecrets: true,
      scanLocalAbsolutePaths: true,
      requireLicenseForRelease: true,
      maxFileBytesToScan: 100000,
      licenseFileNames: ['LICENSE']
    }
  },
  impactReport: securityImpact,
  changes: [
    { path: 'secret.js', kind: 'modified' },
    { path: 'guide.md', kind: 'modified' }
  ],
  options: { releaseCheck: true }
});
assert.equal(securityResult.status, 'failed');
assert.ok(securityResult.findings.some((finding) => finding.id === 'likely-secret-content' && finding.files[0] === 'secret.js'));
assert.ok(securityResult.findings.some((finding) => finding.id === 'local-absolute-path' && finding.severity === 'blocker'));
assert.ok(securityResult.findings.some((finding) => finding.id === 'release-license-missing'));
assert.equal(JSON.stringify(securityResult).includes('abcdefghijklmnopqrstuvwxyz123456'), false);
fs.rmSync(securityRoot, { recursive: true, force: true });

console.log('GUARD_TEST_PASS');
