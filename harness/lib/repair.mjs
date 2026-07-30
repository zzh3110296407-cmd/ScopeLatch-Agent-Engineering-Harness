import crypto from 'node:crypto';
import path from 'node:path';
import { diffWorkingTreeSnapshots, readGuardedWorkingTreeSnapshot, runDiffGuard } from './guard.mjs';
import { manifestPathForRun, updateRunManifest } from './manifest.mjs';
import { validatePlan } from './validator.mjs';
import { checkCodexAvailable, runCodex } from './codex-runner.mjs';
import { codexBindingEnvironment } from './session-binding.mjs';
import { ensureDir, normalizePath, readJson, writeJson, writeText } from './common.mjs';

export function repairRun({ root, runDir, config, options = {} }) {
  const validationResult = readJson(path.join(runDir, 'validation-result.json'), null);
  if (!validationResult) throw new Error(`Cannot read validation result: ${path.join(runDir, 'validation-result.json')}`);
  if (validationResult.outcome === 'PASS') {
    return finishRepair({
      root,
      runDir,
      state: readRepairState(runDir),
      result: {
        status: 'not-needed',
        reason: `Validation outcome is ${validationResult.outcome}.`
      }
    });
  }
  if (validationResult.outcome !== 'FAIL') {
    return finishRepair({
      root,
      runDir,
      state: readRepairState(runDir),
      result: {
        status: 'blocked',
        reason: `validation-${String(validationResult.outcome || 'missing').toLowerCase()}-is-not-repairable`
      }
    });
  }

  const maxRounds = Number.isInteger(options.maxRounds)
    ? options.maxRounds
    : (config.changeBudget?.maxRepairRounds || 3);
  const state = readRepairState(runDir);
  const inputSignature = failureSignature(validationResult);

  if (state.rounds.length >= maxRounds) {
    return finishRepair({
      root,
      runDir,
      state,
      result: {
        status: 'blocked',
        reason: 'max-repair-rounds',
        maxRounds
      }
    });
  }

  const repeated = state.rounds.find((round) => round.outputSignature === inputSignature);
  if (repeated) {
    return finishRepair({
      root,
      runDir,
      state,
      result: {
        status: 'blocked',
        reason: 'repeated-failure-signature',
        repeatedRound: repeated.round,
        signature: inputSignature
      }
    });
  }

  const round = state.rounds.length + 1;
  const roundDir = path.join(runDir, 'repair', `round-${String(round).padStart(3, '0')}`);
  ensureDir(roundDir);

  const context = readRepairContext({ root, runDir, validationResult });
  const prompt = buildRepairPrompt({
    root,
    runDir,
    round,
    maxRounds,
    inputSignature,
    ...context
  });
  const promptPath = path.join(roundDir, 'repair-prompt.md');
  writeText(promptPath, prompt);

  const repairRound = {
    round,
    status: 'prompt-ready',
    inputSignature,
    promptPath: normalizePath(path.relative(root, promptPath)),
    startedAt: new Date().toISOString()
  };
  state.rounds.push(repairRound);
  writeRepairState(runDir, state);
  updateRepairManifest({
    root,
    runDir,
    result: {
      status: 'prompt-ready',
      round,
      signature: inputSignature
    },
    artifacts: { repairPrompt: promptPath }
  });

  if (options.promptOnly) {
    return {
      result: { status: 'prompt-ready', round, signature: inputSignature },
      promptPath,
      statePath: repairStatePath(runDir),
      manifestPath: manifestPathForRun(runDir)
    };
  }

  const codexCheck = checkCodexAvailable({ root });
  if (codexCheck.exitCode !== 0) {
    repairRound.status = 'prompt-ready';
    repairRound.reason = 'codex-cli-not-found';
    writeRepairState(runDir, state);
    return {
      result: {
        status: 'prompt-ready',
        reason: 'codex-cli-not-found',
        round,
        signature: inputSignature
      },
      promptPath,
      statePath: repairStatePath(runDir),
      manifestPath: manifestPathForRun(runDir)
    };
  }

  repairRound.status = 'codex-running';
  writeRepairState(runDir, state);
  updateRepairManifest({
    root,
    runDir,
    result: {
      status: 'codex-running',
      round,
      signature: inputSignature
    },
    artifacts: { repairPrompt: promptPath }
  });

  const manifest = readJson(path.join(runDir, 'run-manifest.json'), null) || {};
  const codexResult = runCodex({
    root,
    input: prompt,
    timeoutMs: options.timeoutMs || 2 * 60 * 60 * 1000,
    env: codexBindingEnvironment({ root, config, manifest })
  });
  const codexResultPath = path.join(roundDir, 'codex-result.json');
  writeJson(codexResultPath, codexResult);
  repairRound.codexResultPath = normalizePath(path.relative(root, codexResultPath));
  repairRound.codexExitCode = codexResult.exitCode;

  if (codexResult.exitCode !== 0) {
    repairRound.status = 'failed';
    repairRound.reason = 'codex-exec-failed';
    repairRound.completedAt = new Date().toISOString();
    writeRepairState(runDir, state);
    return finishRepair({
      root,
      runDir,
      state,
      result: {
        status: 'failed',
        reason: 'codex-exec-failed',
        round,
        exitCode: codexResult.exitCode
      },
      artifacts: { repairPrompt: promptPath, repairCodexResult: codexResultPath }
    });
  }

  const guardRun = runDiffGuard({
    root,
    runDir,
    config,
    options: options.guardOptions || {}
  });
  repairRound.guardStatus = guardRun.result.status;
  if (guardRun.result.status === 'failed') {
    repairRound.status = 'blocked';
    repairRound.reason = 'guard-failed';
    repairRound.completedAt = new Date().toISOString();
    writeRepairState(runDir, state);
    return finishRepair({
      root,
      runDir,
      state,
      result: {
        status: 'blocked',
        reason: 'guard-failed',
        round,
        guardStatus: guardRun.result.status
      },
      artifacts: { repairPrompt: promptPath, repairCodexResult: codexResultPath }
    });
  }

  const beforeValidation = readGuardedWorkingTreeSnapshot(root);
  const validationRun = validatePlan({ root, planPath: path.join(runDir, 'validation-plan.json') });
  const postValidationGuard = runDiffGuard({
    root,
    runDir,
    config,
    options: options.guardOptions || {},
    resultFileName: 'post-validation-guard-result.json',
    artifactKey: 'postValidationGuardResult',
    passedStatus: validationRun.result.outcome === 'PASS' ? 'passed' : 'guarded',
    passedPhase: 'repair-closeout-complete'
  });
  const validationSideEffects = diffWorkingTreeSnapshots(beforeValidation, readGuardedWorkingTreeSnapshot(root));
  if (validationSideEffects.length) {
    postValidationGuard.result.status = 'failed';
    postValidationGuard.result.summary.blockerCount += 1;
    postValidationGuard.result.findings.unshift({
      id: 'validation-side-effect',
      severity: 'blocker',
      message: 'Validation commands changed the guarded working tree.',
      files: validationSideEffects
    });
    writeJson(postValidationGuard.resultPath, postValidationGuard.result);
  }
  repairRound.postValidationGuardStatus = postValidationGuard.result.status;
  if (postValidationGuard.result.status === 'failed') {
    repairRound.status = 'blocked';
    repairRound.reason = 'post-validation-guard-failed';
    repairRound.completedAt = new Date().toISOString();
    writeRepairState(runDir, state);
    return finishRepair({
      root,
      runDir,
      state,
      result: {
        status: 'blocked',
        reason: 'post-validation-guard-failed',
        round,
        files: validationSideEffects
      },
      artifacts: { repairPrompt: promptPath, repairCodexResult: codexResultPath }
    });
  }
  repairRound.validationOutcome = validationRun.result.outcome;
  if (validationRun.result.outcome === 'FAIL') {
    const outputSignature = failureSignature(validationRun.result);
    repairRound.outputSignature = outputSignature;
    repairRound.completedAt = new Date().toISOString();
    if (outputSignature === inputSignature) {
      repairRound.status = 'blocked';
      repairRound.reason = 'repeated-failure-signature';
      writeRepairState(runDir, state);
      return finishRepair({
        root,
        runDir,
        state,
        result: {
          status: 'blocked',
          reason: 'repeated-failure-signature',
          round,
          signature: outputSignature
        },
        artifacts: { repairPrompt: promptPath, repairCodexResult: codexResultPath }
      });
    }
    repairRound.status = 'failed';
    repairRound.reason = 'validation-failed';
    writeRepairState(runDir, state);
    return finishRepair({
      root,
      runDir,
      state,
      result: {
        status: 'failed',
        reason: 'validation-failed',
        round,
        signature: outputSignature
      },
      artifacts: { repairPrompt: promptPath, repairCodexResult: codexResultPath }
    });
  }

  repairRound.status = 'passed';
  repairRound.completedAt = new Date().toISOString();
  writeRepairState(runDir, state);
  return finishRepair({
    root,
    runDir,
    state,
    result: {
      status: 'passed',
      round
    },
    artifacts: { repairPrompt: promptPath, repairCodexResult: codexResultPath }
  });
}

export function failureSignature(validationResult) {
  const failed = (validationResult?.results || [])
    .filter((result) => result.outcome === 'FAIL')
    .map((result) => ({
      id: result.id,
      commandId: result.commandId || null,
      exitCode: result.exitCode ?? null,
      error: result.error || null,
      stdout: signatureText(result.stdout),
      stderr: signatureText(result.stderr)
    }));
  const payload = failed.length ? failed : [{ outcome: validationResult?.outcome || 'UNKNOWN' }];
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
}

function buildRepairPrompt({
  root,
  runDir,
  round,
  maxRounds,
  inputSignature,
  validationResult,
  impactReport,
  validationPlan
}) {
  const rel = (file) => normalizePath(path.relative(root, file));
  const failed = (validationResult.results || []).filter((result) => result.outcome === 'FAIL');
  const skipped = (validationResult.results || [])
    .filter((result) => ['BLOCKED', 'NOT_APPLICABLE'].includes(result.outcome));
  const lines = [];

  lines.push('# Harness Repair Prompt');
  lines.push('');
  lines.push(`Repair round: ${round} / ${maxRounds}`);
  lines.push(`Failure signature: ${inputSignature}`);
  lines.push(`Run directory: ${rel(runDir)}`);
  lines.push('');
  lines.push('## Required Reading');
  lines.push('');
  lines.push(`- ${rel(path.join(runDir, 'context-pack.md'))}`);
  lines.push(`- ${rel(path.join(runDir, 'impact-report.json'))}`);
  lines.push(`- ${rel(path.join(runDir, 'validation-plan.json'))}`);
  lines.push(`- ${rel(path.join(runDir, 'validation-result.json'))}`);
  lines.push(`- ${rel(path.join(runDir, 'failure-dossier.md'))}`);
  lines.push('');
  lines.push('## Repair Rules');
  lines.push('');
  lines.push('- Fix the root cause of the failed checks; do not paper over symptoms.');
  lines.push('- Do not weaken, delete, skip, or rename tests to make validation pass.');
  lines.push('- Do not touch unrelated formatting or unrelated files.');
  lines.push('- Do not touch forbidden dirs, runtime data, Harness runs/state/cache, or secrets.');
  lines.push('- Do not add dependencies unless the task explicitly requires it.');
  lines.push('- Stay inside direct targets, reverse dependents, impacted tests, and required synchronization domains unless a concrete missing dependency is found.');
  lines.push('- After editing, expect Harness to run diff guard before validation.');
  lines.push('');
  lines.push('## Failed checks');
  lines.push('');
  if (!failed.length) lines.push('_No failed checks were recorded._');
  for (const result of failed) {
    lines.push(`- ${result.id}: exit ${result.exitCode}; tier=${result.tier || 'none'}; required=${Boolean(result.required)}; command=${result.command || 'unavailable'}`);
  }
  lines.push('');
  lines.push('## Skipped checks');
  lines.push('');
  if (!skipped.length) lines.push('_No skipped checks were recorded._');
  for (const result of skipped) lines.push(`- ${result.id}: ${result.reason || 'no reason recorded'}`);
  lines.push('');
  lines.push('## Required Synchronizations');
  lines.push('');
  const syncs = impactReport?.requiredSynchronizations || validationPlan?.requiredSynchronizations || [];
  if (!syncs.length) lines.push('_None detected._');
  for (const sync of syncs) {
    lines.push(`- ${sync.domain}: checks=${(sync.validationChecks || []).join(', ') || 'none'}`);
  }
  lines.push('');
  lines.push('## Impact Bounds');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify({
    directTargets: impactReport?.directTargets || [],
    reverseDependents: impactReport?.reverseDependents || [],
    impactedTests: impactReport?.impactedTests || [],
    riskSignals: impactReport?.riskSignals || []
  }, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('## Output Requirements');
  lines.push('');
  lines.push('- Make the smallest coherent fix.');
  lines.push('- Report changed files and validation assumptions.');
  lines.push('- Do not paste raw command logs into the response; refer to failure dossier paths when needed.');
  return `${lines.join('\n')}\n`;
}

function readRepairContext({ runDir, validationResult }) {
  return {
    validationResult,
    impactReport: readJson(path.join(runDir, 'impact-report.json'), null),
    validationPlan: readJson(path.join(runDir, 'validation-plan.json'), null)
  };
}

function finishRepair({ root, runDir, state, result, artifacts = {} }) {
  state.status = result.status;
  state.updatedAt = new Date().toISOString();
  writeRepairState(runDir, state);
  const manifest = updateRepairManifest({ root, runDir, result, artifacts });
  return {
    result,
    statePath: repairStatePath(runDir),
    manifestPath: manifest ? manifestPathForRun(runDir) : null,
    manifest
  };
}

function updateRepairManifest({ root, runDir, result, artifacts = {} }) {
  const status = result.status === 'passed'
    ? 'passed'
    : result.status === 'codex-running'
      ? 'repairing'
    : result.status === 'prompt-ready'
      ? 'repair-prompt-ready'
      : result.status === 'not-needed'
        ? 'passed'
        : 'failed';
  const phase = result.status === 'passed'
    ? 'repair-complete'
    : result.status === 'codex-running'
      ? 'repair-codex-running'
    : result.status === 'prompt-ready'
      ? 'repair-prompt-ready'
      : result.status === 'not-needed'
        ? 'validation-complete'
        : 'repair-blocked';
  return updateRunManifest({
    runDir,
    patch: {
      status,
      phase,
      artifacts,
      repair: {
        ...result,
        updatedAt: new Date().toISOString()
      }
    }
  });
}

function readRepairState(runDir) {
  return readJson(repairStatePath(runDir), {
    schemaVersion: 1,
    status: 'new',
    rounds: []
  });
}

function writeRepairState(runDir, state) {
  writeJson(repairStatePath(runDir), state);
}

function repairStatePath(runDir) {
  return path.join(runDir, 'repair-state.json');
}

function signatureText(text) {
  return String(text || '')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<timestamp>')
    .replace(/\b\d+ms\b/g, '<duration>')
    .trim()
    .slice(0, 1000);
}
