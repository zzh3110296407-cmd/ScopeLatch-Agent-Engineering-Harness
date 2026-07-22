import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function nowId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function slugify(value, max = 48) {
  return String(value || 'task')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'task';
}

export function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function readText(file, fallback = '') {
  try { return fs.readFileSync(file, 'utf8'); } catch { return fallback; }
}

export function writeText(file, text) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text, 'utf8');
}

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeJson(file, data) {
  writeText(file, `${JSON.stringify(data, null, 2)}\n`);
}

export function run(command, options = {}) {
  const start = Date.now();
  const res = spawnSync(command, {
    cwd: options.cwd || process.cwd(),
    input: options.input,
    shell: true,
    encoding: 'utf8',
    timeout: options.timeoutMs || 10 * 60 * 1000,
    maxBuffer: options.maxBuffer || 20 * 1024 * 1024,
    env: { ...process.env, ...(options.env || {}) }
  });
  return {
    command,
    cwd: options.cwd || process.cwd(),
    exitCode: typeof res.status === 'number' ? res.status : 1,
    signal: res.signal || null,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    durationMs: Date.now() - start,
    error: res.error ? String(res.error.message || res.error) : null
  };
}

export function runFile(command, args = [], options = {}) {
  const start = Date.now();
  const res = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    input: options.input,
    shell: false,
    encoding: 'utf8',
    timeout: options.timeoutMs || 10 * 60 * 1000,
    maxBuffer: options.maxBuffer || 20 * 1024 * 1024,
    env: { ...process.env, ...(options.env || {}) }
  });
  return {
    command: [command, ...args].join(' '),
    cwd: options.cwd || process.cwd(),
    exitCode: typeof res.status === 'number' ? res.status : 1,
    signal: res.signal || null,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    durationMs: Date.now() - start,
    error: res.error ? String(res.error.message || res.error) : null
  };
}

export function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function truncate(text, max = 4000) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max)}\n...[truncated ${s.length - max} chars]` : s;
}

export function normalizePath(p) {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function isTextLike(file) {
  return /\.(mjs|cjs|js|jsx|ts|tsx|json|md|mdx|yml|yaml|toml|txt|css|scss|html|py|go|rs|java|kt|swift|sql|graphql|gql|proto|rb|php|sh|bash|zsh|env\.example)$/i.test(file)
    || /(^|\/)(Dockerfile|Makefile|AGENTS\.md|README|CHANGELOG|LICENSE)$/i.test(file);
}

export function globToRegExp(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '<<<GLOBSTAR>>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<<GLOBSTAR>>>/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export function matchesAny(file, patterns = []) {
  const p = normalizePath(file);
  return patterns.some((pattern) => {
    const normalized = normalizePath(pattern);
    if (normalized.includes('*')) return globToRegExp(normalized).test(p);
    return p === normalized || p.startsWith(`${normalized.replace(/\/$/, '')}/`) || p.includes(normalized);
  });
}

export function safeReadPartial(root, rel, maxBytes) {
  const file = path.join(root, rel);
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > maxBytes) return '';
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}
