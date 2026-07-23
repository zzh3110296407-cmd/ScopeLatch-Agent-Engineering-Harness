#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContextPack } from './lib/context-builder.mjs';
import { analyzeImpact } from './lib/impact-analyzer.mjs';
import { planValidation } from './lib/validation-planner.mjs';
import { buildCodexPrompt } from './lib/prompt-builder.mjs';
import { parseTask } from './lib/task.mjs';
import { findGitRoot, gitFiles, currentBranch } from './lib/repo.mjs';
import { buildConfigHealth, loadConfig } from './lib/config.mjs';
import { checkRunDiff, readGuardedWorkingTreeSnapshot, runDiffGuard } from './lib/guard.mjs';
import { buildRunManifest, readRunManifest, updateRunManifest, writeRunManifest } from './lib/manifest.mjs';
import { buildHarnessIndexes, indexDirPath, writeHarnessIndexes } from './lib/indexer.mjs';
import { repairRun } from './lib/repair.mjs';
import { writePrReport } from './lib/report.mjs';
import {
  backfillFailureKnowledge,
  listRuleCandidates,
  loadApplicableRules,
  promoteRuleCandidate,
  recordFailureKnowledge,
  rejectRuleCandidate
} from './lib/knowledge.mjs';
import { closeRun } from './lib/closeout.mjs';
import { checkCodexAvailable, runCodex } from './lib/codex-runner.mjs';
import { codexBindingEnvironment, createSessionLease } from './lib/session-binding.mjs';
import { scanRepositorySecurity } from './lib/security-scanner.mjs';
import { benchmarkPostCheck } from './lib/performance.mjs';
import { readHarnessVersion } from './lib/version.mjs';
import {
  buildSandboxImage,
  buildSandboxInvocation,
  DEFAULT_SANDBOX_IMAGE,
  runSandboxedCommand,
  verifySandboxRuntime
} from './lib/sandbox.mjs';
import { ensureDir, exists, nowId, readJson, slugify, writeJson, writeText } from './lib/common.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const argv = process.argv.slice(2);
  const command = argv.shift();
  const root = findGitRoot(process.cwd());
  const config = loadConfig(root);

  try {
    if (!command || command === 'help' || command === '--help' || command === '-h') return help();
    if (command === 'version' || command === '--version' || command === '-v') return cmdVersion({ root });
    if (command === 'plan') return cmdPlan({ root, config, task: argv.join(' ') });
    if (command === 'prompt') return cmdPrompt({ root, config, task: argv.join(' ') });
    if (command === 'run') return cmdRun({ root, config, argv });
    if (command === 'repair') return cmdRepair({ root, config, argv });
    if (command === 'ci') return cmdCi({ root, config, argv });
    if (command === 'pr-report') return cmdPrReport({ root, argv });
    if (command === 'validate') return cmdValidate({ root, config, argv });
    if (command === 'closeout') return cmdCloseout({ root, config, argv });
    if (command === 'codex') return cmdCodex({ root, config, task: argv.join(' ') });
    if (command === 'index') return cmdIndex({ root, config });
    if (command === 'guard') return cmdGuard({ root, config, argv });
    if (command === 'post-check') return cmdPostCheck({ root, config, argv });
    if (command === 'security') return cmdSecurity({ root, config, argv });
    if (command === 'benchmark') return cmdBenchmark({ root, config, argv });
    if (command === 'sandbox') return cmdSandbox({ root, argv });
    if (command === 'knowledge') return cmdKnowledge({ root, argv });
    if (command === 'status') return cmdStatus({ root, config });
    if (command === 'init') return cmdInit({ root });
    throw new Error(`Unknown command: ${command}`);
  } catch (err) {
    console.error(`\n[harness] ERROR: ${err.message || err}\n`);
    process.exitCode = 1;
  }
}

function help() {
  console.log(`ScopeLatch Agent Engineering Harness

Usage:
  node harness/cli.mjs plan "<task>"
  node harness/cli.mjs prompt "<task>"
  node harness/cli.mjs run "<task>"
  node harness/cli.mjs repair --run .harness/runs/<run>
  node harness/cli.mjs ci --base origin/main
  node harness/cli.mjs pr-report --run .harness/runs/<run>
  node harness/cli.mjs validate --plan .harness/runs/<run>/validation-plan.json
  node harness/cli.mjs closeout --run .harness/runs/<run>
  node harness/cli.mjs codex "<task>"
  node harness/cli.mjs index
  node harness/cli.mjs guard --run .harness/runs/<run>
  node harness/cli.mjs post-check --run .harness/runs/<run>
  node harness/cli.mjs security [--profile private-development|public-release]
  node harness/cli.mjs security --release-check
  node harness/cli.mjs benchmark --run .harness/runs/<run>
  node harness/cli.mjs sandbox [--build] [--dry-run] [--write-workspace] -- <command> [args...]
  node harness/cli.mjs sandbox --verify [--build]
  node harness/cli.mjs knowledge --backfill [--rebuild]
  node harness/cli.mjs knowledge --list
  node harness/cli.mjs knowledge --promote <candidate-id> --reviewer <name> --reason <reason>
  node harness/cli.mjs knowledge --reject <candidate-id> --reviewer <name> --reason <reason>
  node harness/cli.mjs status
  node harness/cli.mjs version
  node harness/cli.mjs init
`);
}

function cmdPlan({ root, config, task }) {
  if (!task.trim()) throw new Error('Missing task text. Example: node harness/cli.mjs plan "Implement an order refund endpoint"');
  const runData = createRun({ root, config, task });
  printRunSummary(runData);
  return runData;
}

function cmdPrompt({ root, config, task }) {
  if (!task.trim()) throw new Error('Missing task text.');
  const runData = createRun({ root, config, task });
  console.log(`\nCodex prompt written to: ${path.relative(root, runData.promptPath)}\n`);
  return runData;
}

function cmdRun({ root, config, argv }) {
  const task = taskFromArgs(argv, runOptionFlags());
  if (!task.trim()) throw new Error('Missing task text. Example: node harness/cli.mjs run "Fix API validation drift"');
  if (argv.includes('--skip-validate')) {
    throw new Error('--skip-validate is not supported for `run`; use `plan` when only planning is intended.');
  }

  const runData = createRun({ root, config, task, includeWorkingTreeChanges: true, captureBaseline: false });
  printRunSummary(runData);

  const closeout = closeRun({ root, runDir: runData.runDir, config, guardOptions: guardOptions(argv, config) });
  printGuardResult({ root, ...closeout.guard });
  if (closeout.validation) printValidationResult({ root, ...closeout.validation });
  if (closeout.postValidationGuard) {
    console.log('Post-validation guard:');
    printGuardResult({ root, ...closeout.postValidationGuard });
  }
  printReportResult({ root, ...closeout.report });
  if (closeout.status === 'failed') process.exitCode = 1;
  return { runData, closeout };
}

function cmdValidate({ root, config, argv }) {
  const planPath = getArg(argv, '--plan') || argv[0];
  if (!planPath) throw new Error('Missing --plan path.');
  const absolute = path.isAbsolute(planPath) ? planPath : path.join(root, planPath);
  const closeout = closeRun({ root, runDir: path.dirname(absolute), config, guardOptions: guardOptions(argv, config) });
  printGuardResult({ root, ...closeout.guard });
  if (closeout.validation) printValidationResult({ root, ...closeout.validation });
  if (closeout.postValidationGuard) printGuardResult({ root, ...closeout.postValidationGuard });
  printReportResult({ root, ...closeout.report });
  if (closeout.status === 'failed') process.exitCode = 1;
  return closeout;
}

function cmdCloseout({ root, config, argv }) {
  const runArg = getArg(argv, '--run') || argv[0];
  if (!runArg) throw new Error('Missing --run path.');
  const runDir = path.isAbsolute(runArg) ? runArg : path.join(root, runArg);
  return cmdValidate({
    root,
    config,
    argv: [
      '--plan',
      path.join(runDir, 'validation-plan.json'),
      ...runOptionFlags().filter((flag) => argv.includes(flag))
    ]
  });
}

function cmdRepair({ root, config, argv }) {
  const runArg = getArg(argv, '--run') || argv[0];
  if (!runArg) throw new Error('Missing --run path. Example: node harness/cli.mjs repair --run .harness/runs/<run>');
  const runDir = path.isAbsolute(runArg) ? runArg : path.join(root, runArg);
  const repair = repairRun({
    root,
    runDir,
    config,
    options: {
      promptOnly: argv.includes('--prompt-only') || argv.includes('--dry-run'),
      maxRounds: numericArg(argv, '--max-rounds'),
      guardOptions: guardOptions(argv, config)
    }
  });
  printRepairResult({ root, ...repair });
  if (['failed', 'blocked'].includes(repair.result.status)) process.exitCode = 1;
  return repair.result;
}

function cmdCi({ root, config, argv }) {
  const baseRef = getArg(argv, '--base') || 'HEAD';
  const task = `Local CI validation against ${baseRef}`;
  const runData = createRun({ root, config, task, baseRef, includeWorkingTreeChanges: true, captureBaseline: false });
  printRunSummary(runData);
  const closeout = closeRun({ root, runDir: runData.runDir, config, guardOptions: guardOptions(argv, config) });
  printGuardResult({ root, ...closeout.guard });
  if (closeout.validation) printValidationResult({ root, ...closeout.validation });
  if (closeout.postValidationGuard) {
    console.log('Post-validation guard:');
    printGuardResult({ root, ...closeout.postValidationGuard });
  }
  printReportResult({ root, ...closeout.report });
  if (closeout.knowledge?.status && closeout.knowledge.status !== 'skipped') {
    printKnowledgeResult({ root, ...closeout.knowledge });
  }
  console.log(`CI status: ${closeout.status}\n`);
  if (closeout.status === 'failed') process.exitCode = 1;
  return {
    runData,
    guard: closeout.guard.result,
    validation: closeout.validation?.result || null,
    postValidationGuard: closeout.postValidationGuard?.result || null,
    report: closeout.report
  };
}

function cmdPrReport({ root, argv }) {
  const runArg = getArg(argv, '--run') || argv[0];
  if (!runArg) throw new Error('Missing --run path. Example: node harness/cli.mjs pr-report --run .harness/runs/<run>');
  const runDir = path.isAbsolute(runArg) ? runArg : path.join(root, runArg);
  const report = writePrReport({ root, runDir });
  printReportResult({ root, ...report });
  const knowledge = recordFailureKnowledge({ root, runDir });
  if (knowledge.status !== 'skipped') printKnowledgeResult({ root, ...knowledge });
  return report;
}

function cmdCodex({ root, config, task }) {
  if (!task.trim()) throw new Error('Missing task text.');
  const runData = createRun({ root, config, task });
  const codexCheck = checkCodexAvailable({ root });
  if (codexCheck.exitCode !== 0) {
    console.log(`\nCodex CLI was not found. Prompt is ready at: ${path.relative(root, runData.promptPath)}\n`);
    return;
  }
  console.log(`\nRunning Codex with prompt: ${path.relative(root, runData.promptPath)}\n`);
  updateRunManifest({ runDir: runData.runDir, patch: { status: 'running', phase: 'codex-running' } });
  const prompt = fs.readFileSync(runData.promptPath, 'utf8');
  const res = runCodex({
    root,
    input: prompt,
    env: codexBindingEnvironment({ root, config, manifest: runData.manifest })
  });
  process.stdout.write(res.stdout || '');
  process.stderr.write(res.stderr || '');
  const codexResultPath = path.join(runData.runDir, 'codex-result.json');
  writeJson(codexResultPath, {
    generatedAt: new Date().toISOString(),
    exitCode: res.exitCode,
    signal: res.signal,
    durationMs: res.durationMs,
    error: res.error
  });
  updateRunManifest({
    runDir: runData.runDir,
    patch: {
      status: res.exitCode === 0 ? 'running' : 'failed',
      phase: res.exitCode === 0 ? 'codex-complete' : 'codex-exec-failed',
      artifacts: { codexResult: codexResultPath }
    }
  });
  if (res.exitCode !== 0) {
    const report = writePrReport({ root, runDir: runData.runDir });
    printReportResult({ root, ...report });
    const knowledge = recordFailureKnowledge({ root, runDir: runData.runDir });
    if (knowledge.status !== 'skipped') printKnowledgeResult({ root, ...knowledge });
    process.exitCode = res.exitCode;
    return { runData, codex: res, report, knowledge };
  }

  const closeout = closeRun({ root, runDir: runData.runDir, config });
  printGuardResult({ root, ...closeout.guard });
  if (closeout.validation) printValidationResult({ root, ...closeout.validation });
  if (closeout.postValidationGuard) {
    console.log('Post-validation guard:');
    printGuardResult({ root, ...closeout.postValidationGuard });
  }
  printReportResult({ root, ...closeout.report });
  if (closeout.knowledge?.status && closeout.knowledge.status !== 'skipped') {
    printKnowledgeResult({ root, ...closeout.knowledge });
  }
  if (closeout.status === 'failed') process.exitCode = 1;
  return { runData, codex: res, closeout };
}

function cmdKnowledge({ root, argv }) {
  if (argv.includes('--backfill')) {
    const result = backfillFailureKnowledge({ root, rebuild: argv.includes('--rebuild') });
    console.log(`Knowledge backfill: ${result.status}`);
    console.log(`Scanned failures: ${result.scanned}`);
    console.log(`New records: ${result.recorded}`);
    console.log(`Existing records: ${result.existing || 0}\n`);
    return result;
  }
  if (argv.includes('--list')) {
    const candidates = listRuleCandidates({ root });
    console.log(JSON.stringify({ schemaVersion: 1, candidates }, null, 2));
    return candidates;
  }
  const promoteId = getArg(argv, '--promote');
  const rejectId = getArg(argv, '--reject');
  if (promoteId || rejectId) {
    const input = {
      root,
      candidateId: promoteId || rejectId,
      reviewer: getArg(argv, '--reviewer'),
      reason: getArg(argv, '--reason')
    };
    const result = promoteId ? promoteRuleCandidate(input) : rejectRuleCandidate(input);
    console.log(`Knowledge candidate ${result.status}: ${input.candidateId}`);
    return result;
  }
  throw new Error('Use knowledge --backfill, --list, --promote, or --reject.');
}

function cmdIndex({ root, config }) {
  const files = gitFiles(root);
  const indexes = buildHarnessIndexes({ root, files, config });
  const written = writeHarnessIndexes({ root, indexes });
  const rel = (p) => path.relative(root, p);
  console.log(`\nHarness index written: ${rel(indexDirPath(root))}`);
  console.log(`Repo files: ${indexes.repoIndex.fileCount}`);
  console.log(`Import nodes: ${indexes.importGraph.nodeCount}`);
  console.log(`Import edges: ${indexes.importGraph.edgeCount}`);
  console.log(`Tests: ${indexes.testIndex.testCount}`);
  console.log(`Owners: ${indexes.ownershipIndex.owners.length}`);
  console.log(`Canonical source: ${indexes.sourceAuthority.root || 'not detected'}`);
  console.log(`\nFiles:`);
  for (const file of written) console.log(`- ${rel(file)}`);
  console.log('');
  return indexes;
}

function cmdPostCheck({ root, config, argv }) {
  const runArg = getArg(argv, '--run') || argv[0];
  if (!runArg) throw new Error('Missing --run path.');
  const runDir = path.isAbsolute(runArg) ? runArg : path.join(root, runArg);
  const result = checkRunDiff({ root, runDir, config, options: guardOptions(argv, config) });
  console.log(JSON.stringify(result));
  if (result.status === 'failed') process.exitCode = 1;
  return result;
}

function cmdSecurity({ root, config, argv }) {
  const report = scanRepositorySecurity({
    root,
    config,
    options: {
      releaseCheck: argv.includes('--release-check'),
      profile: getArg(argv, '--profile'),
      skipHistory: argv.includes('--skip-history'),
      skipDependencyAudit: argv.includes('--skip-dependency-audit')
    }
  });
  const reportPath = path.join(root, '.harness', 'security', 'latest-security-report.json');
  writeJson(reportPath, report);
  console.log(`Security status: ${report.status}`);
  console.log(`Blockers: ${report.summary.blockerCount}`);
  console.log(`Warnings: ${report.summary.warningCount}`);
  console.log(`Report: ${path.relative(root, reportPath)}`);
  if (report.status === 'failed') process.exitCode = 1;
  return report;
}

function cmdBenchmark({ root, config, argv }) {
  const runArg = getArg(argv, '--run') || argv.find((item) => !item.startsWith('--'));
  if (!runArg) throw new Error('Missing --run path.');
  const runDir = path.isAbsolute(runArg) ? runArg : path.join(root, runArg);
  const result = benchmarkPostCheck({
    root,
    runDir,
    iterations: numericArg(argv, '--iterations') || config.performance.benchmarkIterations,
    warmupIterations: numericArg(argv, '--warmup') || config.performance.benchmarkWarmupIterations,
    budgetP95Ms: numericArg(argv, '--budget-p95-ms') || config.performance.postToolBudgetP95Ms,
    guardArgs: runOptionFlags().filter((flag) => argv.includes(flag))
  });
  const resultPath = path.join(root, '.harness', 'cache', 'performance', 'latest-post-check-benchmark.json');
  writeJson(resultPath, result);
  console.log(JSON.stringify(result, null, 2));
  console.log(`Benchmark report: ${path.relative(root, resultPath)}`);
  if (result.status === 'failed') process.exitCode = 1;
  return result;
}

function cmdVersion({ root }) {
  const version = readHarnessVersion(root);
  console.log(`${version.name} v${version.version}`);
  return version;
}

function cmdSandbox({ root, argv }) {
  const separator = argv.indexOf('--');
  const command = separator >= 0 ? argv.slice(separator + 1) : [];
  const image = getArg(argv, '--image') || DEFAULT_SANDBOX_IMAGE;
  const workspaceWritable = argv.includes('--write-workspace');
  if (argv.includes('--verify')) {
    if (workspaceWritable) throw new Error('Sandbox verification requires the default read-only workspace.');
    if (argv.includes('--build')) {
      const build = buildSandboxImage({ root, image });
      process.stdout.write(build.stdout || '');
      process.stderr.write(build.stderr || '');
      if (build.exitCode !== 0) {
        throw new Error(`Sandbox image build failed: ${build.error || build.stderr || `exit ${build.exitCode}`}`);
      }
    }
    const verification = verifySandboxRuntime({ root, image });
    const reportPath = path.join(root, '.harness', 'cache', 'sandbox', 'latest-runtime-verification.json');
    writeJson(reportPath, verification);
    console.log(JSON.stringify(verification, null, 2));
    console.log(`Sandbox verification report: ${path.relative(root, reportPath)}`);
    if (verification.status === 'failed') process.exitCode = 1;
    return verification;
  }
  const invocation = buildSandboxInvocation({ root, image, command, workspaceWritable });
  if (argv.includes('--dry-run')) {
    console.log(JSON.stringify(invocation, null, 2));
    return invocation;
  }
  if (argv.includes('--build')) {
    const build = buildSandboxImage({ root, image });
    process.stdout.write(build.stdout || '');
    process.stderr.write(build.stderr || '');
    if (build.exitCode !== 0) {
      throw new Error(`Sandbox image build failed: ${build.error || build.stderr || `exit ${build.exitCode}`}`);
    }
  }
  const result = runSandboxedCommand({ root, image, command, workspaceWritable });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.exitCode !== 0) {
    throw new Error(`Sandboxed command failed: ${result.error || result.stderr || `exit ${result.exitCode}`}`);
  }
  return result;
}

function cmdGuard({ root, config, argv }) {
  const runArg = getArg(argv, '--run') || argv[0];
  if (!runArg) throw new Error('Missing --run path. Example: node harness/cli.mjs guard --run .harness/runs/<run>');
  const runDir = path.isAbsolute(runArg) ? runArg : path.join(root, runArg);
  const { result, resultPath, manifestPath } = runDiffGuard({
    root,
    runDir,
    config,
    options: guardOptions(argv, config)
  });

  printGuardResult({ root, result, resultPath, manifestPath });
  if (result.status === 'failed') process.exitCode = 1;
  return result;
}

function runOptionFlags() {
  return [
    '--skip-validate',
    '--allow-lockfile',
    '--allow-test-deletion',
    '--allow-out-of-scope',
    '--allow-ci-workflow',
    '--allow-api-frontend-drift',
    '--allow-forbidden-dirs',
    '--allow-local-paths',
    '--release-check'
  ];
}

function taskFromArgs(argv, flags) {
  const flagSet = new Set(flags);
  return argv.filter((arg) => !flagSet.has(arg)).join(' ');
}

function guardOptions(argv, config) {
  const allowOutOfScope = argv.includes('--allow-out-of-scope');
  if (allowOutOfScope && config?.policy?.allowOutOfScopeOverride !== true) {
    throw new Error('--allow-out-of-scope is disabled by policy. Create a fresh plan that explicitly lists every intended write target.');
  }
  return {
    allowLockfile: argv.includes('--allow-lockfile'),
    allowTestDeletion: argv.includes('--allow-test-deletion'),
    allowOutOfScope,
    allowCiWorkflow: argv.includes('--allow-ci-workflow'),
    allowApiFrontendDrift: argv.includes('--allow-api-frontend-drift'),
    allowForbiddenDirs: argv.includes('--allow-forbidden-dirs'),
    allowLocalPaths: argv.includes('--allow-local-paths'),
    releaseCheck: argv.includes('--release-check')
  };
}

function printGuardResult({ root, result, resultPath, manifestPath }) {
  console.log(`\nGuard status: ${result.status}`);
  console.log(`Changed files: ${result.summary.changedFileCount}`);
  console.log(`Blockers: ${result.summary.blockerCount}`);
  console.log(`Warnings: ${result.summary.warningCount}`);
  for (const finding of result.findings) {
    console.log(`- ${finding.severity}: ${finding.id} (${finding.files.length} files)`);
  }
  console.log(`\nResult: ${path.relative(root, resultPath)}`);
  if (manifestPath) console.log(`Manifest: ${path.relative(root, manifestPath)}`);
  console.log('');
}

function printValidationResult({ root, result, resultPath, dossierPath, manifestPath }) {
  console.log(`\nValidation status: ${result.status}`);
  for (const r of result.results) {
    console.log(`- ${r.id}: ${r.status}${r.command ? ` (${r.command})` : ''}`);
  }
  console.log(`\nResult: ${path.relative(root, resultPath)}`);
  console.log(`Dossier: ${path.relative(root, dossierPath)}\n`);
  if (manifestPath) console.log(`Manifest: ${path.relative(root, manifestPath)}\n`);
}

function printRepairResult({ root, result, promptPath = null, statePath = null, manifestPath = null }) {
  console.log(`\nRepair status: ${result.status}`);
  if (result.reason) console.log(`Reason: ${result.reason}`);
  if (result.round) console.log(`Round: ${result.round}`);
  if (result.maxRounds) console.log(`Max rounds: ${result.maxRounds}`);
  if (promptPath) console.log(`Prompt: ${path.relative(root, promptPath)}`);
  if (statePath) console.log(`State: ${path.relative(root, statePath)}`);
  if (manifestPath) console.log(`Manifest: ${path.relative(root, manifestPath)}`);
  console.log('');
}

function printReportResult({ root, reportPath, metricsPath }) {
  console.log(`PR report: ${path.relative(root, reportPath)}`);
  console.log(`Metrics: ${path.relative(root, metricsPath)}`);
}

function printKnowledgeResult({ root, status, count, failuresPath, candidatePath = null, rulesPath = null }) {
  console.log(`Knowledge: ${status} (${count} matching failures)`);
  if (failuresPath) console.log(`Failures: ${path.relative(root, failuresPath)}`);
  if (candidatePath) console.log(`Rule candidates: ${path.relative(root, candidatePath)}`);
  if (rulesPath) console.log(`Rules: ${path.relative(root, rulesPath)}`);
}

function cmdStatus({ root, config }) {
  const stateFile = path.join(root, config.stateDir, 'latest-run.json');
  const state = readJson(stateFile, null);
  const manifest = state?.files?.runManifest ? readRunManifest(state.files.runManifest) : null;
  const configHealth = buildConfigHealth({ root, config });
  console.log(JSON.stringify({
    configHealth,
    index: readIndexStatus(root),
    latestRun: state ? {
      runDir: path.relative(root, state.runDir),
      task: state.task,
      risk: state.risk,
      generatedAt: state.generatedAt,
      files: state.files,
      manifest: manifest ? {
        schemaVersion: manifest.schemaVersion,
        status: manifest.status,
        phase: manifest.phase,
        updatedAt: manifest.updatedAt,
        artifacts: manifest.artifacts
      } : null
    } : null
  }, null, 2));
  if (configHealth.status === 'failed') process.exitCode = 1;
}

function readIndexStatus(root) {
  const dir = indexDirPath(root);
  const repoIndex = readJson(path.join(dir, 'repo-index.json'), null);
  const importGraph = readJson(path.join(dir, 'import-graph.json'), null);
  const testIndex = readJson(path.join(dir, 'test-index.json'), null);
  const ownershipIndex = readJson(path.join(dir, 'ownership-index.json'), null);
  const sourceAuthority = readJson(path.join(dir, 'source-authority.json'), null);
  if (!repoIndex || !importGraph || !testIndex || !ownershipIndex || !sourceAuthority) {
    return {
      status: 'missing',
      indexDir: path.relative(root, dir),
      message: 'Run node harness/cli.mjs index to build project indexes.'
    };
  }
  return {
    status: 'ready',
    indexDir: path.relative(root, dir),
    generatedAt: repoIndex.generatedAt,
    fileCount: repoIndex.fileCount,
    importNodeCount: importGraph.nodeCount,
    importEdgeCount: importGraph.edgeCount,
    testCount: testIndex.testCount,
    ownerCount: ownershipIndex.owners?.length || 0,
    sourceAuthority
  };
}

function cmdInit({ root }) {
  const example = path.join(root, '.harness', 'harness.config.example.json');
  const target = path.join(root, '.harness', 'harness.config.json');
  if (exists(target)) {
    console.log(`Config already exists: ${path.relative(root, target)}`);
    return;
  }
  if (!exists(example)) throw new Error(`Missing example config at ${example}`);
  ensureDir(path.dirname(target));
  fs.copyFileSync(example, target);
  console.log(`Created ${path.relative(root, target)}`);
}

function createRun({ root, config, task, baseRef = null, includeWorkingTreeChanges = false, captureBaseline = true }) {
  const baselineSnapshot = captureBaseline
    ? readGuardedWorkingTreeSnapshot(root, { cacheConfig: config.performance || {} })
    : [];
  const taskInfo = parseTask(task);
  const files = gitFiles(root);
  const contextPack = buildContextPack({ root, taskInfo, files, config });
  const impactReport = analyzeImpact({ root, taskInfo, contextPack, files, config, baseRef, includeWorkingTreeChanges });
  const validationPlan = planValidation({ root, config, impactReport });
  const applicableRules = loadApplicableRules({ root, impactReport });
  const prompt = buildCodexPrompt({
    task,
    contextPackMarkdown: contextPack.markdown,
    impactReport,
    validationPlan,
    config,
    applicableRules
  });

  const runId = `${nowId()}-${slugify(task)}`;
  const runDir = path.join(root, config.outputDir, runId);
  const sessionBinding = createSessionLease({ root, config, runId });
  ensureDir(runDir);
  const contextPath = path.join(runDir, 'context-pack.md');
  const contextJsonPath = path.join(runDir, 'context-pack.json');
  const impactPath = path.join(runDir, 'impact-report.json');
  const validationPath = path.join(runDir, 'validation-plan.json');
  const promptPath = path.join(runDir, 'codex-prompt.md');
  const baselinePath = path.join(runDir, 'working-tree-baseline.json');
  const manifestPath = path.join(runDir, 'run-manifest.json');

  writeText(contextPath, contextPack.markdown);
  writeJson(contextJsonPath, omit(contextPack, ['markdown']));
  writeJson(impactPath, impactReport);
  writeJson(validationPath, validationPlan);
  writeText(promptPath, prompt);
  writeJson(baselinePath, baselineSnapshot);
  const manifest = buildRunManifest({
    root,
    config,
    task,
    runId,
    runDir,
    impactReport,
    validationPlan,
    baselineSnapshot,
    sessionBinding,
    artifacts: {
      contextPack: contextPath,
      contextPackJson: contextJsonPath,
      impactReport: impactPath,
      validationPlan: validationPath,
      codexPrompt: promptPath,
      baselineSnapshot: baselinePath,
      runManifest: manifestPath
    }
  });
  writeRunManifest({ runDir, manifest });

  const stateDir = path.join(root, config.stateDir);
  ensureDir(stateDir);
  const state = {
    task,
    runId,
    taskFingerprint: manifest.task.fingerprint,
    expiresAt: manifest.binding.expiresAt,
    generatedAt: new Date().toISOString(),
    branch: currentBranch(root),
    baseRef,
    runDir,
    risk: impactReport.risk,
    files: {
      contextPack: contextPath,
      impactReport: impactPath,
      validationPlan: validationPath,
      codexPrompt: promptPath,
      baselineSnapshot: baselinePath,
      runManifest: manifestPath
    }
  };
  writeJson(path.join(stateDir, 'latest-run.json'), state);

  return { runDir, contextPath, impactPath, validationPath, promptPath, manifestPath, manifest, contextPack, impactReport, validationPlan, applicableRules };
}

function printRunSummary(runData) {
  const rel = (p) => path.relative(findGitRoot(process.cwd()), p);
  console.log(`\nHarness run: ${rel(runData.runDir)}`);
  console.log(`Risk: ${runData.impactReport.risk.level} (score ${runData.impactReport.risk.score})`);
  console.log(`Must-read files: ${runData.contextPack.mustRead.length}`);
  console.log(`Explicit write targets: ${runData.impactReport.writeTargets.length}`);
  console.log(`Direct targets: ${runData.impactReport.directTargets.length}`);
  console.log(`Reverse dependents: ${runData.impactReport.reverseDependents.length}`);
  console.log(`Validation commands: ${runData.validationPlan.commands.length}`);
  console.log(`\nFiles:`);
  console.log(`- ${rel(runData.contextPath)}`);
  console.log(`- ${rel(runData.impactPath)}`);
  console.log(`- ${rel(runData.validationPath)}`);
  console.log(`- ${rel(runData.promptPath)}`);
  console.log(`- ${rel(runData.manifestPath)}\n`);
}

function getArg(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  return argv[index + 1] || null;
}

function numericArg(argv, name) {
  const value = getArg(argv, name);
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function omit(obj, keys) {
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
}

main();
