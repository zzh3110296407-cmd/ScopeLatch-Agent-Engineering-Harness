import path from 'node:path';
import { runFile } from './common.mjs';

export const DEFAULT_SANDBOX_IMAGE = 'scopelatch-harness-sandbox:3.4.0';

export function buildSandboxInvocation({ root, image = DEFAULT_SANDBOX_IMAGE, command, workspaceWritable = false }) {
  if (!Array.isArray(command) || !command.length || command.some((item) => typeof item !== 'string' || !item)) {
    throw new Error('Sandbox execution requires a command and optional arguments.');
  }
  if (typeof image !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(image)) {
    throw new Error('Sandbox image name is invalid.');
  }
  const mountMode = workspaceWritable ? 'rw' : 'ro';
  const mount = `${path.resolve(root).replaceAll('\\', '/')}:/workspace:${mountMode}`;
  return {
    command: 'docker',
    shell: false,
    args: [
      'run', '--rm',
      '--network', 'none',
      '--read-only',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--pids-limit', '256',
      '--memory', '2g',
      '--cpus', '2',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m',
      '--env', 'HARNESS_SANDBOXED=1',
      '--volume', mount,
      '--workdir', '/workspace',
      image,
      ...command
    ]
  };
}

export function buildSandboxImage({ root, image = DEFAULT_SANDBOX_IMAGE }) {
  return runFile('docker', [
    'build',
    '--tag', image,
    '--file', path.join(root, 'harness', 'sandbox', 'Dockerfile'),
    path.join(root, 'harness', 'sandbox')
  ], { cwd: root, timeoutMs: 20 * 60 * 1000 });
}

export function runSandboxedCommand({ root, image = DEFAULT_SANDBOX_IMAGE, command, workspaceWritable = false, timeoutMs = 60 * 60 * 1000 }) {
  const invocation = buildSandboxInvocation({ root, image, command, workspaceWritable });
  return runFile(invocation.command, invocation.args, { cwd: root, timeoutMs });
}

export function sandboxVerificationCommands() {
  return [
    {
      id: 'environment-marker',
      command: ['python3', '-c', "import os,sys; sys.exit(0 if os.environ.get('HARNESS_SANDBOXED') == '1' and os.getcwd() == '/workspace' else 1)"]
    },
    {
      id: 'workspace-read-only',
      command: ['python3', '-c', "import pathlib,sys; p=pathlib.Path('/workspace/.harness-sandbox-write-probe');\ntry:\n p.write_text('unsafe', encoding='utf-8'); p.unlink(missing_ok=True); sys.exit(1)\nexcept OSError:\n sys.exit(0)"]
    },
    {
      id: 'network-disabled',
      command: ['python3', '-c', "import socket,sys; s=socket.socket(); s.settimeout(1);\ntry:\n s.connect(('1.1.1.1', 53)); sys.exit(1)\nexcept OSError:\n sys.exit(0)\nfinally:\n s.close()"]
    }
  ];
}

export function verifySandboxRuntime({ root, image = DEFAULT_SANDBOX_IMAGE }) {
  const checks = sandboxVerificationCommands().map((check) => {
    const result = runSandboxedCommand({ root, image, command: check.command, workspaceWritable: false, timeoutMs: 30000 });
    return {
      id: check.id,
      status: result.exitCode === 0 ? 'passed' : 'failed',
      exitCode: result.exitCode,
      error: result.error || null
    };
  });
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    image,
    status: checks.every((check) => check.status === 'passed') ? 'passed' : 'failed',
    checks
  };
}
