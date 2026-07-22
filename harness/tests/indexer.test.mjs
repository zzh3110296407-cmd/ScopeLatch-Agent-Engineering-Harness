import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildHarnessIndexes, writeHarnessIndexes } from '../lib/indexer.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-indexer-'));

const files = [
  'src/index.js',
  'src/util.js',
  'tests/index.test.js',
  'docs/guide.md',
  'harness/cli.mjs',
  '.harness/runs/old/context-pack.md'
];

write('src/index.js', "import { util } from './util.js';\nconsole.log(util);\n");
write('src/util.js', 'export const util = 1;\n');
write('tests/index.test.js', "import '../src/index.js';\n");
write('docs/guide.md', '# Guide\n');
write('harness/cli.mjs', 'console.log("cli");\n');
write('.harness/runs/old/context-pack.md', '# old run\n');

const config = {
  context: {
    maxFileBytesToScan: 100000,
    excludePathPatterns: ['.harness/runs/**']
  },
  riskRules: {
    publicApiPatterns: ['**/api/**'],
    databasePatterns: ['**/models/**'],
    authPatterns: ['**/auth/**'],
    paymentPatterns: ['**/payment/**'],
    sharedPatterns: ['**/utils/**'],
    buildSystemPatterns: ['harness/**']
  },
  sourceAuthority: { schemaVersion: 1, status: 'not-found', root: null, candidates: [] }
};

const indexes = buildHarnessIndexes({
  root,
  files,
  config,
  generatedAt: '2026-07-06T00:00:00.000Z'
});

assert.equal(indexes.repoIndex.schemaVersion, 1);
assert.equal(indexes.repoIndex.fileCount, 5);
assert.equal(indexes.repoIndex.files.some((file) => file.path.includes('.harness/runs')), false);
assert.deepEqual(indexes.repoIndex.files.find((file) => file.path === 'harness/cli.mjs').riskCategories, ['buildSystem']);

assert.deepEqual(indexes.importGraph.imports['src/index.js'], ['src/util.js']);
assert.deepEqual(indexes.importGraph.importedBy['src/util.js'], ['src/index.js']);

assert.equal(indexes.testIndex.testCount, 1);
assert.equal(indexes.testIndex.tests[0].path, 'tests/index.test.js');
assert.deepEqual(indexes.testIndex.tests[0].targetHints, ['index']);

assert.equal(indexes.ownershipIndex.owners.some((owner) => owner.owner === 'harness-control'), true);

const written = writeHarnessIndexes({ root, indexes });
assert.equal(written.length, 5);
for (const file of written) assert.equal(fs.existsSync(file), true);
assert.equal(fs.existsSync(path.join(root, '.harness', 'cache', 'index', 'repo-index.json')), true);
assert.equal(fs.existsSync(path.join(root, '.harness', 'cache', 'index', 'source-authority.json')), true);

fs.rmSync(root, { recursive: true, force: true });

console.log('INDEXER_TEST_PASS');

function write(rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}
