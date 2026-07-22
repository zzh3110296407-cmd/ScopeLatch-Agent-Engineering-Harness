import path from 'node:path';
import { runFile } from './common.mjs';

export function runValidationCapability({ root, authority, capability, timeoutMs = 15 * 60 * 1000 }) {
  if (authority?.status && authority.status !== 'manifest-ready') {
    throw new Error(`Source authority is not ready: ${authority.status}.`);
  }
  const steps = authority?.validationProfile?.commands?.[capability];
  if (!Array.isArray(steps) || !steps.length) {
    throw new Error(`Unknown validation capability: ${capability}.`);
  }

  const results = [];
  for (const [index, step] of steps.entries()) {
    const cwd = resolveStepCwd(root, authority.root, step.cwd);
    const invocation = platformInvocation(step.command, step.args || []);
    const result = runFile(invocation.command, invocation.args, {
      cwd,
      timeoutMs: step.timeoutMs || timeoutMs,
      env: step.env || {}
    });
    results.push({
      index,
      cwd,
      command: step.command,
      args: step.args || [],
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error
    });
    if (result.exitCode !== 0) {
      return {
        schemaVersion: 1,
        capability,
        status: 'failed',
        exitCode: result.exitCode,
        steps: results
      };
    }
  }

  return {
    schemaVersion: 1,
    capability,
    status: 'passed',
    exitCode: 0,
    steps: results
  };
}

function resolveStepCwd(root, sourceRoot, cwd) {
  if (cwd === 'source') return path.resolve(root, sourceRoot);
  if (cwd === 'repo') return path.resolve(root);
  if (cwd.startsWith('repo:')) {
    const resolved = path.resolve(root, cwd.slice('repo:'.length));
    const relative = path.relative(path.resolve(root), resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Validation cwd escapes the repository: ${cwd}.`);
    }
    return resolved;
  }
  throw new Error(`Unsupported validation cwd: ${cwd}.`);
}

function platformInvocation(command, args) {
  if (process.platform !== 'win32' || !['npm', 'npx', 'pnpm', 'yarn'].includes(command)) {
    return { command, args };
  }
  const batchCommand = `${command}.cmd`;
  const commandLine = [batchCommand, ...args].map(quoteCmdArg).join(' ');
  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', commandLine]
  };
}

function quoteCmdArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:\\*-]+$/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}
