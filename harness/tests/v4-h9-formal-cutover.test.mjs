import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateFormalDelivery,
  issueFormalCiAttestation,
  sealFormalAttestation,
  validateFormalAttestation,
  validateFormalCutoverPolicy
} from '../auditor/lib/formal-cutover.mjs';
import { digestCanonicalJson } from '../lib/v4/canonical-json.mjs';
import { runFormalCi } from '../qualification/run-formal-ci.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDir, '..', '..');
const policyPath = path.join(
  repositoryRoot,
  'harness',
  'contracts',
  'v4',
  'formal-cutover-policy.json'
);
const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
const formalRunnerPath = path.join(
  repositoryRoot,
  'harness',
  'qualification',
  'run-formal-ci.mjs'
);
const formalWorkflowPath = path.join(
  repositoryRoot,
  '.github',
  'workflows',
  'harness-v4-formal.yml'
);
const reportPath = path.join(
  repositoryRoot,
  '.harness',
  'docs',
  'harness-v4-h9-formal-cutover-report.json'
);
const enforcementObservationPath = path.join(
  repositoryRoot,
  '.harness',
  'docs',
  'harness-v4-h9-github-enforcement-observation.json'
);
const h8ReportPath = path.join(
  repositoryRoot,
  '.harness',
  'docs',
  'harness-v4-h8-ci-shadow-report.json'
);
const digest = (seed) => `sha256:${String(seed).padEnd(64, seed).slice(0, 64)}`;
const oid = (seed) => String(seed).repeat(40).slice(0, 40);
const now = '2026-07-30T00:30:00.000Z';

assert.deepEqual(validateFormalCutoverPolicy(policy), []);
assert.equal(policy.externalEnforcement.required, true);
assert.equal(policy.contractVersion, 'harness-formal-cutover-v4.1.0');
assert.equal(Object.hasOwn(policy, 'legacyV3'), false);

assert.equal(fs.existsSync(formalRunnerPath), true);
assert.equal(fs.existsSync(formalWorkflowPath), true);
const formalRunnerSource = fs.readFileSync(formalRunnerPath, 'utf8');
const formalWorkflowSource = fs.readFileSync(formalWorkflowPath, 'utf8');
assert.match(formalRunnerSource, /issueFormalCiAttestation/);
assert.match(formalRunnerSource, /evaluateFormalDelivery/);
assert.match(formalRunnerSource, /auditRun/);
assert.match(formalRunnerSource, /safeExecute/);
assert.match(formalRunnerSource, /evaluateShadowWindow/);
assert.match(formalRunnerSource, /H9_FORMAL_CI_PROVIDER_REQUIRED/);
assert.doesNotMatch(formalRunnerSource, /GITHUB_TOKEN|GH_TOKEN/);
assert.doesNotMatch(formalRunnerSource, /h8QualificationPath|--h8-qualification/);
assert.match(formalWorkflowSource, /runs-on:\s*windows-latest/);
assert.match(formalWorkflowSource, /name:\s*Harness v4 Formal Attestation/);
assert.match(formalWorkflowSource, /merge_group:/);
assert.match(formalWorkflowSource, /pull_request:/);
assert.doesNotMatch(formalWorkflowSource, /continue-on-error/);
assert.doesNotMatch(formalWorkflowSource, /workflow_dispatch:/);
assert.doesNotMatch(formalWorkflowSource, /uses:\s*[^@\r\n]+@v\d+/);
assert.match(formalWorkflowSource, /python-version:\s*"3\.12\.10"/);
assert.match(formalWorkflowSource, /--base-ref "\$env:HARNESS_FORMAL_BASE_REF"/);
assert.doesNotMatch(formalWorkflowSource, /--base-ref "\$\{\{/);
assert.equal(
  (formalWorkflowSource.match(/persist-credentials: false/g) || []).length,
  2,
  'Formal trusted and candidate checkouts must not retain GitHub credentials'
);
assert.match(formalWorkflowSource, /Checkout protected base authority/);
assert.match(formalWorkflowSource, /Download qualified H8 evidence/);
assert.match(formalWorkflowSource, /Verify required-check enforcement/);
assert.match(formalWorkflowSource, /if-no-files-found:\s*error/);

const providerFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'h9-provider-'));
try {
  const fixturePolicyDir = path.join(
    providerFixture,
    'harness',
    'contracts',
    'v4'
  );
  fs.mkdirSync(fixturePolicyDir, { recursive: true });
  fs.copyFileSync(
    policyPath,
    path.join(fixturePolicyDir, 'formal-cutover-policy.json')
  );
  const localAttempt = runFormalCi({
    root: repositoryRoot,
    trustedRoot: providerFixture,
    baseRef: 'unused',
    h8ObservationDirectory: 'unused',
    enforcementPath: 'unused',
    environment: {}
  });
  assert.equal(localAttempt.status, 'blocked');
  assert.equal(localAttempt.formalEligible, false);
  assert.deepEqual(localAttempt.reasonCodes, ['H9_FORMAL_CI_PROVIDER_REQUIRED']);
  const missingObservationAttempt = runFormalCi({
    root: repositoryRoot,
    trustedRoot: providerFixture,
    baseRef: 'unused',
    h8ObservationDirectory: path.join(providerFixture, 'missing-observations'),
    enforcementPath: path.join(providerFixture, 'missing-enforcement.json'),
    environment: {
      GITHUB_ACTIONS: 'true',
      GITHUB_REPOSITORY: policy.repository,
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_RUN_ID: '30500000001',
      GITHUB_RUN_ATTEMPT: '1'
    }
  });
  assert.equal(missingObservationAttempt.status, 'blocked');
  assert.equal(missingObservationAttempt.formalEligible, false);
  assert.deepEqual(
    missingObservationAttempt.reasonCodes,
    ['H9_H8_OBSERVATION_SET_UNAVAILABLE']
  );
} finally {
  removeTree(providerFixture);
}

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const enforcementObservation = JSON.parse(
  fs.readFileSync(enforcementObservationPath, 'utf8')
);
const h8Report = JSON.parse(fs.readFileSync(h8ReportPath, 'utf8'));
const requiredFormalAcceptance = [
  'absent_stale_invalid_attestation_rejected',
  'delivery_tree_equals_attested_tree',
  'external_enforcement_is_verified',
  'formal_attestation_is_auditor_only',
  'formal_ci_authority_is_closed',
  'formal_workflow_is_fail_closed',
  'h8_qualification_is_required',
  'report_is_observation_derived',
  'rollback_is_v4_fail_closed',
  'v4_only_runtime_is_installed'
];
assert.deepEqual(
  Object.keys(report.formalAcceptance).sort(),
  requiredFormalAcceptance
);
assert.equal(
  Object.values(report.implementationAcceptance).every((value) => value === true),
  true
);
assert.equal(report.implementationStatus, 'PASS');
assert.equal(
  report.h8Observation.qualifiedRunCount,
  h8Report.shadowWindow.observedQualifiedRuns
);
assert.equal(
  report.h8Observation.requiredRunCount,
  h8Report.shadowWindow.requiredRuns
);
assert.equal(
  report.h8Observation.observedWindowDays,
  h8Report.shadowWindow.observedWindowDays
);
assert.equal(
  report.h8Observation.requiredWindowDays,
  h8Report.shadowWindow.requiredWindowDays
);
assert.equal(
  report.h8Observation.requiredTrustRootChangeRunCount,
  h8Report.shadowWindow.requiredTrustRootChangeRuns
);
assert.equal(report.predecessor.reportDigest, fileDigest(h8ReportPath));
assert.equal(
  report.externalEnforcementObservation.digest,
  fileDigest(enforcementObservationPath)
);
assert.equal(enforcementObservation.repository, policy.repository);
assert.equal(enforcementObservation.branchProtection.httpStatus, null);
assert.equal(enforcementObservation.rulesets.httpStatus, null);
assert.equal(enforcementObservation.requiredCheck.installed, false);
assert.equal(enforcementObservation.formalActivationAllowed, false);
assert.equal(enforcementObservation.networkBoundary.otherNetworkUsed, false);
assert.equal(enforcementObservation.reasonCode, 'H9_EXTERNAL_ENFORCEMENT_NOT_OBSERVED');
assert.equal(report.sourceIntegrity.length > 0, true);
assert.equal(
  new Set(report.sourceIntegrity.map((source) => source.path)).size,
  report.sourceIntegrity.length
);
for (const source of report.sourceIntegrity) {
  assert.equal(source.digest, fileDigest(path.join(repositoryRoot, source.path)));
}
assert.deepEqual(report.isolatedCloseouts, []);
const expectedActivationBlockers = [];
if (!report.activationPrerequisites.externalEnforcementSatisfied) {
  expectedActivationBlockers.push('H9_EXTERNAL_ENFORCEMENT_REQUIRED');
}
if (!report.activationPrerequisites.acceptedFormalRunObserved) {
  expectedActivationBlockers.push('H9_FORMAL_CI_RUN_REQUIRED');
}
if (!report.activationPrerequisites.h8WindowSatisfied) {
  expectedActivationBlockers.push('H9_H8_QUALIFICATION_REQUIRED');
}
assert.deepEqual(
  [...report.activationBlockers].sort(),
  expectedActivationBlockers.sort()
);
const formalCutoverAccepted = Object.values(report.formalAcceptance)
  .every((value) => value === true)
  && Object.values(report.activationPrerequisites).every((value) => value === true);
assert.equal(formalCutoverAccepted, false);
assert.equal(report.formalCutoverStatus, 'BLOCKED');
assert.equal(report.finalMarker, 'HARNESS_V4_FORMAL_CUTOVER: BLOCKED');
assert.equal(report.longWindowExclusion.excludedFromThisCodeAcceptance, true);
assert.equal(report.longWindowExclusion.doesNotWaiveFormalActivation, true);

const h8Qualification = {
  schemaVersion: 1,
  contractVersion: 'harness-shadow-qualification-v4.1.0',
  policyId: 'harness-v4-h8-shadow-qualification',
  qualificationStatus: 'QUALIFIED',
  eligibleForH9: true,
  promotionAllowed: false,
  formalEligible: false,
  reasonCode: 'SHADOW_WINDOW_QUALIFIED',
  violations: [],
  metrics: {
    observedRunCount: 20,
    distinctRunCount: 20,
    windowDurationDays: 7,
    unexplainedDecisionDivergences: 0,
    businessProfileCoverage: 1,
    reproducibilityRate: 1,
    trustRootChangeRunCount: 1,
    p50DurationMs: 300000,
    p95DurationMs: 400000,
    totalDurationMs: 6000000,
    blockReasons: {}
  },
  drillResults: {
    rollback: { passed: true, evidenceId: 'rollback-observed' },
    'compromised-judge': { passed: true, evidenceId: 'judge-observed' }
  },
  observationSetDigest: digest('1')
};
const authority = {
  schemaVersion: 1,
  provider: 'github-actions',
  repository: policy.repository,
  workflowPath: policy.workflow.path,
  workflowRef: `${policy.repository}/${policy.workflow.path}@refs/heads/${policy.protectedBranch}`,
  jobName: policy.workflow.requiredCheckName,
  runId: '30500000000',
  runAttempt: 1,
  observedAt: '2026-07-30T00:00:00.000Z',
  eventName: 'merge_group',
  protectedBranch: policy.protectedBranch,
  baseCommitOid: oid('a'),
  candidateCommitOid: oid('b'),
  candidateTreeOid: oid('c'),
  engineDigest: digest('9')
};
const unsignedAttestation = {
  schemaVersion: 2,
  artifactType: 'FormalAttestation',
  contractVersion: policy.attestation.contractVersion,
  mode: 'formal-ci',
  runId: 'formal-run-1',
  outcome: 'FORMAL_PASS',
  repository: policy.repository,
  candidateCommitOid: authority.candidateCommitOid,
  candidateTreeOid: authority.candidateTreeOid,
  candidateSnapshotDigest: digest('3'),
  executorEngineDigest: digest('4'),
  policySnapshotDigest: digest('e'),
  formalCutoverPolicyDigest: digestCanonicalJson(policy),
  sourceAuthorityDigest: digest('5'),
  invariantCatalogDigest: digest('6'),
  executionPlanDigest: digest('7'),
  evidenceRootDigest: digest('8'),
  h8QualificationDigest: digestCanonicalJson(h8Qualification),
  requiredCheckCount: 8,
  requiredInvariantCount: 10,
  exceptionReferences: [],
  issuedAt: '2026-07-30T00:00:00.000Z',
  expiresAt: '2026-07-30T01:00:00.000Z',
  authority,
  authorityDigest: digestCanonicalJson(authority),
  auditor: {
    id: policy.auditor.id,
    version: '4.0.0-h9',
    engineDigest: digest('9')
  }
};
const attestation = sealFormalAttestation(unsignedAttestation);
assert.deepEqual(validateFormalAttestation(attestation, policy), []);
assert.match(attestation.attestationDigest, /^sha256:[a-f0-9]{64}$/);
assert.notEqual(attestation.policySnapshotDigest, attestation.formalCutoverPolicyDigest);

const localUnsignedAttestation = {
  schemaVersion: 1,
  artifactType: 'FormalAttestation',
  contractVersion: 'harness-attestation-v4.0.0',
  mode: 'formal-local',
  runId: 'formal-run-1',
  outcome: 'LOCAL_ATTESTED',
  candidateTreeOid: authority.candidateTreeOid,
  candidateSnapshotDigest: unsignedAttestation.candidateSnapshotDigest,
  executorEngineDigest: unsignedAttestation.executorEngineDigest,
  policySnapshotDigest: unsignedAttestation.policySnapshotDigest,
  sourceAuthorityDigest: unsignedAttestation.sourceAuthorityDigest,
  invariantCatalogDigest: unsignedAttestation.invariantCatalogDigest,
  executionPlanDigest: unsignedAttestation.executionPlanDigest,
  evidenceRootDigest: unsignedAttestation.evidenceRootDigest,
  requiredCheckCount: unsignedAttestation.requiredCheckCount,
  requiredInvariantCount: unsignedAttestation.requiredInvariantCount,
  exceptionReferences: [],
  auditor: {
    id: policy.auditor.id,
    version: '4.0.0-h5',
    engineDigest: unsignedAttestation.auditor.engineDigest
  }
};
const localAudit = {
  status: 'attested',
  outcome: 'LOCAL_ATTESTED',
  violations: [],
  executorVerdictIgnored: true,
  attestation: {
    ...localUnsignedAttestation,
    attestationDigest: digestCanonicalJson(localUnsignedAttestation)
  }
};
const issued = issueFormalCiAttestation({
  localAudit,
  policy,
  authority,
  h8Qualification,
  issuedAt: unsignedAttestation.issuedAt,
  expiresAt: unsignedAttestation.expiresAt
});
assert.equal(issued.status, 'attested');
assert.equal(issued.outcome, 'FORMAL_PASS');
assert.equal(issued.executorVerdictIgnored, true);
assert.deepEqual(issued.violations, []);
assert.deepEqual(validateFormalAttestation(issued.attestation, policy), []);
assert.equal(issued.attestation.policySnapshotDigest, localAudit.attestation.policySnapshotDigest);
assert.equal(issued.attestation.formalCutoverPolicyDigest, digestCanonicalJson(policy));

assertIssueRejected(
  { localAudit: { ...localAudit, outcome: 'BLOCKED' } },
  'H9_LOCAL_AUDIT_INVALID'
);
assertIssueRejected(
  {
    localAudit: {
      ...localAudit,
      attestation: { ...localAudit.attestation, attestationDigest: digest('f') }
    }
  },
  'H9_LOCAL_ATTESTATION_DIGEST_INVALID',
  'invalidated'
);
assertIssueRejected(
  {
    authority: { ...authority, candidateTreeOid: oid('d') }
  },
  'H9_LOCAL_AUTHORITY_TREE_MISMATCH',
  'invalidated'
);
assertIssueRejected(
  {
    h8Qualification: {
      ...h8Qualification,
      qualificationStatus: 'BLOCKED',
      eligibleForH9: false
    }
  },
  'H9_H8_QUALIFICATION_REQUIRED'
);

const delivery = {
  repository: policy.repository,
  branch: policy.protectedBranch,
  commitOid: authority.candidateCommitOid,
  treeOid: authority.candidateTreeOid
};
const enforcement = {
  schemaVersion: 1,
  provider: 'github',
  repository: policy.repository,
  protectedBranch: policy.protectedBranch,
  mode: 'ruleset',
  requiredCheckName: policy.workflow.requiredCheckName,
  installed: true,
  verifiedAt: '2026-07-30T00:20:00.000Z',
  evidenceDigest: digest('a')
};
const accepted = evaluateFormalDelivery({
  policy,
  attestation,
  delivery,
  h8Qualification,
  enforcement,
  now
});
assert.equal(accepted.status, 'accepted');
assert.equal(accepted.outcome, 'FORMAL_PASS');
assert.equal(accepted.formalEligible, true);
assert.deepEqual(accepted.reasonCodes, []);

assertBlocked({ attestation: null }, 'H9_ATTESTATION_REQUIRED');
assertBlocked({
  attestation: withDigest({ ...attestation, expiresAt: '2026-07-30T00:29:59.000Z' })
}, 'H9_ATTESTATION_STALE');
assertBlocked({
  attestation: withDigest({ ...attestation, issuedAt: '2026-07-30T00:40:00.000Z' })
}, 'H9_ATTESTATION_FROM_FUTURE');
assertInvalidated({
  attestation: { ...attestation, candidateTreeOid: oid('d') }
}, 'H9_ATTESTATION_DIGEST_INVALID');
assertInvalidated({
  delivery: { ...delivery, treeOid: oid('d') }
}, 'H9_DELIVERY_TREE_MISMATCH');
assertInvalidated({
  delivery: { ...delivery, commitOid: oid('d') }
}, 'H9_DELIVERY_COMMIT_MISMATCH');
assertBlocked({
  h8Qualification: {
    ...h8Qualification,
    qualificationStatus: 'BLOCKED',
    eligibleForH9: false,
    reasonCode: 'SHADOW_WINDOW_RUN_COUNT_INSUFFICIENT'
  }
}, 'H9_H8_QUALIFICATION_REQUIRED');
assertBlocked({
  enforcement: { ...enforcement, installed: false }
}, 'H9_EXTERNAL_ENFORCEMENT_REQUIRED');
assertBlocked({
  enforcement: null
}, 'H9_EXTERNAL_ENFORCEMENT_REQUIRED');
const rollback = evaluateFormalDelivery({
  policy,
  attestation,
  delivery,
  h8Qualification,
  enforcement,
  now,
  mode: 'provisional-only'
});
assert.equal(rollback.status, 'blocked');
assert.equal(rollback.formalEligible, false);
assert.equal(rollback.reasonCodes.includes('H9_PROVISIONAL_MODE_NO_FORMAL_DELIVERY'), true);

const policyWithUnknown = { ...policy, fabricatedWeakening: true };
assert.equal(
  validateFormalCutoverPolicy(policyWithUnknown)
    .some((item) => item.code === 'H9_POLICY_SHAPE_INVALID'),
  true
);
assert.throws(
  () => sealFormalAttestation({ ...unsignedAttestation, unknown: true }),
  (error) => error?.code === 'H9_ATTESTATION_SHAPE_INVALID'
);

console.log('HARNESS_V4_H9_FORMAL_CUTOVER_CORE: PASS');

function assertBlocked(overrides, code) {
  const result = evaluateFormalDelivery({
    policy,
    attestation,
    delivery,
    h8Qualification,
    enforcement,
    now,
    ...overrides
  });
  assert.equal(result.status, 'blocked', JSON.stringify(result));
  assert.equal(result.formalEligible, false);
  assert.equal(result.reasonCodes.includes(code), true, JSON.stringify(result));
}

function assertInvalidated(overrides, code) {
  const result = evaluateFormalDelivery({
    policy,
    attestation,
    delivery,
    h8Qualification,
    enforcement,
    now,
    ...overrides
  });
  assert.equal(result.status, 'invalidated', JSON.stringify(result));
  assert.equal(result.formalEligible, false);
  assert.equal(result.reasonCodes.includes(code), true, JSON.stringify(result));
}

function withDigest(value) {
  const unsigned = { ...value };
  delete unsigned.attestationDigest;
  return { ...unsigned, attestationDigest: digestCanonicalJson(unsigned) };
}

function assertIssueRejected(overrides, code, expectedStatus = 'blocked') {
  const result = issueFormalCiAttestation({
    localAudit,
    policy,
    authority,
    h8Qualification,
    issuedAt: unsignedAttestation.issuedAt,
    expiresAt: unsignedAttestation.expiresAt,
    ...overrides
  });
  assert.equal(result.status, expectedStatus, JSON.stringify(result));
  assert.equal(result.outcome, expectedStatus === 'invalidated' ? 'INVALIDATED' : 'BLOCKED');
  assert.equal(result.attestation, null);
  assert.equal(result.violations.some((item) => item.code === code), true, JSON.stringify(result));
}

function removeTree(target) {
  if (!fs.existsSync(target)) return;
  if (fs.statSync(target).isDirectory()) {
    for (const entry of fs.readdirSync(target)) removeTree(path.join(target, entry));
    fs.rmdirSync(target);
  } else {
    fs.unlinkSync(target);
  }
  assert.equal(fs.existsSync(target), false, `cleanup did not remove ${target}`);
}

function fileDigest(target) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')}`;
}
