import assert from 'node:assert/strict';
import { assessEvidenceQuality, buildDetailedFailureSignature, renderRules } from '../lib/knowledge.mjs';

const base = {
  source: 'validation',
  failedChecks: [{
    id: 'test-integration',
    commandId: 'testIntegration',
    exitCode: 1,
    stderr: 'C:\\Users\\Alice\\repo\\api.py:42 timeout after 913ms at 2026-07-22T10:20:30.100Z',
    stdout: ''
  }],
  files: ['Project Codes/Phase 8.5/Codes/app/backend/api/story.py'],
  domains: ['public-api']
};

const sameRootCause = {
  ...base,
  failedChecks: [{ ...base.failedChecks[0], stderr: 'D:\\work\\repo\\api.py:98 timeout after 1220ms at 2027-01-01T00:00:00.000Z' }]
};
const differentRootCause = {
  ...base,
  failedChecks: [{ ...base.failedChecks[0], stderr: 'schema mismatch: missing supporting_role_ids' }]
};

const first = buildDetailedFailureSignature(base);
const second = buildDetailedFailureSignature(sameRootCause);
const third = buildDetailedFailureSignature(differentRootCause);
assert.equal(first.signature, second.signature);
assert.notEqual(first.signature, third.signature);
assert.deepEqual(first.features.domains, ['public-api']);
assert.equal(first.features.fileClusters.includes('project-codes/backend/api'), true);
assert.equal(first.features.errorSummaries[0].includes('Alice'), false);
assert.deepEqual(assessEvidenceQuality(first.features), {
  level: 'high',
  promotable: true,
  reasons: []
});

const broadEvidence = assessEvidenceQuality({
  source: 'guard',
  checks: [],
  findingIds: ['out-of-scope-change'],
  domains: Array.from({ length: 15 }, (_, index) => `domain-${index}`),
  fileClusters: Array.from({ length: 30 }, (_, index) => `cluster-${index}`),
  errorSummaries: []
});
assert.equal(broadEvidence.level, 'low');
assert.equal(broadEvidence.promotable, false);
assert.equal(broadEvidence.reasons.includes('scope-too-broad'), true);

const unattributedSideEffect = assessEvidenceQuality({
  source: 'guard',
  checks: [],
  findingIds: ['validation-side-effect'],
  domains: ['harness-control'],
  fileClusters: ['project-codes/backend/scripts'],
  errorSummaries: []
});
assert.equal(unattributedSideEffect.level, 'low');
assert.equal(unattributedSideEffect.promotable, false);
assert.equal(unattributedSideEffect.reasons.includes('unattributed-validation-side-effect'), true);

const emptyRules = renderRules([], { stable: true, reviews: [] });
assert.equal(emptyRules.endsWith('\n'), true);
assert.equal(emptyRules.endsWith('\n\n'), false);

console.log('KNOWLEDGE_SIGNATURE_TEST_PASS');
