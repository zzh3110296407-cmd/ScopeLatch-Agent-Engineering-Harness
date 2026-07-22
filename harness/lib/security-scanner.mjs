import fs from 'node:fs';
import path from 'node:path';
import { filterRepoFiles, gitFiles } from './repo.mjs';
import { isTextLike, normalizePath, run, runFile, unique } from './common.mjs';

const placeholderPattern = /^(?:your[-_ ]|replace[-_ ]|placeholder|example|dummy|test|fake|sample|<|\$\{|changeme)/i;
const directSecretPatterns = [
  { ruleId: 'openai-style-key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { ruleId: 'source-control-token', pattern: /\b(?:ghp|github_pat|glpat)-?[A-Za-z0-9_]{20,}\b/g },
  { ruleId: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g }
];

export function scanContentForSensitiveMaterial(content, options = {}) {
  const entropyThreshold = Number(options.entropyThreshold || 4.2);
  const entropyMinLength = Number(options.entropyMinLength || 20);
  const findings = [];
  for (const { ruleId, pattern } of directSecretPatterns) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      if (isPlaceholderSecretValue(ruleId, match[0])) continue;
      findings.push({ ruleId, line: lineNumber(content, match.index) });
    }
  }
  const assignmentPatterns = [
    /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|token|secret|password)\b\s*[:=]\s*["']([^"']{12,})["']/gi,
    /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|token|secret|password)\b\s*[:=]\s*([A-Za-z0-9_./+=:-]{20,})/gi
  ];
  for (const assignment of assignmentPatterns) {
    for (const match of content.matchAll(assignment)) {
      const value = match[1].trim();
      if (placeholderPattern.test(value)) continue;
      if (!looksCredentialLike(value, entropyMinLength)) continue;
      findings.push({ ruleId: 'credential-assignment', line: lineNumber(content, match.index) });
      if (value.length >= entropyMinLength && shannonEntropy(value) >= entropyThreshold) {
        findings.push({ ruleId: 'high-entropy-credential', line: lineNumber(content, match.index) });
      }
    }
  }
  return dedupeSensitiveFindings(findings);
}

function isPlaceholderSecretValue(ruleId, value) {
  if (ruleId === 'private-key') return false;
  const payload = String(value)
    .replace(/^sk-/i, '')
    .replace(/^(?:ghp|github_pat|glpat)-?/i, '');
  return placeholderPattern.test(payload);
}

function looksCredentialLike(value, minLength) {
  if (value.length < minLength || /\s/.test(value)) return false;
  const hasLetters = /[A-Za-z]/.test(value);
  const hasDigits = /\d/.test(value);
  const hasMixedCase = /[a-z]/.test(value) && /[A-Z]/.test(value);
  const hasTokenPunctuation = /[_+=./:-]/.test(value);
  return hasLetters && hasDigits && (hasMixedCase || hasTokenPunctuation || shannonEntropy(value) >= 3.8);
}

export function containsLocalAbsolutePath(content) {
  return /\b[A-Za-z]:\\Users\\[^\\\s"']+\\/i.test(content)
    || /\/(?:Users|home)\/[^/\s"']+\//.test(content);
}

export function scanRepositorySecurity({ root, config, files = null, options = {} }) {
  const security = config.security || {};
  const profile = resolveSecurityProfile(security, options);
  const releaseCheck = profile === 'public-release';
  const candidates = filterRepoFiles(files || securityCandidateFiles(root), config).filter(isTextLike);
  const current = scanCurrentTree({ root, files: candidates, security, profile });
  const findings = [...current.findings];
  if (releaseCheck && security.requireLicenseForRelease !== false) {
    const names = security.licenseFileNames || ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING'];
    if (!names.some((name) => fs.existsSync(path.join(root, name)))) {
      findings.push({ id: 'release-license-missing', severity: 'blocker', files: names, count: names.length });
    }
  }
  const history = options.skipHistory
    ? { status: 'skipped', scannedCommits: 0, findings: [] }
    : scanGitHistory({ root, security });
  findings.push(...history.findings);
  const dependencies = options.skipDependencyAudit
    ? { status: 'skipped', audits: [] }
    : scanDependencies({ root, config, security });
  for (const audit of dependencies.audits || []) {
    if (audit.status === 'failed' && audit.highOrCritical > 0) {
      findings.push({
        id: 'dependency-vulnerability',
        severity: 'blocker',
        files: [audit.manifest],
        count: audit.highOrCritical,
        ecosystem: audit.ecosystem
      });
    }
  }
  const blockerCount = findings.filter((item) => item.severity === 'blocker').length;
  const warningCount = findings.filter((item) => item.severity === 'warning').length;
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    status: blockerCount ? 'failed' : warningCount ? 'passed-with-warnings' : 'passed',
    summary: { scannedFileCount: candidates.length, blockerCount, warningCount },
    findings,
    history: { ...history, findings: undefined },
    dependencies,
    policy: {
      profile,
      releaseCheck,
      historyScan: !options.skipHistory,
      dependencyAudit: !options.skipDependencyAudit,
      credentialValuesStored: false
    }
  };
}

function resolveSecurityProfile(security, options) {
  const profile = options.releaseCheck
    ? 'public-release'
    : String(options.profile || security.profile || 'private-development').trim().toLowerCase();
  if (!['private-development', 'public-release'].includes(profile)) {
    throw new Error(`Unknown security profile: ${profile}.`);
  }
  return profile;
}

function scanCurrentTree({ root, files, security, profile }) {
  const secretFiles = [];
  const fixtureCredentialFiles = [];
  const highEntropyFiles = [];
  const localPathFiles = [];
  const maxBytes = security.maxFileBytesToScan || 500000;
  for (const rel of files) {
    const file = path.join(root, rel);
    let content;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > maxBytes) continue;
      content = fs.readFileSync(file, 'utf8');
    } catch { continue; }
    const sensitive = scanContentForSensitiveMaterial(content, security);
    if (sensitive.length && isTestFixtureFile(rel)) fixtureCredentialFiles.push(rel);
    else if (sensitive.length) secretFiles.push(rel);
    if (!isTestFixtureFile(rel) && sensitive.some((item) => item.ruleId === 'high-entropy-credential')) highEntropyFiles.push(rel);
    if (security.scanLocalAbsolutePaths !== false && containsLocalAbsolutePath(content)) localPathFiles.push(rel);
  }
  const findings = [];
  if (secretFiles.length && security.scanSecrets !== false) {
    findings.push({ id: 'current-tree-secret', severity: 'blocker', files: unique(secretFiles), count: unique(secretFiles).length });
  }
  if (fixtureCredentialFiles.length && security.scanSecrets !== false) {
    findings.push({ id: 'test-fixture-credential', severity: 'warning', files: unique(fixtureCredentialFiles), count: unique(fixtureCredentialFiles).length });
  }
  if (highEntropyFiles.length && security.scanHighEntropy !== false) {
    findings.push({ id: 'current-tree-high-entropy-credential', severity: 'blocker', files: unique(highEntropyFiles), count: unique(highEntropyFiles).length });
  }
  if (localPathFiles.length) {
    findings.push({ id: 'local-absolute-path', severity: profile === 'public-release' ? 'blocker' : 'warning', files: unique(localPathFiles), count: unique(localPathFiles).length });
  }
  return { findings };
}

function isTestFixtureFile(file) {
  const normalized = normalizePath(file);
  const base = path.posix.basename(normalized);
  return /(^|\/)(tests?|fixtures?|e2e)(\/|$)/i.test(normalized)
    || /^(?:test_|verify_)/i.test(base)
    || /\.(?:test|spec)\.[^.]+$/i.test(base);
}

function securityCandidateFiles(root) {
  const untracked = runFile('git', ['ls-files', '--others', '--exclude-standard'], { cwd: root, timeoutMs: 10000 });
  return unique([
    ...gitFiles(root),
    ...(untracked.exitCode === 0 ? untracked.stdout.split(/\r?\n/).filter(Boolean).map(normalizePath) : [])
  ]).sort();
}

function scanGitHistory({ root, security }) {
  const maxCommits = security.historyMaxCommits || 100;
  const revs = runFile('git', ['rev-list', '--all', `--max-count=${maxCommits}`], { cwd: root, timeoutMs: 30000 });
  if (revs.exitCode !== 0) return { status: 'unavailable', reason: 'git-rev-list-failed', scannedCommits: 0, findings: [] };
  const secretCommits = [];
  let scannedCommits = 0;
  for (const commit of revs.stdout.split(/\r?\n/).filter(Boolean)) {
    const shown = runFile('git', ['show', '--format=', '--no-ext-diff', '--unified=0', commit], {
      cwd: root,
      timeoutMs: security.historyCommitTimeoutMs || 15000,
      maxBuffer: security.historyMaxBytesPerCommit || 5 * 1024 * 1024
    });
    if (shown.exitCode !== 0) continue;
    scannedCommits += 1;
    const additions = shown.stdout.split(/\r?\n/).filter((line) => line.startsWith('+') && !line.startsWith('+++')).join('\n');
    if (scanContentForSensitiveMaterial(additions, security).length) secretCommits.push(commit.slice(0, 12));
  }
  const findings = secretCommits.length ? [{
    id: 'git-history-secret',
    severity: 'blocker',
    files: [],
    count: secretCommits.length,
    commits: unique(secretCommits)
  }] : [];
  return { status: 'completed', scannedCommits, findings };
}

function scanDependencies({ root, config, security }) {
  const audits = [];
  const canonical = config.sourceAuthority?.root;
  const roots = canonical ? [path.join(root, canonical)] : [root];
  for (const sourceRoot of roots) {
    for (const lock of findNamedFiles(sourceRoot, 'package-lock.json', 8)) {
      const packageDir = path.dirname(lock);
      const result = run('npm audit --omit=dev --audit-level=high --json', {
        cwd: packageDir,
        timeoutMs: security.dependencyAuditTimeoutMs || 120000,
        maxBuffer: 10 * 1024 * 1024
      });
      audits.push(parseNpmAudit(root, lock, result));
    }
    for (const requirements of findRequirementFiles(sourceRoot, 8)) {
      const available = run('python -m pip_audit --version', { cwd: path.dirname(requirements), timeoutMs: 10000 });
      if (available.exitCode !== 0) {
        audits.push({ ecosystem: 'python', manifest: normalizePath(path.relative(root, requirements)), status: 'unavailable', reason: 'pip-audit-not-installed', highOrCritical: 0 });
        continue;
      }
      const result = run(`python -m pip_audit -r ${JSON.stringify(requirements)} --format json`, {
        cwd: path.dirname(requirements),
        timeoutMs: security.dependencyAuditTimeoutMs || 120000,
        maxBuffer: 10 * 1024 * 1024
      });
      audits.push(parsePipAudit(root, requirements, result));
    }
  }
  const failed = audits.some((audit) => audit.status === 'failed');
  const unavailable = audits.some((audit) => audit.status === 'unavailable');
  return { status: failed ? 'failed' : unavailable ? 'partial' : 'passed', audits };
}

function parseNpmAudit(root, lock, result) {
  let data = null;
  try { data = JSON.parse(result.stdout || '{}'); } catch { /* Report unavailable below. */ }
  if (!data?.metadata?.vulnerabilities) {
    return { ecosystem: 'npm', manifest: normalizePath(path.relative(root, lock)), status: 'unavailable', reason: result.error || 'npm-audit-output-unreadable', highOrCritical: 0 };
  }
  const values = data.metadata.vulnerabilities;
  const highOrCritical = Number(values.high || 0) + Number(values.critical || 0);
  return { ecosystem: 'npm', manifest: normalizePath(path.relative(root, lock)), status: highOrCritical ? 'failed' : 'passed', highOrCritical };
}

function parsePipAudit(root, requirements, result) {
  let data = null;
  try { data = JSON.parse(result.stdout || '[]'); } catch { /* Report unavailable below. */ }
  const vulnerabilityCount = summarizePipAuditJson(data);
  if (vulnerabilityCount === null) {
    return { ecosystem: 'python', manifest: normalizePath(path.relative(root, requirements)), status: 'unavailable', reason: result.error || 'pip-audit-output-unreadable', highOrCritical: 0 };
  }
  return { ecosystem: 'python', manifest: normalizePath(path.relative(root, requirements)), status: vulnerabilityCount ? 'failed' : 'passed', highOrCritical: vulnerabilityCount };
}

export function summarizePipAuditJson(data) {
  const dependencies = Array.isArray(data) ? data : data?.dependencies;
  if (!Array.isArray(dependencies)) return null;
  return dependencies.reduce((sum, item) => sum + (item.vulns || []).length, 0);
}

function findNamedFiles(root, name, maxDepth, depth = 0, out = []) {
  if (!fs.existsSync(root) || depth > maxDepth) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (['node_modules', '.git', '.venv', 'venv', 'dist', 'build'].includes(entry.name)) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) findNamedFiles(full, name, maxDepth, depth + 1, out);
    else if (entry.isFile() && entry.name === name) out.push(full);
  }
  return out;
}

function findRequirementFiles(root, maxDepth) {
  const out = [];
  walk(root, 0);
  return out;
  function walk(dir, depth) {
    if (!fs.existsSync(dir) || depth > maxDepth) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', '.venv', 'venv', 'dist', 'build'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && /^requirements.*\.txt$/i.test(entry.name)) out.push(full);
    }
  }
}

function shannonEntropy(value) {
  const counts = new Map();
  for (const char of value) counts.set(char, (counts.get(char) || 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function lineNumber(content, index) {
  return content.slice(0, index || 0).split(/\r?\n/).length;
}

function dedupeSensitiveFindings(findings) {
  const seen = new Set();
  return findings.filter((finding) => {
    const key = `${finding.ruleId}:${finding.line || 0}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
