import type { StoredRun } from '../db/review-runs.ts';
import { shownOf } from '../engine/score/shown.ts';
import { CATEGORIES } from '../engine/score/types.ts';
import type { Category, FileHistory, ScoredBy, ScoreEntry, ScoreHistory, StoredEntry, StoredSplit } from '../engine/score/types.ts';

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isScore = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100;
/** The names of the categories, for checking a stored one. */
export const CATEGORY_NAMES: readonly unknown[] = CATEGORIES;

/** An entry of a stored result, or null when it is not one. An absent reason reads as ''. */
function entryOf(value: unknown): ScoreEntry | null {
  if (!isObject(value) || !isScore(value['score']) || !CATEGORY_NAMES.includes(value['category'])) return null;
  return { score: value['score'], category: value['category'] as Category, reason: typeof value['reason'] === 'string' ? value['reason'] : '' };
}

interface ReadBlock {
  hash: string; hunkHash: string;
  entry: ScoreEntry | null;           // null: none, or one that could not be read
  unreadable: boolean;                // it had an entry that is not one
  raisedFrom: number | null;
  raisedUnreadable: boolean;          // it had a `raisedFrom` that is not a score
  range: [number, number] | null;
  by: ScoredBy | null;                // null: a `by` that is neither
  origin: unknown;
}
interface ReadFile { path: string; diffHash: string | null; covered: boolean; wholeFile: ScoreEntry | null; blocks: ReadBlock[] }

function rangeOf(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [first, last] = value as unknown[];
  if (typeof first !== 'number' || typeof last !== 'number' || !Number.isInteger(first) || !Number.isInteger(last) || first < 0 || last < first) return null;
  return [first, last];
}

function blockOf(value: unknown): ReadBlock | null {
  if (!isObject(value) || typeof value['hash'] !== 'string') return null;
  const hash = value['hash'];
  const raw = value['entry'];
  const entry = entryOf(raw);
  const by = value['by'];
  return {
    hash, hunkHash: typeof value['hunkHash'] === 'string' ? value['hunkHash'] : hash,
    entry, unreadable: entry === null && raw !== null && raw !== undefined,
    raisedFrom: isScore(value['raisedFrom']) ? value['raisedFrom'] : null,
    raisedUnreadable: value['raisedFrom'] !== undefined && value['raisedFrom'] !== null && !isScore(value['raisedFrom']),
    range: rangeOf(value['range']),
    by: by === undefined || by === 'model' ? 'model' : by === 'scorer' ? 'scorer' : null,
    origin: value['origin'],
  };
}

/** The files of a stored result; a file or a block that is not of the expected shape is skipped. */
function filesOf(result: unknown): ReadFile[] {
  const files: ReadFile[] = [];
  for (const f of asArray(isObject(result) ? result['scores'] : undefined)) {
    if (!isObject(f) || typeof f['path'] !== 'string') continue;
    files.push({
      path: f['path'],
      diffHash: typeof f['diffHash'] === 'string' ? f['diffHash'] : null,
      covered: f['covered'] === true,
      wholeFile: entryOf(f['wholeFile']),
      blocks: asArray(f['blocks']).flatMap((b) => { const read = blockOf(b); return read === null ? [] : [read]; }),
    });
  }
  return files;
}

function reviewedOf(result: unknown): Set<string> {
  const coverage = isObject(result) ? result['coverage'] : undefined;
  return new Set(asArray(isObject(coverage) ? coverage['reviewed'] : undefined).filter((p): p is string => typeof p === 'string'));
}

interface Kept { entry: ScoreEntry; raisedFrom: number | null; run: number }
interface Acc {
  blocks: Map<string, Kept>;
  partsOf: Map<string, Set<string>>;  // hunk hash -> hashes of its parts that had an entry given by `by`
  splits: Map<string, StoredSplit>;
  stood: Set<string>;
  wholeFile: ScoreEntry | null;
  coveredAt: Set<string>;
  readAt: { head: string; hashes: string[] } | null;
}

/** What the engine is told about the scores of a pull request's earlier runs. `by` is the scorer in force. */
export function historyOf(args: { runs: StoredRun[]; last: StoredRun | null; by: ScoredBy }): ScoreHistory {
  const { by } = args;
  const earlier = args.runs.filter((r) => !r.dryRun && r.outcome === 'ok').sort((a, b) => a.id - b.id);
  const accs = new Map<string, Acc>();
  for (const run of earlier) {
    const reviewed = reviewedOf(run.result);
    for (const file of filesOf(run.result)) {
      let acc = accs.get(file.path);
      if (acc === undefined) {
        acc = { blocks: new Map(), partsOf: new Map(), splits: new Map(), stood: new Set(), wholeFile: null, coveredAt: new Set(), readAt: null };
        accs.set(file.path, acc);
      }
      const hunks = new Map<string, ReadBlock[]>();
      for (const b of file.blocks) {
        hunks.set(b.hunkHash, [...(hunks.get(b.hunkHash) ?? []), b]);
        if (b.entry === null || b.by !== by) continue;
        const kept = acc.blocks.get(b.hash);
        // On a tie an entry that was not raised wins over one that was; then the newer run.
        const tie = kept !== undefined && b.entry.score === kept.entry.score
          && ((kept.raisedFrom !== null && b.raisedFrom === null) || ((kept.raisedFrom === null) === (b.raisedFrom === null) && run.id > kept.run));
        if (kept === undefined || b.entry.score > kept.entry.score || tie) {
          acc.blocks.set(b.hash, { entry: b.entry, raisedFrom: b.raisedFrom, run: run.id });
        }
        if (b.hunkHash !== b.hash) acc.partsOf.set(b.hunkHash, (acc.partsOf.get(b.hunkHash) ?? new Set()).add(b.hash));
      }
      for (const [hunkHash, blocks] of hunks) {
        if (blocks.every((b) => b.range !== null && b.entry !== null && b.by === by)) {
          // In line order, as the parts are fitted to the hunk: the model may have listed them in another.
          acc.splits.set(hunkHash, { hunkHash, parts: blocks.map((b) => ({ hash: b.hash, range: b.range! })).sort((x, y) => x.range[0] - y.range[0]) });
        }
      }
      if (by === 'model' && file.covered && file.wholeFile !== null) {
        for (const b of file.blocks) if (b.entry === null && !b.unreadable) acc.stood.add(b.hash);
      }
      if (file.wholeFile !== null && (acc.wholeFile === null || file.wholeFile.score >= acc.wholeFile.score)) acc.wholeFile = file.wholeFile;
      if (run.published && reviewed.has(file.path)) {
        if (file.diffHash !== null) acc.coveredAt.add(file.diffHash);
        acc.readAt = { head: run.headSha, hashes: [...new Set(file.blocks.flatMap((b) => [b.hash, b.hunkHash]))] };
      }
    }
  }
  const files: FileHistory[] = [];
  for (const [path, acc] of accs) {
    // A hunk does not stand below its own parts; repeated until nothing is raised, so the order hunks are met in does not matter.
    for (let raised = true; raised;) {
      raised = false;
      for (const [hunkHash, parts] of acc.partsOf) {
        const whole = acc.blocks.get(hunkHash);
        if (whole === undefined) continue;
        let highest: Kept | undefined;
        for (const p of parts) {
          const kept = acc.blocks.get(p);
          if (kept !== undefined && (highest === undefined || kept.entry.score > highest.entry.score)) highest = kept;
        }
        if (highest !== undefined && whole.entry.score < highest.entry.score) {
          acc.blocks.set(hunkHash, { entry: highest.entry, raisedFrom: null, run: highest.run });
          raised = true;
        }
      }
    }
    const blocks: StoredEntry[] = [...acc.blocks].map(([hash, k]) => ({ hash, entry: { ...k.entry }, raisedFrom: k.raisedFrom }));
    files.push({
      path, blocks, splits: [...acc.splits.values()],
      stoodFor: [...acc.stood].filter((h) => !acc.blocks.has(h)),
      wholeFile: acc.wholeFile === null ? null : { ...acc.wholeFile },
      coveredAt: [...acc.coveredAt], readAt: acc.readAt,
    });
  }
  const shownRun = earlier.filter((r) => r.published).at(-1);
  const last = args.last;
  return {
    by,
    lastReview: last === null ? null : {
      head: last.headSha,
      overview: isObject(last.result) && typeof last.result['overview'] === 'string' ? last.result['overview'] : '',
    },
    shown: shownRun === undefined ? null : shownOf(shownRun.result),
    files,
  };
}

/** The newest published run that is not a re-check; null when there is none. */
export function lastReviewOf(runs: StoredRun[]): StoredRun | null {
  let newest: StoredRun | null = null;
  for (const r of runs) if (r.published && r.mode !== 'recheck' && (newest === null || r.id > newest.id)) newest = r;
  return newest;
}

/** The scores a run gave, for other pull requests to reuse. */
export function scoresToStore(result: unknown): Array<{ path: string; hash: string; score: number; category: string; reason: string }> {
  const out: Array<{ path: string; hash: string; score: number; category: string; reason: string }> = [];
  for (const file of filesOf(result)) {
    for (const b of file.blocks) {
      // A block whose given score cannot be read is not stored: the raised one must not be passed on as given.
      if (b.entry === null || b.raisedUnreadable || (b.origin !== undefined && b.origin !== null)) continue;
      out.push({ path: file.path, hash: b.hash, score: b.raisedFrom ?? b.entry.score, category: b.entry.category, reason: b.entry.reason });
    }
  }
  return out;
}
