import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-installer-'));
const sourceHooks = path.resolve('.codex', 'hooks');
const sourceCache = path.join(sourceHooks, '__pycache__');
const sourceCacheProbe = path.join(sourceCache, 'installer-probe.pyc');
const sourceRootProbe = path.join(sourceHooks, 'installer-probe.pyo');
fs.mkdirSync(sourceCache, { recursive: true });
fs.writeFileSync(sourceCacheProbe, 'transient bytecode probe');
fs.writeFileSync(sourceRootProbe, 'transient optimized bytecode probe');
process.on('exit', cleanupSourceProbes);
fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Existing rules\n', 'utf8');

const first = spawnSync(process.execPath, [
  path.resolve('scripts/install.mjs'),
  '--target', root,
  '--enable-hooks'
], { cwd: path.resolve('.'), encoding: 'utf8' });

assert.equal(first.status, 0, first.stderr);
assert.equal(fs.existsSync(path.join(root, 'harness', 'cli.mjs')), true);
assert.equal(fs.existsSync(path.join(root, 'harness', 'tests')), false);
assert.equal(fs.existsSync(path.join(root, '.codex', 'hooks', 'pre_tool_use_policy.py')), true);
assert.equal(fs.existsSync(path.join(root, '.codex', 'hooks', '__pycache__')), false);
assert.equal(fs.existsSync(path.join(root, '.codex', 'hooks', 'installer-probe.pyo')), false);
assert.equal(fs.readFileSync(path.join(root, '.codex', 'hooks', '.gitignore'), 'utf8'), '__pycache__/\n*.py[cod]\n');
assert.equal(fs.existsSync(path.join(root, '.codex', 'config.toml')), true);
assert.equal(fs.existsSync(path.join(root, '.harness', 'harness.config.json')), true);
assert.equal(fs.existsSync(path.join(root, 'AGENTS.harness.md')), true);
assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), '# Existing rules\n');
const installedPolicy = JSON.parse(fs.readFileSync(path.join(root, '.harness', 'harness.config.json'), 'utf8')).policy;
assert.equal(installedPolicy.requireExplicitWriteTargets, true);
assert.equal(installedPolicy.allowOutOfScopeOverride, false);
assert.equal(installedPolicy.autoCloseoutOnStop, true);
assert.equal(installedPolicy.autoCloseoutTimeoutSeconds, 900);
assert.match(fs.readFileSync(path.join(root, '.codex', 'config.toml'), 'utf8'), /timeout = 960/);

const compileHooks = spawnSync('python', [
  '-m', 'py_compile',
  path.join(root, '.codex', 'hooks', 'pre_tool_use_policy.py'),
  path.join(root, '.codex', 'hooks', 'post_tool_use_guard.py'),
  path.join(root, '.codex', 'hooks', 'stop_guard.py')
], { cwd: root, encoding: 'utf8' });
assert.equal(compileHooks.status, 0, compileHooks.stderr);
assert.equal(fs.existsSync(path.join(root, '.codex', 'hooks', '__pycache__')), true);

const gitInit = spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' });
assert.equal(gitInit.status, 0, gitInit.stderr);
const gitStatus = spawnSync('git', ['status', '--short', '--untracked-files=all'], {
  cwd: root,
  encoding: 'utf8'
});
assert.equal(gitStatus.status, 0, gitStatus.stderr);
assert.doesNotMatch(gitStatus.stdout, /__pycache__|\.py[co]\b/);

const installedVersion = spawnSync(process.execPath, ['harness/cli.mjs', 'version'], {
  cwd: root,
  encoding: 'utf8'
});
assert.equal(installedVersion.status, 0, installedVersion.stderr);
assert.match(installedVersion.stdout, /3\.4\.0/);

const installedStatus = spawnSync(process.execPath, ['harness/cli.mjs', 'status'], {
  cwd: root,
  encoding: 'utf8'
});
assert.equal(installedStatus.status, 1, installedStatus.stderr);
assert.match(installedStatus.stdout, /"canonical-source-authority"/);
assert.match(installedStatus.stdout, /Unresolved commands/);

fs.writeFileSync(path.join(root, '.harness', 'harness.config.json'), '{"preserved":true}\n', 'utf8');
const second = spawnSync(process.execPath, [
  path.resolve('scripts/install.mjs'),
  '--target', root
], { cwd: path.resolve('.'), encoding: 'utf8' });

assert.equal(second.status, 0, second.stderr);
assert.equal(fs.readFileSync(path.join(root, '.harness', 'harness.config.json'), 'utf8'), '{"preserved":true}\n');

const managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-installer-managed-agents-'));
const managedFirst = spawnSync(process.execPath, [
  path.resolve('scripts/install.mjs'),
  '--target', managedRoot
], { cwd: path.resolve('.'), encoding: 'utf8' });
assert.equal(managedFirst.status, 0, managedFirst.stderr);
assert.equal(fs.existsSync(path.join(managedRoot, 'AGENTS.md')), true);
assert.equal(fs.existsSync(path.join(managedRoot, 'AGENTS.harness.md')), false);

const managedUpgrade = spawnSync(process.execPath, [
  path.resolve('scripts/install.mjs'),
  '--target', managedRoot,
  '--force'
], { cwd: path.resolve('.'), encoding: 'utf8' });
assert.equal(managedUpgrade.status, 0, managedUpgrade.stderr);
assert.equal(fs.existsSync(path.join(managedRoot, 'AGENTS.md')), true);
assert.equal(fs.existsSync(path.join(managedRoot, 'AGENTS.harness.md')), false);

fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(managedRoot, { recursive: true, force: true });
cleanupSourceProbes();
console.log('INSTALLER_TEST_PASS');

function cleanupSourceProbes() {
  fs.rmSync(sourceCacheProbe, { force: true });
  fs.rmSync(sourceRootProbe, { force: true });
  if (fs.existsSync(sourceCache) && fs.readdirSync(sourceCache).length === 0) {
    fs.rmdirSync(sourceCache);
  }
}
