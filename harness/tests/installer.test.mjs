import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-installer-'));
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
assert.equal(fs.existsSync(path.join(root, '.codex', 'config.toml')), true);
assert.equal(fs.existsSync(path.join(root, '.harness', 'harness.config.json')), true);
assert.equal(fs.existsSync(path.join(root, 'AGENTS.harness.md')), true);
assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), '# Existing rules\n');

const installedVersion = spawnSync(process.execPath, ['harness/cli.mjs', 'version'], {
  cwd: root,
  encoding: 'utf8'
});
assert.equal(installedVersion.status, 0, installedVersion.stderr);
assert.match(installedVersion.stdout, /3\.3\.0/);

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

fs.rmSync(root, { recursive: true, force: true });
console.log('INSTALLER_TEST_PASS');
