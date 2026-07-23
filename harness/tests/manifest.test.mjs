import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildRunManifest,
  manifestPathForRun,
  readRunManifest,
  updateRunManifest,
  writeRunManifest
} from '../lib/manifest.mjs';
import { parseTask } from '../lib/task.mjs';

const parsedTargetPaths = parseTask(
  'Modify .harness/harness.config.json and .harness/harness.config.example.json only.'
).fileMentions;
assert.deepEqual(parsedTargetPaths, [
  '.harness/harness.config.json',
  '.harness/harness.config.example.json'
]);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-manifest-'));
const runDir = path.join(tempRoot, '.harness', 'runs', 'run-001');
const configPath = path.join(tempRoot, '.harness', 'harness.config.json');
const contextPath = path.join(runDir, 'context-pack.md');
const validationPath = path.join(runDir, 'validation-plan.json');

fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.mkdirSync(runDir, { recursive: true });
fs.writeFileSync(configPath, '{"repoName":"test"}\n', 'utf8');
fs.writeFileSync(contextPath, '# Context\n', 'utf8');
fs.writeFileSync(validationPath, '{"commands":[]}\n', 'utf8');

const manifest = buildRunManifest({
  root: tempRoot,
  config: { repoName: 'test', configFile: configPath },
  task: '修复世界画布生成草稿 400 错误',
  runId: 'run-001',
  runDir,
  createdAt: '2026-07-06T00:00:00.000Z',
  impactReport: {
    baseRef: 'origin/main',
    risk: { level: 'L4', score: 10 },
    riskSignals: [{ signal: 'build-system-change' }],
    writeTargets: [
      'harness/lib/manifest.mjs',
      'harness/tests/manifest.test.mjs'
    ],
    directTargets: [
      'harness/lib/manifest.mjs',
      'harness/lib/scope.mjs',
      'AGENTS.md'
    ],
    reverseDependents: ['harness/cli.mjs'],
    impactedTests: ['harness/tests/manifest.test.mjs'],
    requiredSynchronizations: [
      { domain: 'harness-control' },
      { domain: 'public-api' }
    ]
  },
  validationPlan: {
    requiredCheckCount: 2,
    commands: [{ id: 'lint' }, { id: 'build' }],
    graph: {
      mode: 'tiered',
      nodes: [{ id: 'diff-guard' }, { id: 'lint' }, { id: 'build' }]
    }
  },
  sessionBinding: {
    fingerprint: `sha256:${'a'.repeat(64)}`,
    source: 'CODEX_THREAD_ID',
    required: true
  },
  artifacts: {
    contextPack: contextPath,
    validationPlan: validationPath
  }
});

assert.equal(manifest.schemaVersion, 4);
assert.equal(manifest.status, 'planned');
assert.equal(manifest.phase, 'implementation-ready');
assert.equal(manifest.task.raw, '修复世界画布生成草稿 400 错误');
assert.equal(manifest.repo.baseRef, 'origin/main');
assert.match(manifest.repo.configHash, /^sha256:[a-f0-9]{64}$/);
assert.equal(manifest.repo.indexHash, null);
assert.equal(manifest.artifacts.contextPack, '.harness/runs/run-001/context-pack.md');
assert.equal(manifest.validation.requiredCheckCount, 2);
assert.equal(manifest.validation.graphMode, 'tiered');
assert.equal(manifest.validation.graphNodeCount, 3);
assert.deepEqual(manifest.risk.signals, ['build-system-change']);
assert.equal(manifest.synchronizations.requiredCount, 2);
assert.deepEqual(manifest.synchronizations.domains, ['harness-control', 'public-api']);
assert.match(manifest.task.fingerprint, /^sha256:[a-f0-9]{64}$/);
assert.equal(manifest.binding.taskFingerprint, manifest.task.fingerprint);
assert.equal(manifest.binding.sessionFingerprint, `sha256:${'a'.repeat(64)}`);
assert.equal(manifest.binding.sessionSource, 'CODEX_THREAD_ID');
assert.equal(manifest.binding.sessionBindingRequired, true);
assert.deepEqual(manifest.binding.allowedFiles, [
  'harness/lib/manifest.mjs',
  'harness/tests/manifest.test.mjs'
]);
assert.deepEqual(manifest.binding.allowedPathPatterns, []);
assert.equal(manifest.binding.expiresAt, '2026-07-06T04:00:00.000Z');

const manifestPath = writeRunManifest({ runDir, manifest });
assert.equal(manifestPath, manifestPathForRun(runDir));
assert.deepEqual(readRunManifest(runDir), manifest);

const updated = updateRunManifest({
  runDir,
  patch: {
    status: 'passed',
    phase: 'validation-complete',
    artifacts: {
      validationResult: path.join(runDir, 'validation-result.json')
    },
    validation: {
      resultStatus: 'passed-or-skipped'
    }
  },
  updatedAt: '2026-07-06T00:01:00.000Z'
});

assert.equal(updated.status, 'passed');
assert.equal(updated.phase, 'validation-complete');
assert.equal(updated.updatedAt, '2026-07-06T00:01:00.000Z');
assert.equal(updated.artifacts.validationResult, '.harness/runs/run-001/validation-result.json');
assert.equal(updated.validation.requiredCheckCount, 2);
assert.equal(updated.validation.resultStatus, 'passed-or-skipped');

fs.rmSync(tempRoot, { recursive: true, force: true });

console.log('MANIFEST_TEST_PASS');
