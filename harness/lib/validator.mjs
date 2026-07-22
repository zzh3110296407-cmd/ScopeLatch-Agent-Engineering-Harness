import path from 'node:path';
import { manifestPathForRun, updateRunManifest } from './manifest.mjs';
import { buildFailureDossier } from './prompt-builder.mjs';
import { readJson, run, writeJson, writeText } from './common.mjs';

export function validatePlan({ root, planPath, timeoutMs = 15 * 60 * 1000 }) {
  const validationPlan = readJson(planPath);
  if (!validationPlan) throw new Error(`Cannot read validation plan: ${planPath}`);
  const runDir = path.dirname(planPath);
  updateRunManifest({
    runDir,
    patch: {
      status: 'running',
      phase: 'validation'
    }
  });
  const impactReport = readJson(path.join(runDir, 'impact-report.json'), null);
  const results = validationPlan.graph?.nodes?.length
    ? runGraphValidation({ root, validationPlan, timeoutMs })
    : runFlatValidation({ root, validationPlan, timeoutMs });

  const failedRequired = results.some((r) => r.required && r.status === 'failed');
  const hasNonPassingResult = results.some((r) => r.status !== 'passed');
  const result = {
    generatedAt: new Date().toISOString(),
    planPath,
    status: failedRequired ? 'failed' : hasNonPassingResult ? 'passed-or-skipped' : 'passed',
    results
  };

  const resultPath = path.join(runDir, 'validation-result.json');
  const dossierPath = path.join(runDir, 'failure-dossier.md');
  writeJson(resultPath, result);
  writeText(dossierPath, buildFailureDossier({ validationResult: result, impactReport, validationPlan }));
  const manifest = updateRunManifest({
    runDir,
    patch: {
      status: failedRequired ? 'failed' : 'passed',
      phase: 'validation-complete',
      artifacts: {
        validationResult: resultPath,
        failureDossier: dossierPath
      },
      validation: {
        resultStatus: result.status,
        passedCount: results.filter((r) => r.status === 'passed').length,
        failedCount: results.filter((r) => r.status === 'failed').length,
        skippedCount: results.filter((r) => r.status === 'skipped').length,
        completedAt: result.generatedAt
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
    if (result.status === 'failed' && result.required) break;
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
    const failedDependency = (node.dependsOn || []).find((dep) => {
      const depResult = byId.get(dep);
      return depResult && depResult.required && depResult.status === 'failed';
    });

    if (blockedByTierFailure && (tierOrder.get(node.tier) ?? 999) > blockedByTierFailure.tierOrder) {
      const skipped = skippedResult({ node, check, reason: `Skipped because required check failed in earlier tier: ${blockedByTierFailure.id}.` });
      results.push(skipped);
      byId.set(node.id, skipped);
      continue;
    }

    if (failedDependency) {
      const skipped = skippedResult({ node, check, reason: `Skipped because dependency failed: ${failedDependency}.` });
      results.push(skipped);
      byId.set(node.id, skipped);
      continue;
    }

    const result = runCheck({ root, check, node, timeoutMs });
    results.push(result);
    byId.set(node.id, result);

    if (result.status === 'failed' && result.required && validationPlan.graph.policy?.skipLaterTiersOnRequiredFailure !== false) {
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
    return skippedResult({
      node,
      check,
      reason: check
        ? `No available command. Candidate scripts: ${(check.candidates || []).join(', ')}`
        : `Graph node has no matching command: ${id}.`
    });
  }
  const res = run(check.command, { cwd: root, timeoutMs });
  return {
    id,
    commandId: check.id,
    label: check.label,
    tier: node?.tier || null,
    dependsOn: node?.dependsOn || [],
    command: check.command,
    required: Boolean(check.required),
    status: res.exitCode === 0 ? 'passed' : 'failed',
    exitCode: res.exitCode,
    signal: res.signal,
    durationMs: res.durationMs,
    stdout: res.stdout,
    stderr: res.stderr,
    error: res.error
  };
}

function skippedResult({ node = null, check = null, reason }) {
  return {
    id: node?.id || check?.id || 'unknown',
    commandId: check?.id || node?.commandId || null,
    label: check?.label || node?.id || 'Unknown check',
    tier: node?.tier || null,
    dependsOn: node?.dependsOn || [],
    command: check?.command || null,
    required: Boolean(check?.required ?? node?.required),
    status: 'skipped',
    reason
  };
}
