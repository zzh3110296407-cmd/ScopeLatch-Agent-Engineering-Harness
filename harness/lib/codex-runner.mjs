import { run } from './common.mjs';

export function resolveCodexCommand(env = process.env) {
  const override = String(env.HARNESS_CODEX_COMMAND || '').trim();
  if (override) return { available: true, command: override, source: 'HARNESS_CODEX_COMMAND' };
  return { available: true, command: 'codex', source: 'PATH' };
}

export function checkCodexAvailable({ root, env = process.env }) {
  const resolved = resolveCodexCommand(env);
  if (resolved.source === 'HARNESS_CODEX_COMMAND') return { ...resolved, exitCode: 0 };
  const result = run(`${resolved.command} --version`, { cwd: root, timeoutMs: 5000, env });
  return { ...resolved, exitCode: result.exitCode, error: result.error };
}

export function runCodex({ root, input, env = {}, timeoutMs = 2 * 60 * 60 * 1000 }) {
  const resolved = resolveCodexCommand({ ...process.env, ...env });
  const result = run(`${resolved.command} exec --sandbox workspace-write -`, {
    cwd: root,
    input,
    timeoutMs,
    maxBuffer: 40 * 1024 * 1024,
    env
  });
  return { ...result, runnerSource: resolved.source };
}
