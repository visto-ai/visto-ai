import test from 'node:test';
import assert from 'node:assert/strict';
import type { StoredRun } from '../db/review-runs.ts';
import type { BlockScore, FileScore, ScoredBy, ScoreEntry } from '../engine/score/types.ts';
import { shownOf } from '../engine/score/shown.ts';
import { review } from '../engine/review.ts';
import { SUBMIT_REVIEW } from '../engine/model/submit-review.ts';
import type { ChangedFile, ModelRequest, ReviewDeps, ReviewInput, ReviewResult } from '../engine/types.ts';
import { historyOf, lastReviewOf, scoresToStore } from './history.ts';

const REF = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;
const USAGE = { calls: 1, inputTokens: 1, outputTokens: 1, cachedTokens: 0, cost: 0 };
const entry = (score: number, reason = `reason ${score}`): ScoreEntry => ({ score, category: 'feature', reason });
const blk = (hash: string, score: number, over: Partial<BlockScore> = {}): BlockScore => ({
  id: 'B1', hunk: 'B1', hunkHash: hash, hash, changedLines: 1,
  span: { side: 'RIGHT', first: 1, last: 1 }, lines: { RIGHT: [[1, 1]], LEFT: [] },
  entry: entry(score), ...over,
});
const blkNoEntry = (hash: string, over: Partial<BlockScore> = {}): BlockScore => blk(hash, 0, { entry: null, ...over });
const file = (path: string, blocks: BlockScore[], over: Partial<FileScore> = {}): FileScore => ({
  path, previousPath: null, diffHash: 'd1', changeSummary: '', changedLines: blocks.length, blocks,
  wholeFile: null, fileLevel: null, finalScore: Math.max(0, ...blocks.map((b) => b.entry?.score ?? 0)), covered: false, ...over,
});
/** A stored, not-dry, `ok`, unpublished full run whose result holds `result`'s fields over an empty result. */
const run = (id: number, result: Record<string, unknown>, over: Partial<StoredRun> = {}): StoredRun => ({
  id, ref: REF, job: id, trigger: 'automatic', mode: 'full', dryRun: false, headSha: `h${id}`, baseSha: 'b1', baseBranch: 'main',
  outcome: 'ok', failureStage: null, failureCode: null, needsHuman: false, highestScore: 0,
  body: '', comments: [],
  result: { overview: `overview ${id}`, coverage: { reviewed: [], notReviewed: [] }, verdict: { threshold: 70, needsHuman: false, highest: 0 }, ...result },
  usage: USAGE, startedAt: '2026-03-01T10:00:00.000Z', finishedAt: '2026-03-01T10:01:00.000Z',
  published: false, reviewId: null, publishedAt: null, inlineDropped: false, ...over,
});
const published = { published: true, reviewId: '401', publishedAt: '2026-03-01T10:02:00.000Z' };
const reviewed = (...paths: string[]) => ({ reviewed: paths, notReviewed: [] });

const of = (runs: StoredRun[], last: StoredRun | null = null, by: ScoredBy = 'model') => historyOf({ runs, last, by });
test('a block keeps the highest score any earlier run left it with', () => {
  const h = of([run(1, { scores: [file('src/a.ts', [blk('h1', 80)])] }), run(2, { scores: [file('src/a.ts', [blk('h1', 40), blk('h2', 60)])] })]);
  assert.deepEqual(h.files[0]!.blocks.map((b) => [b.hash, b.entry.score]), [['h1', 80], ['h2', 60]]);
});
test('two blocks of one run with the same changed lines both stand at the higher score', () => {
  assert.deepEqual(of([run(1, { scores: [file('src/a.ts', [blk('h1', 30), blk('h1', 80)])] })]).files[0]!.blocks.map((b) => b.entry.score), [80]);
});
test('on a tie the newest run gives the entry', () => {
  const h = of([run(1, { scores: [file('src/a.ts', [blk('h1', 50, { entry: entry(50, 'old') })])] }), run(2, { scores: [file('src/a.ts', [blk('h1', 50, { entry: entry(50, 'new') })])] })]);
  assert.equal(h.files[0]!.blocks[0]!.entry.reason, 'new');
});
test('on a tie an entry that was not raised wins over one that was, whichever run is newer', () => {
  const given = run(1, { scores: [file('src/a.ts', [blk('h1', 92, { entry: entry(92, 'given') })])] });
  const raised = run(2, { scores: [file('src/a.ts', [blk('h1', 92, { entry: entry(92, 'raised'), raisedFrom: 2 })])] });
  assert.deepEqual(of([given, raised]).files[0]!.blocks.map((b) => [b.entry.reason, b.raisedFrom]), [['given', null]]);
  const later = run(3, { scores: [file('src/a.ts', [blk('h1', 92, { entry: entry(92, 'given later') })])] });
  assert.deepEqual(of([raised, later]).files[0]!.blocks.map((b) => [b.entry.reason, b.raisedFrom]), [['given later', null]]);
});
test('a score that was raised keeps what was given beside it', () => {
  const h = of([run(1, { scores: [file('src/a.ts', [blk('h1', 85, { raisedFrom: 30 }), blk('h2', 40)])] })]);
  assert.deepEqual(h.files[0]!.blocks.map((b) => [b.hash, b.entry.score, b.raisedFrom]), [['h1', 85, 30], ['h2', 40, null]]);
});
test('a dry run and a failed run are not history', () => {
  const scores = [file('src/a.ts', [blk('h1', 80)])];
  assert.deepEqual(of([run(1, { scores }, { dryRun: true }), run(2, { scores }, { outcome: 'failed' })]).files, []);
});
test('a result that is not a result is not history', () => {
  const runs = [null, 'text', 12, [], {}, { scores: 'x' }, { scores: [null, 'x', { path: 3 }, { path: 'src/a.ts', blocks: 'x' }] }]
    .map((result, i) => ({ ...run(i + 1, {}), result }));
  const h = of(runs);
  assert.deepEqual(h.files.map((f) => [f.path, f.blocks]), [['src/a.ts', []]]);
});
test('a score that is not a score is not history, and the others are kept', () => {
  const bad = (hash: string, score: unknown) => ({ ...blk(hash, 0), entry: { score, category: 'feature', reason: '' } });
  const h = of([run(1, { scores: [{ ...file('src/a.ts', []), blocks: [bad('h1', 150), bad('h2', 12.5), bad('h3', 'x'), bad('h4', -1), null, { hash: 5 }, blk('h5', 20)] }] })]);
  assert.deepEqual(h.files[0]!.blocks.map((b) => [b.hash, b.entry.score]), [['h5', 20]]);
});
test("the scorer's scores and the review model's are separate histories", () => {
  const runs = [run(1, { scores: [file('src/a.ts', [blk('h1', 80, { by: 'scorer' }), blk('h2', 40), blk('h3', 30, { by: 'model' })])] })];
  assert.deepEqual(of(runs, null, 'scorer').files[0]!.blocks.map((b) => b.hash), ['h1']);
  assert.deepEqual(of(runs, null, 'model').files[0]!.blocks.map((b) => b.hash), ['h2', 'h3']);
  assert.equal(of(runs, null, 'scorer').by, 'scorer');
});
test('a hunk that was split is remembered with its parts only when they covered it', () => {
  const parts = [blk('p1', 15, { hunkHash: 'H', range: [0, 19] }), blk('p2', 92, { hunkHash: 'H', range: [20, 39] })];
  assert.deepEqual(of([run(1, { scores: [file('src/a.ts', parts)] })]).files[0]!.splits, [{ hunkHash: 'H', parts: [{ hash: 'p1', range: [0, 19] }, { hash: 'p2', range: [20, 39] }] }]);
});
test('a split is remembered in line order, whatever order its parts were listed in', () => {
  const parts = [blk('p2', 92, { hunkHash: 'H', range: [20, 39] }), blk('p1', 15, { hunkHash: 'H', range: [0, 19] })];
  assert.deepEqual(of([run(1, { scores: [file('src/a.ts', parts)] })]).files[0]!.splits, [{ hunkHash: 'H', parts: [{ hash: 'p1', range: [0, 19] }, { hash: 'p2', range: [20, 39] }] }]);
});
test('a split that left a remainder is not remembered', () => {
  const parts = [blk('p1', 15, { hunkHash: 'H', range: [0, 19] }), blkNoEntry('r', { hunkHash: 'H' })];
  assert.deepEqual(of([run(1, { scores: [file('src/a.ts', parts)] })]).files[0]!.splits, []);
});
test('parts with no range, from an old result, are no split but keep their scores', () => {
  const parts = [blk('p1', 15, { hunkHash: 'H' }), blk('p2', 92, { hunkHash: 'H' })];
  const f = of([run(1, { scores: [file('src/a.ts', parts)] })]).files[0]!;
  assert.deepEqual(f.splits, []);
  assert.deepEqual(f.blocks.map((b) => [b.hash, b.entry.score]), [['p1', 15], ['p2', 92]]);
});
test('a split is the newest run\'s parts', () => {
  const first = [blk('p1', 15, { hunkHash: 'H', range: [0, 19] }), blk('p2', 92, { hunkHash: 'H', range: [20, 39] })];
  const second = [blk('q1', 20, { hunkHash: 'H', range: [0, 9] }), blk('q2', 30, { hunkHash: 'H', range: [10, 39] })];
  assert.deepEqual(of([run(1, { scores: [file('src/a.ts', first)] }), run(2, { scores: [file('src/a.ts', second)] })]).files[0]!.splits,
    [{ hunkHash: 'H', parts: [{ hash: 'q1', range: [0, 9] }, { hash: 'q2', range: [10, 39] }] }]);
});
test('a block is remembered as stood for only by a run that left the file covered', () => {
  const stood = (over: Partial<FileScore>) => of([run(1, { scores: [file('src/a.ts', [blkNoEntry('h1')], { wholeFile: entry(60), covered: true, ...over })] })]).files[0]!.stoodFor;
  assert.deepEqual([stood({}), stood({ covered: false }), stood({ wholeFile: null })], [['h1'], [], []]);
});
test('a block that has a score of its own is not stood for', () => {
  const runs = [
    run(1, { scores: [file('src/a.ts', [blk('h1', 30)])] }),
    run(2, { scores: [file('src/a.ts', [blkNoEntry('h1'), blkNoEntry('h2')], { wholeFile: entry(60), covered: true })] }),
  ];
  assert.deepEqual(of(runs).files[0]!.stoodFor, ['h2']);
});
test('with the scorer nothing is stood for', () => {
  const runs = [run(1, { scores: [file('src/a.ts', [blkNoEntry('h1')], { wholeFile: entry(60), covered: true })] })];
  assert.deepEqual(of(runs, null, 'scorer').files[0]!.stoodFor, []);
});
test('a whole-file score is never forgotten', () => {
  const runs = [
    run(1, { scores: [file('src/a.ts', [], { wholeFile: entry(60) })] }),
    run(2, { scores: [file('src/a.ts', [])] }),
    run(3, { scores: [file('src/a.ts', [], { wholeFile: entry(40) })] }),
  ];
  assert.equal(of(runs.slice(0, 2)).files[0]!.wholeFile?.score, 60);
  assert.equal(of(runs).files[0]!.wholeFile?.score, 60);
  assert.equal(of([run(1, { scores: [file('src/a.ts', [])] })]).files[0]!.wholeFile, null);
});
test('a file is covered at a diff by a published run that read it there, whatever that run left unscored', () => {
  const at = (over: Partial<StoredRun>, coverage: unknown, covered: boolean) =>
    of([run(1, { scores: [file('src/a.ts', [blkNoEntry('h1')], { covered })], coverage }, over)]).files[0]!.coveredAt;
  assert.deepEqual(at({}, reviewed('src/a.ts'), true), []);
  assert.deepEqual(at(published, reviewed('src/a.ts'), true), ['d1']);
  assert.deepEqual(at(published, reviewed('src/a.ts'), false), ['d1']);
  assert.deepEqual(at(published, reviewed(), true), []);
});
test('a file was last read at the head of the newest published run that read it, not at the last review', () => {
  const r1 = run(1, { scores: [file('src/a.ts', [blk('p1', 10, { hunkHash: 'H' }), blkNoEntry('h2')])], coverage: reviewed('src/a.ts') }, { ...published, headSha: 'h0' });
  const r2 = run(2, { scores: [file('src/a.ts', [blk('h3', 10)])], coverage: { reviewed: [], notReviewed: [{ path: 'src/a.ts', reason: 'too_large' }] } }, { ...published, headSha: 'h1' });
  const h = of([r1, r2], r2);
  assert.deepEqual(h.files[0]!.readAt, { head: 'h0', hashes: ['p1', 'H', 'h2'] });
  assert.equal(h.lastReview?.head, 'h1');
  assert.equal(of([run(1, { scores: [file('src/a.ts', [])], coverage: reviewed('src/a.ts') })]).files[0]!.readAt, null);
});
test('the last review is the newest published run that is not a re-check', () => {
  const runs = [run(1, {}, published), run(2, {}, { ...published, mode: 'recheck' }), run(3, {})];
  assert.equal(lastReviewOf(runs)?.id, 1);
  assert.equal(lastReviewOf([run(3, {})]), null);
  assert.deepEqual(of(runs, lastReviewOf(runs)).lastReview, { head: 'h1', overview: 'overview 1' });
  assert.deepEqual(of(runs, { ...runs[0]!, result: {} }).lastReview, { head: 'h1', overview: '' });
});
test('what was last shown is the newest published run of any mode', () => {
  const scores = (n: number) => [file('src/a.ts', [blk('h1', n)])];
  const runs = [run(1, { scores: scores(80) }, published), run(2, { scores: scores(90) }, { ...published, mode: 'recheck' }), run(3, { scores: scores(95) })];
  const shown = of(runs, lastReviewOf(runs)).shown;
  assert.notEqual(shown, null);
  assert.equal(shown, shownOf(runs[1]!.result));
});
test('with no published run there is no last review and nothing was shown', () => {
  const h = of([run(1, {})], null);
  assert.equal(h.lastReview, null);
  assert.equal(h.shown, null);
});
test('a hunk one old review scored whole and a later one split does not stand below its highest part', () => {
  const p2 = blk('p2', 92, { hunkHash: 'H', entry: { score: 92, category: 'billing', reason: 'the total' } });
  const h = of([run(1, { scores: [file('src/a.ts', [blk('H', 50)])] }), run(2, { scores: [file('src/a.ts', [blk('p1', 15, { hunkHash: 'H' }), p2])] })]);
  assert.deepEqual(h.files[0]!.blocks.map((b) => [b.hash, b.entry, b.raisedFrom]), [
    ['H', { score: 92, category: 'billing', reason: 'the total' }, null],
    ['p1', entry(15), null],
    ['p2', { score: 92, category: 'billing', reason: 'the total' }, null],
  ]);
});
test('a hunk no run scored whole is not added for its parts', () => {
  const h = of([run(1, { scores: [file('src/a.ts', [blk('p1', 15, { hunkHash: 'H' }), blk('p2', 92, { hunkHash: 'H' })])] })]);
  assert.deepEqual(h.files[0]!.blocks.map((b) => b.hash), ['p1', 'p2']);
});
test('a file is kept under the path each run knew it by', () => {
  const h = of([run(1, { scores: [file('src/a.ts', [blk('h1', 30)])] }), run(2, { scores: [file('src/b.ts', [blk('h1', 30)], { previousPath: 'src/a.ts' })] })]);
  assert.deepEqual(h.files.map((f) => f.path), ['src/a.ts', 'src/b.ts']);
});
test('only what a run gave is stored for others, with the score that was given', () => {
  const result = { scores: [file('src/a.ts', [blk('h1', 40), blk('h2', 80, { origin: 'earlier_run' }), blk('h3', 90, { raisedFrom: 30 }), blk('h4', 70, { origin: 'other_pull_request' }), blkNoEntry('h5')])] };
  assert.deepEqual(scoresToStore(result).map((s) => [s.hash, s.score]), [['h1', 40], ['h3', 30]]);
  assert.deepEqual(scoresToStore({}), []);
});
test('a score stored for others carries its path, category and reason', () => {
  assert.deepEqual(scoresToStore({ scores: [file('src/a.ts', [blk('h1', 40)])] }), [{ path: 'src/a.ts', hash: 'h1', score: 40, category: 'feature', reason: 'reason 40' }]);
  assert.deepEqual(scoresToStore(null), []);
});
test('runs passed out of order are read in the order of their ids', () => {
  const r1 = run(1, { scores: [file('src/a.ts', [blk('p1', 15, { hunkHash: 'H', range: [0, 19] }), blk('p2', 20, { hunkHash: 'H', range: [20, 39] })], { wholeFile: entry(60, 'old') })], coverage: reviewed('src/a.ts') }, published);
  const r2 = run(2, { scores: [file('src/a.ts', [blk('q1', 15, { hunkHash: 'H', range: [0, 9] }), blk('q2', 80, { hunkHash: 'H', range: [10, 39] })], { wholeFile: entry(60, 'new') })], coverage: reviewed('src/a.ts') }, published);
  const h = of([r2, r1]);
  const f = h.files[0]!;
  assert.equal(f.wholeFile?.reason, 'new');
  assert.equal(f.readAt?.head, 'h2');
  assert.deepEqual(f.splits.map((s) => s.parts.map((p) => p.hash)), [['q1', 'q2']]);
  assert.equal(h.shown, shownOf(r2.result));
  assert.notEqual(shownOf(r1.result), shownOf(r2.result));
});
test('within one run the first of two blocks with the same hash and score gives the entry', () => {
  const h = of([run(1, { scores: [file('src/a.ts', [blk('h1', 50, { entry: entry(50, 'first') }), blk('h1', 50, { entry: entry(50, 'second') })])] })]);
  assert.equal(h.files[0]!.blocks[0]!.entry.reason, 'first');
});
test('a whole-file score takes the newest run on a tie', () => {
  const h = of([run(1, { scores: [file('src/a.ts', [], { wholeFile: entry(60, 'old') })] }), run(2, { scores: [file('src/a.ts', [], { wholeFile: entry(60, 'new') })] })]);
  assert.equal(h.files[0]!.wholeFile?.reason, 'new');
});
test('a split whose part was given by the other scorer is no split', () => {
  const parts = [blk('p1', 15, { hunkHash: 'H', range: [0, 19] }), blk('p2', 92, { hunkHash: 'H', range: [20, 39], by: 'scorer' })];
  assert.deepEqual(of([run(1, { scores: [file('src/a.ts', parts)] })]).files[0]!.splits, []);
});
test('a block whose entry cannot be read is not stood for', () => {
  const bad = { ...blk('h1', 0), entry: { score: 150, category: 'feature', reason: '' } };
  const f = of([run(1, { scores: [{ ...file('src/a.ts', [], { wholeFile: entry(60), covered: true }), blocks: [bad, blkNoEntry('h2')] }] })]).files[0]!;
  assert.deepEqual(f.stoodFor, ['h2']);
});
test('an entry with a category that is not one is skipped', () => {
  const odd = { ...blk('h1', 0), entry: { score: 50, category: 'nope', reason: '' } };
  assert.deepEqual(of([run(1, { scores: [{ ...file('src/a.ts', []), blocks: [odd, blk('h2', 10)] }] })]).files[0]!.blocks.map((b) => b.hash), ['h2']);
});
test("a newer run whose hunk has a remainder does not erase an older run's complete split", () => {
  const whole = [blk('p1', 15, { hunkHash: 'H', range: [0, 19] }), blk('p2', 92, { hunkHash: 'H', range: [20, 39] })];
  const rest = [blk('q1', 15, { hunkHash: 'H', range: [0, 9] }), blkNoEntry('r', { hunkHash: 'H' })];
  assert.deepEqual(of([run(1, { scores: [file('src/a.ts', whole)] }), run(2, { scores: [file('src/a.ts', rest)] })]).files[0]!.splits,
    [{ hunkHash: 'H', parts: [{ hash: 'p1', range: [0, 19] }, { hash: 'p2', range: [20, 39] }] }]);
});
test('a hunk is raised to its highest part whatever order the hunks are met in', () => {
  const h = of([
    run(1, { scores: [file('src/a.ts', [blk('H2', 40), blk('H', 30)])] }),
    run(2, { scores: [file('src/a.ts', [blk('H', 30, { hunkHash: 'H2' })])] }),
    run(3, { scores: [file('src/a.ts', [blk('p', 90, { hunkHash: 'H' })])] }),
  ]);
  assert.deepEqual(h.files[0]!.blocks.map((b) => [b.hash, b.entry.score]), [['H2', 90], ['H', 90], ['p', 90]]);
});
test('a score whose given score cannot be read is not stored for others', () => {
  const odd = { ...blk('h1', 90), raisedFrom: 12.5 };
  assert.deepEqual(scoresToStore({ scores: [{ ...file('src/a.ts', []), blocks: [odd, blk('h2', 40)] }] }).map((s) => [s.hash, s.score]), [['h2', 40]]);
  assert.deepEqual(scoresToStore({ scores: [{ ...file('src/a.ts', []), blocks: [{ ...blk('h3', 90), raisedFrom: 'x' }] }] }), []);
});

// The engine run twice, with the history read between the two as the job reads it.
const fortyAdded: ChangedFile = {
  path: 'src/t.ts', previousPath: null, status: 'added', additions: 40, deletions: 0,
  patch: ['@@ -0,0 +1,40 @@', ...Array.from({ length: 40 }, (_, i) => `+const row${i} = ${i * 31};`)].join('\n'),
};
const PR = {
  ref: REF, title: 'Add rows', description: 'Adds rows.', author: 'octo-dev', baseBranch: 'feature', headBranch: 'topic',
  baseSha: 'b'.repeat(40), headSha: 'h'.repeat(40), draft: false,
};
const INPUT: ReviewInput = {
  pullRequest: PR, trigger: 'automatic', repoConfig: { primaryBranches: ['main'], scoreThreshold: 70 },
  limits: { inputTokensPerCall: 200_000, batchesPerReview: 6, modelTimeoutSeconds: 30 }, asOf: new Date(0), earlier: null,
};
function engine(answers: unknown[]): ReviewDeps & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests, contract: 'You review pull requests.', clock: () => new Date(0), token: () => 'abcdef0123456789', log: () => {},
    source: { listFiles: () => Promise.resolve([fortyAdded]), getFileContent: () => Promise.resolve(null), getDefaultBranchFile: () => Promise.resolve(null) },
    model: {
      complete: (request) => {
        requests.push(request);
        const answer = answers[requests.length - 1];
        if (answer === undefined) return Promise.reject(new Error('stub model exhausted'));
        return Promise.resolve({ toolName: SUBMIT_REVIEW, toolArguments: JSON.stringify(answer), text: null, model: 'm', provider: null, usage: USAGE });
      },
    },
  };
}
test('a split the model listed second part first is kept at the next review', async () => {
  const listed = { overview: 'src/t.ts adds rows.', findings: [], files: [{ path: 'src/t.ts', change_summary: 'Adds rows.', blocks: [{ id: 'B1', parts: [
    { first: 'R21', last: 'R40', score: 92, category: 'data_model', reason: 'Adds a table.' }, { first: 'R1', last: 'R20', score: 15, category: 'test' },
  ] }] }] };
  const first: ReviewResult = await review(INPUT, engine([listed]));
  assert.deepEqual(first.scores[0]!.blocks.map((b) => [b.range, b.entry?.score]), [[[20, 39], 92], [[0, 19], 15]]);
  const stored = run(1, {}, { ...published, headSha: 'h'.repeat(40), result: JSON.parse(JSON.stringify(first)) as unknown });
  const again = engine([{ overview: 'src/t.ts adds rows.', findings: [], files: [] }]);
  const second = await review({ ...INPUT, mode: 'full', history: historyOf({ runs: [stored], last: stored, by: 'model' }) }, again);
  assert.deepEqual(again.requests[0]!.messages[2]!.content.match(/### Block B\d \([^)]*\)/g), ['### Block B1 (40 changed lines, scored)']);
  assert.deepEqual(second.scores[0]!.blocks.map((b) => [b.range, b.entry?.score, b.origin, b.raisedFrom]), [[[0, 19], 15, 'earlier_run', undefined], [[20, 39], 92, 'earlier_run', undefined]]);
});
