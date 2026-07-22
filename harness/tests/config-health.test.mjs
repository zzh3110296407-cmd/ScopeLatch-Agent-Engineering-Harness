import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildConfigHealth, findConfigFile, loadConfig, validateConfigSchema } from '../lib/config.mjs';
import { findGitRoot } from '../lib/repo.mjs';

const root = findGitRoot(process.cwd());
const config = loadConfig(root);

const health = buildConfigHealth({ root, config });
assert.equal(health.status, 'healthy');
assert.equal(health.checks.every((check) => check.status === 'passed'), true);

const cleanCheckoutRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-config-fallback-'));
try {
  const harnessDir = path.join(cleanCheckoutRoot, '.harness');
  fs.mkdirSync(harnessDir, { recursive: true });
  const examplePath = path.join(harnessDir, 'harness.config.example.json');
  fs.writeFileSync(examplePath, '{}\n', 'utf8');
  assert.equal(findConfigFile(cleanCheckoutRoot), examplePath);

  const localPath = path.join(harnessDir, 'harness.config.json');
  fs.writeFileSync(localPath, '{}\n', 'utf8');
  assert.equal(findConfigFile(cleanCheckoutRoot), localPath);
} finally {
  fs.rmSync(cleanCheckoutRoot, { recursive: true, force: true });
}

const invalidConfig = {
  ...config,
  context: {
    ...config.context,
    maxMustReadFiles: 0
  }
};

assert.throws(
  () => validateConfigSchema(invalidConfig, 'test config'),
  /context\.maxMustReadFiles must be a positive integer/
);

assert.throws(
  () => validateConfigSchema({ ...config, security: { ...config.security, profile: 'public-ish' } }, 'test config'),
  /security\.profile must be one of private-development, public-release/
);

assert.throws(
  () => validateConfigSchema({
    ...config,
    context: { ...config.context, controlPlane: { ...config.context.controlPlane, pathPatterns: [] } }
  }, 'test config'),
  /context\.controlPlane\.pathPatterns must contain at least one value/
);

const missingCacheExclusion = {
  ...config,
  context: {
    ...config.context,
    excludePathPatterns: config.context.excludePathPatterns.filter((pattern) => !pattern.includes('.harness/cache'))
  }
};

const degradedHealth = buildConfigHealth({ root, config: missingCacheExclusion });
assert.equal(degradedHealth.status, 'failed');
assert.equal(
  degradedHealth.checks.some((check) => check.id === 'required-exclude-paths' && check.status === 'failed'),
  true
);

console.log('CONFIG_HEALTH_TEST_PASS');
