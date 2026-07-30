import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const workflow = fs.readFileSync(path.resolve('.github/workflows/ci.yml'), 'utf8');

assert.match(workflow, /runs-on: windows-latest/);
assert.match(workflow, /runs-on: ubuntu-latest/);
assert.match(workflow, /codex\/\*\*/);
assert.match(workflow, /security --profile public-release/);
assert.match(workflow, /sandbox --verify --build/);
assert.match(workflow, /needs: harness/);
assert.match(workflow, /actions\/checkout@[0-9a-f]{40} # v7/);
assert.match(workflow, /actions\/setup-node@[0-9a-f]{40} # v7/);
assert.match(workflow, /actions\/setup-python@[0-9a-f]{40} # v7/);
assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40} # v7/);
assert.match(workflow, /python-version:\s*"3\.12\.10"/);
assert.doesNotMatch(workflow, /uses:\s+actions\/(?:checkout|setup-node|setup-python|upload-artifact)@v\d+\b/);
assert.equal(
  (workflow.match(/persist-credentials: false/g) || []).length,
  2,
  'Every checkout must remove the GitHub credential from the working copy'
);
assert.equal(
  (workflow.match(/include-hidden-files: true/g) || []).length,
  2,
  'Every exact .harness artifact upload must include its dot-directory path'
);

const longPathsIndex = workflow.indexOf('git config --global core.longpaths true');
const firstCheckoutIndex = workflow.indexOf('uses: actions/checkout@');
assert.ok(longPathsIndex >= 0, 'Windows CI must enable Git long-path support');
assert.ok(longPathsIndex < firstCheckoutIndex, 'Git long paths must be enabled before Windows checkout');

console.log('CI_WORKFLOW_TEST_PASS');
