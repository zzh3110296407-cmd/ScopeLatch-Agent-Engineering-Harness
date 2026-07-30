import { digestCanonicalJson } from '../../lib/v4/canonical-json.mjs';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const OID = /^[a-f0-9]{40,64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const FORMAL_OUTCOME = 'FORMAL_PASS';
const POLICY_KEYS = new Set([
  'attestation',
  'auditor',
  'contractVersion',
  'delivery',
  'externalEnforcement',
  'freshness',
  'h8',
  'policyId',
  'protectedBranch',
  'provider',
  'repository',
  'schemaVersion',
  'workflow'
]);
const ATTESTATION_KEYS = new Set([
  'artifactType',
  'attestationDigest',
  'auditor',
  'authority',
  'authorityDigest',
  'candidateCommitOid',
  'candidateSnapshotDigest',
  'candidateTreeOid',
  'contractVersion',
  'evidenceRootDigest',
  'exceptionReferences',
  'executionPlanDigest',
  'executorEngineDigest',
  'expiresAt',
  'formalCutoverPolicyDigest',
  'h8QualificationDigest',
  'invariantCatalogDigest',
  'issuedAt',
  'mode',
  'outcome',
  'policySnapshotDigest',
  'repository',
  'requiredCheckCount',
  'requiredInvariantCount',
  'runId',
  'schemaVersion',
  'sourceAuthorityDigest'
]);
const AUTHORITY_KEYS = new Set([
  'baseCommitOid',
  'candidateCommitOid',
  'candidateTreeOid',
  'engineDigest',
  'eventName',
  'jobName',
  'observedAt',
  'protectedBranch',
  'provider',
  'repository',
  'runAttempt',
  'runId',
  'schemaVersion',
  'workflowPath',
  'workflowRef'
]);
const LOCAL_ATTESTATION_KEYS = new Set([
  'artifactType',
  'attestationDigest',
  'auditor',
  'candidateSnapshotDigest',
  'candidateTreeOid',
  'contractVersion',
  'evidenceRootDigest',
  'exceptionReferences',
  'executionPlanDigest',
  'executorEngineDigest',
  'invariantCatalogDigest',
  'mode',
  'outcome',
  'policySnapshotDigest',
  'requiredCheckCount',
  'requiredInvariantCount',
  'runId',
  'schemaVersion',
  'sourceAuthorityDigest'
]);

export class FormalCutoverError extends Error {
  constructor(code, safePath = '$') {
    super(code);
    this.name = 'FormalCutoverError';
    this.code = code;
    this.safePath = safePath;
  }
}

export function validateFormalCutoverPolicy(policy) {
  const violations = [];
  if (!isRecord(policy) || !exactKeys(policy, POLICY_KEYS)) {
    push(violations, 'H9_POLICY_SHAPE_INVALID', '$');
    return violations;
  }
  if (
    policy.schemaVersion !== 1
    || policy.policyId !== 'harness-v4-h9-formal-cutover'
    || policy.contractVersion !== 'harness-formal-cutover-v4.1.0'
    || !repositoryName(policy.repository)
    || policy.provider !== 'github-actions'
    || !branchName(policy.protectedBranch)
  ) push(violations, 'H9_POLICY_IDENTITY_INVALID', '$');

  if (
    !exactRecord(policy.workflow, [
      'path',
      'requiredCheckName',
      'requiredEvents',
      'trustedSource'
    ])
    || !safeRelativePath(policy.workflow?.path)
    || !boundedString(policy.workflow?.requiredCheckName, 1, 128)
    || !uniqueStrings(policy.workflow?.requiredEvents, 1, 8)
    || policy.workflow.requiredEvents.some((item) => !['merge_group', 'pull_request'].includes(item))
    || policy.workflow.trustedSource !== 'protected-base'
  ) push(violations, 'H9_POLICY_WORKFLOW_INVALID', 'workflow');

  if (
    !exactRecord(policy.attestation, [
      'contractVersion',
      'requiredArtifactType',
      'requiredMode',
      'requiredOutcome'
    ])
    || policy.attestation?.contractVersion !== 'harness-attestation-v4.1.0'
    || policy.attestation?.requiredArtifactType !== 'FormalAttestation'
    || policy.attestation?.requiredMode !== 'formal-ci'
    || policy.attestation?.requiredOutcome !== FORMAL_OUTCOME
  ) push(violations, 'H9_POLICY_ATTESTATION_INVALID', 'attestation');

  if (
    !exactRecord(policy.freshness, ['maxAgeSeconds', 'maxFutureSkewSeconds'])
    || !integerBetween(policy.freshness?.maxAgeSeconds, 60, 86_400)
    || !integerBetween(policy.freshness?.maxFutureSkewSeconds, 0, 3600)
  ) push(violations, 'H9_POLICY_FRESHNESS_INVALID', 'freshness');

  if (
    !exactRecord(policy.delivery, ['requireExactCommit', 'requireExactTree'])
    || policy.delivery?.requireExactCommit !== true
    || policy.delivery?.requireExactTree !== true
  ) push(violations, 'H9_POLICY_DELIVERY_INVALID', 'delivery');

  if (
    !exactRecord(policy.h8, [
      'contractVersion',
      'policyId',
      'requireEligibleForH9',
      'requiredQualificationStatus'
    ])
    || policy.h8?.policyId !== 'harness-v4-h8-shadow-qualification'
    || policy.h8?.contractVersion !== 'harness-shadow-qualification-v4.1.0'
    || policy.h8?.requiredQualificationStatus !== 'QUALIFIED'
    || policy.h8?.requireEligibleForH9 !== true
  ) push(violations, 'H9_POLICY_H8_INVALID', 'h8');

  if (
    !exactRecord(policy.auditor, ['id', 'minimumVersion'])
    || policy.auditor?.id !== 'harness-independent-auditor'
    || !boundedString(policy.auditor?.minimumVersion, 1, 64)
  ) push(violations, 'H9_POLICY_AUDITOR_INVALID', 'auditor');

  if (
    !exactRecord(policy.externalEnforcement, ['allowedModes', 'required'])
    || policy.externalEnforcement?.required !== true
    || !uniqueStrings(policy.externalEnforcement?.allowedModes, 1, 4)
    || policy.externalEnforcement.allowedModes.some(
      (item) => !['branch-protection', 'ruleset'].includes(item)
    )
  ) push(violations, 'H9_POLICY_ENFORCEMENT_INVALID', 'externalEnforcement');

  return dedupe(violations);
}

export function issueFormalCiAttestation({
  localAudit,
  policy,
  authority,
  h8Qualification,
  issuedAt,
  expiresAt
}) {
  const violations = [...validateFormalCutoverPolicy(policy)];
  validateLocalAudit(localAudit, policy, violations);
  validateAuthority(authority, violations);
  validateIssuanceAuthority(authority, policy, localAudit?.attestation, violations);
  validateH8(h8Qualification, policy, null, violations);
  if (
    !validDate(issuedAt)
    || !validDate(expiresAt)
    || Date.parse(expiresAt) <= Date.parse(issuedAt)
    || (
      Number.isFinite(policy?.freshness?.maxAgeSeconds)
      && Date.parse(expiresAt) - Date.parse(issuedAt) > policy.freshness.maxAgeSeconds * 1000
    )
  ) push(violations, 'H9_ATTESTATION_TIME_INVALID', '$');

  const unique = dedupe(violations);
  if (unique.length) return failedIssuance(unique);

  const local = localAudit.attestation;
  const unsigned = {
    schemaVersion: 2,
    artifactType: 'FormalAttestation',
    contractVersion: policy.attestation.contractVersion,
    mode: policy.attestation.requiredMode,
    runId: local.runId,
    outcome: FORMAL_OUTCOME,
    repository: policy.repository,
    candidateCommitOid: authority.candidateCommitOid,
    candidateTreeOid: local.candidateTreeOid,
    candidateSnapshotDigest: local.candidateSnapshotDigest,
    executorEngineDigest: local.executorEngineDigest,
    policySnapshotDigest: local.policySnapshotDigest,
    formalCutoverPolicyDigest: digestCanonicalJson(policy),
    sourceAuthorityDigest: local.sourceAuthorityDigest,
    invariantCatalogDigest: local.invariantCatalogDigest,
    executionPlanDigest: local.executionPlanDigest,
    evidenceRootDigest: local.evidenceRootDigest,
    h8QualificationDigest: digestCanonicalJson(h8Qualification),
    requiredCheckCount: local.requiredCheckCount,
    requiredInvariantCount: local.requiredInvariantCount,
    exceptionReferences: [],
    issuedAt,
    expiresAt,
    authority,
    authorityDigest: digestCanonicalJson(authority),
    auditor: {
      id: policy.auditor.id,
      version: policy.auditor.minimumVersion,
      engineDigest: local.auditor.engineDigest
    }
  };
  return {
    status: 'attested',
    outcome: FORMAL_OUTCOME,
    violations: [],
    executorVerdictIgnored: true,
    attestation: sealFormalAttestation(unsigned)
  };
}

export function sealFormalAttestation(value) {
  const candidate = { ...(isRecord(value) ? value : {}) };
  if ('attestationDigest' in candidate) {
    throw new FormalCutoverError('H9_ATTESTATION_ALREADY_SEALED', 'attestationDigest');
  }
  const sealed = {
    ...candidate,
    attestationDigest: digestCanonicalJson(candidate)
  };
  const violations = validateFormalAttestation(sealed);
  if (violations.length) {
    throw new FormalCutoverError(
      violations[0].code === 'H9_ATTESTATION_DIGEST_INVALID'
        ? 'H9_ATTESTATION_SHAPE_INVALID'
        : violations[0].code,
      violations[0].safePath
    );
  }
  return sealed;
}

export function validateFormalAttestation(attestation, policy = null) {
  const violations = [];
  if (!isRecord(attestation) || !exactKeys(attestation, ATTESTATION_KEYS)) {
    push(violations, 'H9_ATTESTATION_SHAPE_INVALID', '$');
    return violations;
  }
  const unsigned = { ...attestation };
  delete unsigned.attestationDigest;
  if (
    !SHA256.test(attestation.attestationDigest || '')
    || attestation.attestationDigest !== digestCanonicalJson(unsigned)
  ) push(violations, 'H9_ATTESTATION_DIGEST_INVALID', 'attestationDigest');
  if (
    attestation.schemaVersion !== 2
    || attestation.artifactType !== 'FormalAttestation'
    || attestation.contractVersion !== 'harness-attestation-v4.1.0'
    || attestation.mode !== 'formal-ci'
    || attestation.outcome !== FORMAL_OUTCOME
    || !boundedString(attestation.runId, 1, 128)
    || !repositoryName(attestation.repository)
  ) push(violations, 'H9_ATTESTATION_IDENTITY_INVALID', '$');
  if (
    !OID.test(attestation.candidateCommitOid || '')
    || !OID.test(attestation.candidateTreeOid || '')
    || !allDigests(attestation, [
      'candidateSnapshotDigest',
      'evidenceRootDigest',
      'executionPlanDigest',
      'executorEngineDigest',
      'formalCutoverPolicyDigest',
      'h8QualificationDigest',
      'invariantCatalogDigest',
      'policySnapshotDigest',
      'sourceAuthorityDigest'
    ])
  ) push(violations, 'H9_ATTESTATION_BINDING_INVALID', '$');
  if (
    !integerBetween(attestation.requiredCheckCount, 1, 10_000)
    || !integerBetween(attestation.requiredInvariantCount, 1, 10_000)
    || !Array.isArray(attestation.exceptionReferences)
    || attestation.exceptionReferences.length !== 0
  ) push(violations, 'H9_ATTESTATION_REQUIREMENTS_INVALID', '$');
  if (
    !validDate(attestation.issuedAt)
    || !validDate(attestation.expiresAt)
    || Date.parse(attestation.expiresAt) <= Date.parse(attestation.issuedAt)
  ) push(violations, 'H9_ATTESTATION_TIME_INVALID', '$');
  validateAuthority(attestation.authority, violations);
  if (
    !SHA256.test(attestation.authorityDigest || '')
    || attestation.authorityDigest !== digestCanonicalJson(attestation.authority)
  ) push(violations, 'H9_AUTHORITY_DIGEST_INVALID', 'authorityDigest');
  if (
    attestation.authority?.candidateCommitOid !== attestation.candidateCommitOid
    || attestation.authority?.candidateTreeOid !== attestation.candidateTreeOid
    || attestation.authority?.repository !== attestation.repository
  ) push(violations, 'H9_AUTHORITY_CANDIDATE_MISMATCH', 'authority');
  if (
    !exactRecord(attestation.auditor, ['engineDigest', 'id', 'version'])
    || !boundedString(attestation.auditor?.id, 1, 128)
    || !boundedString(attestation.auditor?.version, 1, 64)
    || !SHA256.test(attestation.auditor?.engineDigest || '')
  ) push(violations, 'H9_AUDITOR_IDENTITY_INVALID', 'auditor');

  if (policy) validateAttestationAgainstPolicy(attestation, policy, violations);
  return dedupe(violations);
}

export function evaluateFormalDelivery({
  policy,
  attestation,
  delivery,
  h8Qualification,
  enforcement,
  now = new Date().toISOString(),
  mode = 'formal'
}) {
  const violations = [...validateFormalCutoverPolicy(policy)];
  if (mode === 'provisional-only') {
    push(violations, 'H9_PROVISIONAL_MODE_NO_FORMAL_DELIVERY', 'mode');
  } else if (mode !== 'formal') {
    push(violations, 'H9_MODE_INVALID', 'mode');
  }
  if (!attestation) {
    push(violations, 'H9_ATTESTATION_REQUIRED', 'attestation');
  } else {
    violations.push(...validateFormalAttestation(attestation, policy));
  }
  validateDelivery(delivery, policy, attestation, violations);
  validateH8(h8Qualification, policy, attestation, violations);
  validateEnforcement(enforcement, policy, violations);
  validateFreshness(attestation, policy, now, violations);

  const unique = dedupe(violations);
  const invalidated = unique.some((item) => (
    item.code.includes('DIGEST')
    || item.code.includes('MISMATCH')
    || item.code.includes('SHAPE_INVALID')
    || item.code.includes('IDENTITY_INVALID')
  ));
  const accepted = unique.length === 0;
  return {
    schemaVersion: 1,
    status: accepted ? 'accepted' : invalidated ? 'invalidated' : 'blocked',
    outcome: accepted ? FORMAL_OUTCOME : invalidated ? 'INVALIDATED' : 'BLOCKED',
    formalEligible: accepted,
    reasonCodes: unique.map((item) => item.code),
    violations: unique
  };
}

function validateAttestationAgainstPolicy(attestation, policy, violations) {
  if (validateFormalCutoverPolicy(policy).length) return;
  const expectedWorkflowRef = `${policy.repository}/${policy.workflow.path}@refs/heads/${policy.protectedBranch}`;
  if (
    attestation.contractVersion !== policy.attestation.contractVersion
    || attestation.artifactType !== policy.attestation.requiredArtifactType
    || attestation.mode !== policy.attestation.requiredMode
    || attestation.outcome !== policy.attestation.requiredOutcome
    || attestation.repository !== policy.repository
    || attestation.formalCutoverPolicyDigest !== digestCanonicalJson(policy)
  ) push(violations, 'H9_ATTESTATION_POLICY_MISMATCH', '$');
  if (
    attestation.authority?.provider !== policy.provider
    || attestation.authority?.repository !== policy.repository
    || attestation.authority?.workflowPath !== policy.workflow.path
    || attestation.authority?.workflowRef !== expectedWorkflowRef
    || attestation.authority?.jobName !== policy.workflow.requiredCheckName
    || !policy.workflow.requiredEvents.includes(attestation.authority?.eventName)
    || attestation.authority?.protectedBranch !== policy.protectedBranch
  ) push(violations, 'H9_AUTHORITY_POLICY_MISMATCH', 'authority');
  if (
    attestation.auditor?.id !== policy.auditor.id
    || compareVersions(attestation.auditor?.version, policy.auditor.minimumVersion) < 0
  ) push(violations, 'H9_AUDITOR_POLICY_MISMATCH', 'auditor');
}

function validateAuthority(authority, violations) {
  if (!isRecord(authority) || !exactKeys(authority, AUTHORITY_KEYS)) {
    push(violations, 'H9_AUTHORITY_SHAPE_INVALID', 'authority');
    return;
  }
  if (
    authority.schemaVersion !== 1
    || authority.provider !== 'github-actions'
    || !repositoryName(authority.repository)
    || !safeRelativePath(authority.workflowPath)
    || !boundedString(authority.workflowRef, 1, 512)
    || !boundedString(authority.jobName, 1, 128)
    || !boundedString(authority.runId, 1, 64)
    || !integerBetween(authority.runAttempt, 1, 10_000)
    || !['merge_group', 'pull_request'].includes(authority.eventName)
    || !branchName(authority.protectedBranch)
    || !validDate(authority.observedAt)
    || !OID.test(authority.baseCommitOid || '')
    || !OID.test(authority.candidateCommitOid || '')
    || !OID.test(authority.candidateTreeOid || '')
    || !SHA256.test(authority.engineDigest || '')
  ) push(violations, 'H9_AUTHORITY_IDENTITY_INVALID', 'authority');
}

function validateLocalAudit(localAudit, policy, violations) {
  if (
    !exactRecord(localAudit, [
      'attestation',
      'executorVerdictIgnored',
      'outcome',
      'status',
      'violations'
    ])
    || localAudit.status !== 'attested'
    || localAudit.outcome !== 'LOCAL_ATTESTED'
    || localAudit.executorVerdictIgnored !== true
    || !Array.isArray(localAudit.violations)
    || localAudit.violations.length !== 0
  ) {
    push(violations, 'H9_LOCAL_AUDIT_INVALID', 'localAudit');
    return;
  }
  const local = localAudit.attestation;
  if (!isRecord(local) || !exactKeys(local, LOCAL_ATTESTATION_KEYS)) {
    push(violations, 'H9_LOCAL_ATTESTATION_SHAPE_INVALID', 'localAudit.attestation');
    return;
  }
  const unsigned = { ...local };
  delete unsigned.attestationDigest;
  if (
    !SHA256.test(local.attestationDigest || '')
    || local.attestationDigest !== digestCanonicalJson(unsigned)
  ) push(
    violations,
    'H9_LOCAL_ATTESTATION_DIGEST_INVALID',
    'localAudit.attestation.attestationDigest'
  );
  if (
    local.schemaVersion !== 1
    || local.artifactType !== 'FormalAttestation'
    || local.contractVersion !== 'harness-attestation-v4.0.0'
    || local.mode !== 'formal-local'
    || local.outcome !== 'LOCAL_ATTESTED'
    || !boundedString(local.runId, 1, 128)
    || !OID.test(local.candidateTreeOid || '')
    || !allDigests(local, [
      'candidateSnapshotDigest',
      'evidenceRootDigest',
      'executionPlanDigest',
      'executorEngineDigest',
      'invariantCatalogDigest',
      'policySnapshotDigest',
      'sourceAuthorityDigest'
    ])
  ) push(violations, 'H9_LOCAL_ATTESTATION_IDENTITY_INVALID', 'localAudit.attestation');
  if (
    !integerBetween(local.requiredCheckCount, 1, 10_000)
    || !integerBetween(local.requiredInvariantCount, 1, 10_000)
    || !Array.isArray(local.exceptionReferences)
    || local.exceptionReferences.length !== 0
  ) push(
    violations,
    'H9_LOCAL_ATTESTATION_REQUIREMENTS_INVALID',
    'localAudit.attestation'
  );
  if (
    !exactRecord(local.auditor, ['engineDigest', 'id', 'version'])
    || local.auditor?.id !== policy?.auditor?.id
    || !boundedString(local.auditor?.version, 1, 64)
    || !SHA256.test(local.auditor?.engineDigest || '')
  ) push(violations, 'H9_LOCAL_AUDITOR_INVALID', 'localAudit.attestation.auditor');
}

function validateIssuanceAuthority(authority, policy, local, violations) {
  if (!isRecord(authority) || !isRecord(policy) || !isRecord(local)) return;
  const expectedWorkflowRef = `${policy.repository}/${policy.workflow?.path}@refs/heads/${policy.protectedBranch}`;
  if (
    authority.provider !== policy.provider
    || authority.repository !== policy.repository
    || authority.workflowPath !== policy.workflow?.path
    || authority.workflowRef !== expectedWorkflowRef
    || authority.jobName !== policy.workflow?.requiredCheckName
    || !policy.workflow?.requiredEvents?.includes(authority.eventName)
    || authority.protectedBranch !== policy.protectedBranch
  ) push(violations, 'H9_AUTHORITY_POLICY_MISMATCH', 'authority');
  if (authority.candidateTreeOid !== local.candidateTreeOid) {
    push(violations, 'H9_LOCAL_AUTHORITY_TREE_MISMATCH', 'authority.candidateTreeOid');
  }
  if (authority.engineDigest !== local.auditor?.engineDigest) {
    push(violations, 'H9_LOCAL_AUTHORITY_ENGINE_MISMATCH', 'authority.engineDigest');
  }
}

function failedIssuance(violations) {
  const invalidated = violations.some((item) => (
    item.code.includes('DIGEST')
    || item.code.includes('MISMATCH')
    || item.code.includes('SHAPE_INVALID')
    || item.code.includes('IDENTITY_INVALID')
  ));
  return {
    status: invalidated ? 'invalidated' : 'blocked',
    outcome: invalidated ? 'INVALIDATED' : 'BLOCKED',
    violations,
    executorVerdictIgnored: true,
    attestation: null
  };
}

function validateDelivery(delivery, policy, attestation, violations) {
  if (
    !exactRecord(delivery, ['branch', 'commitOid', 'repository', 'treeOid'])
    || delivery?.repository !== policy?.repository
    || delivery?.branch !== policy?.protectedBranch
    || !OID.test(delivery?.commitOid || '')
    || !OID.test(delivery?.treeOid || '')
  ) {
    push(violations, 'H9_DELIVERY_IDENTITY_INVALID', 'delivery');
    return;
  }
  if (attestation && delivery.commitOid !== attestation.candidateCommitOid) {
    push(violations, 'H9_DELIVERY_COMMIT_MISMATCH', 'delivery.commitOid');
  }
  if (attestation && delivery.treeOid !== attestation.candidateTreeOid) {
    push(violations, 'H9_DELIVERY_TREE_MISMATCH', 'delivery.treeOid');
  }
}

function validateH8(value, policy, attestation, violations) {
  const valid = isRecord(value)
    && value.schemaVersion === 1
    && value.policyId === policy?.h8?.policyId
    && value.contractVersion === policy?.h8?.contractVersion
    && value.qualificationStatus === policy?.h8?.requiredQualificationStatus
    && value.eligibleForH9 === true
    && value.promotionAllowed === false
    && value.formalEligible === false
    && Array.isArray(value.violations)
    && value.violations.length === 0
    && SHA256.test(value.observationSetDigest || '')
    && value.metrics?.observedRunCount >= 20
    && value.metrics?.distinctRunCount >= 20
    && value.metrics?.windowDurationDays >= 7
    && value.metrics?.trustRootChangeRunCount >= 1
    && value.metrics?.unexplainedDecisionDivergences === 0
    && value.metrics?.businessProfileCoverage === 1
    && value.metrics?.reproducibilityRate === 1
    && value.drillResults?.rollback?.passed === true
    && value.drillResults?.['compromised-judge']?.passed === true;
  if (!valid) {
    push(violations, 'H9_H8_QUALIFICATION_REQUIRED', 'h8Qualification');
    return;
  }
  if (
    attestation
    && attestation.h8QualificationDigest !== digestCanonicalJson(value)
  ) push(violations, 'H9_H8_QUALIFICATION_DIGEST_MISMATCH', 'h8Qualification');
}

function validateEnforcement(value, policy, violations) {
  if (
    !exactRecord(value, [
      'evidenceDigest',
      'installed',
      'mode',
      'protectedBranch',
      'provider',
      'repository',
      'requiredCheckName',
      'schemaVersion',
      'verifiedAt'
    ])
    || value?.schemaVersion !== 1
    || value?.provider !== 'github'
    || value?.repository !== policy?.repository
    || value?.protectedBranch !== policy?.protectedBranch
    || !policy?.externalEnforcement?.allowedModes?.includes(value?.mode)
    || value?.requiredCheckName !== policy?.workflow?.requiredCheckName
    || value?.installed !== true
    || !validDate(value?.verifiedAt)
    || !SHA256.test(value?.evidenceDigest || '')
  ) push(violations, 'H9_EXTERNAL_ENFORCEMENT_REQUIRED', 'enforcement');
}

function validateFreshness(attestation, policy, now, violations) {
  if (!attestation || !validDate(now) || !validDate(attestation.issuedAt) || !validDate(attestation.expiresAt)) {
    if (!validDate(now)) push(violations, 'H9_VERIFICATION_TIME_INVALID', 'now');
    return;
  }
  const nowMs = Date.parse(now);
  const issuedMs = Date.parse(attestation.issuedAt);
  const expiresMs = Date.parse(attestation.expiresAt);
  if (issuedMs - nowMs > (policy?.freshness?.maxFutureSkewSeconds || 0) * 1000) {
    push(violations, 'H9_ATTESTATION_FROM_FUTURE', 'attestation.issuedAt');
  }
  if (
    expiresMs < nowMs
    || nowMs - issuedMs > (policy?.freshness?.maxAgeSeconds || 0) * 1000
  ) push(violations, 'H9_ATTESTATION_STALE', 'attestation.expiresAt');
}

function allDigests(value, keys) {
  return keys.every((key) => SHA256.test(value?.[key] || ''));
}

function exactRecord(value, keys) {
  return isRecord(value) && exactKeys(value, new Set(keys));
}

function exactKeys(value, expected) {
  return isRecord(value)
    && Object.keys(value).length === expected.size
    && Object.keys(value).every((key) => expected.has(key));
}

function uniqueStrings(value, min, max) {
  return Array.isArray(value)
    && value.length >= min
    && value.length <= max
    && value.every((item) => boundedString(item, 1, 128))
    && new Set(value).size === value.length;
}

function boundedString(value, min, max) {
  return typeof value === 'string'
    && value.length >= min
    && value.length <= max
    && !/[\0\r\n]/.test(value);
}

function repositoryName(value) {
  return boundedString(value, 3, 200)
    && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function branchName(value) {
  return boundedString(value, 1, 128)
    && SAFE_ID.test(value)
    && !value.includes('..');
}

function safeRelativePath(value) {
  return boundedString(value, 1, 260)
    && !value.startsWith('/')
    && !value.startsWith('\\')
    && !value.includes('..')
    && !value.includes('\\');
}

function validDate(value) {
  return boundedString(value, 1, 64) && Number.isFinite(Date.parse(value));
}

function integerBetween(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function compareVersions(left, right) {
  if (!boundedString(left, 1, 64) || !boundedString(right, 1, 64)) return -1;
  const parse = (value) => value.split(/[^0-9]+/).filter(Boolean).map(Number);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] || 0) - (b[index] || 0);
    if (delta) return delta;
  }
  return 0;
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function push(items, code, safePath) {
  items.push({ code, safePath });
}

function dedupe(items) {
  const unique = new Map();
  for (const item of items) unique.set(`${item.code}:${item.safePath}`, item);
  return [...unique.values()].sort(
    (left, right) => left.code.localeCompare(right.code) || left.safePath.localeCompare(right.safePath)
  );
}
