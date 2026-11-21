import { linesOf } from '../score/blocks.ts';
import type { Block } from '../score/types.ts';
import type { Side } from '../types.ts';
import { parsePatch, patchFromContents, toRanges } from './diff.ts';
import type { Range } from './diff.ts';

/** What of a file changed since a published review last read it: everything, or these new-side lines and the removed lines of these hunks. */
export interface Changed { all: boolean; right: Range[]; leftBlocks: string[] }

const inside = (ranges: Range[], line: number): boolean => ranges.some(([start, end]) => line >= start && line <= end);

/** The new-side lines of `now` that `before` does not have, as ranges; null when the two cannot be compared. */
export function changedLines(before: string, now: string): Range[] | null {
  const patch = patchFromContents(before, now);
  if (patch === null) return null;
  return toRanges(parsePatch(patch).flatMap((h) => h.lines.filter((l) => l.kind === 'add').map((l) => l.newLine!)));
}

/** The ids of the hunks that have a removed line and whose hash is not in `hashes`: a hunk that only adds lines has its new lines in `right`. */
export function leftBlocksOf(blocks: Block[], hashes: ReadonlySet<string>): string[] {
  return blocks.filter((b) => b.changed.some((a) => a.side === 'LEFT') && !hashes.has(b.hash)).map((b) => b.id);
}

/** Whether a placed finding sits on a line that changed. `blocks` are the file's hunks. */
export function isChanged(changed: Changed, blocks: Block[], side: Side, line: number): boolean {
  if (changed.all) return true;
  if (side === 'RIGHT') return inside(changed.right, line);
  return blocks.some((b) => changed.leftBlocks.includes(b.id) && inside(linesOf(b).LEFT, line));
}

/** The value of the header line: `all`, `none`, or such as `R4, R11-R12; removed lines of B2`. */
export function changedText(changed: Changed): string {
  if (changed.all) return 'all';
  const parts: string[] = [];
  if (changed.right.length > 0) parts.push(changed.right.map(([start, end]) => (start === end ? `R${start}` : `R${start}-R${end}`)).join(', '));
  if (changed.leftBlocks.length > 0) parts.push(`removed lines of ${changed.leftBlocks.join(', ')}`);
  return parts.length === 0 ? 'none' : parts.join('; ');
}
