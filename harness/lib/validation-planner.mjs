import { readPackageJson, resolveScriptCommand } from './repo.mjs';

export function planValidation({ root, config, impactReport }) {
  const pkg = readPackageJson(root);
  const pm = config.packageManager;
  const commandsConfig = config.commands || {};
  const commands = [];

  const add = (id, label, configured, candidates, reason, required = true) => {
    const command = resolveScriptCommand(root, pm, pkg, configured, candidates);
    commands.push({
      id,
      label,
      command,
      available: Boolean(command),
      required,
      reason,
      candidates
    });
  };

  const risk = impactReport.risk.level;
  const categories = impactReport.categories;
  const hasPublicApi = categories.publicApi.length > 0 || hasSignal(impactReport, 'public-api-change');
  const hasDb = categories.database.length > 0 || hasSignal(impactReport, 'database-migration');
  const hasAuth = categories.auth.length > 0 || hasSignal(impactReport, 'auth-change');
  const hasPayment = categories.payment.length > 0 || hasSignal(impactReport, 'payment-change');
  const hasShared = categories.shared.length > 0 || hasSignal(impactReport, 'shared-change');
  const hasBuild = categories.buildSystem.length > 0 || hasSignal(impactReport, 'build-system-change');

  add('lint', 'Lint', commandsConfig.lint, ['lint', 'check:lint'], 'Baseline static check.', risk !== 'L1' || hasBuild);

  if (risk !== 'L1' || hasShared || hasPublicApi || hasAuth || hasPayment) {
    add('typecheck', 'Typecheck', commandsConfig.typecheck, ['typecheck', 'check:types', 'tsc', 'type-check'], 'Type safety and reverse dependent breakage check.', true);
  }

  if (risk === 'L1') {
    add('test', 'Relevant or default tests', commandsConfig.testUnit, ['test:unit', 'test'], 'Low-risk change; run smallest available test suite.', false);
  } else {
    add('test-unit', 'Unit tests', commandsConfig.testUnit, ['test:unit', 'unit', 'test'], 'Behavior-level coverage for changed code.', true);
  }

  if (hasPublicApi) {
    add('generate-client', 'Generate API client/codegen', commandsConfig.generateClient, ['generate:client', 'codegen', 'generate', 'openapi:generate'], 'Public API/schema changed or likely affected.', true);
    add('test-contract', 'Contract tests', commandsConfig.testContract, ['test:contract', 'contract:test', 'test:api'], 'API/schema compatibility check.', true);
  }

  if (hasDb || hasAuth || hasPayment || risk === 'L3' || risk === 'L4') {
    add('test-integration', 'Integration tests', commandsConfig.testIntegration, ['test:integration', 'integration:test', 'test:int'], 'Cross-module or stateful behavior risk.', true);
  }

  if (hasAuth || hasPayment || risk === 'L4') {
    add('test-e2e', 'E2E tests', commandsConfig.testE2E, ['test:e2e', 'e2e', 'e2e:test'], 'High-risk user/business critical path.', risk === 'L4');
  }

  if (hasBuild || hasShared || risk === 'L3' || risk === 'L4') {
    add('build', 'Build', commandsConfig.build, ['build', 'compile'], 'Build output and package boundary validation.', true);
  }

  if (risk === 'L4') {
    add('full-ci', 'Full CI equivalent', commandsConfig.fullCI, ['ci', 'check', 'verify'], 'L4 risk requires highest available local validation.', false);
  }

  const deduped = dedupeCommands(commands);
  const graph = buildValidationGraph(deduped);
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    riskLevel: risk,
    packageManager: pm,
    requiredCheckCount: deduped.filter((c) => c.required).length,
    commands: deduped,
    graph,
    impactedTests: impactReport.impactedTests,
    requiredSynchronizations: impactReport.requiredSynchronizations || [],
    notes: buildNotes(deduped, impactReport),
    policy: {
      runAvailableOnly: true,
      skipUnavailableWithReason: true,
      failIfRequiredCommandFails: true,
      maxRepairRounds: config.changeBudget.maxRepairRounds
    }
  };
}

function buildValidationGraph(commands) {
  const commandIds = new Set(commands.map((command) => command.id));
  const nodes = [
    {
      id: 'diff-guard',
      commandId: null,
      kind: 'manual-guard',
      tier: 'tier0-guards',
      dependsOn: [],
      available: false,
      required: false,
      reason: 'Run node harness/cli.mjs run "<task>" to execute this guard automatically; when using validate directly, run guard --run <run> first.'
    },
    ...commands.map((command) => ({
      id: command.id,
      commandId: command.id,
      kind: 'command',
      tier: tierForCommand(command.id),
      dependsOn: dependenciesForCommand(command.id, commandIds),
      available: command.available,
      required: command.required,
      reason: command.reason
    }))
  ];

  return {
    schemaVersion: 1,
    mode: 'tiered',
    tiers: [
      { id: 'tier0-guards', order: 0, label: 'Deterministic guards', behavior: 'manual-before-validation' },
      { id: 'tier1-static', order: 1, label: 'Static validation' },
      { id: 'tier2-targeted', order: 2, label: 'Targeted validation' },
      { id: 'tier3-integration', order: 3, label: 'Integration validation' }
    ],
    nodes,
    policy: {
      skipLaterTiersOnRequiredFailure: true,
      skipDependentsOnFailedDependency: true,
      runUnavailableAsSkipped: true,
      guardMode: 'run-or-manual-cli'
    }
  };
}

function tierForCommand(id) {
  if (id === 'lint' || id === 'typecheck') return 'tier1-static';
  if (id === 'test' || id === 'test-unit' || id === 'generate-client' || id === 'test-contract') return 'tier2-targeted';
  return 'tier3-integration';
}

function dependenciesForCommand(id, commandIds) {
  if (id === 'lint') return [];
  if (id === 'typecheck') return commandIds.has('lint') ? ['lint'] : [];
  if (id === 'test' || id === 'test-unit') return firstExisting(commandIds, ['lint', 'typecheck']);
  if (id === 'generate-client') return firstExisting(commandIds, ['lint', 'typecheck']);
  if (id === 'test-contract') return firstExisting(commandIds, ['generate-client', 'typecheck', 'lint']);
  if (id === 'test-integration') return firstExisting(commandIds, ['test-contract', 'test-unit', 'typecheck', 'lint']);
  if (id === 'test-e2e') return firstExisting(commandIds, ['test-integration', 'test-contract', 'build', 'typecheck', 'lint']);
  if (id === 'build') return firstExisting(commandIds, ['typecheck', 'lint']);
  if (id === 'full-ci') return firstExisting(commandIds, ['test-e2e', 'test-integration', 'build', 'lint']);
  return firstExisting(commandIds, ['lint']);
}

function firstExisting(commandIds, candidates) {
  const found = candidates.find((candidate) => commandIds.has(candidate));
  return found ? [found] : [];
}

function hasSignal(report, signal) {
  return (report.riskSignals || []).some((s) => s.signal === signal);
}

function dedupeCommands(commands) {
  const out = [];
  const seenCommand = new Set();
  const seenId = new Set();
  for (const c of commands) {
    if (seenId.has(c.id)) continue;
    if (c.command && seenCommand.has(c.command)) continue;
    seenId.add(c.id);
    if (c.command) seenCommand.add(c.command);
    out.push(c);
  }
  return out;
}

function buildNotes(commands, impactReport) {
  const notes = [];
  const unavailableRequired = commands.filter((c) => c.required && !c.available);
  if (unavailableRequired.length) {
    notes.push(`Required checks without configured scripts: ${unavailableRequired.map((c) => c.id).join(', ')}. Configure them in .harness/harness.config.json or package.json.`);
  }
  if (impactReport.impactedTests.length) notes.push(`Impacted test candidates: ${impactReport.impactedTests.slice(0, 12).join(', ')}`);
  if ((impactReport.requiredSynchronizations || []).length) {
    const domains = impactReport.requiredSynchronizations.map((sync) => sync.domain).join(', ');
    notes.push(`Required synchronizations: ${domains}. Review listed downstream contracts before final response.`);
  }
  if (impactReport.escalationRequired) notes.push('Escalation required: high-risk signal detected. Codex should keep scope narrow and report remaining risk.');
  return notes;
}
