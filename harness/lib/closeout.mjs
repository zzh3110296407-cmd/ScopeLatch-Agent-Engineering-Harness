import path from 'node:path';
import { diffWorkingTreeSnapshots, readGuardedWorkingTreeSnapshot, runDiffGuard } from './guard.mjs';
import { recordFailureKnowledge } from './knowledge.mjs';
import { updateRunManifest } from './manifest.mjs';
import { writePrReport } from './report.mjs';
import { validatePlan } from './validator.mjs';
import { readJson, writeJson } from './common.mjs';
import { removeSessionLease } from './session-binding.mjs';
import { readRunState, transitionRunState } from './v4/concurrent-state.mjs';

export function closeRun({ root, runDir, config, guardOptions = {} }) {
  const guard = runDiffGuard({ root, runDir, config, options: guardOptions });
  let validation = null;
  let postValidationGuard = null;
  let validationSideEffectFiles = [];

  if (guard.result.status !== 'failed') {
    const beforeValidation = readGuardedWorkingTreeSnapshot(root);
    validation = validatePlan({ root, planPath: path.join(runDir, 'validation-plan.json') });
    postValidationGuard = runDiffGuard({
      root,
      runDir,
      config,
      options: guardOptions,
      resultFileName: 'post-validation-guard-result.json',
      artifactKey: 'postValidationGuardResult',
      passedStatus: lifecycleStatusForOutcome(validation.result.outcome),
      passedPhase: validation.result.outcome === 'PASS'
        ? 'closeout-complete'
        : `closeout-${validation.result.outcome.toLowerCase()}`
    });
    validationSideEffectFiles = diffWorkingTreeSnapshots(beforeValidation, readGuardedWorkingTreeSnapshot(root));
    if (validationSideEffectFiles.length) {
      postValidationGuard.result.status = 'failed';
      postValidationGuard.result.summary.blockerCount += 1;
      postValidationGuard.result.findings.unshift({
        id: 'validation-side-effect',
        severity: 'blocker',
        message: 'Validation commands changed the guarded working tree.',
        files: validationSideEffectFiles
      });
      writeJson(postValidationGuard.resultPath, postValidationGuard.result);
      postValidationGuard.manifest = updateRunManifest({
        runDir,
        patch: {
          status: 'failed',
          phase: 'post-validation-guard-failed',
          guard: {
            status: 'failed',
            blockerCount: postValidationGuard.result.summary.blockerCount,
            warningCount: postValidationGuard.result.summary.warningCount,
            checkedAt: postValidationGuard.result.generatedAt
          }
        }
      });
    }
  }

  const report = writePrReport({ root, runDir });
  const status = closeoutStatus({
    guardStatus: guard.result.status,
    validationOutcome: validation?.result.outcome,
    postValidationGuardStatus: postValidationGuard?.result.status,
    validationSideEffectFiles
  });
  const knowledge = status === 'failed' ? recordFailureKnowledge({ root, runDir }) : null;
  const manifest = readRunManifestSafe(runDir);
  if (manifest?.runId) {
    const stateDir = path.join(root, config.stateDir || '.harness/state');
    if (readRunState({ stateDir, runId: manifest.runId })) {
      transitionRunState({
        stateDir,
        runId: manifest.runId,
        lifecycle: status,
        reason: `closeout:${status}`
      });
    }
    if (status !== 'failed') removeSessionLease({ root, config, runId: manifest.runId });
  }
  return {
    status,
    guard,
    validation,
    postValidationGuard,
    validationSideEffectFiles,
    report,
    knowledge
  };
}

function closeoutStatus({
  guardStatus,
  validationOutcome,
  postValidationGuardStatus,
  validationSideEffectFiles
}) {
  if (guardStatus === 'failed' || postValidationGuardStatus === 'failed' || validationSideEffectFiles.length) return 'failed';
  if (!validationOutcome) return 'blocked';
  if (validationOutcome === 'PASS') return 'passed';
  if (['BLOCKED', 'ERROR', 'INVALIDATED'].includes(validationOutcome)) return validationOutcome.toLowerCase();
  return 'failed';
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

function readRunManifestSafe(runDir) {
  return readJson(path.join(runDir, 'run-manifest.json'), null);
}
