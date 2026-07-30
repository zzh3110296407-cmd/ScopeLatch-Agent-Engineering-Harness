import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const harnessDir = path.resolve(testDir, '..');
const root = path.resolve(harnessDir, '..');
const profile = readProfile(process.argv.slice(2));
const allTests = fs.readdirSync(testDir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort();
const selectedTests = selectTests(profile, allTests);
const javascriptFiles = walkFiles(harnessDir, (file) => /\.(?:mjs|cjs)$/i.test(file));
const pythonFiles = [
  ...walkFiles(path.join(harnessDir, 'executor'), (file) => file.endsWith('.py')),
  path.join(root, '.codex', 'hooks', 'pre_tool_use_policy.py'),
  path.join(root, '.codex', 'hooks', 'post_tool_use_guard.py'),
  path.join(root, '.codex', 'hooks', 'stop_guard.py')
].filter((file) => fs.existsSync(file));

for (const file of javascriptFiles) {
  execute(process.execPath, ['--check', file], `syntax ${path.relative(root, file)}`);
}
if (pythonFiles.length) {
  execute('python', [
    '-B',
    '-c',
    "import pathlib, sys; [compile(pathlib.Path(item).read_text(encoding='utf-8'), item, 'exec') for item in sys.argv[1:]]",
    ...pythonFiles
  ], 'Python source in-memory compilation');
}

for (const name of selectedTests) {
  execute(process.execPath, [path.join(testDir, name)], `test ${path.join('harness', 'tests', name)}`);
}

const marker = profile === 'full-ci' ? 'HARNESS_TEST_SUITE_PASS' : 'HARNESS_TEST_PROFILE_PASS';
console.log(`${marker} (${profile}; ${selectedTests.length} tests)`);

function readProfile(argv) {
  const index = argv.indexOf('--profile');
  const value = index >= 0 ? argv[index + 1] : 'full-ci';
  const allowed = new Set(['syntax', 'unit', 'contract', 'integration', 'e2e', 'build', 'full-ci']);
  if (!allowed.has(value)) {
    console.error(`HARNESS_TEST_PROFILE_UNKNOWN: ${value || '<missing>'}`);
    process.exit(2);
  }
  return value;
}

function selectTests(selectedProfile, tests) {
  if (selectedProfile === 'syntax') return [];
  if (selectedProfile === 'full-ci') return tests;
  // The Harness binds every impacted test selector to the test-unit capability.
  // Running the complete deterministic local catalog here keeps the evidence
  // truthful even when a newly added test has not yet been assigned to a
  // narrower contract, integration or e2e convenience profile.
  if (selectedProfile === 'unit') return tests;

  const groups = {
    contract: [
      'hooks-policy.test.mjs',
      'manifest.test.mjs',
      'v4-h0-contract-baseline.test.mjs',
      'v4-h1-fail-closed.test.mjs',
      'v4-h2-evidence-chain.test.mjs',
      'v4-h3-git-candidate.test.mjs',
      'v4-h4-invariant-catalog.test.mjs',
      'v4-h5-independent-auditor.test.mjs',
      'v4-h9-formal-cutover.test.mjs',
      'v4-only-cutover.test.mjs',
      'v4-trust-contract.red.mjs',
      'version.test.mjs'
    ],
    integration: [
      'closeout.test.mjs',
      'repair-loop.test.mjs',
      'run-command.test.mjs',
      'sandbox.test.mjs',
      'security-scanner.test.mjs',
      'v4-h6-concurrent-atomic-state.test.mjs',
      'v4-h7-safe-executor.test.mjs',
      'v4-h8-ci-shadow-qualification.test.mjs',
      'v4-h9-formal-cutover.test.mjs'
    ],
    e2e: [
      'codex-process-e2e.test.mjs',
      'installer.test.mjs',
      'pr10-report-ci.test.mjs'
    ],
    build: [
      'ci-workflow.test.mjs',
      'installer.test.mjs',
      'version.test.mjs',
      'v4-only-cutover.test.mjs'
    ]
  };
  const available = new Set(tests);
  return groups[selectedProfile].filter((name) => available.has(name));
}

function walkFiles(directory, predicate) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(absolute, predicate));
    else if (entry.isFile() && predicate(absolute)) files.push(absolute);
  }
  return files.sort();
}

function execute(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 20 * 1024 * 1024
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    console.error(`HARNESS_TEST_SUITE_FAIL: ${label}`);
    process.exit(result.status || 1);
  }
}
