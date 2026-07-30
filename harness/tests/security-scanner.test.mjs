import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { scanContentForSensitiveMaterial, scanRepositorySecurity, summarizePipAuditJson } from '../lib/security-scanner.mjs';

const credential = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4P5q6';
const findings = scanContentForSensitiveMaterial(`API_KEY="${credential}"\n`, { entropyThreshold: 4 });
assert.equal(findings.some((item) => item.ruleId === 'credential-assignment'), true);
assert.equal(findings.some((item) => item.ruleId === 'high-entropy-credential'), true);
assert.equal(JSON.stringify(findings).includes(credential), false);
const placeholderFindings = scanContentForSensitiveMaterial('sk-test-harness-placeholder-value\n');
assert.equal(placeholderFindings.length, 0);
assert.equal(summarizePipAuditJson({ dependencies: [{ name: 'safe', vulns: [] }], fixes: [] }), 0);
assert.equal(summarizePipAuditJson([{ name: 'affected', vulns: [{ id: 'CVE-test' }] }]), 1);
assert.equal(summarizePipAuditJson({ unexpected: [] }), null);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-security-'));
fs.writeFileSync(path.join(root, 'README.md'), '# Test\n', 'utf8');
fs.writeFileSync(path.join(root, 'config.txt'), `token=${credential}\n`, 'utf8');
fs.writeFileSync(path.join(root, 'verify_fixture.py'), `token=${credential}\n`, 'utf8');
const report = scanRepositorySecurity({
  root,
  config: {
    security: {
      maxFileBytesToScan: 100000,
      entropyThreshold: 4,
      entropyMinLength: 20,
      licenseFileNames: ['LICENSE']
    },
    context: { excludePathPatterns: [] },
    sourceAuthority: { root: null }
  },
  files: ['README.md', 'config.txt'],
  options: { releaseCheck: true, skipHistory: true, skipDependencyAudit: true }
});
assert.equal(report.status, 'failed');
assert.equal(report.findings.some((item) => item.id === 'current-tree-secret'), true);
assert.equal(report.findings.some((item) => item.id === 'release-license-missing'), true);
assert.equal(JSON.stringify(report).includes(credential), false);
const fixtureReport = scanRepositorySecurity({
  root,
  config: {
    security: { maxFileBytesToScan: 100000, entropyThreshold: 4, entropyMinLength: 20 },
    context: { excludePathPatterns: [] },
    sourceAuthority: { root: null }
  },
  files: ['verify_fixture.py'],
  options: { skipHistory: true, skipDependencyAudit: true }
});
assert.equal(fixtureReport.status, 'passed-with-warnings');
assert.equal(fixtureReport.findings.some((item) => item.id === 'test-fixture-credential' && item.severity === 'warning'), true);

fs.writeFileSync(path.join(root, 'private-notes.md'), 'Internal path: C:\\Users\\Developer\\private-repo\\notes.md\n', 'utf8');
const privateReport = scanRepositorySecurity({
  root,
  config: {
    security: {
      profile: 'private-development',
      maxFileBytesToScan: 100000,
      licenseFileNames: ['LICENSE']
    },
    context: { excludePathPatterns: [] },
    sourceAuthority: { root: null }
  },
  files: ['README.md', 'private-notes.md'],
  options: { skipHistory: true, skipDependencyAudit: true }
});
assert.equal(privateReport.status, 'passed-with-warnings');
assert.equal(privateReport.policy.profile, 'private-development');
assert.equal(privateReport.findings.some((item) => item.id === 'release-license-missing'), false);
assert.equal(privateReport.findings.some((item) => item.id === 'local-absolute-path' && item.severity === 'warning'), true);

assert.throws(
  () => scanRepositorySecurity({
    root,
    config: { security: {}, context: { excludePathPatterns: [] }, sourceAuthority: { root: null } },
    files: ['README.md'],
    options: { profile: 'unsupported-profile', skipHistory: true, skipDependencyAudit: true }
  }),
  /Unknown security profile/
);

const historyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-security-history-'));
git(historyRoot, ['init']);
git(historyRoot, ['config', 'user.email', 'harness@example.invalid']);
git(historyRoot, ['config', 'user.name', 'Harness Test']);
const historicalSecret = `sk-${'A'.repeat(32)}`;
fs.writeFileSync(path.join(historyRoot, 'old.env'), `API_KEY=${historicalSecret}\n`, 'utf8');
git(historyRoot, ['add', '.']);
git(historyRoot, ['commit', '-m', 'secret fixture']);
removeTree(path.join(historyRoot, 'old.env'));
fs.writeFileSync(path.join(historyRoot, 'README.md'), '# Clean tree\n', 'utf8');
git(historyRoot, ['add', '-A']);
git(historyRoot, ['commit', '-m', 'remove fixture']);
const historyReport = scanRepositorySecurity({
  root: historyRoot,
  config: {
    security: { historyMaxCommits: 10, historyCommitTimeoutMs: 10000 },
    context: { excludePathPatterns: [] },
    sourceAuthority: { root: null }
  },
  files: ['README.md'],
  options: { skipDependencyAudit: true }
});
assert.equal(historyReport.findings.some((item) => item.id === 'git-history-secret'), true);
assert.equal(historyReport.status, 'failed');
assert.equal(JSON.stringify(historyReport).includes(historicalSecret), false);

removeTree(root);
removeTree(historyRoot);
console.log('SECURITY_SCANNER_TEST_PASS');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
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
