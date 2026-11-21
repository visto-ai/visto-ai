import type { FileContext } from '../context/build.ts';
import type { RawBlock, RawFile, RawPart, SubmitReviewArgs } from '../model/submit-review.ts';
import { inlineText } from '../context/untrusted.ts';
import { SPLIT_ABOVE, fileDiffHash, linesOf, parseAnchor, rangeOf, splitBlock } from '../score/blocks.ts';
import { floorFor } from '../score/floors.ts';
import type { TeamFloors } from '../score/floors.ts';
import { CATEGORIES } from '../score/types.ts';
import type { KeptEntry } from '../score/history.ts';
import type { Anchor, Block, BlockScore, Category, FileLevelSource, FileScore, ScoredBy, ScoreEntry, Verdict } from '../score/types.ts';
import type { AuditEntry } from '../types.ts';
import { normalizePath } from './placement.ts';

const REASON_REQUIRED_FROM = 40;

// The order that settles a tie between candidates for the file's level.
const SOURCE_ORDER: FileLevelSource[] = [
  'builtin_floor', 'team_floor', 'team_file_invalid', 'hidden_characters', 'not_scored', 'whole_file', 'rule_rename', 'rule_asset',
];

const isScore = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100;

const isCategory = (value: string | undefined): value is Category => (CATEGORIES as readonly string[]).includes(value ?? '');

type Raw = { score?: number; category?: string; reason?: string };

// Checks one score the model gave. Nothing it says is kept until it passes here.
function entryOf(raw: Raw, subject: string, audit: AuditEntry[]): ScoreEntry | null {
  if (!isScore(raw.score)) {
    audit.push({ stage: 'reconcile', action: 'score_invalid', subject, reason: 'not_a_whole_number_from_0_to_100' });
    return null;
  }
  const reason = inlineText(raw.reason ?? '').trim();
  if (raw.score >= REASON_REQUIRED_FROM && reason === '') {
    audit.push({ stage: 'reconcile', action: 'reason_missing', subject, reason: String(raw.score) });
  }
  return { score: raw.score, category: isCategory(raw.category) ? raw.category : 'other', reason };
}

const blockScore = (block: Block, entry: ScoreEntry | null): BlockScore => ({
  id: block.id,
  hunk: block.hunk,
  hunkHash: block.hunkHash,
  hash: block.hash,
  changedLines: block.changed.length,
  span: block.span,
  lines: linesOf(block),
  entry,
});

interface ValidPart { first: Anchor; last: Anchor; entry: ScoreEntry }

function validParts(parts: RawPart[], subject: string, audit: AuditEntry[]): ValidPart[] {
  const valid: ValidPart[] = [];
  for (const part of parts) {
    const first = parseAnchor(part.first);
    const last = parseAnchor(part.last);
    if (first === null || last === null || !isScore(part.score)) {
      audit.push({ stage: 'reconcile', action: 'part_invalid', subject, reason: 'anchors_or_score' });
      continue;
    }
    const entry = entryOf(part, subject, audit);
    if (entry !== null) valid.push({ first, last, entry });
  }
  return valid;
}

// A block's score, and whether an item named it without giving it a usable one. A voided block
// counts as 100 even when the file has a whole-file score: that score stands only for blocks no item named.
interface Scored { score: BlockScore; voided: boolean }

// What one item says about its block: nothing, a rejected score, or the blocks that replace it
// (itself with an entry, or its parts and rest) with the highest score among them.
type Outcome = { kind: 'nothing' } | { kind: 'void' } | { kind: 'scored'; blocks: Scored[]; top: number };

const scoredWith = (blocks: Scored[]): Outcome =>
  ({ kind: 'scored', blocks, top: Math.max(...blocks.map((b) => b.score.entry?.score ?? 0)) });

function outcomeOf(path: string, block: Block, item: RawBlock, audit: AuditEntry[]): Outcome {
  const subject = `${path} ${block.id}`;
  if (item.score !== undefined && item.parts !== undefined) {
    // Two answers for one block: neither can be trusted over the other.
    audit.push({ stage: 'reconcile', action: 'score_and_parts', subject, reason: 'voided' });
    return { kind: 'void' };
  }
  if (item.score !== undefined) {
    const entry = entryOf(item, subject, audit);
    return entry === null ? { kind: 'void' } : scoredWith([{ score: blockScore(block, entry), voided: false }]);
  }
  if (item.parts === undefined) return { kind: 'nothing' };

  const parts = validParts(item.parts, subject, audit);
  if (parts.length === 0) return { kind: 'void' };

  const split = splitBlock(block, parts.map((p) => ({ first: p.first, last: p.last })));
  let dropped = parts.length < item.parts.length;
  for (const made of split.parts) {
    if (made === null) {
      dropped = true;
      audit.push({ stage: 'reconcile', action: 'part_invalid', subject, reason: 'lines_overlap_or_unchanged' });
    }
  }

  if (block.changed.length <= SPLIT_ABOVE) {
    // Not split, so the parts only vouch for the block when they cover all of it.
    audit.push({ stage: 'reconcile', action: 'split_ignored', subject, reason: 'block_has_30_changed_lines_or_fewer' });
  }
  // A dropped part may have been the one that scored the block higher, so no part stands.
  if (dropped) return { kind: 'void' };

  if (block.changed.length <= SPLIT_ABOVE) {
    if (split.rest !== null) return { kind: 'void' };
    let best = parts[0]!;
    for (const part of parts) if (part.entry.score > best.entry.score) best = part;
    return scoredWith([{ score: blockScore(block, best.entry), voided: false }]);
  }

  const out: Scored[] = split.parts.map((made, i) => ({ score: { ...blockScore(made!, parts[i]!.entry), range: rangeOf(block, made!) }, voided: false }));
  if (split.rest !== null) out.push({ score: blockScore(split.rest, null), voided: true });
  return scoredWith(out);
}

const isPlainScore = (item: RawBlock): boolean => item.score !== undefined && item.parts === undefined;

// Every item that named `block`. Several items stand only when each is a plain valid score: then the
// highest stands, the first on a tie. Any other mix voids the block, since it cannot be read as one answer.
function blocksFor(path: string, block: Block, items: RawBlock[], audit: AuditEntry[]): Scored[] {
  const voided = [{ score: blockScore(block, null), voided: true }];
  const outcomes = items.map((item) => outcomeOf(path, block, item, audit));
  if (outcomes.some((o) => o.kind === 'void')) return voided;
  if (items.length > 1 && !items.every(isPlainScore)) return voided;
  let best: Outcome & { kind: 'scored' } | null = null;
  for (const o of outcomes) if (o.kind === 'scored' && (best === null || o.top > best.top)) best = o;
  return best === null ? [{ score: blockScore(block, null), voided: false }] : best.blocks;
}

export function reconcileScores(
  answers: { value: SubmitReviewArgs; files: string[] }[],
  contexts: FileContext[],
  notRead: ReadonlySet<string>,
  floors: TeamFloors,
  by: ScoredBy = 'model',
): { scores: FileScore[]; audit: AuditEntry[] } {
  const audit: AuditEntry[] = [];
  const known: ReadonlySet<string> = new Set(contexts.map((c) => c.file.path));

  // Every entry for a file, from an answer whose batch held it, counts; they are pooled in order.
  const counted = new Map<string, RawFile[]>();
  for (const answer of answers) {
    const batch: ReadonlySet<string> = new Set(answer.files);
    for (const raw of answer.value.files) {
      const path = normalizePath(raw.path, known);
      if (path === null) {
        audit.push({ stage: 'reconcile', action: 'score_path_not_in_pull_request', subject: raw.path, reason: 'dropped' });
      } else if (!batch.has(path)) {
        audit.push({ stage: 'reconcile', action: 'score_path_not_in_batch', subject: path, reason: 'dropped' });
      } else if (counted.has(path)) {
        audit.push({ stage: 'reconcile', action: 'score_duplicate', subject: path, reason: 'pooled' });
        counted.get(path)!.push(raw);
      } else {
        counted.set(path, [raw]);
      }
    }
  }

  const scores = contexts.map((context) => scoreFile(context, counted.get(context.file.path) ?? [], notRead, floors, by, audit));
  return { scores, audit };
}

// The highest valid whole-file score among the entries; none, and `invalid`, when any of them gave one that is not valid.
function wholeFileOf(entries: RawFile[], path: string, audit: AuditEntry[]): { entry: ScoreEntry | null; invalid: boolean } {
  let best: ScoreEntry | null = null;
  let invalid = false;
  for (const entry of entries) {
    if (entry.score === undefined) continue;
    const checked = entryOf(entry, path, audit);
    if (checked === null) invalid = true;
    else if (best === null || checked.score > best.score) best = checked;
  }
  return { entry: invalid ? null : best, invalid };
}

// Models often fill an optional list with an empty array; an empty `parts` says nothing.
function withoutEmptyParts(item: RawBlock): RawBlock {
  if (item.parts === undefined || item.parts.length > 0) return item;
  const rest = { ...item };
  delete rest.parts;
  return rest;
}

// A block whose score an earlier run, or another pull request, left it.
const keptScore = (block: Block, kept: KeptEntry, by: ScoredBy): BlockScore => ({
  ...blockScore(block, kept.entry),
  origin: kept.origin,
  ...(kept.raisedFrom === null ? {} : { raisedFrom: kept.raisedFrom }),
  ...(kept.range === null ? {} : { range: kept.range }),
  ...(by === 'scorer' ? { by } : {}),
});

// A score given in this run below the floor is raised to it; the given one is kept beside it.
function atFloor(score: BlockScore, floor: number): BlockScore {
  if (score.entry === null || score.entry.score >= floor) return score;
  return { ...score, entry: { ...score.entry, score: floor }, raisedFrom: score.entry.score };
}

function scoreFile(
  context: FileContext,
  entries: RawFile[],
  notRead: ReadonlySet<string>,
  floors: TeamFloors,
  by: ScoredBy,
  audit: AuditEntry[],
): FileScore {
  const { file, plan, kept } = context;
  const path = file.path;
  const answered = entries.length > 0;
  // A file with nothing left to score: nothing the model sent about its scores is used.
  const settled = kept?.settled === true;
  const lost = kept?.floor ?? 0; // the highest score of a block this file had and lost
  const fileBlocks = kept?.blocks ?? context.blocks;
  // Every block has a kept entry or is stood for: the file can be scored with no answer, settled or not.
  const keepsAll = kept !== undefined && fileBlocks.every((b) => kept.entries.has(b.id) || kept.stoodFor.has(b.id));

  // An unusable whole-file score may have been the model's warning about the file: the file is not scored.
  let given: ScoreEntry | null = null;
  let wholeFileInvalid = false;
  if (settled) {
    // Named once, however many entries gave one.
    if (entries.some((entry) => entry.score !== undefined)) audit.push({ stage: 'reconcile', action: 'whole_file_settled', subject: path, reason: 'ignored' });
  } else {
    ({ entry: given, invalid: wholeFileInvalid } = wholeFileOf(entries, path, audit));
  }
  // The file's whole-file score never falls below the one it keeps; the kept one wins a tie.
  let wholeFile = given;
  const keptWhole = kept?.wholeFile ?? null;
  if (keptWhole !== null && (wholeFile === null || keptWhole.score >= wholeFile.score)) {
    if (wholeFile !== null && keptWhole.score > wholeFile.score) {
      audit.push({ stage: 'reconcile', action: 'whole_file_kept', subject: path, reason: 'kept' });
    }
    wholeFile = keptWhole;
  }

  // An item for a block the file does not have may have been the model's score for lines it does: the file is not scored.
  let strayItem = false;
  const items = new Map<string, RawBlock[]>();
  for (const item of entries.flatMap((e) => e.blocks).map(withoutEmptyParts)) {
    const subject = `${path} ${item.id}`;
    if (kept !== undefined && (kept.entries.has(item.id) || kept.stoodFor.has(item.id) || kept.scoredHunks.has(item.id))) {
      audit.push({ stage: 'reconcile', action: 'block_already_scored', subject, reason: 'ignored' });
    } else if (!fileBlocks.some((b) => b.id === item.id)) {
      if (!settled) strayItem = true;
      audit.push({ stage: 'reconcile', action: 'block_not_in_file', subject, reason: settled ? 'ignored' : 'dropped' });
    } else if (items.has(item.id)) {
      audit.push({ stage: 'reconcile', action: 'block_duplicate', subject, reason: 'pooled' });
      items.get(item.id)!.push(item);
    } else {
      items.set(item.id, [item]);
    }
  }

  // Each block, and whether a whole-file score kept from an earlier run stands for it.
  const scored: Array<Scored & { stoodFor: boolean }> = [];
  for (const block of fileBlocks) {
    const one = kept?.entries.get(block.id);
    if (one !== undefined) {
      scored.push({ score: keptScore(block, one, by), voided: false, stoodFor: false });
    } else if (kept?.stoodFor.has(block.id) === true) {
      scored.push({ score: blockScore(block, null), voided: false, stoodFor: true });
    } else {
      for (const s of blocksFor(path, block, items.get(block.id) ?? [], audit)) {
        let score = atFloor(s.score, lost);
        if (score.entry === null && given !== null && !s.voided && given.score < lost) {
          // A whole-file score in place of a block score cannot go under the floor either.
          score = { ...score, entry: { ...given, score: lost }, raisedFrom: given.score };
        } else if (score.entry !== null && by === 'scorer') {
          score = { ...score, by };
        }
        scored.push({ score, voided: s.voided, stoodFor: false });
      }
    }
  }
  // A block without a score of its own that no whole-file score stands for.
  const unstood = (s: Scored & { stoodFor: boolean }): boolean => s.score.entry === null && !s.stoodFor && (given === null || s.voided);
  if (answered) {
    for (const s of scored) {
      if (unstood(s)) audit.push({ stage: 'reconcile', action: 'block_not_scored', subject: `${path} ${s.score.id}`, reason: 'counts_as_100' });
    }
  }
  const blocks = scored.map((s) => s.score);
  const unscored = scored.some(unstood);

  const notScored =
    plan.kind === 'none' ||
    wholeFileInvalid ||
    strayItem ||
    notRead.has(path) ||
    (plan.kind !== 'rule' && !answered && !keepsAll) ||
    (plan.kind === 'model_whole' && wholeFile === null) ||
    (plan.kind === 'model' && unscored);

  const candidates: { score: number; source: FileLevelSource }[] = [];
  const floor = floorFor(file, floors);
  if (floor !== null) candidates.push({ score: 100, source: floor });
  if (plan.kind === 'rule') candidates.push({ score: plan.score, source: plan.source });
  // The model and any person reading the diff saw the cleaned text, not what was changed.
  if (context.hidden) candidates.push({ score: 100, source: 'hidden_characters' });
  if (notScored) candidates.push({ score: 100, source: 'not_scored' });
  if (wholeFile !== null) candidates.push({ score: wholeFile.score, source: 'whole_file' });
  candidates.sort((a, c) => c.score - a.score || SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(c.source));
  const fileLevel = candidates[0] ?? null;

  const finalScore = Math.max(fileLevel?.score ?? 0, ...blocks.map((b) => b.entry?.score ?? 0));

  let covered: boolean;
  if (context.hidden) covered = false;
  else if (wholeFileInvalid || strayItem) covered = false;
  else if (plan.kind === 'rule') covered = true;
  else if (plan.kind === 'none') covered = false;
  else covered = (answered || kept !== undefined) && !notRead.has(path) && (plan.kind === 'model_whole' ? wholeFile !== null : !unscored);

  return {
    path,
    previousPath: file.previousPath,
    diffHash: fileDiffHash(context.hunks),
    changeSummary: answered ? inlineText(entries[0]!.change_summary) : '',
    changedLines: context.blocks.length === 0 ? file.additions + file.deletions : context.blocks.reduce((n, b) => n + b.changed.length, 0),
    blocks,
    wholeFile,
    fileLevel,
    finalScore,
    covered,
  };
}

export function verdictOf(scores: FileScore[], threshold: number): Verdict {
  const highest = Math.max(0, ...scores.map((s) => s.finalScore));
  return { threshold, needsHuman: highest >= threshold, highest };
}
