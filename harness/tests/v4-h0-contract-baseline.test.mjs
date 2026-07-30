import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testDir, '..', '..');
const catalogPath = path.join(root, 'harness', 'contracts', 'v4', 'h0-adversarial-catalog.json');
const reportPath = path.join(root, '.harness', 'docs', 'harness-v4-h0-baseline-report.json');
const contractPath = path.join(root, '.harness', 'docs', 'HARNESS_V4_TRUST_CONTRACT.md');
const migrationPath = path.join(root, '.harness', 'docs', 'harness-v4-migration-plan.md');
const redSuitePath = path.join(testDir, 'v4-trust-contract.red.mjs');
const gitAttributesPath = path.join(root, '.gitattributes');

for (const requiredFile of [catalogPath, reportPath, contractPath, migrationPath, redSuitePath, gitAttributesPath]) {
  assert.equal(fs.existsSync(requiredFile), true, `required H0 artifact missing: ${path.relative(root, requiredFile)}`);
}

const attributes = spawnSync('git', [
  'check-attr',
  'eol',
  '--',
  '.gitattributes',
  '.harness/docs/harness-v4-h0-baseline-report.json',
  'harness/tests/v4-h0-contract-baseline.test.mjs',
  '.github/workflows/harness-v4-shadow.yml'
], {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true,
  timeout: 30000
});
assert.equal(attributes.status, 0, `git attribute check failed: ${attributes.stderr || attributes.stdout}`);
for (const relPath of [
  '.gitattributes',
  '.harness/docs/harness-v4-h0-baseline-report.json',
  'harness/tests/v4-h0-contract-baseline.test.mjs',
  '.github/workflows/harness-v4-shadow.yml'
]) {
  assert.match(attributes.stdout, new RegExp(`${escapeRegExp(relPath)}: eol: lf`), `LF policy missing: ${relPath}`);
}

const catalog = readJson(catalogPath);
const report = readJson(reportPath);
const cases = catalog.cases || [];
const ids = cases.map((item) => item.id);
const executableIds = cases.filter((item) => item.executableInH0).map((item) => item.id).sort();

assert.equal(catalog.schemaVersion, 1);
assert.equal(catalog.contractVersion, 'harness-trust-v4.0.0');
assert.equal(cases.length, 20);
assert.equal(new Set(ids).size, ids.length, 'adversarial case IDs must be unique');
assert.ok(cases.every((item) => /^H[1-9]$/.test(item.milestone)));
assert.ok(cases.every((item) => ['PASS', 'FAIL', 'BLOCKED', 'INVALIDATED'].includes(item.expectedV4Outcome)));
assert.ok(executableIds.length >= 8);

const contract = fs.readFileSync(contractPath, 'utf8');
for (const decision of [
  'exact Git tree object ID',
  '`PROVISIONAL_PASS`',
  '`FORMAL_EXCEPTION`',
  'independent, read-only auditor'
]) {
  assert.match(contract, new RegExp(escapeRegExp(decision)));
}
assert.match(contract, /Zero applicable required checks \| `BLOCKED`/);
assert.match(contract, /`SKIPPED` and `passed-or-skipped` are legacy states/);

const migration = fs.readFileSync(migrationPath, 'utf8');
for (let milestone = 0; milestone <= 9; milestone += 1) {
  assert.match(migration, new RegExp(`H${milestone}\\s`), `migration plan missing H${milestone}`);
}

const run = spawnSync(process.execPath, [redSuitePath], {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true,
  timeout: 120000
});
const output = `${run.stdout || ''}\n${run.stderr || ''}`;
const observed = parseObserved(output);
assert.deepEqual([...observed.keys()].sort(), executableIds, 'red suite must observe every and only executable H0 catalog case');

const observedFailures = [...observed.entries()]
  .filter(([, status]) => status === 'FAIL')
  .map(([id]) => id)
  .sort();
const unknownFailures = observedFailures.filter((id) => !executableIds.includes(id));
assert.deepEqual(unknownFailures, []);

if (run.status === 0) {
  assert.match(output, /HARNESS_V4_TARGET_CONTRACT: PASS/);
  assert.deepEqual(observedFailures, []);
} else {
  assert.equal(run.status, 1, `red suite exited unexpectedly: ${run.status}\n${output}`);
  assert.match(output, /HARNESS_V4_TARGET_CONTRACT: FAIL/);
  assert.ok(observedFailures.length > 0, 'nonzero red suite must report at least one catalogued target failure');
}

assert.equal(report.schemaVersion, 1);
assert.equal(report.milestone, 'H0');
assert.equal(report.contractVersion, catalog.contractVersion);
assert.equal(report.catalogCaseCount, cases.length);
assert.deepEqual([...report.initialExecutableCaseIds].sort(), executableIds);
assert.deepEqual([...report.initialObservedFailingCaseIds].sort(), executableIds);
assert.equal(report.initialTargetContractStatus, 'FAIL');
assert.equal(report.h0BaselineStatus, 'PASS');
assert.deepEqual(report.hardFailures, []);
assert.equal(report.finalMarker, 'HARNESS_V4_H0_TRUST_CONTRACT_BASELINE: PASS');

const expectedTrackedPaths = [
  '.gitattributes',
  '.harness/docs/HARNESS_V4_TRUST_CONTRACT.md',
  '.harness/docs/harness-v4-migration-plan.md',
  'harness/contracts/v4/h0-adversarial-catalog.json',
  'harness/tests/v4-h0-contract-baseline.test.mjs',
  'harness/tests/v4-trust-contract.red.mjs'
].sort();
assert.deepEqual(Object.keys(report.sourceHashes).sort(), expectedTrackedPaths);
for (const relPath of expectedTrackedPaths) {
  assert.equal(report.sourceHashes[relPath], sha256(path.join(root, relPath)), `H0 source hash mismatch: ${relPath}`);
}
const successorReportPath = path.join(root, '.harness', 'docs', 'harness-v4-h1-fail-closed-report.json');
if (fs.existsSync(successorReportPath)) {
  const successor = readJson(successorReportPath);
  assert.equal(successor.predecessor?.milestone, 'H0');
  assert.equal(successor.predecessor?.reportDigest, sha256(reportPath));
  assert.equal(successor.predecessor?.regressionStatus, 'PASS');
}

console.log('HARNESS_V4_H0_TRUST_CONTRACT_BASELINE: PASS');

function parseObserved(output) {
  const observed = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = /^HARNESS_V4_RED_CASE ([a-z0-9-]+): (PASS|FAIL)(?:\s|$)/.exec(line);
    if (!match) continue;
    assert.equal(observed.has(match[1]), false, `duplicate red-suite observation: ${match[1]}`);
    observed.set(match[1], match[2]);
  }
  return observed;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
