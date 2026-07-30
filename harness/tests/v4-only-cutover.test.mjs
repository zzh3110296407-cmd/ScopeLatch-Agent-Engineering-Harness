import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizedCheckOutcome
} from '../lib/v4/outcome-engine.mjs';
import {
  validateFormalCutoverPolicy
} from '../auditor/lib/formal-cutover.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testDir, '..', '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const readJson = (relativePath) => JSON.parse(read(relativePath));
const exists = (relativePath) => fs.existsSync(path.join(root, relativePath));

const version = readJson('harness/version.json');
assert.equal(version.version, '4.0.0');

const removedActivePaths = [
  'harness/lib/v4/legacy-v3-adapter.mjs'
];
for (const relativePath of removedActivePaths) {
  assert.equal(exists(relativePath), false, `removed V3/shadow path is still active: ${relativePath}`);
}

const requiredV4OnlyPaths = [
  'harness/lib/v4/shadow-qualification.mjs',
  'harness/qualification/run-shadow-pair.mjs',
  'harness/contracts/v4/shadow-qualification-policy.json',
  '.github/workflows/harness-v4-shadow.yml'
];
for (const relativePath of requiredV4OnlyPaths) {
  assert.equal(exists(relativePath), true, `V4-only qualification path is missing: ${relativePath}`);
}

const statusOnly = normalizedCheckOutcome({
  id: 'status-only-v3-result',
  required: true,
  status: 'passed'
});
assert.equal(statusOnly.outcome, 'ERROR');
assert.equal(statusOnly.reasonCode, 'CHECK_OUTCOME_REQUIRED');

const skippedOnly = normalizedCheckOutcome({
  id: 'skipped-only-v3-result',
  required: true,
  status: 'passed-or-skipped'
});
assert.equal(skippedOnly.outcome, 'ERROR');
assert.equal(skippedOnly.reasonCode, 'CHECK_OUTCOME_REQUIRED');

const policy = readJson('harness/contracts/v4/formal-cutover-policy.json');
assert.equal(policy.contractVersion, 'harness-formal-cutover-v4.1.0');
assert.equal(Object.hasOwn(policy, 'legacyV3'), false);
assert.deepEqual(validateFormalCutoverPolicy(policy), []);
assert.equal(
  validateFormalCutoverPolicy({ ...policy, legacyV3: { formalEligible: false } })
    .some((item) => item.code === 'H9_POLICY_SHAPE_INVALID'),
  true
);

const qualificationPolicy = readJson('harness/contracts/v4/shadow-qualification-policy.json');
assert.equal(qualificationPolicy.policyId, 'harness-v4-h8-shadow-qualification');
assert.equal(qualificationPolicy.contractVersion, 'harness-shadow-qualification-v4.1.0');
assert.equal(qualificationPolicy.requiredObservationSchemaVersion, 2);
assert.equal(qualificationPolicy.requiredMode, 'shadow');

const hookSource = read('.codex/hooks/pre_tool_use_policy.py');
assert.doesNotMatch(hookSource, /passed-or-skipped/);

const activeSources = [
  'harness/auditor/lib/formal-cutover.mjs',
  'harness/contracts/v4/formal-cutover-policy.json',
  'harness/qualification/run-formal-ci.mjs',
  'harness/qualification/run-shadow-pair.mjs',
  'harness/lib/v4/shadow-qualification.mjs'
];
for (const relativePath of activeSources) {
  const source = read(relativePath);
  assert.doesNotMatch(source, /legacy[-_ ]?v3/i, `active V4 source contains a V3 branch: ${relativePath}`);
  assert.doesNotMatch(source, /legacyV3/, `active V4 source contains a V3 policy key: ${relativePath}`);
}

console.log('HARNESS_V4_ONLY_RUNTIME_CONTRACT: PASS');
