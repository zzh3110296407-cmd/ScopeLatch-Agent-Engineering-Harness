import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isTextLike, matchesAny, normalizePath, readJson, runFile, unique, writeJson } from './common.mjs';
import { manifestPathForRun, updateRunManifest } from './manifest.mjs';
import { allowedScopeFiles, allowedScopePatterns } from './scope.mjs';
import { containsLocalAbsolutePath, scanContentForSensitiveMaterial } from './security-scanner.mjs';

const guardIgnoredPatterns = [
  '.harness/runs/**',
  '.harness/state/**',
  '.harness/cache/**',
  '.harness/security/**',
  '**/.harness/runs/**',
  '**/.harness/state/**',
  '**/.harness/cache/**',
  '**/.harness/security/**',
  '**/node_modules/**',
  '**/.git/**',
  '**/__pycache__/**',
  '**/.venv/**',
  '**/venv/**'
];

const lockfilePatterns = [
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  '**/bun.lock',
  '**/bun.lockb'
];

const runtimeDataPatterns = [
  '**/app/data/**',
  '**/runtime-data/**',
  '**/.runtime/**'
];

const generatedPatterns = [
  '**/*.generated.*',
  '**/generated/**',
  '**/*_report.json',
  '**/evidence_index.json',
  '**/regression_manifest.json'
];

const publicApiBackendPatterns = [
  '**/backend/api/**',
  '**/api/**',
  '**/*openapi*',
  '**/*.graphql',
  '**/*.proto'
];

const publicApiClientPatterns = [
  '**/frontend/src/api/**',
  '**/client/**',
  '**/generated/**',
  '**/*openapi*'
];

export function runDiffGuard({
  root,
  runDir,
  config,
  options = {},
  resultFileName = 'guard-result.json',
  artifactKey = 'guardResult',
  passedStatus = 'guarded',
  passedPhase = 'guard-complete'
}) {
  const impactReportPath = path.join(runDir, 'impact-report.json');
  const impactReport = readJson(impactReportPath, null);
  if (!impactReport) throw new Error(`Cannot read impact report: ${impactReportPath}`);

  const changes = readChangesSinceRunBaseline({ root, runDir, config });
  const result = evaluateDiffGuard({ root, config, impactReport, changes, options });
  const resultPath = path.join(runDir, resultFileName);
  writeJson(resultPath, result);

  const manifest = updateRunManifest({
    runDir,
    patch: {
      status: result.status === 'failed' ? 'failed' : passedStatus,
      phase: result.status === 'failed' ? 'guard-failed' : passedPhase,
      artifacts: {
        [artifactKey]: resultPath
      },
      guard: {
        status: result.status,
        blockerCount: result.summary.blockerCount,
        warningCount: result.summary.warningCount,
        checkedAt: result.generatedAt
      }
    }
  });

  return { result, resultPath, manifestPath: manifest ? manifestPathForRun(runDir) : null, manifest };
}

export function evaluateDiffGuard({ root = null, config = {}, impactReport = {}, changes = [], options = {} }) {
  const guardedChanges = normalizeChanges(changes)
    .filter((change) => !matchesAny(change.path, guardIgnoredPatterns));
  const changedFiles = unique(guardedChanges.map((change) => change.path));
  const findings = [];
  const budget = config.changeBudget || {};

  addCleanWorkspaceFindings({ findings, changedFiles, options });
  addForbiddenDirFindings({ findings, guardedChanges, budget, options });
  addRuntimeDataFindings({ findings, guardedChanges });
  addDeletedTestFindings({ findings, guardedChanges, options });
  addLockfileFindings({ findings, guardedChanges, options });
  addCiWorkflowFindings({ findings, guardedChanges, impactReport, options });
  addGeneratedArtifactFindings({ findings, guardedChanges });
  addOutOfScopeFindings({ findings, guardedChanges, impactReport, options });
  addPublicApiDriftFindings({ findings, guardedChanges, impactReport, options });
  addSensitiveContentFindings({ root, findings, guardedChanges, config, options });
  addReleaseLicenseFinding({ root, findings, config, options });

  const blockerCount = findings.filter((finding) => finding.severity === 'blocker').length;
  const warningCount = findings.filter((finding) => finding.severity === 'warning').length;
  const status = blockerCount > 0 ? 'failed' : (warningCount > 0 ? 'passed-with-warnings' : 'passed');

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status,
    summary: {
      changedFileCount: changedFiles.length,
      blockerCount,
      warningCount
    },
    policy: {
      allowLockfile: Boolean(options.allowLockfile),
      allowTestDeletion: Boolean(options.allowTestDeletion),
      allowOutOfScope: Boolean(options.allowOutOfScope),
      allowCiWorkflow: Boolean(options.allowCiWorkflow),
      allowApiFrontendDrift: Boolean(options.allowApiFrontendDrift),
      allowLocalPaths: Boolean(options.allowLocalPaths),
      releaseCheck: Boolean(options.releaseCheck),
      requireClean: Boolean(options.requireClean)
    },
    findings,
    changes: guardedChanges
  };
}

export function readWorkingTreeChanges(root) {
  const res = runFile('git', ['status', '--porcelain=v1', '-uall'], { cwd: root, timeoutMs: 10000 });
  if (res.exitCode !== 0) return [];
  return res.stdout.split(/\r?\n/).filter(Boolean).map(parsePorcelainLine).filter(Boolean);
}

export function readGuardedWorkingTreeSnapshot(root, options = {}) {
  const cacheEnabled = options.cacheEnabled !== false
    && options.cacheConfig?.guardHashCache !== false
    && process.env.HARNESS_DISABLE_GUARD_HASH_CACHE !== '1';
  const cachePath = path.join(root, '.harness', 'cache', 'guard-file-hashes.json');
  const cache = cacheEnabled ? readJson(cachePath, { schemaVersion: 1, entries: {} }) : { schemaVersion: 1, entries: {} };
  const metrics = { enabled: cacheEnabled, hits: 0, misses: 0 };
  const snapshot = normalizeChanges(readWorkingTreeChanges(root))
    .filter((change) => !matchesAny(change.path, guardIgnoredPatterns))
    .map((change) => ({
      path: change.path,
      oldPath: change.oldPath,
      kind: change.kind,
      status: change.status,
      indexStatus: change.indexStatus,
      worktreeStatus: change.worktreeStatus,
      hash: hashWorkingTreeFile(root, change.path, cache.entries, metrics)
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (cacheEnabled && metrics.misses > 0) {
    const currentPaths = new Set(snapshot.map((entry) => entry.path));
    const maxEntries = options.cacheConfig?.guardHashCacheMaxEntries || 5000;
    const entries = Object.fromEntries(Object.entries(cache.entries)
      .filter(([file]) => currentPaths.has(file))
      .slice(-maxEntries));
    writeJson(cachePath, { schemaVersion: 1, updatedAt: new Date().toISOString(), entries });
  }
  if (options.metrics && typeof options.metrics === 'object') Object.assign(options.metrics, metrics);
  return snapshot;
}

export function checkRunDiff({ root, runDir, config, options = {} }) {
  const impactReportPath = path.join(runDir, 'impact-report.json');
  const impactReport = readJson(impactReportPath, null);
  if (!impactReport) throw new Error(`Cannot read impact report: ${impactReportPath}`);
  const changes = readChangesSinceRunBaseline({ root, runDir, config });
  return evaluateDiffGuard({ root, config, impactReport, changes, options });
}

export function readChangesSinceRunBaseline({ root, runDir, config = {} }) {
  const current = readGuardedWorkingTreeSnapshot(root, { cacheConfig: config.performance || {} });
  const manifest = readJson(path.join(runDir, 'run-manifest.json'), null);
  const rel = manifest?.artifacts?.baselineSnapshot;
  const baselinePath = rel ? path.join(root, rel) : path.join(runDir, 'working-tree-baseline.json');
  const baseline = readJson(baselinePath, null);
  if (!Array.isArray(baseline)) return readWorkingTreeChanges(root);
  const expectedHash = manifest?.binding?.baselineHash;
  const actualHash = `sha256:${crypto.createHash('sha256').update(JSON.stringify(baseline)).digest('hex')}`;
  if (expectedHash && expectedHash !== actualHash) {
    throw new Error(`Harness baseline snapshot hash mismatch: ${baselinePath}`);
  }
  return changesSinceSnapshot(baseline, current);
}

export function changesSinceSnapshot(before = [], after = []) {
  const beforeByPath = new Map(before.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.map((entry) => [entry.path, entry]));
  const changed = [];
  for (const entry of after) {
    const prior = beforeByPath.get(entry.path);
    if (!prior || JSON.stringify(prior) !== JSON.stringify(entry)) changed.push(entry);
  }
  for (const entry of before) {
    if (afterByPath.has(entry.path)) continue;
    changed.push({
      path: entry.path,
      oldPath: entry.oldPath || null,
      kind: 'modified',
      status: 'baseline-change-removed',
      indexStatus: null,
      worktreeStatus: null
    });
  }
  return changed.sort((a, b) => a.path.localeCompare(b.path));
}

export function diffWorkingTreeSnapshots(before = [], after = []) {
  const beforeByPath = new Map(before.map((entry) => [entry.path, JSON.stringify(entry)]));
  const afterByPath = new Map(after.map((entry) => [entry.path, JSON.stringify(entry)]));
  return unique([
    ...before.filter((entry) => afterByPath.get(entry.path) !== JSON.stringify(entry)).map((entry) => entry.path),
    ...after.filter((entry) => beforeByPath.get(entry.path) !== JSON.stringify(entry)).map((entry) => entry.path)
  ]).sort();
}

function normalizeChanges(changes) {
  return changes.map((change) => ({
    path: cleanGitPath(change.path || change.file || ''),
    oldPath: change.oldPath ? cleanGitPath(change.oldPath) : null,
    kind: change.kind || inferKindFromStatus(change.status || change.indexStatus || change.worktreeStatus || ''),
    status: change.status || null,
    indexStatus: change.indexStatus || null,
    worktreeStatus: change.worktreeStatus || null
  })).filter((change) => change.path);
}

function parsePorcelainLine(line) {
  const indexStatus = line[0];
  const worktreeStatus = line[1];
  const status = `${indexStatus}${worktreeStatus}`;
  const body = line.slice(3);
  if (!body) return null;

  if (status.includes('R') && body.includes(' -> ')) {
    const [oldPath, newPath] = body.split(' -> ');
    return { path: cleanGitPath(newPath), oldPath: cleanGitPath(oldPath), kind: 'renamed', status, indexStatus, worktreeStatus };
  }

  return {
    path: cleanGitPath(body),
    oldPath: null,
    kind: inferKindFromStatus(status),
    status,
    indexStatus,
    worktreeStatus
  };
}

function cleanGitPath(file) {
  return normalizePath(unquoteGitPath(file));
}

function unquoteGitPath(file) {
  const value = String(file || '');
  if (value.length < 2 || value[0] !== '"' || value[value.length - 1] !== '"') return value;

  return value
    .slice(1, -1)
    .replace(/\\([\\"])/g, '$1')
    .replace(/\\t/g, '\t')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r');
}

function hashWorkingTreeFile(root, relPath, cacheEntries = {}, metrics = null) {
  try {
    const file = path.join(root, relPath);
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    const cached = cacheEntries[relPath];
    const identity = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (cached?.identity === identity && cached.hash) {
      if (metrics) metrics.hits += 1;
      return cached.hash;
    }
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    cacheEntries[relPath] = { identity, hash };
    if (metrics) metrics.misses += 1;
    return hash;
  } catch {
    return null;
  }
}

function inferKindFromStatus(status) {
  if (status === '??') return 'untracked';
  if (String(status).includes('D')) return 'deleted';
  if (String(status).includes('A')) return 'added';
  if (String(status).includes('R')) return 'renamed';
  return 'modified';
}

function addCleanWorkspaceFindings({ findings, changedFiles, options }) {
  if (!options.requireClean || !changedFiles.length) return;
  findings.push({
    id: 'working-tree-not-clean',
    severity: 'blocker',
    message: 'Working tree has guarded changes after validation.',
    files: changedFiles
  });
}

function addForbiddenDirFindings({ findings, guardedChanges, budget, options }) {
  if (options.allowForbiddenDirs) return;
  const patterns = budget.forbiddenDirs || [];
  const files = changedFilesMatching(guardedChanges, patterns);
  if (files.length) {
    findings.push({
      id: 'forbidden-dir-touched',
      severity: 'blocker',
      message: 'Changed files touch forbidden directories.',
      files
    });
  }
}

function addRuntimeDataFindings({ findings, guardedChanges }) {
  const files = changedFilesMatching(guardedChanges, runtimeDataPatterns);
  if (files.length) {
    findings.push({
      id: 'runtime-data-change',
      severity: 'blocker',
      message: 'Runtime data changes are blocker-level and must not be committed through Harness.',
      files
    });
  }
}

function addDeletedTestFindings({ findings, guardedChanges, options }) {
  if (options.allowTestDeletion) return;
  const files = guardedChanges
    .filter((change) => change.kind === 'deleted' && isTestFile(change.path))
    .map((change) => change.path);
  if (files.length) {
    findings.push({
      id: 'deleted-test',
      severity: 'blocker',
      message: 'Deleted tests require explicit approval.',
      files
    });
  }
}

function addLockfileFindings({ findings, guardedChanges, options }) {
  if (options.allowLockfile) return;
  const files = changedFilesMatching(guardedChanges, lockfilePatterns);
  if (files.length) {
    findings.push({
      id: 'lockfile-change',
      severity: 'blocker',
      message: 'Lockfile changes require explicit approval.',
      files
    });
  }
}

function addCiWorkflowFindings({ findings, guardedChanges, impactReport, options }) {
  if (options.allowCiWorkflow) return;
  const files = changedFilesMatching(guardedChanges, ['.github/workflows/**', '**/.github/workflows/**']);
  if (!files.length) return;
  if (hasSignal(impactReport, 'build-system-change') || hasSyncDomain(impactReport, 'harness-control')) return;
  findings.push({
    id: 'ci-workflow-change',
    severity: 'blocker',
    message: 'CI workflow changes require a build-system or Harness-control task.',
    files
  });
}

function addGeneratedArtifactFindings({ findings, guardedChanges }) {
  const files = changedFilesMatching(guardedChanges, generatedPatterns);
  if (files.length) {
    findings.push({
      id: 'generated-artifact-change',
      severity: 'warning',
      message: 'Generated artifacts changed; verify source/generated drift intentionally.',
      files
    });
  }
}

function addOutOfScopeFindings({ findings, guardedChanges, impactReport, options }) {
  if (options.allowOutOfScope) return;
  const allowedFiles = allowedScopeFiles(impactReport);
  const allowedPatterns = allowedScopePatterns(impactReport);
  const files = guardedChanges
    .map((change) => change.path)
    .filter((file) => !isExplicitlyAllowedSensitiveFile(file, options))
    .filter((file) => !allowedFiles.has(file) && !matchesAny(file, allowedPatterns));
  if (files.length) {
    findings.push({
      id: 'out-of-scope-change',
      severity: 'blocker',
      message: 'Changed files are outside the impact report scope.',
      files: unique(files).slice(0, 80)
    });
  }
}

function isExplicitlyAllowedSensitiveFile(file, options) {
  if (options.allowLockfile && matchesAny(file, lockfilePatterns)) return true;
  if (options.allowCiWorkflow && matchesAny(file, ['.github/workflows/**', '**/.github/workflows/**'])) return true;
  return false;
}

function addPublicApiDriftFindings({ findings, guardedChanges, impactReport, options }) {
  if (options.allowApiFrontendDrift) return;
  if (!hasSignal(impactReport, 'public-api-change') && !hasSyncDomain(impactReport, 'public-api')) return;
  const backendFiles = changedFilesMatching(guardedChanges, publicApiBackendPatterns)
    .filter((file) => !matchesAny(file, publicApiClientPatterns));
  if (!backendFiles.length) return;
  const clientFiles = changedFilesMatching(guardedChanges, publicApiClientPatterns);
  if (clientFiles.length) return;
  findings.push({
    id: 'api-frontend-drift',
    severity: 'blocker',
    message: 'Public API/backend changes have no matching frontend API/client or generated schema change.',
    files: backendFiles
  });
}

function addSensitiveContentFindings({ root, findings, guardedChanges, config, options }) {
  if (!root) return;
  const security = config.security || {};
  const maxBytes = security.maxFileBytesToScan || 500000;
  const secretFiles = [];
  const localPathFiles = [];
  for (const change of guardedChanges) {
    if (change.kind === 'deleted' || !isTextLike(change.path)) continue;
    const file = path.join(root, change.path);
    let content = '';
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > maxBytes) continue;
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (security.scanSecrets !== false && scanContentForSensitiveMaterial(content, security).length) secretFiles.push(change.path);
    if (security.scanLocalAbsolutePaths !== false && containsLocalAbsolutePath(content)) localPathFiles.push(change.path);
  }
  if (secretFiles.length) {
    findings.push({
      id: 'likely-secret-content',
      severity: 'blocker',
      message: 'Changed files contain likely credential material. Values are intentionally not included in this report.',
      files: unique(secretFiles)
    });
  }
  if (localPathFiles.length && !options.allowLocalPaths) {
    findings.push({
      id: 'local-absolute-path',
      severity: options.releaseCheck ? 'blocker' : 'warning',
      message: 'Changed files contain machine-specific absolute paths; replace them with repository-relative paths or documented placeholders.',
      files: unique(localPathFiles)
    });
  }
}

function addReleaseLicenseFinding({ root, findings, config, options }) {
  if (!root || !options.releaseCheck || config.security?.requireLicenseForRelease === false) return;
  const names = config.security?.licenseFileNames || ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING'];
  if (names.some((name) => fs.existsSync(path.join(root, name)))) return;
  findings.push({
    id: 'release-license-missing',
    severity: 'blocker',
    message: 'Release check requires a repository license file.',
    files: names
  });
}

function hasSignal(impactReport = {}, signal) {
  return (impactReport.riskSignals || []).some((item) => item.signal === signal);
}

function hasSyncDomain(impactReport = {}, domain) {
  return (impactReport.requiredSynchronizations || []).some((sync) => sync.domain === domain);
}

function changedFilesMatching(changes, patterns) {
  return unique(changes.map((change) => change.path).filter((file) => matchesAny(file, patterns)));
}

function isTestFile(file) {
  return /(\.test\.|\.spec\.|__tests__|\/tests?\/|\/e2e\/|verify_)/i.test(file);
}
