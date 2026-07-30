import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  acquireLease,
  leasePathFor,
  readLease,
  releaseLease
} from './v4/concurrent-state.mjs';

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
  const stateDir = path.join(root, config.stateDir || '.harness/state');
  const resourceId = `run:${runId}`;
  const lease = acquireLease({
    stateDir,
    resourceId,
    runId,
    ownerId: identity.value,
    ttlMs: (config.policy?.planMaxAgeMinutes || 240) * 60 * 1000,
    metadata: {
      source: identity.source,
      purpose: 'session-binding'
    }
  });
  return {
    fingerprint: fingerprintSession(identity.value),
    nonceFingerprint: fingerprintSession(lease.nonce),
    source: identity.source,
    required: config.policy?.requireSessionBinding !== false,
    expiresAt: lease.expiresAt,
    leasePath: lease.leasePath,
    resourceId
  };
}

export function removeSessionLease({ root, config, runId }) {
  const stateDir = path.join(root, config.stateDir || '.harness/state');
  const resourceId = `run:${runId}`;
  const lease = readLease({ stateDir, resourceId, includeExpired: true });
  if (lease) {
    releaseLease({
      stateDir,
      resourceId,
      ownerId: lease.ownerId,
      nonce: lease.nonce,
      reason: 'run-closeout'
    });
    return;
  }
  const legacyPath = path.join(stateDir, 'session-leases', `${runId}.json`);
  try { fs.unlinkSync(legacyPath); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export function readSessionLease({ root, config, runId }) {
  const stateDir = path.join(root, config.stateDir || '.harness/state');
  const resourceId = `run:${runId}`;
  const lease = readLease({ stateDir, resourceId });
  if (!lease || lease.runId !== runId) return null;
  return {
    ...lease,
    sessionId: lease.ownerId,
    source: lease.metadata?.source || 'unknown',
    leasePath: leasePathFor(stateDir, resourceId)
  };
}

export function codexBindingEnvironment({ root, config, manifest }) {
  const lease = readSessionLease({ root, config, runId: manifest.runId });
  if (!lease) throw new Error(`Missing or expired session lease for Harness run ${manifest.runId}.`);
  if (fingerprintSession(lease.sessionId) !== manifest.binding?.sessionFingerprint) {
    throw new Error(`Session lease fingerprint mismatch for Harness run ${manifest.runId}.`);
  }
  if (fingerprintSession(lease.nonce) !== manifest.binding?.leaseNonceFingerprint) {
    throw new Error(`Session lease nonce mismatch for Harness run ${manifest.runId}.`);
  }
  if (lease.resourceId !== manifest.binding?.leaseResourceId) {
    throw new Error(`Session lease resource mismatch for Harness run ${manifest.runId}.`);
  }
  return {
    HARNESS_RUN_ID: manifest.runId,
    HARNESS_TASK_FINGERPRINT: manifest.binding?.taskFingerprint || manifest.task?.fingerprint || '',
    HARNESS_SESSION_ID: lease.sessionId
  };
}
