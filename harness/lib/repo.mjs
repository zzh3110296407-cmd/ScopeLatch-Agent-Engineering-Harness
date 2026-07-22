import fs from 'node:fs';
import path from 'node:path';
import { exists, normalizePath, runFile, isTextLike, matchesAny } from './common.mjs';

export function findGitRoot(cwd = process.cwd()) {
  const res = runFile('git', ['rev-parse', '--show-toplevel'], { cwd, timeoutMs: 5000 });
  if (res.exitCode === 0 && res.stdout.trim()) return res.stdout.trim();
  return cwd;
}

export function gitFiles(root) {
  const tracked = runFile('git', ['ls-files', '--cached'], { cwd: root, timeoutMs: 10000 });
  if (tracked.exitCode === 0) {
    const control = runFile('git', ['ls-files', '--others', '--exclude-standard', '--', 'harness', '.harness', '.codex', 'AGENTS.md'], { cwd: root, timeoutMs: 10000 });
    const files = [
      ...tracked.stdout.split(/\r?\n/).filter(Boolean),
      ...(control.exitCode === 0 ? control.stdout.split(/\r?\n/).filter(Boolean) : [])
    ].map(normalizePath);
    if (files.length) return [...new Set(files)].sort();
  }
  return walkFiles(root).map((f) => normalizePath(path.relative(root, f)));
}

export function changedFiles(root, baseRef = null) {
  const files = [];
  const staged = runFile('git', ['diff', '--name-only', '--cached'], { cwd: root, timeoutMs: 10000 });
  const unstaged = runFile('git', ['diff', '--name-only'], { cwd: root, timeoutMs: 10000 });
  if (staged.exitCode === 0) files.push(...staged.stdout.split(/\r?\n/).filter(Boolean));
  if (unstaged.exitCode === 0) files.push(...unstaged.stdout.split(/\r?\n/).filter(Boolean));
  if (baseRef) {
    const base = runFile('git', ['diff', '--name-only', `${baseRef}...HEAD`], { cwd: root, timeoutMs: 10000 });
    if (base.exitCode === 0) files.push(...base.stdout.split(/\r?\n/).filter(Boolean));
  }
  return [...new Set(files.map(normalizePath))];
}

export function currentBranch(root) {
  const res = runFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, timeoutMs: 5000 });
  return res.exitCode === 0 ? res.stdout.trim() : null;
}

export function readPackageJson(root) {
  const file = path.join(root, 'package.json');
  if (!exists(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export function detectPackageManager(root, configured = 'auto') {
  if (configured && configured !== 'auto') return configured;
  if (exists(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (exists(path.join(root, 'yarn.lock'))) return 'yarn';
  if (exists(path.join(root, 'bun.lockb')) || exists(path.join(root, 'bun.lock'))) return 'bun';
  if (exists(path.join(root, 'package-lock.json'))) return 'npm';
  return 'npm';
}

export function packageRunCommand(pm, script) {
  if (pm === 'pnpm') return `pnpm ${script}`;
  if (pm === 'yarn') return `yarn ${script}`;
  if (pm === 'bun') return `bun run ${script}`;
  return `npm run ${script}`;
}

export function scriptExists(pkg, script) {
  return Boolean(pkg?.scripts && Object.prototype.hasOwnProperty.call(pkg.scripts, script));
}

export function resolveScriptCommand(root, pm, pkg, configuredValue, candidates) {
  if (!configuredValue || configuredValue === 'none' || configuredValue === false) return null;
  if (configuredValue && configuredValue !== 'auto') return String(configuredValue);
  for (const script of candidates) {
    if (scriptExists(pkg, script)) return packageRunCommand(pm, script);
  }
  return null;
}

export function filterRepoFiles(files, config) {
  const exclude = config?.context?.excludePathPatterns || [];
  return files.filter((file) => !matchesAny(file, exclude));
}

export function textRepoFiles(files, config) {
  return filterRepoFiles(files, config).filter(isTextLike);
}

function walkFiles(dir, out = []) {
  const skip = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', '.turbo', '.cache']);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}
