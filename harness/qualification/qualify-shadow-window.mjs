import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateShadowWindow,
  runQualificationDrills
} from '../lib/v4/shadow-qualification.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, '..', '..');
const options = parseArgs(process.argv.slice(2));
const inputDir = path.resolve(repositoryRoot, options.input || '.harness/runs/h8-shadow-observations');
const outputPath = path.resolve(repositoryRoot, options.output || '.harness/runs/h8-shadow-qualification.json');
const policyPath = path.resolve(repositoryRoot, options.policy || 'harness/contracts/v4/shadow-qualification-policy.json');
assertInside(repositoryRoot, inputDir);
assertInside(repositoryRoot, outputPath);
assertInside(repositoryRoot, policyPath);

const policy = readJson(policyPath);
const observations = fs.existsSync(inputDir)
  ? fs.readdirSync(inputDir)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => readJson(path.join(inputDir, name)))
  : [];
const drills = runQualificationDrills(policy);
const result = evaluateShadowWindow({ policy, observations, drills });
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exitCode = result.qualificationStatus === 'QUALIFIED' ? 0 : 2;

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!['--input', '--output', '--policy'].includes(key) || !args[index + 1]) {
      throw new Error(`Unsupported or incomplete argument: ${key}`);
    }
    result[key.slice(2)] = args[index + 1];
    index += 1;
  }
  return result;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function assertInside(root, target) {
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('H8 qualification path escapes the repository.');
  }
}
