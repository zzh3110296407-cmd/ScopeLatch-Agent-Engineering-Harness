import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildContextPack } from '../lib/context-builder.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-context-priority-'));
const current = 'Project Codes/Phase 8.5/Codes/app/frontend/src/production-ui/ProductUiApp.jsx';
const historical = 'Project Codes/Phase 3/Codes/app/frontend/src/production-ui/ProductUiApp.jsx';
const generated = 'Database/06-validation/frontend-product-workbench-validation-report.json';
const currentTest = 'Project Codes/Phase 8.5/Codes/app/frontend/tests/ProductUiApp.test.jsx';
const duplicateBody = 'export function ProductUiApp() { return "product workbench"; }\n';

write(current, duplicateBody);
write(historical, duplicateBody);
write(generated, '{"product":"workbench","frontend":"validation report"}\n');
write(currentTest, 'test("product workbench", () => {});\n');

const context = buildContextPack({
  root,
  files: [historical, generated, currentTest, current],
  taskInfo: {
    raw: '审查 ProductUiApp 产品工作台前端',
    intent: 'ui',
    tokens: ['productuiapp', 'product', 'workbench', 'frontend'],
    riskHints: [],
    fileMentions: []
  },
  config: {
    context: {
      maxMustReadFiles: 8,
      maxRelatedFiles: 8,
      maxRelatedTests: 8,
      maxFileBytesToScan: 100000,
      excludePathPatterns: [],
      sourcePriority: {
        activeSourceRoots: ['Project Codes/Phase 8.5/Codes/**'],
        referenceSourceRoots: [],
        historicalPathPatterns: ['Project Codes/Phase */**'],
        generatedPathPatterns: ['**/*_report.json', '**/*validation-report*'],
        activeBonus: 50,
        referenceBonus: 10,
        historicalPenalty: -5,
        generatedPenalty: -45,
        deduplicateExactContent: true,
        includeGeneratedInMustRead: false,
        preferActiveTests: true
      }
    }
  }
});

assert.equal(context.mustRead.includes(current), true);
assert.equal(context.mustRead.includes(historical), false);
assert.equal(context.relatedFiles.includes(historical), false);
assert.equal(context.mustRead.includes(generated), false);
assert.equal(context.relatedTests.includes(currentTest), true);
assert.equal(context.retrieval.deduplicatedFileCount, 1);
assert.deepEqual(context.retrieval.activeSourceRoots, ['Project Codes/Phase 8.5/Codes/**']);

const harnessCli = 'harness/cli.mjs';
const harnessTest = 'harness/tests/closeout.test.mjs';
const harnessHook = '.codex/hooks/stop_guard.py';
const businessScript = 'Project Codes/Phase 8.5/Codes/app/backend/scripts/verify_business_closeout.py';
write(harnessCli, 'export function closeHarnessRun() { return "guard validate closeout"; }\n');
write(harnessTest, 'test("harness closeout", () => {});\n');
write(harnessHook, 'def enforce_harness_closeout():\n    return "guard validation"\n');
write(businessScript, ' '.repeat(10) + 'harness guard validate closeout '.repeat(30));

const controlContext = buildContextPack({
  root,
  files: [businessScript, harnessHook, harnessTest, harnessCli],
  taskInfo: {
    raw: 'Harden Harness closeout, Guard, validation, and Codex hooks',
    intent: 'test',
    tokens: ['harden', 'harness', 'closeout', 'guard', 'validation', 'codex', 'hooks'],
    riskHints: [],
    fileMentions: []
  },
  config: {
    context: {
      maxMustReadFiles: 8,
      maxRelatedFiles: 8,
      maxRelatedTests: 8,
      maxFileBytesToScan: 100000,
      excludePathPatterns: [],
      sourcePriority: {},
      controlPlane: {
        taskTokens: ['harness', 'codex', 'guard', 'closeout'],
        pathPatterns: ['harness/**', '.harness/**', '.codex/hooks/**', '.github/workflows/**', 'AGENTS.md'],
        activeBonus: 120,
        outsidePenalty: -120
      }
    }
  }
});

assert.equal(controlContext.retrieval.profile, 'harness-control-plane');
assert.equal(controlContext.mustRead.includes(harnessCli), true);
assert.equal(controlContext.mustRead.includes(harnessHook), true);
assert.equal(controlContext.relatedTests.includes(harnessTest), true);
assert.equal(controlContext.mustRead.includes(businessScript), false);
assert.equal(controlContext.relatedFiles.includes(businessScript), false);

fs.rmSync(root, { recursive: true, force: true });
console.log('CONTEXT_BUILDER_TEST_PASS');

function write(rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}
