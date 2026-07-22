import assert from 'node:assert/strict';
import { buildCodexPrompt } from '../lib/prompt-builder.mjs';

const prompt = buildCodexPrompt({
  task: 'Update model gateway',
  contextPackMarkdown: '# Context',
  impactReport: { requiredSynchronizations: [] },
  validationPlan: { commands: [] },
  config: { changeBudget: { maxRepairRounds: 3 } },
  applicableRules: [
    {
      id: 'project-model-gateway-secrets',
      source: 'project-reviewed',
      domains: ['model-runtime'],
      action: 'Never persist provider credentials.'
    }
  ]
});

assert.match(prompt, /Applicable Reviewed Rules/);
assert.match(prompt, /project-model-gateway-secrets/);
assert.match(prompt, /Never persist provider credentials/);
console.log('PROMPT_RULES_TEST_PASS');
