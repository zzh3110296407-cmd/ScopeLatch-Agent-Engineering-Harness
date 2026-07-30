import path from 'node:path';
import { buildImportGraph } from './import-graph.mjs';
import { ensureDir, matchesAny, normalizePath, writeJson } from './common.mjs';
import { filterRepoFiles } from './repo.mjs';

const indexDir = '.harness/cache/index';

export function buildHarnessIndexes({ root, files, config, generatedAt = new Date().toISOString() }) {
  const indexedFiles = filterRepoFiles(files, config);
  const repoFiles = indexedFiles.map((file) => buildRepoFileEntry(file, config));
  const importGraph = buildSerializableImportGraph({ root, files: indexedFiles, config, generatedAt });
  const testIndex = buildTestIndex({ files: indexedFiles, generatedAt });
  const ownershipIndex = buildOwnershipIndex({ files: indexedFiles, generatedAt, config });

  return {
    repoIndex: {
      schemaVersion: 1,
      generatedAt,
      root: normalizePath(root),
      fileCount: repoFiles.length,
      files: repoFiles
    },
    importGraph,
    testIndex,
    ownershipIndex,
    sourceAuthority: {
      ...config.sourceAuthority,
      generatedAt
    }
  };
}

export function writeHarnessIndexes({ root, indexes }) {
  const dir = path.join(root, indexDir);
  ensureDir(dir);
  const outputs = [
    ['repo-index.json', indexes.repoIndex],
    ['import-graph.json', indexes.importGraph],
    ['test-index.json', indexes.testIndex],
    ['ownership-index.json', indexes.ownershipIndex],
    ['source-authority.json', indexes.sourceAuthority]
  ];
  const written = [];
  for (const [name, data] of outputs) {
    const file = path.join(dir, name);
    writeJson(file, data);
    written.push(file);
  }
  return written;
}

export function indexDirPath(root) {
  return path.join(root, indexDir);
}

function buildSerializableImportGraph({ root, files, config, generatedAt }) {
  const graph = buildImportGraph(root, files, config.context?.maxFileBytesToScan || 220000);
  const imports = mapToObject(graph.imports);
  const importedBy = mapToObject(graph.importedBy);
  const edgeCount = Object.values(imports).reduce((sum, deps) => sum + deps.length, 0);
  return {
    schemaVersion: 1,
    generatedAt,
    nodeCount: Object.keys(imports).length,
    edgeCount,
    imports,
    importedBy
  };
}

function buildTestIndex({ files, generatedAt }) {
  const tests = files.filter(isTestFile).map((file) => ({
    path: file,
    framework: inferTestFramework(file),
    targetHints: targetHintsForTest(file)
  }));
  return {
    schemaVersion: 1,
    generatedAt,
    testCount: tests.length,
    tests
  };
}

function buildOwnershipIndex({ files, generatedAt, config }) {
  const grouped = new Map();
  for (const file of files) {
    const owner = inferOwner(file, config);
    if (!grouped.has(owner)) grouped.set(owner, []);
    grouped.get(owner).push(file);
  }
  const owners = [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([owner, ownedFiles]) => ({
    owner,
    fileCount: ownedFiles.length,
    globs: ownerGlobs(owner, config),
    sampleFiles: ownedFiles.slice(0, 20)
  }));
  return {
    schemaVersion: 1,
    generatedAt,
    owners
  };
}

function buildRepoFileEntry(file, config) {
  return {
    path: file,
    language: inferLanguage(file),
    kind: inferKind(file),
    package: inferPackage(file),
    isTest: isTestFile(file),
    isGenerated: isGeneratedFile(file),
    riskCategories: riskCategories(file, config)
  };
}

function mapToObject(map) {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => [key, [...values].sort()]));
}

function inferLanguage(file) {
  const ext = path.posix.extname(normalizePath(file)).toLowerCase();
  const map = {
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.py': 'python',
    '.json': 'json',
    '.md': 'markdown',
    '.mdx': 'markdown',
    '.yml': 'yaml',
    '.yaml': 'yaml',
    '.toml': 'toml',
    '.css': 'css',
    '.scss': 'scss',
    '.html': 'html',
    '.sql': 'sql',
    '.txt': 'text'
  };
  return map[ext] || 'other';
}

function inferKind(file) {
  if (isTestFile(file)) return 'test';
  if (isGeneratedFile(file)) return 'generated';
  if (/\.(md|mdx|txt)$/i.test(file) || /(^|\/)docs?\//i.test(file)) return 'doc';
  if (/(^|\/)(harness|\.harness|\.codex)(\/|$)/i.test(file)) return 'tooling';
  if (/(package\.json|lock|config\.|\.toml$|\.ya?ml$|\.gitignore$)/i.test(file)) return 'config';
  return 'source';
}

function inferPackage(file) {
  const f = normalizePath(file);
  const phaseApp = f.match(/^Project Codes\/([^/]+)\/Codes\//);
  if (phaseApp) return `${phaseApp[1].toLowerCase().replace(/\s+/g, '-')}-app`;
  if (f.startsWith('Database/')) return 'database';
  if (f.startsWith('harness/') || f.startsWith('.harness/')) return 'harness';
  if (f.startsWith('.codex/')) return 'codex-policy';
  if (f.startsWith('Analyze Stories/')) return 'story-analyzer-reference';
  if (f.startsWith('Review story agent architecture/')) return 'architecture-docs';
  if (f.startsWith('UI Design/')) return 'ui-design';
  if (f.startsWith('Project Index/')) return 'project-index';
  return f.split('/')[0] || 'root';
}

function isTestFile(file) {
  return /(\.test\.|\.spec\.|__tests__|\/tests?\/|\/e2e\/|verify_)/i.test(file);
}

function isGeneratedFile(file) {
  return /(\.generated\.|\/generated\/|_report\.json$|evidence_index\.json$|regression_manifest\.json$|package-lock\.json$)/i.test(file);
}

function inferTestFramework(file) {
  if (/\.py$/i.test(file)) return 'python';
  if (/\.(js|jsx|mjs|cjs|ts|tsx)$/i.test(file)) return 'node';
  return 'unknown';
}

function targetHintsForTest(file) {
  const base = path.posix.basename(normalizePath(file))
    .replace(/^test_/, '')
    .replace(/^verify_/, '')
    .replace(/\.(test|spec)\.[^.]+$/i, '')
    .replace(/\.[^.]+$/, '');
  return base.split(/[_\-.]+/).filter((part) => part.length > 2).slice(0, 8);
}

function riskCategories(file, config) {
  const rules = config.riskRules || {};
  const categories = [];
  if (matchesAny(file, rules.publicApiPatterns || [])) categories.push('publicApi');
  if (matchesAny(file, rules.databasePatterns || [])) categories.push('database');
  if (matchesAny(file, rules.authPatterns || [])) categories.push('auth');
  if (matchesAny(file, rules.paymentPatterns || [])) categories.push('payment');
  if (matchesAny(file, rules.sharedPatterns || [])) categories.push('shared');
  if (matchesAny(file, rules.buildSystemPatterns || [])) categories.push('buildSystem');
  return categories;
}

function inferOwner(file, config) {
  const f = normalizePath(file);
  if (f.startsWith('harness/') || f.startsWith('.harness/') || f.startsWith('.codex/')) return 'harness-control';
  if (f.startsWith('Database/')) return 'database';
  const canonical = normalizePath(config.sourceAuthority?.root || '');
  const phase = config.sourceAuthority?.phase || 'current';
  if (canonical && f.startsWith(`${canonical}/app/backend/`)) return `phase-${phase}-backend`;
  if (canonical && f.startsWith(`${canonical}/app/frontend/`)) return `phase-${phase}-frontend`;
  if (canonical && f.startsWith(`${canonical}/`)) return `phase-${phase}-docs`;
  if (f.startsWith('Analyze Stories/')) return 'story-analyzer-reference';
  if (f.startsWith('Review story agent architecture/')) return 'architecture';
  if (f.startsWith('UI Design/')) return 'ui-design';
  if (f.startsWith('Project Index/')) return 'project-index';
  return 'project-general';
}

function ownerGlobs(owner, config) {
  const canonical = normalizePath(config.sourceAuthority?.root || '');
  const phase = config.sourceAuthority?.phase || 'current';
  const globs = {
    'harness-control': ['harness/**', '.harness/**', '.codex/**'],
    database: ['Database/**'],
    [`phase-${phase}-backend`]: canonical ? [`${canonical}/app/backend/**`] : [],
    [`phase-${phase}-frontend`]: canonical ? [`${canonical}/app/frontend/**`] : [],
    [`phase-${phase}-docs`]: canonical ? [`${canonical}/**`] : [],
    'story-analyzer-reference': ['Analyze Stories/**'],
    architecture: ['Review story agent architecture/**'],
    'ui-design': ['UI Design/**'],
    'project-index': ['Project Index/**'],
    'project-general': ['**/*']
  };
  return globs[owner] || ['**/*'];
}
