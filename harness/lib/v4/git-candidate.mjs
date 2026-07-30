import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { normalizePath, runFile } from '../common.mjs';
import { digestCanonicalJson } from './canonical-json.mjs';

const OID_PATTERN = /^[a-f0-9]{40,64}$/;

export class GitObservationError extends Error {
  constructor(code, operation, exitCode = null) {
    super(`HARNESS_V4_${code}:${operation}`);
    this.name = 'GitObservationError';
    this.code = code;
    this.operation = operation;
    this.exitCode = exitCode;
  }
}

export function captureGitCandidateSnapshot(root) {
  assertRepository(root);
  const headCommitOid = readOid(root, ['rev-parse', '--verify', 'HEAD'], 'head-commit');
  const headTreeOid = readOid(root, ['rev-parse', '--verify', 'HEAD^{tree}'], 'head-tree');
  const branch = readBranch(root);
  const indexEntries = readGitIndexEntries(root);
  const indexTreeOid = computeIndexTreeOid(indexEntries, headCommitOid.length);
  const statusEntries = readGitStatusChanges(root);
  const record = {
    schemaVersion: 1,
    contractVersion: 'harness-git-candidate-v4.0.0',
    headCommitOid,
    headTreeOid,
    branchMode: branch.mode,
    branchName: branch.name,
    indexTreeOid,
    indexDigest: digestCanonicalJson(indexEntries),
    stagedPatchDigest: digestText(readGit(root, [
      'diff',
      '--cached',
      '--binary',
      '--full-index',
      '--no-ext-diff',
      '--no-color'
    ], 'staged-patch')),
    statusDigest: digestCanonicalJson(statusEntries),
    worktreeDigest: digestCanonicalJson(buildWorktreeState(root, statusEntries))
  };
  return {
    ...record,
    snapshotDigest: digestCanonicalJson(record)
  };
}

export function computeIndexTreeOid(indexEntries, objectIdLengthHint = null) {
  if (!Array.isArray(indexEntries)) throw new GitObservationError('GIT_INDEX_TREE_INVALID', 'index-tree');
  const root = treeNode();
  let objectIdLength = null;
  for (const entry of indexEntries) {
    if (!entry || entry.stage !== 0) throw new GitObservationError('GIT_INDEX_UNMERGED', 'index-tree');
    const mode = normalizeTreeMode(entry.mode);
    if (!mode || !OID_PATTERN.test(entry.objectId || '')) {
      throw new GitObservationError('GIT_INDEX_TREE_INVALID', 'index-tree');
    }
    objectIdLength ??= entry.objectId.length;
    if (entry.objectId.length !== objectIdLength) {
      throw new GitObservationError('GIT_INDEX_OBJECT_FORMAT_MIXED', 'index-tree');
    }
    const normalized = normalizePath(entry.path || '');
    const segments = normalized.split('/');
    if (
      !normalized
      || normalized.startsWith('/')
      || /^[A-Za-z]:/.test(normalized)
      || segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('\0'))
    ) {
      throw new GitObservationError('GIT_INDEX_PATH_INVALID', 'index-tree');
    }
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      if (node.entries.has(segment)) throw new GitObservationError('GIT_INDEX_PATH_CONFLICT', 'index-tree');
      if (!node.children.has(segment)) node.children.set(segment, treeNode());
      node = node.children.get(segment);
    }
    const name = segments.at(-1);
    if (node.entries.has(name) || node.children.has(name)) {
      throw new GitObservationError('GIT_INDEX_PATH_CONFLICT', 'index-tree');
    }
    node.entries.set(name, { mode, objectId: entry.objectId });
  }
  objectIdLength ??= objectIdLengthHint;
  const algorithm = objectIdLength === 64 ? 'sha256' : objectIdLength === 40 || objectIdLength === null ? 'sha1' : null;
  if (!algorithm) throw new GitObservationError('GIT_INDEX_OBJECT_FORMAT_INVALID', 'index-tree');
  return hashTreeNode(root, algorithm);
}

export function verifyGitCandidateBaseline({ root, baseline }) {
  const violations = [];
  if (!baseline || typeof baseline !== 'object') {
    return {
      valid: false,
      mode: 'exact-git-baseline',
      violations: [violation('GIT_CANDIDATE_BINDING_MISSING', 'gitCandidate.baseline')],
      currentSnapshot: null
    };
  }

  const expectedDigest = baseline.snapshotDigest;
  const unsigned = { ...baseline };
  delete unsigned.snapshotDigest;
  if (!expectedDigest || expectedDigest !== digestCanonicalJson(unsigned)) {
    violations.push(violation('GIT_CANDIDATE_DIGEST_MISMATCH', 'gitCandidate.baseline.snapshotDigest'));
  }

  let currentSnapshot = null;
  try {
    currentSnapshot = captureGitCandidateSnapshot(root);
  } catch (error) {
    if (error instanceof GitObservationError) {
      violations.push(violation(error.code, `git.${error.operation}`));
    } else {
      violations.push(violation('GIT_OBSERVATION_FAILED', 'git'));
    }
    return { valid: false, mode: 'exact-git-baseline', violations, currentSnapshot };
  }

  compareIdentity(violations, baseline, currentSnapshot, 'headCommitOid', 'GIT_HEAD_COMMIT_DRIFT');
  compareIdentity(violations, baseline, currentSnapshot, 'headTreeOid', 'GIT_HEAD_TREE_DRIFT');
  compareIdentity(violations, baseline, currentSnapshot, 'branchMode', 'GIT_BRANCH_MODE_DRIFT');
  compareIdentity(violations, baseline, currentSnapshot, 'branchName', 'GIT_BRANCH_DRIFT');

  return {
    valid: violations.length === 0,
    mode: 'exact-git-baseline',
    violations,
    currentSnapshot
  };
}

export function readGitStatusChanges(root) {
  assertRepository(root);
  const stdout = readGit(root, ['status', '--porcelain=v1', '-z', '-uall', '--ignored=no'], 'status');
  return parsePorcelainV1Z(stdout);
}

export function readGitIndexEntries(root) {
  assertRepository(root);
  const stdout = readGit(root, ['ls-files', '--stage', '-z', '--full-name'], 'index');
  const entries = [];
  for (const token of stdout.split('\0')) {
    if (!token) continue;
    const match = /^([0-7]{6}) ([a-f0-9]{40,64}) ([0-3])\t([\s\S]+)$/.exec(token);
    if (!match) throw new GitObservationError('GIT_INDEX_PARSE_FAILED', 'index');
    entries.push({
      path: normalizePath(match[4]),
      mode: match[1],
      objectId: match[2],
      stage: Number(match[3])
    });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path) || a.stage - b.stage);
}

export function parsePorcelainV1Z(stdout) {
  const tokens = String(stdout || '').split('\0');
  const changes = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token.length < 4 || token[2] !== ' ') {
      throw new GitObservationError('GIT_STATUS_PARSE_FAILED', 'status');
    }
    const indexStatus = token[0];
    const worktreeStatus = token[1];
    const status = `${indexStatus}${worktreeStatus}`;
    const targetPath = normalizePath(token.slice(3));
    let oldPath = null;
    if (status.includes('R') || status.includes('C')) {
      index += 1;
      if (index >= tokens.length || !tokens[index]) {
        throw new GitObservationError('GIT_STATUS_PARSE_FAILED', 'status');
      }
      oldPath = normalizePath(tokens[index]);
    }
    changes.push({
      path: targetPath,
      oldPath,
      kind: inferKindFromStatus(status),
      status,
      indexStatus,
      worktreeStatus
    });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

function assertRepository(root) {
  const result = runGit(root, ['rev-parse', '--is-inside-work-tree']);
  if (result.exitCode !== 0 || result.stdout.trim() !== 'true') {
    throw new GitObservationError('GIT_REPOSITORY_UNAVAILABLE', 'repository', result.exitCode);
  }
}

function readBranch(root) {
  const result = runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (result.exitCode === 0 && result.stdout.trim()) {
    return { mode: 'branch', name: result.stdout.trim() };
  }
  const head = readOid(root, ['rev-parse', '--verify', 'HEAD'], 'detached-head');
  if (head) return { mode: 'detached', name: null };
  throw new GitObservationError('GIT_BRANCH_OBSERVATION_FAILED', 'branch', result.exitCode);
}

function readOid(root, args, operation) {
  const value = readGit(root, args, operation).trim();
  if (!OID_PATTERN.test(value)) throw new GitObservationError('GIT_OBJECT_ID_INVALID', operation);
  return value;
}

function readGit(root, args, operation) {
  const result = runGit(root, args);
  if (result.exitCode !== 0) {
    throw new GitObservationError('GIT_OBSERVATION_FAILED', operation, result.exitCode);
  }
  return result.stdout;
}

function runGit(root, args) {
  return runFile('git', ['--no-optional-locks', '-c', 'core.quotepath=false', ...args], {
    cwd: root,
    timeoutMs: 15000,
    maxBuffer: 50 * 1024 * 1024
  });
}

function treeNode() {
  return { children: new Map(), entries: new Map() };
}

function normalizeTreeMode(value) {
  const mode = String(value || '');
  if (!['040000', '100644', '100755', '120000', '160000'].includes(mode)) return null;
  return mode === '040000' ? '40000' : mode;
}

function hashTreeNode(node, algorithm) {
  const entries = [];
  for (const [name, value] of node.entries) entries.push({ name, ...value });
  for (const [name, child] of node.children) {
    entries.push({ name, mode: '40000', objectId: hashTreeNode(child, algorithm) });
  }
  entries.sort((left, right) => Buffer.compare(
    Buffer.from(`${left.name}${left.mode === '40000' ? '/' : ''}`, 'utf8'),
    Buffer.from(`${right.name}${right.mode === '40000' ? '/' : ''}`, 'utf8')
  ));
  const body = Buffer.concat(entries.flatMap((entry) => [
    Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'),
    Buffer.from(entry.objectId, 'hex')
  ]));
  const framed = Buffer.concat([Buffer.from(`tree ${body.length}\0`, 'utf8'), body]);
  return crypto.createHash(algorithm).update(framed).digest('hex');
}

function buildWorktreeState(root, changes) {
  return changes.map((change) => ({
    path: change.path,
    oldPath: change.oldPath,
    status: change.status,
    contentDigest: digestPath(root, change.path)
  }));
}

function digestPath(root, relativePath) {
  const target = path.join(root, relativePath);
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) return digestText(`symlink:${fs.readlinkSync(target)}`);
    if (!stat.isFile()) return digestText(`non-file:${stat.mode}`);
    return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')}`;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new GitObservationError('GIT_WORKTREE_READ_FAILED', 'worktree-path');
  }
}

function compareIdentity(violations, expected, actual, field, code) {
  if (expected[field] !== actual[field]) violations.push(violation(code, `gitCandidate.baseline.${field}`));
}

function digestText(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
}

function inferKindFromStatus(status) {
  if (status === '??') return 'untracked';
  if (String(status).includes('D')) return 'deleted';
  if (String(status).includes('A')) return 'added';
  if (String(status).includes('R')) return 'renamed';
  if (String(status).includes('C')) return 'copied';
  return 'modified';
}

function violation(code, safePath) {
  return { code, safePath };
}
