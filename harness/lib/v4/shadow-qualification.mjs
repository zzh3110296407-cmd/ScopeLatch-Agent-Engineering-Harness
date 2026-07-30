import { digestCanonicalJson } from './canonical-json.mjs';

const POLICY_KEYS = new Set([
  'contractVersion',
  'maxP95DurationMs',
  'maxUnexplainedDecisionDivergences',
  'minBusinessProfileCoverage',
  'minReproducibilityRate',
  'minRuns',
  'minTrustRootChangeRuns',
  'minWindowDays',
  'policyId',
  'promotionMode',
  'requiredDrills',
  'requiredJudgeSource',
  'requiredMode',
  'requiredObservationSchemaVersion',
  'requiredProvider',
  'schemaVersion'
]);
const OBSERVATION_V1_KEYS = new Set([
  'audit',
  'baseline',
  'businessProfile',
  'candidate',
  'comparison',
  'cost',
  'judge',
  'mode',
  'observationId',
  'observedAt',
  'provider',
  'reproducibility',
  'runAttempt',
  'runId',
  'schemaVersion',
  'trustRoot',
  'v4'
]);
const OBSERVATION_V2_KEYS = new Set([
  ...OBSERVATION_V1_KEYS,
  'executionDiagnostics'
]);
const OUTCOMES = new Set(['PASS', 'FAIL', 'BLOCKED', 'ERROR', 'CANCELED', 'INVALIDATED']);
const AUDIT_STATUSES = new Set(['ATTESTED', 'NOT_ATTESTED', 'INVALIDATED', 'ERROR', 'UNAVAILABLE']);
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const OID = /^[a-f0-9]{40,64}$/;
const REASON_CODE = /^[A-Z][A-Z0-9_.:/-]{0,159}$/;
const SIGNAL = /^[A-Z0-9_-]{1,32}$/;
const MAX_DIAGNOSTIC_ITEMS = 64;
const MAX_DIAGNOSTIC_PATH_LENGTH = 240;

export function sealShadowObservation(value) {
  const observation = clone(value);
  delete observation.observationId;
  const sealed = {
    ...observation,
    observationId: digestCanonicalJson(observation)
  };
  const violations = validateShadowObservation(sealed);
  if (violations.length) {
    const error = new Error(`H8_SHADOW_OBSERVATION_INVALID:${violations[0].code}:${violations[0].safePath}`);
    error.code = violations[0].code;
    error.violations = violations;
    throw error;
  }
  return sealed;
}

export function validateShadowObservation(value) {
  const violations = [];
  const expectedKeys = value?.schemaVersion === 2 ? OBSERVATION_V2_KEYS : OBSERVATION_V1_KEYS;
  if (!isRecord(value) || !exactKeys(value, expectedKeys)) {
    return [violation('SHADOW_OBSERVATION_SHAPE_INVALID', '$')];
  }
  if (![1, 2].includes(value.schemaVersion)) push(violations, 'SHADOW_OBSERVATION_VERSION_INVALID', 'schemaVersion');
  if (!nonEmpty(value.provider)) push(violations, 'SHADOW_PROVIDER_INVALID', 'provider');
  if (!nonEmpty(value.mode)) push(violations, 'SHADOW_MODE_INVALID', 'mode');
  if (!nonEmpty(value.runId)) push(violations, 'SHADOW_RUN_ID_INVALID', 'runId');
  if (!Number.isInteger(value.runAttempt) || value.runAttempt < 1) push(violations, 'SHADOW_RUN_ATTEMPT_INVALID', 'runAttempt');
  if (!validDate(value.observedAt)) push(violations, 'SHADOW_OBSERVED_AT_INVALID', 'observedAt');
  validateCandidate(value.candidate, violations);
  validateJudge(value.judge, violations);
  validateAudit(value.audit, violations);
  validateDecision('baseline', value.baseline, violations);
  validateDecision('v4', value.v4, violations);
  validateComparison(value.comparison, violations);
  validateReproducibility(value.reproducibility, violations);
  validateTrustRoot(value.trustRoot, violations);
  validateBusinessProfile(value.businessProfile, violations);
  if (value.schemaVersion === 2) validateExecutionDiagnostics(value, violations);
  validateCost(value.cost, violations);
  const unsigned = { ...value };
  delete unsigned.observationId;
  if (!SHA256.test(value.observationId || '') || value.observationId !== digestCanonicalJson(unsigned)) {
    push(violations, 'SHADOW_OBSERVATION_DIGEST_MISMATCH', 'observationId');
  }
  return violations;
}

export function evaluateShadowWindow({ policy, observations, drills }) {
  const violations = validatePolicy(policy);
  const rows = Array.isArray(observations) ? observations : [];
  if (!Array.isArray(observations)) push(violations, 'SHADOW_OBSERVATIONS_INVALID', 'observations');
  const identities = new Set();
  let businessRequired = 0;
  let businessCovered = 0;
  let reproducible = 0;
  let unexplainedDivergences = 0;
  let trustRootRuns = 0;
  const durations = [];
  const blockReasons = new Map();
  const timestamps = [];

  for (let index = 0; index < rows.length; index += 1) {
    const observation = rows[index];
    for (const item of validateShadowObservation(observation)) {
      push(violations, item.code, `observations[${index}].${item.safePath}`);
    }
    const identity = `${observation?.runId || ''}:${observation?.runAttempt || ''}`;
    if (identities.has(identity)) push(violations, 'SHADOW_RUN_IDENTITY_DUPLICATE', `observations[${index}]`);
    identities.add(identity);
    if (observation?.provider !== policy?.requiredProvider) push(violations, 'SHADOW_PROVIDER_NOT_QUALIFIED', `observations[${index}].provider`);
    if (observation?.mode !== policy?.requiredMode) push(violations, 'SHADOW_MODE_NOT_QUALIFIED', `observations[${index}].mode`);
    if (observation?.schemaVersion !== policy?.requiredObservationSchemaVersion) {
      push(violations, 'SHADOW_OBSERVATION_VERSION_NOT_QUALIFIED', `observations[${index}].schemaVersion`);
    }
    if (
      observation?.judge?.source !== policy?.requiredJudgeSource
      || observation?.judge?.candidateControlled !== false
    ) {
      push(violations, 'SHADOW_JUDGE_NOT_INDEPENDENT', `observations[${index}].judge`);
    }
    if (observation?.judge?.baseCommitOid === observation?.candidate?.commitOid) {
      push(violations, 'SHADOW_JUDGE_CANDIDATE_COMMIT_ALIAS', `observations[${index}].judge.baseCommitOid`);
    }
    if (observation?.audit?.accepted !== true) {
      push(violations, 'SHADOW_AUDIT_NOT_ATTESTED', `observations[${index}].audit`);
    }
    if (validDate(observation?.observedAt)) timestamps.push(Date.parse(observation.observedAt));
    if (Number.isInteger(observation?.cost?.durationMs)) durations.push(observation.cost.durationMs);

    if (observation?.comparison?.divergence && !observation.comparison.explained) {
      unexplainedDivergences += 1;
      push(violations, 'SHADOW_DECISION_DIVERGENCE_UNEXPLAINED', `observations[${index}].comparison`);
    }
    if (observation?.businessProfile?.changed) {
      businessRequired += 1;
      if (
        observation.businessProfile.requiredProfileIds.length > 0
        && isSubset(observation.businessProfile.requiredProfileIds, observation.businessProfile.executedProfileIds)
      ) {
        businessCovered += 1;
      } else {
        push(violations, 'SHADOW_BUSINESS_PROFILE_COVERAGE_INCOMPLETE', `observations[${index}].businessProfile`);
      }
    }
    if (
      observation?.reproducibility?.coldDecisionDigest === observation?.reproducibility?.cachedDecisionDigest
      && observation?.reproducibility?.coldPlanDigest === observation?.reproducibility?.cachedPlanDigest
    ) {
      reproducible += 1;
    } else {
      push(violations, 'SHADOW_REPRODUCIBILITY_MISMATCH', `observations[${index}].reproducibility`);
    }
    if (observation?.trustRoot?.changed) {
      trustRootRuns += 1;
      if (
        observation.trustRoot.adversarialCorpusRequired !== true
        || observation.trustRoot.adversarialCorpusPassed !== true
        || observation.trustRoot.adversarialCaseCount < 1
      ) {
        push(violations, 'SHADOW_TRUST_ROOT_ADVERSARIAL_CORPUS_REQUIRED', `observations[${index}].trustRoot`);
      }
    }
    if (observation?.v4?.outcome !== 'PASS') {
      const reason = observation?.v4?.outcome || 'UNKNOWN';
      blockReasons.set(reason, (blockReasons.get(reason) || 0) + 1);
      push(violations, 'SHADOW_V4_OUTCOME_NOT_PASS', `observations[${index}].v4.outcome`);
    }
    if (observation?.baseline?.outcome !== 'PASS') {
      push(violations, 'SHADOW_BASELINE_OUTCOME_NOT_PASS', `observations[${index}].baseline.outcome`);
    }
    if (observation?.executionDiagnostics?.cached?.aggregateOutcome !== 'PASS') {
      push(violations, 'SHADOW_CACHED_V4_OUTCOME_NOT_PASS', `observations[${index}].executionDiagnostics.cached.aggregateOutcome`);
    }
  }

  const windowDurationDays = timestamps.length > 1
    ? (Math.max(...timestamps) - Math.min(...timestamps)) / 86_400_000
    : 0;
  const businessProfileCoverage = businessRequired ? businessCovered / businessRequired : 1;
  const reproducibilityRate = rows.length ? reproducible / rows.length : 0;
  const p95DurationMs = percentile(durations, 0.95);

  if (rows.length < (policy?.minRuns || Number.POSITIVE_INFINITY)) push(violations, 'SHADOW_WINDOW_RUN_COUNT_INSUFFICIENT', 'observations');
  if (windowDurationDays < (policy?.minWindowDays || Number.POSITIVE_INFINITY)) push(violations, 'SHADOW_WINDOW_DURATION_INSUFFICIENT', 'observations');
  if (trustRootRuns < (policy?.minTrustRootChangeRuns || Number.POSITIVE_INFINITY)) push(violations, 'SHADOW_TRUST_ROOT_RUN_COUNT_INSUFFICIENT', 'observations');
  if (unexplainedDivergences > (policy?.maxUnexplainedDecisionDivergences ?? -1)) push(violations, 'SHADOW_DIVERGENCE_BUDGET_EXCEEDED', 'observations');
  if (businessProfileCoverage < (policy?.minBusinessProfileCoverage ?? 1)) push(violations, 'SHADOW_BUSINESS_PROFILE_COVERAGE_BELOW_TARGET', 'observations');
  if (reproducibilityRate < (policy?.minReproducibilityRate ?? 1)) push(violations, 'SHADOW_REPRODUCIBILITY_BELOW_TARGET', 'observations');
  if (p95DurationMs > (policy?.maxP95DurationMs ?? 0)) push(violations, 'SHADOW_COST_P95_EXCEEDED', 'observations');
  validateDrills(policy, drills, violations);

  const uniqueViolations = deduplicateViolations(violations);
  const qualified = uniqueViolations.length === 0;
  return {
    schemaVersion: 1,
    contractVersion: policy?.contractVersion || null,
    policyId: policy?.policyId || null,
    qualificationStatus: qualified ? 'QUALIFIED' : 'BLOCKED',
    eligibleForH9: qualified,
    promotionAllowed: false,
    formalEligible: false,
    reasonCode: qualified ? 'SHADOW_WINDOW_QUALIFIED' : uniqueViolations[0]?.code || 'SHADOW_WINDOW_INVALID',
    violations: uniqueViolations,
    metrics: {
      observedRunCount: rows.length,
      distinctRunCount: identities.size,
      windowDurationDays,
      unexplainedDecisionDivergences: unexplainedDivergences,
      businessProfileCoverage,
      reproducibilityRate,
      trustRootChangeRunCount: trustRootRuns,
      p50DurationMs: percentile(durations, 0.5),
      p95DurationMs,
      totalDurationMs: durations.reduce((sum, item) => sum + item, 0),
      blockReasons: Object.fromEntries([...blockReasons.entries()].sort())
    },
    drillResults: clone(drills || {}),
    observationSetDigest: digestCanonicalJson(rows.map((item) => item?.observationId || null).sort())
  };
}

export function runQualificationDrills(policy) {
  const empty = evaluateShadowWindow({
    policy,
    observations: [],
    drills: {
      rollback: { passed: true, evidenceId: 'local-empty-window-remains-shadow-only' },
      'compromised-judge': { passed: true, evidenceId: 'local-invalid-judge-is-blocked' }
    }
  });
  const rollback = {
    passed: empty.qualificationStatus === 'BLOCKED'
      && empty.promotionAllowed === false
      && empty.formalEligible === false,
    evidenceId: 'shadow-rollback-preserves-evidence-and-disables-promotion'
  };
  const digest = `sha256:${'a'.repeat(64)}`;
  const untrustedJudgeObservation = sealShadowObservation({
    schemaVersion: 2,
    provider: policy.requiredProvider,
    mode: policy.requiredMode,
    runId: 'compromised-judge-drill',
    runAttempt: 1,
    observedAt: '2026-07-29T00:00:00.000Z',
    candidate: {
      commitOid: 'a'.repeat(40),
      treeOid: 'b'.repeat(40)
    },
    judge: {
      source: 'candidate',
      candidateControlled: true,
      engineDigest: digest,
      candidateEngineDigest: digest,
      baseCommitOid: 'c'.repeat(40),
      workflowRef: 'local-drill'
    },
    audit: {
      accepted: true,
      attestationDigest: digest,
      violationCodes: []
    },
    baseline: drillDecision(digest),
    v4: drillDecision(digest),
    comparison: {
      divergence: false,
      explained: false,
      explanationCode: null
    },
    reproducibility: {
      coldDecisionDigest: digest,
      cachedDecisionDigest: digest,
      coldPlanDigest: digest,
      cachedPlanDigest: digest
    },
    trustRoot: {
      changed: true,
      adversarialCorpusRequired: true,
      adversarialCorpusPassed: true,
      adversarialCaseCount: 1
    },
    businessProfile: {
      changed: false,
      requiredProfileIds: [],
      executedProfileIds: []
    },
    executionDiagnostics: drillExecutionDiagnostics(),
    cost: {
      durationMs: 1,
      cachedDurationMs: 1,
      outputBytes: 1
    }
  });
  const compromisedResult = evaluateShadowWindow({
    policy,
    observations: [untrustedJudgeObservation],
    drills: {
      rollback: { passed: true, evidenceId: 'drill' },
      'compromised-judge': { passed: true, evidenceId: 'drill' }
    }
  });
  const compromised = {
    passed: compromisedResult.violations.some((item) => item.code === 'SHADOW_JUDGE_NOT_INDEPENDENT'),
    evidenceId: 'candidate-controlled-judge-observation-is-rejected'
  };
  return {
    rollback,
    'compromised-judge': compromised
  };
}

function drillDecision(digest) {
  return {
    outcome: 'PASS',
    decisionDigest: digest,
    planDigest: digest,
    requiredProfileIds: [],
    executedProfileIds: []
  };
}

function drillExecutionDiagnostics() {
  const safeExecutor = {
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
  const v4 = {
    aggregateOutcome: 'PASS',
    parsedCiOutcome: 'PASS',
    auditStatus: 'ATTESTED',
    auditViolationCodes: [],
    runDirectoryAvailable: true,
    validationPlanAvailable: true,
    validationResultAvailable: true,
    reasonCodes: [],
    safeExecutor
  };
  return {
    contractVersion: 'harness-shadow-execution-diagnostics-v1.0.0',
    baseline: safeExecutor,
    cold: v4,
    cached: v4,
    adversarialCorpus: {
      passed: true,
      caseCount: 1,
      reasonCodes: []
    }
  };
}

export function validatePolicy(value) {
  const violations = [];
  if (!isRecord(value) || !exactKeys(value, POLICY_KEYS)) return [violation('SHADOW_POLICY_SHAPE_INVALID', 'policy')];
  if (value.schemaVersion !== 1) push(violations, 'SHADOW_POLICY_VERSION_INVALID', 'policy.schemaVersion');
  if (!nonEmpty(value.policyId) || !nonEmpty(value.contractVersion)) push(violations, 'SHADOW_POLICY_IDENTITY_INVALID', 'policy');
  for (const key of ['minRuns', 'minWindowDays', 'minTrustRootChangeRuns', 'maxUnexplainedDecisionDivergences', 'maxP95DurationMs']) {
    if (!Number.isInteger(value[key]) || value[key] < 0) push(violations, 'SHADOW_POLICY_THRESHOLD_INVALID', `policy.${key}`);
  }
  for (const key of ['minBusinessProfileCoverage', 'minReproducibilityRate']) {
    if (typeof value[key] !== 'number' || value[key] < 0 || value[key] > 1) push(violations, 'SHADOW_POLICY_RATIO_INVALID', `policy.${key}`);
  }
  if (!nonEmpty(value.requiredProvider) || !nonEmpty(value.requiredMode) || !nonEmpty(value.requiredJudgeSource)) push(violations, 'SHADOW_POLICY_MODE_INVALID', 'policy');
  if (![1, 2].includes(value.requiredObservationSchemaVersion)) push(violations, 'SHADOW_POLICY_OBSERVATION_VERSION_INVALID', 'policy.requiredObservationSchemaVersion');
  if (!uniqueStrings(value.requiredDrills) || !value.requiredDrills.length) push(violations, 'SHADOW_POLICY_DRILLS_INVALID', 'policy.requiredDrills');
  if (value.promotionMode !== 'shadow-only') push(violations, 'SHADOW_POLICY_PROMOTION_MODE_INVALID', 'policy.promotionMode');
  return violations;
}

function validateCandidate(value, violations) {
  if (!isRecord(value) || !exactKeys(value, new Set(['commitOid', 'treeOid'])) || !OID.test(value.commitOid || '') || !OID.test(value.treeOid || '')) {
    push(violations, 'SHADOW_CANDIDATE_INVALID', 'candidate');
  }
}

function validateJudge(value, violations) {
  const keys = new Set([
    'baseCommitOid',
    'candidateControlled',
    'candidateEngineDigest',
    'engineDigest',
    'source',
    'workflowRef'
  ]);
  if (
    !isRecord(value)
    || !exactKeys(value, keys)
    || !OID.test(value.baseCommitOid || '')
    || typeof value.candidateControlled !== 'boolean'
    || !SHA256.test(value.candidateEngineDigest || '')
    || !SHA256.test(value.engineDigest || '')
    || !nonEmpty(value.source)
    || !nonEmpty(value.workflowRef)
  ) push(violations, 'SHADOW_JUDGE_INVALID', 'judge');
}

function validateAudit(value, violations) {
  const keys = new Set(['accepted', 'attestationDigest', 'violationCodes']);
  if (
    !isRecord(value)
    || !exactKeys(value, keys)
    || typeof value.accepted !== 'boolean'
    || !(value.attestationDigest === null || SHA256.test(value.attestationDigest || ''))
    || !uniqueStrings(value.violationCodes)
    || (value.accepted && !SHA256.test(value.attestationDigest || ''))
    || (!value.accepted && value.attestationDigest !== null)
  ) push(violations, 'SHADOW_AUDIT_INVALID', 'audit');
}

function validateDecision(name, value, violations) {
  const keys = new Set(['decisionDigest', 'executedProfileIds', 'outcome', 'planDigest', 'requiredProfileIds']);
  if (!isRecord(value) || !exactKeys(value, keys)) {
    push(violations, 'SHADOW_DECISION_SHAPE_INVALID', name);
    return;
  }
  if (!OUTCOMES.has(value.outcome)) push(violations, 'SHADOW_DECISION_OUTCOME_INVALID', `${name}.outcome`);
  if (!SHA256.test(value.decisionDigest || '') || !SHA256.test(value.planDigest || '')) push(violations, 'SHADOW_DECISION_DIGEST_INVALID', name);
  if (!uniqueStrings(value.requiredProfileIds) || !uniqueStrings(value.executedProfileIds)) push(violations, 'SHADOW_DECISION_PROFILES_INVALID', name);
}

function validateComparison(value, violations) {
  if (
    !isRecord(value)
    || !exactKeys(value, new Set(['divergence', 'explained', 'explanationCode']))
    || typeof value.divergence !== 'boolean'
    || typeof value.explained !== 'boolean'
    || !(value.explanationCode === null || nonEmpty(value.explanationCode))
    || (value.explained && !value.explanationCode)
  ) push(violations, 'SHADOW_COMPARISON_INVALID', 'comparison');
}

function validateReproducibility(value, violations) {
  const keys = new Set(['cachedDecisionDigest', 'cachedPlanDigest', 'coldDecisionDigest', 'coldPlanDigest']);
  if (!isRecord(value) || !exactKeys(value, keys) || Object.values(value).some((item) => !SHA256.test(item || ''))) {
    push(violations, 'SHADOW_REPRODUCIBILITY_INVALID', 'reproducibility');
  }
}

function validateTrustRoot(value, violations) {
  if (
    !isRecord(value)
    || !exactKeys(value, new Set(['adversarialCaseCount', 'adversarialCorpusPassed', 'adversarialCorpusRequired', 'changed']))
    || typeof value.changed !== 'boolean'
    || typeof value.adversarialCorpusRequired !== 'boolean'
    || typeof value.adversarialCorpusPassed !== 'boolean'
    || !Number.isInteger(value.adversarialCaseCount)
    || value.adversarialCaseCount < 0
  ) push(violations, 'SHADOW_TRUST_ROOT_INVALID', 'trustRoot');
}

function validateBusinessProfile(value, violations) {
  if (
    !isRecord(value)
    || !exactKeys(value, new Set(['changed', 'executedProfileIds', 'requiredProfileIds']))
    || typeof value.changed !== 'boolean'
    || !uniqueStrings(value.requiredProfileIds)
    || !uniqueStrings(value.executedProfileIds)
  ) push(violations, 'SHADOW_BUSINESS_PROFILE_INVALID', 'businessProfile');
}

function validateExecutionDiagnostics(observation, violations) {
  const value = observation.executionDiagnostics;
  if (
    !isRecord(value)
    || !exactKeys(value, new Set(['adversarialCorpus', 'baseline', 'cached', 'cold', 'contractVersion']))
    || value.contractVersion !== 'harness-shadow-execution-diagnostics-v1.0.0'
  ) {
    push(violations, 'SHADOW_EXECUTION_DIAGNOSTIC_INVALID', 'executionDiagnostics');
    return;
  }
  validateSafeExecutionDiagnostic(value.baseline, 'executionDiagnostics.baseline', violations);
  validateV4ExecutionDiagnostic(value.cold, 'executionDiagnostics.cold', violations);
  validateV4ExecutionDiagnostic(value.cached, 'executionDiagnostics.cached', violations);
  validateAdversarialDiagnostic(value.adversarialCorpus, violations);

  const auditCodes = [...(observation.audit?.violationCodes || [])].sort();
  const coldAuditCodes = [...(value.cold?.auditViolationCodes || [])].sort();
  const inconsistent = value.baseline?.outcome !== observation.baseline?.outcome
    || value.cold?.aggregateOutcome !== observation.v4?.outcome
    || (value.cold?.auditStatus === 'ATTESTED') !== observation.audit?.accepted
    || JSON.stringify(auditCodes) !== JSON.stringify(coldAuditCodes)
    || value.adversarialCorpus?.passed !== observation.trustRoot?.adversarialCorpusPassed
    || value.adversarialCorpus?.caseCount !== observation.trustRoot?.adversarialCaseCount;
  if (inconsistent) {
    push(violations, 'SHADOW_EXECUTION_DIAGNOSTICS_INCONSISTENT', 'executionDiagnostics');
  }
}

function validateSafeExecutionDiagnostic(value, safePath, violations) {
  const keys = new Set([
    'boundaryViolation',
    'changedPathCount',
    'changedPaths',
    'exitCode',
    'forbiddenWriteCount',
    'forbiddenWrites',
    'outcome',
    'outputTruncated',
    'pathsTruncated',
    'policyBlocked',
    'processErrorPresent',
    'reasonCodes',
    'signal',
    'timedOut'
  ]);
  if (!isRecord(value) || !exactKeys(value, keys)) {
    push(violations, 'SHADOW_EXECUTION_DIAGNOSTIC_INVALID', safePath);
    return;
  }
  const booleansValid = [
    value.timedOut,
    value.outputTruncated,
    value.policyBlocked,
    value.boundaryViolation,
    value.processErrorPresent,
    value.pathsTruncated
  ].every((item) => typeof item === 'boolean');
  const exitCodeValid = value.exitCode === null
    || (Number.isInteger(value.exitCode) && value.exitCode >= -2147483648 && value.exitCode <= 4294967295);
  const signalValid = value.signal === null || (typeof value.signal === 'string' && SIGNAL.test(value.signal));
  const countsValid = [value.changedPathCount, value.forbiddenWriteCount]
    .every((item) => Number.isInteger(item) && item >= 0 && item <= 100000);
  const pathsValid = diagnosticPathsValid(value.changedPaths) && diagnosticPathsValid(value.forbiddenWrites);
  const reasonCodesValid = diagnosticReasonCodesValid(value.reasonCodes);
  if (
    !OUTCOMES.has(value.outcome)
    || !booleansValid
    || !exitCodeValid
    || !signalValid
    || !countsValid
    || !reasonCodesValid
  ) push(violations, 'SHADOW_EXECUTION_DIAGNOSTIC_INVALID', safePath);
  if (!pathsValid) push(violations, 'SHADOW_EXECUTION_DIAGNOSTIC_PATH_INVALID', safePath);

  const countsMatch = value.changedPathCount >= (value.changedPaths?.length ?? Number.POSITIVE_INFINITY)
    && value.forbiddenWriteCount >= (value.forbiddenWrites?.length ?? Number.POSITIVE_INFINITY)
    && (value.pathsTruncated
      ? value.changedPathCount > value.changedPaths.length || value.forbiddenWriteCount > value.forbiddenWrites.length
      : value.changedPathCount === value.changedPaths.length && value.forbiddenWriteCount === value.forbiddenWrites.length);
  const forbiddenSubset = value.pathsTruncated
    || (Array.isArray(value.forbiddenWrites)
      && Array.isArray(value.changedPaths)
      && value.forbiddenWrites.every((item) => value.changedPaths.includes(item)));
  const passIsClean = value.outcome !== 'PASS'
    || (
      value.exitCode === 0
      && value.signal === null
      && !value.timedOut
      && !value.outputTruncated
      && !value.policyBlocked
      && !value.boundaryViolation
      && !value.processErrorPresent
      && value.reasonCodes.length === 0
    );
  const failureHasReason = value.outcome === 'PASS' || value.reasonCodes.length > 0;
  const boundaryMatches = value.boundaryViolation === (value.forbiddenWriteCount > 0);
  if (!countsMatch || !forbiddenSubset || !passIsClean || !failureHasReason || !boundaryMatches) {
    push(violations, 'SHADOW_EXECUTION_DIAGNOSTICS_INCONSISTENT', safePath);
  }
}

function validateV4ExecutionDiagnostic(value, safePath, violations) {
  const keys = new Set([
    'aggregateOutcome',
    'auditStatus',
    'auditViolationCodes',
    'parsedCiOutcome',
    'reasonCodes',
    'runDirectoryAvailable',
    'safeExecutor',
    'validationPlanAvailable',
    'validationResultAvailable'
  ]);
  if (!isRecord(value) || !exactKeys(value, keys)) {
    push(violations, 'SHADOW_EXECUTION_DIAGNOSTIC_INVALID', safePath);
    return;
  }
  validateSafeExecutionDiagnostic(value.safeExecutor, `${safePath}.safeExecutor`, violations);
  const availabilityValid = [
    value.runDirectoryAvailable,
    value.validationPlanAvailable,
    value.validationResultAvailable
  ].every((item) => typeof item === 'boolean');
  if (
    !OUTCOMES.has(value.aggregateOutcome)
    || !OUTCOMES.has(value.parsedCiOutcome)
    || !AUDIT_STATUSES.has(value.auditStatus)
    || !availabilityValid
    || !diagnosticReasonCodesValid(value.auditViolationCodes)
    || !diagnosticReasonCodesValid(value.reasonCodes)
  ) {
    push(violations, 'SHADOW_EXECUTION_DIAGNOSTIC_INVALID', safePath);
    return;
  }
  const passIsComplete = value.aggregateOutcome !== 'PASS'
    || (
      value.safeExecutor.outcome === 'PASS'
      && value.parsedCiOutcome === 'PASS'
      && value.auditStatus === 'ATTESTED'
      && value.auditViolationCodes.length === 0
      && value.runDirectoryAvailable
      && value.validationPlanAvailable
      && value.validationResultAvailable
      && value.reasonCodes.length === 0
    );
  const failureHasReason = value.aggregateOutcome === 'PASS' || value.reasonCodes.length > 0;
  if (!passIsComplete || !failureHasReason) {
    push(violations, 'SHADOW_EXECUTION_DIAGNOSTICS_INCONSISTENT', safePath);
  }
}

function validateAdversarialDiagnostic(value, violations) {
  if (
    !isRecord(value)
    || !exactKeys(value, new Set(['caseCount', 'passed', 'reasonCodes']))
    || typeof value.passed !== 'boolean'
    || !Number.isInteger(value.caseCount)
    || value.caseCount < 0
    || !diagnosticReasonCodesValid(value.reasonCodes)
    || (value.passed && value.reasonCodes.length > 0)
    || (!value.passed && value.reasonCodes.length === 0)
  ) push(violations, 'SHADOW_EXECUTION_DIAGNOSTIC_INVALID', 'executionDiagnostics.adversarialCorpus');
}

function validateCost(value, violations) {
  if (
    !isRecord(value)
    || !exactKeys(value, new Set(['cachedDurationMs', 'durationMs', 'outputBytes']))
    || ![value.cachedDurationMs, value.durationMs, value.outputBytes].every((item) => Number.isInteger(item) && item >= 0)
  ) push(violations, 'SHADOW_COST_INVALID', 'cost');
}

function diagnosticPathsValid(value) {
  return Array.isArray(value)
    && value.length <= MAX_DIAGNOSTIC_ITEMS
    && new Set(value).size === value.length
    && value.every((item) => {
      if (typeof item !== 'string' || item.length < 1 || item.length > MAX_DIAGNOSTIC_PATH_LENGTH) return false;
      if (item.includes('\\') || item.includes('\0') || pathIsAbsolute(item)) return false;
      return !item.split('/').some((segment) => !segment || segment === '.' || segment === '..');
    });
}

function diagnosticReasonCodesValid(value) {
  return Array.isArray(value)
    && value.length <= MAX_DIAGNOSTIC_ITEMS
    && new Set(value).size === value.length
    && value.every((item) => typeof item === 'string' && REASON_CODE.test(item));
}

function pathIsAbsolute(value) {
  return value.startsWith('/') || /^[A-Za-z]:/.test(value);
}

function validateDrills(policy, drills, violations) {
  if (!isRecord(drills)) {
    push(violations, 'SHADOW_DRILLS_MISSING', 'drills');
    return;
  }
  for (const id of policy?.requiredDrills || []) {
    const result = drills[id];
    if (!isRecord(result) || result.passed !== true || !nonEmpty(result.evidenceId)) {
      push(violations, 'SHADOW_DRILL_NOT_PASSED', `drills.${id}`);
    }
  }
}

function isSubset(required = [], observed = []) {
  const values = new Set(observed);
  return required.every((item) => values.has(item));
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * ratio) - 1)];
}

function validDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function uniqueStrings(value) {
  return Array.isArray(value)
    && value.every(nonEmpty)
    && new Set(value).size === value.length;
}

function exactKeys(value, expected) {
  return Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key));
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function violation(code, safePath) {
  return { code, safePath };
}

function push(violations, code, safePath) {
  violations.push(violation(code, safePath));
}

function deduplicateViolations(values) {
  const seen = new Set();
  return values.filter((item) => {
    const key = `${item.code}:${item.safePath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
