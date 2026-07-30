import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidencePath = path.join(root, 'docs', 'evidence', 'scope-evolution-baseline.json');
const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
const privateSource = argValue('--private-source');

verifyEvidenceShape(evidence);

const publicStage = evidence.stages.find((stage) => stage.sourceVisibility === 'public-repository');
if (!publicStage) throw new Error('Evidence has no public-repository stage.');
const publicObserved = measureStage(root, publicStage.verificationRef || 'HEAD');
compareStage(publicStage, publicObserved);

const version = JSON.parse(fs.readFileSync(path.join(root, 'harness', 'version.json'), 'utf8'));
if (version.version !== publicStage.id.replace(/^v/, '')) {
  throw new Error(`Version mismatch: evidence=${publicStage.id}, harness/version.json=${version.version}`);
}
console.log(`PUBLIC_STAGE_VERIFIED ${publicStage.id} ${formatMetrics(publicObserved.metrics)}`);

if (privateSource) {
  const resolvedPrivateSource = path.resolve(privateSource);
  for (const stage of evidence.stages.filter((item) => item.sourceVisibility === 'private-project-history')) {
    compareStage(stage, measureStage(resolvedPrivateSource, stage.commit));
  }
  verifyUsageFloor(resolvedPrivateSource, evidence.usageEvidence);
  console.log('PRIVATE_STAGES_VERIFIED historical commits and runtime artifact floors');
} else {
  console.log('PRIVATE_STAGES_SKIPPED pass --private-source <repository-path> to verify maintainer-only history');
}

function measureStage(repo, ref) {
  const worktreeMode = ref === 'WORKTREE';
  const files = worktreeMode
    ? walkFiles(repo).map((file) => path.relative(repo, file).replaceAll('\\', '/'))
    : git(repo, ['ls-tree', '-r', '--name-only', ref]).split(/\r?\n/).filter(Boolean);
  const testFiles = files.filter((file) => /^harness\/tests\/.+\.test\.mjs$/.test(file));
  const engineModules = files.filter((file) => /^harness\/lib\/.+\.mjs$/.test(file));
  const content = (file) => {
    if (!files.includes(file)) return '';
    return worktreeMode
      ? fs.readFileSync(path.join(repo, file), 'utf8')
      : git(repo, ['show', `${ref}:${file}`]);
  };
  const preTool = content('.codex/hooks/pre_tool_use_policy.py');
  const stopHook = content('.codex/hooks/stop_guard.py');
  const impactAnalyzer = content('harness/lib/impact-analyzer.mjs');
  let assertionOccurrences = 0;
  const assertionPattern = /assert\.(?:equal|deepEqual|ok|match|throws|doesNotMatch|notEqual|rejects)/g;
  for (const file of testFiles) assertionOccurrences += (content(file).match(assertionPattern) || []).length;

  const capabilities = {
    planningAndContext: files.includes('harness/lib/context-builder.mjs'),
    validationGraph: files.includes('harness/lib/validation-planner.mjs'),
    diffGuard: files.includes('harness/lib/guard.mjs'),
    repairLoop: files.includes('harness/lib/repair.mjs'),
    reporting: files.includes('harness/lib/report.mjs'),
    knowledge: files.includes('harness/lib/knowledge.mjs'),
    preToolHook: files.includes('.codex/hooks/pre_tool_use_policy.py'),
    postToolHook: files.includes('.codex/hooks/post_tool_use_guard.py'),
    stopHook: files.includes('.codex/hooks/stop_guard.py'),
    sessionBinding: files.includes('harness/lib/session-binding.mjs'),
    sourceAuthority: files.includes('harness/lib/source-authority.mjs'),
    closeoutPipeline: files.includes('harness/lib/closeout.mjs'),
    mandatoryCloseout: /validated Harness closeout|closeout-complete/.test(preTool),
    securityScanner: files.includes('harness/lib/security-scanner.mjs'),
    sandbox: files.includes('harness/lib/sandbox.mjs'),
    explicitWriteTargets: /writeTargets/.test(impactAnalyzer),
    automaticStopCloseout: /run_auto_closeout|autoCloseoutOnStop/.test(stopHook)
  };
  const v4TrustControls = {
    closedOutcomes: files.includes('harness/lib/v4/outcome-engine.mjs'),
    contentAddressedEvidence: files.includes('harness/lib/v4/evidence-store.mjs'),
    gitCandidateBinding: files.includes('harness/lib/v4/git-candidate.mjs'),
    invariantCatalog: files.includes('harness/lib/v4/invariant-catalog.mjs'),
    independentAuditor: files.includes('harness/auditor/lib/auditor.mjs'),
    atomicState: files.includes('harness/lib/v4/concurrent-state.mjs'),
    safeExecutor: files.includes('harness/lib/v4/safe-executor.mjs'),
    shadowQualification: files.includes('harness/lib/v4/shadow-qualification.mjs'),
    formalCutover: files.includes('harness/auditor/lib/formal-cutover.mjs'),
    v4OnlyRuntime: JSON.parse(content('harness/version.json') || '{}').version === '4.0.0'
      && !files.includes('harness/lib/v4/legacy-v3-adapter.mjs')
  };

  return {
    metrics: {
      engineModules: engineModules.length,
      testFiles: testFiles.length,
      assertionOccurrences,
      verifiedControls: Object.values(capabilities).filter(Boolean).length
    },
    capabilities,
    v4TrustControls
  };
}

function compareStage(expected, observed) {
  for (const [key, value] of Object.entries(expected.metrics)) {
    if (observed.metrics[key] !== value) {
      throw new Error(`${expected.id} metric mismatch for ${key}: expected ${value}, observed ${observed.metrics[key]}`);
    }
  }
  for (const key of evidence.capabilityKeys) {
    if (observed.capabilities[key] !== expected.capabilities[key]) {
      throw new Error(`${expected.id} capability mismatch for ${key}: expected ${expected.capabilities[key]}, observed ${observed.capabilities[key]}`);
    }
  }
  for (const key of evidence.v4TrustControlKeys) {
    if ((expected.v4TrustControls || {})[key] !== undefined
      && observed.v4TrustControls[key] !== expected.v4TrustControls[key]) {
      throw new Error(`${expected.id} V4 trust-control mismatch for ${key}: expected ${expected.v4TrustControls[key]}, observed ${observed.v4TrustControls[key]}`);
    }
  }
}

function verifyUsageFloor(repo, expected) {
  const runsRoot = path.join(repo, '.harness', 'runs');
  if (!fs.existsSync(runsRoot)) throw new Error('Private source has no .harness/runs directory.');
  const runDirectories = fs.readdirSync(runsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
  const files = walkFiles(runsRoot);
  requireFloor('runDirectories', runDirectories, expected.runDirectories);
  requireFloor('runManifests', files.filter((file) => path.basename(file) === 'run-manifest.json').length, expected.runManifests);
  requireFloor('prReports', files.filter((file) => path.basename(file) === 'pr-report.md').length, expected.prReports);
  verifyArtifactFloor(files, 'validation-result.json', expected.validationResults);
  verifyArtifactFloor(files, 'guard-result.json', expected.initialGuardResults);
  verifyArtifactFloor(files, 'post-validation-guard-result.json', expected.postValidationGuardResults);
}

function verifyArtifactFloor(files, fileName, expected) {
  const matches = files.filter((file) => path.basename(file) === fileName);
  requireFloor(`${fileName}.files`, matches.length, expected.files);
  const distribution = {};
  let parseErrors = 0;
  for (const file of matches) {
    try {
      const status = String(JSON.parse(fs.readFileSync(file, 'utf8')).status || '<missing>');
      distribution[status] = (distribution[status] || 0) + 1;
    } catch {
      parseErrors += 1;
    }
  }
  if (parseErrors > expected.parseErrors) throw new Error(`${fileName} parse errors increased to ${parseErrors}.`);
  for (const [status, count] of Object.entries(expected.distribution)) {
    requireFloor(`${fileName}.${status}`, distribution[status] || 0, count);
  }
}

function verifyEvidenceShape(data) {
  if (data.schemaVersion !== 2) throw new Error(`Unsupported evidence schema ${data.schemaVersion}.`);
  if (!Array.isArray(data.stages) || data.stages.length !== 6) throw new Error('Evidence must contain six comparison stages.');
  if (!Array.isArray(data.capabilityKeys) || data.capabilityKeys.length !== 17) throw new Error('Evidence must contain 17 capability keys.');
  if (!Array.isArray(data.v4TrustControlKeys) || data.v4TrustControlKeys.length !== 10) {
    throw new Error('Evidence must contain 10 V4 trust-control keys.');
  }
  for (const stage of data.stages) {
    const worktreeStage = stage.sourceVisibility === 'public-repository'
      && stage.verificationRef === 'WORKTREE'
      && stage.commit === null;
    if (!worktreeStage && !/^[a-f0-9]{40}$/.test(stage.commit)) {
      throw new Error(`Invalid commit for ${stage.id}.`);
    }
    if (Object.keys(stage.capabilities || {}).length !== data.capabilityKeys.length) throw new Error(`Incomplete capabilities for ${stage.id}.`);
    if (stage.id === 'v4.0.0'
      && Object.keys(stage.v4TrustControls || {}).length !== data.v4TrustControlKeys.length) {
      throw new Error('V4 evidence has an incomplete trust-control inventory.');
    }
  }
}

function walkFiles(directory) {
  const out = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ['.git', 'node_modules', '__pycache__'].includes(entry.name)) {
      continue;
    }
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(absolute));
    else if (entry.isFile()) out.push(absolute);
  }
  return out;
}

function requireFloor(label, observed, minimum) {
  if (observed < minimum) throw new Error(`${label} regressed: expected at least ${minimum}, observed ${observed}`);
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  if (!process.argv[index + 1]) throw new Error(`${name} requires a path.`);
  return process.argv[index + 1];
}

function formatMetrics(metrics) {
  return `modules=${metrics.engineModules} tests=${metrics.testFiles} assertions=${metrics.assertionOccurrences} controls=${metrics.verifiedControls}/17`;
}
