import assert from 'node:assert/strict';
import test from 'node:test';

import { hunksOf } from '../context/build.ts';
import type { FileContext } from '../context/build.ts';
import { renderAnchoredDiff } from '../context/diff.ts';
import type { ChangedFile } from '../types.ts';
import { blocksOf, fileDiffHash, splitBlock } from './blocks.ts';
import { blocksToLookUp, keptScores } from './history.ts';
import { scorePlan } from './rules.ts';
import type { Anchor, FileHistory, ScoreEntry, ScoreHistory, StoredEntry } from './types.ts';

function ctx(path: string, patch: string, previousPath: string | null = null): FileContext {
  const file: ChangedFile = { path, previousPath, status: previousPath === null ? 'modified' : 'renamed', additions: 1, deletions: 1, patch };
  const { hunks } = hunksOf(patch);
  return {
    file, hunks, ranges: null, diffText: renderAnchoredDiff(hunks), full: null, test: null, skip: null,
    blocks: blocksOf(hunks), plan: scorePlan(file, null), hidden: false,
  };
}
function moved(path: string, previousPath: string): FileContext {
  const file: ChangedFile = { path, previousPath, status: 'renamed', additions: 0, deletions: 0, patch: null };
  return { file, hunks: [], ranges: null, diffText: null, full: null, test: null, skip: 'unchanged', blocks: [], plan: scorePlan(file, 'unchanged'), hidden: false };
}
const entry = (score: number): ScoreEntry => ({ score, category: 'fix', reason: '' });
const stored = (hash: string, score: number, raisedFrom: number | null = null): StoredEntry => ({ hash, entry: entry(score), raisedFrom });
const hist = (over: Partial<FileHistory> = {}): FileHistory =>
  ({ path: 'src/a.ts', blocks: [], splits: [], stoodFor: [], wholeFile: null, coveredAt: [], readAt: null, ...over });
const H = (files: FileHistory[], by: ScoreHistory['by'] = 'model'): ScoreHistory => ({ by, lastReview: null, shown: null, files });

const hunkAt = (start: number, text: string): string => [`@@ -${start},3 +${start},3 @@`, ' keep', '-old', `+${text}`, ' keep'].join('\n');
const PATCH_TWO_HUNKS = `${hunkAt(10, 'first')}\n${hunkAt(50, 'second')}`;
const SHIFTED = `${hunkAt(20, 'first')}\n${hunkAt(60, 'second')}`;
const newFile = (from: number, count: number): string =>
  [`@@ -0,0 +1,${count} @@`, ...Array.from({ length: count }, (_, i) => `+line ${from + i}`)].join('\n');
const R = (line: number): Anchor => ({ side: 'RIGHT', line });
const GONE = 'e'.repeat(64);

// The 40-line hunk an earlier run split in two, and its parts' hashes.
const forty = ctx('src/a.ts', newFile(1, 40));
const cut = splitBlock(forty.blocks[0]!, [{ first: R(1), last: R(20) }, { first: R(21), last: R(40) }]);
const P1 = cut.parts[0]!.hash;
const P2 = cut.parts[1]!.hash;
const split = (parts: Array<{ hash: string; range: [number, number] }>) => ({ hunkHash: forty.blocks[0]!.hash, parts });

test('a block whose hash has a stored score keeps it and is not to be scored', () => {
  const c = ctx('src/a.ts', PATCH_TWO_HUNKS);
  const k = keptScores(c, H([hist({ blocks: [stored(c.blocks[0]!.hash, 70)] })]), [])!;
  assert.deepEqual([...k.entries].map(([id, v]) => [id, v.entry.score, v.origin]), [['B1', 70, 'earlier_run']]);
  assert.deepEqual([[...k.scoredHunks], k.settled, k.floor], [['B1'], false, 0]);
});

test('the same block at other line numbers is the same block', () => {
  const before = ctx('src/a.ts', PATCH_TWO_HUNKS);
  const now = ctx('src/a.ts', SHIFTED);
  const k = keptScores(now, H([hist({ blocks: [stored(before.blocks[1]!.hash, 45, 30)] })]), [])!;
  assert.deepEqual([...k.entries].map(([id, v]) => [id, v.entry.score, v.origin, v.raisedFrom, v.range]), [['B2', 45, 'earlier_run', 30, null]]);
  assert.deepEqual([[...k.scoredHunks], k.floor], [['B2'], 0]);
});

test('a hunk an earlier run split keeps its parts when they still cover it', () => {
  const k = keptScores(forty, H([hist({
    blocks: [stored(P1, 15), stored(P2, 92)],
    splits: [split([{ hash: P1, range: [0, 19] }, { hash: P2, range: [20, 39] }])],
    coveredAt: [fileDiffHash(forty.hunks)!],
  })]), [])!;
  assert.deepEqual(k.blocks.map((b) => [b.id, b.hunk, b.hash]), [['B1.1', 'B1', P1], ['B1.2', 'B1', P2]]);
  assert.deepEqual([...k.entries].map(([id, v]) => [id, v.entry.score, v.origin, v.range]), [
    ['B1.1', 15, 'earlier_run', [0, 19]],
    ['B1.2', 92, 'earlier_run', [20, 39]],
  ]);
  assert.deepEqual([[...k.scoredHunks], k.settled, k.floor], [['B1'], true, 0]);
});

test('a split that no longer fits does not keep the hunk', () => {
  const cases: Array<{ name: string; file: FileHistory; floor: number }> = [
    {
      name: 'a range beyond the hunk',
      file: hist({ blocks: [stored(P1, 15), stored(P2, 92)], splits: [split([{ hash: P1, range: [0, 19] }, { hash: P2, range: [20, 49] }])] }),
      floor: 92,
    },
    {
      name: 'a part whose hash differs',
      file: hist({ blocks: [stored(P1, 92), stored(GONE, 15)], splits: [split([{ hash: P1, range: [0, 19] }, { hash: GONE, range: [20, 39] }])] }),
      floor: 92,
    },
    {
      name: 'a part hash with no stored entry',
      file: hist({ blocks: [stored(P1, 15)], splits: [split([{ hash: P1, range: [0, 19] }, { hash: P2, range: [20, 39] }])] }),
      floor: 15,
    },
  ];
  for (const { name, file, floor } of cases) {
    const k = keptScores(forty, H([file]), [])!;
    assert.deepEqual(k.blocks.map((b) => b.id), ['B1'], name);
    assert.equal(k.entries.size, 0, name);
    assert.equal(k.scoredHunks.size, 0, name);
    assert.equal(k.settled, false, name);
    assert.equal(k.floor, floor, name);
  }
  // Both part scores count in the floor, whichever is the higher.
  const low = hist({ blocks: [stored(P1, 92), stored(P2, 15)], splits: [split([{ hash: P1, range: [0, 19] }, { hash: P2, range: [20, 49] }])] });
  assert.equal(keptScores(forty, H([low]), [])!.floor, 92);
});

test('a split is used only for the hunk it was made of, and only with the parts it named', () => {
  // The same ranges and stored parts under another hunk's hash: not this hunk's split.
  const other = keptScores(forty, H([hist({
    blocks: [stored(P1, 15), stored(P2, 92)], splits: [{ hunkHash: GONE, parts: [{ hash: P1, range: [0, 19] }, { hash: P2, range: [20, 39] }] }],
  })]), [])!;
  assert.deepEqual([other.blocks.map((b) => b.id), other.entries.size, other.scoredHunks.size], [['B1'], 0, 0]);
  // A part whose lines now hash otherwise does not fit, even when the present lines' hash has a stored score.
  const moved = keptScores(forty, H([hist({
    blocks: [stored(P1, 15), stored(P2, 92), stored(GONE, 92)], splits: [split([{ hash: P1, range: [0, 19] }, { hash: GONE, range: [20, 39] }])],
  })]), [])!;
  assert.deepEqual([moved.blocks.map((b) => b.id), moved.entries.size, moved.scoredHunks.size], [['B1'], 0, 0]);
});

test('a part that has become a hunk of its own keeps its score, and that score is not in the floor', () => {
  const second = ctx('src/a.ts', newFile(21, 20));
  assert.equal(second.blocks[0]!.hash, P2);
  const k = keptScores(second, H([hist({
    blocks: [stored(P1, 15), stored(P2, 92)],
    splits: [split([{ hash: P1, range: [0, 19] }, { hash: P2, range: [20, 39] }])],
    coveredAt: [fileDiffHash(second.hunks)!],
  })]), [])!;
  assert.deepEqual([...k.entries].map(([id, v]) => [id, v.entry.score, v.origin, v.range]), [['B1', 92, 'earlier_run', null]]);
  assert.deepEqual(k.blocks.map((b) => b.id), ['B1']);
  assert.deepEqual([k.settled, k.floor], [true, 15]);
});

test('a block the file score stood for stays covered by it while the file keeps that score', () => {
  const c = ctx('src/a.ts', hunkAt(10, 'first'));
  const k = keptScores(c, H([hist({ stoodFor: [c.blocks[0]!.hash], wholeFile: entry(60), coveredAt: [fileDiffHash(c.hunks)!] })]), [])!;
  assert.deepEqual([[...k.stoodFor], [...k.scoredHunks], k.entries.size, k.wholeFile?.score, k.settled], [['B1'], ['B1'], 0, 60, true]);
  const none = keptScores(c, H([hist({ stoodFor: [c.blocks[0]!.hash], wholeFile: null })]), [])!;
  assert.deepEqual([[...none.stoodFor], [...none.scoredHunks], none.entries.size, none.wholeFile, none.settled], [[], [], 0, null, false]);
});

test('a score another pull request stored is used only for a block the history does not settle, and never below the floor', () => {
  const c = ctx('src/a.ts', PATCH_TWO_HUNKS);
  const [b1, b2] = [c.blocks[0]!.hash, c.blocks[1]!.hash];
  const fresh = keptScores(c, null, [{ hash: b2, entry: entry(30) }])!;
  assert.deepEqual([...fresh.entries].map(([id, v]) => [id, v.entry.score, v.origin, v.raisedFrom]), [['B2', 30, 'other_pull_request', null]]);
  assert.deepEqual([[...fresh.scoredHunks], fresh.floor, fresh.covered, fresh.readAt], [['B2'], 0, false, null]);

  const raised = keptScores(c, H([hist({ blocks: [stored(GONE, 90)] })]), [{ hash: b2, entry: entry(30) }])!;
  assert.deepEqual([...raised.entries].map(([id, v]) => [id, v.entry.score, v.origin, v.raisedFrom]), [['B2', 90, 'other_pull_request', 30]]);
  assert.equal(raised.floor, 90);

  const both = keptScores(c, H([hist({ blocks: [stored(b1, 70)] })]), [{ hash: b1, entry: entry(99) }, { hash: b2, entry: entry(30) }])!;
  assert.deepEqual([...both.entries].map(([id, v]) => [id, v.entry.score, v.origin]), [['B1', 70, 'earlier_run'], ['B2', 30, 'other_pull_request']]);
  // Every block has a score, but no published review of this pull request read the file at this diff.
  assert.equal(both.settled, false);
  const read = keptScores(c, H([hist({ blocks: [stored(b1, 70)], coveredAt: [fileDiffHash(c.hunks)!] })]), [{ hash: b2, entry: entry(30) }])!;
  assert.equal(read.settled, true);
});

test('the floor is the highest score of a block the file lost', () => {
  const c = ctx('src/a.ts', PATCH_TWO_HUNKS);
  const b1 = c.blocks[0]!.hash;
  assert.equal(keptScores(c, H([hist({ blocks: [stored(GONE, 85), stored(b1, 40)] })]), [])!.floor, 85);
  assert.equal(keptScores(c, H([hist({ blocks: [stored(b1, 40), stored(c.blocks[1]!.hash, 95)] })]), [])!.floor, 0);
});

test('a file is settled and covered when nothing is left to ask and a published run read it as it is', () => {
  const c = ctx('src/a.ts', PATCH_TWO_HUNKS);
  const diff = fileDiffHash(c.hunks)!;
  const blocks = [stored(c.blocks[0]!.hash, 20), stored(c.blocks[1]!.hash, 30)];
  const read = keptScores(c, H([hist({ blocks })]), [])!;
  assert.deepEqual([read.settled, read.covered], [false, false]);
  const seen = keptScores(c, H([hist({ blocks, coveredAt: ['f'.repeat(64), diff] })]), [])!;
  assert.deepEqual([seen.settled, seen.covered], [true, true]);
  const half = keptScores(c, H([hist({ blocks: blocks.slice(0, 1), coveredAt: [diff] })]), [])!;
  assert.deepEqual([half.settled, half.covered], [false, false]);
});

test('a moved file keeps its whole-file score and is settled and covered by it', () => {
  const m = moved('lib/a.ts', 'src/a.ts');
  const k = keptScores(m, H([hist({ wholeFile: entry(75) })]), [])!;
  assert.deepEqual([k.wholeFile?.score, k.settled, k.covered, k.blocks, k.scoredHunks.size], [75, true, true, [], 0]);
  const none = keptScores(m, H([hist({ wholeFile: null })]), [])!;
  assert.deepEqual([none.wholeFile, none.settled, none.covered], [null, false, false]);
  // The review model gives a moved file its score even when a scorer gives the block scores.
  assert.equal(keptScores(m, H([hist({ wholeFile: entry(75) })], 'scorer'), [])!.wholeFile?.score, 75);
});

test("with the scorer in force the review model's whole-file score settles nothing for a file with blocks", () => {
  const c = ctx('src/a.ts', hunkAt(10, 'first'));
  const k = keptScores(c, H([hist({ stoodFor: [c.blocks[0]!.hash], wholeFile: entry(60) })], 'scorer'), [])!;
  assert.deepEqual([[...k.stoodFor], k.wholeFile, k.scoredHunks.size, k.settled], [[], null, 0, false]);
});

test('a renamed file answers to the history of both its names', () => {
  const c = ctx('src/a.ts', PATCH_TWO_HUNKS, 'old/a.ts');
  const [b1, b2] = [c.blocks[0]!.hash, c.blocks[1]!.hash];
  const k = keptScores(c, H([
    hist({ path: 'old/a.ts', blocks: [stored(b1, 40), stored(b2, 80)], wholeFile: entry(85), readAt: { head: 'a'.repeat(40), hashes: [b1] } }),
    hist({ path: 'src/a.ts', blocks: [stored(b1, 55), stored(b2, 10)], wholeFile: entry(50) }),
  ]), [])!;
  assert.deepEqual([...k.entries].map(([id, v]) => [id, v.entry.score]), [['B1', 55], ['B2', 80]]);
  assert.equal(k.wholeFile?.score, 85);
  assert.deepEqual([k.readAt?.head, [...(k.readAt?.hashes ?? [])]], ['a'.repeat(40), [b1]]);
  // The path's own reading wins over its earlier name's.
  const own = keptScores(c, H([
    hist({ path: 'old/a.ts', readAt: { head: 'a'.repeat(40), hashes: [b1] } }),
    hist({ path: 'src/a.ts', readAt: { head: 'c'.repeat(40), hashes: [b2] } }),
  ]), [])!;
  assert.equal(own.readAt?.head, 'c'.repeat(40));
});

test('a renamed file with the same change is not covered by the review that read it under its old name, and keeps its blocks', () => {
  const c = ctx('src/a.ts', hunkAt(10, 'first'), 'old/a.ts');
  const k = keptScores(c, H([hist({ path: 'old/a.ts', blocks: [stored(c.blocks[0]!.hash, 25)], coveredAt: [fileDiffHash(c.hunks)!] })]), [])!;
  assert.deepEqual([k.settled, k.covered], [false, false]);
  assert.deepEqual([...k.entries].map(([id, v]) => [id, v.entry.score, v.origin]), [['B1', 25, 'earlier_run']]);
  assert.deepEqual([...k.scoredHunks], ['B1']);
});

test('a file whose every block is kept is not settled while no published review read it at this diff', () => {
  const c = ctx('src/a.ts', PATCH_TWO_HUNKS);
  const k = keptScores(c, H([hist({ blocks: [stored(c.blocks[0]!.hash, 20), stored(c.blocks[1]!.hash, 30)], coveredAt: ['f'.repeat(64)] })]), [])!;
  assert.deepEqual([k.settled, k.covered, [...k.scoredHunks]], [false, false, ['B1', 'B2']]);
});

test('a file whose every block is kept by a score another pull request stored is not settled', () => {
  const c = ctx('src/a.ts', PATCH_TWO_HUNKS);
  const k = keptScores(c, null, [{ hash: c.blocks[0]!.hash, entry: entry(20) }, { hash: c.blocks[1]!.hash, entry: entry(30) }])!;
  assert.deepEqual([k.settled, k.covered, [...k.scoredHunks]], [false, false, ['B1', 'B2']]);
});

test('a file with no history and no reused score, or one scored by rule, keeps nothing', () => {
  const c = ctx('src/a.ts', PATCH_TWO_HUNKS);
  assert.equal(keptScores(c, null, []), null);
  assert.equal(keptScores(c, H([hist({ path: 'src/other.ts', blocks: [stored(c.blocks[0]!.hash, 70)] })]), []), null);
  const asset: ChangedFile = { path: 'src/a.png', previousPath: null, status: 'modified', additions: 0, deletions: 0, patch: null };
  const rule: FileContext = { file: asset, hunks: [], ranges: null, diffText: null, full: null, test: null, skip: 'no_diff', blocks: [], plan: scorePlan(asset, 'no_diff'), hidden: false };
  assert.equal(keptScores(rule, H([hist({ path: 'src/a.png', wholeFile: entry(40) })]), [{ hash: GONE, entry: entry(40) }]), null);
});

test('the lookup asks only for blocks the history does not settle', () => {
  const a = ctx('src/a.ts', PATCH_TWO_HUNKS);
  const b = ctx('src/b.ts', hunkAt(10, 'other'));
  const c = ctx('src/c.ts', hunkAt(10, 'third'));
  const asset: ChangedFile = { path: 'logo.png', previousPath: null, status: 'modified', additions: 0, deletions: 0, patch: null };
  const rule: FileContext = { file: asset, hunks: [], ranges: null, diffText: null, full: null, test: null, skip: 'no_diff', blocks: [], plan: scorePlan(asset, 'no_diff'), hidden: false };
  const history = H([
    hist({ path: 'src/a.ts', blocks: [stored(a.blocks[0]!.hash, 70)] }),
    hist({ path: 'src/c.ts', stoodFor: [c.blocks[0]!.hash], wholeFile: entry(30) }),
  ]);
  assert.deepEqual(blocksToLookUp([a, b, c, rule, moved('lib/x.ts', 'src/x.ts')], history), [
    { path: 'src/a.ts', hash: a.blocks[1]!.hash },
    { path: 'src/b.ts', hash: b.blocks[0]!.hash },
  ]);
  assert.deepEqual(blocksToLookUp([a, b], null), [
    { path: 'src/a.ts', hash: a.blocks[0]!.hash },
    { path: 'src/a.ts', hash: a.blocks[1]!.hash },
    { path: 'src/b.ts', hash: b.blocks[0]!.hash },
  ]);
  // A hunk kept by its parts is not looked up.
  const parts = H([hist({ blocks: [stored(P1, 15), stored(P2, 92)], splits: [split([{ hash: P1, range: [0, 19] }, { hash: P2, range: [20, 39] }])] })]);
  assert.deepEqual(blocksToLookUp([forty], parts), []);
});

// A file the pull request adds, and a later push renames, is shown as added under its new name.
function added(path: string, patch: string): FileContext {
  const c = ctx(path, patch);
  return { ...c, file: { ...c.file, status: 'added' } };
}

test('a file the pull request adds, with no history of its own, answers to the history of a path that left the diff', () => {
  const c = added('src/new.ts', hunkAt(10, 'first'));
  const history = H([hist({ path: 'old/a.ts', blocks: [stored(c.blocks[0]!.hash, 92)], coveredAt: [fileDiffHash(c.hunks)!] })]);
  const k = keptScores(c, history, [])!;
  assert.deepEqual([...k.entries].map(([id, v]) => [id, v.entry.score, v.origin]), [['B1', 92, 'earlier_run']]);
  assert.deepEqual([[...k.scoredHunks], k.settled, k.covered], [['B1'], false, false]);
  // The lookup does not ask for it.
  assert.deepEqual(blocksToLookUp([c], history), []);
  // A file that is not added does not.
  assert.equal(keptScores(ctx('src/new.ts', hunkAt(10, 'first')), history, []), null);
});

test('a path still in the diff is answered to as well: a copy keeps the scores of what it copies', () => {
  const c = added('src/new.ts', hunkAt(10, 'first'));
  const k = keptScores(c, H([hist({ path: 'old/a.ts', blocks: [stored(c.blocks[0]!.hash, 92)] })]), [])!;
  assert.deepEqual([...k.entries].map(([id, v]) => [id, v.entry.score, v.origin]), [['B1', 92, 'earlier_run']]);
});

test('a path whose whole-file score stood for one of the blocks is answered to', () => {
  const c = added('src/new.ts', hunkAt(10, 'first'));
  const k = keptScores(c, H([hist({ path: 'old/a.ts', stoodFor: [c.blocks[0]!.hash], wholeFile: entry(92) })]), [])!;
  assert.deepEqual([[...k.stoodFor], k.wholeFile?.score, [...k.scoredHunks], k.entries.size], [['B1'], 92, ['B1'], 0]);
});

test('a path that left the diff and holds none of the file\'s blocks is not answered to', () => {
  const c = added('src/new.ts', hunkAt(10, 'first'));
  assert.equal(keptScores(c, H([hist({ path: 'old/a.ts', blocks: [stored(GONE, 92)] })]), []), null);
});

test('a new block of such a file is held to the floor of the path it answers to', () => {
  const c = added('src/new.ts', PATCH_TWO_HUNKS);
  const k = keptScores(c, H([hist({ path: 'old/a.ts', blocks: [stored(c.blocks[0]!.hash, 40), stored(GONE, 85)] })]), [])!;
  assert.deepEqual([...k.entries].map(([id, v]) => [id, v.entry.score]), [['B1', 40]]);
  assert.equal(k.floor, 85);
});

test('a split of the path it answers to keeps its parts when they fit', () => {
  const c = added('src/new.ts', newFile(1, 40));
  const k = keptScores(c, H([hist({
    path: 'old/a.ts', blocks: [stored(P1, 15), stored(P2, 92)], splits: [split([{ hash: P1, range: [0, 19] }, { hash: P2, range: [20, 39] }])],
  })]), [])!;
  assert.deepEqual([...k.entries].map(([id, v]) => [id, v.entry.score, v.range]), [['B1.1', 15, [0, 19]], ['B1.2', 92, [20, 39]]]);
});

test('an added file with a history of its own answers to that history only', () => {
  const c = added('src/new.ts', hunkAt(10, 'first'));
  const k = keptScores(c, H([hist({ path: 'src/new.ts', blocks: [stored(GONE, 10)] }), hist({ path: 'old/a.ts', blocks: [stored(c.blocks[0]!.hash, 92)] })]), [])!;
  assert.deepEqual([k.entries.size, k.floor], [0, 10]);
});
