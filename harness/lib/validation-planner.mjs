import { readPackageJson, resolveScriptCommand } from './repo.mjs';
import {
  computePlanningDigest,
  resolveInvariantPlan
} from './v4/invariant-catalog.mjs';
import { normalizeCommandContract } from './v4/safe-executor.mjs';

export function planValidation({ root, config, impactReport }) {
  const pkg = readPackageJson(root);
  const packageManager = config.packageManager;
  const resolved = resolveInvariantPlan({ root, impactReport });
  const definitionById = new Map(resolved.commandDefinitions.map((item) => [item.id, item]));
  const requiredIds = new Set(resolved.invariantPlan.requiredCommandIds);
  const orderedIds = [
    ...resolved.commandDefinitions.map((item) => item.id).filter((id) => requiredIds.has(id)),
    ...[...requiredIds].filter((id) => !definitionById.has(id)).sort()
  ];
  const commands = orderedIds.map((id) => {
    const definition = definitionById.get(id);
    const configured = definition ? config.commands?.[definition.configKey] : null;
    const candidates = definition?.candidates || [];
    const resolvedCommand = definition
      ? resolveScriptCommand(root, packageManager, pkg, configured, candidates)
      : null;
    const command = resolvedCommand ? normalizeCommandContract(resolvedCommand) : null;
    const invariantIds = resolved.invariantPlan.commandReasons[id] || [];
    return {
      id,
      label: definition?.label || id,
      command,
      available: Boolean(command),
      required: true,
      reason: invariantIds.length
        ? `Required by invariant catalog: ${invariantIds.join(', ')}.`
        : `Required command ${id} has no invariant owner.`,
      candidates,
      invariantIds
    };
  });
  const graph = buildValidationGraph({
    commands,
    definitionById
  });
  const plan = {
    schemaVersion: 4,
    generatedAt: new Date().toISOString(),
    riskLevel: impactReport.risk?.level || 'L4',
    packageManager,
    requiredCheckCount: commands.length,
    commands,
    graph,
    impactedTests: [...(impactReport.impactedTests || [])],
    requiredSynchronizations: impactReport.requiredSynchronizations || [],
    invariantCatalog: resolved.catalog,
    invariantPlan: resolved.invariantPlan,
    notes: buildNotes(commands, impactReport, resolved.invariantPlan),
    policy: {
      runAvailableOnly: true,
      skipUnavailableWithReason: true,
      failIfRequiredCommandFails: true,
      maxRepairRounds: config.changeBudget?.maxRepairRounds ?? 0
    }
  };
  plan.planningDigest = computePlanningDigest(plan);
  return plan;
}

function buildValidationGraph({ commands, definitionById }) {
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
      reason: 'Run node harness/cli.mjs run "<task>" to execute this guard automatically; when using validate directly, run guard --run <run> first.',
      invariantIds: []
    },
    ...commands.map((command) => {
      const definition = definitionById.get(command.id);
      const dependency = (definition?.dependsOnAny || []).find((id) => commandIds.has(id));
      return {
        id: command.id,
        commandId: command.id,
        kind: 'command',
        tier: definition?.tier || 'tier2-targeted',
        dependsOn: dependency ? [dependency] : [],
        available: command.available,
        required: true,
        reason: command.reason,
        invariantIds: command.invariantIds
      };
    })
  ];
  return {
    schemaVersion: 2,
    mode: 'catalog',
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
      guardMode: 'run-or-manual-cli',
      applicabilityAuthority: 'harness-v4-invariant-catalog'
    }
  };
}

function buildNotes(commands, impactReport, invariantPlan) {
  const notes = [];
  const unavailableRequired = commands.filter((command) => !command.available);
  if (unavailableRequired.length) {
    notes.push(`Required invariant results without executable commands: ${unavailableRequired.map((item) => item.id).join(', ')}.`);
  }
  if ((impactReport.impactedTests || []).length) {
    notes.push(`Impacted test selectors are bound to executable results: ${invariantPlan.testSelectorBindings.map((item) => `${item.selector}->${item.resultId}`).join(', ')}`);
  }
  if ((impactReport.requiredSynchronizations || []).length) {
    notes.push(`Required synchronizations compiled by catalog: ${(impactReport.requiredSynchronizations || []).map((item) => item.domain).join(', ')}.`);
  }
  if (invariantPlan.unknownChangedFiles.length) {
    notes.push(`Conservative profile applied to unknown changed files: ${invariantPlan.unknownChangedFiles.join(', ')}.`);
  }
  return notes;
}
