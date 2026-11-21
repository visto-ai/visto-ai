import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ANCHOR_LEGEND,
  commentableRanges,
  parsePatch,
  patchFromContents,
  renderAnchoredDiff,
} from './diff.ts';

const patch = '@@ -10,3 +10,4 @@ def total\n ctx1\n-old\n+new1\n+new2\n ctx2';

test('parsePatch numbers context, added and removed lines from the hunk header', () => {
  const hunks = parsePatch(patch);
  assert.equal(hunks.length, 1);
  const hunk = hunks[0]!;
  assert.equal(hunk.header, '@@ -10,3 +10,4 @@ def total');
  assert.equal(hunk.oldStart, 10);
  assert.equal(hunk.newStart, 10);
  assert.equal(hunk.newLength, 4);
  assert.deepEqual(
    hunk.lines.map((l) => [l.kind, l.text, l.oldLine, l.newLine]),
    [
      ['ctx', 'ctx1', 10, 10],
      ['del', 'old', 11, null],
      ['add', 'new1', null, 11],
      ['add', 'new2', null, 12],
      ['ctx', 'ctx2', 12, 13],
    ],
  );
});

test('a header without a length means one line', () => {
  const hunk = parsePatch('@@ -1 +1 @@\n-a\n+b')[0]!;
  assert.equal(hunk.newLength, 1);
  assert.equal(parsePatch('@@ -1,2 +0,0 @@\n-a\n-b')[0]!.newLength, 0);
});

test('exact anchored format', () => {
  assert.equal(
    renderAnchoredDiff(parsePatch(patch)),
    '### Block B1 (3 changed lines, not scored)\n@@ -10,3 +10,4 @@ def total\nR10     | ctx1\nL11     |-old\nR11     |+new1\nR12     |+new2\nR13     | ctx2',
  );
});

test('each hunk opens with its block header', () => {
  const twoHunks = patch + '\n@@ -40,2 +41,3 @@\n x\n+b\n y';
  const text = renderAnchoredDiff(parsePatch(twoHunks));
  assert.match(text, /^### Block B1 \(3 changed lines, not scored\)\n@@ /);
  assert.match(text, /\n### Block B2 \(1 changed line, not scored\)\n@@ /);
});

test('a hunk that has its score says so in its header, and the others say what they said', () => {
  const twoHunks = patch + '\n@@ -40,2 +41,3 @@\n x\n+b\n y';
  const hunks = parsePatch(twoHunks);
  const text = renderAnchoredDiff(hunks, new Set(['B2']));
  assert.match(text, /^### Block B1 \(3 changed lines, not scored\)\n@@ /);
  assert.match(text, /\n### Block B2 \(1 changed line, scored\)\n@@ /);
  assert.equal(text.replace('1 changed line, scored', '1 changed line, not scored'), renderAnchoredDiff(hunks));
  assert.equal(renderAnchoredDiff(hunks, new Set()), renderAnchoredDiff(hunks));
});

test('commentable ranges', () => {
  assert.deepEqual(commentableRanges(parsePatch(patch)), { RIGHT: [[10, 13]], LEFT: [[11, 11]] });
});

test('numbering restarts at each hunk', () => {
  const two = patch + '\n@@ -40,1 +41,1 @@\n-a\n+b';
  assert.deepEqual(commentableRanges(parsePatch(two)).RIGHT, [[10, 13], [41, 41]]);
});

test('ranges collapse across multiple hunks', () => {
  assert.deepEqual(
    commentableRanges(parsePatch('@@ -1,2 +1,2 @@\n a\n-b\n+B\n@@ -40,2 +40,3 @@\n x\n+y\n z')),
    { RIGHT: [[1, 2], [40, 42]], LEFT: [[2, 2]] },
  );
});

test('the no-newline marker has no anchor', () => {
  const hunks = parsePatch('@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file');
  assert.match(renderAnchoredDiff(hunks), /\n\\ No newline at end of file$/);
  const marker = hunks[0]!.lines[2]!;
  assert.equal(marker.kind, 'meta');
  assert.equal(marker.oldLine, null);
  assert.equal(marker.newLine, null);
});

test('the marker does not move the numbering of the next hunk', () => {
  const hunks = parsePatch('@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n@@ -40,2 +41,2 @@\n x\n+y');
  assert.equal(hunks.length, 2);
  assert.deepEqual(hunks[1]!.lines.map((l) => l.newLine), [41, 42]);
  assert.equal(hunks[1]!.lines[0]!.oldLine, 40);
});

test('diff-looking content inside a hunk is content', () => {
  const h = parsePatch('@@ -1,2 +1,2 @@\n ctx\n+--- a/foo');
  assert.equal(h.length, 1);
  assert.equal(h[0]!.lines[1]!.kind, 'add');
});

test('content that looks like diff syntax is numbered as content, not parsed as a header', () => {
  const content = '@@ -5,3 +5,3 @@\n--- a/foo\n+++ b/foo\n @@ -9 +9 @@';
  assert.equal(
    renderAnchoredDiff(parsePatch(content)),
    '### Block B1 (2 changed lines, not scored)\n@@ -5,3 +5,3 @@\nL5      |--- a/foo\nR5      |+++ b/foo\nR6      | @@ -9 +9 @@',
  );
  assert.deepEqual(commentableRanges(parsePatch(content)), { RIGHT: [[5, 6]], LEFT: [[5, 5]] });
});

test('a zero-length line inside a hunk is dropped', () => {
  const hunk = parsePatch('@@ -1,2 +1,2 @@\n a\n\n+b')[0]!;
  assert.deepEqual(hunk.lines.map((l) => [l.kind, l.newLine]), [['ctx', 1], ['add', 2]]);
});

test('text before the first hunk is ignored', () => {
  assert.deepEqual(parsePatch('diff --git a/x b/x\n--- a/x\n+++ b/x'), []);
  assert.deepEqual(parsePatch(''), []);
});

test('new-file and deleted-file patches', () => {
  assert.deepEqual(commentableRanges(parsePatch('@@ -0,0 +1,2 @@\n+a\n+b')), { RIGHT: [[1, 2]], LEFT: [] });
  assert.deepEqual(commentableRanges(parsePatch('@@ -1,2 +0,0 @@\n-a\n-b')), { RIGHT: [], LEFT: [[1, 2]] });
});

test('the legend explains both anchors and the lines without one', () => {
  assert.match(ANCHOR_LEGEND, /R<n>/);
  assert.match(ANCHOR_LEGEND, /L<n>/);
  assert.match(ANCHOR_LEGEND, /no anchor/);
});

test('patchFromContents round-trips through parsePatch', () => {
  const p = patchFromContents('a\nb\nc\n', 'a\nB\nc\n');
  assert.deepEqual(commentableRanges(parsePatch(p!)), { RIGHT: [[1, 3]], LEFT: [[2, 2]] });
  assert.equal(patchFromContents('same\n', 'same\n'), '');
});

test('patchFromContents has no file headers and keeps 3 lines of context', () => {
  const old = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join('\n') + '\n';
  const next = old.replace('l10\n', 'ten\n');
  const p = patchFromContents(old, next)!;
  assert.ok(p.startsWith('@@ -7,7 +7,7 @@\n'));
  assert.doesNotMatch(p, /^(---|\+\+\+|Index)/m);
});

test('patchFromContents handles an empty side', () => {
  assert.deepEqual(commentableRanges(parsePatch(patchFromContents('', 'a\nb\n')!)), { RIGHT: [[1, 2]], LEFT: [] });
  assert.deepEqual(commentableRanges(parsePatch(patchFromContents('a\nb\n', '')!)), { RIGHT: [], LEFT: [[1, 2]] });
});

test('CRLF content is numbered like LF content', () => {
  assert.deepEqual(
    commentableRanges(parsePatch(patchFromContents('a\r\nb\r\n', 'a\r\nB\r\n')!)).LEFT,
    [[2, 2]],
  );
});

const lines = (count: number, prefix: string): string => Array.from({ length: count }, (_, i) => `${prefix}${i}`).join('\n') + '\n';

test('patchFromContents gives up on two fully different large contents', () => {
  assert.equal(patchFromContents(lines(6000, 'old'), lines(6000, 'new')), null);
});

test('patchFromContents still diffs a small change in a large file', () => {
  const old = lines(6000, 'row');
  const next = old.replace('row10\n', 'ten\n').replace('row3000\n', 'mid\n').replace('row5990\n', 'end\n');
  const p = patchFromContents(old, next);
  assert.notEqual(p, null);
  assert.equal(parsePatch(p!).length, 3);
});
