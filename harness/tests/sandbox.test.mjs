import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildSandboxInvocation, sandboxVerificationCommands } from '../lib/sandbox.mjs';

const root = path.resolve('test-fixtures/sample-project');
const invocation = buildSandboxInvocation({
  root,
  image: 'agent-engineering-harness-sandbox:3.2.0',
  command: ['node', 'harness/cli.mjs', 'status']
});

assert.equal(invocation.command, 'docker');
assert.deepEqual(invocation.args.slice(0, 2), ['run', '--rm']);
assert.equal(invocation.args.includes('--read-only'), true);
assert.equal(invocation.args.includes('no-new-privileges'), true);
assert.equal(invocation.args.includes('ALL'), true);
assert.equal(invocation.args.includes('none'), true);
assert.equal(invocation.args.some((arg) => arg.includes(':/workspace:ro')), true);
assert.deepEqual(invocation.args.slice(-3), ['node', 'harness/cli.mjs', 'status']);
assert.equal(invocation.shell, false);

const writableInvocation = buildSandboxInvocation({
  root,
  image: 'agent-engineering-harness-sandbox:3.3.0',
  workspaceWritable: true,
  command: ['node', 'harness/cli.mjs', 'status']
});
assert.equal(writableInvocation.args.some((arg) => arg.includes(':/workspace:rw')), true);

const verificationCommands = sandboxVerificationCommands();
assert.equal(verificationCommands.length, 3);
assert.equal(verificationCommands.every((item) => item.command[0] === 'python3'), true);
assert.equal(verificationCommands.some((item) => item.id === 'workspace-read-only'), true);
assert.equal(verificationCommands.some((item) => item.id === 'network-disabled'), true);

const dockerfile = fs.readFileSync(path.resolve('harness/sandbox/Dockerfile'), 'utf8');
assert.match(dockerfile, /^FROM node:24-bookworm$/m);
assert.match(dockerfile, /^USER node$/m);
assert.doesNotMatch(dockerfile, /apt-get/);

assert.throws(
  () => buildSandboxInvocation({ root, image: 'image', command: [] }),
  /requires a command/
);

console.log('SANDBOX_TEST_PASS');
