import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const packageFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-installer-package-'));
for (const relativePath of [
  'scripts/install.mjs',
  'harness/cli.mjs',
  'harness/version.json',
  'harness/auditor',
  'harness/contracts',
  'harness/executor',
  'harness/lib',
  'harness/qualification',
  'harness/validators',
  'harness/sandbox',
  '.codex/hooks',
  '.codex/config.example.toml',
  'templates/AGENTS.harness.md',
  'templates/harness.config.json',
  'templates/harness-runtime.gitignore'
]) {
  copyPackageFixturePath(relativePath);
}
const installerPath = path.join(packageFixture, 'scripts', 'install.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-installer-'));
const sourceHooks = path.join(packageFixture, '.codex', 'hooks');
const sourceCache = path.join(sourceHooks, '__pycache__');
const sourceCacheProbe = path.join(sourceCache, 'installer-probe.pyc');
const sourceRootProbe = path.join(sourceHooks, 'installer-probe.pyo');
fs.mkdirSync(sourceCache, { recursive: true });
fs.writeFileSync(sourceCacheProbe, 'transient bytecode probe');
fs.writeFileSync(sourceRootProbe, 'transient optimized bytecode probe');
process.on('exit', cleanupPackageFixture);
fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Existing rules\n', 'utf8');

const first = spawnSync(process.execPath, [
  installerPath,
  '--target', root,
  '--enable-hooks'
], { cwd: packageFixture, encoding: 'utf8' });

assert.equal(first.status, 0, first.stderr);
assert.equal(fs.existsSync(path.join(root, 'harness', 'cli.mjs')), true);
assert.equal(fs.existsSync(path.join(root, 'harness', 'tests')), false);
assert.equal(fs.existsSync(path.join(root, 'harness', 'auditor', 'cli.mjs')), true);
assert.equal(fs.existsSync(path.join(root, 'harness', 'contracts', 'v4', 'invariant-catalog.json')), true);
assert.equal(fs.existsSync(path.join(root, 'harness', 'executor', 'network-deny.cjs')), true);
assert.equal(fs.existsSync(path.join(root, 'harness', 'qualification', 'run-shadow-pair.mjs')), true);
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
assert.match(installedVersion.stdout, /4\.0\.0/);

const installedStatus = spawnSync(process.execPath, ['harness/cli.mjs', 'status'], {
  cwd: root,
  encoding: 'utf8'
});
assert.equal(installedStatus.status, 1, installedStatus.stderr);
assert.match(installedStatus.stdout, /"canonical-source-authority"/);
assert.match(installedStatus.stdout, /Unresolved commands/);

fs.writeFileSync(path.join(root, '.harness', 'harness.config.json'), '{"preserved":true}\n', 'utf8');
const second = spawnSync(process.execPath, [
  installerPath,
  '--target', root
], { cwd: packageFixture, encoding: 'utf8' });

assert.equal(second.status, 0, second.stderr);
assert.equal(fs.readFileSync(path.join(root, '.harness', 'harness.config.json'), 'utf8'), '{"preserved":true}\n');

const linkedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-installer-linked-target-'));
const escapeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-installer-escape-'));
fs.symlinkSync(escapeRoot, path.join(linkedRoot, 'harness'), process.platform === 'win32' ? 'junction' : 'dir');
const escapedInstall = spawnSync(process.execPath, [
  installerPath,
  '--target', linkedRoot,
  '--force'
], { cwd: packageFixture, encoding: 'utf8' });
assert.notEqual(escapedInstall.status, 0);
assert.match(escapedInstall.stderr, /symbolic link or junction/);
assert.equal(fs.existsSync(path.join(escapeRoot, 'cli.mjs')), false);
fs.unlinkSync(path.join(linkedRoot, 'harness'));
fs.rmSync(linkedRoot, { recursive: true, force: true });
fs.rmSync(escapeRoot, { recursive: true, force: true });

const managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-installer-managed-agents-'));
const managedFirst = spawnSync(process.execPath, [
  installerPath,
  '--target', managedRoot
], { cwd: packageFixture, encoding: 'utf8' });
assert.equal(managedFirst.status, 0, managedFirst.stderr);
assert.equal(fs.existsSync(path.join(managedRoot, 'AGENTS.md')), true);
assert.equal(fs.existsSync(path.join(managedRoot, 'AGENTS.harness.md')), false);

const managedUpgrade = spawnSync(process.execPath, [
  installerPath,
  '--target', managedRoot,
  '--force'
], { cwd: packageFixture, encoding: 'utf8' });
assert.equal(managedUpgrade.status, 0, managedUpgrade.stderr);
assert.equal(fs.existsSync(path.join(managedRoot, 'AGENTS.md')), true);
assert.equal(fs.existsSync(path.join(managedRoot, 'AGENTS.harness.md')), false);

fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(managedRoot, { recursive: true, force: true });
cleanupPackageFixture();
console.log('INSTALLER_TEST_PASS');

function copyPackageFixturePath(relativePath) {
  const source = path.resolve(relativePath);
  const target = path.join(packageFixture, relativePath);
  copyFixtureEntry(source, target);
}

function copyFixtureEntry(source, target) {
  const metadata = fs.lstatSync(source);
  if (metadata.isSymbolicLink()) {
    throw new Error(`Installer fixture source must not contain a symbolic link or junction: ${source}`);
  }
  if (metadata.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      copyFixtureEntry(path.join(source, entry.name), path.join(target, entry.name));
    }
    return;
  }
  if (!metadata.isFile()) {
    throw new Error(`Installer fixture source must be a file or directory: ${source}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function cleanupPackageFixture() {
  cleanupSourceProbes();
  fs.rmSync(packageFixture, { recursive: true, force: true });
}

function cleanupSourceProbes() {
  fs.rmSync(sourceCacheProbe, { force: true });
  fs.rmSync(sourceRootProbe, { force: true });
  if (fs.existsSync(sourceCache) && fs.readdirSync(sourceCache).length === 0) {
    fs.rmdirSync(sourceCache);
  }
}
