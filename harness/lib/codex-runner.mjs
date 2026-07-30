import { runFile } from './common.mjs';

export function resolveCodexCommand(env = process.env) {
  const jsonOverride = String(env.HARNESS_CODEX_COMMAND_JSON || '').trim();
  if (jsonOverride) {
    let parsed;
    try {
      parsed = JSON.parse(jsonOverride);
    } catch {
      throw new Error('HARNESS_CODEX_COMMAND_JSON must be a valid JSON array.');
    }
    if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 32) {
      throw new Error('HARNESS_CODEX_COMMAND_JSON must contain 1 to 32 command tokens.');
    }
    const tokens = parsed.map((token, index) => validateCommandToken(token, `HARNESS_CODEX_COMMAND_JSON[${index}]`));
    return {
      available: true,
      executable: tokens[0],
      args: tokens.slice(1),
      source: 'HARNESS_CODEX_COMMAND_JSON'
    };
  }
  const legacyOverride = String(env.HARNESS_CODEX_COMMAND || '').trim();
  if (legacyOverride) {
    return {
      available: true,
      executable: validateCommandToken(legacyOverride, 'HARNESS_CODEX_COMMAND'),
      args: [],
      source: 'HARNESS_CODEX_COMMAND'
    };
  }
  return { available: true, executable: 'codex', args: [], source: 'PATH' };
}

export function checkCodexAvailable({ root, env = process.env }) {
  const resolved = resolveCodexCommand(env);
  const result = runFile(resolved.executable, [...resolved.args, '--version'], {
    cwd: root,
    timeoutMs: 5000,
    env
  });
  return { ...resolved, exitCode: result.exitCode, error: result.error };
}

export function runCodex({ root, input, env = {}, timeoutMs = 2 * 60 * 60 * 1000 }) {
  const resolved = resolveCodexCommand({ ...process.env, ...env });
  const result = runFile(resolved.executable, [...resolved.args, 'exec', '--sandbox', 'workspace-write', '-'], {
    cwd: root,
    input,
    timeoutMs,
    maxBuffer: 40 * 1024 * 1024,
    env
  });
  return { ...result, runnerSource: resolved.source };
}

function validateCommandToken(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  const token = value.trim();
  if (!token || token.length > 4096 || /[\u0000\r\n]/.test(token)) {
    throw new Error(`${label} must be a non-empty command token of at most 4096 characters.`);
  }
  return token;
}
