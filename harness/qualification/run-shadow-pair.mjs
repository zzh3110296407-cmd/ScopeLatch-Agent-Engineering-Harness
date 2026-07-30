import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditRun } from '../auditor/lib/auditor.mjs';
import { normalizePath, runFile } from '../lib/common.mjs';
import { digestCanonicalJson } from '../lib/v4/canonical-json.mjs';
import { sealShadowObservation } from '../lib/v4/shadow-qualification.mjs';
import { safeExecute } from '../lib/v4/safe-executor.mjs';

// H8 observations seal bounded execution diagnostics; raw process output never enters the artifact contract.
const MAX_DIAGNOSTIC_ITEMS = 64;
const H8_RUNTIME_WRITABLE_PATHS = Object.freeze([
  '.harness/runs',
  '.harness/state',
  '.harness/cache'
]);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDir, '..', '..');
const options = parseArgs(process.argv.slice(2));
const root = path.resolve(options.root || defaultRoot);
const trustedRoot = path.resolve(options['trusted-root'] || defaultRoot);
const baseRef = options['base-ref'] || process.env.HARNESS_SHADOW_BASE_REF;
if (!baseRef) throw new Error('H8_SHADOW_BASE_REF_REQUIRED');
const outputPath = path.resolve(
  root,
  options.output
    || `.harness/runs/h8-shadow-observations/${process.env.GITHUB_RUN_ID || Date.now()}-${process.env.GITHUB_RUN_ATTEMPT || 1}.json`
);
assertInside(root, outputPath);

const candidate = {
  commitOid: git(root, ['rev-parse', '--verify', 'HEAD']),
  treeOid: git(root, ['rev-parse', '--verify', 'HEAD^{tree}'])
};
const judgeBaseCommitOid = git(trustedRoot, ['rev-parse', '--verify', 'HEAD']);
const judgeCandidateControlled = trustedRoot === root || judgeBaseCommitOid === candidate.commitOid;
const judge = {
  source: judgeCandidateControlled ? 'local-candidate' : 'protected-base',
  candidateControlled: judgeCandidateControlled,
  engineDigest: engineDigest(trustedRoot),
  candidateEngineDigest: engineDigest(root),
  baseCommitOid: judgeBaseCommitOid,
  workflowRef: process.env.GITHUB_WORKFLOW_REF || 'local-unqualified'
};
const changedFiles = readChangedFiles(root, baseRef);
const trustRootChanged = changedFiles.some(isTrustRootPath);
const businessChangedFiles = changedFiles.filter((item) => !isTrustRootPath(item) && !isDocumentationOnly(item));

const baselineStartedAt = Date.now();
const baselineExecution = executeNode(root, ['harness/tests/run-all.mjs'], []);
const baselineDurationMs = Date.now() - baselineStartedAt;
const baselineOutcome = baselineExecution.outcome;
const adversarialCorpus = trustRootChanged
  ? executeTrustedAdversarialCorpus(trustedRoot, root)
  : {
      passed: true,
      caseCount: 0,
      durationMs: 0,
      outputBytes: 0,
      reasonCodes: []
    };
const baselinePlanDigest = digestCanonicalJson({
  command: 'node harness/tests/run-all.mjs',
  contract: 'harness-current-ci-baseline-v1'
});
const baselineDecisionDigest = digestCanonicalJson({
  outcome: baselineOutcome,
  planDigest: baselinePlanDigest,
  requiredProfileIds: ['harness-suite'],
  executedProfileIds: baselineOutcome === 'PASS' ? ['harness-suite'] : []
});

const cold = executeV4Ci(root, baseRef);
const cached = executeV4Ci(root, baseRef);
const comparisonDivergence = baselineOutcome !== cold.outcome;
const requiredProfiles = cold.requiredProfileIds;
const executedProfiles = cold.executedProfileIds;
const observedAt = new Date().toISOString();
const observation = sealShadowObservation({
  schemaVersion: 2,
  provider: process.env.GITHUB_ACTIONS === 'true' ? 'github-actions' : 'local',
  mode: 'shadow',
  runId: process.env.GITHUB_RUN_ID || `local-${crypto.randomBytes(16).toString('hex')}`,
  runAttempt: positiveInteger(process.env.GITHUB_RUN_ATTEMPT, 1),
  observedAt,
  candidate,
  judge,
  audit: cold.audit,
  baseline: {
    outcome: baselineOutcome,
    decisionDigest: baselineDecisionDigest,
    planDigest: baselinePlanDigest,
    requiredProfileIds: ['harness-suite'],
    executedProfileIds: baselineOutcome === 'PASS' ? ['harness-suite'] : []
  },
  v4: {
    outcome: cold.outcome,
    decisionDigest: cold.decisionDigest,
    planDigest: cold.planDigest,
    requiredProfileIds: requiredProfiles,
    executedProfileIds: executedProfiles
  },
  comparison: {
    divergence: comparisonDivergence,
    explained: false,
    explanationCode: null
  },
  reproducibility: {
    coldDecisionDigest: cold.decisionDigest,
    cachedDecisionDigest: cached.decisionDigest,
    coldPlanDigest: cold.planDigest,
    cachedPlanDigest: cached.planDigest
  },
  trustRoot: {
    changed: trustRootChanged,
    adversarialCorpusRequired: trustRootChanged,
    adversarialCorpusPassed: adversarialCorpus.passed,
    adversarialCaseCount: adversarialCorpus.caseCount
  },
  businessProfile: {
    changed: businessChangedFiles.length > 0,
    requiredProfileIds: businessChangedFiles.length ? requiredProfiles : [],
    executedProfileIds: businessChangedFiles.length ? executedProfiles : []
  },
  executionDiagnostics: {
    contractVersion: 'harness-shadow-execution-diagnostics-v1.0.0',
    baseline: summarizeSafeExecution(baselineExecution),
    cold: cold.executionDiagnostics,
    cached: cached.executionDiagnostics,
    adversarialCorpus: {
      passed: adversarialCorpus.passed,
      caseCount: adversarialCorpus.caseCount,
      reasonCodes: normalizeReasonCodes(adversarialCorpus.reasonCodes)
    }
  },
  cost: {
    durationMs: baselineDurationMs + cold.durationMs + adversarialCorpus.durationMs,
    cachedDurationMs: cached.durationMs,
    outputBytes: byteLength(baselineExecution)
      + cold.outputBytes
      + cached.outputBytes
      + adversarialCorpus.outputBytes
  }
});

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(observation, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({
  status: 'recorded',
  outputPath: normalizePath(path.relative(root, outputPath)),
  observationId: observation.observationId,
  baselineOutcome,
  v4Outcome: cold.outcome,
  reproducible: cold.decisionDigest === cached.decisionDigest && cold.planDigest === cached.planDigest,
  trustRootChanged,
  adversarialCorpusPassed: adversarialCorpus.passed,
  adversarialCaseCount: adversarialCorpus.caseCount,
  baselineReasonCodes: observation.executionDiagnostics.baseline.reasonCodes,
  coldReasonCodes: observation.executionDiagnostics.cold.reasonCodes,
  cachedReasonCodes: observation.executionDiagnostics.cached.reasonCodes,
  businessChangedFileCount: businessChangedFiles.length,
  promotionAllowed: false,
  formalEligible: false
}, null, 2)}\n`);
process.exitCode = comparisonDivergence
  || cold.outcome !== 'PASS'
  || cached.outcome !== 'PASS'
  || (trustRootChanged && !adversarialCorpus.passed)
  ? 2
  : 0;

function executeV4Ci(candidateRoot, targetBaseRef) {
  const execution = executeNode(
    candidateRoot,
    ['harness/cli.mjs', 'ci', '--base', targetBaseRef],
    H8_RUNTIME_WRITABLE_PATHS,
    { HARNESS_OBSERVATION_MODE: 'shadow' }
  );
  const executorOutcome = parseCiOutcome(execution);
  const runDir = parseRunDirectory(candidateRoot, execution.stdout);
  const plan = runDir ? readJson(path.join(runDir, 'validation-plan.json')) : null;
  const result = runDir ? readJson(path.join(runDir, 'validation-result.json')) : null;
  const audited = runDir
    ? auditRun({ root: candidateRoot, runDir, mode: 'formal-local' })
    : {
        outcome: 'BLOCKED',
        violations: [{ code: 'H8_AUDIT_RUN_DIRECTORY_UNAVAILABLE' }],
        attestation: null
      };
  const auditViolationCodes = [...new Set(
    (audited.violations || []).map((item) => item?.code).filter(Boolean)
  )].sort();
  const outcome = audited.outcome === 'LOCAL_ATTESTED' && executorOutcome === 'PASS'
    ? 'PASS'
    : deriveFailedOutcome(executorOutcome, audited.outcome);
  const requiredProfileIds = (plan?.commands || []).filter((item) => item.required).map((item) => item.id).sort();
  const passed = new Set((result?.results || []).filter((item) => item.outcome === 'PASS').map((item) => item.commandId || item.id));
  const executedProfileIds = requiredProfileIds.filter((item) => passed.has(item));
  const planDigest = plan?.planningDigest || digestCanonicalJson({
    unavailable: true,
    outcome,
    requiredProfileIds
  });
  const decisionDigest = digestCanonicalJson({
    outcome,
    executorOutcome,
    auditOutcome: audited.outcome,
    auditViolationCodes,
    planDigest,
    requiredProfileIds,
    executedProfileIds,
    resultOutcomes: (result?.results || []).map((item) => ({
      id: item.commandId || item.id,
      outcome: item.outcome
    })).sort((a, b) => a.id.localeCompare(b.id))
  });
  const runDirectoryAvailable = Boolean(runDir);
  const validationPlanAvailable = Boolean(plan);
  const validationResultAvailable = Boolean(result);
  const executionDiagnostics = {
    aggregateOutcome: outcome,
    parsedCiOutcome: executorOutcome,
    auditStatus: shadowAuditStatus(audited.outcome),
    auditViolationCodes,
    runDirectoryAvailable,
    validationPlanAvailable,
    validationResultAvailable,
    reasonCodes: v4ExecutionReasonCodes({
      execution,
      executorOutcome,
      auditOutcome: audited.outcome,
      auditViolationCodes,
      outcome,
      runDirectoryAvailable,
      validationPlanAvailable,
      validationResultAvailable,
      validationResult: result
    }),
    safeExecutor: summarizeSafeExecution(execution)
  };
  return {
    outcome,
    audit: {
      accepted: audited.outcome === 'LOCAL_ATTESTED',
      attestationDigest: audited.attestation?.attestationDigest || null,
      violationCodes: auditViolationCodes
    },
    decisionDigest,
    planDigest,
    requiredProfileIds,
    executedProfileIds,
    executionDiagnostics,
    durationMs: execution.durationMs,
    outputBytes: byteLength(execution)
  };
}

function summarizeSafeExecution(execution) {
  const changedPaths = boundedDiagnosticPaths(execution.changedPaths);
  const forbiddenWrites = boundedDiagnosticPaths(execution.forbiddenWrites);
  const changedPathCount = Array.isArray(execution.changedPaths) ? execution.changedPaths.length : 0;
  const forbiddenWriteCount = Array.isArray(execution.forbiddenWrites) ? execution.forbiddenWrites.length : 0;
  return {
    outcome: execution.outcome,
    exitCode: Number.isInteger(execution.exitCode) ? execution.exitCode : null,
    signal: boundedSignal(execution.signal),
    timedOut: execution.timedOut === true,
    outputTruncated: execution.outputTruncated === true,
    policyBlocked: execution.policyBlocked === true,
    boundaryViolation: execution.boundaryViolation === true,
    processErrorPresent: Boolean(execution.error),
    changedPathCount,
    forbiddenWriteCount,
    changedPaths,
    forbiddenWrites,
    pathsTruncated: changedPathCount > changedPaths.length || forbiddenWriteCount > forbiddenWrites.length,
    reasonCodes: safeExecutionReasonCodes(execution)
  };
}

function safeExecutionReasonCodes(execution) {
  if (execution.outcome === 'PASS') return [];
  const reasonCodes = extractSafeFailureMarkers(execution.stdout, execution.stderr);
  if (execution.timedOut) reasonCodes.push('SAFE_EXECUTOR_TIMED_OUT');
  if (execution.outputTruncated) reasonCodes.push('SAFE_EXECUTOR_OUTPUT_TRUNCATED');
  if (execution.policyBlocked) reasonCodes.push('SAFE_EXECUTOR_POLICY_BLOCKED');
  if (execution.boundaryViolation) reasonCodes.push('SAFE_EXECUTOR_BOUNDARY_VIOLATION');
  if (execution.error) reasonCodes.push('SAFE_EXECUTOR_PROCESS_ERROR');
  if (Number.isInteger(execution.exitCode) && execution.exitCode !== 0) reasonCodes.push('SAFE_EXECUTOR_EXIT_NONZERO');
  if (execution.signal) reasonCodes.push('SAFE_EXECUTOR_SIGNALLED');
  if (execution.outcome !== 'PASS' && reasonCodes.length === 0) {
    reasonCodes.push(`SAFE_EXECUTOR_OUTCOME_${reasonToken(execution.outcome)}`);
  }
  return normalizeReasonCodes(reasonCodes);
}

function extractSafeFailureMarkers(...values) {
  const reasonCodes = [];
  const text = values.map((item) => String(item || '')).join('\n');
  for (const match of text.matchAll(/\b(?:AUDITOR|HARNESS|SAFE_EXECUTOR)_[A-Z0-9_]{2,120}\b/g)) {
    reasonCodes.push(match[0]);
  }
  for (const match of text.matchAll(/HARNESS_TEST_SUITE_FAIL:\s*test\s+(harness[\\/]+tests[\\/]+[A-Za-z0-9_.-]+\.mjs)/gi)) {
    reasonCodes.push(`HARNESS_TEST_FAILED:${normalizePath(match[1])}`);
  }
  for (const match of text.matchAll(/^(?:ERROR|FAIL):\s+([A-Za-z_][A-Za-z0-9_]*)\s+\(([A-Za-z0-9_.-]+)\)\s*$/gm)) {
    reasonCodes.push(`PYTHON_UNITTEST_${match[0].startsWith('ERROR:') ? 'ERROR' : 'FAIL'}:${match[2]}.${match[1]}`);
  }
  for (const match of text.matchAll(/^\s*([A-Z][A-Z0-9_]{2,96}):\s*(?:FAILED|BLOCKED)\s*$/gm)) {
    reasonCodes.push(`VALIDATION_MARKER_${match[1]}_FAILED`);
  }
  for (const match of text.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_.]*(?:Error|Exception))(?::|$)/gm)) {
    reasonCodes.push(`PROCESS_EXCEPTION_CLASS:${match[1]}`);
  }
  const unittestSummary = /FAILED\s+\(([^)\r\n]{1,120})\)/.exec(text);
  if (unittestSummary) {
    const counts = [...unittestSummary[1].matchAll(/\b(failures|errors|skipped)=(\d{1,6})\b/g)]
      .map((match) => `${match[1]}_${match[2]}`);
    if (counts.length) reasonCodes.push(`PYTHON_UNITTEST_SUMMARY_${counts.join('_')}`);
  }
  return normalizeReasonCodes(reasonCodes);
}

function v4ExecutionReasonCodes({
  execution,
  executorOutcome,
  auditOutcome,
  auditViolationCodes,
  outcome,
  runDirectoryAvailable,
  validationPlanAvailable,
  validationResultAvailable,
  validationResult
}) {
  if (outcome === 'PASS') return [];
  const reasonCodes = [
    ...safeExecutionReasonCodes(execution),
    ...validationResultReasonCodes(validationResult)
  ];
  if (executorOutcome !== 'PASS') reasonCodes.push(`H8_CI_OUTCOME_${reasonToken(executorOutcome)}`);
  if (auditOutcome !== 'LOCAL_ATTESTED') reasonCodes.push(`H8_AUDIT_OUTCOME_${reasonToken(auditOutcome)}`);
  for (const code of auditViolationCodes) reasonCodes.push(`H8_AUDIT_VIOLATION_${reasonToken(code)}`);
  if (!runDirectoryAvailable) reasonCodes.push('H8_RUN_DIRECTORY_UNAVAILABLE');
  if (!validationPlanAvailable) reasonCodes.push('H8_VALIDATION_PLAN_UNAVAILABLE');
  if (!validationResultAvailable) reasonCodes.push('H8_VALIDATION_RESULT_UNAVAILABLE');
  reasonCodes.push(`H8_V4_AGGREGATE_${reasonToken(outcome)}`);
  return normalizeReasonCodes(reasonCodes);
}

function validationResultReasonCodes(result) {
  if (!result || result.outcome === 'PASS') return [];
  const reasonCodes = [];
  if (result.reasonCode) {
    reasonCodes.push(`H8_VALIDATION_SUMMARY_${reasonToken(result.reasonCode)}`);
  }
  for (const item of result.results || []) {
    if (!item || item.outcome === 'PASS') continue;
    const commandId = reasonToken(item.commandId || item.id || 'UNKNOWN_COMMAND');
    reasonCodes.push(`H8_VALIDATION_RESULT_${commandId}_${reasonToken(item.outcome)}`);
    if (Number.isInteger(item.exitCode) && item.exitCode !== 0) {
      reasonCodes.push(`H8_VALIDATION_RESULT_${commandId}_EXIT_${item.exitCode}`);
    }
    if (item.signal) reasonCodes.push(`H8_VALIDATION_RESULT_${commandId}_SIGNALLED`);
    if (item.error || item.executor?.error) {
      reasonCodes.push(`H8_VALIDATION_RESULT_${commandId}_PROCESS_ERROR`);
    }
    if (item.executor?.timedOut) reasonCodes.push(`H8_VALIDATION_RESULT_${commandId}_TIMED_OUT`);
    if (item.executor?.outputTruncated) {
      reasonCodes.push(`H8_VALIDATION_RESULT_${commandId}_OUTPUT_TRUNCATED`);
    }
    if (item.executor?.policyBlocked) {
      reasonCodes.push(`H8_VALIDATION_RESULT_${commandId}_POLICY_BLOCKED`);
    }
    if (item.executor?.boundaryViolation) {
      reasonCodes.push(`H8_VALIDATION_RESULT_${commandId}_BOUNDARY_VIOLATION`);
    }
    for (const marker of extractSafeFailureMarkers(
      item.stdout,
      item.stderr,
      item.error,
      item.executor?.error
    )) {
      reasonCodes.push(`H8_VALIDATION_RESULT_${commandId}_${marker}`);
    }
  }
  return normalizeReasonCodes(reasonCodes);
}

function shadowAuditStatus(value) {
  if (value === 'LOCAL_ATTESTED') return 'ATTESTED';
  if (value === 'INVALIDATED') return 'INVALIDATED';
  if (value === 'ERROR') return 'ERROR';
  if (!value) return 'UNAVAILABLE';
  return 'NOT_ATTESTED';
}

function boundedDiagnosticPaths(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((item) => normalizePath(String(item))).filter(Boolean))]
    .sort()
    .slice(0, MAX_DIAGNOSTIC_ITEMS);
}

function boundedSignal(value) {
  if (!value) return null;
  const normalized = String(value).toUpperCase().replace(/[^A-Z0-9_-]/g, '_').slice(0, 32);
  return normalized || null;
}

function normalizeReasonCodes(values) {
  return [...new Set((values || []).map((item) => reasonToken(item)).filter(Boolean))]
    .sort()
    .slice(0, MAX_DIAGNOSTIC_ITEMS);
}

function reasonToken(value) {
  return String(value || 'UNKNOWN')
    .toUpperCase()
    .replace(/[^A-Z0-9_.:/-]/g, '_')
    .replace(/^([^A-Z])/, 'R_$1')
    .slice(0, 160);
}

function executeTrustedAdversarialCorpus(judgeRoot, candidateRoot) {
  const trustedTestDir = path.join(judgeRoot, 'harness', 'tests');
  const candidateTestDir = path.join(candidateRoot, 'harness', 'tests');
  const testNames = fs.readdirSync(trustedTestDir)
    .filter((name) => /^v4-.*\.test\.mjs$/.test(name))
    .sort();
  const supportNames = fs.existsSync(path.join(trustedTestDir, 'v4-trust-contract.red.mjs'))
    ? ['v4-trust-contract.red.mjs']
    : [];
  const protectedSources = [...testNames, ...supportNames];
  const sourceMismatch = protectedSources.some((name) => {
    const trustedFile = path.join(trustedTestDir, name);
    const candidateFile = path.join(candidateTestDir, name);
    return !fs.existsSync(candidateFile) || fileDigest(candidateFile) !== fileDigest(trustedFile);
  });
  if (sourceMismatch || testNames.length === 0) {
    return {
      passed: false,
      caseCount: testNames.length,
      durationMs: 0,
      outputBytes: 0,
      reasonCodes: [sourceMismatch ? 'H8_TRUSTED_CORPUS_SOURCE_DRIFT' : 'H8_TRUSTED_CORPUS_EMPTY']
    };
  }
  const executions = testNames.map((name) => executeNode(
    candidateRoot,
    [`harness/tests/${name}`],
    []
  ));
  return {
    passed: executions.every((item) => item.outcome === 'PASS'),
    caseCount: testNames.length,
    durationMs: executions.reduce((sum, item) => sum + item.durationMs, 0),
    outputBytes: executions.reduce((sum, item) => sum + byteLength(item), 0),
    reasonCodes: executions
      .map((item, index) => item.outcome === 'PASS' ? null : `H8_TRUSTED_CORPUS_CASE_FAILED:${testNames[index]}`)
      .filter(Boolean)
  };
}

function executeNode(candidateRoot, args, writablePaths, environmentValues = {}) {
  return safeExecute({
    root: candidateRoot,
    contract: {
      schemaVersion: 1,
      executable: 'node',
      args,
      policy: {
        resources: {
          timeoutMs: 30 * 60 * 1000,
          maxOutputBytes: 20 * 1024 * 1024,
          maxMemoryMb: 4096,
          maxProcesses: 64
        },
        network: {
          mode: 'deny',
          invariantPolicyId: null,
          allowedDestinations: []
        },
        environment: {
          allow: ['CI', 'GITHUB_ACTIONS', 'GITHUB_RUN_ATTEMPT', 'GITHUB_RUN_ID'],
          values: environmentValues
        },
        writablePaths
      }
    },
    cwd: candidateRoot,
    protectCandidate: true
  });
}

function parseCiOutcome(execution) {
  const match = /CI status:\s*(passed|failed|blocked)/i.exec(execution.stdout || '');
  if (match) return { passed: 'PASS', failed: 'FAIL', blocked: 'BLOCKED' }[match[1].toLowerCase()];
  return execution.outcome;
}

function deriveFailedOutcome(executorOutcome, auditOutcome) {
  if (auditOutcome === 'INVALIDATED') return 'INVALIDATED';
  if (executorOutcome === 'FAIL' || auditOutcome === 'FAIL') return 'FAIL';
  if (executorOutcome === 'ERROR') return 'ERROR';
  return 'BLOCKED';
}

function parseRunDirectory(root, stdout) {
  const match = /Harness run:\s*([^\r\n]+)/i.exec(stdout || '');
  if (!match) return null;
  const resolved = path.resolve(root, match[1].trim());
  assertInside(root, resolved);
  return resolved;
}

function readChangedFiles(root, baseRef) {
  for (const range of [`${baseRef}...HEAD`, `${baseRef}..HEAD`]) {
    const result = runFile('git', ['diff', '--name-only', '-z', range], {
      cwd: root,
      timeoutMs: 30000
    });
    if (result.exitCode === 0) {
      return result.stdout.split('\0').filter(Boolean).map(normalizePath).sort();
    }
  }
  throw new Error('H8_SHADOW_BASE_REF_UNRESOLVED');
}

function isTrustRootPath(value) {
  return value === '.gitattributes'
    || value === 'AGENTS.md'
    || value.startsWith('harness/')
    || value.startsWith('.codex/hooks/')
    || value.startsWith('.harness/harness.config')
    || value === '.harness/source-authority.json'
    || value.startsWith('.github/workflows/harness');
}

function isDocumentationOnly(value) {
  return value.startsWith('.harness/docs/')
    || value.toLowerCase().endsWith('.md');
}

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!['--root', '--trusted-root', '--base-ref', '--output'].includes(key) || !args[index + 1]) {
      throw new Error(`Unsupported or incomplete argument: ${key}`);
    }
    result[key.slice(2)] = args[index + 1];
    index += 1;
  }
  return result;
}

function engineDigest(targetRoot) {
  const roots = [
    'harness/cli.mjs',
    'harness/auditor',
    'harness/contracts/v4',
    'harness/executor',
    'harness/lib'
  ];
  const records = [];
  for (const relative of roots) {
    const absolute = path.join(targetRoot, relative);
    if (!fs.existsSync(absolute)) continue;
    for (const file of walkFiles(absolute)) {
      records.push({
        path: normalizePath(path.relative(targetRoot, file)),
        digest: `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`
      });
    }
  }
  return digestCanonicalJson(records.sort((a, b) => a.path.localeCompare(b.path)));
}

function walkFiles(target, out = []) {
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    out.push(target);
    return out;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) walkFiles(child, out);
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

function git(root, args) {
  const result = runFile('git', args, { cwd: root, timeoutMs: 30000 });
  if (result.exitCode !== 0 || !result.stdout.trim()) throw new Error(`H8_GIT_OBSERVATION_FAILED:${args.join(':')}`);
  return result.stdout.trim();
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function fileDigest(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function byteLength(result) {
  return Buffer.byteLength(result.stdout || '') + Buffer.byteLength(result.stderr || '');
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function assertInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('H8_SHADOW_PATH_ESCAPE');
}
