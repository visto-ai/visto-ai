import assert from 'node:assert/strict';
import test from 'node:test';

import { blocksOf } from '../score/blocks.ts';
import { parsePatch } from './diff.ts';
import type { Range } from './diff.ts';
import { changedLines, changedText, isChanged, leftBlocksOf } from './increment.ts';

const lines = (count: number, prefix: string): string => Array.from({ length: count }, (_, i) => `${prefix} ${i}`).join('\n') + '\n';

test('the lines a file gained or changed, by their new numbers', () => {
  assert.deepEqual(changedLines('a\nb\nc\n', 'a\nB\nc\nd\n'), [[2, 2], [4, 4]]);
  assert.deepEqual(changedLines('a\nb\n', 'a\nb\n'), []);
});

test('code that only moved down is not changed', () => {
  const body = lines(20, 'body');
  assert.deepEqual(changedLines(body, lines(10, 'top') + body), [[1, 10]]);
});

test('two contents too different to compare are not compared', () => {
  assert.equal(changedLines(lines(6000, 'old'), lines(6000, 'new')), null);
});

test('a finding is on a changed line when the file is new to the reviewer, the line changed, or its removed line is in a new hunk', async (t) => {
  const blocks = blocksOf(parsePatch([
    '@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c',
    '@@ -20,3 +20,3 @@', ' x', '-y', '+Y', ' z',
  ].join('\n')));
  const some = { all: false, right: [[2, 2]] as Range[], leftBlocks: ['B2'] };
  await t.test('a file new to the reviewer is changed on every line', () => {
    const all = { all: true, right: [], leftBlocks: [] };
    assert.deepEqual([isChanged(all, blocks, 'RIGHT', 3), isChanged(all, blocks, 'LEFT', 2)], [true, true]);
  });
  await t.test('a new-side line is changed inside the ranges and not outside them', () => {
    assert.deepEqual([isChanged(some, blocks, 'RIGHT', 2), isChanged(some, blocks, 'RIGHT', 3), isChanged(some, blocks, 'RIGHT', 21)], [true, false, false]);
  });
  await t.test('a removed line is changed in a hunk of leftBlocks and not in another', () => {
    assert.deepEqual([isChanged(some, blocks, 'LEFT', 21), isChanged(some, blocks, 'LEFT', 2)], [true, false]);
  });
});

test('the header says what changed', () => {
  assert.deepEqual([{ all: true, right: [], leftBlocks: [] }, { all: false, right: [], leftBlocks: [] }, { all: false, right: [[4, 4], [11, 12]] as Range[], leftBlocks: ['B2'] }, { all: false, right: [], leftBlocks: ['B1', 'B3'] }].map(changedText),
    ['all', 'none', 'R4, R11-R12; removed lines of B2', 'removed lines of B1, B3']);
});

const addedThenRemoved = blocksOf(parsePatch([
  '@@ -1,2 +1,3 @@', ' a1', '+new2', ' a3',
  '@@ -8,3 +9,3 @@', ' b8', '-old9', '+b10', ' b11',
].join('\n')));

test('a new hunk that only adds lines is not named for its removed lines', async (t) => {
  await t.test('it is not in leftBlocks', () => {
    assert.deepEqual(leftBlocksOf(addedThenRemoved, new Set()), ['B2']);
  });
  await t.test('the header gives the ranges alone', () => {
    assert.equal(changedText({ all: false, right: [[2, 2]], leftBlocks: leftBlocksOf(addedThenRemoved.slice(0, 1), new Set()) }), 'R2');
  });
});

test('a new hunk with a removed line is still listed, and a hunk the review read is not', () => {
  assert.deepEqual(leftBlocksOf(addedThenRemoved, new Set([addedThenRemoved[0]!.hash])), ['B2']);
  assert.deepEqual(leftBlocksOf(addedThenRemoved, new Set([addedThenRemoved[1]!.hash])), []);
});

test('the old side of a new hunk that only adds lines is not changed, and that of a new hunk with a removed line is', async (t) => {
  const changed = { all: false, right: [], leftBlocks: leftBlocksOf(addedThenRemoved, new Set()) };
  await t.test('a context line of the added-only hunk', () => {
    assert.equal(isChanged(changed, addedThenRemoved, 'LEFT', 2), false);
  });
  await t.test('the removed line of the other hunk', () => {
    assert.equal(isChanged(changed, addedThenRemoved, 'LEFT', 9), true);
  });
});
