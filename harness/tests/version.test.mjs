import assert from 'node:assert/strict';
import { findGitRoot } from '../lib/repo.mjs';
import { readHarnessVersion } from '../lib/version.mjs';

const root = findGitRoot(process.cwd());
const version = readHarnessVersion(root);
assert.match(version.version, /^\d+\.\d+\.\d+$/);
assert.equal(version.version, '3.4.0');
assert.equal(version.runManifestSchemaVersion, 4);
assert.equal(version.sourceAuthoritySchemaVersion, 2);
assert.equal(version.ruleReviewSchemaVersion, 1);
assert.equal(version.securityReportSchemaVersion, 2);
assert.equal(version.failureKnowledgeSchemaVersion, 4);
assert.equal(version.sandboxVerificationSchemaVersion, 1);
console.log('VERSION_TEST_PASS');
