import path from 'node:path';
import { readJson, exists, normalizePath } from './common.mjs';
import { detectPackageManager, readPackageJson, resolveScriptCommand } from './repo.mjs';
import { discoverSourceAuthority, interpolateCanonicalSource } from './source-authority.mjs';

const requiredExcludePaths = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.harness/runs',
  '.harness/state',
  '.harness/cache',
  '.harness/security',
  '.codex/hooks/__pycache__'
];

const requiredForbiddenPaths = [
  '.harness/runs',
  '.harness/state',
  '.harness/cache',
  '.harness/security'
];

const riskRuleKeys = [
  'publicApiPatterns',
  'databasePatterns',
  'authPatterns',
  'paymentPatterns',
  'sharedPatterns',
  'buildSystemPatterns'
];

const commandCandidates = {
  lint: ['lint', 'check:lint'],
  typecheck: ['typecheck', 'check:types', 'tsc', 'type-check'],
  testUnit: ['test:unit', 'unit', 'test'],
  testIntegration: ['test:integration', 'integration:test', 'test:int'],
  testContract: ['test:contract', 'contract:test', 'test:api'],
  testE2E: ['test:e2e', 'e2e', 'e2e:test'],
  build: ['build', 'compile'],
  generateClient: ['generate:client', 'codegen', 'generate', 'openapi:generate'],
  fullCI: ['ci', 'check', 'verify']
};

const defaultConfig = {
  repoName: 'unknown',
  packageManager: 'auto',
  outputDir: '.harness/runs',
  stateDir: '.harness/state',
  policy: {
    planMaxAgeMinutes: 240,
    requireSessionBinding: true
  },
  performance: {
    guardHashCache: true,
    guardHashCacheMaxEntries: 5000,
    postToolBudgetP95Ms: 350,
    benchmarkIterations: 20,
    benchmarkWarmupIterations: 3
  },
  security: {
    profile: 'private-development',
    scanSecrets: true,
    scanHighEntropy: true,
    scanLocalAbsolutePaths: true,
    requireLicenseForRelease: true,
    maxFileBytesToScan: 500000,
    entropyThreshold: 4.2,
    entropyMinLength: 20,
    historyMaxCommits: 100,
    historyCommitTimeoutMs: 15000,
    historyMaxBytesPerCommit: 5242880,
    dependencyAuditTimeoutMs: 120000,
    licenseFileNames: ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING']
  },
  context: {
    maxMustReadFiles: 18,
    maxRelatedFiles: 20,
    maxRelatedTests: 12,
    maxFileBytesToScan: 220000,
    controlPlane: {
      taskTokens: ['harness', 'codex', 'guard', 'closeout'],
      pathPatterns: ['harness/**', '.harness/**', '.codex/hooks/**', '.github/workflows/**', 'AGENTS.md'],
      activeBonus: 120,
      outsidePenalty: -120
    },
    sourcePriority: {
      autoDetectCanonicalSource: true,
      canonicalSourceRoot: null,
      phaseSearchRoot: 'versions',
      canonicalMarkers: ['app/backend', 'app/frontend'],
      authorityManifestPath: '.harness/source-authority.json',
      requireAuthorityManifest: false,
      activeSourceRoots: [],
      referenceSourceRoots: [],
      historicalPathPatterns: ['**/archive/**', '**/archives/**'],
      generatedPathPatterns: ['**/generated/**', '**/*_report.json', '**/*validation-report*'],
      activeBonus: 40,
      referenceBonus: 8,
      historicalPenalty: -30,
      generatedPenalty: -35,
      deduplicateExactContent: true,
      includeGeneratedInMustRead: false,
      preferActiveTests: true
    },
    excludePathPatterns: [
      '**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/.next/**',
      '**/coverage/**', '**/vendor/**', '**/.turbo/**', '**/.cache/**',
      '**/__pycache__/**', '**/.venv/**', '**/venv/**',
      '**/.playwright-cli/**', '.playwright-cli/**',
      '**/.harness/runs/**', '**/.harness/state/**', '**/.harness/cache/**', '**/.harness/security/**',
      '**/.codex/hooks/__pycache__/**'
    ]
  },
  changeBudget: {
    maxRepairRounds: 3,
    forbiddenDirs: ['infra/prod', 'secrets', '.harness/runs', '.harness/state', '.harness/cache', '.harness/security'],
    escalateOn: [
      'public-api-change', 'database-migration', 'auth-change', 'payment-change',
      'permission-change', 'build-system-change'
    ]
  },
  riskRules: {
    publicApiPatterns: ['**/api/**', '**/routes/**', '**/schema/**', '**/*openapi*', '**/*.graphql', '**/*.proto'],
    databasePatterns: ['**/migrations/**', '**/schema.sql', '**/prisma/**', '**/drizzle/**', '**/models/**'],
    authPatterns: ['**/auth/**', '**/authorization/**', '**/permissions/**', '**/rbac/**', '**/session/**'],
    paymentPatterns: ['**/payment/**', '**/billing/**', '**/refund/**', '**/ledger/**', '**/settlement/**', '**/balance/**'],
    sharedPatterns: ['**/shared/**', '**/common/**', '**/utils/**', '**/types/**', '**/packages/**'],
    buildSystemPatterns: ['package.json', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'turbo.json', 'nx.json', 'vite.config.*', 'webpack.config.*', 'tsconfig*.json', '.github/workflows/**']
  },
  commands: {
    lint: 'auto',
    typecheck: 'auto',
    test: 'auto',
    testUnit: 'auto',
    testIntegration: 'auto',
    testContract: 'auto',
    testE2E: 'auto',
    build: 'auto',
    generateClient: 'auto',
    fullCI: 'auto'
  }
};

export function loadConfig(root) {
  const file = findConfigFile(root);
  const userConfig = file ? readJson(file, {}) : {};
  const merged = deepMerge(defaultConfig, userConfig || {});
  const priority = merged.context.sourcePriority;
  merged.sourceAuthority = discoverSourceAuthority({
    root,
    configuredRoot: priority.autoDetectCanonicalSource === false ? priority.canonicalSourceRoot : null,
    searchRoot: priority.phaseSearchRoot,
    requiredMarkers: priority.canonicalMarkers,
    authorityManifestPath: priority.authorityManifestPath,
    requireAuthorityManifest: priority.requireAuthorityManifest
  });
  if (merged.sourceAuthority.root) {
    priority.activeSourceRoots = [...new Set([
      ...priority.activeSourceRoots,
      `${merged.sourceAuthority.root}/**`
    ])];
  }
  merged.commands = Object.fromEntries(Object.entries(merged.commands).map(([key, value]) => [
    key,
    interpolateCanonicalSource(value, merged.sourceAuthority)
  ]));
  merged.packageManager = detectPackageManager(root, merged.packageManager);
  merged.configFile = file || null;
  validateConfigSchema(merged, file || 'default config');
  return merged;
}

export function findConfigFile(root) {
  const candidates = [
    path.join(root, '.harness', 'harness.config.json'),
    path.join(root, 'harness.config.json'),
    path.join(root, '.harness', 'harness.config.example.json')
  ];
  return candidates.find(exists) || null;
}

export function validateConfigSchema(config, source = 'config') {
  const errors = [];
  const ctx = config?.context;
  const budget = config?.changeBudget;
  const rules = config?.riskRules;
  const commands = config?.commands;

  requireObject(config, 'root', errors);
  requireString(config?.repoName, 'repoName', errors);
  requireString(config?.packageManager, 'packageManager', errors);
  requireString(config?.outputDir, 'outputDir', errors);
  requireString(config?.stateDir, 'stateDir', errors);
  requireObject(config?.policy, 'policy', errors);
  requirePositiveInteger(config?.policy?.planMaxAgeMinutes, 'policy.planMaxAgeMinutes', errors);
  requireBoolean(config?.policy?.requireSessionBinding, 'policy.requireSessionBinding', errors);
  requireObject(config?.performance, 'performance', errors);
  requireBoolean(config?.performance?.guardHashCache, 'performance.guardHashCache', errors);
  requirePositiveInteger(config?.performance?.guardHashCacheMaxEntries, 'performance.guardHashCacheMaxEntries', errors);
  requirePositiveInteger(config?.performance?.postToolBudgetP95Ms, 'performance.postToolBudgetP95Ms', errors);
  requirePositiveInteger(config?.performance?.benchmarkIterations, 'performance.benchmarkIterations', errors);
  requirePositiveInteger(config?.performance?.benchmarkWarmupIterations, 'performance.benchmarkWarmupIterations', errors);
  requireObject(config?.security, 'security', errors);
  requireOneOf(config?.security?.profile, ['private-development', 'public-release'], 'security.profile', errors);
  requireBoolean(config?.security?.scanSecrets, 'security.scanSecrets', errors);
  requireBoolean(config?.security?.scanHighEntropy, 'security.scanHighEntropy', errors);
  requireBoolean(config?.security?.scanLocalAbsolutePaths, 'security.scanLocalAbsolutePaths', errors);
  requireBoolean(config?.security?.requireLicenseForRelease, 'security.requireLicenseForRelease', errors);
  requirePositiveInteger(config?.security?.maxFileBytesToScan, 'security.maxFileBytesToScan', errors);
  requireNumber(config?.security?.entropyThreshold, 'security.entropyThreshold', errors);
  requirePositiveInteger(config?.security?.entropyMinLength, 'security.entropyMinLength', errors);
  requirePositiveInteger(config?.security?.historyMaxCommits, 'security.historyMaxCommits', errors);
  requirePositiveInteger(config?.security?.historyCommitTimeoutMs, 'security.historyCommitTimeoutMs', errors);
  requirePositiveInteger(config?.security?.historyMaxBytesPerCommit, 'security.historyMaxBytesPerCommit', errors);
  requirePositiveInteger(config?.security?.dependencyAuditTimeoutMs, 'security.dependencyAuditTimeoutMs', errors);
  requireStringArray(config?.security?.licenseFileNames, 'security.licenseFileNames', errors);

  requireObject(ctx, 'context', errors);
  requirePositiveInteger(ctx?.maxMustReadFiles, 'context.maxMustReadFiles', errors);
  requirePositiveInteger(ctx?.maxRelatedFiles, 'context.maxRelatedFiles', errors);
  requirePositiveInteger(ctx?.maxRelatedTests, 'context.maxRelatedTests', errors);
  requirePositiveInteger(ctx?.maxFileBytesToScan, 'context.maxFileBytesToScan', errors);
  requireObject(ctx?.controlPlane, 'context.controlPlane', errors);
  requireNonEmptyStringArray(ctx?.controlPlane?.taskTokens, 'context.controlPlane.taskTokens', errors);
  requireNonEmptyStringArray(ctx?.controlPlane?.pathPatterns, 'context.controlPlane.pathPatterns', errors);
  requireNumber(ctx?.controlPlane?.activeBonus, 'context.controlPlane.activeBonus', errors);
  requireNumber(ctx?.controlPlane?.outsidePenalty, 'context.controlPlane.outsidePenalty', errors);
  requireStringArray(ctx?.excludePathPatterns, 'context.excludePathPatterns', errors);
  requireObject(ctx?.sourcePriority, 'context.sourcePriority', errors);
  requireBoolean(ctx?.sourcePriority?.autoDetectCanonicalSource, 'context.sourcePriority.autoDetectCanonicalSource', errors);
  requireNullableString(ctx?.sourcePriority?.canonicalSourceRoot, 'context.sourcePriority.canonicalSourceRoot', errors);
  requireString(ctx?.sourcePriority?.phaseSearchRoot, 'context.sourcePriority.phaseSearchRoot', errors);
  requireStringArray(ctx?.sourcePriority?.canonicalMarkers, 'context.sourcePriority.canonicalMarkers', errors);
  requireString(ctx?.sourcePriority?.authorityManifestPath, 'context.sourcePriority.authorityManifestPath', errors);
  requireBoolean(ctx?.sourcePriority?.requireAuthorityManifest, 'context.sourcePriority.requireAuthorityManifest', errors);
  requireStringArray(ctx?.sourcePriority?.activeSourceRoots, 'context.sourcePriority.activeSourceRoots', errors);
  requireStringArray(ctx?.sourcePriority?.referenceSourceRoots, 'context.sourcePriority.referenceSourceRoots', errors);
  requireStringArray(ctx?.sourcePriority?.historicalPathPatterns, 'context.sourcePriority.historicalPathPatterns', errors);
  requireStringArray(ctx?.sourcePriority?.generatedPathPatterns, 'context.sourcePriority.generatedPathPatterns', errors);
  requireNumber(ctx?.sourcePriority?.activeBonus, 'context.sourcePriority.activeBonus', errors);
  requireNumber(ctx?.sourcePriority?.referenceBonus, 'context.sourcePriority.referenceBonus', errors);
  requireNumber(ctx?.sourcePriority?.historicalPenalty, 'context.sourcePriority.historicalPenalty', errors);
  requireNumber(ctx?.sourcePriority?.generatedPenalty, 'context.sourcePriority.generatedPenalty', errors);
  requireBoolean(ctx?.sourcePriority?.deduplicateExactContent, 'context.sourcePriority.deduplicateExactContent', errors);
  requireBoolean(ctx?.sourcePriority?.includeGeneratedInMustRead, 'context.sourcePriority.includeGeneratedInMustRead', errors);
  requireBoolean(ctx?.sourcePriority?.preferActiveTests, 'context.sourcePriority.preferActiveTests', errors);

  requireObject(budget, 'changeBudget', errors);
  requirePositiveInteger(budget?.maxRepairRounds, 'changeBudget.maxRepairRounds', errors);
  requireStringArray(budget?.forbiddenDirs, 'changeBudget.forbiddenDirs', errors);
  requireStringArray(budget?.escalateOn, 'changeBudget.escalateOn', errors);

  requireObject(rules, 'riskRules', errors);
  for (const key of riskRuleKeys) requireStringArray(rules?.[key], `riskRules.${key}`, errors);

  requireObject(commands, 'commands', errors);
  for (const key of Object.keys(commandCandidates)) requireCommandValue(commands?.[key], `commands.${key}`, errors);
  if (Object.prototype.hasOwnProperty.call(commands || {}, 'test')) requireCommandValue(commands.test, 'commands.test', errors);

  if (errors.length) {
    throw new Error(`Invalid Harness config (${source}):\n- ${errors.join('\n- ')}`);
  }
  return true;
}

export function buildConfigHealth({ root, config }) {
  const checks = [];
  const pkg = readPackageJson(root);
  const exclusions = config.context?.excludePathPatterns || [];
  const forbiddenDirs = config.changeBudget?.forbiddenDirs || [];

  addCheck(checks, 'config-file-present', Boolean(config.configFile), config.configFile || 'No Harness config or tracked example found.');
  addCheck(
    checks,
    'canonical-source-authority',
    ['manifest-ready', 'detected', 'configured'].includes(config.sourceAuthority?.status),
    config.sourceAuthority?.root
      ? `Canonical source: ${config.sourceAuthority.root} (${config.sourceAuthority.status}).`
      : `No valid canonical source authority is available (${config.sourceAuthority?.status || 'unknown'}).`
  );
  const formalManifestRequired = config.context?.sourcePriority?.requireAuthorityManifest === true;
  addCheck(
    checks,
    'canonical-source-readiness',
    !formalManifestRequired || config.sourceAuthority?.status === 'manifest-ready',
    config.sourceAuthority?.status === 'manifest-ready'
      ? `Ready source manifest: ${config.sourceAuthority.manifestPath}.`
      : formalManifestRequired
        ? `A ready source manifest is required. ${config.sourceAuthority?.errors?.join(' ') || ''}`.trim()
        : 'Formal source manifest is optional for this configuration.'
  );

  const missingExcludes = requiredExcludePaths.filter((p) => !hasPathPattern(exclusions, p));
  addCheck(
    checks,
    'required-exclude-paths',
    missingExcludes.length === 0,
    missingExcludes.length ? `Missing exclude patterns for: ${missingExcludes.join(', ')}` : 'Harness runtime/cache paths and common generated folders are excluded.'
  );

  const missingForbidden = requiredForbiddenPaths.filter((p) => !hasPathPattern(forbiddenDirs, p));
  addCheck(
    checks,
    'required-forbidden-dirs',
    missingForbidden.length === 0,
    missingForbidden.length ? `Missing forbidden dirs: ${missingForbidden.join(', ')}` : 'Harness run/state/cache folders are protected from edits.'
  );

  const commandResults = Object.entries(commandCandidates).map(([id, candidates]) => {
    const configured = config.commands?.[id];
    const command = resolveScriptCommand(root, config.packageManager, pkg, configured, candidates);
    const explicit = configured !== undefined && configured !== 'auto';
    const disabled = configured === 'none' || configured === false;
    return {
      id,
      configured: configured === undefined ? null : configured,
      explicit,
      disabled,
      available: Boolean(command),
      command
    };
  });
  const unresolvedCommands = commandResults.filter((c) => !c.available && !c.disabled);
  const autoCommands = commandResults.filter((c) => !c.explicit);
  addCheck(
    checks,
    'commands-explicit-and-resolved',
    unresolvedCommands.length === 0 && autoCommands.length === 0,
    unresolvedCommands.length || autoCommands.length
      ? `Unresolved commands: ${unresolvedCommands.map((c) => c.id).join(', ') || 'none'}; auto commands: ${autoCommands.map((c) => c.id).join(', ') || 'none'}`
      : 'All primary validation commands are explicit and either resolvable or intentionally disabled.'
  );
  const phaseBoundCommands = commandResults.filter((item) => /(?:verify_|run_)?phase\d|phase-\d/i.test(item.command || ''));
  addCheck(
    checks,
    'phase-neutral-validation-entrypoints',
    phaseBoundCommands.length === 0,
    phaseBoundCommands.length
      ? `Validation entrypoints expose phase-specific names: ${phaseBoundCommands.map((item) => item.id).join(', ')}.`
      : 'Validation commands use phase-neutral Harness entrypoints.'
  );
  const authorityCapabilities = config.sourceAuthority?.validationProfile?.commands || {};
  const missingCapabilities = commandResults
    .filter((item) => item.available && /harness[\\/]validators[\\/]run\.mjs\s+/i.test(item.command || ''))
    .map((item) => item.id)
    .filter((id) => !authorityCapabilities[id]);
  addCheck(
    checks,
    'authority-validation-profile',
    missingCapabilities.length === 0,
    missingCapabilities.length
      ? `Source authority profile is missing: ${missingCapabilities.join(', ')}.`
      : 'Source authority validation profile covers every configured generic entrypoint.'
  );

  const emptyRiskRules = riskRuleKeys.filter((key) => !(config.riskRules?.[key] || []).length);
  addCheck(
    checks,
    'risk-rules-populated',
    emptyRiskRules.length === 0,
    emptyRiskRules.length ? `Empty risk rule groups: ${emptyRiskRules.join(', ')}` : 'All risk rule groups contain project patterns.'
  );

  addCheck(
    checks,
    'repository-security-profile',
    ['private-development', 'public-release'].includes(config.security?.profile),
    `Security profile: ${config.security?.profile || 'missing'}.`
  );

  const failed = checks.filter((c) => c.status === 'failed');
  return {
    status: failed.length ? 'failed' : 'healthy',
    generatedAt: new Date().toISOString(),
    configFile: config.configFile,
    packageManager: config.packageManager,
    checks,
    commands: commandResults
  };
}

function deepMerge(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(b) ? b : a;
  if (!isObject(a) || !isObject(b)) return b === undefined ? a : b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = deepMerge(a[k], v);
  return out;
}

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function requireObject(value, name, errors) {
  if (!isObject(value)) errors.push(`${name} must be an object.`);
}

function requireString(value, name, errors) {
  if (typeof value !== 'string' || !value.trim()) errors.push(`${name} must be a non-empty string.`);
}

function requirePositiveInteger(value, name, errors) {
  if (!Number.isInteger(value) || value <= 0) errors.push(`${name} must be a positive integer.`);
}

function requireNullableString(value, name, errors) {
  if (value !== null && (typeof value !== 'string' || !value.trim())) errors.push(`${name} must be null or a non-empty string.`);
}

function requireNumber(value, name, errors) {
  if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`${name} must be a finite number.`);
}

function requireBoolean(value, name, errors) {
  if (typeof value !== 'boolean') errors.push(`${name} must be a boolean.`);
}

function requireStringArray(value, name, errors) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    errors.push(`${name} must be an array of non-empty strings.`);
  }
}

function requireNonEmptyStringArray(value, name, errors) {
  requireStringArray(value, name, errors);
  if (Array.isArray(value) && value.length === 0) errors.push(`${name} must contain at least one value.`);
}

function requireOneOf(value, allowed, name, errors) {
  if (!allowed.includes(value)) errors.push(`${name} must be one of ${allowed.join(', ')}.`);
}

function requireCommandValue(value, name, errors) {
  if (typeof value === 'string') return;
  if (value === false) return;
  errors.push(`${name} must be a string or false.`);
}

function addCheck(checks, id, passed, message) {
  checks.push({ id, status: passed ? 'passed' : 'failed', message });
}

function hasPathPattern(patterns, requiredPath) {
  const required = normalizePath(requiredPath).replace(/\/$/, '');
  return patterns.some((pattern) => {
    const normalized = normalizePath(pattern).replace(/\/\*\*$/, '').replace(/^\*\*\//, '').replace(/\/$/, '');
    return normalized === required || normalized.endsWith(`/${required}`) || required.endsWith(`/${normalized}`) || normalized.includes(required);
  });
}
