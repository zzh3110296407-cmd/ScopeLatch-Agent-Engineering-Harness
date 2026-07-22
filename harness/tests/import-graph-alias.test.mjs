import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildImportGraph } from '../lib/import-graph.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-import-graph-'));

const files = [
  'apps/web/src/main.ts',
  'apps/web/src/utils/math.ts',
  'apps/web/src/components/Button/index.ts',
  'packages/shared/package.json',
  'packages/shared/src/index.ts',
  'packages/shared/src/feature.ts',
  'packages/ui/package.json',
  'packages/ui/src/index.ts',
  'packages/ui/src/button.ts'
];

write('tsconfig.json', JSON.stringify({
  compilerOptions: {
    baseUrl: '.',
    paths: {
      '@web/*': ['apps/web/src/*'],
      '@shared': ['packages/shared/src/index.ts'],
      '@shared/*': ['packages/shared/src/*']
    }
  }
}, null, 2));

write('package.json', JSON.stringify({
  workspaces: ['packages/*']
}, null, 2));

write('packages/shared/package.json', JSON.stringify({
  name: '@repo/shared',
  main: './src/index.ts',
  exports: {
    '.': './src/index.ts',
    './feature': './src/feature.ts'
  }
}, null, 2));

write('packages/ui/package.json', JSON.stringify({
  name: '@repo/ui',
  exports: './src/index.ts'
}, null, 2));

write('apps/web/src/main.ts', [
  "import { add } from '@web/utils/math';",
  "import { shared } from '@shared';",
  "import { feature } from '@shared/feature';",
  "import { workspaceShared } from '@repo/shared';",
  "import { exportedFeature } from '@repo/shared/feature';",
  "import { Button } from '@repo/ui';",
  "import { LocalButton } from '@web/components/Button';"
].join('\n'));
write('apps/web/src/utils/math.ts', 'export const add = 1;\n');
write('apps/web/src/components/Button/index.ts', 'export const LocalButton = 1;\n');
write('packages/shared/src/index.ts', 'export const shared = 1; export const workspaceShared = 1;\n');
write('packages/shared/src/feature.ts', 'export const feature = 1; export const exportedFeature = 1;\n');
write('packages/ui/src/index.ts', "export { Button } from './button';\n");
write('packages/ui/src/button.ts', 'export const Button = 1;\n');

const graph = buildImportGraph(root, files, 100000);
const deps = graph.imports.get('apps/web/src/main.ts');

assert.deepEqual(deps, [
  'apps/web/src/components/Button/index.ts',
  'apps/web/src/utils/math.ts',
  'packages/shared/src/feature.ts',
  'packages/shared/src/index.ts',
  'packages/ui/src/index.ts'
]);
assert.deepEqual(graph.importedBy.get('packages/shared/src/index.ts'), ['apps/web/src/main.ts']);
assert.deepEqual(graph.importedBy.get('packages/ui/src/index.ts'), ['apps/web/src/main.ts']);
assert.deepEqual(graph.imports.get('packages/ui/src/index.ts'), ['packages/ui/src/button.ts']);

fs.rmSync(root, { recursive: true, force: true });

console.log('IMPORT_GRAPH_ALIAS_TEST_PASS');

function write(rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}
