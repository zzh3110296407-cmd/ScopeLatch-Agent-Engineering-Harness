import { matchesAny, normalizePath, unique } from './common.mjs';

const domainRules = [
  {
    domain: 'public-api',
    title: 'Backend API / OpenAPI / frontend client',
    categories: ['publicApi'],
    signals: ['public-api-change'],
    pathPatterns: [
      '**/api/**',
      '**/routes/**',
      '**/*openapi*',
      '**/*.graphql',
      '**/*.proto',
      '**/frontend/src/api/**'
    ],
    review: [
      'OpenAPI/schema shape',
      'backend route handler and service contract',
      'frontend API client and consumers',
      'contract tests and generated client/codegen output'
    ],
    validationChecks: ['generate-client', 'test-contract', 'typecheck', 'build']
  },
  {
    domain: 'frontend',
    title: 'Product workbench frontend',
    categories: ['frontend'],
    pathPatterns: [
      '**/frontend/**',
      '**/components/**',
      '**/views/**',
      '**/production-ui/**',
      'UI Design/**'
    ],
    review: [
      'navigation and workbench state',
      'ordinary/expert mode display',
      'validation and blocking issue display',
      'API payload compatibility'
    ],
    validationChecks: ['typecheck', 'build', 'test-e2e']
  },
  {
    domain: 'storage',
    title: 'Storage, repositories, runtime data, PostgreSQL readiness',
    categories: ['database'],
    signals: ['database-migration'],
    pathPatterns: [
      'Database/**',
      '**/repositories/**',
      '**/storage/**',
      '**/models/**',
      '**/migrations/**',
      '**/postgresql_readiness/**'
    ],
    review: [
      'JSON repository compatibility',
      'PostgreSQL readiness and migration safety',
      'local project runtime data boundaries',
      'fixtures, seed data, and integration tests'
    ],
    validationChecks: ['test-unit', 'test-integration', 'full-ci']
  },
  {
    domain: 'model-runtime',
    title: 'Model gateway, provider adapters, tracing',
    pathPatterns: [
      '**/model_gateway*',
      '**/model_adapters/**',
      '**/provider*',
      '**/tracing*',
      '**/langsmith*',
      '**/model_settings*'
    ],
    review: [
      'provider request/response contract',
      'runtime degraded/healthy state',
      'tracing and observability fields',
      'secret and API key handling'
    ],
    validationChecks: ['test-integration', 'test-e2e']
  },
  {
    domain: 'world-canvas',
    title: 'World canvas and fact base',
    pathPatterns: [
      '**/world_canvas*',
      '**/story_setup*',
      '**/project_story_premise*',
      '**/fact*',
      '**/location*'
    ],
    review: [
      'story premise absorption',
      'world fact base consistency',
      'location/history/culture downstream consumers',
      'world canvas confirmation gates'
    ],
    validationChecks: ['test-contract', 'test-integration', 'test-e2e']
  },
  {
    domain: 'character-generation',
    title: 'Character generation and role state',
    pathPatterns: [
      '**/character*',
      '**/role_generation*',
      '**/role_management*',
      '**/relationship*',
      '**/runtime_role*'
    ],
    review: [
      'role generation prompt absorption',
      'character current state validity',
      'relationship drafts and relationship state',
      'role eligibility and validation blockers'
    ],
    validationChecks: ['test-contract', 'test-integration', 'test-e2e']
  },
  {
    domain: 'framework',
    title: 'Framework package and current chapter framework',
    pathPatterns: [
      '**/framework*',
      '**/chapter_framework*',
      '**/macro*',
      '**/module_library*'
    ],
    review: [
      'framework package contract',
      'current chapter framework build context',
      'macro module routing',
      'chapter framework audit reasons'
    ],
    validationChecks: ['test-contract', 'test-integration']
  },
  {
    domain: 'chapter-plan',
    title: 'Chapter plan, route, scene count, next chapter transition',
    pathPatterns: [
      '**/chapter_plan*',
      '**/chapter_progress*',
      '**/chapter_archive*',
      '**/chapter_memory*'
    ],
    review: [
      'chapter route and current chapter brief',
      'scene count and required scene coverage',
      'framework route alignment',
      'next chapter transition and archive readiness'
    ],
    validationChecks: ['test-contract', 'test-integration', 'test-e2e']
  },
  {
    domain: 'scene-writing',
    title: 'Scene generation, gates, repair, prose drafting',
    pathPatterns: [
      '**/scene*',
      '**/writer*',
      '**/prose*',
      '**/quality_gate*',
      '**/revision*'
    ],
    review: [
      'scene generation constraints',
      'scene gate and repair adapter behavior',
      'repair orchestrator bounded loop',
      'prose drafting and quality closeout'
    ],
    validationChecks: ['test-contract', 'test-integration', 'test-e2e', 'full-ci']
  },
  {
    domain: 'continuity',
    title: 'Continuity, memory refresh, narrative debt',
    pathPatterns: [
      '**/continuity*',
      '**/memory*',
      '**/narrative_debt*',
      '**/abcd*',
      '**/apparent_contradiction*'
    ],
    review: [
      'continuity gate lifecycle',
      'old story resolution and refresh state',
      'memory retrieval/writeback side effects',
      'narrative debt and apparent contradiction handling'
    ],
    validationChecks: ['test-contract', 'test-integration', 'test-e2e', 'full-ci']
  },
  {
    domain: 'harness-control',
    title: 'Harness engine, hooks, validation commands',
    categories: ['buildSystem'],
    signals: ['build-system-change'],
    pathPatterns: [
      'harness/**',
      '.harness/**',
      '.codex/**',
      'AGENTS.md'
    ],
    review: [
      'Harness command behavior',
      'validation command mapping',
      'Codex hook policy',
      'run/state/cache exclusion boundaries'
    ],
    validationChecks: ['lint', 'typecheck', 'test-unit', 'build', 'full-ci']
  }
];

export function buildRequiredSynchronizations(report = {}) {
  const categories = report.categories || {};
  const signals = (report.riskSignals || []).map((signal) => signal.signal).filter(Boolean);
  const files = unique([
    ...(report.directTargets || []),
    ...(report.changedFiles || []),
    ...Object.values(categories).flat()
  ]).map(normalizePath);

  return domainRules
    .map((rule) => buildDomainSynchronization({ rule, categories, signals, files }))
    .filter(Boolean);
}

function buildDomainSynchronization({ rule, categories, signals, files }) {
  const categoryHits = (rule.categories || []).filter((category) => (categories[category] || []).length > 0);
  const signalHits = (rule.signals || []).filter((signal) => signals.includes(signal));
  const matchedFiles = files.filter((file) => matchesAny(file, rule.pathPatterns || []));

  if (!categoryHits.length && !signalHits.length && !matchedFiles.length) return null;

  return {
    id: `sync-${rule.domain}`,
    domain: rule.domain,
    title: rule.title,
    required: true,
    trigger: {
      categories: categoryHits,
      signals: signalHits,
      files: matchedFiles.slice(0, 20)
    },
    review: [...rule.review],
    validationChecks: [...rule.validationChecks],
    handoff: [
      `Review ${rule.domain} downstream consumers before final response.`,
      `Mention skipped ${rule.domain} checks with exact reasons if unavailable.`
    ]
  };
}
