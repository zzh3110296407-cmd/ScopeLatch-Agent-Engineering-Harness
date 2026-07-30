import { validateCommandContract } from './safe-executor.mjs';

export const CHECK_OUTCOMES = Object.freeze([
  'PASS',
  'FAIL',
  'BLOCKED',
  'ERROR',
  'CANCELED',
  'NOT_APPLICABLE'
]);

export const RUN_OUTCOMES = Object.freeze([
  'PASS',
  'FAIL',
  'BLOCKED',
  'ERROR',
  'CANCELED',
  'INVALIDATED'
]);

export function validateExecutionPlan(plan) {
  const violations = [];
  const commands = Array.isArray(plan?.commands) ? plan.commands : [];
  const graphNodes = Array.isArray(plan?.graph?.nodes) ? plan.graph.nodes : [];
  const hasGraphContract = Boolean(plan?.graph);

  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return invalid('PLAN_NOT_OBJECT', 'Execution plan must be an object.');
  }
  if (!Array.isArray(plan.commands)) {
    violations.push(violation('PLAN_COMMANDS_INVALID', 'commands', 'commands must be an array.'));
  }
  if (hasGraphContract && !Array.isArray(plan.graph.nodes)) {
    violations.push(violation('PLAN_GRAPH_NODES_INVALID', 'graph.nodes', 'graph.nodes must be an array.'));
  }

  const commandIds = uniqueIdentityViolations({
    items: commands,
    kind: 'command',
    pathPrefix: 'commands',
    violations
  });
  const nodeIds = uniqueIdentityViolations({
    items: graphNodes,
    kind: 'graph node',
    pathPrefix: 'graph.nodes',
    violations
  });
  const commandsById = new Map(commands.filter((item) => validId(item?.id)).map((item) => [item.id, item]));
  const commandNodes = graphNodes.filter((node) => node?.kind !== 'manual-guard');
  const nodesByCommand = new Map();

  for (let index = 0; index < commandNodes.length; index += 1) {
    const node = commandNodes[index] || {};
    const commandId = validId(node.commandId) ? node.commandId : validId(node.id) ? node.id : null;
    if (!commandId) {
      violations.push(violation(
        'PLAN_GRAPH_COMMAND_ID_MISSING',
        `graph.nodes[${index}].commandId`,
        'Every command graph node must identify a command.'
      ));
      continue;
    }
    if (!commandsById.has(commandId)) {
      violations.push(violation(
        'PLAN_GRAPH_COMMAND_UNRESOLVED',
        `graph.nodes[${index}].commandId`,
        `Graph node references unknown command ${commandId}.`
      ));
    }
    const indexes = nodesByCommand.get(commandId) || [];
    indexes.push(index);
    nodesByCommand.set(commandId, indexes);
  }

  if (hasGraphContract) {
    for (let index = 0; index < commands.length; index += 1) {
      const item = commands[index] || {};
      if (!validId(item.id)) continue;
      const coverage = nodesByCommand.get(item.id) || [];
      if (coverage.length === 0) {
        violations.push(violation(
          item.required ? 'PLAN_REQUIRED_COMMAND_NODE_MISSING' : 'PLAN_COMMAND_NODE_MISSING',
          `commands[${index}].id`,
          `Command ${item.id} has no execution graph node.`
        ));
      } else if (coverage.length > 1) {
        violations.push(violation(
          'PLAN_COMMAND_NODE_DUPLICATE',
          `commands[${index}].id`,
          `Command ${item.id} has ${coverage.length} execution graph nodes.`
        ));
      }
    }
  }

  for (let index = 0; index < commands.length; index += 1) {
    const item = commands[index] || {};
    if (item.available !== true) continue;
    const contractValidation = validateCommandContract(item.command);
    for (const detail of contractValidation.violations) {
      violations.push(violation(
        detail.code,
        `commands[${index}].${detail.safePath}`,
        detail.message
      ));
    }
  }

  for (let index = 0; index < graphNodes.length; index += 1) {
    const node = graphNodes[index] || {};
    if (node.dependsOn !== undefined && !Array.isArray(node.dependsOn)) {
      violations.push(violation(
        'PLAN_GRAPH_DEPENDENCIES_INVALID',
        `graph.nodes[${index}].dependsOn`,
        'dependsOn must be an array.'
      ));
      continue;
    }
    for (let depIndex = 0; depIndex < (node.dependsOn || []).length; depIndex += 1) {
      const dependency = node.dependsOn[depIndex];
      if (!nodeIds.has(dependency)) {
        violations.push(violation(
          'PLAN_GRAPH_DEPENDENCY_UNRESOLVED',
          `graph.nodes[${index}].dependsOn[${depIndex}]`,
          `Dependency ${dependency} does not resolve to a graph node.`
        ));
      }
      if (dependency === node.id) {
        violations.push(violation(
          'PLAN_GRAPH_SELF_DEPENDENCY',
          `graph.nodes[${index}].dependsOn[${depIndex}]`,
          `Node ${node.id} cannot depend on itself.`
        ));
      }
    }
  }

  if (detectCycle(graphNodes)) {
    violations.push(violation('PLAN_GRAPH_CYCLE', 'graph.nodes', 'Execution graph contains a dependency cycle.'));
  }

  const requiredCommands = commands.filter((item) => item?.required === true);
  if (!Number.isInteger(plan.requiredCheckCount) || plan.requiredCheckCount < 0) {
    violations.push(violation(
      'PLAN_REQUIRED_COUNT_INVALID',
      'requiredCheckCount',
      'requiredCheckCount must be a non-negative integer.'
    ));
  } else if (plan.requiredCheckCount !== requiredCommands.length) {
    violations.push(violation(
      'PLAN_REQUIRED_COUNT_MISMATCH',
      'requiredCheckCount',
      `Declared ${plan.requiredCheckCount}; observed ${requiredCommands.length}.`
    ));
  }

  return {
    valid: violations.length === 0,
    violations,
    commandIds: [...commandIds],
    requiredCommandIds: requiredCommands.map((item) => item.id).filter(validId),
    commandNodeCount: commandNodes.length
  };
}

export function aggregateExecutionOutcome({ plan, results, planValidation = validateExecutionPlan(plan) }) {
  const observations = Array.isArray(results) ? results : [];
  if (!planValidation.valid) {
    return aggregate('BLOCKED', 'PLAN_CONTRACT_INVALID', planValidation.violations.map((item) => item.code));
  }

  const requiredIds = planValidation.requiredCommandIds;
  if (requiredIds.length === 0) {
    return aggregate('BLOCKED', 'ZERO_APPLICABLE_REQUIRED_CHECKS', []);
  }

  const outcomes = observations.map((item) => normalizedCheckOutcome(item));
  if (outcomes.some((item) => item.outcome === 'FAIL')) {
    return aggregate('FAIL', 'CHECK_FAILED', outcomes.filter((item) => item.outcome === 'FAIL').map((item) => item.id));
  }
  if (outcomes.some((item) => item.outcome === 'ERROR')) {
    return aggregate('ERROR', 'CHECK_ERROR', outcomes.filter((item) => item.outcome === 'ERROR').map((item) => item.id));
  }
  if (outcomes.some((item) => item.outcome === 'CANCELED')) {
    return aggregate('BLOCKED', 'CHECK_CANCELED', outcomes.filter((item) => item.outcome === 'CANCELED').map((item) => item.id));
  }

  const requiredResults = new Map();
  for (const item of outcomes) {
    const key = item.commandId || item.id;
    if (!requiredIds.includes(key)) continue;
    if (!requiredResults.has(key)) requiredResults.set(key, []);
    requiredResults.get(key).push(item);
  }
  const missing = requiredIds.filter((id) => !requiredResults.has(id));
  if (missing.length) return aggregate('BLOCKED', 'REQUIRED_RESULT_MISSING', missing);

  const duplicates = [...requiredResults.entries()].filter(([, items]) => items.length !== 1).map(([id]) => id);
  if (duplicates.length) return aggregate('BLOCKED', 'REQUIRED_RESULT_AMBIGUOUS', duplicates);

  const blocked = [...requiredResults.entries()]
    .filter(([, items]) => items[0].outcome !== 'PASS')
    .map(([id]) => id);
  if (blocked.length) return aggregate('BLOCKED', 'REQUIRED_CHECK_NOT_PASS', blocked);

  return aggregate('PASS', 'ALL_APPLICABLE_REQUIRED_CHECKS_PASSED', requiredIds);
}

export function normalizedCheckOutcome(result) {
  if (CHECK_OUTCOMES.includes(result?.outcome)) {
    return {
      ...result,
      outcome: result.outcome
    };
  }
  return {
    ...result,
    outcome: 'ERROR',
    reasonCode: 'CHECK_OUTCOME_REQUIRED'
  };
}

function aggregate(outcome, reasonCode, evidenceIds) {
  return {
    outcome,
    developmentVerdict: outcome === 'PASS' ? 'PROVISIONAL_PASS' : outcome,
    formalEligible: false,
    reasonCode,
    evidenceIds: [...new Set(evidenceIds)].sort()
  };
}

function uniqueIdentityViolations({ items, kind, pathPrefix, violations }) {
  const ids = new Set();
  for (let index = 0; index < items.length; index += 1) {
    const id = items[index]?.id;
    if (!validId(id)) {
      violations.push(violation(
        'PLAN_ID_INVALID',
        `${pathPrefix}[${index}].id`,
        `${kind} ID must be a non-empty string.`
      ));
      continue;
    }
    if (ids.has(id)) {
      violations.push(violation(
        'PLAN_ID_DUPLICATE',
        `${pathPrefix}[${index}].id`,
        `Duplicate ${kind} ID ${id}.`
      ));
    }
    ids.add(id);
  }
  return ids;
}

function detectCycle(nodes) {
  const dependencies = new Map(
    nodes
      .filter((node) => validId(node?.id))
      .map((node) => [node.id, (node.dependsOn || []).filter(validId)])
  );
  const visiting = new Set();
  const visited = new Set();

  const visit = (id) => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of dependencies.get(id) || []) {
      if (dependencies.has(dependency) && visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };

  return [...dependencies.keys()].some(visit);
}

function invalid(code, message) {
  return {
    valid: false,
    violations: [violation(code, '$', message)],
    commandIds: [],
    requiredCommandIds: [],
    commandNodeCount: 0
  };
}

function violation(code, safePath, message) {
  return { code, safePath, message };
}

function validId(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
