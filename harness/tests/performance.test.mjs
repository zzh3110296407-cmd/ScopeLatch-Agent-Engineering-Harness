import assert from 'node:assert/strict';
import { benchmarkStatus, summarizeDurations } from '../lib/performance.mjs';

const summary = summarizeDurations([30, 10, 40, 20, 50]);
assert.equal(summary.count, 5);
assert.equal(summary.minMs, 10);
assert.equal(summary.p50Ms, 30);
assert.equal(summary.p95Ms, 50);
assert.equal(summary.maxMs, 50);

const budgeted = summarizeDurations([10, 12, 11, 13], { budgetP95Ms: 20 });
assert.equal(budgeted.status, 'passed');
assert.equal(budgeted.budgetP95Ms, 20);

const exceeded = summarizeDurations([10, 12, 30, 40], { budgetP95Ms: 20 });
assert.equal(exceeded.status, 'failed');

assert.equal(benchmarkStatus({ optimizedSummary: budgeted }), 'passed');
assert.equal(benchmarkStatus({ optimizedSummary: budgeted, guardFailures: [{ iteration: 1 }] }), 'failed');
assert.equal(benchmarkStatus({ optimizedSummary: budgeted, processErrors: [{ iteration: 1 }] }), 'failed');

console.log('PERFORMANCE_TEST_PASS');
