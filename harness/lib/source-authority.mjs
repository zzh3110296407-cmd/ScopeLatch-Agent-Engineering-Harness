import fs from 'node:fs';
import path from 'node:path';
import { normalizePath } from './common.mjs';
import { normalizeCommandContract } from './v4/safe-executor.mjs';

const DEFAULT_MANIFEST_PATH = '.harness/source-authority.json';

export function discoverSourceAuthority({
  root,
  configuredRoot = null,
  searchRoot = 'Project Codes',
  requiredMarkers = ['app/backend', 'app/frontend'],
  authorityManifestPath = DEFAULT_MANIFEST_PATH,
  requireAuthorityManifest = false
}) {
  const manifest = readAuthorityManifest(root, authorityManifestPath);
  if (manifest.exists) {
    return authorityFromManifest({ root, manifest, fallbackMarkers: requiredMarkers });
  }
  if (requireAuthorityManifest) {
    return emptyAuthority('manifest-required', searchRoot, requiredMarkers, {
      manifestPath: normalizePath(authorityManifestPath),
      errors: [`Required source authority manifest is missing: ${normalizePath(authorityManifestPath)}`]
    });
  }

  if (configuredRoot) {
    const normalized = normalizePath(configuredRoot);
    return {
      schemaVersion: 2,
      status: isValidSourceRoot(root, normalized, requiredMarkers) ? 'configured' : 'invalid-configured',
      readinessStatus: 'legacy-configured',
      root: normalized,
      phase: phaseName(normalized),
      version: parseVersion(phaseName(normalized)),
      requiredMarkers,
      readinessFiles: [],
      validationProfile: null,
      manifestPath: null,
      errors: [],
      candidates: []
    };
  }

  const base = path.join(root, searchRoot);
  if (!fs.existsSync(base)) return emptyAuthority('not-found', searchRoot, requiredMarkers);
  const candidates = fs.readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, match: entry.name.match(/^Phase\s+(\d+(?:\.\d+)*)$/i) }))
    .filter((entry) => entry.match)
    .map((entry) => {
      const phase = entry.match[1];
      const candidateRoot = normalizePath(path.join(searchRoot, entry.name, 'Codes'));
      return {
        phase,
        version: parseVersion(phase),
        root: candidateRoot,
        valid: isValidSourceRoot(root, candidateRoot, requiredMarkers)
      };
    })
    .filter((entry) => entry.valid)
    .sort((a, b) => compareVersions(b.version, a.version));
  const selected = candidates[0];
  if (!selected) return emptyAuthority('not-found', searchRoot, requiredMarkers);
  return {
    schemaVersion: 2,
    status: 'detected',
    readinessStatus: 'legacy-auto-detected',
    root: selected.root,
    phase: selected.phase,
    version: selected.version,
    requiredMarkers,
    readinessFiles: [],
    validationProfile: null,
    manifestPath: null,
    errors: [],
    candidates: candidates.map(({ valid, ...entry }) => entry)
  };
}

export function interpolateCanonicalSource(value, authority) {
  if (typeof value === 'string') {
    return value.includes('{canonicalSourceRoot}')
      ? value.replaceAll('{canonicalSourceRoot}', authority?.root || '.')
      : value;
  }
  if (Array.isArray(value)) return value.map((item) => interpolateCanonicalSource(item, authority));
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, interpolateCanonicalSource(item, authority)])
    );
  }
  return value;
}

function readAuthorityManifest(root, manifestPath) {
  const normalized = normalizePath(manifestPath || DEFAULT_MANIFEST_PATH);
  const absolute = path.resolve(root, normalized);
  if (!isInsideRoot(root, absolute)) {
    return { exists: true, path: normalized, data: null, parseError: 'Manifest path escapes the repository root.' };
  }
  if (!fs.existsSync(absolute)) return { exists: false, path: normalized, data: null, parseError: null };
  try {
    return { exists: true, path: normalized, data: JSON.parse(fs.readFileSync(absolute, 'utf8')), parseError: null };
  } catch (error) {
    return { exists: true, path: normalized, data: null, parseError: String(error.message || error) };
  }
}

function authorityFromManifest({ root, manifest, fallbackMarkers }) {
  const data = manifest.data || {};
  const errors = [];
  if (manifest.parseError) errors.push(`Manifest JSON is invalid: ${manifest.parseError}`);
  if (data.schemaVersion !== 1) errors.push('schemaVersion must be 1.');
  if (data.status !== 'ready') errors.push('status must be "ready".');
  if (typeof data.root !== 'string' || !data.root.trim()) errors.push('root must be a non-empty repository-relative path.');

  const sourceRoot = normalizePath(data.root || '');
  const absoluteSourceRoot = path.resolve(root, sourceRoot || '.');
  if (sourceRoot && !isInsideRoot(root, absoluteSourceRoot)) errors.push('root must stay inside the repository.');

  const markers = validStringArray(data.requiredMarkers) ? data.requiredMarkers : fallbackMarkers;
  if (!isValidSourceRoot(root, sourceRoot, markers)) {
    errors.push(`Source root is missing required markers: ${markers.join(', ')}.`);
  }

  const readinessFiles = validStringArray(data.readinessFiles) ? data.readinessFiles : [];
  for (const file of readinessFiles) {
    const readinessPath = path.resolve(absoluteSourceRoot, file);
    if (!isInsideRoot(absoluteSourceRoot, readinessPath)) {
      errors.push(`Readiness file must stay inside the source root: ${file}.`);
    } else if (!fs.existsSync(readinessPath)) {
      errors.push(`Missing readiness file: ${file}.`);
    }
  }

  const validationProfile = data.validationProfile;
  if (!validationProfile || validationProfile.schemaVersion !== 2 || !isObject(validationProfile.commands)) {
    errors.push('validationProfile.commands must be present with schemaVersion 2.');
  } else {
    validatePolicyDefaults(validationProfile.policyDefaults, errors);
    for (const [capability, steps] of Object.entries(validationProfile.commands)) {
      if (!capability.trim() || !Array.isArray(steps) || !steps.length) {
        errors.push(`Validation capability ${capability || '<empty>'} must contain at least one step.`);
        continue;
      }
      for (const step of steps) validateValidationStep(capability, step, validationProfile.policyDefaults, errors);
    }
  }

  const declaredPhase = data.phase == null ? phaseName(sourceRoot) : String(data.phase);
  const pathPhase = phaseName(sourceRoot);
  if (declaredPhase && pathPhase && declaredPhase !== pathPhase) {
    errors.push(`Declared phase ${declaredPhase} does not match source path phase ${pathPhase}.`);
  }

  return {
    schemaVersion: 2,
    status: errors.length ? 'invalid-manifest' : 'manifest-ready',
    readinessStatus: errors.length ? 'invalid' : 'ready',
    root: sourceRoot || null,
    phase: declaredPhase || null,
    version: parseVersion(declaredPhase),
    requiredMarkers: markers,
    readinessFiles,
    validationProfile: validationProfile || null,
    manifestPath: manifest.path,
    errors,
    candidates: []
  };
}

function validateValidationStep(capability, step, policyDefaults, errors) {
  if (!isObject(step)) {
    errors.push(`Validation capability ${capability} contains a non-object step.`);
    return;
  }
  if (typeof step.command !== 'string' || !step.command.trim()) {
    errors.push(`Validation capability ${capability} has a step without a command.`);
  }
  if (!['repo', 'source'].includes(step.cwd) && !(typeof step.cwd === 'string' && step.cwd.startsWith('repo:'))) {
    errors.push(`Validation capability ${capability} has an invalid cwd.`);
  }
  if (step.args !== undefined && (!Array.isArray(step.args) || step.args.some((arg) => typeof arg !== 'string'))) {
    errors.push(`Validation capability ${capability} args must be an array of strings.`);
  }
  try {
    normalizeCommandContract({
      schemaVersion: 1,
      executable: step.command,
      args: step.args || [],
      policy: mergePolicy(policyDefaults, step.policy)
    });
  } catch (error) {
    errors.push(`Validation capability ${capability} has an invalid command policy: ${error.code || error.message}.`);
  }
}

function validatePolicyDefaults(value, errors) {
  if (!isObject(value)) {
    errors.push('validationProfile.policyDefaults must be present.');
    return;
  }
  try {
    normalizeCommandContract({
      schemaVersion: 1,
      executable: 'node',
      args: ['--version'],
      policy: value
    });
  } catch (error) {
    errors.push(`validationProfile.policyDefaults is invalid: ${error.code || error.message}.`);
  }
}

function mergePolicy(defaults = {}, override = {}) {
  return {
    resources: { ...(defaults.resources || {}), ...(override.resources || {}) },
    network: { ...(defaults.network || {}), ...(override.network || {}) },
    environment: {
      ...(defaults.environment || {}),
      ...(override.environment || {}),
      allow: override.environment?.allow || defaults.environment?.allow || [],
      values: {
        ...(defaults.environment?.values || {}),
        ...(override.environment?.values || {})
      }
    },
    writablePaths: override.writablePaths || defaults.writablePaths || []
  };
}

function isValidSourceRoot(repoRoot, candidateRoot, requiredMarkers) {
  if (!candidateRoot) return false;
  const absolute = path.resolve(repoRoot, candidateRoot);
  return isInsideRoot(repoRoot, absolute)
    && fs.existsSync(absolute)
    && requiredMarkers.every((marker) => fs.existsSync(path.join(absolute, marker)));
}

function isInsideRoot(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function phaseName(value) {
  return normalizePath(value || '').match(/(?:^|\/)Phase\s+(\d+(?:\.\d+)*)(?:\/|$)/i)?.[1] || null;
}

function parseVersion(value) {
  return String(value || '').split('.').map((part) => Number(part)).filter(Number.isFinite);
}

function compareVersions(a, b) {
  const size = Math.max(a.length, b.length);
  for (let index = 0; index < size; index += 1) {
    const delta = (a[index] || 0) - (b[index] || 0);
    if (delta) return delta;
  }
  return 0;
}

function validStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.trim());
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function emptyAuthority(status, searchRoot, requiredMarkers, extra = {}) {
  return {
    schemaVersion: 2,
    status,
    readinessStatus: 'unavailable',
    root: null,
    phase: null,
    version: [],
    searchRoot: normalizePath(searchRoot),
    requiredMarkers,
    readinessFiles: [],
    validationProfile: null,
    manifestPath: null,
    errors: [],
    candidates: [],
    ...extra
  };
}
