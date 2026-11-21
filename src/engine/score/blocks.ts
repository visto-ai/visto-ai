import { createHash } from 'node:crypto';

import { toRanges } from '../context/diff.ts';
import type { Hunk, HunkLine, Ranges } from '../context/diff.ts';
import type { Anchor, Block, Span } from './types.ts';

export const SPLIT_ABOVE = 30; // a block may be split when it has more changed lines than this

// A Block carries positions, not text. The anchored lines it was built from are kept
// here so that a part of it can be hashed without the caller handing the text back.
const sourceLines = new WeakMap<Block, HunkLine[]>();

function anchorOf(line: HunkLine): Anchor | null {
  if (line.kind === 'add' || line.kind === 'ctx') return { side: 'RIGHT', line: line.newLine! };
  if (line.kind === 'del') return { side: 'LEFT', line: line.oldLine! };
  return null;
}

const isChanged = (line: HunkLine): boolean => line.kind === 'add' || line.kind === 'del';

function hashOf(lines: HunkLine[]): string {
  const hash = createHash('sha256');
  for (const line of lines) {
    if (isChanged(line)) hash.update(`${line.kind === 'add' ? '+' : '-'}${line.text}\n`);
  }
  return hash.digest('hex');
}

function spanOf(changed: HunkLine[], fallback: number): Span {
  const added = changed.filter((l) => l.kind === 'add').map((l) => l.newLine!);
  if (added.length > 0) return { side: 'RIGHT', first: Math.min(...added), last: Math.max(...added) };
  const removed = changed.map((l) => l.oldLine!);
  if (removed.length > 0) return { side: 'LEFT', first: Math.min(...removed), last: Math.max(...removed) };
  return { side: 'RIGHT', first: fallback, last: fallback };
}

function build(id: string, hunk: string, hunkHash: string | null, lines: HunkLine[], fallback: number): Block {
  const hash = hashOf(lines);
  const changed = lines.filter(isChanged);
  const block: Block = {
    id,
    hunk,
    hunkHash: hunkHash ?? hash,
    hash,
    anchors: lines.map(anchorOf).filter((a): a is Anchor => a !== null),
    changed: changed.map((l) => anchorOf(l)!),
    span: spanOf(changed, fallback),
  };
  sourceLines.set(block, lines);
  return block;
}

export function blocksOf(hunks: Hunk[]): Block[] {
  return hunks.map((hunk, i) =>
    build(
      `B${i + 1}`,
      `B${i + 1}`,
      null,
      hunk.lines.filter((l) => l.kind !== 'meta'),
      hunk.newStart,
    ),
  );
}

export function fileDiffHash(hunks: Hunk[]): string | null {
  if (hunks.length === 0) return null;
  return hashOf(hunks.flatMap((h) => h.lines));
}

// A person can comment on an unchanged line from either column, so a context line is listed
// on both sides: with its new number on the right and its old number on the left.
export function linesOf(block: Block): Ranges {
  const lines = sourceLines.get(block) ?? [];
  const right: number[] = [];
  const left: number[] = [];
  for (const line of lines) {
    if (line.kind !== 'del') right.push(line.newLine!);
    if (line.kind !== 'add') left.push(line.oldLine!);
  }
  return { RIGHT: toRanges(right), LEFT: toRanges(left) };
}

export function parseAnchor(text: string): Anchor | null {
  const match = /^([RL])([1-9]\d*)$/.exec(text.trim());
  if (match === null) return null;
  return { side: match[1] === 'R' ? 'RIGHT' : 'LEFT', line: Number(match[2]) };
}

export function splitBlock(
  block: Block,
  parts: { first: Anchor; last: Anchor }[],
): { parts: (Block | null)[]; rest: Block | null } {
  const lines = sourceLines.get(block);
  if (lines === undefined) throw new Error(`block ${block.id} was not built by blocksOf`);
  const anchored = lines.filter((l) => anchorOf(l) !== null);
  const indexOf = (a: Anchor): number =>
    block.anchors.findIndex((b) => b.side === a.side && b.line === a.line);

  const taken = new Set<number>();
  const kept: (Block | null)[] = [];
  for (const [position, part] of parts.entries()) {
    const from = indexOf(part.first);
    const to = indexOf(part.last);
    let ok = from !== -1 && to !== -1 && from <= to;
    const slice = ok ? anchored.slice(from, to + 1) : [];
    if (ok && !slice.some(isChanged)) ok = false;
    if (ok) {
      for (let i = from; i <= to; i++) if (taken.has(i)) ok = false;
    }
    if (!ok) {
      kept.push(null);
      continue;
    }
    for (let i = from; i <= to; i++) taken.add(i);
    kept.push(build(`${block.id}.${position + 1}`, block.hunk, block.hunkHash, slice, block.span.first));
  }

  const left = anchored.filter((l, i) => isChanged(l) && !taken.has(i));
  const rest = left.length === 0 ? null : build(`${block.id}.rest`, block.hunk, block.hunkHash, left, block.span.first);
  return { parts: kept, rest };
}

const placeOf = (hunk: Block, a: Anchor | undefined): number =>
  a === undefined ? -1 : hunk.changed.findIndex((c) => c.side === a.side && c.line === a.line);

/** The places of a part's first and last changed line among its hunk's changed lines. */
export function rangeOf(hunk: Block, part: Block): [number, number] {
  return [placeOf(hunk, part.changed[0]), placeOf(hunk, part.changed[part.changed.length - 1])];
}

/** The parts of a hunk at these ranges, as splitBlock cuts them; null when a range is outside the hunk or the parts leave a remainder. */
export function partsAt(hunk: Block, ranges: Array<[number, number]>): Block[] | null {
  let next = 0; // the first place no range has taken yet
  for (const range of ranges) {
    if (!Array.isArray(range) || range.length !== 2) return null;
    const [first, last] = range;
    if (!Number.isInteger(first) || !Number.isInteger(last) || first !== next || last < first || last >= hunk.changed.length) return null;
    next = last + 1;
  }
  if (ranges.length === 0 || next !== hunk.changed.length) return null;
  const cut = splitBlock(hunk, ranges.map(([first, last]) => ({ first: hunk.changed[first]!, last: hunk.changed[last]! })));
  if (cut.rest !== null || cut.parts.some((p) => p === null)) return null;
  return cut.parts as Block[];
}
