import assert from 'node:assert/strict';
import { buildRequiredSynchronizations } from '../lib/synchronizations.mjs';
import { planValidation } from '../lib/validation-planner.mjs';

const impactReport = {
  risk: { level: 'L4', score: 10 },
  riskSignals: [
    { signal: 'public-api-change', source: 'path' },
    { signal: 'database-migration', source: 'path' },
    { signal: 'build-system-change', source: 'path' }
  ],
  categories: {
    publicApi: ['Project Codes/Phase 8.5/Codes/app/backend/api/chapter_plan.py'],
    database: ['Project Codes/Phase 8.5/Codes/app/backend/repositories/json_repositories.py'],
    auth: [],
    payment: [],
    shared: [],
    buildSystem: ['harness/lib/impact-analyzer.mjs'],
    tests: [],
    frontend: ['Project Codes/Phase 8.5/Codes/app/frontend/src/api/projectApi.js'],
    backend: ['Project Codes/Phase 8.5/Codes/app/backend/services/chapter_plan_service.py'],
    docs: []
  },
  directTargets: [
    'Project Codes/Phase 8.5/Codes/app/backend/api/chapter_plan.py',
    'Project Codes/Phase 8.5/Codes/app/backend/services/chapter_plan_service.py',
    'Project Codes/Phase 8.5/Codes/app/backend/services/scene_generation_service.py',
    'Project Codes/Phase 8.5/Codes/app/backend/repositories/json_repositories.py',
    'Project Codes/Phase 8.5/Codes/app/frontend/src/api/projectApi.js',
    'harness/lib/impact-analyzer.mjs'
  ],
  changedFiles: [
    'Project Codes/Phase 8.5/Codes/app/backend/api/chapter_plan.py'
  ],
  impactedTests: [],
  escalationRequired: true
};

const requiredSynchronizations = buildRequiredSynchronizations(impactReport);
const domains = requiredSynchronizations.map((sync) => sync.domain);

assert.deepEqual(domains, [
  'public-api',
  'frontend',
  'storage',
  'chapter-plan',
  'scene-writing',
  'harness-control'
]);

const publicApi = requiredSynchronizations.find((sync) => sync.domain === 'public-api');
assert.equal(publicApi.required, true);
assert.deepEqual(publicApi.validationChecks, ['generate-client', 'test-contract', 'typecheck', 'build']);
assert.ok(publicApi.review.some((item) => item.includes('OpenAPI')));
assert.ok(publicApi.trigger.files.includes('Project Codes/Phase 8.5/Codes/app/backend/api/chapter_plan.py'));

const chapterPlan = requiredSynchronizations.find((sync) => sync.domain === 'chapter-plan');
assert.ok(chapterPlan.review.some((item) => item.includes('scene count')));
assert.ok(chapterPlan.validationChecks.includes('test-contract'));

const validationPlan = planValidation({
  root: process.cwd(),
  config: {
    packageManager: 'npm',
    commands: {
      lint: 'node --check harness/cli.mjs',
      typecheck: 'node --check harness/cli.mjs',
      testUnit: 'node --check harness/cli.mjs',
      testIntegration: 'node --check harness/cli.mjs',
      testContract: 'node --check harness/cli.mjs',
      testE2E: 'node --check harness/cli.mjs',
      build: 'node --check harness/cli.mjs',
      generateClient: 'node --check harness/cli.mjs',
      fullCI: 'node --check harness/cli.mjs'
    },
    changeBudget: { maxRepairRounds: 3 }
  },
  impactReport: {
    ...impactReport,
    requiredSynchronizations
  }
});

assert.equal(validationPlan.requiredSynchronizations.length, requiredSynchronizations.length);
assert.ok(validationPlan.notes.some((note) => note.includes('Required synchronizations')));
assert.ok(validationPlan.notes.some((note) => note.includes('public-api')));

console.log('SYNCHRONIZATIONS_TEST_PASS');
