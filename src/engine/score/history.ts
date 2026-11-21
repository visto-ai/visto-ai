import type { FileContext } from '../context/build.ts';
import { fileDiffHash, partsAt } from './blocks.ts';
import type { Block, FileHistory, ScoreEntry, ScoreHistory, StoredEntry, StoredSplit } from './types.ts';

export interface KeptEntry { entry: ScoreEntry; origin: 'earlier_run' | 'other_pull_request'; raisedFrom: number | null; range: [number, number] | null }
export interface KeptScores {
  blocks: Block[];                  // the file's blocks, with a split hunk replaced by its kept parts
  entries: Map<string, KeptEntry>;  // by block id
  stoodFor: Set<string>;            // ids of blocks with no entry that the kept whole-file score stands for
  wholeFile: ScoreEntry | null;     // the whole-file score the file keeps
  floor: number;                    // the highest stored score whose hash no present block has; 0 when none
  settled: boolean;                 // every block has a kept entry or is stood for, and a published run read the file under this path with the diff it has now (a moved file: it keeps a whole-file score)
  covered: boolean;                 // the same as settled
  scoredHunks: Set<string>;         // ids of hunks whose header says `scored`
  readAt: { head: string; hashes: Set<string> } | null;
}

// A file's history under its path and its earlier name, joined.
interface Joined {
  entries: Map<string, StoredEntry>;  // by hash: the higher of the two
  splits: StoredSplit[];              // the path's own first
  stoodFor: Set<string>;
  wholeFile: ScoreEntry | null;
  coveredAt: Set<string>;            // the path's own only
  readAt: FileHistory['readAt'];
}

const list = <T>(value: T[] | undefined | null): T[] => (Array.isArray(value) ? value : []);
const higher = (a: ScoreEntry | null, b: ScoreEntry | null): ScoreEntry | null => (b !== null && (a === null || b.score > a.score) ? b : a);

// Null when neither name has a history. A stored result may be old: an absent field reads as empty.
function joined(context: FileContext, history: ScoreHistory | null): Joined | null {
  if (history === null) return null;
  const files = list(history.files);
  const names = [context.file.path, ...(context.file.previousPath === null ? [] : [context.file.previousPath])];
  let found = names.map((name) => files.find((f) => f.path === name)).filter((f): f is FileHistory => f !== undefined);
  const own = files.some((f) => f.path === context.file.path);
  if (!own && context.file.status === 'added' && context.file.previousPath === null && context.plan.kind === 'model') {
    // A file the pull request added and a later push renamed or copied is shown as added: it answers to every other path that held one of its blocks.
    const hashes = new Set(context.blocks.map((b) => b.hash));
    found = files.filter((f) => list(f.blocks).some((s) => hashes.has(s.hash))
      || list(f.stoodFor).some((h) => hashes.has(h)) || list(f.splits).some((s) => hashes.has(s.hunkHash)));
  }
  if (found.length === 0) return null;
  const out: Joined = { entries: new Map(), splits: [], stoodFor: new Set(), wholeFile: null, coveredAt: new Set(), readAt: null };
  for (const file of found) {
    for (const stored of list(file.blocks)) {
      const known = out.entries.get(stored.hash);
      if (known === undefined || stored.entry.score > known.entry.score) out.entries.set(stored.hash, stored);
    }
    out.splits.push(...list(file.splits));
    for (const hash of list(file.stoodFor)) out.stoodFor.add(hash);
    out.wholeFile = higher(out.wholeFile, file.wholeFile ?? null);
    // A file is covered only where it now stands.
    if (file.path === context.file.path) for (const hash of list(file.coveredAt)) out.coveredAt.add(hash);
    if (out.readAt === null && file.readAt) out.readAt = file.readAt;
  }
  return out;
}

const readAtOf = (j: Joined | null): KeptScores['readAt'] =>
  j?.readAt ? { head: j.readAt.head, hashes: new Set(list(j.readAt.hashes)) } : null;

// The highest stored score whose hash no present block has.
function floorOf(j: Joined | null, present: ReadonlySet<string>): number {
  let floor = 0;
  for (const [hash, stored] of j?.entries ?? []) {
    if (!present.has(hash)) floor = Math.max(floor, stored.entry.score);
  }
  return floor;
}

/** Works out, for one file, what its history already settles. `reused` are the scores other pull requests stored for its blocks. */
export function keptScores(context: FileContext, history: ScoreHistory | null, reused: Array<{ hash: string; entry: ScoreEntry }>): KeptScores | null {
  const kind = context.plan.kind;
  if (kind === 'rule' || kind === 'none') return null;
  const j = joined(context, history);
  if (j === null && reused.length === 0) return null;

  if (kind === 'model_whole') {
    // A moved file has no block and no diff: it keeps its whole-file score, the review model's even with a scorer.
    const wholeFile = j?.wholeFile ?? null;
    return {
      blocks: [], entries: new Map(), stoodFor: new Set(), wholeFile, floor: floorOf(j, new Set()),
      settled: wholeFile !== null, covered: wholeFile !== null, scoredHunks: new Set(), readAt: readAtOf(j),
    };
  }

  // With the scorer in force, the whole-file score and what it stood for are the review model's.
  const byScorer = history?.by === 'scorer';
  const wholeFile = byScorer ? null : (j?.wholeFile ?? null);
  const stoodForHashes = byScorer || wholeFile === null ? new Set<string>() : (j?.stoodFor ?? new Set<string>());

  const blocks: Block[] = [];
  const entries = new Map<string, KeptEntry>();
  const stoodFor = new Set<string>();
  const scoredHunks = new Set<string>();
  const present = new Set<string>();
  const open: Block[] = []; // blocks the history does not settle, in diff order
  for (const block of context.blocks) {
    present.add(block.hash);
    const stored = j?.entries.get(block.hash);
    if (stored !== undefined) {
      blocks.push(block);
      entries.set(block.id, { entry: stored.entry, origin: 'earlier_run', raisedFrom: stored.raisedFrom ?? null, range: null });
      scoredHunks.add(block.hunk);
      continue;
    }
    const split = j?.splits.find((s) => s.hunkHash === block.hash);
    if (split !== undefined) {
      const stParts = list(split.parts);
      const parts = partsAt(block, stParts.map((p) => p.range));
      const fits = parts !== null && parts.every((p, i) => p.hash === stParts[i]!.hash && j!.entries.has(p.hash));
      if (fits) {
        parts.forEach((part, i) => {
          const one = j!.entries.get(part.hash)!;
          blocks.push(part);
          present.add(part.hash);
          entries.set(part.id, { entry: one.entry, origin: 'earlier_run', raisedFrom: one.raisedFrom ?? null, range: stParts[i]!.range });
        });
        scoredHunks.add(block.hunk);
      } else {
        blocks.push(block); // the hunk is not kept
      }
      continue;
    }
    blocks.push(block);
    if (stoodForHashes.has(block.hash)) {
      stoodFor.add(block.id);
      scoredHunks.add(block.hunk);
      continue;
    }
    open.push(block);
  }

  // A block found on another pull request is new to this one, and the floor holds for it.
  const floor = floorOf(j, present);
  for (const block of open) {
    let best: ScoreEntry | null = null;
    for (const r of reused) if (r.hash === block.hash) best = higher(best, r.entry);
    if (best === null) continue;
    // The reason was written about another pull request: it is not taken with the score.
    const taken: ScoreEntry = { ...best, reason: '' };
    entries.set(block.id, taken.score < floor
      ? { entry: { ...taken, score: floor }, origin: 'other_pull_request', raisedFrom: taken.score, range: null }
      : { entry: taken, origin: 'other_pull_request', raisedFrom: null, range: null });
    scoredHunks.add(block.hunk);
  }

  // Nothing is left to ask only of a file a published review of this pull request read under this path, with this diff.
  const diffHash = fileDiffHash(context.hunks);
  const settled = blocks.every((b) => entries.has(b.id) || stoodFor.has(b.id)) && diffHash !== null && (j?.coveredAt.has(diffHash) ?? false);
  return { blocks, entries, stoodFor, wholeFile, floor, settled, covered: settled, scoredHunks, readAt: readAtOf(j) };
}

/** The blocks of these files that the history does not settle, for the lookup across pull requests. */
export function blocksToLookUp(contexts: FileContext[], history: ScoreHistory | null): Array<{ path: string; hash: string }> {
  const out: Array<{ path: string; hash: string }> = [];
  const seen = new Set<string>();
  for (const context of contexts) {
    if (context.plan.kind !== 'model') continue;
    const kept = keptScores(context, history, []);
    const open = kept === null ? context.blocks : kept.blocks.filter((b) => !kept.scoredHunks.has(b.hunk));
    for (const block of open) {
      const key = `${context.file.path}\n${block.hash}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ path: context.file.path, hash: block.hash });
    }
  }
  return out;
}
