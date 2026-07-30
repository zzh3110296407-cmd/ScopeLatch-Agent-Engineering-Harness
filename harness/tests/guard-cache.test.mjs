import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readGuardedWorkingTreeSnapshot } from '../lib/guard.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-guard-cache-'));
fs.writeFileSync(path.join(root, 'tracked.txt'), 'clean\n', 'utf8');
git(['init']);
git(['config', 'user.email', 'harness@example.invalid']);
git(['config', 'user.name', 'Harness Test']);
git(['add', '.']);
git(['commit', '-m', 'initial']);
fs.writeFileSync(path.join(root, 'tracked.txt'), 'dirty\n', 'utf8');

const firstMetrics = {};
const first = readGuardedWorkingTreeSnapshot(root, { metrics: firstMetrics });
assert.equal(first.length, 1);
assert.equal(firstMetrics.misses, 1);
assert.equal(firstMetrics.hits, 0);

const secondMetrics = {};
const second = readGuardedWorkingTreeSnapshot(root, { metrics: secondMetrics });
assert.deepEqual(second, first);
assert.equal(secondMetrics.hits, 1);
assert.equal(secondMetrics.misses, 0);

fs.appendFileSync(path.join(root, 'tracked.txt'), 'changed again\n', 'utf8');
const changedMetrics = {};
const changed = readGuardedWorkingTreeSnapshot(root, { metrics: changedMetrics });
assert.equal(changedMetrics.misses, 1);
assert.notEqual(changed[0].hash, first[0].hash);

fs.writeFileSync(path.join(root, 'tracked.txt'), 'index-a\n', 'utf8');
git(['add', 'tracked.txt']);
fs.writeFileSync(path.join(root, 'tracked.txt'), 'same-worktree\n', 'utf8');
const stagedA = readGuardedWorkingTreeSnapshot(root, { cacheEnabled: false });
fs.writeFileSync(path.join(root, 'tracked.txt'), 'index-b\n', 'utf8');
git(['add', 'tracked.txt']);
fs.writeFileSync(path.join(root, 'tracked.txt'), 'same-worktree\n', 'utf8');
const stagedB = readGuardedWorkingTreeSnapshot(root, { cacheEnabled: false });
assert.equal(stagedA[0].worktreeHash, stagedB[0].worktreeHash);
assert.notEqual(stagedA[0].indexHash, stagedB[0].indexHash);
assert.notDeepEqual(stagedA, stagedB);

fs.rmSync(root, { recursive: true, force: true });
console.log('GUARD_CACHE_TEST_PASS');

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}
