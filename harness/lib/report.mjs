import path from 'node:path';
import { readRunManifest, updateRunManifest } from './manifest.mjs';
import { failureSignature } from './repair.mjs';
import { normalizePath, readJson, writeJson, writeText } from './common.mjs';

export function writePrReport({ root, runDir }) {
  const manifest = readRunManifest(runDir);
  if (!manifest) throw new Error(`Cannot read run manifest: ${path.join(runDir, 'run-manifest.json')}`);

  const contextPack = readArtifactJson({ root, runDir, manifest, key: 'contextPackJson', fallback: 'context-pack.json' }) || {};
  const impactReport = readArtifactJson({ root, runDir, manifest, key: 'impactReport', fallback: 'impact-report.json' }) || {};
  const validationPlan = readArtifactJson({ root, runDir, manifest, key: 'validationPlan', fallback: 'validation-plan.json' }) || {};
  const validationResult = readArtifactJson({ root, runDir, manifest, key: 'validationResult', fallback: 'validation-result.json' }) || null;
  const guardResult = readArtifactJson({ root, runDir, manifest, key: 'guardResult', fallback: 'guard-result.json' }) || null;
  const repairState = readJson(path.join(runDir, 'repair-state.json'), null);

  const metrics = buildRunMetrics({
    manifest,
    contextPack,
    impactReport,
    validationPlan,
    validationResult,
    guardResult,
    repairState
  });
  const reportText = renderPrReport({
    manifest,
    impactReport,
    validationPlan,
    validationResult,
    guardResult,
    repairState,
    metrics
  });

  const reportPath = path.join(runDir, 'pr-report.md');
  const metricsPath = path.join(runDir, 'metrics.json');
  writeText(reportPath, reportText);
  writeJson(metricsPath, metrics);

  const updatedManifest = updateRunManifest({
    runDir,
    patch: {
      artifacts: {
        prReport: reportPath,
        metrics: metricsPath
      },
      metrics
    }
  });

  return {
    reportPath,
    metricsPath,
    metrics,
    manifest: updatedManifest
  };
}

export function buildRunMetrics({
  manifest = {},
  contextPack = {},
  impactReport = {},
  validationPlan = {},
  validationResult = null,
  guardResult = null,
  repairState = null
}) {
  const requiredCommands = (validationPlan.commands || []).filter((command) => command.required);
  const unavailableCommands = (validationPlan.commands || []).filter((command) => !command.available);
  const failedSignatures = validationResult?.status === 'failed'
    ? [failureSignature(validationResult)]
    : [];
  const outOfScope = (guardResult?.findings || [])
    .filter((finding) => finding.id === 'out-of-scope-change')
    .reduce((sum, finding) => sum + (finding.files || []).length, 0);

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    taskType: taskType({ manifest, contextPack, impactReport }),
    riskLevel: impactReport?.risk?.level || manifest?.risk?.level || null,
    mustReadCount: Array.isArray(contextPack.mustRead) ? contextPack.mustRead.length : 0,
    changedFileCount: Array.isArray(impactReport.changedFiles) ? impactReport.changedFiles.length : 0,
    requiredValidationCount: validationPlan.requiredCheckCount ?? requiredCommands.length,
    unavailableValidationCount: unavailableCommands.length,
    firstPassValidationResult: validationResult?.status || null,
    repairRounds: Array.isArray(repairState?.rounds) ? repairState.rounds.length : 0,
    finalStatus: manifest.status || null,
    durationMs: durationMs(manifest.createdAt, manifest.updatedAt),
    topFailureSignatures: failedSignatures,
    outOfScopeModificationCount: outOfScope
  };
}

function renderPrReport({
  manifest = {},
  impactReport = {},
  validationPlan = {},
  validationResult = null,
  guardResult = null,
  repairState = null,
  metrics = {}
}) {
  const lines = [];
  lines.push('# Harness PR Report');
  lines.push('');
  lines.push('## Task');
  lines.push('');
  lines.push(manifest.task?.raw || impactReport.task || '_Unknown task._');
  lines.push('');
  lines.push('## Risk');
  lines.push('');
  lines.push(`- Level: ${impactReport.risk?.level || manifest.risk?.level || 'unknown'}`);
  lines.push(`- Score: ${impactReport.risk?.score ?? manifest.risk?.score ?? 'unknown'}`);
  const signals = impactReport.riskSignals?.map((signal) => signal.signal || signal).filter(Boolean) || manifest.risk?.signals || [];
  lines.push(`- Signals: ${signals.length ? signals.join(', ') : 'none'}`);
  lines.push('');
  lines.push('## Changed Files');
  lines.push('');
  listLines(lines, impactReport.changedFiles || [], '_No changed files recorded._');
  lines.push('');
  lines.push('## Impact');
  lines.push('');
  lines.push(`- Direct targets: ${(impactReport.directTargets || []).length}`);
  lines.push(`- Reverse dependents: ${(impactReport.reverseDependents || []).length}`);
  lines.push(`- Impacted tests: ${(impactReport.impactedTests || []).length}`);
  if (impactReport.recommendations?.length) {
    lines.push('');
    lines.push('Recommendations:');
    listLines(lines, impactReport.recommendations);
  }
  lines.push('');
  lines.push('## Required Synchronizations');
  lines.push('');
  const syncs = impactReport.requiredSynchronizations || validationPlan.requiredSynchronizations || [];
  if (!syncs.length) lines.push('_None detected._');
  for (const sync of syncs) {
    lines.push(`- ${sync.domain}: ${sync.title || sync.domain}; checks=${(sync.validationChecks || []).join(', ') || 'none'}`);
  }
  lines.push('');
  lines.push('## Validation');
  lines.push('');
  if (!validationResult?.results?.length) {
    lines.push('_No validation result recorded._');
  } else {
    lines.push('| Check | Status | Required | Details |');
    lines.push('|---|---:|---:|---|');
    for (const result of validationResult.results) {
      const detail = result.reason || result.command || '';
      lines.push(`| ${result.id} | ${result.status} | ${Boolean(result.required)} | ${escapeCell(detail)} |`);
    }
  }
  lines.push('');
  lines.push('## Repair Rounds');
  lines.push('');
  if (!repairState?.rounds?.length) {
    lines.push('_No repair rounds recorded._');
  } else {
    lines.push('| Round | Status | Reason |');
    lines.push('|---:|---:|---|');
    for (const round of repairState.rounds) {
      lines.push(`| ${round.round} | ${round.status} | ${round.reason || ''} |`);
    }
  }
  lines.push('');
  lines.push('## Remaining Risks');
  lines.push('');
  const remaining = remainingRisks({ validationResult, guardResult, validationPlan });
  listLines(lines, remaining, '_No remaining risks detected by Harness._');
  lines.push('');
  lines.push('## Metrics');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(metrics, null, 2));
  lines.push('```');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function remainingRisks({ validationResult, guardResult, validationPlan }) {
  const risks = [];
  if (guardResult?.status && guardResult.status !== 'passed') {
    for (const finding of guardResult.findings || []) {
      risks.push(`${finding.severity || 'risk'}: ${finding.id} (${(finding.files || []).length} files)`);
    }
  }
  for (const result of validationResult?.results || []) {
    if (result.status === 'failed') risks.push(`Validation failed: ${result.id}`);
    if (result.status === 'skipped') risks.push(`Validation skipped: ${result.id}: ${result.reason || 'no reason recorded'}`);
  }
  for (const command of validationPlan.commands || []) {
    if (!command.available) risks.push(`Validation unavailable: ${command.id}`);
  }
  return risks;
}

function readArtifactJson({ root, runDir, manifest, key, fallback }) {
  const manifestPath = manifest.artifacts?.[key];
  const candidates = [
    manifestPath ? path.join(root, manifestPath) : null,
    fallback ? path.join(runDir, fallback) : null
  ].filter(Boolean);
  for (const candidate of candidates) {
    const value = readJson(candidate, null);
    if (value) return value;
  }
  return null;
}

function taskType({ manifest, contextPack, impactReport }) {
  return manifest.task?.intent?.primary
    || contextPack.taskInfo?.domains?.[0]
    || contextPack.taskInfo?.primaryTerms?.[0]
    || impactReport.requiredSynchronizations?.[0]?.domain
    || impactReport.riskSignals?.[0]?.signal
    || 'unknown';
}

function durationMs(start, end) {
  const a = Date.parse(start || '');
  const b = Date.parse(end || '');
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, b - a) : null;
}

function listLines(lines, values, empty = '_None._') {
  if (!values.length) {
    lines.push(empty);
    return;
  }
  for (const value of values) lines.push(`- ${value}`);
}

function escapeCell(value) {
  return normalizePath(String(value || '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')).slice(0, 500);
}
