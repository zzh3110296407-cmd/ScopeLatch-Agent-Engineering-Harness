'use strict';

const childProcess = require('node:child_process');
const dgram = require('node:dgram');
const dns = require('node:dns');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const tls = require('node:tls');
const rawLstatSync = fs.lstatSync.bind(fs);
const rawReadlinkSync = fs.readlinkSync.bind(fs);
const rawRealpathSync = (fs.realpathSync.native || fs.realpathSync).bind(fs);

const networkMode = process.env.HARNESS_NETWORK_MODE || 'deny';
const maxProcesses = boundedInteger(process.env.HARNESS_MAX_PROCESSES, 1, 64, 16);
let activeChildren = 0;
const candidateRoot = canonicalPathForComparison(process.env.HARNESS_CANDIDATE_ROOT || process.cwd());
const scratchBoundary = process.env.HARNESS_SCRATCH_ROOT
  ? createPathBoundary(process.env.HARNESS_SCRATCH_ROOT)
  : null;
const writablePaths = parseWritablePaths(process.env.HARNESS_WRITABLE_PATHS);

if (networkMode === 'deny') {
  const denyNetwork = () => {
    const error = new Error('HARNESS_NETWORK_DENIED: network access is disabled for this validation.');
    error.code = 'HARNESS_NETWORK_DENIED';
    throw error;
  };
  net.connect = denyNetwork;
  net.createConnection = denyNetwork;
  net.Socket.prototype.connect = denyNetwork;
  tls.connect = denyNetwork;
  dns.lookup = denyNetwork;
  dns.resolve = denyNetwork;
  dns.resolve4 = denyNetwork;
  dns.resolve6 = denyNetwork;
  dgram.createSocket = denyNetwork;
}

childProcess.exec = function guardedShellChildProcess(command, ...args) {
  const callback = [...args].reverse().find((value) => typeof value === 'function');
  if (String(command).trim().toLowerCase() === 'net use' && callback) {
    const error = new Error('HARNESS_SAFE_PROBE_SUPPRESSED: Windows network-map discovery is disabled.');
    error.code = 'HARNESS_SAFE_PROBE_SUPPRESSED';
    queueMicrotask(() => callback(error, '', ''));
    return {};
  }
  const error = new Error('HARNESS_SHELL_FORBIDDEN: child shell execution is disabled.');
  error.code = 'HARNESS_SHELL_FORBIDDEN';
  throw error;
};

childProcess.execSync = function forbiddenSynchronousShellChildProcess() {
  const error = new Error('HARNESS_SHELL_FORBIDDEN: child shell execution is disabled.');
  error.code = 'HARNESS_SHELL_FORBIDDEN';
  throw error;
};

for (const method of ['spawnSync', 'execFileSync']) {
  const original = childProcess[method];
  childProcess[method] = function guardedSynchronousChildProcess(...rawArgs) {
    const args = guardChildInvocation(method, rawArgs);
    acquireProcessSlot();
    try {
      return original.apply(this, args);
    } finally {
      activeChildren -= 1;
    }
  };
}

for (const method of ['spawn', 'execFile', 'fork']) {
  const original = childProcess[method];
  childProcess[method] = function guardedAsynchronousChildProcess(...rawArgs) {
    const args = guardChildInvocation(method, rawArgs);
    acquireProcessSlot();
    let child;
    try {
      child = original.apply(this, args);
    } catch (error) {
      activeChildren -= 1;
      throw error;
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeChildren = Math.max(0, activeChildren - 1);
    };
    child.once('exit', release);
    child.once('error', release);
    return child;
  };
}

guardFilesystem();

function boundedInteger(raw, min, max, fallback) {
  const parsed = Number.parseInt(raw || '', 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function acquireProcessSlot() {
  if (activeChildren + 1 >= maxProcesses) {
    const error = new Error(`HARNESS_PROCESS_LIMIT_EXCEEDED: maximum concurrent process count is ${maxProcesses}.`);
    error.code = 'HARNESS_PROCESS_LIMIT_EXCEEDED';
    throw error;
  }
  activeChildren += 1;
}

function guardChildInvocation(method, rawArgs) {
  const args = [...rawArgs];
  const optionsIndex = method === 'fork'
    ? 2
    : method.startsWith('execFile')
      ? 2
      : 2;
  const options = args[optionsIndex];
  if (options && typeof options === 'object' && options.shell) {
    const error = new Error('HARNESS_SHELL_FORBIDDEN: child shell execution is disabled.');
    error.code = 'HARNESS_SHELL_FORBIDDEN';
    throw error;
  }
  if (method === 'fork') {
    const forkOptions = options && typeof options === 'object' ? { ...options } : {};
    forkOptions.execArgv = ensureGuardRequired(forkOptions.execArgv || process.execArgv);
    args[2] = forkOptions;
    return args;
  }
  if (isNodeExecutable(args[0]) && Array.isArray(args[1])) {
    args[1] = ensureGuardRequired(args[1]);
  }
  return args;
}

function ensureGuardRequired(args) {
  const values = [...args];
  if (values.some((item) => String(item) === __filename)) return values;
  return ['--require', __filename, ...values];
}

function isNodeExecutable(value) {
  if (typeof value !== 'string') return false;
  const name = path.basename(value).toLowerCase();
  return name === 'node' || name === 'node.exe' || path.resolve(value) === path.resolve(process.execPath);
}

function guardFilesystem() {
  const rawRemoval = {
    chmodSync: fs.chmodSync.bind(fs),
    existsSync: fs.existsSync.bind(fs),
    lstatSync: fs.lstatSync.bind(fs),
    readdirSync: fs.readdirSync.bind(fs),
    rmdirSync: fs.rmdirSync.bind(fs),
    unlinkSync: fs.unlinkSync.bind(fs)
  };
  const rawCopy = {
    copyFileSync: fs.copyFileSync.bind(fs),
    lstatSync: fs.lstatSync.bind(fs),
    mkdirSync: fs.mkdirSync.bind(fs),
    readlinkSync: fs.readlinkSync.bind(fs),
    readdirSync: fs.readdirSync.bind(fs),
    symlinkSync: fs.symlinkSync.bind(fs)
  };
  const onePathMethods = [
    'appendFile', 'appendFileSync', 'chmod', 'chmodSync', 'chown', 'chownSync',
    'lchmod', 'lchmodSync', 'lchown', 'lchownSync',
    'lutimes', 'lutimesSync', 'mkdir', 'mkdirSync', 'mkdtemp', 'mkdtempSync',
    'rm', 'rmdir', 'rmdirSync',
    'truncate', 'truncateSync', 'unlink', 'unlinkSync', 'utimes',
    'utimesSync', 'writeFile', 'writeFileSync'
  ];
  for (const method of onePathMethods) {
    if (typeof fs[method] !== 'function') continue;
    const original = fs[method];
    fs[method] = function guardedFilesystemWrite(target, ...args) {
      assertWritable(target, method);
      return original.call(this, target, ...args);
    };
  }
  fs.rmSync = function guardedVerifiedRemove(target, options = {}) {
    assertWritable(target, 'rmSync');
    removePathWithRawOperations(target, {
      recursive: options?.recursive === true,
      force: options?.force === true,
      rawRemoval
    });
    if (rawRemoval.existsSync(target)) {
      const error = new Error(`HARNESS_PATH_REMOVAL_INCOMPLETE: ${safeRelative(path.resolve(String(target)))}`);
      error.code = 'HARNESS_PATH_REMOVAL_INCOMPLETE';
      throw error;
    }
  };
  fs.cpSync = function guardedVerifiedCopy(source, destination, options = {}) {
    assertWritable(destination, 'cpSyncDestination');
    copyPathWithRawOperations(source, destination, {
      recursive: options?.recursive === true,
      force: options?.force !== false,
      errorOnExist: options?.errorOnExist === true,
      rawCopy
    });
  };
  for (const method of ['copyFile', 'copyFileSync']) {
    const original = fs[method];
    fs[method] = function guardedCopyFile(source, destination, ...args) {
      assertWritable(destination, `${method}Destination`);
      return original.call(this, source, destination, ...args);
    };
  }
  for (const method of ['link', 'linkSync', 'symlink', 'symlinkSync']) {
    if (typeof fs[method] !== 'function') continue;
    const original = fs[method];
    fs[method] = function guardedLink(source, destination, ...args) {
      assertWritable(destination, `${method}Destination`);
      return original.call(this, source, destination, ...args);
    };
  }
  for (const method of ['rename', 'renameSync']) {
    if (typeof fs[method] !== 'function') continue;
    const original = fs[method];
    fs[method] = function guardedRename(source, destination, ...args) {
      assertWritable(source, `${method}Source`);
      assertWritable(destination, `${method}Destination`);
      return original.call(this, source, destination, ...args);
    };
  }
  for (const method of ['open', 'openSync']) {
    const original = fs[method];
    fs[method] = function guardedOpen(target, flags, ...args) {
      if (isWriteFlag(flags)) assertWritable(target, method);
      return original.call(this, target, flags, ...args);
    };
  }
  const originalCreateWriteStream = fs.createWriteStream;
  fs.createWriteStream = function guardedCreateWriteStream(target, ...args) {
    assertWritable(target, 'createWriteStream');
    return originalCreateWriteStream.call(this, target, ...args);
  };

  if (fs.promises) {
    for (const method of ['appendFile', 'chmod', 'chown', 'lchmod', 'lchown', 'lutimes', 'mkdir', 'mkdtemp', 'rm', 'rmdir', 'truncate', 'unlink', 'utimes', 'writeFile']) {
      if (typeof fs.promises[method] !== 'function') continue;
      const original = fs.promises[method].bind(fs.promises);
      fs.promises[method] = async function guardedPromiseWrite(target, ...args) {
        assertWritable(target, `promises${capitalize(method)}`);
        return original(target, ...args);
      };
    }
    for (const method of ['copyFile', 'link', 'symlink']) {
      if (typeof fs.promises[method] !== 'function') continue;
      const original = fs.promises[method].bind(fs.promises);
      fs.promises[method] = async function guardedPromiseTwoPath(source, destination, ...args) {
        assertWritable(destination, `promises${capitalize(method)}Destination`);
        return original(source, destination, ...args);
      };
    }
    if (typeof fs.promises.rename === 'function') {
      const originalRename = fs.promises.rename.bind(fs.promises);
      fs.promises.rename = async function guardedPromiseRename(source, destination, ...args) {
        assertWritable(source, 'promisesRenameSource');
        assertWritable(destination, 'promisesRenameDestination');
        return originalRename(source, destination, ...args);
      };
    }
    const originalOpen = fs.promises.open.bind(fs.promises);
    fs.promises.open = async function guardedPromiseOpen(target, flags, ...args) {
      if (isWriteFlag(flags)) assertWritable(target, 'promisesOpen');
      return originalOpen(target, flags, ...args);
    };
  }
}

function copyPathWithRawOperations(source, destination, {
  recursive,
  force,
  errorOnExist,
  rawCopy
}) {
  const sourceStat = rawCopy.lstatSync(source);
  if (sourceStat.isDirectory() && !sourceStat.isSymbolicLink()) {
    if (!recursive) {
      const error = new Error('ERR_FS_EISDIR: recursive option is required to copy a directory.');
      error.code = 'ERR_FS_EISDIR';
      throw error;
    }
    rawCopy.mkdirSync(destination, { recursive: true });
    for (const entry of rawCopy.readdirSync(source)) {
      copyPathWithRawOperations(path.join(source, entry), path.join(destination, entry), {
        recursive,
        force,
        errorOnExist,
        rawCopy
      });
    }
    return;
  }
  if (sourceStat.isSymbolicLink()) {
    rawCopy.symlinkSync(rawCopy.readlinkSync(source), destination);
    return;
  }
  if (!force && rawExists(destination, rawCopy)) {
    if (!errorOnExist) return;
    const error = new Error(`EEXIST: destination already exists, copy '${source}' -> '${destination}'`);
    error.code = 'EEXIST';
    throw error;
  }
  rawCopy.mkdirSync(path.dirname(destination), { recursive: true });
  rawCopy.copyFileSync(source, destination);
}

function rawExists(target, raw) {
  try {
    raw.lstatSync(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function removePathWithRawOperations(target, { recursive, force, rawRemoval }) {
  let stat;
  try {
    stat = rawRemoval.lstatSync(target);
  } catch (error) {
    if (force && error?.code === 'ENOENT') return;
    throw error;
  }
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    if (!recursive) {
      rawRemoval.rmdirSync(target);
      return;
    }
    for (const entry of rawRemoval.readdirSync(target)) {
      removePathWithRawOperations(path.join(target, entry), {
        recursive: true,
        force,
        rawRemoval
      });
    }
    rawRemoval.rmdirSync(target);
    return;
  }
  try {
    rawRemoval.unlinkSync(target);
  } catch (error) {
    if (error?.code !== 'EPERM') throw error;
    rawRemoval.chmodSync(target, 0o600);
    rawRemoval.unlinkSync(target);
  }
}

function assertWritable(target, operation = 'unknown') {
  if (typeof target === 'number') return;
  const resolved = canonicalPathForComparison(target);
  const scratchInspection = inspectPathBoundary(target, scratchBoundary);
  if (scratchInspection.allowed) return;
  if (writablePaths.some((allowed) => inspectPathBoundary(target, allowed).allowed)) return;
  const code = boundaryDenialCode(target, scratchInspection, operation);
  const error = new Error(`${code}: ${safeRelative(resolved)}`);
  error.code = code;
  throw error;
}

function isWriteFlag(flags) {
  if (typeof flags === 'number') {
    const writeMask = fs.constants.O_WRONLY
      | fs.constants.O_RDWR
      | fs.constants.O_APPEND
      | fs.constants.O_CREAT
      | fs.constants.O_TRUNC;
    return (flags & writeMask) !== 0;
  }
  return /[wax+]/.test(String(flags || 'r'));
}

function parseWritablePaths(raw) {
  try {
    const values = JSON.parse(raw || '[]');
    return Array.isArray(values) ? values.map((item) => createPathBoundary(item)) : [];
  } catch {
    return [];
  }
}

function createPathBoundary(value) {
  const lexical = normalizeWindowsDevicePath(path.resolve(String(value)));
  return {
    lexical,
    canonical: canonicalPathForComparison(lexical)
  };
}

function isWithinPathBoundary(value, boundary) {
  return inspectPathBoundary(value, boundary).allowed;
}

function inspectPathBoundary(value, boundary) {
  if (!boundary) return { allowed: false, reason: 'BOUNDARY_UNAVAILABLE' };
  const lexicalTarget = normalizeWindowsDevicePath(path.resolve(String(value)));
  const lexicalRelative = path.relative(boundary.lexical, lexicalTarget);
  if (escapesBoundary(lexicalRelative)) {
    const allowed = isWithin(canonicalPathForComparison(lexicalTarget), boundary.canonical);
    return {
      allowed,
      reason: allowed ? 'CANONICAL_ALIAS' : 'LEXICAL_OUTSIDE'
    };
  }

  // Ordinary descendants are anchored by the executor-created boundary and
  // need no physical-name comparison. Hosted Windows can expose transient
  // short/long aliases while concurrent lock files are created or removed.
  // Inspect only actual reparse links, whose destinations can escape.
  const segments = lexicalRelative.split(/[\\/]+/).filter(Boolean);
  let cursor = boundary.canonical;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    let stat;
    try {
      stat = rawLstatSync(cursor);
    } catch (error) {
      if (!['EBADF', 'ENOENT', 'ENOTDIR'].includes(error?.code)) throw error;
      return { allowed: true, reason: 'PHYSICAL_WITHIN' };
    }
    if (!stat.isSymbolicLink()) continue;

    let linkTarget;
    try {
      linkTarget = normalizeWindowsDevicePath(rawRealpathSync(cursor));
    } catch (error) {
      if (!['EBADF', 'ENOENT', 'ENOTDIR'].includes(error?.code)) throw error;
      const rawTarget = normalizeWindowsDevicePath(rawReadlinkSync(cursor));
      linkTarget = canonicalPathForComparison(
        path.isAbsolute(rawTarget)
          ? rawTarget
          : path.resolve(path.dirname(cursor), rawTarget)
      );
    }
    if (!isWithin(linkTarget, boundary.canonical)) {
      return { allowed: false, reason: 'PHYSICAL_SEGMENT_ESCAPE' };
    }
    cursor = linkTarget;
  }
  return { allowed: true, reason: 'PHYSICAL_WITHIN' };
}

function escapesBoundary(relative) {
  return relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative);
}

function canonicalPathForComparison(value) {
  const resolved = path.resolve(String(value));
  const suffix = [];
  let existingAncestor = resolved;
  while (true) {
    try {
      const physicalAncestor = normalizeWindowsDevicePath(rawRealpathSync(existingAncestor));
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

function boundaryDenialCode(target, scratchInspection, operation) {
  const lexicalTarget = normalizeWindowsDevicePath(path.resolve(String(target)));
  const lexicalScratch = process.env.HARNESS_SCRATCH_ROOT
    ? normalizeWindowsDevicePath(path.resolve(process.env.HARNESS_SCRATCH_ROOT))
    : null;
  const lexicalCandidate = normalizeWindowsDevicePath(
    path.resolve(process.env.HARNESS_CANDIDATE_ROOT || process.cwd())
  );
  if (isWithin(lexicalTarget, lexicalScratch)) {
    return [
      'HARNESS_WRITE_BOUNDARY_DENIED_SCRATCH',
      diagnosticToken(scratchInspection?.reason),
      diagnosticToken(operation)
    ].join('_');
  }
  if (isWithin(lexicalTarget, lexicalCandidate)) {
    return 'HARNESS_WRITE_BOUNDARY_DENIED_CANDIDATE_PATH_NOT_LEASED';
  }
  return 'HARNESS_WRITE_BOUNDARY_DENIED_OUTSIDE_CANDIDATE';
}

function diagnosticToken(value) {
  return String(value || 'UNKNOWN')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'UNKNOWN';
}

function capitalize(value) {
  const text = String(value || '');
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : '';
}

function isWithin(target, root) {
  if (!root) return false;
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function safeRelative(target) {
  return isWithin(target, candidateRoot)
    ? path.relative(candidateRoot, target).replaceAll('\\', '/')
    : '<outside-candidate>';
}
