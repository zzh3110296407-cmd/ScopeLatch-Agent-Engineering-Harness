import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const harnessDir = path.resolve(testDir, '..');
const root = path.resolve(harnessDir, '..');
const sourceFiles = [
  path.join(harnessDir, 'cli.mjs'),
  ...fs.readdirSync(path.join(harnessDir, 'lib'))
    .filter((name) => name.endsWith('.mjs'))
    .sort()
    .map((name) => path.join(harnessDir, 'lib', name))
];
const tests = fs.readdirSync(testDir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => path.join(testDir, name));

for (const file of [...sourceFiles, ...tests, fileURLToPath(import.meta.url)]) {
  execute(process.execPath, ['--check', file], `syntax ${path.relative(root, file)}`);
}
for (const file of tests) execute(process.execPath, [file], `test ${path.relative(root, file)}`);
execute('python', ['-B', '-m', 'py_compile',
  path.join(root, '.codex', 'hooks', 'pre_tool_use_policy.py'),
  path.join(root, '.codex', 'hooks', 'post_tool_use_guard.py'),
  path.join(root, '.codex', 'hooks', 'stop_guard.py')
], 'Python hook compilation');

console.log(`HARNESS_TEST_SUITE_PASS (${tests.length} tests)`);

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
