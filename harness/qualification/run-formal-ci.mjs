import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditRun } from '../auditor/lib/auditor.mjs';
import {
  evaluateFormalDelivery,
  issueFormalCiAttestation,
  validateFormalCutoverPolicy
} from '../auditor/lib/formal-cutover.mjs';
import { normalizePath, runFile } from '../lib/common.mjs';
import { safeExecute } from '../lib/v4/safe-executor.mjs';
import {
  evaluateShadowWindow,
  runQualificationDrills
} from '../lib/v4/shadow-qualification.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const defaultTrustedRoot = path.resolve(scriptDir, '..', '..');
const RUNTIME_WRITABLE_PATHS = Object.freeze([
  '.harness/runs',
  '.harness/state',
  '.harness/cache'
]);

export function runFormalCi({
  root,
  trustedRoot,
  baseRef,
  h8ObservationDirectory,
  enforcementPath,
  environment = process.env,
  now = new Date().toISOString()
}) {
  const candidateRoot = path.resolve(root);
  const authorityRoot = path.resolve(trustedRoot);
  if (candidateRoot === authorityRoot) {
    return blocked('H9_TRUSTED_BASE_MUST_BE_INDEPENDENT');
  }
  const policyPath = path.join(
    authorityRoot,
    'harness',
    'contracts',
    'v4',
    'formal-cutover-policy.json'
  );
  const policy = readJson(policyPath, 'H9_FORMAL_POLICY_UNAVAILABLE');
  const policyViolations = validateFormalCutoverPolicy(policy);
  if (policyViolations.length) {
    return closedResult({
      status: 'invalidated',
      outcome: 'INVALIDATED',
      reasonCodes: policyViolations.map((item) => item.code),
      violations: policyViolations
    });
  }
  const providerFailure = validateProviderEnvironment(environment, policy);
  if (providerFailure) return blocked(providerFailure);
  if (!baseRef) return blocked('H9_FORMAL_BASE_REF_REQUIRED');

  const h8Qualification = recomputeH8Qualification(
    authorityRoot,
    h8ObservationDirectory
  );
  if (h8Qualification.error) return blocked(h8Qualification.error);
  const enforcement = readTrustedJson(
    authorityRoot,
    enforcementPath,
    'H9_EXTERNAL_ENFORCEMENT_EVIDENCE_UNAVAILABLE'
  );
  if (enforcement.error) return blocked(enforcement.error);

  const candidate = {
    commitOid: git(candidateRoot, ['rev-parse', '--verify', 'HEAD']),
    treeOid: git(candidateRoot, ['rev-parse', '--verify', 'HEAD^{tree}'])
  };
  const baseCommitOid = git(authorityRoot, ['rev-parse', '--verify', 'HEAD']);
  if (environment.HARNESS_FORMAL_BASE_COMMIT !== baseCommitOid) {
    return invalidated('H9_TRUSTED_BASE_COMMIT_MISMATCH');
  }

  const execution = safeExecute({
    root: candidateRoot,
    cwd: candidateRoot,
    contract: {
      schemaVersion: 1,
      executable: 'node',
      args: [
        path.join(authorityRoot, 'harness', 'cli.mjs'),
        'ci',
        '--base',
        baseRef
      ],
      policy: {
        resources: {
          timeoutMs: 60 * 60 * 1000,
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
          values: { HARNESS_OBSERVATION_MODE: 'formal' }
        },
        writablePaths: [...RUNTIME_WRITABLE_PATHS]
      }
    },
    protectCandidate: true
  });
  const runDir = parseRunDirectory(candidateRoot, execution.stdout);
  const localAudit = runDir
    ? auditRun({ root: candidateRoot, runDir, mode: 'formal-local' })
    : {
        status: 'blocked',
        outcome: 'BLOCKED',
        violations: [{ code: 'H9_AUDIT_RUN_DIRECTORY_UNAVAILABLE' }],
        executorVerdictIgnored: true,
        attestation: null
      };
  const authority = {
    schemaVersion: 1,
    provider: policy.provider,
    repository: environment.GITHUB_REPOSITORY,
    workflowPath: policy.workflow.path,
    workflowRef: `${policy.repository}/${policy.workflow.path}@refs/heads/${policy.protectedBranch}`,
    jobName: policy.workflow.requiredCheckName,
    runId: environment.GITHUB_RUN_ID,
    runAttempt: positiveInteger(environment.GITHUB_RUN_ATTEMPT),
    observedAt: now,
    eventName: environment.GITHUB_EVENT_NAME,
    protectedBranch: policy.protectedBranch,
    baseCommitOid,
    candidateCommitOid: candidate.commitOid,
    candidateTreeOid: candidate.treeOid,
    engineDigest: localAudit.attestation?.auditor?.engineDigest
      || 'sha256:0000000000000000000000000000000000000000000000000000000000000000'
  };
  const issuedAt = now;
  const expiresAt = new Date(
    Date.parse(now) + policy.freshness.maxAgeSeconds * 1000
  ).toISOString();
  const issuance = issueFormalCiAttestation({
    localAudit,
    policy,
    authority,
    h8Qualification: h8Qualification.value,
    issuedAt,
    expiresAt
  });
  if (issuance.status !== 'attested') {
    return closedResult({
      status: issuance.status,
      outcome: issuance.outcome,
      reasonCodes: [
        ...(execution.outcome === 'PASS' ? [] : ['H9_FORMAL_EXECUTION_NOT_PASS']),
        ...issuance.violations.map((item) => item.code)
      ],
      violations: issuance.violations,
      execution: summarizeExecution(execution, runDir)
    });
  }
  const delivery = {
    repository: policy.repository,
    branch: policy.protectedBranch,
    commitOid: candidate.commitOid,
    treeOid: candidate.treeOid
  };
  const decision = evaluateFormalDelivery({
    policy,
    attestation: issuance.attestation,
    delivery,
    h8Qualification: h8Qualification.value,
    enforcement: enforcement.value,
    now
  });
  if (execution.outcome !== 'PASS') {
    decision.status = 'blocked';
    decision.outcome = 'BLOCKED';
    decision.formalEligible = false;
    decision.reasonCodes = [...new Set([
      ...decision.reasonCodes,
      'H9_FORMAL_EXECUTION_NOT_PASS'
    ])].sort();
    decision.violations = [
      ...decision.violations,
      { code: 'H9_FORMAL_EXECUTION_NOT_PASS', safePath: 'execution' }
    ];
  }
  return closedResult({
    ...decision,
    attestation: issuance.attestation,
    delivery,
    execution: summarizeExecution(execution, runDir)
  });
}

function validateProviderEnvironment(environment, policy) {
  if (environment.GITHUB_ACTIONS !== 'true') return 'H9_FORMAL_CI_PROVIDER_REQUIRED';
  if (environment.GITHUB_REPOSITORY !== policy.repository) {
    return 'H9_FORMAL_CI_REPOSITORY_MISMATCH';
  }
  if (!policy.workflow.requiredEvents.includes(environment.GITHUB_EVENT_NAME)) {
    return 'H9_FORMAL_CI_EVENT_NOT_AUTHORIZED';
  }
  if (!/^[0-9]{1,32}$/.test(environment.GITHUB_RUN_ID || '')) {
    return 'H9_FORMAL_CI_RUN_ID_INVALID';
  }
  if (!positiveInteger(environment.GITHUB_RUN_ATTEMPT)) {
    return 'H9_FORMAL_CI_RUN_ATTEMPT_INVALID';
  }
  return null;
}

function readTrustedJson(root, value, missingCode) {
  if (!value) return { error: missingCode };
  const resolved = path.resolve(value);
  try {
    assertInside(root, resolved, 'H9_TRUSTED_EVIDENCE_PATH_ESCAPE');
    if (!fs.existsSync(resolved) || fs.lstatSync(resolved).isSymbolicLink()) {
      return { error: missingCode };
    }
    return { value: readJson(resolved, missingCode) };
  } catch (error) {
    return { error: error?.code || missingCode };
  }
}

function recomputeH8Qualification(root, directory) {
  if (!directory) return { error: 'H9_H8_OBSERVATION_SET_UNAVAILABLE' };
  const resolved = path.resolve(directory);
  try {
    assertInside(root, resolved, 'H9_TRUSTED_EVIDENCE_PATH_ESCAPE');
    if (
      !fs.existsSync(resolved)
      || fs.lstatSync(resolved).isSymbolicLink()
      || !fs.statSync(resolved).isDirectory()
    ) return { error: 'H9_H8_OBSERVATION_SET_UNAVAILABLE' };
    const names = fs.readdirSync(resolved)
      .filter((name) => name.endsWith('.json'))
      .sort();
    if (names.length === 0 || names.length > 200) {
      return { error: 'H9_H8_OBSERVATION_SET_INVALID' };
    }
    const observations = names.map((name) => {
      const file = path.join(resolved, name);
      if (fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile()) {
        const error = new Error('H9_H8_OBSERVATION_SET_INVALID');
        error.code = 'H9_H8_OBSERVATION_SET_INVALID';
        throw error;
      }
      return readJson(file, 'H9_H8_OBSERVATION_SET_INVALID');
    });
    const qualificationPolicy = readJson(
      path.join(root, 'harness', 'contracts', 'v4', 'shadow-qualification-policy.json'),
      'H9_H8_QUALIFICATION_POLICY_UNAVAILABLE'
    );
    const drills = runQualificationDrills(qualificationPolicy);
    return {
      value: evaluateShadowWindow({
        policy: qualificationPolicy,
        observations,
        drills
      })
    };
  } catch (error) {
    return { error: error?.code || 'H9_H8_OBSERVATION_SET_INVALID' };
  }
}

function readJson(file, code) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    const error = new Error(code);
    error.code = code;
    throw error;
  }
}

function parseRunDirectory(root, stdout) {
  const match = /Harness run:\s*([^\r\n]+)/i.exec(stdout || '');
  if (!match) return null;
  const resolved = path.resolve(root, match[1].trim());
  assertInside(root, resolved, 'H9_AUDIT_RUN_DIRECTORY_ESCAPE');
  return resolved;
}

function summarizeExecution(execution, runDir) {
  return {
    outcome: execution.outcome,
    exitCode: Number.isInteger(execution.exitCode) ? execution.exitCode : null,
    timedOut: execution.timedOut === true,
    outputTruncated: execution.outputTruncated === true,
    policyBlocked: execution.policyBlocked === true,
    boundaryViolation: execution.boundaryViolation === true,
    runDirectoryAvailable: Boolean(runDir)
  };
}

function closedResult(value) {
  return {
    schemaVersion: 1,
    contractVersion: 'harness-formal-delivery-v4.0.0',
    status: value.status,
    outcome: value.outcome,
    formalEligible: value.formalEligible === true,
    reasonCodes: [...new Set(value.reasonCodes || [])].sort(),
    violations: value.violations || [],
    attestation: value.attestation || null,
    delivery: value.delivery || null,
    execution: value.execution || null
  };
}

function blocked(code) {
  return closedResult({
    status: 'blocked',
    outcome: 'BLOCKED',
    reasonCodes: [code],
    violations: [{ code, safePath: '$' }]
  });
}

function invalidated(code) {
  return closedResult({
    status: 'invalidated',
    outcome: 'INVALIDATED',
    reasonCodes: [code],
    violations: [{ code, safePath: '$' }]
  });
}

function positiveInteger(value) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function git(root, args) {
  const result = runFile('git', args, { cwd: root, timeoutMs: 30_000 });
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    const error = new Error(`H9_GIT_OBSERVATION_FAILED:${args.join(':')}`);
    error.code = 'H9_GIT_OBSERVATION_FAILED';
    throw error;
  }
  return result.stdout.trim();
}

function assertInside(root, target, code) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    const error = new Error(code);
    error.code = code;
    throw error;
  }
}

function parseArgs(args) {
  const result = {};
  const allowed = new Set([
    '--base-ref',
    '--enforcement',
    '--h8-observations',
    '--output',
    '--root',
    '--trusted-root'
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!allowed.has(key) || !args[index + 1]) {
      throw new Error(`Unsupported or incomplete argument: ${key}`);
    }
    result[key.slice(2)] = args[index + 1];
    index += 1;
  }
  return result;
}

function writeResult(root, output, result) {
  const outputPath = path.resolve(root, output);
  assertInside(root, outputPath, 'H9_FORMAL_OUTPUT_PATH_ESCAPE');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({
    status: result.status,
    outcome: result.outcome,
    formalEligible: result.formalEligible,
    reasonCodes: result.reasonCodes,
    outputPath: normalizePath(path.relative(root, outputPath))
  }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  let options = {};
  let candidateRoot = process.cwd();
  let output = '.harness/runs/h9-formal/formal-delivery.json';
  let result;
  try {
    options = parseArgs(process.argv.slice(2));
    candidateRoot = path.resolve(options.root || process.cwd());
    output = options.output || output;
    result = runFormalCi({
      root: candidateRoot,
      trustedRoot: path.resolve(options['trusted-root'] || defaultTrustedRoot),
      baseRef: options['base-ref'],
      h8ObservationDirectory: options['h8-observations'],
      enforcementPath: options.enforcement
    });
  } catch (error) {
    result = blocked(error?.code || 'H9_FORMAL_RUNNER_ERROR');
  }
  writeResult(candidateRoot, output, result);
  process.exitCode = result.formalEligible ? 0 : 2;
}
