import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, normalizePath, readJson, unique, writeJson, writeText } from './common.mjs';

const TRACKED_KNOWLEDGE_DIR = path.join('.harness', 'knowledge');
const RUNTIME_KNOWLEDGE_DIR = path.join('.harness', 'state', 'failure-knowledge');

export function recordFailureKnowledge({
  root,
  runDir,
  mode = process.env.HARNESS_OBSERVATION_MODE === 'shadow' ? 'read-only' : 'record'
}) {
  if (mode === 'read-only') {
    return { status: 'skipped', reason: 'knowledge-read-only', count: 0 };
  }
  if (mode !== 'record') throw new Error(`Unsupported failure knowledge mode: ${mode}.`);
  const impactReport = readJson(path.join(runDir, 'impact-report.json'), null) || {};
  const evidence = failureEvidence(runDir, impactReport);
  if (!evidence) return { status: 'skipped', reason: 'no-failed-run-evidence', count: 0 };
  const manifest = readJson(path.join(runDir, 'run-manifest.json'), null) || {};
  const runtimeKnowledgeDir = path.join(root, RUNTIME_KNOWLEDGE_DIR);
  ensureDir(runtimeKnowledgeDir);
  const relativeRunDir = normalizePath(path.relative(root, runDir));
  const eventId = `${relativeRunDir}:${evidence.signature}`;
  const entry = {
    schemaVersion: 4,
    eventId,
    recordedAt: new Date().toISOString(),
    signature: evidence.signature,
    source: evidence.source,
    runDir: relativeRunDir,
    task: manifest.task?.raw || impactReport.task || null,
    riskLevel: impactReport.risk?.level || manifest.risk?.level || null,
    failedChecks: evidence.failedChecks,
    findingIds: evidence.findingIds,
    domains: evidence.features.domains,
    fileClusters: evidence.features.fileClusters,
    errorSummaries: evidence.features.errorSummaries,
    evidenceQuality: evidence.evidenceQuality,
    synchronizationDomains: (impactReport.requiredSynchronizations || []).map((sync) => sync.domain).filter(Boolean),
    riskSignals: (impactReport.riskSignals || []).map((signal) => signal.signal || signal).filter(Boolean)
  };

  const failuresPath = path.join(runtimeKnowledgeDir, 'failures.jsonl');
  const entries = combinedFailureEntries(root);
  const alreadyRecorded = entries.some((item) => item.eventId === eventId);
  if (!alreadyRecorded) fs.appendFileSync(failuresPath, `${JSON.stringify(entry)}\n`, 'utf8');
  const allEntries = alreadyRecorded ? entries : [...entries, entry];
  const count = allEntries.filter((item) => item.signature === evidence.signature).length;
  const candidatePath = regenerateRuleCandidates({
    knowledgeDir: runtimeKnowledgeDir,
    entries: allEntries,
    reviews: readRuleReviews(path.join(root, TRACKED_KNOWLEDGE_DIR, 'rule-reviews.json'))
  });

  return {
    status: alreadyRecorded ? 'already-recorded' : 'recorded',
    signature: evidence.signature,
    count,
    failuresPath,
    candidatePath,
    rulesPath: null
  };
}

export function backfillFailureKnowledge({ root, runsDir = path.join(root, '.harness', 'runs'), rebuild = false }) {
  if (!fs.existsSync(runsDir)) return { status: 'skipped', scanned: 0, recorded: 0 };
  if (rebuild) {
    const failuresPath = path.join(root, RUNTIME_KNOWLEDGE_DIR, 'failures.jsonl');
    if (fs.existsSync(failuresPath)) fs.unlinkSync(failuresPath);
  }
  let scanned = 0;
  let recorded = 0;
  let existing = 0;
  for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const runDir = path.join(runsDir, entry.name);
    const impactReport = readJson(path.join(runDir, 'impact-report.json'), null) || {};
    if (!failureEvidence(runDir, impactReport)) continue;
    scanned += 1;
    const result = recordFailureKnowledge({ root, runDir });
    if (result.status === 'recorded') recorded += 1;
    if (result.status === 'already-recorded') existing += 1;
  }
  return { status: 'completed', scanned, recorded, existing };
}

export function promoteRuleCandidate({ root, candidateId, reviewer, reason }) {
  requireReviewField(candidateId, 'candidateId');
  requireReviewField(reviewer, 'reviewer');
  requireReviewField(reason, 'reason');
  const state = knowledgeState(root);
  const candidate = state.candidates.find((item) => item.id === candidateId);
  if (!candidate) throw new Error(`Unknown rule candidate: ${candidateId}.`);
  const quality = candidateEvidenceQuality(candidate);
  if (!quality.promotable) {
    throw new Error(`Rule candidate ${candidateId} cannot be promoted because evidence quality is ${quality.level}: ${quality.reasons.join(', ')}.`);
  }
  const review = {
    candidateId,
    signature: candidate.signature,
    status: 'approved',
    reviewer: reviewer.trim(),
    reason: reason.trim(),
    reviewedAt: new Date().toISOString(),
    evidenceCount: candidate.entries.length
  };
  upsertReview(state.reviews, review);
  writeRuleReviews(state.reviewPath, state.reviews);
  regenerateStableRules({ root, entries: state.entries, reviews: state.reviews });
  regenerateRuleCandidates({
    knowledgeDir: state.runtimeKnowledgeDir,
    entries: state.entries,
    reviews: state.reviews
  });
  return { status: 'promoted', review, rulesPath: path.join(root, '.harness', 'rules.yaml') };
}

export function rejectRuleCandidate({ root, candidateId, reviewer, reason }) {
  requireReviewField(candidateId, 'candidateId');
  requireReviewField(reviewer, 'reviewer');
  requireReviewField(reason, 'reason');
  const state = knowledgeState(root);
  const candidate = state.candidates.find((item) => item.id === candidateId);
  if (!candidate) throw new Error(`Unknown rule candidate: ${candidateId}.`);
  const review = {
    candidateId,
    signature: candidate.signature,
    status: 'rejected',
    reviewer: reviewer.trim(),
    reason: reason.trim(),
    reviewedAt: new Date().toISOString(),
    evidenceCount: candidate.entries.length
  };
  upsertReview(state.reviews, review);
  writeRuleReviews(state.reviewPath, state.reviews);
  regenerateStableRules({ root, entries: state.entries, reviews: state.reviews });
  regenerateRuleCandidates({
    knowledgeDir: state.runtimeKnowledgeDir,
    entries: state.entries,
    reviews: state.reviews
  });
  return { status: 'rejected', review };
}

export function listRuleCandidates({ root }) {
  const state = knowledgeState(root);
  return state.candidates.map((candidate) => ({
    id: candidate.id,
    signature: candidate.signature,
    count: candidate.entries.length,
    evidenceQuality: candidateEvidenceQuality(candidate),
    review: state.reviews.find((item) => item.candidateId === candidate.id) || null,
    domains: unique(candidate.entries.flatMap((entry) => entry.synchronizationDomains || [])).sort()
  }));
}

export function loadApplicableRules({ root, impactReport = {}, limit = 8 }) {
  const domains = new Set(inferDomains(impactReport));
  const manual = (readJson(path.join(root, '.harness', 'project-rules.json'), null)?.rules || [])
    .filter((rule) => rule.status === 'reviewed')
    .map((rule) => ({ ...rule, source: 'project-reviewed' }));
  const state = knowledgeState(root);
  const learned = state.candidates
    .map((candidate) => ({ candidate, review: state.reviews.find((item) => item.candidateId === candidate.id) }))
    .filter(({ candidate, review }) => review?.status === 'approved' && candidateEvidenceQuality(candidate).promotable)
    .map(({ candidate, review }) => {
      const latest = candidate.entries.at(-1);
      return {
        id: `reviewed-failure-${shortSignature(candidate.signature)}`,
        domains: unique(candidate.entries.flatMap((entry) => entry.synchronizationDomains || [])).sort(),
        action: ruleAdvice(unique(candidate.entries.flatMap((entry) => entry.synchronizationDomains || [])), latest),
        status: 'reviewed',
        reviewer: review.reviewer,
        source: 'failure-knowledge'
      };
    });
  return [...manual, ...learned]
    .map((rule) => ({
      ...rule,
      relevance: (rule.domains || []).filter((domain) => domains.has(domain)).length
    }))
    .filter((rule) => rule.relevance > 0 || (rule.domains || []).includes('all'))
    .sort((a, b) => b.relevance - a.relevance || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map(({ relevance, ...rule }) => rule);
}

function failureEvidence(runDir, impactReport = {}) {
  const domains = inferDomains(impactReport);
  const impactFiles = unique([
    ...(impactReport.directTargets || []),
    ...(impactReport.reverseDependents || []),
    ...(impactReport.impactedTests || [])
  ]);
  const validation = readJson(path.join(runDir, 'validation-result.json'), null);
  if (validation?.status === 'failed') {
    const failedChecks = (validation.results || []).filter((item) => item.status === 'failed').map((item) => ({
      id: item.id,
      commandId: item.commandId || null,
      exitCode: item.exitCode ?? null,
      stdout: item.stdout || '',
      stderr: item.stderr || '',
      error: item.error || item.reason || ''
    }));
  const detailed = buildDetailedFailureSignature({ source: 'validation', failedChecks, files: impactFiles, domains });
    return {
      source: 'validation',
      signature: detailed.signature,
      features: detailed.features,
      evidenceQuality: assessEvidenceQuality(detailed.features),
      failedChecks: failedChecks.map((item) => ({
        id: item.id,
        commandId: item.commandId || null,
        exitCode: item.exitCode ?? null
      })),
      findingIds: []
    };
  }
  const guard = readJson(path.join(runDir, 'post-validation-guard-result.json'), null)
    || readJson(path.join(runDir, 'guard-result.json'), null);
  if (guard?.status === 'failed') {
    const ids = (guard.findings || []).map((item) => item.id).filter(Boolean).sort();
    const files = unique((guard.findings || []).flatMap((item) => item.files || []));
    const detailed = buildDetailedFailureSignature({ source: 'guard', findingIds: ids, files: [...impactFiles, ...files], domains });
    return {
      source: 'guard',
      signature: detailed.signature,
      features: detailed.features,
      evidenceQuality: assessEvidenceQuality(detailed.features),
      failedChecks: [],
      findingIds: ids
    };
  }
  const codex = readJson(path.join(runDir, 'codex-result.json'), null);
  if (codex && Number(codex.exitCode) !== 0) {
    const failedChecks = [{ id: 'codex-exec', commandId: null, exitCode: codex.exitCode, error: codex.error || '' }];
    const detailed = buildDetailedFailureSignature({ source: 'codex', failedChecks, files: impactFiles, domains });
    return {
      source: 'codex',
      signature: detailed.signature,
      features: detailed.features,
      evidenceQuality: assessEvidenceQuality(detailed.features),
      failedChecks: [{ id: 'codex-exec', commandId: null, exitCode: codex.exitCode }],
      findingIds: []
    };
  }
  return null;
}

export function buildDetailedFailureSignature({ source = 'unknown', failedChecks = [], findingIds = [], files = [], domains = [] }) {
  const errorSummaries = failedChecks
    .map((item) => normalizeFailureText([item.error, item.stderr, item.stdout].filter(Boolean).join('\n')))
    .filter(Boolean)
    .sort();
  const features = {
    source,
    checks: failedChecks.map((item) => `${item.id || 'unknown'}:${item.commandId || 'none'}:${item.exitCode ?? 'none'}`).sort(),
    findingIds: unique(findingIds).sort(),
    domains: unique(domains).sort(),
    fileClusters: unique(files.map(fileCluster).filter(Boolean)).sort(),
    errorSummaries
  };
  return { signature: hashSignature(JSON.stringify(features)), features };
}

export function assessEvidenceQuality(features = {}) {
  const domains = unique(features.domains || []);
  const fileClusters = unique(features.fileClusters || []);
  const checks = unique(features.checks || []);
  const findingIds = unique(features.findingIds || []);
  const errorSummaries = unique(features.errorSummaries || []);
  const reasons = [];
  if (domains.length > 12 || fileClusters.length > 20) reasons.push('scope-too-broad');
  if (features.source === 'validation' && !checks.length) reasons.push('missing-failed-check');
  if (features.source === 'guard' && !findingIds.length) reasons.push('missing-guard-finding');
  if (features.source === 'guard' && findingIds.includes('validation-side-effect') && !errorSummaries.length) {
    reasons.push('unattributed-validation-side-effect');
  }
  if (features.source === 'codex' && !checks.length && !errorSummaries.length) reasons.push('missing-codex-failure');
  if (!['validation', 'guard', 'codex'].includes(features.source)) reasons.push('unknown-source');
  if (reasons.length) return { level: 'low', promotable: false, reasons };
  if (domains.length > 6 || fileClusters.length > 10) {
    return { level: 'medium', promotable: true, reasons: ['broad-but-specific'] };
  }
  return { level: 'high', promotable: true, reasons: [] };
}

function normalizeFailureText(value) {
  return String(value || '')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<timestamp>')
    .replace(/\b[A-Za-z]:\\(?:[^\\\s:]+\\)*[^\\\s:]+/g, '<path>')
    .replace(/\/(?:Users|home|tmp)\/[^\s:]+/g, '<path>')
    .replace(/:\d+(?::\d+)?\b/g, ':<line>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|milliseconds?|seconds?|secs?|s)\b/gi, '<duration>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function fileCluster(file) {
  const parts = normalizePath(file).split('/').filter(Boolean);
  if (!parts.length) return null;
  if (parts[0] === 'Project Codes') {
    const appIndex = parts.indexOf('app');
    const layer = appIndex >= 0 ? parts[appIndex + 1] : null;
    const area = appIndex >= 0 ? parts[appIndex + 2] : null;
    return ['project-codes', layer, area].filter(Boolean).join('/').toLowerCase();
  }
  if (parts[0] === 'harness' || parts[0] === '.harness' || parts[0] === '.codex') {
    return ['harness-control', parts[1]].filter(Boolean).join('/').toLowerCase();
  }
  return parts.slice(0, Math.min(3, parts.length - 1 || 1)).join('/').toLowerCase();
}

function inferDomains(impactReport) {
  return unique([
    ...(impactReport.requiredSynchronizations || []).map((item) => item.domain),
    ...(impactReport.riskSignals || []).map((item) => item.signal || item)
  ]);
}

function readFailureEntries(file) {
  if (!fs.existsSync(file)) return [];
  const entries = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)) {
    try { entries.push(JSON.parse(line)); } catch { /* Keep malformed history inspectable. */ }
  }
  return entries;
}

function groupedRepeatedEntries(entries) {
  const grouped = new Map();
  for (const entry of entries) {
    if (!grouped.has(entry.signature)) grouped.set(entry.signature, []);
    grouped.get(entry.signature).push(entry);
  }
  return [...grouped.entries()].filter(([, items]) => items.length >= 2);
}

function regenerateRuleCandidates({ knowledgeDir, entries, reviews }) {
  ensureDir(knowledgeDir);
  const repeated = groupedRepeatedEntries(entries);
  const candidatePath = path.join(knowledgeDir, 'rule-candidates.yaml');
  writeText(candidatePath, renderRules(repeated, { stable: false, reviews }));
  return candidatePath;
}

function regenerateStableRules({ root, entries, reviews }) {
  const repeated = groupedRepeatedEntries(entries);
  const stable = repeated.filter(([signature]) => reviews.some((review) => review.signature === signature && review.status === 'approved'));
  const rulesPath = path.join(root, '.harness', 'rules.yaml');
  writeText(rulesPath, renderRules(stable, { stable: true, reviews }));
  return rulesPath;
}

export function renderRules(groups, { stable, reviews }) {
  const lines = [stable ? '# Generated stable Harness rules' : '# Generated Harness rule candidates', ''];
  for (const [signature, entries] of groups.sort(([a], [b]) => a.localeCompare(b))) {
    const latest = entries.at(-1);
    const domains = [...new Set(entries.flatMap((entry) => entry.synchronizationDomains || []))].sort();
    const candidateId = `candidate-${shortSignature(signature)}`;
    const review = reviews.find((item) => item.candidateId === candidateId && item.signature === signature) || null;
    lines.push(`- id: "${stable ? 'reviewed-failure' : 'candidate'}-${shortSignature(signature)}"`);
    lines.push(`  signature: "${signature}"`);
    lines.push(`  count: ${entries.length}`);
    lines.push(`  evidenceQuality: "${candidateEvidenceQuality({ entries }).level}"`);
    lines.push(`  source: "${latest.source || 'unknown'}"`);
    lines.push(`  domains: [${domains.map((domain) => JSON.stringify(domain)).join(', ')}]`);
    lines.push(`  action: ${JSON.stringify(ruleAdvice(domains, latest))}`);
    lines.push(`  status: "${stable ? 'stable-reviewed' : review?.status === 'rejected' ? 'candidate-rejected' : review?.status === 'approved' ? 'candidate-approved' : 'candidate-review'}"`);
    if (review) {
      lines.push(`  reviewedBy: ${JSON.stringify(review.reviewer)}`);
      lines.push(`  reviewReason: ${JSON.stringify(review.reason)}`);
      lines.push(`  reviewedAt: ${JSON.stringify(review.reviewedAt)}`);
    }
    lines.push('');
  }
  if (!groups.length) lines.push(stable ? '# No reviewed failure rules yet.' : '# No repeated failure signatures yet.', '');
  while (lines.at(-1) === '') lines.pop();
  return `${lines.join('\n')}\n`;
}

function knowledgeState(root) {
  const trackedKnowledgeDir = path.join(root, TRACKED_KNOWLEDGE_DIR);
  const runtimeKnowledgeDir = path.join(root, RUNTIME_KNOWLEDGE_DIR);
  const entries = combinedFailureEntries(root);
  const grouped = new Map();
  for (const entry of entries) {
    if (!grouped.has(entry.signature)) grouped.set(entry.signature, []);
    grouped.get(entry.signature).push(entry);
  }
  const candidates = [...grouped.entries()]
    .filter(([, items]) => items.length >= 2)
    .map(([signature, candidateEntries]) => ({
      id: `candidate-${shortSignature(signature)}`,
      signature,
      entries: candidateEntries
    }));
  const reviewPath = path.join(trackedKnowledgeDir, 'rule-reviews.json');
  return {
    trackedKnowledgeDir,
    runtimeKnowledgeDir,
    entries,
    candidates,
    reviewPath,
    reviews: readRuleReviews(reviewPath)
  };
}

function combinedFailureEntries(root) {
  const tracked = readFailureEntries(path.join(root, TRACKED_KNOWLEDGE_DIR, 'failures.jsonl'));
  const runtime = readFailureEntries(path.join(root, RUNTIME_KNOWLEDGE_DIR, 'failures.jsonl'));
  const byEventId = new Map();
  for (const entry of [...tracked, ...runtime]) {
    if (entry?.eventId && !byEventId.has(entry.eventId)) byEventId.set(entry.eventId, entry);
  }
  return [...byEventId.values()];
}

function candidateEvidenceQuality(candidate) {
  const qualities = candidate.entries.map((entry) => entry.evidenceQuality || assessEvidenceQuality({
    source: entry.source,
    checks: (entry.failedChecks || []).map((item) => `${item.id || 'unknown'}:${item.commandId || 'none'}:${item.exitCode ?? 'none'}`),
    findingIds: entry.findingIds || [],
    domains: entry.domains || [],
    fileClusters: entry.fileClusters || [],
    errorSummaries: entry.errorSummaries || []
  }));
  const low = qualities.filter((quality) => quality.level === 'low');
  if (low.length) {
    return {
      level: 'low',
      promotable: false,
      reasons: unique(low.flatMap((quality) => quality.reasons)).sort()
    };
  }
  if (qualities.some((quality) => quality.level === 'medium')) {
    return { level: 'medium', promotable: true, reasons: ['broad-but-specific'] };
  }
  return { level: 'high', promotable: true, reasons: [] };
}

function readRuleReviews(file) {
  const data = readJson(file, null);
  return Array.isArray(data?.reviews) ? data.reviews : [];
}

function writeRuleReviews(file, reviews) {
  writeJson(file, { schemaVersion: 1, updatedAt: new Date().toISOString(), reviews });
}

function upsertReview(reviews, review) {
  const index = reviews.findIndex((item) => item.candidateId === review.candidateId);
  if (index >= 0) reviews[index] = review;
  else reviews.push(review);
}

function requireReviewField(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`);
}

function ruleAdvice(domains, entry) {
  if (domains.includes('harness-control')) return 'Inspect the prior Harness dossier, reproduce with a focused Harness test, and keep hook, Guard, validation, and report behavior synchronized.';
  if (domains.includes('public-api')) return 'Recheck backend route/schema, frontend client consumers, and contract validation together before retrying.';
  if (domains.includes('framework')) return 'Recheck FrameworkPackage contracts, current-chapter build context, audit reasons, and their contract/integration tests together.';
  if (domains.includes('continuity')) return 'Recheck memory, continuity, narrative-debt, and confirmation boundaries with a targeted regression test before retrying.';
  const evidence = [...(entry.failedChecks || []).map((item) => item.id), ...(entry.findingIds || [])].filter(Boolean).join(', ');
  return `Inspect the prior failure evidence${evidence ? ` (${evidence})` : ''}, fix the root cause, and add or update the smallest regression check that exposes it.`;
}

function hashSignature(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value)).digest('hex')}`;
}

function shortSignature(signature) {
  return signature.replace(/^sha256:/, '').slice(0, 12);
}
