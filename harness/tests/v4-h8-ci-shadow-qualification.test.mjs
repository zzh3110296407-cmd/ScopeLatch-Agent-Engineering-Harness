import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateShadowWindow,
  runQualificationDrills,
  sealShadowObservation,
  validatePolicy,
  validateShadowObservation
} from '../lib/v4/shadow-qualification.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDir, '..', '..');
const policyPath = path.join(repositoryRoot, 'harness', 'contracts', 'v4', 'shadow-qualification-policy.json');
const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));

assert.deepEqual(validatePolicy(policy), []);
assert.equal(policy.requiredObservationSchemaVersion, 2);
const drills = runQualificationDrills(policy);
assert.equal(drills.rollback.passed, true);
assert.equal(drills['compromised-judge'].passed, true);

const observations = Array.from({ length: policy.minRuns }, (_, index) => observation(index));
const qualified = evaluateShadowWindow({ policy, observations, drills });
assert.equal(qualified.qualificationStatus, 'QUALIFIED', JSON.stringify(qualified));
assert.equal(qualified.eligibleForH9, true);
assert.equal(qualified.promotionAllowed, false);
assert.equal(qualified.formalEligible, false);
assert.equal(qualified.metrics.observedRunCount, policy.minRuns);
assert.equal(qualified.metrics.distinctRunCount, policy.minRuns);
assert.ok(qualified.metrics.windowDurationDays >= policy.minWindowDays);
assert.equal(qualified.metrics.unexplainedDecisionDivergences, 0);
assert.equal(qualified.metrics.businessProfileCoverage, 1);
assert.equal(qualified.metrics.reproducibilityRate, 1);
assert.ok(qualified.metrics.p95DurationMs <= policy.maxP95DurationMs);
assert.equal(observations.every((item) => item.schemaVersion === 2), true);

const legacyObservation = withoutId(observations[0]);
legacyObservation.schemaVersion = 1;
delete legacyObservation.executionDiagnostics;
const sealedLegacyObservation = sealShadowObservation(legacyObservation);
assert.deepEqual(validateShadowObservation(sealedLegacyObservation), []);
assertBlocked(
  [sealedLegacyObservation, ...observations.slice(1)],
  drills,
  'SHADOW_OBSERVATION_VERSION_NOT_QUALIFIED'
);

const missingDiagnostics = withoutId(observations[0]);
delete missingDiagnostics.executionDiagnostics;
assert.throws(
  () => sealShadowObservation(missingDiagnostics),
  (error) => error?.code === 'SHADOW_OBSERVATION_SHAPE_INVALID'
);

const rawOutputLeak = withoutId(observations[0]);
rawOutputLeak.executionDiagnostics.baseline.stdout = 'unbounded output must never be sealed';
assert.throws(
  () => sealShadowObservation(rawOutputLeak),
  (error) => error?.code === 'SHADOW_EXECUTION_DIAGNOSTIC_INVALID'
);

const unsafeDiagnosticPath = withoutId(observations[0]);
unsafeDiagnosticPath.executionDiagnostics.baseline.changedPathCount = 1;
unsafeDiagnosticPath.executionDiagnostics.baseline.changedPaths = ['../outside'];
assert.throws(
  () => sealShadowObservation(unsafeDiagnosticPath),
  (error) => error?.code === 'SHADOW_EXECUTION_DIAGNOSTIC_PATH_INVALID'
);

const inconsistentDiagnostics = withoutId(observations[0]);
inconsistentDiagnostics.executionDiagnostics.baseline.outcome = 'FAIL';
inconsistentDiagnostics.executionDiagnostics.baseline.exitCode = 1;
inconsistentDiagnostics.executionDiagnostics.baseline.reasonCodes = ['SAFE_EXECUTOR_EXIT_NONZERO'];
assert.throws(
  () => sealShadowObservation(inconsistentDiagnostics),
  (error) => error?.code === 'SHADOW_EXECUTION_DIAGNOSTICS_INCONSISTENT'
);

assertBlocked(observations.slice(0, policy.minRuns - 1), drills, 'SHADOW_WINDOW_RUN_COUNT_INSUFFICIENT');
assertBlocked(
  observations.map((item) => mutate(item, (value) => { value.observedAt = '2026-07-01T00:00:00.000Z'; })),
  drills,
  'SHADOW_WINDOW_DURATION_INSUFFICIENT'
);
assertBlocked(
  replaceAt(observations, 4, (value) => {
    value.comparison = { divergence: true, explained: false, explanationCode: null };
  }),
  drills,
  'SHADOW_DECISION_DIVERGENCE_UNEXPLAINED'
);
const explained = evaluateShadowWindow({
  policy,
  observations: replaceAt(observations, 4, (value) => {
    value.comparison = { divergence: true, explained: true, explanationCode: 'DOCUMENTED_LEGACY_POLICY_DIFFERENCE' };
  }),
  drills
});
assert.equal(explained.qualificationStatus, 'QUALIFIED', JSON.stringify(explained));
assertBlocked(
  replaceAt(observations, 5, (value) => { value.businessProfile.executedProfileIds = []; }),
  drills,
  'SHADOW_BUSINESS_PROFILE_COVERAGE_INCOMPLETE'
);
assertBlocked(
  replaceAt(observations, 6, (value) => { value.reproducibility.cachedDecisionDigest = digest('different'); }),
  drills,
  'SHADOW_REPRODUCIBILITY_MISMATCH'
);
assertBlocked(
  replaceAt(observations, 0, (value) => {
    value.trustRoot.adversarialCorpusPassed = false;
    value.executionDiagnostics.adversarialCorpus.passed = false;
    value.executionDiagnostics.adversarialCorpus.reasonCodes = ['H8_TRUSTED_CORPUS_CASE_FAILED'];
  }),
  drills,
  'SHADOW_TRUST_ROOT_ADVERSARIAL_CORPUS_REQUIRED'
);
assertBlocked(
  replaceAt(observations, 7, (value) => {
    value.judge.source = 'candidate';
    value.judge.candidateControlled = true;
  }),
  drills,
  'SHADOW_JUDGE_NOT_INDEPENDENT'
);
assertBlocked(
  replaceAt(observations, 7, (value) => {
    value.judge.baseCommitOid = value.candidate.commitOid;
  }),
  drills,
  'SHADOW_JUDGE_CANDIDATE_COMMIT_ALIAS'
);
assertBlocked(
  replaceAt(observations, 7, (value) => {
    value.audit = {
      accepted: false,
      attestationDigest: null,
      violationCodes: ['AUDITOR_PLAN_DIGEST_MISMATCH']
    };
    value.v4.outcome = 'BLOCKED';
    value.executionDiagnostics.cold.aggregateOutcome = 'BLOCKED';
    value.executionDiagnostics.cold.auditStatus = 'NOT_ATTESTED';
    value.executionDiagnostics.cold.auditViolationCodes = ['AUDITOR_PLAN_DIGEST_MISMATCH'];
    value.executionDiagnostics.cold.reasonCodes = [
      'H8_AUDIT_OUTCOME_BLOCKED',
      'H8_AUDIT_VIOLATION_AUDITOR_PLAN_DIGEST_MISMATCH',
      'H8_V4_AGGREGATE_BLOCKED'
    ];
  }),
  drills,
  'SHADOW_AUDIT_NOT_ATTESTED'
);
assertBlocked(
  replaceAt(observations, 7, (value) => {
    value.v4.outcome = 'FAIL';
    value.executionDiagnostics.cold.aggregateOutcome = 'FAIL';
    value.executionDiagnostics.cold.reasonCodes = ['H8_V4_AGGREGATE_FAIL'];
  }),
  drills,
  'SHADOW_V4_OUTCOME_NOT_PASS'
);
assertBlocked(
  replaceAt(observations, 7, (value) => {
    value.businessProfile.requiredProfileIds = [];
    value.businessProfile.executedProfileIds = [];
  }),
  drills,
  'SHADOW_BUSINESS_PROFILE_COVERAGE_INCOMPLETE'
);
assertBlocked(
  replaceAt(observations, 8, (value) => { value.provider = 'local'; }),
  drills,
  'SHADOW_PROVIDER_NOT_QUALIFIED'
);
assertBlocked(
  observations,
  { ...drills, rollback: { passed: false, evidenceId: 'rollback-failed' } },
  'SHADOW_DRILL_NOT_PASSED'
);
assertBlocked(
  [observations[0], observations[0], ...observations.slice(2)],
  drills,
  'SHADOW_RUN_IDENTITY_DUPLICATE'
);

const tampered = structuredClone(observations[0]);
tampered.cost.durationMs += 1;
assert.equal(
  validateShadowObservation(tampered).some((item) => item.code === 'SHADOW_OBSERVATION_DIGEST_MISMATCH'),
  true
);
assert.equal(
  validatePolicy({ ...policy, fabricated: true }).some((item) => item.code === 'SHADOW_POLICY_SHAPE_INVALID'),
  true
);
assert.throws(
  () => sealShadowObservation({ ...withoutId(observations[0]), fabricated: true }),
  (error) => error?.code === 'SHADOW_OBSERVATION_SHAPE_INVALID'
);

const workflow = fs.readFileSync(path.join(repositoryRoot, '.github', 'workflows', 'harness-v4-shadow.yml'), 'utf8');
assert.match(workflow, /name: Harness v4 Shadow/);
assert.match(workflow, /pull_request:/);
assert.match(workflow, /push:/);
assert.match(workflow, /workflow_dispatch:/);
assert.match(workflow, /permissions:\s*\r?\n\s*contents: read/);
assert.match(workflow, /continue-on-error: true/);
assert.match(workflow, /Checkout protected base judge/);
assert.match(workflow, /path: trusted-engine/);
assert.match(workflow, /path: candidate/);
assert.match(workflow, /trusted-engine\/harness\/qualification\/run-shadow-pair\.mjs/);
assert.match(workflow, /--trusted-root trusted-engine/);
assert.match(workflow, /github\.event\.before != '0000000000000000000000000000000000000000'/);
assert.match(workflow, /github\.event\.repository\.default_branch/);
assert.match(workflow, /--base-ref "\$env:HARNESS_SHADOW_BASE_REF"/);
assert.doesNotMatch(workflow, /--base-ref "\$\{\{/);
assert.match(workflow, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/);
assert.match(workflow, /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/);
assert.match(workflow, /actions\/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97/);
assert.match(workflow, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/);
assert.match(workflow, /python-version:\s*"3\.12\.10"/);
assert.equal(
  (workflow.match(/persist-credentials: false/g) || []).length,
  2,
  'Trusted and candidate checkouts must not retain GitHub credentials'
);
assert.doesNotMatch(workflow, /Project Codes|app\/frontend|app\/backend/);
assert.doesNotMatch(workflow, /npm\s+(?:ci|install)|pip\s+install/);
assert.match(workflow, /Promotion remains disabled/);
assert.doesNotMatch(workflow, /pull_request_target/);
assert.doesNotMatch(workflow, /contents:\s*write|id-token:\s*write|secrets\./);

const runner = fs.readFileSync(path.join(repositoryRoot, 'harness', 'qualification', 'run-shadow-pair.mjs'), 'utf8');
const safeExecutor = fs.readFileSync(path.join(repositoryRoot, 'harness', 'lib', 'v4', 'safe-executor.mjs'), 'utf8');
const validationRunner = fs.readFileSync(path.join(repositoryRoot, 'harness', 'validators', 'run.mjs'), 'utf8');
const gitAttributes = fs.readFileSync(path.join(repositoryRoot, '.gitattributes'), 'utf8');
assert.match(runner, /safeExecute/);
assert.match(gitAttributes, /^\* text=auto eol=lf$/m);
assert.match(gitAttributes, /^\*\.png binary$/m);
assert.match(runner, /network:\s*\{\s*mode: 'deny'/);
assert.match(safeExecutor, /\['safe\.directory', null\]/);
assert.match(safeExecutor, /core\.autocrlf/);
assert.match(safeExecutor, /PYTHONUTF8/);
assert.match(safeExecutor, /GIT_CONFIG_KEY_\$\{index\}/);
assert.match(safeExecutor, /value === null \? root : value/);
assert.match(safeExecutor, /env\.GIT_CONFIG_GLOBAL = emptyGitConfigPath/);
assert.match(safeExecutor, /env\.GIT_CONFIG_NOSYSTEM = '1'/);
assert.doesNotMatch(runner, /GIT_CONFIG_KEY_0|GIT_CONFIG_VALUE_0/);
assert.match(runner, /HARNESS_OBSERVATION_MODE/);
assert.match(runner, /H8_RUNTIME_WRITABLE_PATHS/);
assert.doesNotMatch(runner, /executeV4Ci\(root, baseRef\)[\s\S]*\['\.harness'\]/);
assert.match(runner, /formalEligible: false/);
assert.match(runner, /promotionAllowed: false/);
assert.match(runner, /engineDigest\(trustedRoot\)/);
assert.match(runner, /import \{ auditRun \} from '\.\.\/auditor\/lib\/auditor\.mjs'/);
assert.match(runner, /auditRun\(\{ root: candidateRoot, runDir, mode: 'formal-local' \}\)/);
assert.match(runner, /audited\.outcome === 'LOCAL_ATTESTED' && executorOutcome === 'PASS'/);
assert.match(runner, /executeTrustedAdversarialCorpus\(trustedRoot, root\)/);
assert.match(runner, /executionDiagnostics/);
assert.match(runner, /summarizeSafeExecution/);
assert.match(runner, /extractSafeFailureMarkers/);
assert.match(runner, /validationResultReasonCodes/);
assert.match(runner, /H8_VALIDATION_RESULT_/);
assert.match(runner, /H8_VALIDATION_SUMMARY_/);
assert.match(runner, /HARNESS_TEST_FAILED:/);
assert.match(runner, /PYTHON_UNITTEST_/);
assert.match(runner, /VALIDATION_MARKER_/);
assert.match(runner, /PROCESS_EXCEPTION_CLASS:/);
assert.match(runner, /ERROR\|FAIL/);
assert.match(runner, /SAFE_EXECUTOR_BOUNDARY_VIOLATION/);
assert.match(validationRunner, /HARNESS_VALIDATION_STEP_FAILED_\$\{capabilityToken\}_\$\{step\.index\}/);
assert.match(validationRunner, /step\.outcome !== 'PASS'/);
assert.doesNotMatch(validationRunner, /HARNESS_VALIDATION_STEP_FAILED_\$\{[^}]*error|JSON\.stringify\(step\)/);
assert.match(runner, /fileDigest\(candidateFile\) !== fileDigest\(trustedFile\)/);
assert.match(runner, /\/\^v4-\.\*\\\.test\\\.mjs\$\//);
assert.match(runner, /value === '\.gitattributes'/);
assert.doesNotMatch(runner, /shell:\s*true/);

const reportPath = path.join(repositoryRoot, '.harness', 'docs', 'harness-v4-h8-ci-shadow-report.json');
const predecessorPath = path.join(repositoryRoot, '.harness', 'docs', 'harness-v4-h7-safe-executor-report.json');
assert.equal(fs.existsSync(reportPath), true, 'tracked H8 status report is missing');
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
assert.equal(report.schemaVersion, 1);
assert.equal(report.milestone, 'H8');
assert.equal(report.predecessor.milestone, 'H7');
assert.equal(report.predecessor.reportDigest, sha256File(predecessorPath));
assert.equal(report.infrastructureAcceptance.status, 'PASS');
assert.equal(report.infrastructureAcceptance.boundedRemoteExecutionDiagnosticsEnforced, true);
assert.equal(report.infrastructureAcceptance.boundedValidationCommandDiagnosticsEnforced, true);
assert.equal(report.infrastructureAcceptance.boundedTestFailureClassificationsEnforced, true);
assert.equal(report.infrastructureAcceptance.canonicalTrackedTextHashingEnforced, true);
assert.equal(report.infrastructureAcceptance.executorOwnedGitRepositoryConfigurationEnforced, true);
assert.equal(report.infrastructureAcceptance.legacyV1ObservationsReadableButNotQualifying, true);
assert.equal(report.infrastructureAcceptance.repositorySpecificApplicationDependenciesRequired, false);
assert.equal(report.shadowWindow.status, 'BLOCKED_PENDING_CI_WINDOW');
assert.equal(report.shadowWindow.observedQualifiedRuns, 0);
assert.equal(report.shadowWindow.observedWindowDays, 0);
assert.equal(report.shadowWindow.unexplainedDecisionDivergences, 0);
assert.equal(report.shadowWindow.businessProfileCoverage, 0);
assert.equal(report.shadowWindow.reproducibilityRate, 0);
assert.equal(report.shadowWindow.p95DurationMs, null);
assert.equal(report.shadowWindow.requiredRuns, policy.minRuns);
assert.equal(report.shadowWindow.requiredWindowDays, policy.minWindowDays);
assert.equal(report.formalEligible, false);
assert.equal(report.eligibleForH9, false);
assert.equal(report.actionObservationBatch.status, 'NOT_STARTED_FOR_THIS_REPOSITORY');
assert.equal(report.actionObservationBatch.requestedAttemptCount, 0);
assert.equal(report.actionObservationBatch.completedAttemptCount, 0);
assert.equal(report.actionObservationBatch.qualifiedRunCount, 0);
assert.deepEqual(report.actionObservationBatch.attempts, []);
assert.deepEqual(report.hardFailures, ['H8_SHADOW_WINDOW_NOT_OBSERVED']);
assert.equal(report.finalMarker, 'HARNESS_V4_H8_CI_SHADOW: BLOCKED_PENDING_CI_WINDOW');

const expectedHashPaths = [
  '.gitattributes',
  '.github/workflows/harness-v4-shadow.yml',
  '.harness/docs/harness-v4-h8-operations-runbook.md',
  'harness/contracts/v4/shadow-qualification-policy.json',
  'harness/lib/v4/shadow-qualification.mjs',
  'harness/qualification/qualify-shadow-window.mjs',
  'harness/qualification/run-shadow-pair.mjs',
  'harness/tests/v4-h8-ci-shadow-qualification.test.mjs',
  'harness/validators/run.mjs'
].sort();
assert.deepEqual(Object.keys(report.sourceHashes).sort(), expectedHashPaths);
for (const relPath of expectedHashPaths) {
  assert.equal(
    report.sourceHashes[relPath],
    sha256TrackedTextFile(path.join(repositoryRoot, relPath)),
    `H8 canonical tracked-text source hash mismatch: ${relPath}`
  );
}

console.log('HARNESS_V4_H8_QUALIFICATION_INFRASTRUCTURE: PASS');

function observation(index) {
  const timestamp = new Date(Date.parse('2026-07-01T00:00:00.000Z') + (index * 8 * 86_400_000 / (policy.minRuns - 1))).toISOString();
  const planDigest = digest('stable-plan');
  const decisionDigest = digest('stable-decision');
  return sealShadowObservation({
    schemaVersion: 2,
    provider: 'github-actions',
    mode: 'shadow',
    runId: `github-run-${index + 1}`,
    runAttempt: 1,
    observedAt: timestamp,
    candidate: {
      commitOid: `${(index + 1).toString(16).padStart(40, '0')}`,
      treeOid: `${(index + 101).toString(16).padStart(40, '0')}`
    },
    judge: {
      source: 'protected-base',
      candidateControlled: false,
      engineDigest: digest('trusted-engine'),
      candidateEngineDigest: digest(index === 0 ? 'candidate-engine-change' : 'trusted-engine'),
      baseCommitOid: 'f'.repeat(40),
      workflowRef: 'owner/repo/.github/workflows/harness-v4-shadow.yml@refs/heads/main'
    },
    audit: {
      accepted: true,
      attestationDigest: digest(`attestation-${index}`),
      violationCodes: []
    },
    baseline: decision('PASS', planDigest, decisionDigest),
    v4: decision('PASS', planDigest, decisionDigest),
    comparison: {
      divergence: false,
      explained: false,
      explanationCode: null
    },
    reproducibility: {
      coldDecisionDigest: decisionDigest,
      cachedDecisionDigest: decisionDigest,
      coldPlanDigest: planDigest,
      cachedPlanDigest: planDigest
    },
    trustRoot: {
      changed: index === 0,
      adversarialCorpusRequired: index === 0,
      adversarialCorpusPassed: true,
      adversarialCaseCount: index === 0 ? 9 : 0
    },
    businessProfile: {
      changed: true,
      requiredProfileIds: ['lint', 'test-unit'],
      executedProfileIds: ['lint', 'test-unit']
    },
    executionDiagnostics: executionDiagnostics(index === 0 ? 9 : 0),
    cost: {
      durationMs: 60_000 + index * 100,
      cachedDurationMs: 40_000 + index * 100,
      outputBytes: 4096 + index
    }
  });
}

function executionDiagnostics(adversarialCaseCount) {
  return {
    contractVersion: 'harness-shadow-execution-diagnostics-v1.0.0',
    baseline: safeExecutionDiagnostic(),
    cold: v4ExecutionDiagnostic(),
    cached: v4ExecutionDiagnostic(),
    adversarialCorpus: {
      passed: true,
      caseCount: adversarialCaseCount,
      reasonCodes: []
    }
  };
}

function v4ExecutionDiagnostic() {
  return {
    aggregateOutcome: 'PASS',
    parsedCiOutcome: 'PASS',
    auditStatus: 'ATTESTED',
    auditViolationCodes: [],
    runDirectoryAvailable: true,
    validationPlanAvailable: true,
    validationResultAvailable: true,
    reasonCodes: [],
    safeExecutor: safeExecutionDiagnostic()
  };
}

function safeExecutionDiagnostic() {
  return {
    outcome: 'PASS',
    exitCode: 0,
    signal: null,
    timedOut: false,
    outputTruncated: false,
    policyBlocked: false,
    boundaryViolation: false,
    processErrorPresent: false,
    changedPathCount: 0,
    forbiddenWriteCount: 0,
    changedPaths: [],
    forbiddenWrites: [],
    pathsTruncated: false,
    reasonCodes: []
  };
}

function decision(outcome, planDigest, decisionDigest) {
  return {
    outcome,
    decisionDigest,
    planDigest,
    requiredProfileIds: ['lint', 'test-unit'],
    executedProfileIds: ['lint', 'test-unit']
  };
}

function replaceAt(values, index, mutator) {
  return values.map((item, current) => current === index ? mutate(item, mutator) : item);
}

function mutate(value, mutator) {
  const unsigned = withoutId(value);
  mutator(unsigned);
  return sealShadowObservation(unsigned);
}

function withoutId(value) {
  const clone = structuredClone(value);
  delete clone.observationId;
  return clone;
}

function assertBlocked(rows, drillResults, code) {
  const result = evaluateShadowWindow({ policy, observations: rows, drills: drillResults });
  assert.equal(result.qualificationStatus, 'BLOCKED');
  assert.equal(result.eligibleForH9, false);
  assert.equal(result.promotionAllowed, false);
  assert.equal(result.violations.some((item) => item.code === code), true, JSON.stringify(result));
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function sha256File(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function sha256TrackedTextFile(file) {
  const canonicalText = fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
  return `sha256:${crypto.createHash('sha256').update(canonicalText, 'utf8').digest('hex')}`;
}
