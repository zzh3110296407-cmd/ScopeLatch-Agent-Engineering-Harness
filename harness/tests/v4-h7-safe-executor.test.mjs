import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  normalizeCommandContract,
  safeExecute,
  validateCommandContract
} from '../lib/v4/safe-executor.mjs';
import { validateExecutionPlan } from '../lib/v4/outcome-engine.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDir, '..', '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v4-h7-'));
const aliasRoot = `${root}-alias`;
const escapeRoot = `${root}-escape-target`;
const networkDenySource = fs.readFileSync(
  path.join(repositoryRoot, 'harness', 'executor', 'network-deny.cjs'),
  'utf8'
);

try {
  prepareRepository();
  fs.mkdirSync(escapeRoot);
  const canonicalRoot = fs.realpathSync.native(root);
  fs.symlinkSync(root, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir');
  assert.match(networkDenySource, /const rawLstatSync = /);
  assert.match(networkDenySource, /if \(!stat\.isSymbolicLink\(\)\) continue;/);
  assert.match(networkDenySource, /const rawRealpathSync = /);
  assert.doesNotMatch(
    networkDenySource,
    /const physicalTarget = canonicalPathForComparison\(lexicalTarget\)/,
  );

  assert.throws(
    () => normalizeCommandContract('node --version; node --version'),
    (error) => error?.code === 'SAFE_EXECUTOR_LEGACY_SHELL_SYNTAX_FORBIDDEN'
  );
  assert.throws(
    () => normalizeCommandContract(contract('cmd.exe', ['/c', 'echo', 'unsafe'])),
    (error) => error?.code === 'SAFE_EXECUTOR_SHELL_FORBIDDEN'
  );
  assert.throws(
    () => normalizeCommandContract(contract('node', ['--token=secret-material'])),
    (error) => error?.code === 'SAFE_EXECUTOR_SECRET_ARGUMENT_FORBIDDEN'
  );
  assert.throws(
    () => normalizeCommandContract(contract('node', ['--version'], {
      environment: {
        values: {
          GIT_CONFIG_COUNT: '99'
        }
      }
    })),
    (error) => error?.code === 'SAFE_EXECUTOR_GIT_ENV_RESERVED'
  );
  assert.throws(
    () => normalizeCommandContract(contract('node', ['--version'], {
      network: {
        mode: 'allow',
        invariantPolicyId: null,
        allowedDestinations: ['example.invalid:443']
      }
    })),
    (error) => error?.code === 'SAFE_EXECUTOR_NETWORK_ALLOW_UNBOUND'
  );
  const explicitNetwork = normalizeCommandContract(contract('node', ['--version'], {
    network: {
      mode: 'allow',
      invariantPolicyId: 'INV_NETWORK_001',
      allowedDestinations: ['example.invalid:443']
    }
  }));
  assert.equal(validateCommandContract(explicitNetwork).valid, true);

  const clean = execute('clean.mjs');
  assert.equal(clean.outcome, 'PASS', JSON.stringify(clean));
  assert.equal(clean.shellUsed, false);
  assert.equal(clean.formalEligible, false);
  assert.match(clean.formalIneligibilityReason, /H8 CI sandbox/);

  const gitEnvironment = execute('git-environment.mjs');
  assert.equal(gitEnvironment.outcome, 'PASS', JSON.stringify(gitEnvironment));
  const gitEnvironmentPayload = JSON.parse(gitEnvironment.stdout);
  assert.equal(gitEnvironmentPayload.repositoryRoot, canonicalRoot.replaceAll('\\', '/'));
  assert.equal(gitEnvironmentPayload.status, '');
  assert.deepEqual(gitEnvironmentPayload.config, {
    count: '7',
    global: 'gitconfig',
    noSystem: '1',
    entries: [
      ['safe.directory', canonicalRoot],
      ['core.autocrlf', 'true'],
      ['core.safecrlf', 'false'],
      ['core.longpaths', 'true'],
      ['core.quotepath', 'false'],
      ['i18n.logOutputEncoding', 'utf-8'],
      ['i18n.commitEncoding', 'utf-8']
    ]
  });
  assert.equal(gitEnvironment.environmentKeys.includes('GIT_CONFIG_COUNT'), true);
  assert.equal(gitEnvironment.environmentKeys.includes('GIT_CONFIG_GLOBAL'), true);
  assert.equal(gitEnvironment.environmentKeys.includes('GIT_CONFIG_NOSYSTEM'), true);
  assert.equal(gitEnvironment.environmentKeys.includes('PYTHONUTF8'), true);
  assert.equal(gitEnvironment.environmentKeys.includes('PYTHONIOENCODING'), true);

  const aliasWrite = safeExecute({
    root: aliasRoot,
    cwd: aliasRoot,
    contract: contract('node', ['canonical-write.mjs'], {
      writablePaths: ['allowed']
    }),
    protectCandidate: true
  });
  assert.equal(aliasWrite.outcome, 'PASS', JSON.stringify(aliasWrite));
  assert.equal(aliasWrite.stdout.trim(), canonicalRoot.replaceAll('\\', '/'));
  assert.equal(fs.readFileSync(path.join(root, 'allowed', 'alias-write.txt'), 'utf8'), 'alias-safe\n');
  removeTree(path.join(root, 'allowed'));

  if (process.platform === 'win32') {
    const namespacedRoot = path.toNamespacedPath(canonicalRoot);
    const namespacedWrite = safeExecute({
      root: namespacedRoot,
      cwd: namespacedRoot,
      contract: contract('node', ['namespaced-write.mjs'], {
        writablePaths: ['allowed']
      }),
      protectCandidate: true
    });
    assert.equal(namespacedWrite.outcome, 'PASS', JSON.stringify(namespacedWrite));
    assert.equal(
      fs.readFileSync(path.join(root, 'allowed', 'namespaced-write.txt'), 'utf8'),
      'namespaced-safe\n'
    );
    removeTree(path.join(root, 'allowed'));
  }

  const pythonUtf8 = safeExecute({
    root,
    contract: contract('python', ['-B', 'python-utf8.py']),
    protectCandidate: true
  });
  assert.equal(pythonUtf8.outcome, 'PASS', JSON.stringify(pythonUtf8));
  assert.match(pythonUtf8.stdout, /UTF8_中文_PASS/);

  const verifiedRemoval = execute('verified-removal.mjs');
  assert.equal(verifiedRemoval.outcome, 'PASS', JSON.stringify(verifiedRemoval));
  assert.match(verifiedRemoval.stdout, /VERIFIED_REMOVAL_PASS/);

  const nestedScratch = execute('nested-scratch.mjs');
  assert.equal(nestedScratch.outcome, 'PASS', JSON.stringify(nestedScratch));
  assert.match(nestedScratch.stdout, /NESTED_SCRATCH_PASS/);

  const internalScratchLink = execute('scratch-internal-link.mjs');
  assert.equal(internalScratchLink.outcome, 'PASS', JSON.stringify(internalScratchLink));
  assert.match(internalScratchLink.stdout, /SCRATCH_INTERNAL_LINK_PASS/);

  const concurrentScratchChurn = execute('scratch-concurrency-churn.mjs', {
    resources: {
      timeoutMs: 30000,
      maxOutputBytes: 1024 * 1024,
      maxMemoryMb: 256,
      maxProcesses: 4
    }
  });
  assert.equal(concurrentScratchChurn.outcome, 'PASS', JSON.stringify(concurrentScratchChurn));
  assert.match(concurrentScratchChurn.stdout, /SCRATCH_CONCURRENCY_CHURN_PASS/);

  const scratchEscape = safeExecute({
    root,
    contract: contract('node', ['scratch-junction-escape.mjs', escapeRoot]),
    protectCandidate: true
  });
  assert.equal(scratchEscape.outcome, 'BLOCKED', JSON.stringify(scratchEscape));
  assert.equal(scratchEscape.policyBlocked, true);
  assert.match(
    scratchEscape.stderr,
    /HARNESS_WRITE_BOUNDARY_DENIED_SCRATCH_PHYSICAL_SEGMENT_ESCAPE_WRITE_FILE_SYNC/
  );
  assert.doesNotMatch(scratchEscape.stderr, new RegExp(escapeRegExp(escapeRoot), 'i'));
  assert.equal(fs.existsSync(path.join(escapeRoot, 'escaped.txt')), false);

  const secret = execute('secret-output.mjs');
  assert.equal(secret.outcome, 'PASS');
  assert.doesNotMatch(secret.stdout, /\bsk-[A-Za-z0-9_-]{12,}\b/);
  assert.match(secret.stdout, /\[REDACTED\]/);

  const network = execute('network.mjs');
  assert.equal(network.outcome, 'BLOCKED', JSON.stringify(network));
  assert.equal(network.policyBlocked, true);
  assert.match(network.stderr, /HARNESS_NETWORK_DENIED/);

  const runaway = execute('runaway.mjs', {
    resources: {
      timeoutMs: 100,
      maxOutputBytes: 4096,
      maxMemoryMb: 64,
      maxProcesses: 2
    }
  });
  assert.equal(runaway.outcome, 'BLOCKED', JSON.stringify(runaway));
  assert.equal(runaway.timedOut, true);

  const processLimit = execute('process-limit.mjs', {
    resources: {
      timeoutMs: 5000,
      maxOutputBytes: 16384,
      maxMemoryMb: 128,
      maxProcesses: 2
    }
  });
  assert.equal(processLimit.outcome, 'BLOCKED', JSON.stringify(processLimit));
  assert.equal(processLimit.policyBlocked, true);
  assert.match(processLimit.stderr, /HARNESS_PROCESS_LIMIT_EXCEEDED/);

  const childShell = execute('child-shell.mjs');
  assert.equal(childShell.outcome, 'BLOCKED', JSON.stringify(childShell));
  assert.equal(childShell.policyBlocked, true);
  assert.match(childShell.stderr, /HARNESS_SHELL_FORBIDDEN/);

  const safeWindowsProbe = execute('safe-windows-probe.mjs');
  assert.equal(safeWindowsProbe.outcome, 'PASS', JSON.stringify(safeWindowsProbe));
  assert.match(safeWindowsProbe.stdout, /SAFE_WINDOWS_PROBE_SUPPRESSED/);

  const candidateBefore = fs.readFileSync(path.join(root, 'candidate.txt'), 'utf8');
  const writeBoundary = execute('write-candidate.mjs');
  assert.equal(writeBoundary.outcome, 'BLOCKED', JSON.stringify(writeBoundary));
  assert.equal(writeBoundary.policyBlocked, true);
  assert.match(writeBoundary.stderr, /HARNESS_WRITE_BOUNDARY_DENIED/);
  assert.equal(fs.readFileSync(path.join(root, 'candidate.txt'), 'utf8'), candidateBefore);
  assert.deepEqual(writeBoundary.changedPaths, []);
  assert.deepEqual(writeBoundary.forbiddenWrites, []);

  const renameBoundary = execute('rename-candidate.mjs');
  assert.equal(renameBoundary.outcome, 'BLOCKED', JSON.stringify(renameBoundary));
  assert.equal(renameBoundary.policyBlocked, true);
  assert.match(renameBoundary.stderr, /HARNESS_WRITE_BOUNDARY_DENIED/);
  assert.equal(fs.readFileSync(path.join(root, 'candidate.txt'), 'utf8'), candidateBefore);

  const descendantWrite = execute('descendant-write.mjs');
  assert.equal(descendantWrite.outcome, 'BLOCKED', JSON.stringify(descendantWrite));
  assert.equal(descendantWrite.policyBlocked, true);
  assert.match(descendantWrite.stderr, /HARNESS_WRITE_BOUNDARY_DENIED/);
  assert.equal(fs.readFileSync(path.join(root, 'candidate.txt'), 'utf8'), candidateBefore);

  const python = safeExecute({
    root,
    contract: contract('python', ['-B', 'write-candidate.py']),
    protectCandidate: true
  });
  assert.equal(python.outcome, 'BLOCKED', JSON.stringify(python));
  assert.equal(python.policyBlocked, true);
  assert.match(python.stderr, /HARNESS_WRITE_BOUNDARY_DENIED/);
  assert.equal(fs.readFileSync(path.join(root, 'candidate.txt'), 'utf8'), candidateBefore);

  const pythonSocketPair = safeExecute({
    root,
    contract: contract('python', ['-B', 'python-socketpair.py']),
    protectCandidate: true
  });
  assert.equal(pythonSocketPair.outcome, 'PASS', JSON.stringify(pythonSocketPair));
  assert.match(pythonSocketPair.stdout, /SOCKETPAIR_PASS/);

  const pythonNetwork = safeExecute({
    root,
    contract: contract('python', ['-B', 'python-network.py']),
    protectCandidate: true
  });
  assert.equal(pythonNetwork.outcome, 'BLOCKED', JSON.stringify(pythonNetwork));
  assert.equal(pythonNetwork.policyBlocked, true);
  assert.match(pythonNetwork.stderr, /HARNESS_NETWORK_DENIED/);

  const oversized = execute('oversized-output.mjs', {
    resources: {
      timeoutMs: 5000,
      maxOutputBytes: 1024,
      maxMemoryMb: 128,
      maxProcesses: 2
    }
  });
  assert.equal(oversized.outcome, 'BLOCKED', JSON.stringify(oversized));
  assert.equal(oversized.outputTruncated, true);
  assert.ok(Buffer.byteLength(oversized.stdout) <= 1024);

  const invalidPlan = validateExecutionPlan({
    requiredCheckCount: 1,
    commands: [{
      id: 'unsafe',
      available: true,
      required: true,
      command: {
        schemaVersion: 1,
        executable: 'cmd.exe',
        args: ['/c', 'echo unsafe'],
        policy: completePolicy()
      }
    }],
    graph: {
      nodes: [{ id: 'unsafe', commandId: 'unsafe', kind: 'command', dependsOn: [] }]
    }
  });
  assert.equal(invalidPlan.valid, false);
  assert.equal(invalidPlan.violations.some((item) => item.code === 'SAFE_EXECUTOR_SHELL_FORBIDDEN'), true);
} finally {
  removeAlias(aliasRoot);
  removeTree(escapeRoot);
  removeTree(root);
}

const reportPath = path.join(repositoryRoot, '.harness', 'docs', 'harness-v4-h7-safe-executor-report.json');
const predecessorPath = path.join(repositoryRoot, '.harness', 'docs', 'harness-v4-h6-concurrent-atomic-state-report.json');
assert.equal(fs.existsSync(reportPath), true, 'tracked H7 report is missing');
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
assert.equal(report.schemaVersion, 1);
assert.equal(report.milestone, 'H7');
assert.equal(report.contractVersion, 'harness-trust-v4.0.0');
assert.equal(report.predecessor.milestone, 'H6');
assert.equal(report.predecessor.reportDigest, sha256File(predecessorPath));
assert.equal(report.predecessor.regressionStatus, 'PASS');
assert.equal(report.isolatedAcceptance.status, 'PASS');
assert.equal(report.isolatedAcceptance.networkUsed, false);
assert.equal(report.isolatedAcceptance.formalEligible, false);
assert.equal(report.acceptance.windows_namespaced_device_paths_share_one_physical_identity, true);
assert.equal(report.acceptance.scratch_physical_containment_is_root_anchored, true);
assert.equal(report.acceptance.scratch_junction_escapes_are_denied, true);
assert.equal(report.acceptance.scratch_denials_are_bounded_by_subcase_and_operation, true);
assert.equal(report.acceptance.scratch_concurrent_physical_checks_are_stable, true);
assert.equal(report.acceptance.scratch_internal_links_remain_inside_boundary, true);
assert.equal(report.acceptance.rename_validates_source_and_destination_write_boundaries, true);
assert.deepEqual(report.hardFailures, []);
assert.equal(report.finalMarker, 'HARNESS_V4_H7_SAFE_EXECUTOR: PASS');

const exampleConfig = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, '.harness', 'harness.config.example.json'), 'utf8')
);
for (const [commandId, command] of Object.entries(exampleConfig.commands)) {
  if (command === false) {
    continue;
  }
  assert.deepEqual(
    command.policy?.writablePaths,
    ['.harness/state/resource-locks'],
    `${commandId} must grant only the Harness resource-lock runtime path`
  );
}

const expectedHashPaths = [
  '.harness/harness.config.example.json',
  '.harness/source-authority.json',
  'harness/auditor/lib/auditor.mjs',
  'harness/executor/network-deny.cjs',
  'harness/executor/python/sitecustomize.py',
  'harness/lib/config.mjs',
  'harness/lib/repo.mjs',
  'harness/lib/source-authority.mjs',
  'harness/lib/source-validator.mjs',
  'harness/lib/validation-planner.mjs',
  'harness/lib/validator.mjs',
  'harness/lib/v4/outcome-engine.mjs',
  'harness/lib/v4/safe-executor.mjs',
  'harness/tests/closeout.test.mjs',
  'harness/tests/config-health.test.mjs',
  'harness/tests/pr10-report-ci.test.mjs',
  'harness/tests/run-all.mjs',
  'harness/tests/source-authority.test.mjs',
  'harness/tests/source-validator.test.mjs',
  'harness/tests/v4-h1-fail-closed.test.mjs',
  'harness/tests/v4-h2-evidence-chain.test.mjs',
  'harness/tests/v4-h3-git-candidate.test.mjs',
  'harness/tests/v4-h4-invariant-catalog.test.mjs',
  'harness/tests/v4-h5-independent-auditor.test.mjs',
  'harness/tests/v4-h7-safe-executor.test.mjs',
  'harness/tests/v4-trust-contract.red.mjs',
  'harness/tests/validation-graph.test.mjs'
].sort();
assert.deepEqual(Object.keys(report.sourceHashes).sort(), expectedHashPaths);
for (const relPath of expectedHashPaths) {
  assert.equal(report.sourceHashes[relPath], sha256File(path.join(repositoryRoot, relPath)), `H7 source hash mismatch: ${relPath}`);
}

console.log('HARNESS_V4_H7_SAFE_EXECUTOR: PASS');

function execute(script, policyOverrides = {}) {
  return safeExecute({
    root,
    contract: contract('node', [script], policyOverrides),
    protectCandidate: true
  });
}

function contract(executable, args, policyOverrides = {}) {
  const defaults = completePolicy();
  return {
    schemaVersion: 1,
    executable,
    args,
    policy: {
      resources: {
        ...defaults.resources,
        ...(policyOverrides.resources || {})
      },
      network: {
        ...defaults.network,
        ...(policyOverrides.network || {})
      },
      environment: {
        ...defaults.environment,
        ...(policyOverrides.environment || {}),
        allow: policyOverrides.environment?.allow || defaults.environment.allow,
        values: {
          ...defaults.environment.values,
          ...(policyOverrides.environment?.values || {})
        }
      },
      writablePaths: policyOverrides.writablePaths || defaults.writablePaths
    }
  };
}

function completePolicy() {
  return {
    resources: {
      timeoutMs: 5000,
      maxOutputBytes: 1024 * 1024,
      maxMemoryMb: 128,
      maxProcesses: 4
    },
    network: {
      mode: 'deny',
      invariantPolicyId: null,
      allowedDestinations: []
    },
    environment: {
      allow: [],
      values: {}
    },
    writablePaths: []
  };
}

function prepareRepository() {
  fs.writeFileSync(path.join(root, '.gitignore'), '.harness/\n', 'utf8');
  fs.writeFileSync(path.join(root, 'candidate.txt'), 'immutable candidate\n', 'utf8');
  fs.writeFileSync(path.join(root, 'clean.mjs'), "process.stdout.write('CLEAN_PASS');\n", 'utf8');
  fs.writeFileSync(
    path.join(root, 'canonical-write.mjs'),
    [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "const physicalRoot = fs.realpathSync.native(process.cwd());",
      "fs.mkdirSync(path.join(physicalRoot, 'allowed'), { recursive: true });",
      "fs.writeFileSync(path.join(physicalRoot, 'allowed', 'alias-write.txt'), 'alias-safe\\n', 'utf8');",
      "process.stdout.write(physicalRoot.replaceAll('\\\\', '/'));",
      ''
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(root, 'namespaced-write.mjs'),
    [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "const target = path.toNamespacedPath(path.join(process.cwd(), 'allowed', 'namespaced-write.txt'));",
      "fs.mkdirSync(path.dirname(target), { recursive: true });",
      "fs.writeFileSync(target, 'namespaced-safe\\n', 'utf8');"
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(root, 'git-environment.mjs'),
    [
      "import { spawnSync } from 'node:child_process';",
      "const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });",
      "if (result.status !== 0) { process.stderr.write(result.stderr || 'git probe failed'); process.exit(1); }",
      "const status = spawnSync('git', ['status', '--porcelain=v1'], { encoding: 'utf8' });",
      "if (status.status !== 0) { process.stderr.write(status.stderr || 'git status failed'); process.exit(1); }",
      "const count = Number(process.env.GIT_CONFIG_COUNT || 0);",
      "process.stdout.write(JSON.stringify({",
      "  repositoryRoot: result.stdout.trim().replaceAll('\\\\\\\\', '/'),",
      "  status: status.stdout.trim(),",
      "  config: {",
      "    count: String(count),",
      "    global: process.env.GIT_CONFIG_GLOBAL.split(/[\\\\/]/).at(-1),",
      "    noSystem: process.env.GIT_CONFIG_NOSYSTEM,",
      "    entries: Array.from({ length: count }, (_, index) => [",
      "      process.env[`GIT_CONFIG_KEY_${index}`],",
      "      process.env[`GIT_CONFIG_VALUE_${index}`]",
      "    ])",
      "  }",
      "}));",
      ''
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(root, 'secret-output.mjs'),
    "process.stdout.write(['sk', 'H7RuntimeSecretValue'].join('-'));\n",
    'utf8'
  );
  fs.writeFileSync(
    path.join(root, 'network.mjs'),
    "import net from 'node:net';\nnet.connect({ host: '127.0.0.1', port: 9 });\n",
    'utf8'
  );
  fs.writeFileSync(path.join(root, 'runaway.mjs'), "setInterval(() => {}, 1000);\n", 'utf8');
  fs.writeFileSync(
    path.join(root, 'process-limit.mjs'),
    [
      "import { spawn, spawnSync } from 'node:child_process';",
      "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1000)']);",
      "spawnSync(process.execPath, ['--version']);",
      ''
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(root, 'write-candidate.mjs'),
    "import fs from 'node:fs';\nfs.writeFileSync('candidate.txt', 'mutated\\n');\n",
    'utf8'
  );
  fs.writeFileSync(
    path.join(root, 'rename-candidate.mjs'),
    [
      "import fs from 'node:fs';",
      "import os from 'node:os';",
      "import path from 'node:path';",
      "fs.renameSync('candidate.txt', path.join(os.tmpdir(), 'renamed-candidate.txt'));"
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(root, 'child-shell.mjs'),
    "import { execSync } from 'node:child_process';\nexecSync('node --version');\n",
    'utf8'
  );
  fs.writeFileSync(
    path.join(root, 'safe-windows-probe.mjs'),
    [
      "import childProcess from 'node:child_process';",
      "childProcess.exec('net use', (error, stdout, stderr) => {",
      "  if (error?.code !== 'HARNESS_SAFE_PROBE_SUPPRESSED' || stdout || stderr) process.exit(1);",
      "  process.stdout.write('SAFE_WINDOWS_PROBE_SUPPRESSED');",
      "});",
      ''
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(root, 'descendant-write.mjs'),
    [
      "import { spawnSync } from 'node:child_process';",
      "const child = spawnSync(process.execPath, ['write-candidate.mjs'], { encoding: 'utf8' });",
      "process.stdout.write(child.stdout || '');",
      "process.stderr.write(child.stderr || '');",
      "process.exit(child.status || 0);",
      ''
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(root, 'write-candidate.py'),
    "from pathlib import Path\nPath('candidate.txt').write_text('mutated\\n', encoding='utf-8')\n",
    'utf8'
  );
  fs.writeFileSync(
    path.join(root, 'python-socketpair.py'),
    "import socket\nleft, right = socket.socketpair()\nleft.close()\nright.close()\nprint('SOCKETPAIR_PASS')\n",
    'utf8'
  );
  fs.writeFileSync(
    path.join(root, 'python-network.py'),
    "import socket\nsocket.socket().connect(('127.0.0.1', 9))\n",
    'utf8'
  );
  fs.writeFileSync(
    path.join(root, 'python-utf8.py'),
    "print('UTF8_中文_PASS')\n",
    'utf8'
  );
  fs.writeFileSync(
    path.join(root, 'verified-removal.mjs'),
    [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "const target = path.join(process.env.HARNESS_SCRATCH_ROOT, 'verified-removal.txt');",
      "fs.writeFileSync(target, 'remove me\\n', 'utf8');",
      "fs.rmSync(target, { force: true });",
      "if (fs.existsSync(target)) throw new Error('REMOVAL_WAS_NOT_DURABLE');",
      "process.stdout.write('VERIFIED_REMOVAL_PASS');",
      ''
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(root, 'nested-scratch.mjs'),
    [
      "import fs from 'node:fs';",
      "import os from 'node:os';",
      "import path from 'node:path';",
      "const nested = fs.mkdtempSync(path.join(os.tmpdir(), 'nested-scratch-'));",
      "fs.writeFileSync(path.join(nested, 'probe.txt'), 'safe\\n', 'utf8');",
      "fs.rmSync(nested, { recursive: true, force: true });",
      "process.stdout.write('NESTED_SCRATCH_PASS');"
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(root, 'scratch-junction-escape.mjs'),
    [
      "import fs from 'node:fs';",
      "import os from 'node:os';",
      "import path from 'node:path';",
      "const destination = process.argv[2];",
      "const link = path.join(os.tmpdir(), 'scratch-escape-link');",
      "fs.symlinkSync(destination, link, process.platform === 'win32' ? 'junction' : 'dir');",
      "fs.writeFileSync(path.join(link, 'escaped.txt'), 'forbidden\\n', 'utf8');"
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(root, 'scratch-internal-link.mjs'),
    [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "const scratch = process.env.HARNESS_SCRATCH_ROOT;",
      "const destination = path.join(scratch, 'internal-link-target');",
      "const link = path.join(scratch, 'internal-link');",
      "fs.mkdirSync(destination);",
      "fs.symlinkSync(destination, link, process.platform === 'win32' ? 'junction' : 'dir');",
      "fs.writeFileSync(path.join(link, 'inside.txt'), 'inside\\n', 'utf8');",
      "if (fs.readFileSync(path.join(destination, 'inside.txt'), 'utf8') !== 'inside\\n') process.exit(1);",
      "fs.unlinkSync(link);",
      "fs.rmSync(destination, { recursive: true, force: true });",
      "process.stdout.write('SCRATCH_INTERNAL_LINK_PASS');"
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(root, 'scratch-concurrency-churn.mjs'),
    [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "import { spawn } from 'node:child_process';",
      "const workerId = process.argv[2];",
      "const sharedRoot = path.join(process.env.HARNESS_SCRATCH_ROOT, 'physical-check-churn');",
      "if (workerId) {",
      "  for (let index = 0; index < 160; index += 1) {",
      "    const directory = path.join(sharedRoot, `worker-${workerId}-${index % 4}`);",
      "    const file = path.join(directory, `lock-${index}.tmp`);",
      "    fs.mkdirSync(directory, { recursive: true });",
      "    const handle = fs.openSync(file, 'wx', 0o600);",
      "    fs.closeSync(handle);",
      "    fs.unlinkSync(file);",
      "    fs.rmdirSync(directory);",
      "  }",
      "  process.exit(0);",
      "}",
      "fs.mkdirSync(sharedRoot, { recursive: true });",
      "const results = await Promise.all(['a', 'b'].map((id) => new Promise((resolve) => {",
      "  const child = spawn(process.execPath, [process.argv[1], id], { stdio: ['ignore', 'ignore', 'pipe'] });",
      "  let stderr = '';",
      "  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });",
      "  child.once('error', (error) => resolve({ code: 1, stderr: error.name }));",
      "  child.once('exit', (code) => resolve({ code, stderr }));",
      "})));",
      "if (results.some((item) => item.code !== 0)) {",
      "  process.stderr.write('SCRATCH_CONCURRENCY_CHURN_WORKER_FAILED');",
      "  process.exit(1);",
      "}",
      "fs.rmdirSync(sharedRoot);",
      "process.stdout.write('SCRATCH_CONCURRENCY_CHURN_PASS');"
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(root, 'oversized-output.mjs'),
    "process.stdout.write('x'.repeat(1024 * 1024));\n",
    'utf8'
  );
  git(['init']);
  git(['config', 'user.email', 'harness@example.invalid']);
  git(['config', 'user.name', 'Harness H7 Test']);
  git(['add', '.']);
  git(['commit', '-m', 'immutable fixture']);
  git(['-c', 'core.autocrlf=true', 'checkout-index', '-a', '-f']);
}

function git(args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 1024 * 1024
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function sha256File(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function removeTree(target) {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const entry of fs.readdirSync(target)) removeTree(path.join(target, entry));
    fs.rmdirSync(target);
  } else {
    fs.unlinkSync(target);
  }
  assert.equal(fs.existsSync(target), false, `cleanup did not remove ${target}`);
}

function removeAlias(target) {
  if (!fs.existsSync(target)) return;
  if (process.platform === 'win32') fs.rmdirSync(target);
  else fs.unlinkSync(target);
  assert.equal(fs.existsSync(target), false, `cleanup did not remove alias ${target}`);
}
