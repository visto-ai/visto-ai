import test from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './testing.ts';
import { recordBlockScores, reusableScores } from './block-scores.ts';
import type { StoredBlockScore } from './block-scores.ts';
import type { Db } from './types.ts';

const REF = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;
const OTHER = { service: 'github', owner: 'acme', repo: 'shop', number: 8 } as const;
const THIRD = { service: 'github', owner: 'acme', repo: 'shop', number: 9 } as const;
const at = (seconds: number): string => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000).toISOString();
const A: StoredBlockScore = { path: 'src/a.ts', hash: 'h1', score: 70, category: 'calculation', reason: 'Totals.' };
const ASK = [{ path: 'src/a.ts', hash: 'h1' }];

test('a score stored by one pull request is found by another, and never by itself', async () => {
  const db = await testDb();
  await recordBlockScores(db, 1, REF, 'model', [A], at(0));
  assert.deepEqual(await reusableScores(db, OTHER, 'model', [{ path: 'src/a.ts', hash: 'h1' }, { path: 'src/a.ts', hash: 'h9' }], at(-60)), [A]);
  assert.deepEqual(await reusableScores(db, REF, 'model', ASK, at(-60)), []);
  await db.close();
});
test('only a score of the last 30 days is reused: the caller says since when', async () => {
  const db = await testDb();
  await recordBlockScores(db, 1, REF, 'model', [A], at(0));
  assert.deepEqual(await reusableScores(db, OTHER, 'model', ASK, at(1)), []);
  assert.deepEqual(await reusableScores(db, OTHER, 'model', ASK, at(0)), [A]);
  await db.close();
});
test('the highest score stored for a block is the one reused, the newest on a tie', async () => {
  const db = await testDb();
  await recordBlockScores(db, 1, REF, 'model', [{ ...A, score: 80, reason: 'First.' }], at(0));
  await recordBlockScores(db, 2, OTHER, 'model', [{ ...A, score: 40, reason: 'Second.' }], at(10));
  await recordBlockScores(db, 3, THIRD, 'model', [{ ...A, score: 80, reason: 'Third.' }], at(20));
  const asker = { service: 'github', owner: 'acme', repo: 'shop', number: 50 } as const;
  assert.deepEqual(await reusableScores(db, asker, 'model', ASK, at(-60)), [{ ...A, score: 80, reason: 'Third.' }]);
  await db.close();
});
test("the review model's scores and the scorer's are kept apart", async () => {
  const db = await testDb();
  await recordBlockScores(db, 1, REF, 'scorer', [A], at(0));
  assert.deepEqual(await reusableScores(db, OTHER, 'model', ASK, at(-60)), []);
  assert.deepEqual(await reusableScores(db, OTHER, 'scorer', ASK, at(-60)), [A]);
  await db.close();
});
test('another repository, another path or another hash is another block', async () => {
  const db = await testDb();
  await recordBlockScores(db, 1, REF, 'model', [A], at(0));
  const elsewhere = { service: 'github', owner: 'acme', repo: 'blog', number: 8 } as const;
  assert.deepEqual(await reusableScores(db, elsewhere, 'model', ASK, at(-60)), []);
  assert.deepEqual(await reusableScores(db, OTHER, 'model', [{ path: 'src/b.ts', hash: 'h1' }], at(-60)), []);
  assert.deepEqual(await reusableScores(db, OTHER, 'model', [{ path: 'src/a.ts', hash: 'h2' }], at(-60)), []);
  await db.close();
});
test('owner and repository are matched whatever their case', async () => {
  const db = await testDb();
  await recordBlockScores(db, 1, { service: 'github', owner: 'Acme', repo: 'Shop', number: 7 }, 'model', [A], at(0));
  assert.deepEqual(await reusableScores(db, OTHER, 'model', ASK, at(-60)), [A]);
  assert.deepEqual(await db.query('select owner, repo from visto_ai.block_scores'), [{ owner: 'acme', repo: 'shop' }]);
  await db.close();
});
test('the asking side is matched whatever the case of its owner and repository', async () => {
  const db = await testDb();
  await recordBlockScores(db, 1, REF, 'model', [A], at(0));
  assert.deepEqual(await reusableScores(db, { service: 'github', owner: 'ACME', repo: 'Shop', number: 8 }, 'model', ASK, at(-60)), [A]);
  // Its own pull request is still left out.
  assert.deepEqual(await reusableScores(db, { service: 'github', owner: 'ACME', repo: 'Shop', number: 7 }, 'model', ASK, at(-60)), []);
  await db.close();
});
test('on a tie the score stored last in time wins, not the row stored last', async () => {
  const db = await testDb();
  await recordBlockScores(db, 1, REF, 'model', [{ ...A, score: 80, reason: 'Newest.' }], at(20));
  await recordBlockScores(db, 2, OTHER, 'model', [{ ...A, score: 80, reason: 'Older.' }], at(0));
  const asker = { service: 'github', owner: 'acme', repo: 'shop', number: 50 } as const;
  assert.deepEqual(await reusableScores(db, asker, 'model', ASK, at(-60)), [{ ...A, score: 80, reason: 'Newest.' }]);
  await db.close();
});
test('nothing asked, nothing stored: no statement is sent', async () => {
  const boom: Db = {
    query: () => { throw new Error('query_sent'); },
    script: () => { throw new Error('script_sent'); },
    transaction: () => { throw new Error('transaction_sent'); },
    close: async () => {},
  };
  await recordBlockScores(boom, 1, REF, 'model', [], at(0));
  assert.deepEqual(await reusableScores(boom, OTHER, 'model', [], at(0)), []);
});
test('a score outside 0 to 100 cannot be stored', async () => {
  const db = await testDb();
  await assert.rejects(recordBlockScores(db, 1, REF, 'model', [{ ...A, score: 101 }], at(0)));
  await assert.rejects(recordBlockScores(db, 1, REF, 'model', [{ ...A, score: -1 }], at(0)));
  assert.deepEqual(await db.query('select count(*)::int as n from visto_ai.block_scores'), [{ n: 0 }]);
  await db.close();
});
test('more than 500 blocks are asked in several statements, and all are answered', async () => {
  const db = await testDb();
  const scores: StoredBlockScore[] = Array.from({ length: 501 }, (_, i) => ({ path: `src/f${i}.ts`, hash: `h${i}`, score: i % 101, category: 'logic', reason: `Block ${i}.` }));
  await recordBlockScores(db, 1, REF, 'model', scores, at(0));
  const seen: string[] = [];
  const spy: Db = { ...db, query: (text, params) => { seen.push(text); return db.query(text, params); } };
  const answer = await reusableScores(spy, OTHER, 'model', scores.map((s) => ({ path: s.path, hash: s.hash })), at(-60));
  assert.equal(seen.length, 2);
  assert.equal(answer.length, 501);
  assert.deepEqual([...answer].sort((a, b) => a.path.localeCompare(b.path)), [...scores].sort((a, b) => a.path.localeCompare(b.path)));
  await db.close();
});
