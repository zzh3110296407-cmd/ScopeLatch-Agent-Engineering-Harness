#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  printHelp();
  process.exit(0);
}

const targetArg = optionValue('--target') || args.find((value) => !value.startsWith('-'));
if (!targetArg) fail('Missing target repository. Use --target <path>.');

const requestedTargetRoot = path.resolve(targetArg);
const force = args.includes('--force');
const enableHooks = args.includes('--enable-hooks');

if (!fs.existsSync(requestedTargetRoot) || !fs.statSync(requestedTargetRoot).isDirectory()) {
  fail(`Target directory does not exist: ${requestedTargetRoot}`);
}
const targetRoot = fs.realpathSync(requestedTargetRoot);
if (samePath(targetRoot, packageRoot)) fail('Target must be a different repository.');

const results = [];
copyFile('harness/cli.mjs', 'harness/cli.mjs');
copyFile('harness/version.json', 'harness/version.json');
copyTree('harness/auditor', 'harness/auditor');
copyTree('harness/contracts', 'harness/contracts');
copyTree('harness/executor', 'harness/executor');
copyTree('harness/lib', 'harness/lib');
copyTree('harness/qualification', 'harness/qualification');
copyTree('harness/validators', 'harness/validators');
copyTree('harness/sandbox', 'harness/sandbox');
copyTree('.codex/hooks', '.codex/hooks');
copyFile('.codex/config.example.toml', '.codex/config.example.toml');
copyFile('templates/harness.config.json', '.harness/harness.config.json');
copyFile('templates/harness-runtime.gitignore', '.harness/.gitignore');

if (enableHooks) copyFile('.codex/config.example.toml', '.codex/config.toml');

const agentsFile = path.join(targetRoot, 'AGENTS.md');
const agentsTemplate = path.join(packageRoot, 'templates', 'AGENTS.harness.md');
const agentsTarget = !fs.existsSync(agentsFile)
  || fs.readFileSync(agentsFile, 'utf8') === fs.readFileSync(agentsTemplate, 'utf8')
  ? 'AGENTS.md'
  : 'AGENTS.harness.md';
copyFile('templates/AGENTS.harness.md', agentsTarget);

const installed = results.filter((item) => item.status === 'installed').length;
const skipped = results.filter((item) => item.status === 'skipped').length;
console.log(`ScopeLatch installation complete: ${installed} installed, ${skipped} preserved.`);
console.log(`Target: ${targetRoot}`);
console.log('Next: review .harness/harness.config.json, then run `node harness/cli.mjs status`.');
if (!enableHooks) {
  console.log('Hooks are staged but disabled. Review .codex/config.example.toml, then copy it to .codex/config.toml.');
}
if (agentsTarget !== 'AGENTS.md') {
  console.log('Existing AGENTS.md was preserved. Merge the rules from AGENTS.harness.md manually.');
}

function copyTree(sourceRel, targetRel) {
  const source = path.join(packageRoot, sourceRel);
  const target = path.join(targetRoot, targetRel);
  assertSafeDestination(target);
  if (fs.existsSync(target) && !force) {
    results.push({ path: targetRel, status: 'skipped' });
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  copyDirectory(source, target);
  results.push({ path: targetRel, status: 'installed' });
}

function copyDirectory(source, target) {
  assertSafeDestination(target);
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (isTransientPythonArtifact(entry)) continue;
    const sourceEntry = path.join(source, entry.name);
    const targetEntry = path.join(target, entry.name);
    if (entry.isDirectory()) copyDirectory(sourceEntry, targetEntry);
    else if (entry.isFile()) fs.copyFileSync(sourceEntry, targetEntry);
    else fail(`Unsupported filesystem entry: ${sourceEntry}`);
  }
}

function isTransientPythonArtifact(entry) {
  if (entry.isDirectory()) return entry.name === '__pycache__';
  return entry.isFile() && (entry.name.endsWith('.pyc') || entry.name.endsWith('.pyo'));
}

function copyFile(sourceRel, targetRel) {
  const source = path.join(packageRoot, sourceRel);
  const target = path.join(targetRoot, targetRel);
  assertSafeDestination(target);
  if (fs.existsSync(target) && !force) {
    results.push({ path: targetRel, status: 'skipped' });
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  results.push({ path: targetRel, status: 'installed' });
}

function assertSafeDestination(target) {
  const relative = path.relative(targetRoot, path.resolve(target));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('Installer destination escapes the target repository.');
  }
  let cursor = targetRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (!fs.existsSync(cursor)) continue;
    if (fs.lstatSync(cursor).isSymbolicLink()) {
      fail(`Installer destination contains a symbolic link or junction: ${path.relative(targetRoot, cursor)}`);
    }
  }
}

function optionValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function samePath(left, right) {
  return path.relative(left, right) === '' && path.relative(right, left) === '';
}

function fail(message) {
  console.error(`[installer] ${message}`);
  process.exit(1);
}

function printHelp() {
  console.log(`ScopeLatch Agent Engineering Harness installer

Usage:
  node scripts/install.mjs --target <repository-path> [--enable-hooks] [--force]

Options:
  --target <path>   Existing repository that will receive Harness.
  --enable-hooks    Create .codex/config.toml after copying the example.
  --force           Replace previously installed Harness files.
  --help            Show this help.

The installer copies the V4 runtime, formal contracts, Auditor, Safe Executor,
qualification tools and Codex hooks. It does not copy this package's self-tests
or CI workflows. It never deletes files. Without --force, existing destinations
are preserved.`);
}
