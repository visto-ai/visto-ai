import test from 'node:test';
import assert from 'node:assert/strict';
import type { StoredRun } from '../db/review-runs.ts';
import type { ReviewThread, ThreadComment } from '../forge/types.ts';
import { earlierOf, missedComments } from './earlier.ts';

const REF = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;
const USAGE = { calls: 1, inputTokens: 1, outputTokens: 1, cachedTokens: 0, cost: 0 };
const BODY = 'Check the total.';
const run = (over: Partial<StoredRun> & { verdicts?: unknown; result?: unknown } = {}): StoredRun => {
  const { verdicts, result, ...rest } = over;
  const base = result ?? {
    findings: [{ path: 'src/a.ts', side: 'RIGHT', line: 12, severity: 'major', body: 'x', quote: 'total = a + b', requestedLine: null }],
    scores: [{ path: 'src/a.ts', diffHash: 'd1' }],
  };
  return {
    id: 1, ref: REF, job: 1, trigger: 'automatic', mode: 'full', dryRun: false, headSha: 'h1', baseSha: 'b1', baseBranch: null,
    outcome: 'ok', failureStage: null, failureCode: null, needsHuman: false, highestScore: 1,
    body: '', comments: [{ path: 'src/a.ts', side: 'RIGHT', line: 12, body: BODY }],
    result: verdicts === undefined ? base : { ...(base as object), threadVerdicts: verdicts },
    usage: USAGE, startedAt: '2026-03-01T10:00:00.000Z', finishedAt: '2026-03-01T10:01:00.000Z',
    published: true, reviewId: '401', publishedAt: '2026-03-01T10:02:00.000Z', inlineDropped: false, ...rest,
  };
};
const STORED = { commentId: '8001', path: 'src/a.ts', side: 'RIGHT' as const, line: 12, severity: 'major', quote: 'total = a + b', run: 1 };
const ROOT: ThreadComment = { id: '8001', node: 'N1', author: 'visto-test', authorIsBot: true, byApp: true, reviewId: '401', body: BODY, at: '2026-03-01T10:02:00.000Z' };
const reply = (author: string, over: Partial<ThreadComment> = {}): ThreadComment =>
  ({ id: '9000', node: 'N2', author, authorIsBot: false, byApp: false, reviewId: null, body: 'Meant to be so.', at: '2026-03-01T11:00:00.000Z', ...over });
const thread = (over: Partial<ReviewThread> = {}): ReviewThread =>
  ({ id: 'PRRT_1', path: 'src/a.ts', side: 'RIGHT', line: 12, resolved: false, resolvedByApp: false, comments: [ROOT], ...over });
const args = (threads: ReviewThread[], over: Partial<{ runs: StoredRun[]; stored: Array<typeof STORED> }> = {}) =>
  ({ last: run(), runs: over.runs ?? [run()], stored: over.stored ?? [STORED], threads });

test("a stored finding's thread is handed on with where it was opened and what was said", () => {
  const t = thread({ comments: [ROOT, reply('octo-dev'), reply('visto-test', { byApp: true, authorIsBot: true }), reply('helper-bot', { authorIsBot: true })] });
  assert.deepEqual(earlierOf({ last: run(), runs: [run()], stored: [STORED], threads: [t] }), {
    head: 'h1',
    threads: [{
      id: 'PRRT_1', commentId: '8001', path: 'src/a.ts', side: 'RIGHT', line: 12, severity: 'major', quote: 'total = a + b', body: ROOT.body,
      openedAt: { head: 'h1', diffHash: 'd1' }, resolved: false, settled: false, lastVerdict: null,
      replies: [{ author: 'octo-dev', kind: 'person', body: 'Meant to be so.' }, { author: 'visto-test', kind: 'app', body: 'Meant to be so.' }, { author: 'helper-bot', kind: 'bot', body: 'Meant to be so.' }],
    }],
  });
});
test("a thread the database does not hold is not the reviewer's", () => {
  assert.deepEqual(earlierOf(args([thread({ comments: [{ ...ROOT, id: '7777' }] })])).threads, []);
});
test('a thread is settled only when it is resolved and the app resolved it or a person replied', () => {
  const settled = (over: Partial<ReviewThread>) => earlierOf(args([thread(over)])).threads[0]!.settled;
  assert.deepEqual([
    settled({ resolved: true }),
    settled({ resolved: true, resolvedByApp: true }),
    settled({ resolved: true, comments: [ROOT, reply('octo-dev')] }),
    settled({ resolved: false, comments: [ROOT, reply('octo-dev')] }),
    settled({ resolved: true, comments: [ROOT, reply('helper-bot', { authorIsBot: true })] }),
  ], [false, false, true, false, false]);
});
test("the app resolved it only when the thread also holds the app's own reply with a marker", () => {
  const settled = (over: Partial<ReviewThread>) => earlierOf(args([thread(over)])).threads[0]!.settled;
  const MARKED = 'Answered.\n\n<!-- visto-ai: review=402 head=h2 -->';
  assert.deepEqual([
    settled({ resolved: true, resolvedByApp: true }),
    settled({ resolved: true, resolvedByApp: true, comments: [ROOT, reply('visto-test', { byApp: true, authorIsBot: true, body: MARKED })] }),
    // not the app's: another bot under the same login (a person's reply settles the thread on its own, so a bot shows the rule alone)
    settled({ resolved: true, resolvedByApp: true, comments: [ROOT, reply('visto-test', { authorIsBot: true, body: MARKED })] }),
    settled({ resolved: true, resolvedByApp: true, comments: [ROOT, reply('visto-test', { byApp: true, authorIsBot: true, body: 'Answered.' })] }),
    settled({ resolved: true, resolvedByApp: false, comments: [ROOT, reply('visto-test', { byApp: true, authorIsBot: true, body: MARKED })] }),
  ], [false, true, false, false, false]);
});
test('a thread listed twice is handed on once, as first listed', () => {
  const out = earlierOf(args([thread(), thread({ line: 99 })]));
  assert.deepEqual(out.threads.map((t) => [t.id, t.line]), [['PRRT_1', 12]]);
});
test('the newest published verdict on a thread is its last verdict', () => {
  const runs = [
    run({ id: 1 }),
    run({ id: 2, verdicts: [{ threadId: 'PRRT_1', verdict: 'fixed' }] }),
    run({ id: 3, verdicts: [{ threadId: 'PRRT_1', verdict: 'open' }] }),
    run({ id: 4, published: false, verdicts: [{ threadId: 'PRRT_1', verdict: 'answered' }] }),
    run({ id: 5, verdicts: [{ threadId: 'PRRT_OTHER', verdict: 'fixed' }] }),
  ];
  assert.equal(earlierOf({ ...args([thread()]), runs }).threads[0]!.lastVerdict, 'open');
  const skipped = [run({ id: 2, verdicts: [{ threadId: 'PRRT_1', verdict: 'fixed' }] }), run({ id: 3 })];
  assert.equal(earlierOf({ ...args([thread()]), runs: skipped }).threads[0]!.lastVerdict, 'fixed');
});
test('a run that is gone, or has no score for the file, leaves the place of opening unknown', () => {
  assert.deepEqual(earlierOf(args([thread()], { stored: [{ ...STORED, run: 99 }] })).threads[0]!.openedAt, { head: '', diffHash: null });
  assert.deepEqual(earlierOf(args([thread()], { runs: [run({ result: { findings: [], scores: [] } })] })).threads[0]!.openedAt, { head: 'h1', diffHash: null });
  assert.deepEqual(earlierOf(args([thread()], { runs: [run({ result: 'not an object' })] })).threads[0]!.openedAt, { head: 'h1', diffHash: null });
});
test('threads come in the order their findings were posted', () => {
  const stored = [{ ...STORED, commentId: '10' }, { ...STORED, commentId: '9' }];
  const out = earlierOf(args([
    thread({ id: 'T10', comments: [{ ...ROOT, id: '10' }] }),
    thread({ id: 'T9', comments: [{ ...ROOT, id: '9' }] }),
  ], { stored }));
  assert.deepEqual(out.threads.map((t) => t.id), ['T9', 'T10']);
});
test('a posted comment the read-back missed is tied to its finding from the thread itself', () => {
  assert.deepEqual(missedComments({ runs: [run()], stored: [], threads: [thread()] }), [{ ...STORED, line: 12 }]);
  assert.deepEqual(missedComments({ runs: [run()], stored: [STORED], threads: [thread()] }), []);
  assert.deepEqual(missedComments({ runs: [run()], stored: [], threads: [thread({ comments: [{ ...ROOT, reviewId: '999' }] })] }), []);
  assert.deepEqual(missedComments({ runs: [run()], stored: [], threads: [thread({ comments: [{ ...ROOT, body: 'edited by hand' }] })] }), []);
});
