import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const workflow = fs.readFileSync(path.resolve('.github/workflows/ci.yml'), 'utf8');

assert.match(workflow, /runs-on: windows-latest/);
assert.match(workflow, /runs-on: ubuntu-latest/);
assert.match(workflow, /codex\/\*\*/);
assert.match(workflow, /security --profile public-release/);
assert.doesNotMatch(workflow, /--skip-history/);
assert.match(workflow, /sandbox --verify --build/);
assert.match(workflow, /needs: harness/);
assert.match(workflow, /actions\/checkout@v7/);
assert.match(workflow, /actions\/setup-node@v7/);
assert.match(workflow, /actions\/setup-python@v7/);
assert.match(workflow, /actions\/upload-artifact@v7/);
assert.doesNotMatch(workflow, /actions\/(?:checkout|setup-node|setup-python|upload-artifact)@v(?:4|5|6)\b/);

const longPathsIndex = workflow.indexOf('git config --global core.longpaths true');
const firstCheckoutIndex = workflow.indexOf('uses: actions/checkout@v7');
assert.ok(longPathsIndex >= 0, 'Windows CI must enable Git long-path support');
assert.ok(longPathsIndex < firstCheckoutIndex, 'Git long paths must be enabled before Windows checkout');

console.log('CI_WORKFLOW_TEST_PASS');
