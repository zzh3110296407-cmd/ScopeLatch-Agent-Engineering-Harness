import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { normalizePath, readJson, writeJson } from './common.mjs';
import { allowedScopeFiles, allowedScopePatterns } from './scope.mjs';
import { buildSealedRunBinding, writeSealedRunBinding } from './v4/evidence-store.mjs';
import { captureGitCandidateSnapshot } from './v4/git-candidate.mjs';
import {
  buildImmutableCandidateWorkspace,
  withAtomicResourceLock
} from './v4/concurrent-state.mjs';

export function manifestPathForRun(runDir) {
  return path.join(runDir, 'run-manifest.json');
}

export function buildRunManifest({
  root,
  config,
  task,
  runId,
  runDir,
  createdAt = new Date().toISOString(),
  impactReport,
  validationPlan,
  artifacts = {},
  baselineSnapshot = [],
  sessionBinding = null
}) {
  const gitCandidateBaseline = withAtomicResourceLock({
    stateDir: path.join(root, config.stateDir || '.harness/state'),
    resourceId: `git-candidate:${path.resolve(root)}`
  }, () => captureGitCandidateSnapshot(root));
  const branch = gitCandidateBaseline.branchName;
  const commit = gitCandidateBaseline.headCommitOid;
  const taskFingerprint = hashText(normalizeTask(task));
  const maxAgeMinutes = config.policy?.planMaxAgeMinutes || 240;
  const sealedBinding = buildSealedRunBinding({
    root,
    runId,
    impactReport,
    validationPlan,
    baselineSnapshot,
    config,
    gitCandidateBaseline
  });
  const executionWorkspace = buildImmutableCandidateWorkspace({
    root,
    runId,
    runDir,
    candidateSnapshot: gitCandidateBaseline
  });
  return {
    schemaVersion: 6,
    runId,
    createdAt,
    updatedAt: createdAt,
    status: 'planned',
    phase: 'implementation-ready',
    task: {
      raw: task,
      intent: impactReport?.intent || null,
      fingerprint: taskFingerprint
    },
    repo: {
      root: normalizePath(root),
      branch,
      commit,
      baseRef: impactReport?.baseRef || null,
      configHash: hashConfig(config),
      indexHash: hashDirectory(path.join(root, '.harness', 'cache', 'index'))
    },
    binding: {
      taskFingerprint,
      branch,
      commit,
      sessionFingerprint: sessionBinding?.fingerprint || null,
      sessionSource: sessionBinding?.source || null,
      sessionBindingRequired: sessionBinding?.required !== false,
      leaseResourceId: sessionBinding?.resourceId || null,
      leaseNonceFingerprint: sessionBinding?.nonceFingerprint || null,
      workspaceDigest: executionWorkspace.workspaceDigest,
      expiresAt: new Date(Date.parse(createdAt) + maxAgeMinutes * 60 * 1000).toISOString(),
      allowedFiles: [...allowedScopeFiles(impactReport)].sort(),
      allowedPathPatterns: allowedScopePatterns(impactReport).sort(),
      baselineHash: hashText(JSON.stringify(baselineSnapshot || []))
    },
    risk: {
      level: impactReport?.risk?.level || null,
      score: impactReport?.risk?.score ?? null,
      signals: (impactReport?.riskSignals || []).map((signal) => signal.signal).filter(Boolean)
    },
    synchronizations: {
      requiredCount: Array.isArray(impactReport?.requiredSynchronizations) ? impactReport.requiredSynchronizations.length : 0,
      domains: (impactReport?.requiredSynchronizations || []).map((sync) => sync.domain).filter(Boolean)
    },
    validation: {
      requiredCheckCount: validationPlan?.requiredCheckCount ?? null,
      commandCount: Array.isArray(validationPlan?.commands) ? validationPlan.commands.length : 0,
      graphMode: validationPlan?.graph?.mode || null,
      graphNodeCount: Array.isArray(validationPlan?.graph?.nodes) ? validationPlan.graph.nodes.length : 0,
      resultOutcome: null
    },
    evidence: {
      schemaVersion: 1,
      required: true,
      bindingRecord: 'run-binding.json',
      sealedBinding
    },
    gitCandidate: {
      schemaVersion: 1,
      contractVersion: 'harness-git-candidate-v4.0.0',
      baseline: gitCandidateBaseline,
      validation: null,
      formalCandidate: null
    },
    executionWorkspace,
    artifacts: normalizeArtifacts(root, artifacts)
  };
}

export function fingerprintTask(task) {
  return hashText(normalizeTask(task));
}

export function writeRunManifest({ runDir, manifest }) {
  if ((manifest?.schemaVersion || 0) >= 6 && !manifest?.gitCandidate?.baseline?.snapshotDigest) {
    throw new Error('HARNESS_V4_GIT_CANDIDATE_BINDING_REQUIRED');
  }
  if ((manifest?.schemaVersion || 0) >= 5) {
    if (!manifest.evidence?.sealedBinding) throw new Error('HARNESS_V4_EVIDENCE_BINDING_REQUIRED');
    writeSealedRunBinding({ runDir, binding: manifest.evidence.sealedBinding });
  }
  const manifestPath = manifestPathForRun(runDir);
  writeJson(manifestPath, manifest);
  return manifestPath;
}

export function readRunManifest(runDirOrPath) {
  const manifestPath = path.basename(runDirOrPath) === 'run-manifest.json'
    ? runDirOrPath
    : manifestPathForRun(runDirOrPath);
  return readJson(manifestPath, null);
}

export function updateRunManifest({ runDir, patch, updatedAt = new Date().toISOString() }) {
  const current = readRunManifest(runDir);
  if (!current) return null;
  const merged = mergeManifest(current, patch);
  merged.updatedAt = updatedAt;
  writeRunManifest({ runDir, manifest: merged });
  return merged;
}

export function normalizeArtifacts(root, artifacts = {}) {
  const out = {};
  for (const [key, value] of Object.entries(artifacts)) {
    if (!value) continue;
    out[key] = path.isAbsolute(value) ? normalizePath(path.relative(root, value)) : normalizePath(value);
  }
  return out;
}

function mergeManifest(current, patch = {}) {
  const next = {
    ...current,
    ...patch
  };
  const root = current.repo?.root ? path.resolve(current.repo.root) : process.cwd();
  if (patch.artifacts) next.artifacts = { ...(current.artifacts || {}), ...normalizeArtifacts(root, patch.artifacts) };
  if (patch.validation) next.validation = { ...(current.validation || {}), ...patch.validation };
  if (patch.risk) next.risk = { ...(current.risk || {}), ...patch.risk };
  if (patch.repo) next.repo = { ...(current.repo || {}), ...patch.repo };
  if (patch.task) next.task = { ...(current.task || {}), ...patch.task };
  if (patch.binding) next.binding = { ...(current.binding || {}), ...patch.binding };
  if (patch.gitCandidate) next.gitCandidate = { ...(current.gitCandidate || {}), ...patch.gitCandidate };
  if (patch.executionWorkspace) next.executionWorkspace = { ...(current.executionWorkspace || {}), ...patch.executionWorkspace };
  return next;
}

function hashConfig(config = {}) {
  if (config.configFile && fs.existsSync(config.configFile)) return hashFile(config.configFile);
  const stableConfig = { ...config };
  delete stableConfig.configFile;
  return hashText(JSON.stringify(sortObject(stableConfig)));
}

function hashDirectory(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = walk(dir).filter((file) => fs.statSync(file).isFile()).sort();
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(normalizePath(path.relative(dir, file)));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

function hashFile(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function hashText(text) {
  return `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;
}

function normalizeTask(task) {
  return String(task || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortObject(item)]));
}
