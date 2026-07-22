import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

export function summarizeDurations(values, { budgetP95Ms = null } = {}) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) {
    return {
      status: 'failed',
      count: 0,
      minMs: null,
      p50Ms: null,
      p95Ms: null,
      maxMs: null,
      meanMs: null,
      budgetP95Ms
    };
  }
  const p50Ms = percentile(sorted, 0.5);
  const p95Ms = percentile(sorted, 0.95);
  return {
    status: budgetP95Ms == null || p95Ms <= budgetP95Ms ? 'passed' : 'failed',
    count: sorted.length,
    minMs: round(sorted[0]),
    p50Ms: round(p50Ms),
    p95Ms: round(p95Ms),
    maxMs: round(sorted.at(-1)),
    meanMs: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    budgetP95Ms
  };
}

export function benchmarkPostCheck({
  root,
  runDir,
  iterations = 20,
  warmupIterations = 3,
  budgetP95Ms = 350,
  guardArgs = []
}) {
  const cliPath = path.join(root, 'harness', 'cli.mjs');
  const baseline = measureProcesses({
    root,
    cliPath,
    runDir,
    iterations,
    guardArgs,
    env: { HARNESS_DISABLE_GUARD_HASH_CACHE: '1' }
  });
  measureProcesses({ root, cliPath, runDir, iterations: warmupIterations, guardArgs });
  const optimized = measureProcesses({ root, cliPath, runDir, iterations, guardArgs });
  const baselineSummary = summarizeDurations(baseline.durations);
  const optimizedSummary = summarizeDurations(optimized.durations, { budgetP95Ms });
  const processErrors = [...baseline.errors, ...optimized.errors];
  const guardFailures = [...baseline.guardFailures, ...optimized.guardFailures];
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'post-check-process',
    runDir: path.relative(root, runDir),
    status: benchmarkStatus({ optimizedSummary, processErrors, guardFailures }),
    budget: { p95Ms: budgetP95Ms },
    baseline: baselineSummary,
    optimized: optimizedSummary,
    improvement: {
      p50Percent: percentImprovement(baselineSummary.p50Ms, optimizedSummary.p50Ms),
      p95Percent: percentImprovement(baselineSummary.p95Ms, optimizedSummary.p95Ms)
    },
    processErrors,
    guardFailures
  };
}

export function benchmarkStatus({ optimizedSummary, processErrors = [], guardFailures = [] }) {
  return optimizedSummary?.status === 'passed' && processErrors.length === 0 && guardFailures.length === 0
    ? 'passed'
    : 'failed';
}

function measureProcesses({ root, cliPath, runDir, iterations, guardArgs, env = {} }) {
  const durations = [];
  const errors = [];
  const guardFailures = [];
  for (let index = 0; index < iterations; index += 1) {
    const start = performance.now();
    const result = spawnSync(process.execPath, [cliPath, 'post-check', '--run', runDir, ...guardArgs], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 5 * 1024 * 1024,
      env: { ...process.env, ...env }
    });
    durations.push(performance.now() - start);
    const guard = parsePostCheckResult(result.stdout);
    if (guard?.status === 'failed') {
      guardFailures.push({
        iteration: index + 1,
        findingIds: (guard.findings || []).map((finding) => finding.id).filter(Boolean)
      });
    }
    if (result.status == null || result.status > 1 || result.error) {
      errors.push({
        iteration: index + 1,
        exitCode: result.status,
        error: result.error ? String(result.error.message || result.error) : null,
        stderr: String(result.stderr || '').slice(0, 500)
      });
    }
  }
  return { durations, errors, guardFailures };
}

function parsePostCheckResult(stdout) {
  const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return null;
  try {
    return JSON.parse(lines.at(-1));
  } catch {
    return null;
  }
}

function percentile(sorted, percentileValue) {
  const index = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);
  return sorted[index];
}

function percentImprovement(before, after) {
  if (!Number.isFinite(before) || before <= 0 || !Number.isFinite(after)) return null;
  return round(((before - after) / before) * 100);
}

function round(value) {
  return Math.round(value * 100) / 100;
}
