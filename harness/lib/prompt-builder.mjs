import { truncate } from './common.mjs';

export function buildCodexPrompt({ task, contextPackMarkdown, impactReport, validationPlan, config, applicableRules = [] }) {
  return `# Codex Harness Prompt

You are working in a large production repository. Follow the harness output exactly.

## Goal

${task}

## Operating Rules

1. Do not edit until you inspect all Must Read files listed in the Context Pack.
2. Keep changes inside the Impact Report unless you discover a concrete missing dependency.
3. If you discover broader impact, update your implementation summary and validation assumptions.
4. Do not weaken tests to make failures pass.
5. If public API/schema changes, synchronize schema, generated clients, server/client usages, and contract tests.
6. If DB schema changes, update migrations, seed/fixtures, and integration tests.
7. If auth/payment/permission behavior changes, test both allowed and denied paths.
8. Use the change controls below for protected paths and repair rounds. File count is not a warning or stop condition.
9. Complete every Required Synchronization item listed below, or state the exact skipped reason.

## Change Controls

\`\`\`json
${JSON.stringify(renderChangeControls(config.changeBudget), null, 2)}
\`\`\`

## Context Pack

${contextPackMarkdown}

## Impact Report

\`\`\`json
${JSON.stringify(impactReport, null, 2)}
\`\`\`

## Required Synchronizations

${renderRequiredSynchronizations(impactReport.requiredSynchronizations)}

## Applicable Reviewed Rules

${renderApplicableRules(applicableRules)}

## Validation Plan

\`\`\`json
${JSON.stringify(validationPlan, null, 2)}
\`\`\`

## Implementation Instructions

- Start by reading the Must Read files.
- Identify exact files to change before editing.
- Make the smallest coherent change that satisfies the task.
- Add or update tests when behavior changes.
- Do not expand beyond the impact report without explaining why.
- Preserve existing architecture and project conventions.

## Done When

- The requested behavior is implemented.
- Required generated files are updated when applicable.
- Relevant tests are added or updated.
- Available validation commands from the plan pass.
- Skipped checks are listed with exact reasons.
- Final response includes changed files, risk areas, commands run, results, skipped checks, and remaining risks.

## Repair Loop Rules

If validation fails:

1. Read the failure output.
2. Identify the root cause.
3. Repair within the current impact area.
4. Re-run only the failed and dependent checks first.
5. Stop after ${config.changeBudget.maxRepairRounds} repair rounds and produce a failure dossier if still failing.
`;
}

function renderApplicableRules(rules = []) {
  if (!rules.length) return '_No reviewed project or failure rules matched this task._';
  return rules.map((rule) => {
    const domains = (rule.domains || []).join(', ') || 'all';
    return `- **${rule.id}** [${rule.source}; ${domains}]: ${rule.action}`;
  }).join('\n');
}

function renderRequiredSynchronizations(requiredSynchronizations = []) {
  if (!requiredSynchronizations.length) return '_No domain-specific synchronization requirements detected._';
  const lines = [];
  for (const sync of requiredSynchronizations) {
    lines.push(`### ${sync.domain}: ${sync.title}`);
    lines.push('');
    lines.push(`Required: ${sync.required ? 'yes' : 'no'}`);
    lines.push(`Validation checks: ${sync.validationChecks.join(', ')}`);
    lines.push('');
    lines.push('Review:');
    for (const item of sync.review) lines.push(`- ${item}`);
    lines.push('');
    lines.push('Triggered by:');
    for (const file of sync.trigger.files.slice(0, 12)) lines.push(`- ${file}`);
    if (!sync.trigger.files.length) lines.push('- risk signal or category match');
    lines.push('');
  }
  return lines.join('\n');
}

function renderChangeControls(changeBudget = {}) {
  return changeBudget || {};
}

export function buildFailureDossier({ validationResult, impactReport, validationPlan }) {
  const failed = validationResult.results.filter((r) => r.status === 'failed');
  const skipped = validationResult.results.filter((r) => r.status === 'skipped');
  const lines = [];
  lines.push('# Failure Dossier');
  lines.push('');
  lines.push(`Generated: ${validationResult.generatedAt}`);
  lines.push(`Overall status: ${validationResult.status}`);
  lines.push(`Risk level: ${impactReport?.risk?.level || validationPlan?.riskLevel || 'unknown'}`);
  lines.push('');
  lines.push('## Failed Checks');
  lines.push('');
  if (!failed.length) lines.push('_None._');
  for (const r of failed) {
    lines.push(`### ${r.id}: ${r.command}`);
    lines.push('');
    lines.push(`Exit code: ${r.exitCode}`);
    lines.push(`Duration: ${r.durationMs}ms`);
    lines.push('');
    lines.push('#### stdout');
    lines.push('```');
    lines.push(truncate(r.stdout, 5000));
    lines.push('```');
    lines.push('');
    lines.push('#### stderr');
    lines.push('```');
    lines.push(truncate(r.stderr, 5000));
    lines.push('```');
    lines.push('');
  }
  lines.push('## Skipped Checks');
  lines.push('');
  if (!skipped.length) lines.push('_None._');
  for (const r of skipped) lines.push(`- ${r.id}: ${r.reason}`);
  lines.push('');
  lines.push('## Required Synchronizations');
  lines.push('');
  const syncs = impactReport?.requiredSynchronizations || validationPlan?.requiredSynchronizations || [];
  if (!syncs.length) lines.push('_None detected._');
  for (const sync of syncs) {
    lines.push(`### ${sync.domain}: ${sync.title || sync.domain}`);
    lines.push('');
    if (sync.validationChecks?.length) lines.push(`Validation checks: ${sync.validationChecks.join(', ')}`);
    if (sync.review?.length) {
      lines.push('Review:');
      for (const item of sync.review) lines.push(`- ${item}`);
    }
    if (sync.trigger?.files?.length) {
      lines.push('Triggered files:');
      for (const file of sync.trigger.files.slice(0, 12)) lines.push(`- ${file}`);
    }
    lines.push('');
  }
  lines.push('## Impact Summary');
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
  lines.push('## Repair Instructions for Codex');
  lines.push('');
  lines.push('- Fix the root cause of the failed checks.');
  lines.push('- Stay within the direct targets and impacted dependents unless a concrete missing dependency is found.');
  lines.push('- Do not delete or weaken tests unless they are obsolete and explain why.');
  lines.push('- Re-run failed checks after the repair.');
  return `${lines.join('\n')}\n`;
}
