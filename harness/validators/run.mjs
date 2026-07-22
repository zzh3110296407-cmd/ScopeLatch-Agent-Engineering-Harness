#!/usr/bin/env node
import { loadConfig } from '../lib/config.mjs';
import { findGitRoot } from '../lib/repo.mjs';
import { runValidationCapability } from '../lib/source-validator.mjs';

const capability = process.argv[2];
if (!capability) {
  console.error('Usage: node harness/validators/run.mjs <capability>');
  process.exit(2);
}

const root = findGitRoot(process.cwd());
const config = loadConfig(root);

try {
  const result = runValidationCapability({ root, authority: config.sourceAuthority, capability });
  for (const step of result.steps) {
    if (step.stdout) process.stdout.write(step.stdout);
    if (step.stderr) process.stderr.write(step.stderr);
  }
  console.log(`HARNESS_VALIDATION_${capability.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}: ${result.status.toUpperCase()}`);
  if (result.status !== 'passed') process.exitCode = result.exitCode || 1;
} catch (error) {
  console.error(`HARNESS_VALIDATION_ERROR: ${error.message || error}`);
  process.exitCode = 1;
}
