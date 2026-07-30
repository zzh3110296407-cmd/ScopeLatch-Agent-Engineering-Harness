import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson, digestCanonicalJson } from './canonical-json.mjs';

const RUN_ID_RANDOM_BYTES = 16;
const DEFAULT_LEASE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_LOCK_TTL_MS = 30 * 1000;
const DEFAULT_LOCK_WAIT_MS = 60 * 1000;
const TERMINAL_LIFECYCLES = new Set(['passed', 'aborted', 'invalidated']);
const RESUMABLE_LIFECYCLES = new Set(['planned', 'running', 'blocked', 'failed', 'error']);

export class HarnessConcurrencyError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'HarnessConcurrencyError';
    this.code = code;
    this.details = details;
  }
}

export function createCollisionResistantRunId({
  taskSlug = 'task',
  now = new Date(),
  randomBytes = crypto.randomBytes
} = {}) {
  const timestamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const entropy = randomBytes(RUN_ID_RANDOM_BYTES).toString('hex');
  const slug = String(taskSlug || 'task')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/giu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'task';
  return `${timestamp}-${entropy}-${slug}`;
}

export function reserveRunDirectory({ root, outputDir, runId }) {
  requireNonEmpty(root, 'root');
  requireNonEmpty(outputDir, 'outputDir');
  assertRunId(runId);
  const outputRoot = path.resolve(root, outputDir);
  const runDir = path.resolve(outputRoot, runId);
  assertDescendant(outputRoot, runDir, 'HARNESS_V4_RUN_DIRECTORY_ESCAPE');
  fs.mkdirSync(outputRoot, { recursive: true });
  try {
    fs.mkdirSync(runDir, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new HarnessConcurrencyError(
        'HARNESS_V4_RUN_DIRECTORY_COLLISION',
        `Run output directory already exists for ${runId}.`
      );
    }
    throw error;
  }
  const evidenceDir = path.join(runDir, 'evidence');
  const outputArtifactDir = path.join(runDir, 'outputs');
  fs.mkdirSync(evidenceDir, { recursive: false, mode: 0o700 });
  fs.mkdirSync(outputArtifactDir, { recursive: false, mode: 0o700 });
  return {
    runId,
    runDir,
    evidenceDir,
    outputArtifactDir
  };
}

export function buildImmutableCandidateWorkspace({
  root,
  runId,
  runDir,
  candidateSnapshot
}) {
  assertRunId(runId);
  if (!candidateSnapshot?.indexTreeOid || !candidateSnapshot?.snapshotDigest) {
    throw new HarnessConcurrencyError(
      'HARNESS_V4_IMMUTABLE_CANDIDATE_REQUIRED',
      'An immutable Git index tree and snapshot digest are required.'
    );
  }
  const descriptor = {
    schemaVersion: 1,
    contractVersion: 'harness-immutable-candidate-workspace-v4.0.0',
    mode: 'immutable-git-tree',
    runId,
    candidateTreeOid: candidateSnapshot.indexTreeOid,
    candidateSnapshotDigest: candidateSnapshot.snapshotDigest,
    repositoryIdentity: digestCanonicalJson({ root: path.resolve(root) }),
    ownershipResourceId: `run:${runId}`,
    runDirectory: path.resolve(runDir),
    evidenceDirectory: path.resolve(runDir, 'evidence'),
    outputDirectory: path.resolve(runDir, 'outputs'),
    readOnlyCandidate: true,
    materializationPolicy: 'git-tree-object-only'
  };
  return {
    ...descriptor,
    workspaceDigest: digestCanonicalJson(descriptor)
  };
}

export function acquireLease({
  stateDir,
  resourceId,
  runId,
  ownerId,
  ttlMs = DEFAULT_LEASE_TTL_MS,
  now = Date.now(),
  metadata = {}
}) {
  requireNonEmpty(stateDir, 'stateDir');
  requireNonEmpty(resourceId, 'resourceId');
  assertRunId(runId);
  requireNonEmpty(ownerId, 'ownerId');
  assertPositiveInteger(ttlMs, 'ttlMs');
  const leasePath = leasePathFor(stateDir, resourceId);
  return withFileLock(leasePath, () => {
    const existing = readJsonStrictOrNull(leasePath);
    if (existing && existing.status === 'active' && Date.parse(existing.expiresAt) > now) {
      throw new HarnessConcurrencyError(
        'HARNESS_V4_LEASE_ALREADY_HELD',
        `Resource ${resourceId} is leased by another owner.`,
        { resourceId, runId: existing.runId, ownerFingerprint: fingerprint(existing.ownerId) }
      );
    }
    const acquiredAt = new Date(now).toISOString();
    const record = sealLease({
      schemaVersion: 2,
      resourceId,
      runId,
      ownerId,
      nonce: crypto.randomBytes(24).toString('base64url'),
      revision: (existing?.revision ?? -1) + 1,
      status: 'active',
      acquiredAt,
      heartbeatAt: acquiredAt,
      expiresAt: new Date(now + ttlMs).toISOString(),
      metadata: cloneJson(metadata),
      takeoverOfLeaseDigest: existing?.leaseDigest || null
    });
    atomicWriteJson(leasePath, record);
    restrictFile(leasePath);
    return { ...record, leasePath };
  });
}

export function readLease({ stateDir, resourceId, includeExpired = false, now = Date.now() }) {
  const record = readJsonStrictOrNull(leasePathFor(stateDir, resourceId));
  if (!record || !verifySealed(record, 'leaseDigest')) return null;
  if (!includeExpired && (record.status !== 'active' || Date.parse(record.expiresAt) <= now)) return null;
  return record;
}

export function heartbeatLease({
  stateDir,
  resourceId,
  ownerId,
  nonce,
  ttlMs = DEFAULT_LEASE_TTL_MS,
  now = Date.now()
}) {
  assertPositiveInteger(ttlMs, 'ttlMs');
  const leasePath = leasePathFor(stateDir, resourceId);
  return withFileLock(leasePath, () => {
    const current = requireActiveLease({ leasePath, resourceId, ownerId, nonce, now });
    const heartbeatAt = new Date(now).toISOString();
    const next = sealLease({
      ...withoutDigest(current, 'leaseDigest'),
      revision: current.revision + 1,
      heartbeatAt,
      expiresAt: new Date(now + ttlMs).toISOString()
    });
    atomicWriteJson(leasePath, next);
    return next;
  });
}

export function releaseLease({
  stateDir,
  resourceId,
  ownerId,
  nonce,
  now = Date.now(),
  reason = 'released'
}) {
  const leasePath = leasePathFor(stateDir, resourceId);
  return withFileLock(leasePath, () => {
    const current = requireOwnedLease({ leasePath, resourceId, ownerId, nonce });
    if (current.status !== 'active') return current;
    const releasedAt = new Date(now).toISOString();
    const next = sealLease({
      ...withoutDigest(current, 'leaseDigest'),
      revision: current.revision + 1,
      status: 'released',
      releasedAt,
      releaseReason: String(reason || 'released').slice(0, 160)
    });
    atomicWriteJson(leasePath, next);
    return next;
  });
}

export function initializeRunState({
  stateDir,
  runId,
  ownerFingerprint,
  nonceFingerprint,
  workspace,
  generatedAt = new Date().toISOString(),
  data = {}
}) {
  assertRunId(runId);
  const statePath = runStatePathFor(stateDir, runId);
  return withFileLock(statePath, () => {
    if (fs.existsSync(statePath)) {
      throw new HarnessConcurrencyError(
        'HARNESS_V4_RUN_STATE_ALREADY_EXISTS',
        `Authoritative state already exists for ${runId}.`
      );
    }
    const record = sealState({
      schemaVersion: 1,
      runId,
      revision: 0,
      lifecycle: 'planned',
      ownerFingerprint,
      nonceFingerprint,
      workspaceDigest: workspace?.workspaceDigest || null,
      createdAt: generatedAt,
      updatedAt: generatedAt,
      recovery: null,
      data: cloneJson(data)
    });
    atomicWriteJson(statePath, record);
    return { ...record, statePath };
  });
}

export function readRunState({ stateDir, runId }) {
  assertRunId(runId);
  const statePath = runStatePathFor(stateDir, runId);
  const record = readJsonStrictOrNull(statePath);
  if (!record) return null;
  if (!verifySealed(record, 'stateDigest')) {
    throw new HarnessConcurrencyError(
      'HARNESS_V4_RUN_STATE_DIGEST_MISMATCH',
      `Authoritative state digest mismatch for ${runId}.`
    );
  }
  return { ...record, statePath };
}

export function compareAndSwapRunState({
  stateDir,
  runId,
  expectedRevision,
  expectedStateDigest,
  mutate,
  updatedAt = new Date().toISOString()
}) {
  if (typeof mutate !== 'function') throw new TypeError('mutate must be a function.');
  const statePath = runStatePathFor(stateDir, runId);
  return withFileLock(statePath, () => {
    const current = readRunState({ stateDir, runId });
    if (!current) {
      throw new HarnessConcurrencyError('HARNESS_V4_RUN_STATE_MISSING', `Missing state for ${runId}.`);
    }
    if (current.revision !== expectedRevision || current.stateDigest !== expectedStateDigest) {
      throw new HarnessConcurrencyError(
        'HARNESS_V4_CAS_CONFLICT',
        `Run state changed before revision ${expectedRevision} could be committed.`,
        { expectedRevision, actualRevision: current.revision }
      );
    }
    return commitRunStateMutation({ current, statePath, mutate, updatedAt });
  });
}

export function mutateRunStateAtomic({
  stateDir,
  runId,
  mutate,
  updatedAt = null
}) {
  if (typeof mutate !== 'function') throw new TypeError('mutate must be a function.');
  const statePath = runStatePathFor(stateDir, runId);
  return withFileLock(statePath, () => {
    const current = readRunState({ stateDir, runId });
    if (!current) {
      throw new HarnessConcurrencyError('HARNESS_V4_RUN_STATE_MISSING', `Missing state for ${runId}.`);
    }
    return commitRunStateMutation({
      current,
      statePath,
      mutate,
      updatedAt: updatedAt || new Date().toISOString()
    });
  });
}

function commitRunStateMutation({ current, statePath, mutate, updatedAt }) {
  const draft = cloneJson(withoutRuntimePath(current));
  const proposed = mutate(draft);
  const value = proposed === undefined ? draft : proposed;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HarnessConcurrencyError('HARNESS_V4_STATE_MUTATION_INVALID', 'Atomic state mutation must return an object.');
  }
  for (const immutable of ['schemaVersion', 'runId', 'createdAt']) {
    if (value[immutable] !== current[immutable]) {
      throw new HarnessConcurrencyError(
        'HARNESS_V4_STATE_IDENTITY_MUTATION',
        `Atomic state mutation cannot change ${immutable}.`
      );
    }
  }
  const next = sealState({
    ...withoutDigest(value, 'stateDigest'),
    revision: current.revision + 1,
    updatedAt
  });
  atomicWriteJson(statePath, next);
  return { ...next, statePath };
}

export function transitionRunState({ stateDir, runId, lifecycle, reason = null }) {
  const target = String(lifecycle || '').trim();
  if (!target) throw new TypeError('lifecycle is required.');
  return mutateRunStateAtomic({
    stateDir,
    runId,
    mutate(current) {
      assertLifecycleTransition(current.lifecycle, target);
      current.lifecycle = target;
      if (reason) current.lifecycleReason = String(reason).slice(0, 240);
      return current;
    }
  });
}

export function recoverRunState({
  stateDir,
  runId,
  action,
  ownerId,
  ttlMs = DEFAULT_LEASE_TTL_MS,
  now = Date.now()
}) {
  const current = readRunState({ stateDir, runId });
  if (!current) throw new HarnessConcurrencyError('HARNESS_V4_RUN_STATE_MISSING', `Missing state for ${runId}.`);
  if (TERMINAL_LIFECYCLES.has(current.lifecycle)) {
    throw new HarnessConcurrencyError(
      'HARNESS_V4_RECOVERY_TERMINAL_STATE',
      `Run ${runId} is terminal and cannot be recovered.`
    );
  }
  if (action === 'abort') {
    const resourceId = `run:${runId}`;
    const existingLease = readLease({
      stateDir,
      resourceId,
      includeExpired: true,
      now
    });
    if (
      existingLease?.status === 'active'
      && Date.parse(existingLease.expiresAt) > now
      && existingLease.ownerId !== ownerId
    ) {
      throw new HarnessConcurrencyError(
        'HARNESS_V4_RECOVERY_LEASE_OWNED_BY_ANOTHER',
        `Run ${runId} has an active lease owned by another session.`
      );
    }
    const state = mutateRunStateAtomic({
        stateDir,
        runId,
        mutate(value) {
          value.lifecycle = 'aborted';
          value.recovery = {
            action: 'abort',
            recoveredAt: new Date(now).toISOString(),
            ownerFingerprint: fingerprint(ownerId)
          };
          return value;
        },
        updatedAt: new Date(now).toISOString()
      });
    if (existingLease?.status === 'active' && existingLease.ownerId === ownerId) {
      releaseLease({
        stateDir,
        resourceId,
        ownerId,
        nonce: existingLease.nonce,
        now,
        reason: 'recovery-abort'
      });
    }
    return { state, lease: null };
  }
  if (action !== 'resume') {
    throw new HarnessConcurrencyError(
      'HARNESS_V4_RECOVERY_ACTION_INVALID',
      'Recovery action must be resume or abort.'
    );
  }
  if (!RESUMABLE_LIFECYCLES.has(current.lifecycle)) {
    throw new HarnessConcurrencyError(
      'HARNESS_V4_RECOVERY_STATE_INVALID',
      `Run lifecycle ${current.lifecycle} cannot be resumed.`
    );
  }
  const lease = acquireLease({
    stateDir,
    resourceId: `run:${runId}`,
    runId,
    ownerId,
    ttlMs,
    now,
    metadata: { recovery: 'resume' }
  });
  try {
    const state = compareAndSwapRunState({
      stateDir,
      runId,
      expectedRevision: current.revision,
      expectedStateDigest: current.stateDigest,
      updatedAt: new Date(now).toISOString(),
      mutate(value) {
        value.lifecycle = 'running';
        value.ownerFingerprint = fingerprint(ownerId);
        value.nonceFingerprint = fingerprint(lease.nonce);
        value.recovery = {
          action: 'resume',
          recoveredAt: new Date(now).toISOString(),
          priorLifecycle: current.lifecycle
        };
        return value;
      }
    });
    return { state, lease };
  } catch (error) {
    releaseLease({
      stateDir,
      resourceId: lease.resourceId,
      ownerId,
      nonce: lease.nonce,
      now,
      reason: 'recovery-cas-failed'
    });
    throw error;
  }
}

export function writeLatestRunNavigation({
  stateDir,
  runId,
  runDir,
  task = null,
  generatedAt = new Date().toISOString(),
  files = null,
  risk = null
}) {
  assertRunId(runId);
  const record = {
    schemaVersion: 2,
    authority: false,
    purpose: 'navigation-only',
    runId,
    runDir: path.resolve(runDir),
    task,
    risk,
    generatedAt,
    files
  };
  atomicWriteJson(path.join(stateDir, 'latest-run.json'), record);
  return record;
}

export function readLatestRunNavigation({ stateDir }) {
  const record = readJsonStrictOrNull(path.join(stateDir, 'latest-run.json'));
  if (!record) return null;
  if (record.authority !== false || record.purpose !== 'navigation-only') {
    throw new HarnessConcurrencyError(
      'HARNESS_V4_LATEST_RUN_AUTHORITY_FORBIDDEN',
      'latest-run.json is navigation-only and cannot be treated as authoritative.'
    );
  }
  return record;
}

export function resolveAuthoritativeRunState({ stateDir, runId }) {
  if (!runId) {
    throw new HarnessConcurrencyError(
      'HARNESS_V4_EXPLICIT_RUN_ID_REQUIRED',
      'An explicit run ID is required for authoritative state.'
    );
  }
  const state = readRunState({ stateDir, runId });
  if (!state) throw new HarnessConcurrencyError('HARNESS_V4_RUN_STATE_MISSING', `Missing state for ${runId}.`);
  return state;
}

export function withAtomicResourceLock({ stateDir, resourceId }, operation) {
  requireNonEmpty(stateDir, 'stateDir');
  requireNonEmpty(resourceId, 'resourceId');
  if (typeof operation !== 'function') throw new TypeError('operation must be a function.');
  const key = crypto.createHash('sha256').update(resourceId).digest('hex');
  const lockTarget = path.join(stateDir, 'resource-locks', `${key}.state`);
  return withFileLock(lockTarget, operation);
}

export function leasePathFor(stateDir, resourceId) {
  requireNonEmpty(stateDir, 'stateDir');
  requireNonEmpty(resourceId, 'resourceId');
  const key = crypto.createHash('sha256').update(resourceId).digest('hex');
  return path.join(stateDir, 'leases', `${key}.json`);
}

export function runStatePathFor(stateDir, runId) {
  assertRunId(runId);
  return path.join(stateDir, 'runs', `${runId}.json`);
}

function requireActiveLease({ leasePath, resourceId, ownerId, nonce, now }) {
  const current = requireOwnedLease({ leasePath, resourceId, ownerId, nonce });
  if (current.status !== 'active' || Date.parse(current.expiresAt) <= now) {
    throw new HarnessConcurrencyError('HARNESS_V4_LEASE_EXPIRED', `Lease for ${resourceId} is not active.`);
  }
  return current;
}

function requireOwnedLease({ leasePath, resourceId, ownerId, nonce }) {
  const current = readJsonStrictOrNull(leasePath);
  if (!current || !verifySealed(current, 'leaseDigest')) {
    throw new HarnessConcurrencyError('HARNESS_V4_LEASE_MISSING_OR_CORRUPT', `Lease for ${resourceId} is missing or corrupt.`);
  }
  if (current.resourceId !== resourceId || current.ownerId !== ownerId || current.nonce !== nonce) {
    throw new HarnessConcurrencyError('HARNESS_V4_LEASE_OWNERSHIP_MISMATCH', `Lease ownership mismatch for ${resourceId}.`);
  }
  return current;
}

function assertLifecycleTransition(from, to) {
  if (from === to) return;
  if (TERMINAL_LIFECYCLES.has(from)) {
    throw new HarnessConcurrencyError(
      'HARNESS_V4_TERMINAL_STATE_IMMUTABLE',
      `Cannot transition terminal lifecycle ${from} to ${to}.`
    );
  }
  const allowed = new Set(['planned', 'running', 'blocked', 'failed', 'error', 'passed', 'aborted', 'invalidated']);
  if (!allowed.has(to)) {
    throw new HarnessConcurrencyError('HARNESS_V4_LIFECYCLE_INVALID', `Unknown lifecycle ${to}.`);
  }
}

function withFileLock(targetPath, operation, {
  maxWaitMs = DEFAULT_LOCK_WAIT_MS,
  lockTtlMs = DEFAULT_LOCK_TTL_MS
} = {}) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const lockPath = `${targetPath}.lock`;
  const started = process.hrtime.bigint();
  const lockNonce = crypto.randomBytes(16).toString('hex');
  const waiter = createLockWaiter(lockPath, lockNonce);
  let queueDepth = 1;
  try {
    while (true) {
      reclaimAbandonedLockWaiters(waiter, maxWaitMs);
      const queue = inspectLockWaiterQueue(waiter);
      queueDepth = Math.max(queueDepth, queue.count);
      if (queue.isFirst) {
        let handle = null;
        let acquired = false;
        try {
          handle = fs.openSync(lockPath, 'wx', 0o600);
          fs.writeFileSync(handle, canonicalJson({
            schemaVersion: 1,
            pid: process.pid,
            nonce: lockNonce,
            createdAt: new Date().toISOString()
          }));
          fs.fsyncSync(handle);
          fs.closeSync(handle);
          handle = null;
          acquired = true;
        } catch (error) {
          if (handle !== null) {
            try { fs.closeSync(handle); } catch { /* ignored */ }
          }
          if (!isLockContention(error, lockPath)) throw error;
          reclaimStaleLock(lockPath, lockTtlMs);
        }
        if (acquired) {
          removeLockWaiter(waiter.path);
          try {
            return operation();
          } finally {
            releaseOwnedLock(lockPath, lockNonce);
          }
        }
      }
      const waitedMs = monotonicElapsedMs(started);
      if (waitedMs >= maxWaitMs) {
        throw new HarnessConcurrencyError(
          'HARNESS_V4_STATE_LOCK_TIMEOUT',
          `Timed out acquiring atomic state lock for ${path.basename(targetPath)}.`,
          { waitedMs, maximumQueueDepth: queueDepth }
        );
      }
      blockFor(4);
    }
  } finally {
    removeLockWaiter(waiter.path);
  }
}

function createLockWaiter(lockPath, nonce) {
  const directory = path.join(path.dirname(lockPath), '.lock-waiters');
  fs.mkdirSync(directory, { recursive: true });
  const key = crypto.createHash('sha256').update(path.basename(lockPath)).digest('hex');
  const createdAtMs = Date.now();
  const prefix = `${key}.`;
  const file = `${prefix}${String(createdAtMs).padStart(16, '0')}.${nonce}.wait`;
  const waiterPath = path.join(directory, file);
  let handle = null;
  let complete = false;
  try {
    handle = fs.openSync(waiterPath, 'wx', 0o600);
    fs.writeFileSync(handle, canonicalJson({
      schemaVersion: 1,
      pid: process.pid,
      nonce,
      createdAt: new Date(createdAtMs).toISOString()
    }));
    fs.closeSync(handle);
    handle = null;
    complete = true;
  } finally {
    if (handle !== null) {
      try { fs.closeSync(handle); } catch { /* ignored */ }
    }
    if (!complete) {
      try { unlinkFileDurably(waiterPath); } catch { /* Another process will reclaim an abandoned ticket. */ }
    }
  }
  return { path: waiterPath, directory, prefix };
}

function inspectLockWaiterQueue(waiter) {
  let names;
  try {
    names = fs.readdirSync(waiter.directory)
      .filter((name) => name.startsWith(waiter.prefix) && name.endsWith('.wait'))
      .sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return { isFirst: false, count: 0 };
    throw error;
  }
  return {
    isFirst: names[0] === path.basename(waiter.path),
    count: names.length
  };
}

function reclaimAbandonedLockWaiters(waiter, maxWaitMs) {
  let names;
  try {
    names = fs.readdirSync(waiter.directory)
      .filter((name) => name.startsWith(waiter.prefix) && name.endsWith('.wait'));
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  const now = Date.now();
  for (const name of names) {
    const candidate = path.join(waiter.directory, name);
    if (candidate === waiter.path) continue;
    let stat;
    let record;
    try {
      stat = fs.statSync(candidate);
      record = JSON.parse(fs.readFileSync(candidate, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      if (stat && now - stat.mtimeMs <= 1000) continue;
      removeLockWaiter(candidate);
      continue;
    }
    const ageMs = now - stat.mtimeMs;
    if (!isProcessAlive(record?.pid) || ageMs > maxWaitMs + 2000) {
      removeLockWaiter(candidate);
    }
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function removeLockWaiter(waiterPath) {
  try {
    unlinkFileDurably(waiterPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function monotonicElapsedMs(started) {
  return Number((process.hrtime.bigint() - started) / 1_000_000n);
}

function isLockContention(error, lockPath) {
  if (error?.code === 'EEXIST') return true;
  if (['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) return true;
  return false;
}

function reclaimStaleLock(lockPath, lockTtlMs) {
  let stat;
  try {
    stat = fs.statSync(lockPath);
  } catch {
    return;
  }
  if (Date.now() - stat.mtimeMs <= lockTtlMs) return;
  const quarantine = `${lockPath}.stale.${process.pid}.${crypto.randomBytes(8).toString('hex')}`;
  try {
    fs.renameSync(lockPath, quarantine);
    unlinkFileDurably(quarantine);
  } catch { /* Another contender reclaimed or refreshed the lock. */ }
}

function releaseOwnedLock(lockPath, lockNonce) {
  const deadline = Date.now() + 2000;
  while (true) {
    let lock;
    try {
      lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      if (['EPERM', 'EACCES', 'EBUSY'].includes(error?.code) && Date.now() < deadline) {
        blockFor(8);
        continue;
      }
      throw new HarnessConcurrencyError(
        'HARNESS_V4_STATE_LOCK_RELEASE_FAILED',
        `Cannot inspect atomic state lock for ${path.basename(lockPath)}.`
      );
    }
    if (!lock || lock.nonce !== lockNonce) return;
    const releasedPath = `${lockPath}.released.${lockNonce}`;
    try {
      fs.renameSync(lockPath, releasedPath);
      try {
        unlinkFileDurably(releasedPath);
      } catch {
        // The authoritative lock path is already free; a released tombstone is harmless.
      }
      return;
    } catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error?.code) || Date.now() >= deadline) {
        throw new HarnessConcurrencyError(
          'HARNESS_V4_STATE_LOCK_RELEASE_FAILED',
          `Cannot release atomic state lock for ${path.basename(lockPath)}.`
        );
      }
      blockFor(8);
    }
  }
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`;
  let handle = null;
  try {
    handle = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(handle, `${canonicalJson(value)}\n`, 'utf8');
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = null;
    replaceFileWithTransientRetry(temp, file);
    syncDirectory(path.dirname(file));
  } finally {
    if (handle !== null) {
      try { fs.closeSync(handle); } catch { /* ignored */ }
    }
    try { unlinkFileDurably(temp); } catch { /* ignored */ }
  }
}

function unlinkFileDurably(file) {
  const deadline = Date.now() + 2000;
  while (true) {
    try {
      fs.unlinkSync(file);
      if (fs.existsSync(file)) {
        throw Object.assign(new Error('unlink returned before the file disappeared'), { code: 'EBUSY' });
      }
      return;
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error?.code) || Date.now() >= deadline) throw error;
      blockFor(8);
    }
  }
}

function replaceFileWithTransientRetry(source, destination) {
  const deadline = Date.now() + 2000;
  while (true) {
    try {
      fs.renameSync(source, destination);
      return;
    } catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error?.code) || Date.now() >= deadline) {
        throw error;
      }
      blockFor(8);
    }
  }
}

function syncDirectory(dir) {
  let handle = null;
  try {
    handle = fs.openSync(dir, 'r');
    fs.fsyncSync(handle);
  } catch {
    // Directory fsync is not available on every Windows/filesystem combination.
  } finally {
    if (handle !== null) {
      try { fs.closeSync(handle); } catch { /* ignored */ }
    }
  }
}

function sealLease(value) {
  const payload = withoutDigest(value, 'leaseDigest');
  return { ...payload, leaseDigest: digestCanonicalJson(payload) };
}

function sealState(value) {
  const payload = withoutDigest(value, 'stateDigest');
  return { ...payload, stateDigest: digestCanonicalJson(payload) };
}

function verifySealed(value, digestField) {
  return value?.[digestField] === digestCanonicalJson(withoutDigest(value, digestField));
}

function withoutDigest(value, field) {
  const copy = cloneJson(value);
  delete copy[field];
  delete copy.statePath;
  delete copy.leasePath;
  return copy;
}

function withoutRuntimePath(value) {
  const copy = cloneJson(value);
  delete copy.statePath;
  return copy;
}

function readJsonStrictOrNull(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new HarnessConcurrencyError(
      'HARNESS_V4_ATOMIC_STATE_CORRUPT',
      `Cannot parse atomic state file ${path.basename(file)}.`
    );
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function fingerprint(value) {
  return digestCanonicalJson({ value: String(value || '') });
}

function restrictFile(file) {
  try { fs.chmodSync(file, 0o600); } catch { /* Best effort on Windows. */ }
}

function blockFor(milliseconds) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function assertRunId(runId) {
  requireNonEmpty(runId, 'runId');
  if (!/^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{32}-[a-z0-9\u4e00-\u9fa5-]{1,48}$/u.test(runId)
    && !/^[a-z0-9][a-z0-9._-]{0,159}$/i.test(runId)) {
    throw new HarnessConcurrencyError('HARNESS_V4_RUN_ID_INVALID', 'runId has an invalid format.');
  }
}

function assertPositiveInteger(value, field) {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${field} must be a positive integer.`);
}

function requireNonEmpty(value, field) {
  if (!String(value || '').trim()) throw new TypeError(`${field} is required.`);
}

function assertDescendant(parent, child, code) {
  const relative = path.relative(parent, child);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new HarnessConcurrencyError(code, `Path ${child} is not a unique descendant of ${parent}.`);
  }
}
