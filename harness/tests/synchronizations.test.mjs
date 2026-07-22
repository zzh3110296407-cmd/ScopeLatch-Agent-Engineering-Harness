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
    publicApi: ['src/backend/api/orders.py'],
    database: ['src/backend/repositories/order_repository.py'],
    auth: [],
    payment: [],
    shared: [],
    buildSystem: ['harness/lib/impact-analyzer.mjs'],
    tests: [],
    frontend: ['src/frontend/api/ordersApi.js'],
    backend: ['src/backend/services/order_service.py'],
    docs: []
  },
  directTargets: [
    'src/backend/api/orders.py',
    'src/backend/services/order_service.py',
    'src/backend/repositories/order_repository.py',
    'src/frontend/api/ordersApi.js',
    'harness/lib/impact-analyzer.mjs'
  ],
  changedFiles: [
    'src/backend/api/orders.py'
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
  'harness-control'
]);

const publicApi = requiredSynchronizations.find((sync) => sync.domain === 'public-api');
assert.equal(publicApi.required, true);
assert.deepEqual(publicApi.validationChecks, ['generate-client', 'test-contract', 'typecheck', 'build']);
assert.ok(publicApi.review.some((item) => item.includes('OpenAPI')));
assert.ok(publicApi.trigger.files.includes('src/backend/api/orders.py'));

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
