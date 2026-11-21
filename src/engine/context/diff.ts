import { structuredPatch } from 'diff';

export interface HunkLine {
  kind: 'add' | 'del' | 'ctx' | 'meta';
  text: string;
  oldLine: number | null;
  newLine: number | null;
}
export interface Hunk {
  header: string;
  oldStart: number;
  newStart: number;
  newLength: number;
  lines: HunkLine[];
}
export type Range = [start: number, end: number];
export interface Ranges { RIGHT: Range[]; LEFT: Range[] }

export const ANCHOR_LEGEND =
  'Each diff line starts with an anchor: R<n> means side RIGHT, line n of the new file; L<n> means side LEFT, line n of the old file. ' +
  'A line with no anchor cannot take a comment.';

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
const ANCHOR_WIDTH = 8;

export function parsePatch(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  for (const raw of patch.split('\n')) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      current = {
        header: raw,
        oldStart: oldLine,
        newStart: newLine,
        newLength: header[3] === undefined ? 1 : Number(header[3]),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (current === null || raw === '') continue; // before the first hunk, or a zero-length line
    const marker = raw.charAt(0);
    const text = raw.slice(1);
    if (marker === '+') {
      current.lines.push({ kind: 'add', text, oldLine: null, newLine });
      newLine += 1;
    } else if (marker === '-') {
      current.lines.push({ kind: 'del', text, oldLine, newLine: null });
      oldLine += 1;
    } else if (marker === ' ') {
      current.lines.push({ kind: 'ctx', text, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    } else {
      current.lines.push({ kind: 'meta', text: raw, oldLine: null, newLine: null });
    }
  }
  return hunks;
}

function anchor(prefix: 'R' | 'L', n: number): string {
  return `${prefix}${n}`.padEnd(ANCHOR_WIDTH);
}

/** The anchored diff; a hunk whose id is in `scored` already has its score, and its header says so. */
export function renderAnchoredDiff(hunks: Hunk[], scored?: ReadonlySet<string>): string {
  const out: string[] = [];
  for (const [i, hunk] of hunks.entries()) {
    const changed = hunk.lines.filter((l) => l.kind === 'add' || l.kind === 'del').length;
    const state = scored?.has(`B${i + 1}`) === true ? 'scored' : 'not scored';
    out.push(`### Block B${i + 1} (${changed} changed ${changed === 1 ? 'line' : 'lines'}, ${state})`);
    out.push(hunk.header);
    for (const line of hunk.lines) {
      if (line.kind === 'meta') out.push(line.text);
      else if (line.kind === 'add') out.push(`${anchor('R', line.newLine!)}|+${line.text}`);
      else if (line.kind === 'ctx') out.push(`${anchor('R', line.newLine!)}| ${line.text}`);
      else out.push(`${anchor('L', line.oldLine!)}|-${line.text}`);
    }
  }
  return out.join('\n');
}

export function toRanges(numbers: number[]): Range[] {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const ranges: Range[] = [];
  for (const n of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else ranges.push([n, n]);
  }
  return ranges;
}

export function commentableRanges(hunks: Hunk[]): Ranges {
  const right: number[] = [];
  const left: number[] = [];
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'add' || line.kind === 'ctx') right.push(line.newLine!);
      else if (line.kind === 'del') left.push(line.oldLine!);
    }
  }
  return { RIGHT: toRanges(right), LEFT: toRanges(left) };
}

// Beyond this many edits the diff library gives up: two large, fully different
// contents would otherwise block the process for a long time.
const MAX_EDIT_LENGTH = 8000;

/** The unified hunks between two contents, or null when the diff gives up at MAX_EDIT_LENGTH. */
export function patchFromContents(oldText: string, newText: string): string | null {
  const patch = structuredPatch('a', 'b', oldText, newText, undefined, undefined, { context: 3, maxEditLength: MAX_EDIT_LENGTH });
  if (patch === undefined) return null;
  return patch.hunks
    .map((h) => [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines].join('\n'))
    .join('\n');
}
