import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, readJson, writeJson } from './common.mjs';

const sessionEnvironmentKeys = [
  'HARNESS_SESSION_ID',
  'CODEX_THREAD_ID',
  'CODEX_SESSION_ID',
  'CODEX_CONVERSATION_ID'
];

export function currentSessionIdentity(env = process.env) {
  for (const key of sessionEnvironmentKeys) {
    const value = String(env[key] || '').trim();
    if (value) return { value, source: key };
  }
  return null;
}

export function fingerprintSession(value) {
  if (!value) return null;
  return `sha256:${crypto.createHash('sha256').update(String(value)).digest('hex')}`;
}

export function createSessionLease({ root, config, runId, env = process.env }) {
  const identity = currentSessionIdentity(env) || {
    value: crypto.randomBytes(32).toString('base64url'),
    source: 'generated-execution-capability'
  };
  const expiresAt = new Date(Date.now() + (config.policy?.planMaxAgeMinutes || 240) * 60 * 1000).toISOString();
  const leaseDir = path.join(root, config.stateDir || '.harness/state', 'session-leases');
  const leasePath = path.join(leaseDir, `${runId}.json`);
  ensureDir(leaseDir);
  pruneExpiredSessionLeases(leaseDir);
  writeJson(leasePath, {
    schemaVersion: 1,
    runId,
    sessionId: identity.value,
    source: identity.source,
    expiresAt
  });
  try { fs.chmodSync(leasePath, 0o600); } catch { /* Best effort on Windows. */ }
  return {
    fingerprint: fingerprintSession(identity.value),
    source: identity.source,
    required: config.policy?.requireSessionBinding !== false,
    expiresAt,
    leasePath
  };
}

export function removeSessionLease({ root, config, runId }) {
  const file = path.join(root, config.stateDir || '.harness/state', 'session-leases', `${runId}.json`);
  try { fs.rmSync(file); } catch { /* Lease may already be absent. */ }
}

export function readSessionLease({ root, config, runId }) {
  const file = path.join(root, config.stateDir || '.harness/state', 'session-leases', `${runId}.json`);
  const lease = readJson(file, null);
  if (!lease?.sessionId || lease.runId !== runId) return null;
  if (Date.parse(lease.expiresAt || '') < Date.now()) return null;
  return lease;
}

export function codexBindingEnvironment({ root, config, manifest }) {
  const lease = readSessionLease({ root, config, runId: manifest.runId });
  if (!lease) throw new Error(`Missing or expired session lease for Harness run ${manifest.runId}.`);
  if (fingerprintSession(lease.sessionId) !== manifest.binding?.sessionFingerprint) {
    throw new Error(`Session lease fingerprint mismatch for Harness run ${manifest.runId}.`);
  }
  return {
    HARNESS_RUN_ID: manifest.runId,
    HARNESS_TASK_FINGERPRINT: manifest.binding?.taskFingerprint || manifest.task?.fingerprint || '',
    HARNESS_SESSION_ID: lease.sessionId
  };
}

function pruneExpiredSessionLeases(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(dir, entry.name);
    const lease = readJson(file, null);
    if (!lease || Date.parse(lease.expiresAt || '') < Date.now()) {
      try { fs.rmSync(file); } catch { /* Best effort cleanup. */ }
    }
  }
}
