import fs from 'node:fs';
import path from 'node:path';
import { normalizePath, readJson, writeJson } from '../common.mjs';
import { canonicalJson, digestBytes, digestCanonicalJson } from './canonical-json.mjs';

export function buildSealedRunBinding({
  root,
  runId,
  impactReport,
  validationPlan,
  baselineSnapshot,
  config,
  gitCandidateBaseline = null
}) {
  const configPath = existingPath(root, config?.configFile);
  const sourceAuthorityPath = existingPath(root, config?.sourceAuthority?.manifestPath);
  const record = {
    schemaVersion: 1,
    contractVersion: 'harness-evidence-v4.0.0',
    runId,
    impactReportDigest: digestCanonicalJson(impactReport ?? null),
    validationPlanDigest: digestCanonicalJson(validationPlan ?? null),
    baselineSnapshotDigest: digestCanonicalJson(baselineSnapshot ?? []),
    policySnapshotDigest: digestCanonicalJson(policySnapshot(config)),
    configPath: relativePath(root, configPath),
    configFileDigest: configPath ? digestFile(configPath) : null,
    sourceAuthorityPath: relativePath(root, sourceAuthorityPath),
    sourceAuthorityFileDigest: sourceAuthorityPath ? digestFile(sourceAuthorityPath) : null,
    sourceAuthoritySnapshotDigest: digestCanonicalJson(config?.sourceAuthority ?? null),
    gitCandidateBaselineDigest: gitCandidateBaseline?.snapshotDigest || null,
    engineDigest: digestEngine(root)
  };
  return {
    ...record,
    bindingDigest: digestCanonicalJson(record)
  };
}

export function bindingRecordPath(runDir) {
  return path.join(runDir, 'run-binding.json');
}

export function writeSealedRunBinding({ runDir, binding }) {
  const target = bindingRecordPath(runDir);
  const existing = readJson(target, null);
  if (existing && canonicalJson(existing) !== canonicalJson(binding)) {
    return target;
  }
  if (!existing) writeJson(target, binding);
  return target;
}

export function verifyRunEvidenceBindings({ root, runDir, manifest, validationPlan, impactReport }) {
  if ((manifest?.schemaVersion || 0) < 5) {
    return { valid: true, mode: 'legacy-unbound', violations: [], binding: null };
  }
  const violations = [];
  const embedded = manifest?.evidence?.sealedBinding;
  const stored = readJson(bindingRecordPath(runDir), null);
  if (!embedded) violations.push(violation('EVIDENCE_BINDING_MISSING', 'manifest.evidence.sealedBinding'));
  if (!stored) violations.push(violation('EVIDENCE_BINDING_RECORD_MISSING', 'run-binding.json'));
  if (!embedded || !stored) return { valid: false, mode: 'sealed', violations, binding: embedded || stored };

  const withoutDigest = { ...embedded };
  delete withoutDigest.bindingDigest;
  const recomputed = digestCanonicalJson(withoutDigest);
  if (embedded.bindingDigest !== recomputed) {
    violations.push(violation('EVIDENCE_BINDING_DIGEST_MISMATCH', 'manifest.evidence.sealedBinding.bindingDigest'));
  }
  if (canonicalJson(embedded) !== canonicalJson(stored)) {
    violations.push(violation('EVIDENCE_BINDING_RECORD_MISMATCH', 'run-binding.json'));
  }
  if (embedded.runId !== manifest.runId) violations.push(violation('EVIDENCE_RUN_ID_MISMATCH', 'run-binding.json.runId'));
  if (embedded.validationPlanDigest !== digestCanonicalJson(validationPlan ?? null)) {
    violations.push(violation('EVIDENCE_VALIDATION_PLAN_DRIFT', 'validation-plan.json'));
  }
  if (embedded.impactReportDigest !== digestCanonicalJson(impactReport ?? null)) {
    violations.push(violation('EVIDENCE_IMPACT_REPORT_DRIFT', 'impact-report.json'));
  }
  if ((manifest?.schemaVersion || 0) >= 6) {
    const baselineDigest = manifest?.gitCandidate?.baseline?.snapshotDigest || null;
    if (!baselineDigest || embedded.gitCandidateBaselineDigest !== baselineDigest) {
      violations.push(violation('EVIDENCE_GIT_CANDIDATE_BINDING_DRIFT', 'gitCandidate.baseline'));
    }
  }
  verifyFileBinding({ root, binding: embedded, pathKey: 'configPath', digestKey: 'configFileDigest', code: 'EVIDENCE_POLICY_SOURCE_DRIFT', violations });
  verifyFileBinding({ root, binding: embedded, pathKey: 'sourceAuthorityPath', digestKey: 'sourceAuthorityFileDigest', code: 'EVIDENCE_SOURCE_AUTHORITY_DRIFT', violations });
  if (embedded.engineDigest !== digestEngine(root)) {
    violations.push(violation('EVIDENCE_ENGINE_DRIFT', 'harness'));
  }
  return { valid: violations.length === 0, mode: 'sealed', violations, binding: embedded };
}

export function recordEvidenceObject({ runDir, runId, kind, value, parentDigests = [] }) {
  const payload = {
    schemaVersion: 1,
    runId,
    kind,
    parentDigests: [...new Set(parentDigests)].sort(),
    value
  };
  const digest = digestCanonicalJson(payload);
  const objectDir = path.join(runDir, 'evidence', 'objects');
  fs.mkdirSync(objectDir, { recursive: true });
  const objectPath = path.join(objectDir, `${digest.slice('sha256:'.length)}.json`);
  const existing = readJson(objectPath, null);
  if (existing && canonicalJson(existing) !== canonicalJson(payload)) {
    throw new Error('HARNESS_V4_EVIDENCE_CONTENT_ADDRESS_COLLISION');
  }
  if (!existing) writeJson(objectPath, payload);

  const indexPath = path.join(runDir, 'evidence-index.json');
  const index = readJson(indexPath, {
    schemaVersion: 1,
    runId,
    entries: []
  });
  if (index.runId !== runId) throw new Error('HARNESS_V4_EVIDENCE_CROSS_RUN_INDEX');
  const prior = index.entries.find((entry) => entry.digest === digest);
  if (prior && (prior.kind !== kind || prior.path !== normalizePath(path.relative(runDir, objectPath)))) {
    throw new Error('HARNESS_V4_EVIDENCE_INDEX_IDENTITY_CONFLICT');
  }
  if (!prior) {
    index.entries.push({
      digest,
      kind,
      path: normalizePath(path.relative(runDir, objectPath)),
      parentDigests: payload.parentDigests
    });
    index.entries.sort((a, b) => a.digest.localeCompare(b.digest));
    writeJson(indexPath, index);
  }
  return { digest, objectPath, indexPath };
}

export function digestFile(file) {
  return digestBytes(fs.readFileSync(file));
}

export function digestEngine(root) {
  const candidates = [
    path.join(root, 'harness', 'cli.mjs'),
    ...walkFiles(path.join(root, 'harness', 'lib'))
  ].filter((file) => fs.existsSync(file)).sort();
  const chunks = [];
  for (const file of candidates) {
    chunks.push(normalizePath(path.relative(root, file)), '\0', digestFile(file), '\0');
  }
  return digestBytes(Buffer.from(chunks.join(''), 'utf8'));
}

function policySnapshot(config = {}) {
  const copy = { ...config };
  delete copy.configFile;
  delete copy.sourceAuthority;
  return copy;
}

function existingPath(root, value) {
  if (!value || typeof value !== 'string') return null;
  const resolved = path.isAbsolute(value) ? value : path.join(root, value);
  return fs.existsSync(resolved) ? resolved : null;
}

function relativePath(root, value) {
  return value ? normalizePath(path.relative(root, value)) : null;
}

function verifyFileBinding({ root, binding, pathKey, digestKey, code, violations }) {
  const relPath = binding[pathKey];
  const expected = binding[digestKey];
  if (!relPath && !expected) return;
  if (!relPath || !expected) {
    violations.push(violation(code, pathKey));
    return;
  }
  const file = path.join(root, relPath);
  if (!fs.existsSync(file) || digestFile(file) !== expected) violations.push(violation(code, relPath));
}

function walkFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

function violation(code, safePath) {
  return { code, safePath };
}
