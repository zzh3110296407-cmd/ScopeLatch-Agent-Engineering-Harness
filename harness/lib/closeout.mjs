import path from 'node:path';
import { diffWorkingTreeSnapshots, readGuardedWorkingTreeSnapshot, runDiffGuard } from './guard.mjs';
import { recordFailureKnowledge } from './knowledge.mjs';
import { updateRunManifest } from './manifest.mjs';
import { writePrReport } from './report.mjs';
import { validatePlan } from './validator.mjs';
import { readJson, writeJson } from './common.mjs';
import { removeSessionLease } from './session-binding.mjs';

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
      passedStatus: validation.result.status === 'failed' ? 'failed' : 'passed',
      passedPhase: 'closeout-complete'
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
  const failed = guard.result.status === 'failed'
    || validation?.result.status === 'failed'
    || postValidationGuard?.result.status === 'failed'
    || validationSideEffectFiles.length > 0;
  const knowledge = failed ? recordFailureKnowledge({ root, runDir }) : null;
  if (!failed) {
    const manifest = readRunManifestSafe(runDir);
    if (manifest?.runId) removeSessionLease({ root, config, runId: manifest.runId });
  }
  return {
    status: failed ? 'failed' : 'passed',
    guard,
    validation,
    postValidationGuard,
    validationSideEffectFiles,
    report,
    knowledge
  };
}

function readRunManifestSafe(runDir) {
  return readJson(path.join(runDir, 'run-manifest.json'), null);
}
