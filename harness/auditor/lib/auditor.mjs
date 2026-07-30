import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const CHECK_OUTCOMES = new Set(['PASS', 'FAIL', 'BLOCKED', 'ERROR', 'CANCELED', 'NOT_APPLICABLE']);
const COMMAND_KEYS = new Set(['args', 'executable', 'policy', 'schemaVersion']);
const POLICY_KEYS = new Set(['environment', 'network', 'resources', 'writablePaths']);
const RESOURCE_KEYS = new Set(['maxMemoryMb', 'maxOutputBytes', 'maxProcesses', 'timeoutMs']);
const NETWORK_KEYS = new Set(['allowedDestinations', 'invariantPolicyId', 'mode']);
const ENVIRONMENT_KEYS = new Set(['allow', 'values']);
const FORBIDDEN_EXECUTABLES = new Set([
  'bash', 'bash.exe', 'cmd', 'cmd.exe', 'command', 'dash', 'fish',
  'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'sh', 'sh.exe',
  'wsl', 'wsl.exe', 'zsh'
]);
const BINDING_KEYS = [
  'baselineSnapshotDigest',
  'bindingDigest',
  'configFileDigest',
  'configPath',
  'contractVersion',
  'engineDigest',
  'gitCandidateBaselineDigest',
  'impactReportDigest',
  'policySnapshotDigest',
  'runId',
  'schemaVersion',
  'sourceAuthorityFileDigest',
  'sourceAuthorityPath',
  'sourceAuthoritySnapshotDigest',
  'validationPlanDigest'
];

export function auditRun({ root, runDir, mode = 'formal-local' }) {
  const violations = [];
  const resolvedRoot = path.resolve(root);
  const resolvedRunDir = path.resolve(runDir);
  if (!isWithin(resolvedRoot, resolvedRunDir)) return blocked('AUDITOR_RUN_PATH_OUTSIDE_REPOSITORY');
  if (mode !== 'formal-local') return blocked('AUDITOR_MODE_NOT_QUALIFIED');

  const manifest = readJsonStrict(path.join(resolvedRunDir, 'run-manifest.json'), 'AUDITOR_MANIFEST_UNAVAILABLE', violations);
  const plan = readJsonStrict(path.join(resolvedRunDir, 'validation-plan.json'), 'AUDITOR_PLAN_UNAVAILABLE', violations);
  const impact = readJsonStrict(path.join(resolvedRunDir, 'impact-report.json'), 'AUDITOR_IMPACT_UNAVAILABLE', violations);
  const binding = readJsonStrict(path.join(resolvedRunDir, 'run-binding.json'), 'AUDITOR_BINDING_UNAVAILABLE', violations);
  const evidenceIndex = readJsonStrict(path.join(resolvedRunDir, 'evidence-index.json'), 'AUDITOR_EVIDENCE_INDEX_UNAVAILABLE', violations);
  if (!manifest || !plan || !impact || !binding || !evidenceIndex) return finishFailure(violations);

  if (manifest.schemaVersion !== 6) add(violations, 'AUDITOR_MANIFEST_VERSION_UNSUPPORTED', 'run-manifest.json.schemaVersion');
  if (plan.schemaVersion !== 4) add(violations, 'AUDITOR_PLAN_VERSION_UNSUPPORTED', 'validation-plan.json.schemaVersion');
  if (!exactKeys(binding, BINDING_KEYS)) add(violations, 'AUDITOR_BINDING_SHAPE_INVALID', 'run-binding.json');
  if (manifest.runId !== binding.runId || evidenceIndex.runId !== binding.runId) add(violations, 'AUDITOR_RUN_ID_MISMATCH', 'runId');
  if (canonicalJson(manifest.evidence?.sealedBinding) !== canonicalJson(binding)) {
    add(violations, 'AUDITOR_BINDING_RECORD_MISMATCH', 'run-binding.json');
  }
  const unsignedBinding = { ...binding };
  delete unsignedBinding.bindingDigest;
  if (binding.bindingDigest !== digestCanonical(unsignedBinding)) {
    add(violations, 'AUDITOR_BINDING_DIGEST_MISMATCH', 'run-binding.json.bindingDigest');
  }
  if (binding.validationPlanDigest !== digestCanonical(plan)) add(violations, 'AUDITOR_PLAN_DIGEST_MISMATCH', 'validation-plan.json');
  if (binding.impactReportDigest !== digestCanonical(impact)) add(violations, 'AUDITOR_IMPACT_DIGEST_MISMATCH', 'impact-report.json');
  verifyBoundFile(resolvedRoot, binding.configPath, binding.configFileDigest, 'AUDITOR_POLICY_SOURCE_DRIFT', violations);
  verifyBoundFile(resolvedRoot, binding.sourceAuthorityPath, binding.sourceAuthorityFileDigest, 'AUDITOR_SOURCE_AUTHORITY_DRIFT', violations);
  if (binding.engineDigest !== digestExecutorEngine(resolvedRoot)) add(violations, 'AUDITOR_EXECUTOR_ENGINE_DRIFT', 'harness');

  const catalogPath = safeJoin(resolvedRoot, plan.invariantCatalog?.path, violations, 'AUDITOR_CATALOG_PATH_INVALID');
  const catalog = catalogPath ? readJsonStrict(catalogPath, 'AUDITOR_CATALOG_UNAVAILABLE', violations) : null;
  if (!catalog || digestCanonical(catalog) !== plan.invariantCatalog?.digest) {
    add(violations, 'AUDITOR_CATALOG_DIGEST_MISMATCH', 'invariantCatalog');
  }
  verifyPlanGraph(plan, violations);

  const baseline = manifest.gitCandidate?.baseline;
  verifyCandidateDigest(baseline, 'gitCandidate.baseline', violations);
  if (binding.gitCandidateBaselineDigest !== baseline?.snapshotDigest) {
    add(violations, 'AUDITOR_CANDIDATE_BINDING_MISMATCH', 'gitCandidate.baseline');
  }
  let currentCandidate = null;
  try {
    currentCandidate = captureCandidate(resolvedRoot);
  } catch {
    add(violations, 'AUDITOR_GIT_OBSERVATION_FAILED', 'git');
  }
  if (currentCandidate && baseline) {
    compare(violations, baseline, currentCandidate, 'headCommitOid', 'AUDITOR_HEAD_COMMIT_DRIFT');
    compare(violations, baseline, currentCandidate, 'headTreeOid', 'AUDITOR_HEAD_TREE_DRIFT');
    compare(violations, baseline, currentCandidate, 'branchMode', 'AUDITOR_BRANCH_MODE_DRIFT');
    compare(violations, baseline, currentCandidate, 'branchName', 'AUDITOR_BRANCH_DRIFT');
    if (currentCandidate.indexTreeOid !== currentCandidate.headTreeOid) {
      add(violations, 'AUDITOR_CANDIDATE_INDEX_NOT_FROZEN', 'git.indexTreeOid');
    }
    if (currentCandidate.statusEntries.length > 0) add(violations, 'AUDITOR_CANDIDATE_WORKTREE_DIRTY', 'git.status');
  }

  const validationEvidence = readValidationEvidence({
    runDir: resolvedRunDir,
    runId: binding.runId,
    evidenceIndex,
    violations
  });
  const validationResult = validationEvidence?.value || null;
  if (validationResult && currentCandidate) {
    if (validationResult.candidateValidation?.snapshotDigest !== currentCandidate.snapshotDigest) {
      add(violations, 'AUDITOR_VALIDATION_CANDIDATE_MISMATCH', 'validation-result.candidateValidation');
    }
    verifyRequiredResults({ plan, validationResult, binding, currentCandidate, violations });
  }
  if (validationEvidence) {
    const requiredParents = [
      binding.bindingDigest,
      binding.validationPlanDigest,
      binding.impactReportDigest,
      currentCandidate?.snapshotDigest,
      plan.invariantCatalog?.digest
    ].filter(Boolean);
    for (const digest of requiredParents) {
      if (!validationEvidence.parentDigests.includes(digest)) {
        add(violations, 'AUDITOR_EVIDENCE_PARENT_MISSING', 'evidence.validation-result.parentDigests');
      }
    }
  }

  if (violations.length) return finishFailure(violations);
  const record = {
    schemaVersion: 1,
    artifactType: 'FormalAttestation',
    contractVersion: 'harness-attestation-v4.0.0',
    mode,
    runId: binding.runId,
    outcome: 'LOCAL_ATTESTED',
    candidateTreeOid: currentCandidate.indexTreeOid,
    candidateSnapshotDigest: currentCandidate.snapshotDigest,
    executorEngineDigest: binding.engineDigest,
    policySnapshotDigest: binding.policySnapshotDigest,
    sourceAuthorityDigest: binding.sourceAuthorityFileDigest,
    invariantCatalogDigest: plan.invariantCatalog.digest,
    executionPlanDigest: binding.validationPlanDigest,
    evidenceRootDigest: digestCanonical(evidenceIndex),
    requiredCheckCount: plan.commands.filter((item) => item.required).length,
    requiredInvariantCount: plan.invariantPlan.acceptanceRequirements.length,
    exceptionReferences: [],
    auditor: {
      id: 'harness-independent-auditor',
      version: '4.0.0-h5',
      engineDigest: digestAuditorEngine()
    }
  };
  return {
    status: 'attested',
    outcome: 'LOCAL_ATTESTED',
    violations: [],
    executorVerdictIgnored: true,
    attestation: { ...record, attestationDigest: digestCanonical(record) }
  };
}

function verifyRequiredResults({ plan, validationResult, binding, currentCandidate, violations }) {
  const requiredCommands = plan.commands.filter((item) => item.required);
  if (!requiredCommands.length) add(violations, 'AUDITOR_REQUIRED_CHECKS_EMPTY', 'validationPlan.commands');
  const results = Array.isArray(validationResult.results) ? validationResult.results : [];
  const byCommand = new Map();
  for (const result of results) {
    const commandId = result.commandId || result.id;
    if (!byCommand.has(commandId)) byCommand.set(commandId, []);
    byCommand.get(commandId).push(result);
    if (!CHECK_OUTCOMES.has(result.outcome)) add(violations, 'AUDITOR_CHECK_OUTCOME_UNKNOWN', `result.${commandId}`);
    if (result.outcome === 'FAIL') add(violations, 'AUDITOR_CHECK_FAILED', `result.${commandId}`);
    if (['BLOCKED', 'ERROR', 'CANCELED'].includes(result.outcome)) add(violations, 'AUDITOR_CHECK_INCOMPLETE', `result.${commandId}`);
  }
  for (const command of requiredCommands) {
    const matches = byCommand.get(command.id) || [];
    if (matches.length !== 1) {
      add(violations, matches.length ? 'AUDITOR_REQUIRED_RESULT_AMBIGUOUS' : 'AUDITOR_REQUIRED_RESULT_MISSING', `result.${command.id}`);
      continue;
    }
    const result = matches[0];
    if (result.outcome !== 'PASS' || result.exitCode !== 0 || result.required !== true) {
      add(violations, 'AUDITOR_REQUIRED_RESULT_NOT_PASS', `result.${command.id}`);
    }
    const evidence = result.evidenceBinding;
    if (
      evidence?.runId !== binding.runId
      || evidence?.bindingDigest !== binding.bindingDigest
      || evidence?.validationPlanDigest !== binding.validationPlanDigest
      || evidence?.gitCandidateSnapshotDigest !== currentCandidate.snapshotDigest
      || evidence?.invariantCatalogDigest !== plan.invariantCatalog.digest
    ) add(violations, 'AUDITOR_CHECK_BINDING_MISMATCH', `result.${command.id}.evidenceBinding`);
    if (evidence?.commandSpecDigest !== commandSpecDigest(result)) {
      add(violations, 'AUDITOR_COMMAND_SPEC_DIGEST_MISMATCH', `result.${command.id}.commandSpecDigest`);
    }
  }
  const acceptanceIds = new Set();
  for (const requirement of plan.invariantPlan.acceptanceRequirements || []) {
    if (acceptanceIds.has(requirement.acceptanceId)) add(violations, 'AUDITOR_ACCEPTANCE_ID_DUPLICATE', `acceptance.${requirement.acceptanceId}`);
    acceptanceIds.add(requirement.acceptanceId);
    if (!requirement.resultIds?.length) add(violations, 'AUDITOR_ACCEPTANCE_RESULTS_EMPTY', `acceptance.${requirement.acceptanceId}`);
    for (const resultId of requirement.resultIds || []) {
      const result = (byCommand.get(resultId) || [])[0];
      if (!result || result.outcome !== 'PASS') add(violations, 'AUDITOR_ACCEPTANCE_RESULT_NOT_PASS', `acceptance.${requirement.acceptanceId}`);
    }
  }
}

function readValidationEvidence({ runDir, runId, evidenceIndex, violations }) {
  if (!exactKeys(evidenceIndex, ['entries', 'runId', 'schemaVersion']) || evidenceIndex.schemaVersion !== 1) {
    add(violations, 'AUDITOR_EVIDENCE_INDEX_SHAPE_INVALID', 'evidence-index.json');
    return null;
  }
  const entries = Array.isArray(evidenceIndex.entries) ? evidenceIndex.entries : [];
  const validationEntries = entries.filter((item) => item?.kind === 'validation-result');
  if (validationEntries.length !== 1) {
    add(violations, 'AUDITOR_VALIDATION_EVIDENCE_AMBIGUOUS', 'evidence-index.json.entries');
    return null;
  }
  const entry = validationEntries[0];
  if (!exactKeys(entry, ['digest', 'kind', 'parentDigests', 'path'])) {
    add(violations, 'AUDITOR_EVIDENCE_ENTRY_SHAPE_INVALID', 'evidence.validation-result');
    return null;
  }
  const objectPath = safeJoin(runDir, entry.path, violations, 'AUDITOR_EVIDENCE_PATH_INVALID');
  const object = objectPath ? readJsonStrict(objectPath, 'AUDITOR_EVIDENCE_OBJECT_UNAVAILABLE', violations) : null;
  if (!object) return null;
  if (!exactKeys(object, ['kind', 'parentDigests', 'runId', 'schemaVersion', 'value'])) {
    add(violations, 'AUDITOR_EVIDENCE_OBJECT_SHAPE_INVALID', 'evidence.validation-result');
  }
  const digest = digestCanonical(object);
  if (digest !== entry.digest || path.basename(entry.path, '.json') !== digest.slice('sha256:'.length)) {
    add(violations, 'AUDITOR_EVIDENCE_OBJECT_DIGEST_MISMATCH', 'evidence.validation-result');
  }
  if (object.runId !== runId || object.kind !== 'validation-result') {
    add(violations, 'AUDITOR_EVIDENCE_OBJECT_IDENTITY_MISMATCH', 'evidence.validation-result');
  }
  if (canonicalJson(object.parentDigests) !== canonicalJson(entry.parentDigests)) {
    add(violations, 'AUDITOR_EVIDENCE_PARENT_INDEX_MISMATCH', 'evidence.validation-result.parentDigests');
  }
  return object;
}

function verifyPlanGraph(plan, violations) {
  const commands = Array.isArray(plan.commands) ? plan.commands : [];
  const nodes = Array.isArray(plan.graph?.nodes) ? plan.graph.nodes.filter((item) => item.kind !== 'manual-guard') : [];
  const commandIds = new Set();
  for (const command of commands) {
    if (!command?.id || commandIds.has(command.id)) add(violations, 'AUDITOR_PLAN_COMMAND_ID_INVALID', 'validationPlan.commands');
    commandIds.add(command.id);
    verifyCommandContract(command, violations);
  }
  const nodeIds = new Set();
  const coverage = new Map();
  for (const node of nodes) {
    if (!node?.id || nodeIds.has(node.id)) add(violations, 'AUDITOR_PLAN_NODE_ID_INVALID', 'validationPlan.graph.nodes');
    nodeIds.add(node.id);
    const commandId = node.commandId || node.id;
    coverage.set(commandId, (coverage.get(commandId) || 0) + 1);
  }
  for (const command of commands.filter((item) => item.required)) {
    if (coverage.get(command.id) !== 1) add(violations, 'AUDITOR_PLAN_REQUIRED_NODE_INVALID', `command.${command.id}`);
  }
  if (plan.requiredCheckCount !== commands.filter((item) => item.required).length) {
    add(violations, 'AUDITOR_PLAN_REQUIRED_COUNT_MISMATCH', 'validationPlan.requiredCheckCount');
  }
}

function verifyCommandContract(command, violations) {
  const contract = command?.command;
  const safePath = `command.${command?.id || '<unknown>'}.command`;
  if (command?.available !== true) {
    if (contract !== null) add(violations, 'AUDITOR_UNAVAILABLE_COMMAND_NOT_NULL', safePath);
    return;
  }
  if (!isRecord(contract) || !exactKeySet(contract, COMMAND_KEYS) || contract.schemaVersion !== 1) {
    add(violations, 'AUDITOR_COMMAND_CONTRACT_INVALID', safePath);
    return;
  }
  const executable = contract.executable;
  if (
    typeof executable !== 'string'
    || !executable.trim()
    || FORBIDDEN_EXECUTABLES.has(path.basename(executable).toLowerCase())
    || /[\0\r\n]/.test(executable)
  ) {
    add(violations, 'AUDITOR_COMMAND_EXECUTABLE_INVALID', `${safePath}.executable`);
  }
  if (
    !Array.isArray(contract.args)
    || contract.args.length > 256
    || contract.args.some((item) => typeof item !== 'string' || item.length > 16_384 || /[\0\r\n]/.test(item))
  ) {
    add(violations, 'AUDITOR_COMMAND_ARGS_INVALID', `${safePath}.args`);
  }
  if ((contract.args || []).some(secretShaped)) {
    add(violations, 'AUDITOR_COMMAND_SECRET_ARGUMENT', `${safePath}.args`);
  }
  const policy = contract.policy;
  if (!isRecord(policy) || !exactKeySet(policy, POLICY_KEYS)) {
    add(violations, 'AUDITOR_COMMAND_POLICY_INVALID', `${safePath}.policy`);
    return;
  }
  verifyResourcePolicy(policy.resources, `${safePath}.policy.resources`, violations);
  verifyNetworkPolicy(policy.network, `${safePath}.policy.network`, violations);
  verifyEnvironmentPolicy(policy.environment, `${safePath}.policy.environment`, violations);
  if (
    !Array.isArray(policy.writablePaths)
    || policy.writablePaths.length > 32
    || policy.writablePaths.some((item) => typeof item !== 'string' || !item.trim() || path.isAbsolute(item) || item.includes('\0'))
  ) {
    add(violations, 'AUDITOR_COMMAND_WRITABLE_PATHS_INVALID', `${safePath}.policy.writablePaths`);
  }
}

function verifyResourcePolicy(value, safePath, violations) {
  if (!isRecord(value) || !exactKeySet(value, RESOURCE_KEYS)) {
    add(violations, 'AUDITOR_COMMAND_RESOURCES_INVALID', safePath);
    return;
  }
  const ranges = {
    timeoutMs: [50, 3_600_000],
    maxOutputBytes: [256, 50 * 1024 * 1024],
    maxMemoryMb: [32, 16_384],
    maxProcesses: [1, 64]
  };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max) {
      add(violations, 'AUDITOR_COMMAND_RESOURCE_LIMIT_INVALID', `${safePath}.${key}`);
    }
  }
}

function verifyNetworkPolicy(value, safePath, violations) {
  if (!isRecord(value) || !exactKeySet(value, NETWORK_KEYS)) {
    add(violations, 'AUDITOR_COMMAND_NETWORK_POLICY_INVALID', safePath);
    return;
  }
  const destinationsValid = Array.isArray(value.allowedDestinations)
    && value.allowedDestinations.every((item) => typeof item === 'string' && item.trim());
  if (!['deny', 'allow'].includes(value.mode) || !destinationsValid) {
    add(violations, 'AUDITOR_COMMAND_NETWORK_POLICY_INVALID', safePath);
  } else if (value.mode === 'deny' && value.allowedDestinations.length) {
    add(violations, 'AUDITOR_COMMAND_NETWORK_DENY_DESTINATIONS', `${safePath}.allowedDestinations`);
  } else if (
    value.mode === 'allow'
    && (
      typeof value.invariantPolicyId !== 'string'
      || !value.invariantPolicyId.trim()
      || !value.allowedDestinations.length
    )
  ) {
    add(violations, 'AUDITOR_COMMAND_NETWORK_ALLOW_UNBOUND', safePath);
  }
}

function verifyEnvironmentPolicy(value, safePath, violations) {
  if (!isRecord(value) || !exactKeySet(value, ENVIRONMENT_KEYS)) {
    add(violations, 'AUDITOR_COMMAND_ENVIRONMENT_POLICY_INVALID', safePath);
    return;
  }
  if (
    !Array.isArray(value.allow)
    || value.allow.some((item) => typeof item !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/i.test(item))
    || !isRecord(value.values)
    || Object.entries(value.values).some(([key, item]) => (
      !/^[A-Z][A-Z0-9_]{0,63}$/i.test(key)
      || typeof item !== 'string'
      || secretShaped(`${key}=${item}`)
    ))
  ) {
    add(violations, 'AUDITOR_COMMAND_ENVIRONMENT_POLICY_INVALID', safePath);
  }
}

function secretShaped(value) {
  return /\bsk-[A-Za-z0-9_-]{12,}\b/.test(value)
    || /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*\b/i.test(value)
    || /(?:api[_-]?key|authorization|credential|password|private[_-]?key|provider[_-]?secret|secret|token)\s*[:=]/i.test(value);
}

function exactKeySet(value, expected) {
  return isRecord(value)
    && Object.keys(value).length === expected.size
    && Object.keys(value).every((key) => expected.has(key));
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function verifyCandidateDigest(candidate, safePath, violations) {
  if (!candidate || typeof candidate !== 'object') {
    add(violations, 'AUDITOR_CANDIDATE_MISSING', safePath);
    return;
  }
  const unsigned = { ...candidate };
  delete unsigned.snapshotDigest;
  if (candidate.snapshotDigest !== digestCanonical(unsigned)) add(violations, 'AUDITOR_CANDIDATE_DIGEST_MISMATCH', `${safePath}.snapshotDigest`);
}

function captureCandidate(root) {
  const headCommitOid = git(root, ['rev-parse', '--verify', 'HEAD']).trim();
  const headTreeOid = git(root, ['rev-parse', '--verify', 'HEAD^{tree}']).trim();
  const branchResult = runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const branchMode = branchResult.status === 0 ? 'branch' : 'detached';
  const branchName = branchResult.status === 0 ? branchResult.stdout.trim() : null;
  const indexEntries = parseIndex(git(root, ['ls-files', '--stage', '-z', '--full-name']));
  const indexTreeOid = computeAuditorIndexTreeOid(indexEntries, headCommitOid.length);
  const statusEntries = parseStatus(git(root, ['status', '--porcelain=v1', '-z', '-uall', '--ignored=no']));
  const record = {
    schemaVersion: 1,
    contractVersion: 'harness-git-candidate-v4.0.0',
    headCommitOid,
    headTreeOid,
    branchMode,
    branchName,
    indexTreeOid,
    indexDigest: digestCanonical(indexEntries),
    stagedPatchDigest: digestText(git(root, ['diff', '--cached', '--binary', '--full-index', '--no-ext-diff', '--no-color'])),
    statusDigest: digestCanonical(statusEntries),
    worktreeDigest: digestCanonical(statusEntries.map((item) => ({
      path: item.path,
      oldPath: item.oldPath,
      status: item.status,
      contentDigest: digestPath(root, item.path)
    })))
  };
  return { ...record, snapshotDigest: digestCanonical(record), statusEntries };
}

function parseStatus(stdout) {
  const tokens = stdout.split('\0');
  const changes = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token.length < 4 || token[2] !== ' ') throw new Error('status parse');
    const status = token.slice(0, 2);
    let oldPath = null;
    if (status.includes('R') || status.includes('C')) {
      index += 1;
      oldPath = tokens[index];
      if (!oldPath) throw new Error('status rename parse');
    }
    changes.push({
      path: normalizePath(token.slice(3)),
      oldPath: oldPath ? normalizePath(oldPath) : null,
      kind: status === '??' ? 'untracked' : status.includes('D') ? 'deleted' : status.includes('A') ? 'added' : status.includes('R') ? 'renamed' : 'modified',
      status,
      indexStatus: status[0],
      worktreeStatus: status[1]
    });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

function parseIndex(stdout) {
  return stdout.split('\0').filter(Boolean).map((token) => {
    const match = /^([0-7]{6}) ([a-f0-9]{40,64}) ([0-3])\t([\s\S]+)$/.exec(token);
    if (!match) throw new Error('index parse');
    return { path: normalizePath(match[4]), mode: match[1], objectId: match[2], stage: Number(match[3]) };
  }).sort((a, b) => a.path.localeCompare(b.path) || a.stage - b.stage);
}

function computeAuditorIndexTreeOid(indexEntries, objectIdLengthHint) {
  const root = auditorTreeNode();
  let objectIdLength = null;
  for (const entry of indexEntries) {
    if (!entry || entry.stage !== 0) throw new Error('unmerged index');
    const mode = auditorTreeMode(entry.mode);
    if (!mode || !/^[a-f0-9]{40,64}$/.test(entry.objectId || '')) throw new Error('invalid index entry');
    objectIdLength ??= entry.objectId.length;
    if (entry.objectId.length !== objectIdLength) throw new Error('mixed object format');
    const normalized = normalizePath(entry.path || '');
    const segments = normalized.split('/');
    if (
      !normalized
      || normalized.startsWith('/')
      || /^[A-Za-z]:/.test(normalized)
      || segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('\0'))
    ) throw new Error('invalid index path');
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      if (node.entries.has(segment)) throw new Error('index path conflict');
      if (!node.children.has(segment)) node.children.set(segment, auditorTreeNode());
      node = node.children.get(segment);
    }
    const name = segments.at(-1);
    if (node.entries.has(name) || node.children.has(name)) throw new Error('index path conflict');
    node.entries.set(name, { mode, objectId: entry.objectId });
  }
  objectIdLength ??= objectIdLengthHint;
  const algorithm = objectIdLength === 64 ? 'sha256' : objectIdLength === 40 || objectIdLength === null ? 'sha1' : null;
  if (!algorithm) throw new Error('unsupported object format');
  return auditorHashTree(root, algorithm);
}

function auditorTreeNode() {
  return { children: new Map(), entries: new Map() };
}

function auditorTreeMode(value) {
  const mode = String(value || '');
  if (!['040000', '100644', '100755', '120000', '160000'].includes(mode)) return null;
  return mode === '040000' ? '40000' : mode;
}

function auditorHashTree(node, algorithm) {
  const entries = [];
  for (const [name, value] of node.entries) entries.push({ name, ...value });
  for (const [name, child] of node.children) {
    entries.push({ name, mode: '40000', objectId: auditorHashTree(child, algorithm) });
  }
  entries.sort((left, right) => Buffer.compare(
    Buffer.from(`${left.name}${left.mode === '40000' ? '/' : ''}`, 'utf8'),
    Buffer.from(`${right.name}${right.mode === '40000' ? '/' : ''}`, 'utf8')
  ));
  const body = Buffer.concat(entries.flatMap((entry) => [
    Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'),
    Buffer.from(entry.objectId, 'hex')
  ]));
  return crypto.createHash(algorithm)
    .update(Buffer.concat([Buffer.from(`tree ${body.length}\0`, 'utf8'), body]))
    .digest('hex');
}

function digestPath(root, relPath) {
  const target = path.join(root, relPath);
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) return digestText(`symlink:${fs.readlinkSync(target)}`);
    if (!stat.isFile()) return digestText(`non-file:${stat.mode}`);
    return digestBytes(fs.readFileSync(target));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function digestExecutorEngine(root) {
  const files = [
    path.join(root, 'harness', 'cli.mjs'),
    ...walk(path.join(root, 'harness', 'lib')).filter((file) => file.endsWith('.mjs'))
  ].filter((file) => fs.existsSync(file)).sort();
  const chunks = [];
  for (const file of files) chunks.push(normalizePath(path.relative(root, file)), '\0', digestBytes(fs.readFileSync(file)), '\0');
  return digestBytes(Buffer.from(chunks.join(''), 'utf8'));
}

function digestAuditorEngine() {
  const libDir = path.dirname(fileURLToPath(import.meta.url));
  const auditorDir = path.resolve(libDir, '..');
  const files = walk(auditorDir).filter((file) => file.endsWith('.mjs')).sort();
  const chunks = [];
  for (const file of files) chunks.push(normalizePath(path.relative(auditorDir, file)), '\0', digestBytes(fs.readFileSync(file)), '\0');
  return digestBytes(Buffer.from(chunks.join(''), 'utf8'));
}

function commandSpecDigest(result) {
  return digestText(JSON.stringify({
    id: result.commandId || result.id,
    command: result.command || null,
    required: Boolean(result.required),
    tier: result.tier || null,
    dependsOn: result.dependsOn || [],
    invariantIds: result.invariantIds || []
  }));
}

function verifyBoundFile(root, relPath, expected, code, violations) {
  if (!relPath && !expected) return;
  const file = safeJoin(root, relPath, violations, code);
  if (!file || !expected || !fs.existsSync(file) || digestBytes(fs.readFileSync(file)) !== expected) add(violations, code, relPath || 'missing');
}

function safeJoin(base, relPath, violations, code) {
  if (typeof relPath !== 'string' || !relPath || path.isAbsolute(relPath)) {
    add(violations, code, 'path');
    return null;
  }
  const target = path.resolve(base, relPath);
  if (!isWithin(base, target)) {
    add(violations, code, 'path');
    return null;
  }
  return target;
}

function readJsonStrict(file, code, violations) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    add(violations, code, path.basename(file));
    return null;
  }
}

function finishFailure(violations) {
  const codes = violations.map((item) => item.code);
  const invalidated = codes.some((code) => /DIGEST|DRIFT|MISMATCH|CANDIDATE|TAMPER/.test(code));
  const failed = codes.includes('AUDITOR_CHECK_FAILED');
  return {
    status: invalidated ? 'invalidated' : failed ? 'failed' : 'blocked',
    outcome: invalidated ? 'INVALIDATED' : failed ? 'FAIL' : 'BLOCKED',
    violations: uniqueViolations(violations),
    executorVerdictIgnored: true,
    attestation: null
  };
}

function blocked(code) {
  return {
    status: 'blocked',
    outcome: 'BLOCKED',
    violations: [{ code, safePath: '$' }],
    executorVerdictIgnored: true,
    attestation: null
  };
}

function git(root, args) {
  const result = runGit(root, args);
  if (result.status !== 0) throw new Error('git observation failed');
  return result.stdout;
}

function runGit(root, args) {
  return spawnSync('git', ['--no-optional-locks', '-c', 'core.quotepath=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 50 * 1024 * 1024,
    windowsHide: true
  });
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function canonicalJson(value, seen = new Set()) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, seen)).join(',')}]`;
  if (typeof value !== 'object') throw new Error('unsupported');
  if (seen.has(value)) throw new Error('cyclic');
  seen.add(value);
  const serialized = `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`).join(',')}}`;
  seen.delete(value);
  return serialized;
}

function digestCanonical(value) {
  return digestText(canonicalJson(value));
}

function digestText(value) {
  return digestBytes(Buffer.from(String(value), 'utf8'));
}

function digestBytes(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function exactKeys(value, keys) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function isWithin(base, target) {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function normalizePath(value) {
  return String(value).replace(/\\/g, '/').replace(/^\.\//, '');
}

function compare(violations, expected, actual, field, code) {
  if (expected[field] !== actual[field]) add(violations, code, `gitCandidate.${field}`);
}

function add(violations, code, safePath) {
  violations.push({ code, safePath });
}

function uniqueViolations(violations) {
  const seen = new Set();
  return violations.filter((item) => {
    const key = `${item.code}:${item.safePath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
