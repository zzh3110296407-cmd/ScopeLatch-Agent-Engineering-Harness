import path from 'node:path';
import { safeExecute } from './v4/safe-executor.mjs';

export function runValidationCapability({ root, authority, capability, timeoutMs = 15 * 60 * 1000 }) {
  if (authority?.status && authority.status !== 'manifest-ready') {
    throw new Error(`Source authority is not ready: ${authority.status}.`);
  }
  const steps = authority?.validationProfile?.commands?.[capability];
  if (!Array.isArray(steps) || !steps.length) {
    throw new Error(`Unknown validation capability: ${capability}.`);
  }

  const results = [];
  for (const [index, step] of steps.entries()) {
    const cwd = resolveStepCwd(root, authority.root, step.cwd);
    const contract = stepContract(authority.validationProfile, step, timeoutMs);
    const result = safeExecute({
      root,
      contract,
      cwd,
      timeoutMs: step.timeoutMs || timeoutMs,
      environment: step.env || {},
      protectCandidate: true
    });
    results.push({
      index,
      cwd,
      command: step.command,
      args: step.args || [],
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error,
      outcome: result.outcome,
      executor: {
        contractVersion: result.contractVersion,
        commandContractDigest: result.commandContractDigest,
        shellUsed: result.shellUsed,
        networkPolicy: result.networkPolicy,
        environmentKeys: result.environmentKeys,
        limits: result.limits,
        enforcement: result.enforcement,
        formalEligible: result.formalEligible,
        formalIneligibilityReason: result.formalIneligibilityReason,
        timedOut: result.timedOut,
        outputTruncated: result.outputTruncated,
        boundaryViolation: result.boundaryViolation,
        changedPaths: result.changedPaths,
        forbiddenWrites: result.forbiddenWrites
      }
    });
    if (result.outcome !== 'PASS') {
      return {
        schemaVersion: 1,
        capability,
        status: result.outcome === 'BLOCKED' ? 'blocked' : 'failed',
        exitCode: result.exitCode,
        steps: results
      };
    }
  }

  return {
    schemaVersion: 1,
    capability,
    status: 'passed',
    exitCode: 0,
    steps: results
  };
}

function resolveStepCwd(root, sourceRoot, cwd) {
  if (cwd === 'source') return path.resolve(root, sourceRoot);
  if (cwd === 'repo') return path.resolve(root);
  if (cwd.startsWith('repo:')) {
    const resolved = path.resolve(root, cwd.slice('repo:'.length));
    const relative = path.relative(path.resolve(root), resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Validation cwd escapes the repository: ${cwd}.`);
    }
    return resolved;
  }
  throw new Error(`Unsupported validation cwd: ${cwd}.`);
}

function stepContract(profile, step, timeoutMs) {
  const defaults = profile?.policyDefaults || {};
  const stepPolicy = step.policy || {};
  return {
    schemaVersion: 1,
    executable: step.command,
    args: step.args || [],
    policy: {
      resources: {
        ...(defaults.resources || {}),
        ...(stepPolicy.resources || {}),
        timeoutMs: step.timeoutMs || stepPolicy.resources?.timeoutMs || defaults.resources?.timeoutMs || timeoutMs
      },
      network: {
        ...(defaults.network || {}),
        ...(stepPolicy.network || {})
      },
      environment: {
        ...(defaults.environment || {}),
        ...(stepPolicy.environment || {}),
        allow: stepPolicy.environment?.allow || defaults.environment?.allow || [],
        values: {
          ...(defaults.environment?.values || {}),
          ...(stepPolicy.environment?.values || {})
        }
      },
      writablePaths: stepPolicy.writablePaths || defaults.writablePaths || []
    }
  };
}
