import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from '../db/testing.ts';
import type { Db } from '../db/types.ts';
import { recordRun } from '../db/review-runs.ts';
import type { RunRecord } from '../db/review-runs.ts';
import { createSpendGuard } from './spend.ts';

const REF = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;
const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  ref: REF, job: null, trigger: 'automatic', mode: 'full', dryRun: true, headSha: 'h1', baseSha: 'b1', baseBranch: null,
  outcome: 'ok', failureStage: null, failureCode: null, needsHuman: false, highestScore: 35,
  body: 'text', comments: [], result: { findings: [] },
  usage: { calls: 2, inputTokens: 1000, outputTokens: 200, cachedTokens: 50, cost: 0.0375 },
  startedAt: '2026-03-01T10:00:00.000Z', finishedAt: '2026-03-01T10:01:30.000Z', ...over,
});

let db: Db;
let alerts: Array<[string, Record<string, unknown>]>;
const alert = (code: string, details?: Record<string, string | number | boolean | null>): void => { alerts.push([code, details ?? {}]); };
const cost = async (startedAt: string, usd: number): Promise<void> => {
  await recordRun(db, run({ startedAt, finishedAt: startedAt, usage: { ...run().usage, cost: usd } }));
};
beforeEach(async () => { db = await testDb(); alerts = []; });
afterEach(async () => { await db.close(); });

test('the level follows the cost of the runs recorded since the start of the UTC day', async () => {
  const guard = createSpendGuard({ db, limit: 50, clock: () => new Date('2026-03-01T10:00:00.000Z'), alert });
  await cost('2026-02-28T23:59:59.000Z', 100);
  assert.equal(await guard.level(), 'ok');
  await cost('2026-03-01T00:00:00.000Z', 39.5);
  assert.equal(await guard.level(), 'ok');
  await cost('2026-03-01T09:00:00.000Z', 0.5);
  assert.equal(await guard.level(), 'warn');
  await cost('2026-03-01T09:30:00.000Z', 10);
  assert.equal(await guard.level(), 'limit');
});
test('each level is alerted once a day, and again the next day', async () => {
  let now = '2026-03-01T10:00:00.000Z';
  const guard = createSpendGuard({ db, limit: 50, clock: () => new Date(now), alert });
  await cost('2026-03-01T09:00:00.000Z', 40);
  await guard.level();
  await guard.level();
  await cost('2026-03-01T09:30:00.000Z', 10.254);
  await guard.level();
  await guard.level();
  assert.deepEqual(alerts, [['spend_80', { spent: 40, limit: 50 }], ['spend_limit', { spent: 50.25, limit: 50 }]]);
  now = '2026-03-02T00:00:01.000Z';
  assert.equal(await guard.level(), 'ok');
  await cost('2026-03-02T00:00:00.500Z', 60);
  await guard.level();
  assert.deepEqual(alerts.map((a) => a[0]), ['spend_80', 'spend_limit', 'spend_limit']);
});
test('a run with tokens and no cost is alerted once', () => {
  const guard = createSpendGuard({ db, limit: 50, clock: () => new Date(), alert });
  guard.noteRun({ inputTokens: 0, outputTokens: 0, cost: 0 });
  guard.noteRun({ inputTokens: 10, outputTokens: 1, cost: 0.01 });
  guard.noteRun({ inputTokens: 10, outputTokens: 1, cost: 0 });
  guard.noteRun({ inputTokens: 10, outputTokens: 1, cost: 0 });
  assert.deepEqual(alerts, [['cost_unknown', {}]]);
});
