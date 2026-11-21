import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePatch } from '../context/diff.ts';
import type { Anchor } from './types.ts';
import { SPLIT_ABOVE, blocksOf, fileDiffHash, linesOf, parseAnchor, partsAt, rangeOf, splitBlock } from './blocks.ts';

const patch = (start: number) =>
  [`@@ -${start},4 +${start},5 @@`, ' keep', '-old one', '+new one', '+new two', ' keep', ' keep'].join('\n');
const R = (line: number): Anchor => ({ side: 'RIGHT', line });

const newFile = (count: number) =>
  [`@@ -0,0 +1,${count} @@`, ...Array.from({ length: count }, (_, i) => `+line ${i + 1}`)].join('\n');

test('the split threshold is 30 changed lines', () => {
  assert.equal(SPLIT_ABOVE, 30);
});

test('one block per hunk, with anchors, changed lines and span', () => {
  const [b] = blocksOf(parsePatch(patch(10)));
  assert.equal(b!.id, 'B1');
  assert.equal(b!.hunk, 'B1');
  assert.equal(b!.hunkHash, b!.hash);
  assert.deepEqual(b!.changed, [{ side: 'LEFT', line: 11 }, { side: 'RIGHT', line: 11 }, { side: 'RIGHT', line: 12 }]);
  assert.equal(b!.anchors.length, 6);
  assert.deepEqual(b!.span, { side: 'RIGHT', first: 11, last: 12 });
  assert.deepEqual(linesOf(b!), { RIGHT: [[10, 14]], LEFT: [[10, 13]] });
});

test('lines holds a context line on both sides, with its old and its new number', () => {
  const [b] = blocksOf(parsePatch(['@@ -20,3 +25,4 @@', ' keep', '+added', ' keep', ' keep'].join('\n')));
  assert.deepEqual(linesOf(b!), { RIGHT: [[25, 28]], LEFT: [[20, 22]] });
});

test('a block that only moved keeps its hash; a changed line changes it; a context line does not', () => {
  const at = (p: string) => blocksOf(parsePatch(p))[0]!.hash;
  assert.equal(at(patch(10)), at(patch(40)));
  assert.notEqual(at(patch(10)), at(patch(10).replace('+new two', '+new 2')));
  assert.equal(at(patch(10)), at(patch(10).replace(' keep', ' kept')));
  assert.match(at(patch(10)), /^[0-9a-f]{64}$/);
});

test('a block that only removes lines has a span on the old side', () => {
  const [b] = blocksOf(parsePatch(['@@ -5,3 +5,1 @@', ' keep', '-gone one', '-gone two'].join('\n')));
  assert.deepEqual(b!.span, { side: 'LEFT', first: 6, last: 7 });
});

test('meta lines have no anchor', () => {
  const [b] = blocksOf(parsePatch(['@@ -1,1 +1,2 @@', ' keep', '+added', '\\ No newline at end of file'].join('\n')));
  assert.equal(b!.anchors.length, 2);
  assert.equal(b!.changed.length, 1);
});

test('two hunks are B1 and B2, and the file hash covers both', () => {
  const hunks = parsePatch(`${patch(10)}\n${patch(50).replace('+new two', '+other')}`);
  const blocks = blocksOf(hunks);
  assert.deepEqual(blocks.map((b) => b.id), ['B1', 'B2']);
  const whole = fileDiffHash(hunks)!;
  assert.match(whole, /^[0-9a-f]{64}$/);
  assert.notEqual(whole, blocks[0]!.hash);
  assert.notEqual(whole, blocks[1]!.hash);
  assert.equal(fileDiffHash([]), null);
});

test('the file hash of a one-hunk file equals that block hash', () => {
  const hunks = parsePatch(patch(10));
  assert.equal(fileDiffHash(hunks), blocksOf(hunks)[0]!.hash);
});

test('parseAnchor', () => {
  assert.deepEqual(parseAnchor('R142'), { side: 'RIGHT', line: 142 });
  assert.deepEqual(parseAnchor(' L98 '), { side: 'LEFT', line: 98 });
  for (const bad of ['142', 'R0', 'R-1', 'R+1', 'R007', 'X5', 'R1.5', 'R 5', 'r5', '']) assert.equal(parseAnchor(bad), null);
});

test('two parts cover the block', () => {
  const [b] = blocksOf(parsePatch(newFile(40)));
  const out = splitBlock(b!, [{ first: R(1), last: R(20) }, { first: R(21), last: R(40) }]);
  assert.deepEqual(out.parts.map((p) => p?.id), ['B1.1', 'B1.2']);
  assert.equal(out.rest, null);
  assert.equal(out.parts[0]!.hunk, 'B1');
  assert.equal(out.parts[0]!.hunkHash, b!.hash);
  assert.notEqual(out.parts[0]!.hash, b!.hash);
  assert.equal(out.parts[0]!.changed.length, 20);
  assert.deepEqual(out.parts[1]!.span, { side: 'RIGHT', first: 21, last: 40 });
});

test('a part hash equals the hash of the same lines as a block of their own', () => {
  const [whole] = blocksOf(parsePatch(newFile(40)));
  const [small] = blocksOf(parsePatch(newFile(20)));
  const out = splitBlock(whole!, [{ first: R(1), last: R(20) }]);
  assert.equal(out.parts[0]!.hash, small!.hash);
});

test('lines in no part are the rest', () => {
  const [b] = blocksOf(parsePatch(newFile(40)));
  const out = splitBlock(b!, [{ first: R(1), last: R(20) }]);
  assert.equal(out.rest!.id, 'B1.rest');
  assert.equal(out.rest!.changed.length, 20);
  assert.equal(out.rest!.anchors.length, 20);
  assert.equal(out.rest!.hunkHash, b!.hash);
  assert.deepEqual(out.rest!.span, { side: 'RIGHT', first: 21, last: 40 });
});

test('an overlapping, a reversed and an outside part are dropped, and their lines go to the rest', () => {
  const [b] = blocksOf(parsePatch(newFile(40)));
  const out = splitBlock(b!, [
    { first: R(1), last: R(20) },
    { first: R(15), last: R(30) },
    { first: R(40), last: R(31) },
    { first: R(35), last: R(99) },
  ]);
  assert.deepEqual(out.parts.map((p) => p?.id ?? null), ['B1.1', null, null, null]);
  assert.equal(out.rest!.changed.length, 20);
});

test('a part that holds only context lines is dropped', () => {
  const [b] = blocksOf(parsePatch(patch(10)));
  const out = splitBlock(b!, [{ first: R(13), last: R(14) }]);
  assert.deepEqual(out.parts, [null]);
  assert.equal(out.rest!.changed.length, 3);
});

test('a part may span context lines and both sides', () => {
  const [b] = blocksOf(parsePatch(patch(10)));
  const out = splitBlock(b!, [{ first: { side: 'LEFT', line: 11 }, last: R(11) }]);
  assert.equal(out.parts[0]!.id, 'B1.1');
  assert.equal(out.parts[0]!.changed.length, 2);
  assert.equal(out.rest!.changed.length, 1);
});

test('a part knows its place among the changed lines of its hunk, and the hunk can be cut there again', () => {
  // A hunk with context lines between its changed lines: places count changed lines only.
  const text = ['@@ -1,6 +1,8 @@', ' keep', '-old one', '+new one', ' keep', '+new two', '+new three', ' keep', '-old two', '+new four', ' keep'].join('\n');
  const [b] = blocksOf(parsePatch(text));
  assert.equal(b!.changed.length, 6);
  const L = (line: number): Anchor => ({ side: 'LEFT', line });
  const made = splitBlock(b!, [{ first: L(2), last: R(5) }, { first: L(5), last: R(7) }]);
  assert.equal(made.rest, null);
  const one = made.parts[0]!;
  const two = made.parts[1]!;
  assert.deepEqual([rangeOf(b!, one), rangeOf(b!, two)], [[0, 3], [4, 5]]);
  const again = partsAt(b!, [[0, 3], [4, 5]])!;
  assert.deepEqual(again.map((p) => p.id), ['B1.1', 'B1.2']);
  assert.deepEqual(again.map((p) => p.hash), [one.hash, two.hash]);
  assert.deepEqual(again.map((p) => p.hunkHash), [b!.hash, b!.hash]);
  assert.deepEqual(partsAt(b!, [[0, 5]])!.map((p) => p.hash), [splitBlock(b!, [{ first: L(2), last: R(7) }]).parts[0]!.hash]);
  assert.equal(partsAt(b!, [[0, 3], [4, 6]]), null);   // beyond the hunk
  assert.equal(partsAt(b!, [[-1, 3], [4, 5]]), null);  // before it
  assert.equal(partsAt(b!, [[0, 4], [4, 5]]), null);   // overlapping
  assert.equal(partsAt(b!, [[4, 5], [0, 3]]), null);   // out of order
  assert.equal(partsAt(b!, [[0, 2], [4, 5]]), null);   // a changed line left over
  assert.equal(partsAt(b!, [[0, 3]]), null);           // a remainder at the end
  assert.equal(partsAt(b!, [[3, 1], [4, 5]]), null);   // reversed
  assert.equal(partsAt(b!, [[0, 3.5], [4, 5]]), null); // not a place
  assert.equal(partsAt(b!, []), null);
});
