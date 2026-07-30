import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  acquireLease,
  initializeRunState,
  releaseLease,
  transitionRunState
} from '../lib/v4/concurrent-state.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..', '..');
const preToolHook = path.join(repoRoot, '.codex', 'hooks', 'pre_tool_use_policy.py');
const stopHook = path.join(repoRoot, '.codex', 'hooks', 'stop_guard.py');
const postToolHook = path.join(repoRoot, '.codex', 'hooks', 'post_tool_use_guard.py');
const sessionId = 'harness-hook-test-session';

const noHarnessRoot = makeGitProject('harness-hook-no-plan-');
const deniedWrite = runHook(preToolHook, noHarnessRoot, {
  tool_name: 'functions.exec_command',
  tool_input: { cmd: 'Set-Content -Path note.txt -Value x' }
});
assert.equal(deniedWrite.hookSpecificOutput?.permissionDecision, 'deny');
assert.match(deniedWrite.hookSpecificOutput?.permissionDecisionReason || '', /Harness plan required/);

const deniedPatch = runHook(preToolHook, noHarnessRoot, {
  tool_name: 'functions.apply_patch',
  tool_input: { patch: '*** Begin Patch\n*** End Patch\n' }
});
assert.equal(deniedPatch.hookSpecificOutput?.permissionDecision, 'deny');
assert.match(deniedPatch.hookSpecificOutput?.permissionDecisionReason || '', /Harness plan required/);

const dangerous = runHook(preToolHook, noHarnessRoot, {
  tool_name: 'functions.exec_command',
  tool_input: { cmd: 'git reset --hard HEAD' }
});
assert.equal(dangerous.hookSpecificOutput?.permissionDecision, 'deny');
assert.match(dangerous.hookSpecificOutput?.permissionDecisionReason || '', /reset --hard/);

const dangerousWindows = runHook(preToolHook, noHarnessRoot, {
  tool_name: 'functions.exec_command',
  tool_input: { cmd: 'Remove-Item -LiteralPath .\\cache -Recurse -Force' }
});
assert.equal(dangerousWindows.hookSpecificOutput?.permissionDecision, 'deny');
assert.match(dangerousWindows.hookSpecificOutput?.permissionDecisionReason || '', /recursive forced delete/);

const dangerousRestore = runHook(preToolHook, noHarnessRoot, {
  tool_name: 'functions.exec_command',
  tool_input: { cmd: 'git restore tracked.txt' }
});
assert.equal(dangerousRestore.hookSpecificOutput?.permissionDecision, 'deny');
assert.match(dangerousRestore.hookSpecificOutput?.permissionDecisionReason || '', /overwrite uncommitted work/);

const plannedRoot = makeGitProject('harness-hook-planned-');
writeHarnessRun(plannedRoot, 'planned-run', { validation: false, allowedFiles: ['note.txt'] });
const allowedWrite = runHook(preToolHook, plannedRoot, {
  tool_name: 'functions.exec_command',
  tool_input: { cmd: 'Set-Content -Path note.txt -Value x' }
});
assert.equal(allowedWrite.hookSpecificOutput?.permissionDecision || 'allow', 'allow');
const misleadingLatest = JSON.parse(fs.readFileSync(
  path.join(plannedRoot, '.harness', 'state', 'latest-run.json'),
  'utf8'
));
assert.equal(misleadingLatest.authority, false);
assert.equal(misleadingLatest.runId, 'attacker-controlled-navigation');

const deniedOutOfScope = runHook(preToolHook, plannedRoot, {
  tool_name: 'functions.exec_command',
  tool_input: { cmd: 'Set-Content -Path outside.txt -Value x' }
});
assert.equal(deniedOutOfScope.hookSpecificOutput?.permissionDecision, 'deny');
assert.match(deniedOutOfScope.hookSpecificOutput?.permissionDecisionReason || '', /out-of-scope/);

const deniedSession = runHook(preToolHook, plannedRoot, {
  tool_name: 'functions.exec_command',
  thread_id: 'another-session',
  tool_input: { cmd: 'Set-Content -Path note.txt -Value x' }
});
assert.equal(deniedSession.hookSpecificOutput?.permissionDecision, 'deny');
assert.match(deniedSession.hookSpecificOutput?.permissionDecisionReason || '', /different Codex session/);

fs.writeFileSync(path.join(plannedRoot, 'note.txt'), 'pending commit\n', 'utf8');
const deniedUnclosedCommit = runHook(preToolHook, plannedRoot, {
  tool_name: 'functions.exec_command',
  tool_input: { cmd: 'git commit -m "should be blocked"' }
});
assert.equal(deniedUnclosedCommit.hookSpecificOutput?.permissionDecision, 'deny');
assert.match(deniedUnclosedCommit.hookSpecificOutput?.permissionDecisionReason || '', /validated Harness closeout/);
removeTree(path.join(plannedRoot, 'note.txt'));

fs.writeFileSync(path.join(plannedRoot, 'outside.txt'), 'unparsed side effect\n', 'utf8');
const deniedPostSideEffect = runHook(postToolHook, plannedRoot, {
  tool_name: 'functions.exec_command',
  tool_input: { cmd: 'custom-writer --opaque' }
});
assert.equal(deniedPostSideEffect.decision, 'block');
assert.match(deniedPostSideEffect.reason || '', /unapproved repository side effect/);
removeTree(path.join(plannedRoot, 'outside.txt'));

const expiredRoot = makeGitProject('harness-hook-expired-');
writeHarnessRun(expiredRoot, 'expired-run', {
  validation: false,
  allowedFiles: ['note.txt'],
  expiresAt: new Date(Date.now() - 60_000).toISOString()
});
const deniedExpired = runHook(preToolHook, expiredRoot, {
  tool_name: 'functions.exec_command',
  tool_input: { cmd: 'Set-Content -Path note.txt -Value x' }
});
assert.equal(deniedExpired.hookSpecificOutput?.permissionDecision, 'deny');
assert.match(deniedExpired.hookSpecificOutput?.permissionDecisionReason || '', /expired/);

const changedCommitRoot = makeGitProject('harness-hook-commit-');
writeHarnessRun(changedCommitRoot, 'commit-run', { validation: false, allowedFiles: ['note.txt'] });
fs.writeFileSync(path.join(changedCommitRoot, 'second.txt'), 'second\n', 'utf8');
git(changedCommitRoot, ['add', '.']);
git(changedCommitRoot, ['commit', '-m', 'second']);
const deniedCommit = runHook(preToolHook, changedCommitRoot, {
  tool_name: 'functions.exec_command',
  tool_input: { cmd: 'Set-Content -Path note.txt -Value x' }
});
assert.equal(deniedCommit.hookSpecificOutput?.permissionDecision, 'deny');
assert.match(deniedCommit.hookSpecificOutput?.permissionDecisionReason || '', /different commit/);

const unicodeRoot = makeGitProject('harness-hook-unicode-路径-');
fs.writeFileSync(path.join(unicodeRoot, 'tracked.txt'), 'dirty\n', 'utf8');
writeHarnessRun(unicodeRoot, 'unicode-run', { validation: false });
const unicodeStop = runHook(stopHook, unicodeRoot, { stop_hook_active: false });
assert.equal(unicodeStop.decision, 'block');
assert.match(unicodeStop.reason || '', /no validation result/);

const ambiguousRoot = makeGitProject('harness-hook-ambiguous-');
writeHarnessRun(ambiguousRoot, 'first-run', { validation: false, allowedFiles: ['note.txt'] });
writeHarnessRun(ambiguousRoot, 'second-run', { validation: false, allowedFiles: ['note.txt'] });
const deniedAmbiguous = runHook(preToolHook, ambiguousRoot, {
  tool_name: 'functions.exec_command',
  tool_input: { cmd: 'Set-Content -Path note.txt -Value x' }
});
assert.equal(deniedAmbiguous.hookSpecificOutput?.permissionDecision, 'deny');
assert.match(deniedAmbiguous.hookSpecificOutput?.permissionDecisionReason || '', /multiple authoritative Harness runs/);
const explicitRunAllowed = runHook(
  preToolHook,
  ambiguousRoot,
  {
    tool_name: 'functions.exec_command',
    tool_input: { cmd: 'Set-Content -Path note.txt -Value x' }
  },
  { HARNESS_RUN_ID: 'first-run' }
);
assert.equal(explicitRunAllowed.hookSpecificOutput?.permissionDecision || 'allow', 'allow');

const staleRoot = makeGitProject('harness-hook-stale-');
writeHarnessRun(staleRoot, 'validated-run', {
  validation: true,
  status: 'passed',
  phase: 'closeout-complete'
});
const validationFile = path.join(staleRoot, '.harness', 'runs', 'validated-run', 'validation-result.json');
const oldTime = new Date(Date.now() - 60_000);
fs.utimesSync(validationFile, oldTime, oldTime);
fs.writeFileSync(path.join(staleRoot, 'tracked.txt'), 'changed after validation\n', 'utf8');
const staleStop = runHook(stopHook, staleRoot, { stop_hook_active: false });
assert.equal(staleStop.decision, 'block');
assert.match(staleStop.reason || '', /newer than the latest validation/);

const incompleteCloseoutRoot = makeGitProject('harness-hook-incomplete-closeout-');
fs.writeFileSync(path.join(incompleteCloseoutRoot, 'tracked.txt'), 'dirty but not closed\n', 'utf8');
writeHarnessRun(incompleteCloseoutRoot, 'guarded-run', {
  validation: true,
  status: 'guarded',
  phase: 'guard-complete'
});
const incompleteCloseoutStop = runHook(stopHook, incompleteCloseoutRoot, { stop_hook_active: false });
assert.equal(incompleteCloseoutStop.decision, 'block');
assert.match(incompleteCloseoutStop.reason || '', /closeout is incomplete/);

const autoCloseoutRoot = makeGitProject('harness-hook-auto-closeout-');
fs.writeFileSync(path.join(autoCloseoutRoot, 'tracked.txt'), 'dirty but ready for closeout\n', 'utf8');
writeHarnessRun(autoCloseoutRoot, 'auto-closeout-run', {
  validation: false,
  status: 'guarded',
  phase: 'guard-complete'
});
writeAutoCloseoutStub(autoCloseoutRoot);
const automaticCloseoutStop = runHook(
  stopHook,
  autoCloseoutRoot,
  { stop_hook_active: false },
  { HARNESS_STOP_AUTOCLOSEOUT: 'on' }
);
assert.equal(automaticCloseoutStop.continue, true);
assert.equal(fs.existsSync(path.join(autoCloseoutRoot, '.harness', 'runs', 'auto-closeout-run', 'validation-result.json')), true);
assert.equal(fs.existsSync(path.join(autoCloseoutRoot, '.harness', 'runs', 'auto-closeout-run', 'post-validation-guard-result.json')), true);
assert.equal(fs.existsSync(path.join(autoCloseoutRoot, '.harness', 'runs', 'auto-closeout-run', 'pr-report.md')), true);
const automaticManifest = JSON.parse(fs.readFileSync(
  path.join(autoCloseoutRoot, '.harness', 'runs', 'auto-closeout-run', 'run-manifest.json'),
  'utf8'
));
assert.equal(automaticManifest.status, 'passed');
assert.equal(automaticManifest.phase, 'closeout-complete');

const validRoot = makeGitProject('harness-hook-valid-');
fs.writeFileSync(path.join(validRoot, 'tracked.txt'), 'changed before validation\n', 'utf8');
writeHarnessRun(validRoot, 'validated-run', {
  validation: true,
  status: 'passed',
  phase: 'closeout-complete'
});
const validStop = runHook(stopHook, validRoot, { stop_hook_active: false });
assert.equal(validStop.continue, true);
const allowedClosedCommit = runHook(preToolHook, validRoot, {
  tool_name: 'functions.exec_command',
  tool_input: { cmd: 'git commit -m "closed run"' }
});
assert.equal(allowedClosedCommit.hookSpecificOutput?.permissionDecision || 'allow', 'allow');

const legacyStatusRoot = makeGitProject('harness-hook-v3-status-');
fs.writeFileSync(path.join(legacyStatusRoot, 'tracked.txt'), 'legacy status must not authorize commit\n', 'utf8');
writeHarnessRun(legacyStatusRoot, 'legacy-status-run', {
  validation: true,
  validationResult: { status: 'passed-or-skipped', results: [] },
  status: 'passed',
  phase: 'closeout-complete'
});
const deniedLegacyStatusCommit = runHook(preToolHook, legacyStatusRoot, {
  tool_name: 'functions.exec_command',
  tool_input: { cmd: 'git commit -m "legacy status must be blocked"' }
});
assert.equal(deniedLegacyStatusCommit.hookSpecificOutput?.permissionDecision, 'deny');
assert.match(
  deniedLegacyStatusCommit.hookSpecificOutput?.permissionDecisionReason || '',
  /validation outcome=None/
);

removeTree(noHarnessRoot);
removeTree(plannedRoot);
removeTree(expiredRoot);
removeTree(changedCommitRoot);
removeTree(unicodeRoot);
removeTree(ambiguousRoot);
removeTree(staleRoot);
removeTree(incompleteCloseoutRoot);
removeTree(autoCloseoutRoot);
removeTree(validRoot);
removeTree(legacyStatusRoot);

console.log('HOOKS_POLICY_TEST_PASS');

function makeGitProject(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'clean\n', 'utf8');
  git(root, ['init']);
  git(root, ['config', 'user.email', 'harness@example.invalid']);
  git(root, ['config', 'user.name', 'Harness Test']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'initial']);
  return root;
}

function writeHarnessRun(root, runName, {
  validation,
  allowedFiles = ['tracked.txt'],
  allowedPathPatterns = [],
  expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  status = 'planned',
  phase = 'implementation-ready',
  validationResult = { outcome: 'PASS', results: [] }
}) {
  const runDir = path.join(root, '.harness', 'runs', runName);
  fs.mkdirSync(path.join(root, '.harness', 'state'), { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'context-pack.md'), '# Context\n', 'utf8');
  fs.writeFileSync(path.join(runDir, 'impact-report.json'), '{}\n', 'utf8');
  fs.writeFileSync(path.join(runDir, 'validation-plan.json'), '{"commands":[]}\n', 'utf8');
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  const commit = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  const taskFingerprint = 'sha256:hook-test';
  const sessionFingerprint = `sha256:${crypto.createHash('sha256').update(sessionId).digest('hex')}`;
  const workspaceDigest = `sha256:${crypto.createHash('sha256').update(`workspace:${runName}`).digest('hex')}`;
  const expiresAtMs = Date.parse(expiresAt);
  const leaseNow = expiresAtMs <= Date.now() ? expiresAtMs - 1000 : Date.now();
  const lease = acquireLease({
    stateDir: path.join(root, '.harness', 'state'),
    resourceId: `run:${runName}`,
    runId: runName,
    ownerId: sessionId,
    ttlMs: Math.max(1, expiresAtMs - leaseNow),
    now: leaseNow,
    metadata: { source: 'CODEX_THREAD_ID', purpose: 'session-binding' }
  });
  const nonceFingerprint = `sha256:${crypto.createHash('sha256').update(lease.nonce).digest('hex')}`;
  initializeRunState({
    stateDir: path.join(root, '.harness', 'state'),
    runId: runName,
    ownerFingerprint: sessionFingerprint,
    nonceFingerprint,
    workspace: { workspaceDigest },
    data: { taskFingerprint }
  });
  if (status === 'passed') {
    transitionRunState({
      stateDir: path.join(root, '.harness', 'state'),
      runId: runName,
      lifecycle: 'passed'
    });
    releaseLease({
      stateDir: path.join(root, '.harness', 'state'),
      resourceId: `run:${runName}`,
      ownerId: sessionId,
      nonce: lease.nonce,
      reason: 'fixture-closeout'
    });
  } else if (status !== 'planned') {
    transitionRunState({
      stateDir: path.join(root, '.harness', 'state'),
      runId: runName,
      lifecycle: 'running'
    });
  }
  fs.writeFileSync(path.join(runDir, 'run-manifest.json'), `${JSON.stringify({
    schemaVersion: 6,
    runId: runName,
    status,
    phase,
    task: { raw: 'hook test', fingerprint: taskFingerprint },
    repo: { branch, commit },
    binding: {
      taskFingerprint,
      sessionFingerprint,
      sessionSource: 'CODEX_THREAD_ID',
      sessionBindingRequired: true,
      leaseResourceId: `run:${runName}`,
      leaseNonceFingerprint: nonceFingerprint,
      workspaceDigest,
      branch,
      commit,
      expiresAt,
      allowedFiles,
      allowedPathPatterns
    }
  }, null, 2)}\n`, 'utf8');
  if (validation) {
    fs.writeFileSync(
      path.join(runDir, 'validation-result.json'),
      `${JSON.stringify(validationResult)}\n`,
      'utf8'
    );
    fs.writeFileSync(path.join(runDir, 'post-validation-guard-result.json'), '{"status":"passed","findings":[]}\n', 'utf8');
    fs.writeFileSync(path.join(runDir, 'pr-report.md'), '# Harness closeout report\n', 'utf8');
  }
  fs.writeFileSync(path.join(root, '.harness', 'state', 'latest-run.json'), `${JSON.stringify({
    schemaVersion: 2,
    authority: false,
    purpose: 'navigation-only',
    runId: 'attacker-controlled-navigation',
    runDir: path.join(root, '.harness', 'runs', 'attacker-controlled-navigation')
  }, null, 2)}\n`, 'utf8');
}

function writeAutoCloseoutStub(root) {
  const harnessDir = path.join(root, 'harness');
  fs.mkdirSync(harnessDir, { recursive: true });
  fs.writeFileSync(path.join(harnessDir, 'cli.mjs'), `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args[0] !== 'closeout') process.exit(2);
const runDir = args[args.indexOf('--run') + 1];
const manifestPath = path.join(runDir, 'run-manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
fs.writeFileSync(path.join(runDir, 'validation-result.json'), JSON.stringify({ outcome: 'PASS', results: [] }) + '\\n');
fs.writeFileSync(path.join(runDir, 'post-validation-guard-result.json'), JSON.stringify({ status: 'passed', findings: [] }) + '\\n');
fs.writeFileSync(path.join(runDir, 'pr-report.md'), '# Automatic closeout\\n');
manifest.status = 'passed';
manifest.phase = 'closeout-complete';
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\\n');
`, 'utf8');
}

function runHook(script, cwd, payload, envOverrides = {}) {
  const res = spawnSync('python', [script], {
    cwd,
    input: `${JSON.stringify(payload)}\n`,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      CODEX_THREAD_ID: sessionId,
      HARNESS_STOP_AUTOCLOSEOUT: 'off',
      ...envOverrides
    }
  });
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  return res.stdout.trim() ? JSON.parse(res.stdout) : {};
}

function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  return res;
}

function removeTree(target) {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const entry of fs.readdirSync(target)) removeTree(path.join(target, entry));
    fs.rmdirSync(target);
  } else {
    fs.unlinkSync(target);
  }
  assert.equal(fs.existsSync(target), false, `cleanup did not remove ${target}`);
}
