import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitFiles } from '../lib/repo.mjs';
import { runFile } from '../lib/common.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-repo-'));

write('tracked.txt', 'tracked\n');
write('untracked.txt', 'untracked\n');
write('harness/lib/new-control.mjs', 'export const control = true;\n');
write('ignored.log', 'ignored\n');
write('.gitignore', '*.log\n');

assert.equal(runFile('git', ['init'], { cwd: root }).exitCode, 0);
assert.equal(runFile('git', ['add', 'tracked.txt', '.gitignore'], { cwd: root }).exitCode, 0);

const files = gitFiles(root).sort();

assert.deepEqual(files, ['.gitignore', 'harness/lib/new-control.mjs', 'tracked.txt']);

fs.rmSync(root, { recursive: true, force: true });

console.log('REPO_TEST_PASS');

function write(rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}
