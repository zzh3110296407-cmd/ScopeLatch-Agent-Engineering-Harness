import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizePath } from '../common.mjs';
import { readGitStatusChanges } from './git-candidate.mjs';
import { digestCanonicalJson } from './canonical-json.mjs';
import { withAtomicResourceLock } from './concurrent-state.mjs';

const CONTRACT_KEYS = new Set(['args', 'executable', 'policy', 'schemaVersion']);
const POLICY_KEYS = new Set(['environment', 'network', 'resources', 'writablePaths']);
const RESOURCE_KEYS = new Set(['maxMemoryMb', 'maxOutputBytes', 'maxProcesses', 'timeoutMs']);
const NETWORK_KEYS = new Set(['allowedDestinations', 'invariantPolicyId', 'mode']);
const ENVIRONMENT_KEYS = new Set(['allow', 'values']);
const DEFAULT_POLICY = Object.freeze({
  resources: Object.freeze({
    timeoutMs: 15 * 60 * 1000,
    maxOutputBytes: 10 * 1024 * 1024,
    maxMemoryMb: 2048,
    maxProcesses: 16
  }),
  network: Object.freeze({
    mode: 'deny',
    invariantPolicyId: null,
    allowedDestinations: []
  }),
  environment: Object.freeze({
    allow: [],
    values: {}
  }),
  writablePaths: []
});
const HOST_ENV_ALLOWLIST = new Set([
  'APPDATA',
  'CI',
  'COMSPEC',
  'LANG',
  'LC_ALL',
  'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'WINDIR'
]);
const EXECUTOR_OWNED_ENV_KEYS = new Set([
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'PYTHONIOENCODING',
  'PYTHONUTF8'
]);
const EXECUTOR_GIT_CONFIG = Object.freeze([
  ['safe.directory', null],
  ['core.autocrlf', 'true'],
  ['core.safecrlf', 'false'],
  ['core.longpaths', 'true'],
  ['core.quotepath', 'false'],
  ['i18n.logOutputEncoding', 'utf-8'],
  ['i18n.commitEncoding', 'utf-8']
]);
const SECRET_KEY = /(?:api[_-]?key|authorization|bearer|credential|password|private[_-]?key|provider[_-]?secret|secret|token)/i;
const FORBIDDEN_EXECUTABLES = new Set([
  'bash', 'bash.exe', 'cmd', 'cmd.exe', 'command', 'dash', 'fish',
  'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'sh', 'sh.exe',
  'wsl', 'wsl.exe', 'zsh'
]);
const PACKAGE_MANAGER_EXECUTABLES = new Map([
  ['npm', 'npm-cli.js'],
  ['npm.cmd', 'npm-cli.js'],
  ['npx', 'npx-cli.js'],
  ['npx.cmd', 'npx-cli.js']
]);
const EXECUTOR_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..'
);

export class SafeExecutorError extends Error {
  constructor(code, message, safePath = null) {
    super(`${code}: ${message}`);
    this.name = 'SafeExecutorError';
    this.code = code;
    this.safePath = safePath;
  }
}

export function normalizeCommandContract(value) {
  if (value === null || value === undefined || value === false || value === 'none') return null;
  const raw = typeof value === 'string'
    ? legacyCommandToContract(value)
    : cloneJson(value);
  const policy = raw.policy || {};
  const normalized = {
    schemaVersion: 1,
    executable: String(raw.executable || '').trim(),
    args: Array.isArray(raw.args) ? raw.args.map((item) => String(item)) : [],
    policy: {
      resources: {
        ...DEFAULT_POLICY.resources,
        ...(policy.resources || {})
      },
      network: {
        ...DEFAULT_POLICY.network,
        ...(policy.network || {}),
        allowedDestinations: [...(policy.network?.allowedDestinations || [])]
      },
      environment: {
        ...DEFAULT_POLICY.environment,
        ...(policy.environment || {}),
        allow: [...(policy.environment?.allow || [])],
        values: { ...(policy.environment?.values || {}) }
      },
      writablePaths: [...(policy.writablePaths || [])]
    }
  };
  const validation = validateCommandContract(normalized);
  if (!validation.valid) {
    const first = validation.violations[0];
    throw new SafeExecutorError(first.code, first.message, first.safePath);
  }
  return normalized;
}

export function validateCommandContract(value) {
  const violations = [];
  if (!isRecord(value)) return invalid('SAFE_EXECUTOR_CONTRACT_NOT_OBJECT', 'command');
  rejectUnknownKeys(value, CONTRACT_KEYS, 'command', violations);
  if (value.schemaVersion !== 1) add(violations, 'SAFE_EXECUTOR_SCHEMA_UNSUPPORTED', 'command.schemaVersion', 'schemaVersion must be 1.');
  if (typeof value.executable !== 'string' || !value.executable.trim()) {
    add(violations, 'SAFE_EXECUTOR_EXECUTABLE_REQUIRED', 'command.executable', 'executable is required.');
  } else {
    const executableName = path.basename(value.executable).toLowerCase();
    if (FORBIDDEN_EXECUTABLES.has(executableName)) {
      add(violations, 'SAFE_EXECUTOR_SHELL_FORBIDDEN', 'command.executable', 'Shell interpreters are forbidden.');
    }
    if (/[\0\r\n]/.test(value.executable)) {
      add(violations, 'SAFE_EXECUTOR_EXECUTABLE_INVALID', 'command.executable', 'executable contains control characters.');
    }
  }
  if (!Array.isArray(value.args) || value.args.length > 256 || value.args.some((item) => typeof item !== 'string' || item.length > 16_384 || /[\0\r\n]/.test(item))) {
    add(violations, 'SAFE_EXECUTOR_ARGS_INVALID', 'command.args', 'args must contain at most 256 bounded strings without control characters.');
  }
  if ((value.args || []).some((item) => containsSecretShape(item))) {
    add(violations, 'SAFE_EXECUTOR_SECRET_ARGUMENT_FORBIDDEN', 'command.args', 'Secret-shaped arguments are forbidden.');
  }

  const policy = value.policy;
  if (!isRecord(policy)) {
    add(violations, 'SAFE_EXECUTOR_POLICY_REQUIRED', 'command.policy', 'policy is required.');
    return { valid: violations.length === 0, violations };
  }
  rejectUnknownKeys(policy, POLICY_KEYS, 'command.policy', violations);
  validateResources(policy.resources, violations);
  validateNetwork(policy.network, violations);
  validateEnvironment(policy.environment, violations);
  validateWritablePaths(policy.writablePaths, violations);
  return { valid: violations.length === 0, violations };
}

export function safeExecute({
  root,
  contract,
  cwd = root,
  timeoutMs = null,
  environment = {},
  protectCandidate = true
}) {
  const normalized = normalizeCommandContract(contract);
  if (!normalized) throw new SafeExecutorError('SAFE_EXECUTOR_CONTRACT_REQUIRED', 'A command contract is required.');
  const resolvedRoot = canonicalPathForComparison(root);
  const resolvedCwd = canonicalPathForComparison(cwd);
  assertInside(resolvedRoot, resolvedCwd, 'SAFE_EXECUTOR_CWD_ESCAPE', 'cwd');
  const effectiveTimeout = Math.min(
    normalized.policy.resources.timeoutMs,
    timeoutMs || normalized.policy.resources.timeoutMs
  );
  const invocation = resolveInvocation({
    root: resolvedRoot,
    executable: normalized.executable,
    args: normalized.args,
    policy: normalized.policy
  });
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-safe-exec-'));
  const env = buildMinimalEnvironment({
    root: resolvedRoot,
    invocation,
    policy: normalized.policy,
    requested: environment,
    scratchRoot
  });
  const writablePaths = normalized.policy.writablePaths.map((item) => resolveWritablePath(resolvedRoot, item));
  const before = protectCandidate ? candidateBoundarySnapshot(resolvedRoot) : null;
  const startedAt = Date.now();
  const maxOutputBytes = normalized.policy.resources.maxOutputBytes;
  let processResult;
  try {
    processResult = spawnSync(invocation.executable, invocation.args, {
      cwd: resolvedCwd,
      env,
      shell: false,
      windowsHide: true,
      timeout: effectiveTimeout,
      killSignal: 'SIGKILL',
      encoding: 'buffer',
      maxBuffer: maxOutputBytes + 1
    });
  } finally {
    removePathVerified(scratchRoot);
  }
  const durationMs = Date.now() - startedAt;
  const after = protectCandidate ? candidateBoundarySnapshot(resolvedRoot) : null;
  const changedPaths = protectCandidate ? boundaryChanges(before, after) : [];
  const forbiddenWrites = changedPaths.filter((item) => !matchesWritablePath(item, writablePaths, resolvedRoot));
  const stdoutRaw = Buffer.isBuffer(processResult.stdout) ? processResult.stdout : Buffer.from(processResult.stdout || '');
  const stderrRaw = Buffer.isBuffer(processResult.stderr) ? processResult.stderr : Buffer.from(processResult.stderr || '');
  const outputTruncated = stdoutRaw.length + stderrRaw.length > maxOutputBytes || processResult.error?.code === 'ENOBUFS';
  const stdoutBudget = Math.min(stdoutRaw.length, maxOutputBytes);
  const stderrBudget = Math.max(0, maxOutputBytes - stdoutBudget);
  const stdout = sanitizeOutput(stdoutRaw.subarray(0, stdoutBudget).toString('utf8'));
  const stderr = sanitizeOutput(stderrRaw.subarray(0, stderrBudget).toString('utf8'));
  const timedOut = processResult.error?.code === 'ETIMEDOUT';
  const boundaryViolation = forbiddenWrites.length > 0;
  const policyBlocked = /HARNESS_(?:NETWORK_DENIED|PROCESS_LIMIT_EXCEEDED|SHELL_FORBIDDEN|WRITE_BOUNDARY_DENIED)/.test(`${stdout}\n${stderr}`);
  const outcome = boundaryViolation || outputTruncated || timedOut || policyBlocked
    ? 'BLOCKED'
    : typeof processResult.status === 'number' && processResult.status === 0
      ? 'PASS'
      : processResult.error
        ? 'ERROR'
        : 'FAIL';
  return {
    schemaVersion: 1,
    contractVersion: 'harness-safe-executor-v4.0.0',
    commandContractDigest: digestCanonicalJson(normalized),
    executable: invocation.displayExecutable,
    args: redactArguments(normalized.args),
    cwd: normalizePath(path.relative(resolvedRoot, resolvedCwd) || '.'),
    shellUsed: false,
    networkPolicy: cloneJson(normalized.policy.network),
    environmentKeys: Object.keys(env).sort(),
    limits: cloneJson(normalized.policy.resources),
    enforcement: {
      timeout: 'host-process-timeout',
      output: 'bounded-buffer',
      environment: 'allowlist',
      network: invocation.networkGuard,
      memory: invocation.memoryGuard,
      processes: invocation.processGuard,
      writablePaths: protectCandidate ? 'git-candidate-boundary' : 'disabled'
    },
    formalEligible: false,
    formalIneligibilityReason: 'Host enforcement cannot prove OS-level network, memory and descendant-process isolation; H8 CI sandbox qualification is required.',
    outcome,
    exitCode: typeof processResult.status === 'number' ? processResult.status : null,
    signal: processResult.signal || null,
    durationMs,
    timedOut,
    outputTruncated,
    policyBlocked,
    boundaryViolation,
    changedPaths,
    forbiddenWrites,
    stdout,
    stderr,
    error: processResult.error ? sanitizeOutput(String(processResult.error.message || processResult.error)) : null
  };
}

export function sanitizeOutput(value) {
  let text = String(value || '');
  const patterns = [
    /\bsk-[A-Za-z0-9_-]{12,}\b/g,
    /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*\b/gi,
    /\b(?:api[_-]?key|authorization|credential|password|private[_-]?key|provider[_-]?secret|secret|token)\s*[:=]\s*[^\s,;]+/gi,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
  ];
  for (const pattern of patterns) text = text.replace(pattern, '[REDACTED]');
  return text;
}

function legacyCommandToContract(value) {
  const tokens = tokenizeLegacyCommand(String(value || '').trim());
  if (!tokens.length) throw new SafeExecutorError('SAFE_EXECUTOR_LEGACY_COMMAND_EMPTY', 'Legacy command is empty.');
  return {
    schemaVersion: 1,
    executable: tokens[0],
    args: tokens.slice(1),
    policy: cloneJson(DEFAULT_POLICY)
  };
}

function tokenizeLegacyCommand(input) {
  if (/[;&|<>`]/.test(input)) {
    throw new SafeExecutorError(
      'SAFE_EXECUTOR_LEGACY_SHELL_SYNTAX_FORBIDDEN',
      'Legacy command contains shell control syntax.'
    );
  }
  const tokens = [];
  let current = '';
  let quote = null;
  let escaped = false;
  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote === '"') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (escaped || quote) throw new SafeExecutorError('SAFE_EXECUTOR_LEGACY_QUOTING_INVALID', 'Legacy command has invalid quoting.');
  if (current) tokens.push(current);
  return tokens;
}

function resolveInvocation({ root, executable, args, policy }) {
  let resolvedExecutable = executable;
  let resolvedArgs = [...args];
  const executableName = path.basename(executable).toLowerCase();
  const packageManagerCli = PACKAGE_MANAGER_EXECUTABLES.get(executableName);
  if (packageManagerCli) {
    const cliPath = resolveNpmCli(packageManagerCli);
    if (!cliPath) {
      throw new SafeExecutorError(
        'SAFE_EXECUTOR_PACKAGE_MANAGER_UNRESOLVED',
        `Cannot resolve ${executableName} without a shell.`
      );
    }
    resolvedExecutable = process.execPath;
    resolvedArgs = [cliPath, ...resolvedArgs];
  } else if (/\.(?:cmd|bat)$/i.test(executable)) {
    throw new SafeExecutorError(
      'SAFE_EXECUTOR_BATCH_REQUIRES_SHELL',
      'Batch executables are forbidden because they require a command shell.'
    );
  }

  const finalName = path.basename(resolvedExecutable).toLowerCase();
  const isNode = finalName === 'node' || finalName === 'node.exe' || path.resolve(resolvedExecutable) === path.resolve(process.execPath);
  const isPython = /^python(?:3(?:\.\d+)?)?(?:\.exe)?$/i.test(finalName);
  let networkGuard = 'policy-only';
  let memoryGuard = 'policy-only';
  let processGuard = 'policy-only';
  if (isNode) {
    resolvedArgs = [
      `--max-old-space-size=${policy.resources.maxMemoryMb}`,
      '--require',
      path.join(EXECUTOR_ROOT, 'harness', 'executor', 'network-deny.cjs'),
      ...resolvedArgs
    ];
    networkGuard = policy.network.mode === 'deny' ? 'node-runtime-guard' : 'explicit-policy';
    memoryGuard = 'node-v8-heap-limit';
    processGuard = 'node-child-process-guard';
  } else if (isPython) {
    networkGuard = policy.network.mode === 'deny' ? 'python-sitecustomize-guard' : 'explicit-policy';
    memoryGuard = 'policy-only';
    processGuard = 'python-sitecustomize-guard';
  } else if (policy.network.mode === 'deny') {
    throw new SafeExecutorError(
      'SAFE_EXECUTOR_NETWORK_DENY_UNENFORCEABLE',
      `Network-deny enforcement is unavailable for executable ${executableName}.`
    );
  }
  return {
    executable: resolvedExecutable,
    args: resolvedArgs,
    displayExecutable: executable,
    isNode,
    isPython,
    networkGuard,
    memoryGuard,
    processGuard
  };
}

function buildMinimalEnvironment({ root, invocation, policy, requested, scratchRoot }) {
  const env = {};
  for (const key of HOST_ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  for (const key of policy.environment.allow) {
    if (SECRET_KEY.test(key)) throw new SafeExecutorError('SAFE_EXECUTOR_SECRET_ENV_FORBIDDEN', `Secret environment key ${key} is forbidden.`);
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  for (const [key, value] of Object.entries({ ...policy.environment.values, ...requested })) {
    if (isExecutorOwnedEnvironmentKey(key)) {
      throw new SafeExecutorError(
        'SAFE_EXECUTOR_GIT_ENV_RESERVED',
        `Deterministic executor environment key ${key} is owned by the safe executor.`
      );
    }
    if (SECRET_KEY.test(key) || containsSecretShape(String(value))) {
      throw new SafeExecutorError('SAFE_EXECUTOR_SECRET_ENV_FORBIDDEN', `Secret environment value ${key} is forbidden.`);
    }
    env[key] = String(value);
  }
  const emptyGitConfigPath = path.join(scratchRoot, 'gitconfig');
  fs.writeFileSync(emptyGitConfigPath, '', { encoding: 'utf8', flag: 'wx' });
  env.GIT_CONFIG_COUNT = String(EXECUTOR_GIT_CONFIG.length);
  env.GIT_CONFIG_GLOBAL = emptyGitConfigPath;
  env.GIT_CONFIG_NOSYSTEM = '1';
  EXECUTOR_GIT_CONFIG.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value === null ? root : value;
  });
  env.PYTHONIOENCODING = 'utf-8';
  env.PYTHONUTF8 = '1';
  env.HARNESS_NETWORK_MODE = policy.network.mode;
  env.HARNESS_ALLOWED_DESTINATIONS = policy.network.allowedDestinations.join(',');
  env.HARNESS_MAX_PROCESSES = String(policy.resources.maxProcesses);
  env.HARNESS_CANDIDATE_ROOT = root;
  env.HARNESS_WRITABLE_PATHS = JSON.stringify(
    policy.writablePaths.map((item) => resolveWritablePath(root, item))
  );
  env.HARNESS_SCRATCH_ROOT = scratchRoot;
  env.TEMP = scratchRoot;
  env.TMP = scratchRoot;
  env.TMPDIR = scratchRoot;
  if (invocation.isPython) {
    env.PYTHONDONTWRITEBYTECODE = '1';
    env.PYTHONPATH = path.join(EXECUTOR_ROOT, 'harness', 'executor', 'python');
  }
  return env;
}

function candidateBoundarySnapshot(root) {
  return withAtomicResourceLock({
    stateDir: path.join(root, '.harness', 'state'),
    resourceId: `safe-executor-candidate:${root}`
  }, () => {
    const entries = readGitStatusChanges(root).filter(
      (entry) => !isHarnessRuntimePath(entry.path) && !isHarnessRuntimePath(entry.oldPath)
    );
    const records = entries.map((entry) => ({
      path: entry.path,
      oldPath: entry.oldPath,
      status: entry.status,
      contentDigest: digestPath(root, entry.path)
    }));
    return new Map(records.map((entry) => [entry.path, digestCanonicalJson(entry)]));
  });
}

function isHarnessRuntimePath(value) {
  return typeof value === 'string' && (
    value === '.harness/state'
    || value.startsWith('.harness/state/')
    || value === '.harness/runs'
    || value.startsWith('.harness/runs/')
    || value === '.harness/cache'
    || value.startsWith('.harness/cache/')
  );
}

function boundaryChanges(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths]
    .filter((item) => before.get(item) !== after.get(item))
    .sort();
}

function digestPath(root, relativePath) {
  const target = path.join(root, relativePath);
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) return digestText(`symlink:${fs.readlinkSync(target)}`);
    if (!stat.isFile()) return digestText(`non-file:${stat.mode}`);
    return digestText(fs.readFileSync(target));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function resolveWritablePath(root, value) {
  const lexicalPath = path.resolve(root, value);
  assertInside(root, lexicalPath, 'SAFE_EXECUTOR_WRITABLE_PATH_ESCAPE', 'command.policy.writablePaths');
  return canonicalPathForComparison(lexicalPath);
}

function matchesWritablePath(relativePath, writablePaths, root) {
  const resolved = canonicalPathForComparison(path.resolve(root, relativePath));
  return writablePaths.some((allowed) => resolved === allowed || resolved.startsWith(`${allowed}${path.sep}`));
}

function canonicalPathForComparison(value) {
  const resolved = path.resolve(String(value));
  const suffix = [];
  let existingAncestor = resolved;
  const realpath = fs.realpathSync.native || fs.realpathSync;
  while (true) {
    try {
      const physicalAncestor = normalizeWindowsDevicePath(realpath(existingAncestor));
      return normalizeWindowsDevicePath(path.resolve(physicalAncestor, ...suffix));
    } catch (error) {
      if (!['EBADF', 'ENOENT', 'ENOTDIR'].includes(error?.code)) throw error;
    }
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) return normalizeWindowsDevicePath(resolved);
    suffix.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }
}

function normalizeWindowsDevicePath(value) {
  if (process.platform !== 'win32') return value;
  if (/^\\\\\?\\UNC\\/i.test(value)) return `\\\\${value.slice(8)}`;
  if (/^\\\\\?\\/i.test(value)) return value.slice(4);
  return value;
}

function validateResources(value, violations) {
  if (!isRecord(value)) {
    add(violations, 'SAFE_EXECUTOR_RESOURCES_REQUIRED', 'command.policy.resources', 'resources is required.');
    return;
  }
  rejectUnknownKeys(value, RESOURCE_KEYS, 'command.policy.resources', violations);
  const ranges = {
    timeoutMs: [50, 3_600_000],
    maxOutputBytes: [256, 50 * 1024 * 1024],
    maxMemoryMb: [32, 16_384],
    maxProcesses: [1, 64]
  };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max) {
      add(violations, 'SAFE_EXECUTOR_RESOURCE_LIMIT_INVALID', `command.policy.resources.${key}`, `${key} must be an integer from ${min} to ${max}.`);
    }
  }
}

function validateNetwork(value, violations) {
  if (!isRecord(value)) {
    add(violations, 'SAFE_EXECUTOR_NETWORK_POLICY_REQUIRED', 'command.policy.network', 'network policy is required.');
    return;
  }
  rejectUnknownKeys(value, NETWORK_KEYS, 'command.policy.network', violations);
  if (!['deny', 'allow'].includes(value.mode)) {
    add(violations, 'SAFE_EXECUTOR_NETWORK_MODE_INVALID', 'command.policy.network.mode', 'network mode must be deny or allow.');
  }
  if (!Array.isArray(value.allowedDestinations) || value.allowedDestinations.some((item) => typeof item !== 'string' || !item.trim())) {
    add(violations, 'SAFE_EXECUTOR_NETWORK_DESTINATIONS_INVALID', 'command.policy.network.allowedDestinations', 'allowedDestinations must be bounded strings.');
  }
  if (value.mode === 'deny' && (value.allowedDestinations || []).length) {
    add(violations, 'SAFE_EXECUTOR_NETWORK_DENY_DESTINATIONS', 'command.policy.network.allowedDestinations', 'deny mode cannot list destinations.');
  }
  if (value.mode === 'allow' && (
    typeof value.invariantPolicyId !== 'string'
    || !value.invariantPolicyId.trim()
    || !(value.allowedDestinations || []).length
  )) {
    add(violations, 'SAFE_EXECUTOR_NETWORK_ALLOW_UNBOUND', 'command.policy.network', 'allow mode requires an invariant policy ID and destinations.');
  }
}

function validateEnvironment(value, violations) {
  if (!isRecord(value)) {
    add(violations, 'SAFE_EXECUTOR_ENVIRONMENT_POLICY_REQUIRED', 'command.policy.environment', 'environment policy is required.');
    return;
  }
  rejectUnknownKeys(value, ENVIRONMENT_KEYS, 'command.policy.environment', violations);
  if (!Array.isArray(value.allow) || value.allow.some((item) => typeof item !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/i.test(item))) {
    add(violations, 'SAFE_EXECUTOR_ENV_ALLOWLIST_INVALID', 'command.policy.environment.allow', 'environment allowlist is invalid.');
  }
  for (const key of value.allow || []) {
    if (isExecutorOwnedEnvironmentKey(key)) {
      add(
        violations,
        'SAFE_EXECUTOR_GIT_ENV_RESERVED',
        'command.policy.environment.allow',
        'Deterministic executor environment configuration is owned by the safe executor.'
      );
    }
  }
  if (!isRecord(value.values) || Object.entries(value.values).some(([key, item]) => !/^[A-Z][A-Z0-9_]{0,63}$/i.test(key) || typeof item !== 'string')) {
    add(violations, 'SAFE_EXECUTOR_ENV_VALUES_INVALID', 'command.policy.environment.values', 'environment values must be a string map.');
  }
  for (const [key, item] of Object.entries(value.values || {})) {
    if (isExecutorOwnedEnvironmentKey(key)) {
      add(
        violations,
        'SAFE_EXECUTOR_GIT_ENV_RESERVED',
        `command.policy.environment.values.${key}`,
        'Deterministic executor environment configuration is owned by the safe executor.'
      );
    }
    if (SECRET_KEY.test(key) || containsSecretShape(item)) {
      add(violations, 'SAFE_EXECUTOR_SECRET_ENV_FORBIDDEN', `command.policy.environment.values.${key}`, 'Secret environment material is forbidden.');
    }
  }
}

function validateWritablePaths(value, violations) {
  if (!Array.isArray(value) || value.length > 32 || value.some((item) => typeof item !== 'string' || !item.trim() || path.isAbsolute(item) || item.includes('\0'))) {
    add(violations, 'SAFE_EXECUTOR_WRITABLE_PATHS_INVALID', 'command.policy.writablePaths', 'writablePaths must contain bounded repository-relative paths.');
  }
}

function resolveNpmCli(fileName) {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', fileName),
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', fileName)
  ].filter(Boolean);
  return candidates.find((item) => path.basename(item).toLowerCase() === fileName && fs.existsSync(item)) || null;
}

function redactArguments(args) {
  return args.map((item) => containsSecretShape(item) ? '[REDACTED]' : item);
}

function containsSecretShape(value) {
  return /\bsk-[A-Za-z0-9_-]{12,}\b/.test(value)
    || /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*\b/i.test(value)
    || /(?:api[_-]?key|authorization|credential|password|private[_-]?key|provider[_-]?secret|secret|token)\s*[:=]/i.test(value);
}

function rejectUnknownKeys(value, allowed, safePath, violations) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) add(violations, 'SAFE_EXECUTOR_UNKNOWN_FIELD', `${safePath}.${key}`, 'Unknown contract field.');
  }
}

function add(violations, code, safePath, message) {
  violations.push({ code, safePath, message });
}

function invalid(code, safePath) {
  return { valid: false, violations: [{ code, safePath, message: code }] };
}

function assertInside(root, target, code, safePath) {
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new SafeExecutorError(code, 'Path escapes the candidate root.', safePath);
  }
}

function digestText(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function isExecutorOwnedEnvironmentKey(value) {
  const key = String(value || '').toUpperCase();
  return EXECUTOR_OWNED_ENV_KEYS.has(key)
    || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key);
}

function removePathVerified(target) {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const entry of fs.readdirSync(target)) {
      removePathVerified(path.join(target, entry));
    }
    fs.rmdirSync(target);
  } else {
    try {
      fs.unlinkSync(target);
    } catch (error) {
      if (error?.code !== 'EPERM') throw error;
      fs.chmodSync(target, 0o600);
      fs.unlinkSync(target);
    }
  }
  if (fs.existsSync(target)) {
    throw new SafeExecutorError(
      'SAFE_EXECUTOR_SCRATCH_CLEANUP_INCOMPLETE',
      'Scratch data could not be removed durably.'
    );
  }
}
