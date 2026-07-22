import fs from 'node:fs';
import path from 'node:path';
import { normalizePath, safeReadPartial } from './common.mjs';

const codeExts = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const importRegexes = [
  /import\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g,
  /export\s+[^'";]+?\s+from\s+['"]([^'"]+)['"]/g,
  /require\(\s*['"]([^'"]+)['"]\s*\)/g,
  /import\(\s*['"]([^'"]+)['"]\s*\)/g
];

export function buildImportGraph(root, files, maxBytes = 220000) {
  const codeFiles = files.filter((f) => codeExts.includes(path.extname(f)));
  const fileSet = new Set(codeFiles.map(normalizePath));
  const resolver = buildImportResolver(root, files, fileSet);
  const imports = new Map();
  const importedBy = new Map();

  for (const file of codeFiles) {
    const content = safeReadPartial(root, file, maxBytes);
    if (!content) continue;
    const deps = [];
    for (const re of importRegexes) {
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(content))) {
        const spec = match[1];
        if (!spec) continue;
        const resolved = resolveImport(file, spec, fileSet, resolver);
        if (resolved) deps.push(resolved);
      }
    }
    const uniqueDeps = [...new Set(deps)].sort();
    imports.set(file, uniqueDeps);
    for (const dep of uniqueDeps) {
      if (!importedBy.has(dep)) importedBy.set(dep, []);
      importedBy.get(dep).push(file);
    }
  }

  for (const [dep, importers] of importedBy.entries()) importedBy.set(dep, [...new Set(importers)].sort());
  return { imports, importedBy };
}

export function reverseDependents(importedBy, targets, depth = 2) {
  const out = new Set();
  const seen = new Set(targets);
  let frontier = [...targets];
  for (let d = 0; d < depth; d += 1) {
    const next = [];
    for (const target of frontier) {
      for (const importer of importedBy.get(target) || []) {
        if (!seen.has(importer)) {
          seen.add(importer);
          out.add(importer);
          next.push(importer);
        }
      }
    }
    frontier = next;
  }
  return [...out];
}

function resolveImport(fromFile, spec, fileSet, resolver) {
  if (spec.startsWith('.')) return resolveRelativeImport(fromFile, spec, fileSet);
  return resolveTsPathAlias(spec, fileSet, resolver.tsPathAliases)
    || resolveWorkspacePackage(spec, fileSet, resolver.packages)
    || null;
}

function resolveRelativeImport(fromFile, spec, fileSet) {
  const fromDir = path.posix.dirname(normalizePath(fromFile));
  const base = normalizePath(path.posix.normalize(path.posix.join(fromDir, spec)));
  return resolveFileCandidate(base, fileSet);
}

function resolveFileCandidate(base, fileSet) {
  const candidates = [];
  if (path.posix.extname(base)) candidates.push(base);
  for (const ext of codeExts) candidates.push(`${base}${ext}`);
  for (const ext of codeExts) candidates.push(`${base}/index${ext}`);
  return candidates.find((c) => fileSet.has(c)) || null;
}

function buildImportResolver(root, files, fileSet) {
  return {
    tsPathAliases: readTsPathAliases(root),
    packages: readWorkspacePackages(root, files, fileSet)
  };
}

function readTsPathAliases(root) {
  const aliases = [];
  for (const rel of ['tsconfig.json', 'tsconfig.base.json']) {
    const file = path.join(root, rel);
    const config = readJsonWithComments(file);
    const options = config?.compilerOptions || {};
    const baseUrl = normalizePath(path.posix.join(path.posix.dirname(rel), options.baseUrl || '.'));
    for (const [pattern, targets] of Object.entries(options.paths || {})) {
      const targetList = Array.isArray(targets) ? targets : [targets];
      aliases.push({
        pattern,
        targets: targetList.filter((target) => typeof target === 'string'),
        baseUrl
      });
    }
  }
  return aliases.sort((a, b) => aliasSpecificity(b.pattern) - aliasSpecificity(a.pattern));
}

function resolveTsPathAlias(spec, fileSet, aliases) {
  for (const alias of aliases) {
    const match = matchAliasPattern(alias.pattern, spec);
    if (!match.matched) continue;
    for (const target of alias.targets) {
      const replaced = target.includes('*') ? target.replace('*', match.capture) : target;
      const base = normalizePath(path.posix.normalize(path.posix.join(alias.baseUrl, replaced)));
      const resolved = resolveFileCandidate(base, fileSet);
      if (resolved) return resolved;
    }
  }
  return null;
}

function readWorkspacePackages(root, files, fileSet) {
  const packages = new Map();
  const packageJsonFiles = files.filter((file) => path.posix.basename(normalizePath(file)) === 'package.json');
  for (const rel of packageJsonFiles) {
    const json = readJsonWithComments(path.join(root, rel));
    if (!json?.name) continue;
    const packageDir = path.posix.dirname(normalizePath(rel));
    packages.set(json.name, {
      name: json.name,
      packageDir,
      main: json.main || json.module || json.types || null,
      exports: json.exports || null
    });
  }
  return packages;
}

function resolveWorkspacePackage(spec, fileSet, packages) {
  const pkg = findPackageForSpec(spec, packages);
  if (!pkg) return null;
  const subpath = spec === pkg.name ? '.' : `.${spec.slice(pkg.name.length)}`;
  const exported = resolvePackageExportTarget(pkg.exports, subpath);
  const candidates = [];
  if (exported) candidates.push(path.posix.join(pkg.packageDir, exported));
  if (subpath === '.' && pkg.main) candidates.push(path.posix.join(pkg.packageDir, pkg.main));
  if (subpath !== '.') candidates.push(path.posix.join(pkg.packageDir, subpath.slice(2)));
  candidates.push(path.posix.join(pkg.packageDir, 'index'));
  for (const candidate of candidates) {
    const resolved = resolveFileCandidate(normalizePath(path.posix.normalize(candidate)), fileSet);
    if (resolved) return resolved;
  }
  return null;
}

function findPackageForSpec(spec, packages) {
  const candidates = [...packages.values()]
    .filter((pkg) => spec === pkg.name || spec.startsWith(`${pkg.name}/`))
    .sort((a, b) => b.name.length - a.name.length);
  return candidates[0] || null;
}

function resolvePackageExportTarget(exportsValue, subpath) {
  if (!exportsValue) return null;
  if (typeof exportsValue === 'string') return subpath === '.' ? exportsValue : null;
  if (typeof exportsValue !== 'object') return null;
  const entry = exportsValue[subpath] || (subpath === '.' ? exportsValue['.'] : null);
  return pickExportTarget(entry);
}

function pickExportTarget(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return null;
  for (const key of ['import', 'require', 'default', 'types']) {
    const picked = pickExportTarget(value[key]);
    if (picked) return picked;
  }
  return null;
}

function matchAliasPattern(pattern, spec) {
  if (!pattern.includes('*')) return { matched: pattern === spec, capture: '' };
  const [prefix, suffix = ''] = pattern.split('*');
  if (!spec.startsWith(prefix) || !spec.endsWith(suffix)) return { matched: false, capture: '' };
  return { matched: true, capture: spec.slice(prefix.length, spec.length - suffix.length) };
}

function aliasSpecificity(pattern) {
  return pattern.replace('*', '').length;
}

function readJsonWithComments(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(stripJsonComments(raw));
  } catch {
    return null;
  }
}

function stripJsonComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}
