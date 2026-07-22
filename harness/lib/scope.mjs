import { normalizePath, unique } from './common.mjs';

export const domainAllowedPatterns = {
  'public-api': ['**/api/**', '**/routes/**', '**/*openapi*', '**/*.graphql', '**/*.proto', '**/frontend/src/api/**'],
  frontend: ['**/frontend/**', '**/components/**', '**/views/**', '**/production-ui/**', 'UI Design/**'],
  storage: ['Database/**', '**/repositories/**', '**/storage/**', '**/models/**', '**/migrations/**', '**/postgresql_readiness/**'],
  'model-runtime': ['**/model_gateway*', '**/model_adapters/**', '**/provider*', '**/tracing*', '**/langsmith*', '**/model_settings*'],
  'world-canvas': ['**/world_canvas*', '**/story_setup*', '**/project_story_premise*', '**/fact*', '**/location*'],
  'character-generation': ['**/character*', '**/role_generation*', '**/role_management*', '**/relationship*', '**/runtime_role*'],
  framework: ['**/framework*', '**/chapter_framework*', '**/macro*', '**/module_library*'],
  'chapter-plan': ['**/chapter_plan*', '**/chapter_progress*', '**/chapter_archive*', '**/chapter_memory*'],
  'scene-writing': ['**/scene*', '**/writer*', '**/prose*', '**/quality_gate*', '**/revision*'],
  continuity: ['**/continuity*', '**/memory*', '**/narrative_debt*', '**/abcd*', '**/apparent_contradiction*'],
  'harness-control': ['harness/**', '.harness/**', '.codex/**', '.github/workflows/**', 'AGENTS.md']
};

export function allowedScopeFiles(impactReport = {}) {
  const syncFiles = (impactReport.requiredSynchronizations || []).flatMap((sync) => sync.trigger?.files || []);
  return new Set(unique([
    ...(impactReport.directTargets || []),
    ...(impactReport.reverseDependents || []),
    ...(impactReport.impactedTests || []),
    ...(impactReport.changedFiles || []),
    ...syncFiles
  ]).map(normalizePath));
}

export function allowedScopePatterns(impactReport = {}) {
  const domains = (impactReport.requiredSynchronizations || []).map((sync) => sync.domain).filter(Boolean);
  return unique(domains.flatMap((domain) => domainAllowedPatterns[domain] || []));
}
