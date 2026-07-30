#!/usr/bin/env node
import path from 'node:path';
import { auditRun } from './lib/auditor.mjs';

const args = process.argv.slice(2);
const command = args.shift();
if (command !== 'audit') {
  process.stderr.write('Usage: node harness/auditor/cli.mjs audit --root <repo> --run <run-dir> [--mode formal-local]\n');
  process.exitCode = 2;
} else {
  const root = valueAfter(args, '--root') || process.cwd();
  const run = valueAfter(args, '--run');
  const mode = valueAfter(args, '--mode') || 'formal-local';
  if (!run) {
    process.stderr.write('AUDITOR_RUN_REQUIRED\n');
    process.exitCode = 2;
  } else {
    const result = auditRun({ root: path.resolve(root), runDir: path.resolve(root, run), mode });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status !== 'attested') process.exitCode = 1;
  }
}

function valueAfter(values, flag) {
  const index = values.indexOf(flag);
  return index >= 0 ? values[index + 1] : null;
}
