import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
fs.rmSync(path.join(plannedRoot, 'note.txt'));

fs.writeFileSync(path.join(plannedRoot, 'outside.txt'), 'unparsed side effect\n', 'utf8');
const deniedPostSideEffect = runHook(postToolHook, plannedRoot, {
  tool_name: 'functions.exec_command',
  tool_input: { cmd: 'custom-writer --opaque' }
});
assert.equal(deniedPostSideEffect.decision, 'block');
assert.match(deniedPostSideEffect.reason || '', /unapproved repository side effect/);
fs.rmSync(path.join(plannedRoot, 'outside.txt'));

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

const unicodeRoot = makeGitProject('harness-hook-unicode-');
fs.writeFileSync(path.join(unicodeRoot, 'tracked.txt'), 'dirty\n', 'utf8');
writeHarnessRun(unicodeRoot, '中文-run', { validation: false });
const unicodeStop = runHook(stopHook, unicodeRoot, { stop_hook_active: false });
assert.equal(unicodeStop.decision, 'block');
assert.match(unicodeStop.reason || '', /no validation result/);

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

fs.rmSync(noHarnessRoot, { recursive: true, force: true });
fs.rmSync(plannedRoot, { recursive: true, force: true });
fs.rmSync(expiredRoot, { recursive: true, force: true });
fs.rmSync(changedCommitRoot, { recursive: true, force: true });
fs.rmSync(unicodeRoot, { recursive: true, force: true });
fs.rmSync(staleRoot, { recursive: true, force: true });
fs.rmSync(incompleteCloseoutRoot, { recursive: true, force: true });
fs.rmSync(validRoot, { recursive: true, force: true });

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
  phase = 'implementation-ready'
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
  fs.writeFileSync(path.join(runDir, 'run-manifest.json'), `${JSON.stringify({
    schemaVersion: 4,
    runId: runName,
    status,
    phase,
    task: { raw: 'hook test', fingerprint: taskFingerprint },
    repo: { branch, commit },
    binding: {
      taskFingerprint,
      sessionFingerprint: `sha256:${crypto.createHash('sha256').update(sessionId).digest('hex')}`,
      sessionSource: 'CODEX_THREAD_ID',
      sessionBindingRequired: true,
      branch,
      commit,
      expiresAt,
      allowedFiles,
      allowedPathPatterns
    }
  }, null, 2)}\n`, 'utf8');
  if (validation) {
    fs.writeFileSync(path.join(runDir, 'validation-result.json'), '{"status":"passed","results":[]}\n', 'utf8');
    fs.writeFileSync(path.join(runDir, 'post-validation-guard-result.json'), '{"status":"passed","findings":[]}\n', 'utf8');
    fs.writeFileSync(path.join(runDir, 'pr-report.md'), '# Harness closeout report\n', 'utf8');
  }
  fs.writeFileSync(path.join(root, '.harness', 'state', 'latest-run.json'), `${JSON.stringify({
    task: 'hook test',
    runId: runName,
    taskFingerprint,
    runDir
  }, null, 2)}\n`, 'utf8');
}

function runHook(script, cwd, payload) {
  const res = spawnSync('python', [script], {
    cwd,
    input: `${JSON.stringify(payload)}\n`,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, CODEX_THREAD_ID: sessionId }
  });
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  return res.stdout.trim() ? JSON.parse(res.stdout) : {};
}

function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  return res;
}
