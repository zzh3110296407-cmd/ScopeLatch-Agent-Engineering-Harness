import path from 'node:path';
import { matchesAny, unique } from './common.mjs';
import { changedFiles, filterRepoFiles } from './repo.mjs';
import { buildImportGraph, reverseDependents } from './import-graph.mjs';
import { buildRequiredSynchronizations } from './synchronizations.mjs';

export function analyzeImpact({ root, taskInfo, contextPack, files, config, baseRef = null, includeWorkingTreeChanges = false }) {
  const filtered = filterRepoFiles(files, config);
  const changed = includeWorkingTreeChanges ? changedFiles(root, baseRef).filter((f) => filtered.includes(f)) : [];
  const directTargets = unique([
    ...contextPack.mustRead.filter((f) => !/(^|\/)AGENTS\.md$/i.test(f)),
    ...changed
  ]).slice(0, 50);

  const { importedBy } = buildImportGraph(root, filtered, config.context.maxFileBytesToScan);
  const dependents = reverseDependents(importedBy, directTargets, 2).slice(0, 80);
  const impactedTests = findImpactedTests(filtered, directTargets, dependents, contextPack.relatedTests);
  const categories = categorizeFiles(unique([...directTargets, ...changed]), config);
  const riskSignals = buildRiskSignals({ taskInfo, categories, directTargets, dependents, changed, config });
  const risk = computeRisk({ riskSignals, categories, dependents, changed });
  const requiredSynchronizations = buildRequiredSynchronizations({
    taskInfo,
    categories,
    riskSignals,
    directTargets,
    changedFiles: changed
  });

  return {
    task: taskInfo.raw,
    generatedAt: new Date().toISOString(),
    baseRef,
    changedFiles: changed,
    directTargets,
    reverseDependents: dependents,
    impactedTests,
    categories,
    risk,
    riskSignals,
    requiredSynchronizations,
    changeBudget: config.changeBudget,
    escalationRequired: risk.level === 'L4' || riskSignals.some((s) => s.severity === 'high'),
    recommendations: recommendations({ categories, risk, impactedTests, requiredSynchronizations })
  };
}

function categorizeFiles(files, config) {
  const rules = config.riskRules;
  const out = {
    publicApi: [],
    database: [],
    auth: [],
    payment: [],
    shared: [],
    buildSystem: [],
    tests: [],
    frontend: [],
    backend: [],
    docs: []
  };
  for (const file of files) {
    if (matchesAny(file, rules.publicApiPatterns)) out.publicApi.push(file);
    if (matchesAny(file, rules.databasePatterns)) out.database.push(file);
    if (matchesAny(file, rules.authPatterns)) out.auth.push(file);
    if (matchesAny(file, rules.paymentPatterns)) out.payment.push(file);
    if (matchesAny(file, rules.sharedPatterns)) out.shared.push(file);
    if (matchesAny(file, rules.buildSystemPatterns)) out.buildSystem.push(file);
    if (/(\.test\.|\.spec\.|__tests__|\/tests?\/|\/e2e\/)/i.test(file)) out.tests.push(file);
    if (/(^|\/)(frontend|client|web|app|pages|components|ui)(\/|$)/i.test(file)) out.frontend.push(file);
    if (/(^|\/)(backend|server|services|controllers|routes|api)(\/|$)/i.test(file)) out.backend.push(file);
    if (/\.(md|mdx|txt)$/i.test(file) || /(^|\/)docs?\//i.test(file)) out.docs.push(file);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, unique(v)]));
}

function buildRiskSignals({ taskInfo, categories, directTargets, dependents, changed, config }) {
  const signals = [];
  for (const hint of taskInfo.riskHints) signals.push({ signal: hint, severity: hint === 'shared-change' ? 'medium' : 'high', source: 'task' });
  if (categories.publicApi.length) signals.push({ signal: 'public-api-change', severity: 'high', source: 'path', files: categories.publicApi });
  if (categories.database.length) signals.push({ signal: 'database-migration', severity: 'high', source: 'path', files: categories.database });
  if (categories.auth.length) signals.push({ signal: 'auth-change', severity: 'high', source: 'path', files: categories.auth });
  if (categories.payment.length) signals.push({ signal: 'payment-change', severity: 'high', source: 'path', files: categories.payment });
  if (categories.buildSystem.length) signals.push({ signal: 'build-system-change', severity: 'high', source: 'path', files: categories.buildSystem });
  if (categories.shared.length) signals.push({ signal: 'shared-change', severity: 'medium', source: 'path', files: categories.shared });
  if (dependents.length > 20) signals.push({ signal: 'many-reverse-dependents', severity: 'high', source: 'import-graph', count: dependents.length });
  else if (dependents.length > 8) signals.push({ signal: 'several-reverse-dependents', severity: 'medium', source: 'import-graph', count: dependents.length });
  for (const dir of config.changeBudget.forbiddenDirs || []) {
    const touched = directTargets.filter((f) => f === dir || f.startsWith(`${dir.replace(/\/$/, '')}/`));
    if (touched.length) signals.push({ signal: 'forbidden-dir-touched', severity: 'high', source: 'budget', files: touched });
  }
  return dedupeSignals(signals);
}

function computeRisk({ riskSignals, categories, dependents, changed }) {
  let score = 1;
  const reasons = [];
  const high = riskSignals.filter((s) => s.severity === 'high');
  const medium = riskSignals.filter((s) => s.severity === 'medium');
  score += high.length * 2 + medium.length;
  if (!high.length && !medium.length && categories.docs.length && Object.values(categories).flat().length === categories.docs.length) {
    score = Math.min(score, 1);
    reasons.push('docs-only impact');
  }
  if (dependents.length) reasons.push(`${dependents.length} reverse dependents`);
  for (const s of riskSignals) reasons.push(`${s.signal} via ${s.source}`);
  let level = 'L1';
  if (score >= 7) level = 'L4';
  else if (score >= 4) level = 'L3';
  else if (score >= 2) level = 'L2';
  return { level, score, reasons: unique(reasons) };
}

function findImpactedTests(files, directTargets, dependents, relatedTests) {
  const tests = new Set(relatedTests || []);
  const bases = unique([...directTargets, ...dependents].map((f) => path.basename(f).replace(/\.[^.]+$/, '').toLowerCase()).filter((b) => b && b.length > 2));
  for (const f of files) {
    if (!/(\.test\.|\.spec\.|__tests__|\/tests?\/|\/e2e\/)/i.test(f)) continue;
    const lower = f.toLowerCase();
    if (bases.some((b) => lower.includes(b))) tests.add(f);
  }
  return [...tests].slice(0, 40);
}

function recommendations({ categories, risk, impactedTests, requiredSynchronizations }) {
  const recs = [];
  for (const sync of requiredSynchronizations || []) {
    recs.push(`Required synchronization: ${sync.domain} (${sync.review.slice(0, 2).join('; ')}).`);
  }
  if (categories.publicApi.length) recs.push('Synchronize schema, generated clients, server handlers, consumers, and contract tests.');
  if (categories.database.length) recs.push('Check migrations, rollback/down migration, seed data, fixtures, and integration tests.');
  if (categories.auth.length) recs.push('Test both allowed and denied auth/permission paths.');
  if (categories.payment.length) recs.push('Check idempotency, amount precision, ledger/audit effects, and gateway mocks.');
  if (categories.shared.length) recs.push('Run reverse dependent typecheck/tests for shared utilities and types.');
  if (categories.buildSystem.length) recs.push('Run build/dry-run CI checks; avoid changing lockfiles unless required.');
  if (!impactedTests.length && risk.level !== 'L1') recs.push('No impacted tests found; Codex should add or identify coverage before finishing.');
  return recs.length ? recs : ['Keep change scoped; run planned validation before final response.'];
}

function dedupeSignals(signals) {
  const seen = new Set();
  const out = [];
  for (const s of signals) {
    const key = `${s.signal}:${s.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}
