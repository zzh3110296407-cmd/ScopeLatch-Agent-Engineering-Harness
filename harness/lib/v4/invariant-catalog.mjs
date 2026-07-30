import fs from 'node:fs';
import path from 'node:path';
import { normalizePath } from '../common.mjs';
import { canonicalJson, digestCanonicalJson } from './canonical-json.mjs';

const CATALOG_RELATIVE_PATH = 'harness/contracts/v4/invariant-catalog.json';
const CATALOG_KEYS = ['catalogId', 'commands', 'contractVersion', 'invariants', 'schemaVersion'];
const COMMAND_KEYS = ['candidates', 'configKey', 'dependsOnAny', 'id', 'label', 'tier'];
const INVARIANT_KEYS = [
  'acceptanceId',
  'commands',
  'dependencies',
  'description',
  'formalEligible',
  'id',
  'selectorMode',
  'trigger',
  'version'
];
const TRIGGER_KEYS = [
  'always',
  'any',
  'categoryAny',
  'hasImpactedTests',
  'hasRequiredSynchronizations',
  'hasUnknownChangedFiles',
  'riskIn',
  'signalAny'
];
const SPECIAL_COMMANDS = new Set(['$behavior-test', '$synchronization-checks']);

export function invariantCatalogPath(root) {
  return path.join(root, ...CATALOG_RELATIVE_PATH.split('/'));
}

export function loadInvariantCatalog(root) {
  const file = invariantCatalogPath(root);
  let catalog;
  try {
    catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error('HARNESS_V4_INVARIANT_CATALOG_UNAVAILABLE');
  }
  const violations = validateInvariantCatalog(catalog);
  if (violations.length) {
    const error = new Error('HARNESS_V4_INVARIANT_CATALOG_INVALID');
    error.violations = violations;
    throw error;
  }
  return {
    catalog,
    path: normalizePath(path.relative(root, file)),
    digest: digestCanonicalJson(catalog)
  };
}

export function validateInvariantCatalog(catalog) {
  const violations = [];
  if (!isExactObject(catalog, CATALOG_KEYS)) {
    violations.push(violation('INVARIANT_CATALOG_SHAPE_INVALID', 'catalog'));
    return violations;
  }
  if (catalog.schemaVersion !== 1) violations.push(violation('INVARIANT_CATALOG_VERSION_UNSUPPORTED', 'catalog.schemaVersion'));
  if (catalog.catalogId !== 'harness-v4-invariant-catalog') violations.push(violation('INVARIANT_CATALOG_ID_INVALID', 'catalog.catalogId'));
  if (catalog.contractVersion !== 'harness-invariants-v4.0.0') {
    violations.push(violation('INVARIANT_CATALOG_CONTRACT_INVALID', 'catalog.contractVersion'));
  }
  if (!Array.isArray(catalog.commands) || !catalog.commands.length) {
    violations.push(violation('INVARIANT_COMMAND_CATALOG_EMPTY', 'catalog.commands'));
  }
  if (!Array.isArray(catalog.invariants) || !catalog.invariants.length) {
    violations.push(violation('INVARIANT_CATALOG_EMPTY', 'catalog.invariants'));
  }

  const commandIds = new Set();
  for (const [index, command] of (catalog.commands || []).entries()) {
    const safePath = `catalog.commands[${index}]`;
    if (!isExactObject(command, COMMAND_KEYS)) {
      violations.push(violation('INVARIANT_COMMAND_SHAPE_INVALID', safePath));
      continue;
    }
    if (!isContractId(command.id) || commandIds.has(command.id)) {
      violations.push(violation('INVARIANT_COMMAND_ID_INVALID', `${safePath}.id`));
    }
    commandIds.add(command.id);
    if (!nonEmpty(command.label) || !nonEmpty(command.configKey) || !nonEmpty(command.tier)) {
      violations.push(violation('INVARIANT_COMMAND_METADATA_INVALID', safePath));
    }
    if (!stringList(command.candidates) || !stringList(command.dependsOnAny)) {
      violations.push(violation('INVARIANT_COMMAND_LIST_INVALID', safePath));
    }
  }
  for (const [index, command] of (catalog.commands || []).entries()) {
    for (const dependency of command.dependsOnAny || []) {
      if (!commandIds.has(dependency)) {
        violations.push(violation('INVARIANT_COMMAND_DEPENDENCY_UNKNOWN', `catalog.commands[${index}].dependsOnAny`));
      }
    }
  }

  const invariantIds = new Set();
  const acceptanceIds = new Set();
  for (const [index, invariant] of (catalog.invariants || []).entries()) {
    const safePath = `catalog.invariants[${index}]`;
    if (!isExactObject(invariant, INVARIANT_KEYS)) {
      violations.push(violation('INVARIANT_SHAPE_INVALID', safePath));
      continue;
    }
    if (!isContractId(invariant.id) || invariantIds.has(invariant.id)) {
      violations.push(violation('INVARIANT_ID_INVALID', `${safePath}.id`));
    }
    invariantIds.add(invariant.id);
    if (!isContractId(invariant.acceptanceId) || acceptanceIds.has(invariant.acceptanceId)) {
      violations.push(violation('INVARIANT_ACCEPTANCE_ID_INVALID', `${safePath}.acceptanceId`));
    }
    acceptanceIds.add(invariant.acceptanceId);
    if (!Number.isInteger(invariant.version) || invariant.version < 1) {
      violations.push(violation('INVARIANT_VERSION_INVALID', `${safePath}.version`));
    }
    if (!nonEmpty(invariant.description) || typeof invariant.formalEligible !== 'boolean') {
      violations.push(violation('INVARIANT_METADATA_INVALID', safePath));
    }
    if (!['none', 'bind-behavior-suite'].includes(invariant.selectorMode)) {
      violations.push(violation('INVARIANT_SELECTOR_MODE_INVALID', `${safePath}.selectorMode`));
    }
    if (!stringList(invariant.dependencies) || !stringList(invariant.commands) || !invariant.commands.length) {
      violations.push(violation('INVARIANT_REQUIREMENTS_INVALID', safePath));
    }
    validateTrigger(invariant.trigger, `${safePath}.trigger`, violations);
    for (const commandId of invariant.commands || []) {
      if (!commandIds.has(commandId) && !SPECIAL_COMMANDS.has(commandId)) {
        violations.push(violation('INVARIANT_COMMAND_UNKNOWN', `${safePath}.commands`));
      }
    }
  }
  for (const [index, invariant] of (catalog.invariants || []).entries()) {
    for (const dependency of invariant.dependencies || []) {
      if (!invariantIds.has(dependency)) {
        violations.push(violation('INVARIANT_DEPENDENCY_UNKNOWN', `catalog.invariants[${index}].dependencies`));
      }
    }
  }
  if (hasDependencyCycle(catalog.invariants || [])) {
    violations.push(violation('INVARIANT_DEPENDENCY_CYCLE', 'catalog.invariants'));
  }
  return violations;
}

export function resolveInvariantPlan({ root, impactReport }) {
  const loaded = loadInvariantCatalog(root);
  const input = normalizeApplicabilityInput(impactReport);
  const byId = new Map(loaded.catalog.invariants.map((item) => [item.id, item]));
  const applicable = new Set(
    loaded.catalog.invariants
      .filter((invariant) => triggerMatches(invariant.trigger, input))
      .map((invariant) => invariant.id)
  );
  const visit = (id) => {
    const invariant = byId.get(id);
    if (!invariant) return;
    applicable.add(id);
    for (const dependency of invariant.dependencies) {
      if (!applicable.has(dependency)) visit(dependency);
    }
  };
  for (const id of [...applicable]) visit(id);

  const behaviorCommandId = input.riskLevel === 'L1' && !input.hasUnknownChangedFiles ? 'test' : 'test-unit';
  const synchronizationCommandIds = input.requiredSynchronizationChecks;
  const applicableInvariants = [...applicable].sort().map((id) => {
    const invariant = byId.get(id);
    const resultIds = expandCommands(invariant.commands, {
      behaviorCommandId,
      synchronizationCommandIds
    });
    return {
      invariantId: invariant.id,
      invariantVersion: invariant.version,
      acceptanceId: invariant.acceptanceId,
      dependencyInvariantIds: [...invariant.dependencies].sort(),
      resultIds,
      selectorMode: invariant.selectorMode,
      formalEligible: invariant.formalEligible
    };
  });
  const requiredCommandIds = [...new Set(applicableInvariants.flatMap((item) => item.resultIds))].sort();
  const commandReasons = Object.fromEntries(requiredCommandIds.map((commandId) => [
    commandId,
    applicableInvariants
      .filter((item) => item.resultIds.includes(commandId))
      .map((item) => item.invariantId)
      .sort()
  ]));
  const acceptanceRequirements = applicableInvariants.map((item) => ({
    acceptanceId: item.acceptanceId,
    invariantId: item.invariantId,
    invariantVersion: item.invariantVersion,
    required: true,
    resultIds: item.resultIds
  }));
  const testSelectorBindings = input.impactedTests.map((selector) => ({
    selector,
    resultId: behaviorCommandId,
    invariantId: 'impacted-test-coverage'
  }));
  const record = {
    schemaVersion: 1,
    catalogId: loaded.catalog.catalogId,
    catalogDigest: loaded.digest,
    applicabilityInputDigest: digestCanonicalJson(input),
    applicableInvariants,
    requiredCommandIds,
    commandReasons,
    acceptanceRequirements,
    testSelectorBindings,
    unknownChangedFiles: input.unknownChangedFiles,
    violations: acceptanceRequirements
      .filter((item) => !item.resultIds.length)
      .map((item) => violation('INVARIANT_REQUIRED_RESULTS_EMPTY', `acceptance.${item.acceptanceId}`))
  };
  return {
    catalog: {
      schemaVersion: loaded.catalog.schemaVersion,
      catalogId: loaded.catalog.catalogId,
      contractVersion: loaded.catalog.contractVersion,
      path: loaded.path,
      digest: loaded.digest
    },
    invariantPlan: {
      ...record,
      invariantPlanDigest: digestCanonicalJson(record)
    },
    commandDefinitions: loaded.catalog.commands
  };
}

export function verifyInvariantPlanBinding({ root, validationPlan, impactReport }) {
  if ((validationPlan?.schemaVersion || 0) < 3) {
    return { valid: true, mode: 'legacy-unbound', violations: [], resolved: null };
  }
  const violations = [];
  let resolved;
  try {
    resolved = resolveInvariantPlan({ root, impactReport });
  } catch (error) {
    return {
      valid: false,
      mode: 'catalog-bound',
      violations: error?.violations || [violation('INVARIANT_CATALOG_UNAVAILABLE', 'invariantCatalog')],
      resolved: null
    };
  }
  if (canonicalJson(validationPlan.invariantCatalog) !== canonicalJson(resolved.catalog)) {
    violations.push(violation('INVARIANT_CATALOG_BINDING_DRIFT', 'validationPlan.invariantCatalog'));
  }
  if (canonicalJson(validationPlan.invariantPlan) !== canonicalJson(resolved.invariantPlan)) {
    violations.push(violation('INVARIANT_APPLICABILITY_DRIFT', 'validationPlan.invariantPlan'));
  }
  const graphNodeIds = new Set((validationPlan.graph?.nodes || []).map((item) => item.commandId || item.id));
  for (const requirement of validationPlan.invariantPlan?.acceptanceRequirements || []) {
    if (!requirement.resultIds?.length) {
      violations.push(violation('INVARIANT_REQUIRED_RESULTS_EMPTY', `acceptance.${requirement.acceptanceId}`));
    }
    for (const resultId of requirement.resultIds || []) {
      if (!graphNodeIds.has(resultId)) {
        violations.push(violation('INVARIANT_RESULT_NODE_MISSING', `acceptance.${requirement.acceptanceId}`));
      }
    }
  }
  const expectedPlanningDigest = computePlanningDigest(validationPlan);
  if (validationPlan.planningDigest !== expectedPlanningDigest) {
    violations.push(violation('INVARIANT_PLANNING_DIGEST_MISMATCH', 'validationPlan.planningDigest'));
  }
  return {
    valid: violations.length === 0,
    mode: 'catalog-bound',
    violations,
    resolved
  };
}

export function computePlanningDigest(validationPlan) {
  const stable = { ...validationPlan };
  delete stable.generatedAt;
  delete stable.planningDigest;
  return digestCanonicalJson(stable);
}

export function buildInvariantResults({ validationPlan, results }) {
  if ((validationPlan?.schemaVersion || 0) < 3) return [];
  const byId = new Map((results || []).map((item) => [item.commandId || item.id, item]));
  return (validationPlan.invariantPlan?.acceptanceRequirements || []).map((requirement) => {
    const observedResults = requirement.resultIds.map((resultId) => {
      const result = byId.get(resultId);
      return {
        resultId,
        outcome: result?.outcome || 'BLOCKED',
        evidenceBinding: result?.evidenceBinding || null
      };
    });
    const outcome = aggregateInvariantOutcome(observedResults.map((item) => item.outcome));
    const identity = {
      acceptanceId: requirement.acceptanceId,
      invariantId: requirement.invariantId,
      invariantVersion: requirement.invariantVersion,
      resultIds: requirement.resultIds,
      observedOutcomes: observedResults.map((item) => item.outcome)
    };
    return {
      schemaVersion: 1,
      invariantResultId: digestCanonicalJson(identity),
      ...identity,
      required: true,
      outcome,
      status: outcome.toLowerCase(),
      observedResults
    };
  });
}

export function deriveAcceptanceEvidence(invariantResults) {
  return [...(invariantResults || [])]
    .map((result) => ({
      acceptanceId: result.acceptanceId,
      invariantResultId: result.invariantResultId,
      outcome: result.outcome
    }))
    .sort((a, b) => a.acceptanceId.localeCompare(b.acceptanceId));
}

export function validateAcceptanceEvidence({ acceptanceEvidence, invariantResults }) {
  const expected = deriveAcceptanceEvidence(invariantResults);
  const violations = [];
  if (canonicalJson(acceptanceEvidence) !== canonicalJson(expected)) {
    violations.push(violation('INVARIANT_ACCEPTANCE_EVIDENCE_MISMATCH', 'acceptanceEvidence'));
  }
  if (expected.some((item) => item.outcome !== 'PASS')) {
    violations.push(violation('INVARIANT_ACCEPTANCE_NOT_PASSED', 'acceptanceEvidence'));
  }
  return { valid: violations.length === 0, violations, expected };
}

function normalizeApplicabilityInput(impactReport = {}) {
  const categories = Object.fromEntries(
    Object.entries(impactReport.categories || {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, values]) => [key, uniqueStrings(values)])
  );
  const changedFiles = uniqueStrings(impactReport.changedFiles);
  const categorizedFiles = new Set(Object.values(categories).flat());
  const unknownChangedFiles = changedFiles.filter((file) => !categorizedFiles.has(file));
  const requiredSynchronizations = (impactReport.requiredSynchronizations || [])
    .filter((item) => item?.required !== false)
    .map((item) => ({
      domain: String(item?.domain || ''),
      validationChecks: uniqueStrings(item?.validationChecks)
    }))
    .sort((a, b) => a.domain.localeCompare(b.domain));
  return {
    riskLevel: ['L1', 'L2', 'L3', 'L4'].includes(impactReport.risk?.level) ? impactReport.risk.level : 'L4',
    categories,
    signals: uniqueStrings((impactReport.riskSignals || []).map((item) => item?.signal)),
    impactedTests: uniqueStrings(impactReport.impactedTests),
    changedFiles,
    unknownChangedFiles,
    hasUnknownChangedFiles: unknownChangedFiles.length > 0,
    hasImpactedTests: Boolean(impactReport.impactedTests?.length),
    hasRequiredSynchronizations: requiredSynchronizations.length > 0,
    requiredSynchronizationChecks: uniqueStrings(requiredSynchronizations.flatMap((item) => item.validationChecks)),
    requiredSynchronizations
  };
}

function triggerMatches(trigger, input) {
  if (trigger.always === true) return true;
  if (Array.isArray(trigger.any)) return trigger.any.some((item) => triggerMatches(item, input));
  if (Array.isArray(trigger.riskIn)) return trigger.riskIn.includes(input.riskLevel);
  if (Array.isArray(trigger.categoryAny)) {
    return trigger.categoryAny.some((category) => (input.categories[category] || []).length > 0);
  }
  if (Array.isArray(trigger.signalAny)) return trigger.signalAny.some((signal) => input.signals.includes(signal));
  if (trigger.hasImpactedTests === true) return input.hasImpactedTests;
  if (trigger.hasRequiredSynchronizations === true) return input.hasRequiredSynchronizations;
  if (trigger.hasUnknownChangedFiles === true) return input.hasUnknownChangedFiles;
  return false;
}

function validateTrigger(trigger, safePath, violations) {
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) {
    violations.push(violation('INVARIANT_TRIGGER_INVALID', safePath));
    return;
  }
  const keys = Object.keys(trigger);
  if (keys.length !== 1 || !TRIGGER_KEYS.includes(keys[0])) {
    violations.push(violation('INVARIANT_TRIGGER_SHAPE_INVALID', safePath));
    return;
  }
  if (keys[0] === 'any') {
    if (!Array.isArray(trigger.any) || !trigger.any.length) {
      violations.push(violation('INVARIANT_TRIGGER_ANY_EMPTY', safePath));
      return;
    }
    trigger.any.forEach((item, index) => validateTrigger(item, `${safePath}.any[${index}]`, violations));
  }
}

function expandCommands(commands, { behaviorCommandId, synchronizationCommandIds }) {
  return [...new Set(commands.flatMap((commandId) => {
    if (commandId === '$behavior-test') return [behaviorCommandId];
    if (commandId === '$synchronization-checks') return synchronizationCommandIds;
    return [commandId];
  }))].sort();
}

function aggregateInvariantOutcome(outcomes) {
  if (!outcomes.length || outcomes.includes('BLOCKED')) return 'BLOCKED';
  if (outcomes.includes('ERROR')) return 'ERROR';
  if (outcomes.includes('CANCELED')) return 'CANCELED';
  if (outcomes.includes('FAIL')) return 'FAIL';
  return outcomes.every((item) => item === 'PASS') ? 'PASS' : 'BLOCKED';
}

function hasDependencyCycle(invariants) {
  const byId = new Map(invariants.map((item) => [item.id, item]));
  const active = new Set();
  const done = new Set();
  const visit = (id) => {
    if (active.has(id)) return true;
    if (done.has(id)) return false;
    active.add(id);
    for (const dependency of byId.get(id)?.dependencies || []) {
      if (visit(dependency)) return true;
    }
    active.delete(id);
    done.add(id);
    return false;
  };
  return invariants.some((item) => visit(item.id));
}

function isExactObject(value, allowedKeys) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson([...allowedKeys].sort());
}

function stringList(value) {
  return Array.isArray(value) && value.every(nonEmpty) && new Set(value).size === value.length;
}

function uniqueStrings(value) {
  return [...new Set((Array.isArray(value) ? value : []).filter(nonEmpty))].sort();
}

function nonEmpty(value) {
  return typeof value === 'string' && value.length > 0;
}

function isContractId(value) {
  return nonEmpty(value) && /^[a-z][a-z0-9_-]{1,79}$/.test(value);
}

function violation(code, safePath) {
  return { code, safePath };
}
