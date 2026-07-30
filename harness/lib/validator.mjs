import { createHash } from 'node:crypto';
import path from 'node:path';
import { manifestPathForRun, readRunManifest, updateRunManifest } from './manifest.mjs';
import { buildFailureDossier } from './prompt-builder.mjs';
import { readJson, writeJson, writeText } from './common.mjs';
import {
  aggregateExecutionOutcome,
  validateExecutionPlan
} from './v4/outcome-engine.mjs';
import {
  recordEvidenceObject,
  verifyRunEvidenceBindings
} from './v4/evidence-store.mjs';
import { verifyGitCandidateBaseline } from './v4/git-candidate.mjs';
import {
  buildInvariantResults,
  verifyInvariantPlanBinding
} from './v4/invariant-catalog.mjs';
import { safeExecute } from './v4/safe-executor.mjs';

export function validatePlan({ root, planPath, timeoutMs = 15 * 60 * 1000 }) {
  const validationPlan = readJson(planPath);
  if (!validationPlan) throw new Error(`Cannot read validation plan: ${planPath}`);
  const runDir = path.dirname(planPath);
  const manifestBefore = readRunManifest(runDir);
  const impactReport = readJson(path.join(runDir, 'impact-report.json'), null);
  const evidenceValidation = verifyRunEvidenceBindings({
    root,
    runDir,
    manifest: manifestBefore,
    validationPlan,
    impactReport
  });
  const candidateValidation = (manifestBefore?.schemaVersion || 0) >= 6
    ? verifyGitCandidateBaseline({
        root,
        baseline: manifestBefore?.gitCandidate?.baseline
      })
    : {
        valid: false,
        mode: 'v4-binding-required',
        violations: [{
          code: 'GIT_CANDIDATE_V4_BINDING_REQUIRED',
          safePath: 'run-manifest.schemaVersion'
        }],
        currentSnapshot: null
      };
  const invariantValidation = verifyInvariantPlanBinding({
    root,
    validationPlan,
    impactReport
  });
  updateRunManifest({
    runDir,
    patch: {
      status: 'running',
      phase: 'validation'
    }
  });
  const planValidation = validateExecutionPlan(validationPlan);
  const rawResults = evidenceValidation.valid
    && candidateValidation.valid
    && invariantValidation.valid
    && planValidation.valid
    ? validationPlan.graph?.nodes?.length
      ? runGraphValidation({ root, validationPlan, timeoutMs })
      : runFlatValidation({ root, validationPlan, timeoutMs })
    : [];
  const results = bindCheckResults({
    results: rawResults,
    runId: manifestBefore?.runId || null,
    binding: evidenceValidation.binding,
    candidateSnapshot: candidateValidation.currentSnapshot,
    invariantCatalogDigest: validationPlan.invariantCatalog?.digest || null
  });
  const invariantResults = buildInvariantResults({ validationPlan, results });
  const aggregate = !evidenceValidation.valid
    ? {
        outcome: 'INVALIDATED',
        developmentVerdict: 'INVALIDATED',
        formalEligible: false,
        reasonCode: 'EVIDENCE_BINDING_INVALID',
        evidenceIds: evidenceValidation.violations.map((item) => item.code).sort()
      }
    : !candidateValidation.valid
      ? {
          outcome: 'INVALIDATED',
          developmentVerdict: 'INVALIDATED',
          formalEligible: false,
          reasonCode: 'GIT_CANDIDATE_INVALID',
          evidenceIds: candidateValidation.violations.map((item) => item.code).sort()
        }
      : !invariantValidation.valid
        ? {
            outcome: 'INVALIDATED',
            developmentVerdict: 'INVALIDATED',
            formalEligible: false,
            reasonCode: 'INVARIANT_CATALOG_INVALID',
            evidenceIds: invariantValidation.violations.map((item) => item.code).sort()
          }
        : aggregateExecutionOutcome({ plan: validationPlan, results, planValidation });
  const result = {
    generatedAt: new Date().toISOString(),
    planPath,
    ...aggregate,
    planContractVersion: 'harness-execution-plan-v4.0.0',
    planViolations: planValidation.violations,
    evidenceValidation: {
      mode: evidenceValidation.mode,
      valid: evidenceValidation.valid,
      violations: evidenceValidation.violations
    },
    candidateValidation: {
      mode: candidateValidation.mode,
      valid: candidateValidation.valid,
      violations: candidateValidation.violations,
      snapshotDigest: candidateValidation.currentSnapshot?.snapshotDigest || null,
      headCommitOid: candidateValidation.currentSnapshot?.headCommitOid || null,
      indexTreeOid: candidateValidation.currentSnapshot?.indexTreeOid || null,
      worktreeDigest: candidateValidation.currentSnapshot?.worktreeDigest || null
    },
    invariantValidation: {
      mode: invariantValidation.mode,
      valid: invariantValidation.valid,
      violations: invariantValidation.violations,
      catalogDigest: validationPlan.invariantCatalog?.digest || null
    },
    results,
    invariantResults
  };

  const resultPath = path.join(runDir, 'validation-result.json');
  const dossierPath = path.join(runDir, 'failure-dossier.md');
  writeJson(resultPath, result);
  writeText(dossierPath, buildFailureDossier({ validationResult: result, impactReport, validationPlan }));
  const resultEvidence = manifestBefore?.schemaVersion >= 5
    ? recordEvidenceObject({
        runDir,
        runId: manifestBefore.runId,
        kind: 'validation-result',
        value: result,
        parentDigests: [
          evidenceValidation.binding?.bindingDigest,
          evidenceValidation.binding?.validationPlanDigest,
          evidenceValidation.binding?.impactReportDigest,
          candidateValidation.currentSnapshot?.snapshotDigest,
          validationPlan.invariantCatalog?.digest
        ].filter(Boolean)
      })
    : null;
  const manifest = updateRunManifest({
    runDir,
    patch: {
      status: lifecycleStatusForOutcome(result.outcome),
      phase: result.outcome === 'PASS'
        ? 'validation-complete'
        : `validation-${result.outcome.toLowerCase()}`,
      artifacts: {
        validationResult: resultPath,
        failureDossier: dossierPath,
        evidenceIndex: resultEvidence?.indexPath
      },
      validation: {
        resultOutcome: result.outcome,
        developmentVerdict: result.developmentVerdict,
        formalEligible: false,
        passedCount: results.filter((r) => r.outcome === 'PASS').length,
        failedCount: results.filter((r) => r.outcome === 'FAIL').length,
        blockedCount: results.filter((r) => r.outcome === 'BLOCKED').length,
        notApplicableCount: results.filter((r) => r.outcome === 'NOT_APPLICABLE').length,
        completedAt: result.generatedAt
      },
      gitCandidate: {
        validation: result.candidateValidation
      }
    }
  });
  return { result, resultPath, dossierPath, manifestPath: manifest ? manifestPathForRun(runDir) : null, manifest };
}

function runFlatValidation({ root, validationPlan, timeoutMs }) {
  const results = [];
  for (const check of validationPlan.commands || []) {
    const result = runCheck({ root, check, timeoutMs });
    results.push(result);
    if (result.required && result.outcome !== 'PASS') break;
  }
  return results;
}

function runGraphValidation({ root, validationPlan, timeoutMs }) {
  const commands = new Map((validationPlan.commands || []).map((command) => [command.id, command]));
  const tiers = [...(validationPlan.graph.tiers || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const tierOrder = new Map(tiers.map((tier, index) => [tier.id, index]));
  const commandNodes = (validationPlan.graph.nodes || [])
    .filter((node) => node.kind !== 'manual-guard')
    .sort((a, b) => (tierOrder.get(a.tier) ?? 999) - (tierOrder.get(b.tier) ?? 999));

  const results = [];
  const byId = new Map();
  let blockedByTierFailure = null;

  for (const node of commandNodes) {
    const check = commands.get(node.commandId || node.id);
    const nonPassingDependency = (node.dependsOn || []).find((dep) => {
      const depResult = byId.get(dep);
      return depResult && depResult.required && depResult.outcome !== 'PASS';
    });

    if (blockedByTierFailure && (tierOrder.get(node.tier) ?? 999) > blockedByTierFailure.tierOrder) {
      const skipped = skippedResult({ node, check, reason: `Skipped because required check failed in earlier tier: ${blockedByTierFailure.id}.` });
      results.push(skipped);
      byId.set(node.id, skipped);
      continue;
    }

    if (nonPassingDependency) {
      const skipped = skippedResult({ node, check, reason: `Blocked because dependency did not pass: ${nonPassingDependency}.` });
      results.push(skipped);
      byId.set(node.id, skipped);
      continue;
    }

    const result = runCheck({ root, check, node, timeoutMs });
    results.push(result);
    byId.set(node.id, result);

    if (result.outcome !== 'PASS' && result.required && validationPlan.graph.policy?.skipLaterTiersOnRequiredFailure !== false) {
      const order = tierOrder.get(node.tier) ?? 999;
      if (!blockedByTierFailure || order < blockedByTierFailure.tierOrder) {
        blockedByTierFailure = { id: node.id, tierOrder: order };
      }
    }
  }

  return results;
}

function runCheck({ root, check, node = null, timeoutMs }) {
  const id = node?.id || check?.id || 'unknown';
  if (!check || !check.available || !check.command) {
    return unavailableResult({
      node,
      check,
      reason: check
        ? `No available command. Candidate scripts: ${(check.candidates || []).join(', ')}`
        : `Graph node has no matching command: ${id}.`
    });
  }
  const res = safeExecute({
    root,
    contract: check.command,
    cwd: root,
    timeoutMs,
    protectCandidate: true
  });
  const outcome = res.outcome;
  return {
    id,
    commandId: check.id,
    label: check.label,
    tier: node?.tier || null,
    dependsOn: node?.dependsOn || [],
    invariantIds: node?.invariantIds || check.invariantIds || [],
    command: check.command,
    required: Boolean(check.required),
    outcome,
    exitCode: res.exitCode,
    signal: res.signal,
    durationMs: res.durationMs,
    stdout: res.stdout,
    stderr: res.stderr,
    error: res.error,
    executor: {
      contractVersion: res.contractVersion,
      commandContractDigest: res.commandContractDigest,
      shellUsed: res.shellUsed,
      networkPolicy: res.networkPolicy,
      environmentKeys: res.environmentKeys,
      limits: res.limits,
      enforcement: res.enforcement,
      formalEligible: res.formalEligible,
      formalIneligibilityReason: res.formalIneligibilityReason,
      timedOut: res.timedOut,
      outputTruncated: res.outputTruncated,
      boundaryViolation: res.boundaryViolation,
      changedPaths: res.changedPaths,
      forbiddenWrites: res.forbiddenWrites
    }
  };
}

function bindCheckResults({ results, runId, binding, candidateSnapshot, invariantCatalogDigest }) {
  return results.map((result) => ({
    ...result,
    evidenceBinding: binding
      ? {
          runId,
          bindingDigest: binding.bindingDigest,
          validationPlanDigest: binding.validationPlanDigest,
          gitCandidateSnapshotDigest: candidateSnapshot?.snapshotDigest || null,
          invariantCatalogDigest,
          commandSpecDigest: bindingDigestForCheck(result)
        }
      : {
          runId,
          bindingMissing: true
        }
  }));
}

function bindingDigestForCheck(result) {
  const value = JSON.stringify({
    id: result.commandId || result.id,
    command: result.command || null,
    required: Boolean(result.required),
    tier: result.tier || null,
    dependsOn: result.dependsOn || [],
    invariantIds: result.invariantIds || []
  });
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function unavailableResult({ node = null, check = null, reason }) {
  const required = Boolean(check?.required ?? node?.required);
  const outcome = required ? 'BLOCKED' : 'NOT_APPLICABLE';
  return {
    id: node?.id || check?.id || 'unknown',
    commandId: check?.id || node?.commandId || null,
    label: check?.label || node?.id || 'Unknown check',
    tier: node?.tier || null,
    dependsOn: node?.dependsOn || [],
    invariantIds: node?.invariantIds || check?.invariantIds || [],
    command: check?.command || null,
    required,
    outcome,
    reason
  };
}

function skippedResult({ node = null, check = null, reason }) {
  const required = Boolean(check?.required ?? node?.required);
  return {
    id: node?.id || check?.id || 'unknown',
    commandId: check?.id || node?.commandId || null,
    label: check?.label || node?.id || 'Unknown check',
    tier: node?.tier || null,
    dependsOn: node?.dependsOn || [],
    invariantIds: node?.invariantIds || check?.invariantIds || [],
    command: check?.command || null,
    required,
    outcome: required ? 'BLOCKED' : 'NOT_APPLICABLE',
    reason
  };
}

function lifecycleStatusForOutcome(outcome) {
  return {
    PASS: 'passed',
    FAIL: 'failed',
    BLOCKED: 'blocked',
    ERROR: 'error',
    CANCELED: 'blocked',
    INVALIDATED: 'invalidated'
  }[outcome] || 'error';
}
