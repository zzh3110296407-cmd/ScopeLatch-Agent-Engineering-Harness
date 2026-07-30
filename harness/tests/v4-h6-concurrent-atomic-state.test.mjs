import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  acquireLease,
  buildImmutableCandidateWorkspace,
  compareAndSwapRunState,
  createCollisionResistantRunId,
  heartbeatLease,
  initializeRunState,
  mutateRunStateAtomic,
  readLatestRunNavigation,
  readLease,
  readRunState,
  recoverRunState,
  releaseLease,
  reserveRunDirectory,
  resolveAuthoritativeRunState,
  transitionRunState,
  withAtomicResourceLock,
  writeLatestRunNavigation
} from '../lib/v4/concurrent-state.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDir, '..', '..');
const moduleUrl = pathToFileURL(path.join(repositoryRoot, 'harness', 'lib', 'v4', 'concurrent-state.mjs')).href;
const cliPath = path.join(repositoryRoot, 'harness', 'cli.mjs');
const concurrentStateSource = fs.readFileSync(
  path.join(repositoryRoot, 'harness', 'lib', 'v4', 'concurrent-state.mjs'),
  'utf8'
);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v4-h6-'));
const stateDir = path.join(root, '.harness', 'state');

try {
  assert.match(
    concurrentStateSource,
    /const DEFAULT_LOCK_WAIT_MS = 60 \* 1000;/,
    'the production lock wait budget must cover the slow-Windows-fsync stress profile'
  );
  const ids = new Set();
  for (let index = 0; index < 5000; index += 1) {
    ids.add(createCollisionResistantRunId({ taskSlug: 'parallel task', now: new Date('2026-07-29T00:00:00Z') }));
  }
  assert.equal(ids.size, 5000);
  const [runA, runB] = [...ids];
  assert.match(runA, /^20260729T000000Z-[a-f0-9]{32}-parallel-task$/);

  const reservedA = reserveRunDirectory({ root, outputDir: '.harness/runs', runId: runA });
  const reservedB = reserveRunDirectory({ root, outputDir: '.harness/runs', runId: runB });
  assert.notEqual(reservedA.runDir, reservedB.runDir);
  assert.notEqual(reservedA.evidenceDir, reservedB.evidenceDir);
  assert.notEqual(reservedA.outputArtifactDir, reservedB.outputArtifactDir);
  assert.throws(
    () => reserveRunDirectory({ root, outputDir: '.harness/runs', runId: runA }),
    (error) => error?.code === 'HARNESS_V4_RUN_DIRECTORY_COLLISION'
  );

  const candidate = {
    indexTreeOid: 'a'.repeat(40),
    snapshotDigest: `sha256:${'b'.repeat(64)}`
  };
  const workspaceA = buildImmutableCandidateWorkspace({
    root,
    runId: runA,
    runDir: reservedA.runDir,
    candidateSnapshot: candidate
  });
  const workspaceB = buildImmutableCandidateWorkspace({
    root,
    runId: runB,
    runDir: reservedB.runDir,
    candidateSnapshot: candidate
  });
  assert.equal(workspaceA.mode, 'immutable-git-tree');
  assert.equal(workspaceA.readOnlyCandidate, true);
  assert.notEqual(workspaceA.workspaceDigest, workspaceB.workspaceDigest);
  assert.notEqual(workspaceA.ownershipResourceId, workspaceB.ownershipResourceId);

  const leaseA = acquireLease({
    stateDir,
    resourceId: workspaceA.ownershipResourceId,
    runId: runA,
    ownerId: 'owner-a',
    ttlMs: 1000,
    now: 1000
  });
  assert.match(leaseA.nonce, /^[A-Za-z0-9_-]{32}$/);
  assert.throws(
    () => acquireLease({
      stateDir,
      resourceId: workspaceA.ownershipResourceId,
      runId: runA,
      ownerId: 'owner-b',
      ttlMs: 1000,
      now: 1500
    }),
    (error) => error?.code === 'HARNESS_V4_LEASE_ALREADY_HELD'
  );
  assert.throws(
    () => heartbeatLease({
      stateDir,
      resourceId: workspaceA.ownershipResourceId,
      ownerId: 'owner-a',
      nonce: 'wrong',
      ttlMs: 1000,
      now: 1500
    }),
    (error) => error?.code === 'HARNESS_V4_LEASE_OWNERSHIP_MISMATCH'
  );
  const heartbeat = heartbeatLease({
    stateDir,
    resourceId: workspaceA.ownershipResourceId,
    ownerId: 'owner-a',
    nonce: leaseA.nonce,
    ttlMs: 1000,
    now: 1500
  });
  assert.equal(heartbeat.revision, leaseA.revision + 1);
  assert.equal(heartbeat.expiresAt, new Date(2500).toISOString());

  const initial = initializeRunState({
    stateDir,
    runId: runA,
    ownerFingerprint: 'owner-fingerprint-a',
    nonceFingerprint: 'nonce-fingerprint-a',
    workspace: workspaceA,
    generatedAt: new Date(1000).toISOString(),
    data: { counter: 0 }
  });
  assert.equal(initial.revision, 0);
  assert.equal(initial.lifecycle, 'planned');
  const afterCas = compareAndSwapRunState({
    stateDir,
    runId: runA,
    expectedRevision: initial.revision,
    expectedStateDigest: initial.stateDigest,
    updatedAt: new Date(1200).toISOString(),
    mutate(value) {
      value.data.counter += 1;
      return value;
    }
  });
  assert.equal(afterCas.revision, 1);
  assert.equal(afterCas.data.counter, 1);
  assert.throws(
    () => compareAndSwapRunState({
      stateDir,
      runId: runA,
      expectedRevision: initial.revision,
      expectedStateDigest: initial.stateDigest,
      mutate: (value) => value
    }),
    (error) => error?.code === 'HARNESS_V4_CAS_CONFLICT'
  );

  const workers = 6;
  const increments = 50;
  await Promise.all(Array.from({ length: workers }, () => spawnWorker({
    moduleUrl,
    stateDir,
    runId: runA,
    increments
  })));
  const stressed = readRunState({ stateDir, runId: runA });
  assert.equal(stressed.data.counter, 1 + workers * increments);
  assert.equal(stressed.revision, 1 + workers * increments);

  const slowFilesystemWorkers = 8;
  const slowFilesystemIncrements = 15;
  const slowFilesystemResults = await Promise.allSettled(
    Array.from({ length: slowFilesystemWorkers }, () => spawnWorker({
      moduleUrl,
      stateDir,
      runId: runA,
      increments: slowFilesystemIncrements,
      fsyncDelayMs: 100
    }))
  );
  const slowFilesystemFailures = slowFilesystemResults
    .filter((result) => result.status === 'rejected')
    .map((result) => String(result.reason?.message || result.reason));
  assert.deepEqual(
    slowFilesystemFailures,
    [],
    `fair lock acquisition failed under simulated slow Windows fsync:\n${slowFilesystemFailures.join('\n')}`
  );
  const slowFilesystemStressed = readRunState({ stateDir, runId: runA });
  assert.equal(
    slowFilesystemStressed.data.counter,
    1 + workers * increments + slowFilesystemWorkers * slowFilesystemIncrements
  );
  assert.equal(
    slowFilesystemStressed.revision,
    1 + workers * increments + slowFilesystemWorkers * slowFilesystemIncrements
  );
  assert.deepEqual(
    listLockWaiters(path.join(stateDir, 'runs', '.lock-waiters')),
    [],
    'successful state mutations must not leak lock waiter tickets'
  );
  const operationError = Object.assign(new Error('operation-level EEXIST'), { code: 'EEXIST' });
  assert.throws(
    () => withAtomicResourceLock({
      stateDir,
      resourceId: 'operation-error-propagation'
    }, () => {
      throw operationError;
    }),
    (error) => error === operationError,
    'operation errors must never be mistaken for lock-acquisition contention'
  );
  assert.deepEqual(
    listLockWaiters(path.join(stateDir, 'resource-locks', '.lock-waiters')),
    [],
    'failed operations must not leak lock waiter tickets'
  );

  writeLatestRunNavigation({
    stateDir,
    runId: runA,
    runDir: reservedA.runDir,
    task: 'navigation only'
  });
  const navigation = readLatestRunNavigation({ stateDir });
  assert.equal(navigation.authority, false);
  assert.equal(navigation.purpose, 'navigation-only');
  assert.equal(resolveAuthoritativeRunState({ stateDir, runId: runA }).runId, runA);
  assert.throws(
    () => resolveAuthoritativeRunState({ stateDir, runId: null }),
    (error) => error?.code === 'HARNESS_V4_EXPLICIT_RUN_ID_REQUIRED'
  );

  releaseLease({
    stateDir,
    resourceId: workspaceA.ownershipResourceId,
    ownerId: 'owner-a',
    nonce: leaseA.nonce,
    now: 2600,
    reason: 'simulated-crash'
  });
  transitionRunState({ stateDir, runId: runA, lifecycle: 'running' });
  const resumed = recoverRunState({
    stateDir,
    runId: runA,
    action: 'resume',
    ownerId: 'owner-recovery',
    ttlMs: 1000,
    now: 3000
  });
  assert.equal(resumed.state.lifecycle, 'running');
  assert.equal(resumed.state.recovery.action, 'resume');
  assert.notEqual(resumed.state.lifecycle, 'passed');
  assert.equal(readLease({
    stateDir,
    resourceId: workspaceA.ownershipResourceId,
    now: 3001
  }).ownerId, 'owner-recovery');

  const initialB = initializeRunState({
    stateDir,
    runId: runB,
    ownerFingerprint: 'owner-fingerprint-b',
    nonceFingerprint: 'nonce-fingerprint-b',
    workspace: workspaceB,
    data: {}
  });
  assert.equal(initialB.lifecycle, 'planned');
  const leaseB = acquireLease({
    stateDir,
    resourceId: workspaceB.ownershipResourceId,
    runId: runB,
    ownerId: 'owner-b',
    ttlMs: 1000,
    now: 4000
  });
  assert.throws(
    () => recoverRunState({
      stateDir,
      runId: runB,
      action: 'abort',
      ownerId: 'owner-intruder',
      now: 4001
    }),
    (error) => error?.code === 'HARNESS_V4_RECOVERY_LEASE_OWNED_BY_ANOTHER'
  );
  const aborted = recoverRunState({
    stateDir,
    runId: runB,
    action: 'abort',
    ownerId: 'owner-b',
    now: 4000
  });
  assert.equal(aborted.state.lifecycle, 'aborted');
  assert.equal(readLease({
    stateDir,
    resourceId: workspaceB.ownershipResourceId,
    includeExpired: true
  }).status, 'released');
  assert.throws(
    () => recoverRunState({
      stateDir,
      runId: runB,
      action: 'resume',
      ownerId: 'owner-b',
      now: 5000
    }),
    (error) => error?.code === 'HARNESS_V4_RECOVERY_TERMINAL_STATE'
  );

  const direct = mutateRunStateAtomic({
    stateDir,
    runId: runA,
    mutate(value) {
      value.data.atomic = true;
      return value;
    }
  });
  assert.equal(direct.data.atomic, true);

  const cliRoot = path.join(root, 'cli-project');
  prepareCliRepository(cliRoot);
  const cliSessions = Array.from({ length: 4 }, (_, index) => `h6-cli-session-${index}`);
  const cliPlans = await Promise.all(cliSessions.map((sessionId, index) => spawnCli(
    cliRoot,
    ['plan', `parallel cli task ${index}`],
    { HARNESS_SESSION_ID: sessionId }
  )));
  for (const result of cliPlans) assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  const cliRunsRoot = path.join(cliRoot, '.harness', 'runs');
  const cliRunIds = fs.readdirSync(cliRunsRoot).sort();
  assert.equal(cliRunIds.length, cliSessions.length);
  assert.equal(new Set(cliRunIds).size, cliSessions.length);
  const cliStates = fs.readdirSync(path.join(cliRoot, '.harness', 'state', 'runs')).filter((name) => name.endsWith('.json'));
  const cliLeases = fs.readdirSync(path.join(cliRoot, '.harness', 'state', 'leases')).filter((name) => name.endsWith('.json'));
  assert.equal(cliStates.length, cliSessions.length);
  assert.equal(cliLeases.length, cliSessions.length);
  const workspaceResources = cliRunIds.map((id) => {
    const manifest = readJson(path.join(cliRunsRoot, id, 'run-manifest.json'));
    assert.equal(manifest.executionWorkspace.readOnlyCandidate, true);
    assert.equal(manifest.executionWorkspace.runId, id);
    return manifest.executionWorkspace.ownershipResourceId;
  });
  assert.equal(new Set(workspaceResources).size, cliSessions.length);

  const navigationStatus = runCli(cliRoot, ['status']);
  assert.equal(navigationStatus.status, 0, `${navigationStatus.stdout}\n${navigationStatus.stderr}`);
  const navigationPayload = JSON.parse(navigationStatus.stdout);
  assert.equal(navigationPayload.latestRunNavigation.authority, false);
  assert.equal(navigationPayload.authoritativeRun, null);
  const explicitStatus = runCli(cliRoot, ['status', '--run', cliRunIds[0]]);
  assert.equal(explicitStatus.status, 0, `${explicitStatus.stdout}\n${explicitStatus.stderr}`);
  assert.equal(JSON.parse(explicitStatus.stdout).authoritativeRun.state.runId, cliRunIds[0]);

  const deniedAbort = runCli(
    cliRoot,
    ['recover', '--run', cliRunIds[0], '--action', 'abort'],
    { HARNESS_SESSION_ID: 'not-the-owner' }
  );
  assert.notEqual(deniedAbort.status, 0);
  assert.match(deniedAbort.stderr, /RECOVERY_LEASE_OWNED_BY_ANOTHER/);
  const ownerIndex = Number(/parallel-cli-task-(\d+)$/.exec(cliRunIds[0])?.[1]);
  const ownerAbort = runCli(
    cliRoot,
    ['recover', '--run', cliRunIds[0], '--action', 'abort'],
    { HARNESS_SESSION_ID: cliSessions[ownerIndex] }
  );
  assert.equal(ownerAbort.status, 0, `${ownerAbort.stdout}\n${ownerAbort.stderr}`);
  assert.equal(readRunState({
    stateDir: path.join(cliRoot, '.harness', 'state'),
    runId: cliRunIds[0]
  }).lifecycle, 'aborted');

  for (const hookPath of [
    '.codex/hooks/pre_tool_use_policy.py',
    '.codex/hooks/post_tool_use_guard.py',
    '.codex/hooks/stop_guard.py'
  ]) {
    assert.doesNotMatch(
      fs.readFileSync(path.join(repositoryRoot, hookPath), 'utf8'),
      /latest-run\.json/,
      `${hookPath} still treats latest-run.json as an authority source`
    );
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

const reportPath = path.join(repositoryRoot, '.harness', 'docs', 'harness-v4-h6-concurrent-atomic-state-report.json');
const predecessorPath = path.join(repositoryRoot, '.harness', 'docs', 'harness-v4-h5-independent-auditor-report.json');
assert.equal(fs.existsSync(reportPath), true, 'tracked H6 report is missing');
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
assert.equal(report.schemaVersion, 1);
assert.equal(report.milestone, 'H6');
assert.equal(report.contractVersion, 'harness-trust-v4.0.0');
assert.equal(report.predecessor.milestone, 'H5');
assert.equal(report.predecessor.reportDigest, sha256File(predecessorPath));
assert.equal(report.predecessor.regressionStatus, 'PASS');
assert.equal(report.isolatedAcceptance.status, 'PASS');
assert.equal(report.isolatedAcceptance.networkUsed, false);
assert.deepEqual(report.hardFailures, []);
assert.equal(report.finalMarker, 'HARNESS_V4_H6_CONCURRENT_ATOMIC_STATE: PASS');

const expectedHashPaths = [
  '.codex/hooks/post_tool_use_guard.py',
  '.codex/hooks/pre_tool_use_policy.py',
  '.codex/hooks/stop_guard.py',
  'harness/cli.mjs',
  'harness/lib/closeout.mjs',
  'harness/lib/manifest.mjs',
  'harness/lib/session-binding.mjs',
  'harness/lib/v4/concurrent-state.mjs',
  'harness/tests/hooks-policy.test.mjs',
  'harness/tests/v4-h6-concurrent-atomic-state.test.mjs'
].sort();
assert.deepEqual(Object.keys(report.sourceHashes).sort(), expectedHashPaths);
for (const relPath of expectedHashPaths) {
  assert.equal(report.sourceHashes[relPath], sha256File(path.join(repositoryRoot, relPath)), `H6 source hash mismatch: ${relPath}`);
}
const successorPath = path.join(repositoryRoot, '.harness', 'docs', 'harness-v4-h7-safe-executor-report.json');
if (fs.existsSync(successorPath)) {
  const successor = JSON.parse(fs.readFileSync(successorPath, 'utf8'));
  assert.equal(successor.predecessor?.milestone, 'H6');
  assert.equal(successor.predecessor?.reportDigest, sha256File(reportPath));
  assert.equal(successor.predecessor?.regressionStatus, 'PASS');
}

console.log('HARNESS_V4_H6_CONCURRENT_ATOMIC_STATE: PASS');

function spawnWorker({
  moduleUrl: targetModuleUrl,
  stateDir: targetStateDir,
  runId,
  increments: count,
  fsyncDelayMs = 0
}) {
  const script = `
    import fs from 'node:fs';
    const stateDir = process.argv[1];
    const runId = process.argv[2];
    const count = Number(process.argv[3]);
    const fsyncDelayMs = Number(process.argv[4]);
    if (fsyncDelayMs > 0) {
      const realFsyncSync = fs.fsyncSync.bind(fs);
      fs.fsyncSync = (...args) => {
        const signal = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(signal, 0, 0, fsyncDelayMs);
        return realFsyncSync(...args);
      };
    }
    const { mutateRunStateAtomic } = await import(${JSON.stringify(targetModuleUrl)});
    for (let index = 0; index < count; index += 1) {
      mutateRunStateAtomic({
        stateDir,
        runId,
        mutate(value) {
          value.data.counter += 1;
          return value;
        }
      });
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--input-type=module',
      '-e',
      script,
      targetStateDir,
      runId,
      String(count),
      String(fsyncDelayMs)
    ], {
      cwd: repositoryRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`CAS worker exited ${code}: ${stderr}`));
    });
  });
}

function listLockWaiters(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => name.endsWith('.wait')).sort();
}

function prepareCliRepository(root) {
  fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
  fs.mkdirSync(path.join(root, 'harness', 'contracts', 'v4'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), '# H6 CLI fixture\n', 'utf8');
  fs.writeFileSync(path.join(root, '.harness', 'harness.config.json'), `${JSON.stringify({
    repoName: 'H6 CLI fixture',
    context: {
      sourcePriority: {
        autoDetectCanonicalSource: false,
        canonicalSourceRoot: '.',
        canonicalMarkers: ['README.md']
      }
    },
    commands: {
      lint: `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
      typecheck: `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
      testUnit: `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
      testIntegration: `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
      testContract: `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
      testE2E: `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
      build: `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
      generateClient: `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
      fullCI: `${JSON.stringify(process.execPath)} -e "process.exit(0)"`
    }
  }, null, 2)}\n`, 'utf8');
  fs.copyFileSync(
    path.join(repositoryRoot, 'harness', 'contracts', 'v4', 'invariant-catalog.json'),
    path.join(root, 'harness', 'contracts', 'v4', 'invariant-catalog.json')
  );
  git(root, ['init']);
  git(root, ['config', 'user.email', 'harness@example.invalid']);
  git(root, ['config', 'user.name', 'H6 CLI Fixture']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'frozen candidate']);
}

function spawnCli(root, args, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: root,
      env: { ...process.env, ...envOverrides },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

function runCli(root, args, envOverrides = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: root,
    env: { ...process.env, ...envOverrides },
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 20 * 1024 * 1024
  });
}

function git(root, args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 5 * 1024 * 1024
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256File(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}
