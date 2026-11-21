import assert from 'node:assert/strict';
import test from 'node:test';

import type { FileContext } from '../context/build.ts';
import { parsePatch } from '../context/diff.ts';
import type { RawBlock, RawFile, RawPart, SubmitReviewArgs } from '../model/submit-review.ts';
import { parseRepoFile } from '../score/floors.ts';
import type { TeamFloors } from '../score/floors.ts';
import { blocksOf, fileDiffHash, partsAt } from '../score/blocks.ts';
import type { KeptEntry, KeptScores } from '../score/history.ts';
import { scorePlan } from '../score/rules.ts';
import type { FileScore, ScoredBy } from '../score/types.ts';
import type { ChangedFile } from '../types.ts';
import { reconcileScores, verdictOf } from './scores.ts';

const patch = (start: number) =>
  [`@@ -${start},4 +${start},5 @@`, ' keep', '-old one', '+new one', '+new two', ' keep', ' keep'].join('\n');
const twoHunks = `${patch(10)}\n${['@@ -50,3 +51,3 @@', ' keep', '-old', '+new', ' keep'].join('\n')}`;
const fortyAdded = ['@@ -0,0 +1,40 @@', ...Array.from({ length: 40 }, (_, i) => `+line ${i + 1}`)].join('\n');

function ctx(path: string, text: string | null, extra: Partial<ChangedFile> = {}): FileContext {
  const file: ChangedFile = { path, previousPath: null, status: 'modified', additions: 3, deletions: 1, patch: text, ...extra };
  const hunks = text === null ? [] : parsePatch(text);
  const skip = text !== null ? null : file.status === 'renamed' && file.previousPath !== null ? 'unchanged' : 'no_diff';
  return { file, hunks, ranges: null, diffText: null, full: null, test: null, skip, blocks: blocksOf(hunks), plan: scorePlan(file, skip), hidden: false };
}

const b = (id: string, score: number, category = 'fix', reason?: string): RawBlock =>
  reason === undefined ? { id, score, category } : { id, score, category, reason };
const part = (first: string, last: string, score: number, category: string, reason?: string): RawPart =>
  reason === undefined ? { first, last, score, category } : { first, last, score, category, reason };
const file = (path: string, blocks: RawBlock[]): RawFile => ({ path, change_summary: 'Summary.', blocks });

const run = (
  files: RawFile[],
  contexts: FileContext[],
  options: { notRead?: string[]; floors?: TeamFloors; batch?: string[] } = {},
) => {
  const value: SubmitReviewArgs = { overview: 'o', findings: [], files };
  const batch = options.batch ?? contexts.map((c) => c.file.path);
  return reconcileScores([{ value, files: batch }], contexts, new Set(options.notRead ?? []), options.floors ?? parseRepoFile(null));
};

test('every block scored: the file takes the highest', () => {
  const [s] = run([file('src/a.ts', [b('B1', 20, 'rename'), b('B2', 75, 'business_rule', 'Changes who may refund.')])], [ctx('src/a.ts', twoHunks)]).scores;
  assert.equal(s!.finalScore, 75);
  assert.equal(s!.fileLevel, null);
  assert.equal(s!.covered, true);
  assert.deepEqual(s!.blocks.map((x) => x.entry?.score), [20, 75]);
  assert.equal(s!.changedLines, 5);
  assert.equal(s!.changeSummary, 'Summary.');
  assert.match(s!.diffHash!, /^[0-9a-f]{64}$/);
});

test('a skipped block counts as 100 and the file is not covered', () => {
  const out = run([file('src/a.ts', [b('B1', 20, 'rename')])], [ctx('src/a.ts', twoHunks)]);
  assert.deepEqual(out.scores[0]!.fileLevel, { score: 100, source: 'not_scored' });
  assert.equal(out.scores[0]!.finalScore, 100);
  assert.equal(out.scores[0]!.covered, false);
  assert.ok(out.audit.some((a) => a.stage === 'reconcile' && a.action === 'block_not_scored' && a.subject === 'src/a.ts B2'));
});

test('a whole-file score stands for blocks with none', () => {
  const [s] = run([{ ...file('pnpm-lock.yaml', []), score: 72, category: 'dependency', reason: 'Moves a library to a new major version.' }], [ctx('pnpm-lock.yaml', twoHunks)]).scores;
  assert.deepEqual(s!.fileLevel, { score: 72, source: 'whole_file' });
  assert.equal(s!.finalScore, 72);
  assert.equal(s!.covered, true);
  assert.deepEqual(s!.wholeFile, { score: 72, category: 'dependency', reason: 'Moves a library to a new major version.' });
});

test('a whole-file score adds no block_not_scored entries', () => {
  const out = run([{ ...file('src/a.ts', []), score: 30, category: 'refactor' }], [ctx('src/a.ts', twoHunks)]);
  assert.equal(out.audit.filter((a) => a.action === 'block_not_scored').length, 0);
});

test('a block above the whole-file score still counts', () => {
  const [s] = run([{ ...file('src/a.ts', [b('B1', 80, 'business_rule', 'Changes a limit.')]), score: 45, category: 'refactor', reason: 'Reorders the checks.' }], [ctx('src/a.ts', twoHunks)]).scores;
  assert.equal(s!.finalScore, 80);
  assert.deepEqual(s!.fileLevel, { score: 45, source: 'whole_file' });
  assert.equal(s!.covered, true);
});

test('a file the model returned nothing for is 100, not_scored', () => {
  const out = run([], [ctx('src/a.ts', twoHunks)]);
  assert.deepEqual(out.scores[0]!.fileLevel, { score: 100, source: 'not_scored' });
  assert.equal(out.scores[0]!.finalScore, 100);
  assert.equal(out.scores[0]!.covered, false);
  assert.equal(out.scores[0]!.changeSummary, '');
  assert.equal(out.scores[0]!.wholeFile, null);
});

test('a file that was not read is 100 even with an entry', () => {
  const out = run([file('src/a.ts', [b('B1', 10, 'formatting'), b('B2', 10, 'formatting')])], [ctx('src/a.ts', twoHunks)], { notRead: ['src/a.ts'] });
  assert.deepEqual(out.scores[0]!.fileLevel, { score: 100, source: 'not_scored' });
  assert.equal(out.scores[0]!.covered, false);
});

test('bad values cost one block', () => {
  const out = run([file('src/a.ts', [b('B1', 45.5, 'fix', 'x'), b('B2', 101, 'fix', 'x')])], [ctx('src/a.ts', twoHunks)]);
  assert.deepEqual(out.scores[0]!.blocks.map((x) => x.entry), [null, null]);
  assert.equal(out.audit.filter((a) => a.action === 'score_invalid').length, 2);
});

test('negative and non-finite scores are invalid', () => {
  const out = run([file('src/a.ts', [b('B1', -1), b('B2', Number.NaN)])], [ctx('src/a.ts', twoHunks)]);
  assert.deepEqual(out.scores[0]!.blocks.map((x) => x.entry), [null, null]);
  assert.equal(out.audit.filter((a) => a.action === 'score_invalid').length, 2);
});

test('an unknown category is stored as other', () => {
  const out = run([file('src/a.ts', [b('B1', 10, 'nonsense'), b('B2', 10, 'fix')])], [ctx('src/a.ts', twoHunks)]);
  assert.equal(out.scores[0]!.blocks[0]!.entry!.category, 'other');
  assert.equal(out.scores[0]!.blocks[1]!.entry!.category, 'fix');
  assert.equal(out.audit.length, 0);
});

test('a reason is cleaned to one line, and a missing one at 70 is kept and recorded', () => {
  const out = run([file('src/a.ts', [b('B1', 70, 'permission'), b('B2', 45, 'fix', 'first line\nsecond line')])], [ctx('src/a.ts', twoHunks)]);
  assert.equal(out.scores[0]!.blocks[0]!.entry!.reason, '');
  assert.equal(out.scores[0]!.blocks[1]!.entry!.reason, 'first line second line');
  assert.deepEqual(out.audit.filter((a) => a.action === 'reason_missing').map((a) => a.subject), ['src/a.ts B1']);
});

test('a missing reason below 40 is not recorded', () => {
  const out = run([file('src/a.ts', [b('B1', 39), b('B2', 5)])], [ctx('src/a.ts', twoHunks)]);
  assert.equal(out.audit.length, 0);
});

test('change_summary is cleaned to one line of at most 300 characters', () => {
  const [s] = run([{ ...file('src/a.ts', [b('B1', 5), b('B2', 5)]), change_summary: `${'x'.repeat(400)}\nmore` }], [ctx('src/a.ts', twoHunks)]).scores;
  assert.equal(s!.changeSummary.length, 300);
});

test('a block id that is not in the file voids the file; one seen twice takes the higher score; both are recorded', () => {
  const out = run([file('src/a.ts', [b('B1', 10), b('B9', 99), b('B1', 90, 'fix', 'x'), b('B2', 20)])], [ctx('src/a.ts', twoHunks)]);
  assert.deepEqual(out.scores[0]!.blocks.map((x) => x.entry?.score), [90, 20]);
  assertVoided(out.scores[0]!);
  assert.deepEqual(out.audit.map((a) => [a.action, a.subject]), [['block_not_in_file', 'src/a.ts B9'], ['block_duplicate', 'src/a.ts B1']]);
});

test('two items for one block, 10 and 85.5: the block has no score and the file is not_scored', () => {
  const out = run([{ ...file('src/a.ts', [b('B1', 10), b('B1', 85.5, 'fix', 'x'), b('B2', 5)]), score: 30, category: 'refactor' }], [ctx('src/a.ts', twoHunks)]);
  assert.equal(out.scores[0]!.blocks[0]!.entry, null);
  assert.deepEqual(out.scores[0]!.fileLevel, { score: 100, source: 'not_scored' });
  assert.equal(out.scores[0]!.covered, false);
});

test('a whole-file score does not stand for a block whose score was rejected', () => {
  const [s] = run([{ ...file('src/a.ts', [b('B2', 85.5, 'fix', 'x')]), score: 30, category: 'refactor' }], [ctx('src/a.ts', twoHunks)]).scores;
  assert.deepEqual(s!.fileLevel, { score: 100, source: 'not_scored' });
  assert.equal(s!.covered, false);
});

test('a whole-file score does not stand for a short block whose parts leave a changed line out', () => {
  const [s] = run([{ ...file('src/a.ts', [{ id: 'B1', parts: [part('R11', 'R11', 90, 'fix', 'x')] }]), score: 30, category: 'refactor' }], [ctx('src/a.ts', twoHunks)]).scores;
  assert.deepEqual(s!.fileLevel, { score: 100, source: 'not_scored' });
  assert.equal(s!.covered, false);
});

test('a whole-file score does not stand for the rest of a split', () => {
  const added = ctx('src/new.ts', fortyAdded, { status: 'added', additions: 40, deletions: 0 });
  const [s] = run([{ ...file('src/new.ts', [{ id: 'B1', parts: [part('R1', 'R20', 30, 'test')] }]), score: 30, category: 'test' }], [added]).scores;
  assert.deepEqual(s!.blocks.map((x) => [x.id, x.entry?.score ?? null]), [['B1.1', 30], ['B1.rest', null]]);
  assert.deepEqual(s!.fileLevel, { score: 100, source: 'not_scored' });
  assert.equal(s!.covered, false);
});

test('a whole-file score still stands for a block no item named', () => {
  const [s] = run([{ ...file('src/a.ts', [b('B1', 10)]), score: 30, category: 'refactor' }], [ctx('src/a.ts', twoHunks)]).scores;
  assert.deepEqual(s!.fileLevel, { score: 30, source: 'whole_file' });
  assert.equal(s!.finalScore, 30);
  assert.equal(s!.covered, true);
});

test('two entries for one file: the whole-file score is the higher one', () => {
  const out = run([{ ...file('src/a.ts', []), score: 20, category: 'refactor' }, { ...file('src/a.ts', []), score: 80, category: 'fix', reason: 'x' }], [ctx('src/a.ts', twoHunks)]);
  assert.equal(out.scores[0]!.wholeFile!.score, 80);
});

test('two entries for one file: an invalid whole-file score in either leaves the file with none', () => {
  const out = run([{ ...file('src/a.ts', []), score: 20, category: 'refactor' }, { ...file('src/a.ts', []), score: 80.5, category: 'fix', reason: 'x' }], [ctx('src/a.ts', twoHunks)]);
  assert.equal(out.scores[0]!.wholeFile, null);
  assert.deepEqual(out.scores[0]!.fileLevel, { score: 100, source: 'not_scored' });
});

test('two entries for one file: the first scores B1, the second B2, and both stand', () => {
  const out = run([{ ...file('src/a.ts', [b('B1', 10)]), change_summary: 'First.' }, { ...file('src/a.ts', [b('B2', 20)]), change_summary: 'Second.' }], [ctx('src/a.ts', twoHunks)]);
  assert.deepEqual(out.scores[0]!.blocks.map((x) => x.entry?.score), [10, 20]);
  assert.equal(out.scores[0]!.changeSummary, 'First.');
  assert.equal(out.scores[0]!.covered, true);
});

test('an item with neither score nor parts leaves its block alone and adds nothing of its own', () => {
  const out = run([file('src/a.ts', [{ id: 'B1' }, b('B2', 10)])], [ctx('src/a.ts', twoHunks)]);
  assert.equal(out.scores[0]!.blocks[0]!.entry, null);
  assert.deepEqual(out.audit.map((a) => a.action), ['block_not_scored']);
});

test('a long block is split into parts, each a block of its own', () => {
  const out = run([file('src/new.ts', [{ id: 'B1', parts: [part('R1', 'R20', 30, 'test'), part('R21', 'R40', 80, 'data_model', 'Adds a table.')] }])], [ctx('src/new.ts', fortyAdded, { status: 'added', additions: 40, deletions: 0 })]);
  assert.deepEqual(out.scores[0]!.blocks.map((x) => [x.id, x.hunk, x.entry?.score]), [['B1.1', 'B1', 30], ['B1.2', 'B1', 80]]);
  assert.equal(out.scores[0]!.blocks[0]!.changedLines, 20);
  assert.deepEqual(out.scores[0]!.blocks[0]!.lines, { RIGHT: [[1, 20]], LEFT: [] });
  assert.equal(out.scores[0]!.finalScore, 80);
  assert.equal(out.scores[0]!.covered, true);
});

test('a part dropped as overlapping voids the whole block, unsplit', () => {
  const out = run([file('src/new.ts', [{ id: 'B1', parts: [part('R1', 'R20', 30, 'test'), part('R15', 'R30', 80, 'data_model', 'Adds a table.')] }])], [ctx('src/new.ts', fortyAdded, { status: 'added', additions: 40, deletions: 0 })]);
  assert.deepEqual(out.scores[0]!.blocks.map((x) => [x.id, x.entry?.score ?? null]), [['B1', null]]);
  assert.deepEqual(out.scores[0]!.fileLevel, { score: 100, source: 'not_scored' });
  assert.equal(out.scores[0]!.covered, false);
  assert.ok(out.audit.some((a) => a.action === 'part_invalid' && a.subject === 'src/new.ts B1'));
});

test('a part with bad anchors or a bad score voids the whole block, unsplit', () => {
  const out = run([file('src/new.ts', [{ id: 'B1', parts: [part('X1', 'R20', 30, 'test'), part('R1', 'R20', 130, 'test'), part('R21', 'R40', 80, 'data_model', 'Adds a table.')] }])], [ctx('src/new.ts', fortyAdded, { status: 'added', additions: 40, deletions: 0 })]);
  assert.equal(out.audit.filter((a) => a.action === 'part_invalid').length, 2);
  assert.deepEqual(out.scores[0]!.blocks.map((x) => [x.id, x.entry?.score ?? null]), [['B1', null]]);
  assert.deepEqual(out.scores[0]!.fileLevel, { score: 100, source: 'not_scored' });
});

test('parts on a short block are not a split: the highest part stands', () => {
  const out = run([file('src/a.ts', [{ id: 'B1', parts: [part('L11', 'R11', 30, 'rename'), part('R12', 'R12', 75, 'calculation', 'Changes rounding.')] }, b('B2', 10, 'formatting')])], [ctx('src/a.ts', twoHunks)]);
  assert.deepEqual(out.scores[0]!.blocks.map((x) => x.id), ['B1', 'B2']);
  assert.equal(out.scores[0]!.blocks[0]!.entry!.score, 75);
  assert.ok(out.audit.some((a) => a.action === 'split_ignored' && a.subject === 'src/a.ts B1'));
});

for (const [name, parts, action] of [
  ['one part has an invalid score', [part('R11', 'R11', 85.5, 'fix', 'x'), part('R12', 'R12', 20, 'fix')], 'part_invalid'],
  ['the parts leave a changed line out', [part('R11', 'R11', 20, 'fix')], 'split_ignored'],
  ['the parts overlap', [part('R11', 'R12', 30, 'fix'), part('R12', 'R12', 75, 'fix', 'x')], 'part_invalid'],
] as const) {
  test(`a short block keeps no score when ${name}`, () => {
    const out = run([file('src/a.ts', [{ id: 'B1', parts: [...parts] }, b('B2', 10)])], [ctx('src/a.ts', twoHunks)]);
    assert.equal(out.scores[0]!.blocks[0]!.id, 'B1');
    assert.equal(out.scores[0]!.blocks[0]!.entry, null);
    assert.deepEqual(out.scores[0]!.fileLevel, { score: 100, source: 'not_scored' });
    assert.equal(out.scores[0]!.covered, false);
    assert.ok(out.audit.some((a) => a.action === action));
    assert.ok(out.audit.some((a) => a.action === 'block_not_scored' && a.subject === 'src/a.ts B1'));
  });
}

test('a long block whose parts are all rejected stays the original block', () => {
  const out = run([file('src/new.ts', [{ id: 'B1', parts: [part('R50', 'R60', 30, 'test'), part('R70', 'R80', 40, 'test')] }])], [ctx('src/new.ts', fortyAdded, { status: 'added', additions: 40, deletions: 0 })]);
  assert.deepEqual(out.scores[0]!.blocks.map((x) => [x.id, x.entry]), [['B1', null]]);
  assert.equal(out.audit.filter((a) => a.action === 'part_invalid').length, 2);
});

for (const kind of ['model', 'model_whole'] as const) {
  test(`an invalid whole-file score is 100 not_scored on a ${kind} file`, () => {
    const c = kind === 'model'
      ? ctx('src/a.ts', twoHunks)
      : ctx('lib/a.ts', null, { status: 'renamed', previousPath: 'src/a.ts', additions: 0, deletions: 0 });
    const out = run([{ ...file(c.file.path, []), score: 72.5, category: 'fix', reason: 'x' }], [c]);
    assert.deepEqual(out.scores[0]!.fileLevel, { score: 100, source: 'not_scored' });
    assert.equal(out.scores[0]!.covered, false);
    assert.ok(out.audit.some((a) => a.action === 'score_invalid' && a.subject === c.file.path));
  });
}

test('on a tie between parts of a short block the first stands', () => {
  const out = run([file('src/a.ts', [{ id: 'B1', parts: [part('L11', 'R11', 50, 'fix', 'First.'), part('R12', 'R12', 50, 'refactor', 'Second.')] }, b('B2', 10)])], [ctx('src/a.ts', twoHunks)]);
  assert.equal(out.scores[0]!.blocks[0]!.entry!.category, 'fix');
});

test('an item with both a score and parts voids its block', () => {
  const out = run([file('src/a.ts', [{ id: 'B1', score: 10, category: 'fix', parts: [part('R12', 'R12', 90, 'fix', 'x')] }, b('B2', 10)])], [ctx('src/a.ts', twoHunks)]);
  assert.deepEqual(out.scores[0]!.blocks.map((x) => [x.id, x.entry?.score ?? null]), [['B1', null], ['B2', 10]]);
  assertVoided(out.scores[0]!);
  assert.ok(out.audit.some((a) => a.action === 'score_and_parts' && a.subject === 'src/a.ts B1'));
});

test('a rename inside its directory scores 30 by rule and is covered', () => {
  const [s] = run([], [ctx('src/new-name.ts', null, { status: 'renamed', previousPath: 'src/old-name.ts', additions: 0, deletions: 0 })]).scores;
  assert.deepEqual(s!.fileLevel, { score: 30, source: 'rule_rename' });
  assert.equal(s!.finalScore, 30);
  assert.equal(s!.covered, true);
  assert.equal(s!.diffHash, null);
  assert.equal(s!.changedLines, 0);
  assert.equal(s!.previousPath, 'src/old-name.ts');
});

test('an image scores 10 by rule', () => {
  const [s] = run([], [ctx('img/logo.png', null, { status: 'added', additions: 0, deletions: 0 })]).scores;
  assert.deepEqual(s!.fileLevel, { score: 10, source: 'rule_asset' });
  assert.equal(s!.covered, true);
});

test('a floor beats a rule, on the old path too', () => {
  const floors = parseRepoFile('human_review:\n  - db/migrate/\n');
  const rename = ctx('db/migrate/002_b.sql', null, { status: 'renamed', previousPath: 'db/migrate/001_a.sql', additions: 0, deletions: 0 });
  assert.deepEqual(run([], [rename], { floors }).scores[0]!.fileLevel, { score: 100, source: 'team_floor' });
  const moved = ctx('src/001_a.sql', null, { status: 'renamed', previousPath: 'db/migrate/001_a.sql', additions: 0, deletions: 0 });
  const [s] = run([{ ...file('src/001_a.sql', []), score: 20, category: 'rename' }], [moved], { floors }).scores;
  assert.deepEqual(s!.fileLevel, { score: 100, source: 'team_floor' });
  assert.equal(s!.finalScore, 100);
});

test('a built-in floor wins a tie with the rule and the whole-file score', () => {
  const [s] = run([{ ...file('.github/workflows/ci.yml', []), score: 100, category: 'security_configuration', reason: 'Changes CI.' }], [ctx('.github/workflows/ci.yml', twoHunks)]).scores;
  assert.deepEqual(s!.fileLevel, { score: 100, source: 'builtin_floor' });
});

test('an unusable team file puts every file at 100 with its own source', () => {
  const [s] = run([file('src/a.ts', [b('B1', 5), b('B2', 5)])], [ctx('src/a.ts', twoHunks)], { floors: parseRepoFile('nonsense: 1') }).scores;
  assert.deepEqual(s!.fileLevel, { score: 100, source: 'team_file_invalid' });
});

test('a moved file needs its whole-file score', () => {
  const moved = () => ctx('lib/a.ts', null, { status: 'renamed', previousPath: 'src/a.ts', additions: 0, deletions: 0 });
  const withScore = run([{ ...file('lib/a.ts', []), score: 60, category: 'structure', reason: 'Moves the file.' }], [moved()]).scores[0]!;
  assert.deepEqual(withScore.fileLevel, { score: 60, source: 'whole_file' });
  assert.equal(withScore.covered, true);
  const without = run([file('lib/a.ts', [])], [moved()]).scores[0]!;
  assert.deepEqual(without.fileLevel, { score: 100, source: 'not_scored' });
  assert.equal(without.covered, false);
});

test('a file with no diff and no rule is 100 and not covered', () => {
  const [s] = run([], [ctx('docs/big.bin', null, { status: 'modified' })]).scores;
  assert.deepEqual(s!.fileLevel, { score: 100, source: 'not_scored' });
  assert.equal(s!.covered, false);
});

test('scores for another batch or another pull request are dropped', () => {
  const contexts = [ctx('src/a.ts', twoHunks), ctx('src/b.ts', twoHunks)];
  const out = run([file('src/a.ts', [b('B1', 5), b('B2', 5)]), file('src/b.ts', [b('B1', 5), b('B2', 5)]), file('elsewhere.ts', [])], contexts, { batch: ['src/a.ts'] });
  assert.equal(out.scores[0]!.finalScore, 5);
  assert.equal(out.scores[1]!.finalScore, 100);
  assert.deepEqual(out.audit.map((a) => [a.action, a.subject]), [['score_path_not_in_batch', 'src/b.ts'], ['score_path_not_in_pull_request', 'elsewhere.ts']]);
});

test('a later entry for a file is recorded as a duplicate and pooled with the first, and prefixes normalise', () => {
  const contexts = [ctx('src/a.ts', twoHunks)];
  const out = run([file('a/src/a.ts', [b('B1', 5), b('B2', 5)]), file('src/a.ts', [b('B1', 90, 'fix', 'x'), b('B2', 90, 'fix', 'x')])], contexts);
  assert.equal(out.scores[0]!.finalScore, 90);
  assert.deepEqual(out.audit.map((a) => [a.action, a.subject]), [['score_duplicate', 'src/a.ts'], ['block_duplicate', 'src/a.ts B1'], ['block_duplicate', 'src/a.ts B2']]);
});

test('an entry in a batch that did not hold the file does not hide a later one that did', () => {
  const contexts = [ctx('src/a.ts', twoHunks)];
  const value = (n: number): SubmitReviewArgs => ({ overview: 'o', findings: [], files: [file('src/a.ts', [b('B1', n), b('B2', n)])] });
  const out = reconcileScores([{ value: value(90), files: [] }, { value: value(7), files: ['src/a.ts'] }], contexts, new Set(), parseRepoFile(null));
  assert.equal(out.scores[0]!.finalScore, 7);
});

test('one score per context, in the order of the contexts', () => {
  const out = run([], [ctx('src/z.ts', twoHunks), ctx('src/a.ts', twoHunks)]);
  assert.deepEqual(out.scores.map((s) => s.path), ['src/z.ts', 'src/a.ts']);
});

test('the verdict', () => {
  const score = (finalScore: number): FileScore => ({ path: 'p', previousPath: null, diffHash: null, changeSummary: '', changedLines: 0, blocks: [], wholeFile: null, fileLevel: null, finalScore, covered: true });
  assert.deepEqual(verdictOf([score(69)], 70), { threshold: 70, needsHuman: false, highest: 69 });
  assert.deepEqual(verdictOf([score(69), score(70)], 70), { threshold: 70, needsHuman: true, highest: 70 });
  assert.deepEqual(verdictOf([], 70), { threshold: 70, needsHuman: false, highest: 0 });
});

test('a file whose changed lines hold hidden characters needs a person whatever its blocks score', () => {
  const hidden = { ...ctx('src/b.ts', patch(10), { status: 'renamed', previousPath: 'src/a.ts' }), hidden: true };
  const [s] = run([file('src/b.ts', [b('B1', 5)])], [hidden]).scores;
  assert.deepEqual(s!.fileLevel, { score: 100, source: 'hidden_characters' });
  assert.equal(s!.finalScore, 100);
  assert.equal(s!.covered, false);
});

test('hidden_characters loses a tie to the team file, wins it against not_scored', () => {
  const hidden = { ...ctx('src/a.ts', twoHunks), hidden: true };
  assert.equal(run([], [hidden], { floors: parseRepoFile('nonsense: 1') }).scores[0]!.fileLevel!.source, 'team_file_invalid');
  assert.equal(run([], [hidden]).scores[0]!.fileLevel!.source, 'hidden_characters');
});

function assertVoided(s: FileScore): void {
  assert.deepEqual(s.fileLevel, { score: 100, source: 'not_scored' });
  assert.equal(s.finalScore, 100);
  assert.equal(s.covered, false);
}
const forty = () => ctx('src/new.ts', fortyAdded, { status: 'added', additions: 40, deletions: 0 });

test('an invalid whole-file score voids the file even when every block is scored', () => {
  const out = run([{ ...file('src/a.ts', [b('B1', 10), b('B2', 10)]), score: 85.5, category: 'fix', reason: 'x' }], [ctx('src/a.ts', twoHunks)]);
  assertVoided(out.scores[0]!);
  assert.ok(out.audit.some((a) => a.action === 'score_invalid' && a.subject === 'src/a.ts'));
});

test('an invalid whole-file score in a second entry voids the file', () => {
  const out = run([{ ...file('src/a.ts', [b('B1', 10), b('B2', 10)]), score: 80, category: 'fix', reason: 'x' }, { ...file('src/a.ts', []), score: 85.5, category: 'fix', reason: 'x' }], [ctx('src/a.ts', twoHunks)]);
  assertVoided(out.scores[0]!);
});

test('a long block whose second part overlaps the first is voided', () => {
  const out = run([file('src/new.ts', [{ id: 'B1', parts: [part('R1', 'R40', 10, 'test'), part('R10', 'R20', 90, 'test', 'x')] }])], [forty()]);
  assert.deepEqual(out.scores[0]!.blocks.map((x) => [x.id, x.entry]), [['B1', null]]);
  assertVoided(out.scores[0]!);
});

test('a long block split with an invalid part, then scored 20 by a second item, is voided', () => {
  const out = run([file('src/new.ts', [{ id: 'B1', parts: [part('R1', 'R20', 10, 'test'), part('R21', 'R40', 85.5, 'test', 'x')] }, b('B1', 20, 'test')])], [forty()]);
  assertVoided(out.scores[0]!);
});

test('two items for one block, a complete valid split and a plain 20, void the block', () => {
  const out = run([file('src/new.ts', [{ id: 'B1', parts: [part('R1', 'R20', 10, 'test'), part('R21', 'R40', 10, 'test')] }, b('B1', 20, 'test')])], [forty()]);
  assert.deepEqual(out.scores[0]!.blocks.map((x) => [x.id, x.entry]), [['B1', null]]);
  assertVoided(out.scores[0]!);
  assert.ok(out.audit.some((a) => a.action === 'block_duplicate' && a.subject === 'src/new.ts B1'));
});

test('a long block with one valid part that leaves lines out: the part and a voided rest', () => {
  const out = run([file('src/new.ts', [{ id: 'B1', parts: [part('R1', 'R20', 30, 'test')] }])], [forty()]);
  assert.deepEqual(out.scores[0]!.blocks.map((x) => [x.id, x.entry?.score ?? null]), [['B1.1', 30], ['B1.rest', null]]);
  assertVoided(out.scores[0]!);
});

test('an empty parts array beside a score is a plain score', () => {
  const out = run([file('src/a.ts', [{ id: 'B1', score: 10, category: 'fix', parts: [] }, b('B2', 10)])], [ctx('src/a.ts', twoHunks)]);
  assert.equal(out.scores[0]!.blocks[0]!.entry!.score, 10);
  assert.deepEqual([out.scores[0]!.finalScore, out.scores[0]!.covered], [10, true]);
  assert.ok(!out.audit.some((a) => a.action === 'score_and_parts'));
});

test('an empty parts array alone is an item with neither a score nor parts', () => {
  const [s] = run([{ ...file('src/a.ts', [{ id: 'B1', parts: [] }]), score: 30, category: 'refactor' }], [ctx('src/a.ts', twoHunks)]).scores;
  assert.equal(s!.blocks[0]!.entry, null);
  assert.deepEqual(s!.fileLevel, { score: 30, source: 'whole_file' });
  assert.deepEqual([s!.finalScore, s!.covered], [30, true]);
});

test('a score for a block id that is not in the file voids the file', () => {
  const out = run([file('src/a.ts', [b('B1', 10), b('B2', 10), b('B9', 99, 'fix', 'x')])], [ctx('src/a.ts', twoHunks)]);
  assertVoided(out.scores[0]!);
  assert.ok(out.audit.some((a) => a.action === 'block_not_in_file' && a.subject === 'src/a.ts B9'));
});

test('part ids used as block ids void the file', () => {
  const out = run([{ ...file('src/new.ts', [b('B1.1', 10), b('B1.2', 90, 'fix', 'x')]), score: 10, category: 'test' }], [forty()]);
  assertVoided(out.scores[0]!);
});

test('a moved file with a whole-file score and an item for a block it does not have is voided', () => {
  const moved = ctx('lib/a.ts', null, { status: 'renamed', previousPath: 'src/a.ts', additions: 0, deletions: 0 });
  const out = run([{ ...file('lib/a.ts', [b('B1', 95, 'fix', 'x')]), score: 20, category: 'structure' }], [moved]);
  assertVoided(out.scores[0]!);
});

test('an item with neither a score nor parts beside a plain 10 for the same block voids the block', () => {
  const out = run([file('src/a.ts', [{ id: 'B1' }, b('B1', 10), b('B2', 10)])], [ctx('src/a.ts', twoHunks)]);
  assert.equal(out.scores[0]!.blocks[0]!.entry, null);
  assertVoided(out.scores[0]!);
});

test('an invalid whole-file score on a file scored by a fixed rule leaves it not_scored', () => {
  const rename = ctx('src/new-name.ts', null, { status: 'renamed', previousPath: 'src/old-name.ts', additions: 0, deletions: 0 });
  const out = run([{ ...file('src/new-name.ts', []), score: 72.5, category: 'rename', reason: 'x' }], [rename]);
  assertVoided(out.scores[0]!);
});

// Scores that hold across reviews: a file whose context keeps what earlier runs scored.
const one = () => ctx('src/a.ts', patch(10));
function kept(over: Partial<KeptScores> = {}): KeptScores {
  return {
    blocks: ctx('src/a.ts', twoHunks).blocks, entries: new Map(), stoodFor: new Set(), wholeFile: null, floor: 0,
    settled: false, covered: false, scoredHunks: new Set(), readAt: null, ...over,
  };
}
const keptEntry = (score: number, over: Partial<KeptEntry> = {}): KeptEntry =>
  ({ entry: { score, category: 'fix', reason: 'Kept.' }, origin: 'earlier_run', raisedFrom: null, range: null, ...over });
const withKept = (k: KeptScores, c: FileContext = ctx('src/a.ts', twoHunks)): FileContext => ({ ...c, kept: k });
// One model answer for the file, reconciled against a context that keeps `k`.
const answer = (f: RawFile | null, k: KeptScores, options: { notRead?: string[]; c?: FileContext; by?: ScoredBy } = {}) => {
  const value: SubmitReviewArgs = { overview: 'o', findings: [], files: f === null ? [] : [f] };
  const c = withKept(k, options.c);
  return reconcileScores([{ value, files: [c.file.path] }], [c], new Set(options.notRead ?? []), parseRepoFile(null), options.by);
};
const whole = (f: RawFile, score: number, category = 'refactor', reason?: string): RawFile =>
  (reason === undefined ? { ...f, score, category } : { ...f, score, category, reason });
const already = (id: string) => ({ stage: 'reconcile', action: 'block_already_scored', subject: `src/a.ts ${id}`, reason: 'ignored' });

test('a kept block keeps its score whatever the model says about it', () => {
  const out = answer(file('src/a.ts', [b('B1', 10), b('B2', 30)]), kept({ entries: new Map([['B1', keptEntry(70)]]), scoredHunks: new Set(['B1']) }));
  const [s] = out.scores;
  assert.deepEqual(s!.blocks.map((x) => [x.id, x.entry?.score, x.origin]), [['B1', 70, 'earlier_run'], ['B2', 30, undefined]]);
  assert.deepEqual(s!.blocks[0]!.entry, { score: 70, category: 'fix', reason: 'Kept.' });
  assert.deepEqual([s!.finalScore, s!.fileLevel, s!.covered], [70, null, true]);
  assert.deepEqual(out.audit, [already('B1')]);
});

test('a new or edited block cannot score below a block the file lost', async (t) => {
  const k = () => kept({ entries: new Map([['B1', keptEntry(10)]]), scoredHunks: new Set(['B1']), floor: 85 });
  await t.test('a score below the floor is raised to it, and the given score is kept beside it', () => {
    const [s] = answer(file('src/a.ts', [b('B2', 30, 'refactor', 'Moves a check.')]), k()).scores;
    assert.deepEqual(s!.blocks[1]!.entry, { score: 85, category: 'refactor', reason: 'Moves a check.' });
    assert.equal(s!.blocks[1]!.raisedFrom, 30);
    assert.equal(s!.finalScore, 85);
  });
  await t.test('a score above the floor stands as given', () => {
    const [s] = answer(file('src/a.ts', [b('B2', 90, 'business_rule', 'Changes a limit.')]), k()).scores;
    assert.deepEqual(s!.blocks[1]!.entry, { score: 90, category: 'business_rule', reason: 'Changes a limit.' });
    assert.equal('raisedFrom' in s!.blocks[1]!, false);
  });
});

test('a whole-file score in place of a block score cannot go under the floor', () => {
  const c = one();
  const out = answer(whole(file('src/a.ts', []), 20, 'refactor', 'Reorders the checks.'), kept({ blocks: c.blocks, floor: 90 }), { c });
  const [s] = out.scores;
  assert.deepEqual(s!.blocks[0]!.entry, { score: 90, category: 'refactor', reason: 'Reorders the checks.' });
  assert.equal(s!.blocks[0]!.raisedFrom, 20);
  assert.equal(s!.finalScore, 90);
  assert.equal(s!.covered, true);
});

test('a whole-file score at or above the floor stands for the block as it does today', () => {
  const c = one();
  const [s] = answer(whole(file('src/a.ts', []), 60, 'refactor', 'Reorders the checks.'), kept({ blocks: c.blocks, floor: 40 }), { c }).scores;
  assert.equal(s!.blocks[0]!.entry, null);
  assert.equal('raisedFrom' in s!.blocks[0]!, false);
  assert.deepEqual(s!.fileLevel, { score: 60, source: 'whole_file' });
  assert.deepEqual([s!.finalScore, s!.covered], [60, true]);
});

test('a whole-file score never falls', async (t) => {
  const k = () => kept({ entries: new Map([['B1', keptEntry(10)]]), scoredHunks: new Set(['B1']), wholeFile: { score: 60, category: 'refactor', reason: 'Kept.' } });
  await t.test('a lower one from the model leaves the kept one, and says so', () => {
    const out = answer(whole(file('src/a.ts', [b('B2', 10)]), 40, 'refactor', 'Lower.'), k());
    assert.deepEqual(out.scores[0]!.wholeFile, { score: 60, category: 'refactor', reason: 'Kept.' });
    assert.deepEqual(out.scores[0]!.fileLevel, { score: 60, source: 'whole_file' });
    assert.equal(out.scores[0]!.finalScore, 60);
    assert.deepEqual(out.audit, [{ stage: 'reconcile', action: 'whole_file_kept', subject: 'src/a.ts', reason: 'kept' }]);
  });
  await t.test('a higher one from the model stands', () => {
    const out = answer(whole(file('src/a.ts', [b('B2', 10)]), 80, 'fix', 'Higher.'), k());
    assert.deepEqual(out.scores[0]!.wholeFile, { score: 80, category: 'fix', reason: 'Higher.' });
    assert.equal(out.scores[0]!.finalScore, 80);
    assert.deepEqual(out.audit, []);
  });
  await t.test('none from the model leaves the kept one', () => {
    const out = answer(file('src/a.ts', [b('B2', 10)]), k());
    assert.deepEqual(out.scores[0]!.fileLevel, { score: 60, source: 'whole_file' });
    assert.equal(out.scores[0]!.finalScore, 60);
  });
});

test('the kept whole-file score wins a tie with the one the model gives', () => {
  const k = kept({ entries: new Map([['B1', keptEntry(10)]]), scoredHunks: new Set(['B1']), wholeFile: { score: 60, category: 'refactor', reason: 'Kept.' } });
  const out = answer(whole(file('src/a.ts', [b('B2', 10)]), 60, 'fix', 'Given.'), k);
  assert.deepEqual(out.scores[0]!.wholeFile, { score: 60, category: 'refactor', reason: 'Kept.' });
  assert.deepEqual(out.audit, []);
});

test('a file with a hidden character on a changed line counts as 100 whatever it keeps', () => {
  const k = kept({ entries: new Map([['B1', keptEntry(70)], ['B2', keptEntry(40)]]), scoredHunks: new Set(['B1', 'B2']), settled: true, covered: true });
  const [s] = answer(null, k, { c: { ...ctx('src/a.ts', twoHunks), hidden: true } }).scores;
  assert.deepEqual([s!.fileLevel, s!.finalScore, s!.covered], [{ score: 100, source: 'hidden_characters' }, 100, false]);
});

test('a settled file answered in two batches names the whole-file score it ignores once', () => {
  const c = withKept(kept({ entries: new Map([['B1', keptEntry(70)], ['B2', keptEntry(40)]]), scoredHunks: new Set(['B1', 'B2']), settled: true, covered: true }));
  const value = (score: number): SubmitReviewArgs => ({ overview: 'o', findings: [], files: [whole(file('src/a.ts', []), score)] });
  const out = reconcileScores([{ value: value(10), files: ['src/a.ts'] }, { value: value(20), files: ['src/a.ts'] }], [c], new Set(), parseRepoFile(null));
  assert.deepEqual(out.audit.filter((e) => e.action === 'whole_file_settled'), [{ stage: 'reconcile', action: 'whole_file_settled', subject: 'src/a.ts', reason: 'ignored' }]);
});

test('a kept whole-file score does not stand for a new block', () => {
  const k = kept({ wholeFile: { score: 40, category: 'refactor', reason: 'Kept.' }, stoodFor: new Set(['B1']), scoredHunks: new Set(['B1']) });
  const out = answer(file('src/a.ts', []), k);
  const [s] = out.scores;
  assert.deepEqual(s!.blocks.map((x) => x.entry), [null, null]);
  assert.deepEqual(s!.fileLevel, { score: 100, source: 'not_scored' });
  assert.deepEqual([s!.finalScore, s!.covered], [100, false]);
  assert.deepEqual(out.audit, [{ stage: 'reconcile', action: 'block_not_scored', subject: 'src/a.ts B2', reason: 'counts_as_100' }]);
});

test('a block an item named without a usable score is not stood for', () => {
  const k = kept({ entries: new Map([['B1', keptEntry(10)]]), scoredHunks: new Set(['B1']) });
  const [s] = answer(whole(file('src/a.ts', [b('B2', 85.5, 'fix', 'x')]), 30), k).scores;
  assert.deepEqual(s!.fileLevel, { score: 100, source: 'not_scored' });
  assert.deepEqual([s!.finalScore, s!.covered], [100, false]);
});

test('a file with nothing left to score cannot be moved by the answer', async (t) => {
  const settled = () => kept({ entries: new Map([['B1', keptEntry(70)], ['B2', keptEntry(40)]]), scoredHunks: new Set(['B1', 'B2']), settled: true, covered: true });
  const parts = () => {
    const c = forty();
    const cut = partsAt(c.blocks[0]!, [[0, 19], [20, 39]])!;
    const k = kept({
      blocks: cut, settled: true, covered: true, scoredHunks: new Set(['B1']),
      entries: new Map([['B1.1', keptEntry(70, { range: [0, 19] })], ['B1.2', keptEntry(40, { range: [20, 39] })]]),
    });
    return { c, k };
  };
  const unmoved = (out: ReturnType<typeof answer>, audit: unknown[]) => {
    assert.deepEqual([out.scores[0]!.finalScore, out.scores[0]!.covered], [70, true]);
    assert.deepEqual(out.audit, audit);
  };
  await t.test('by a score for a kept block', () => {
    unmoved(answer(file('src/a.ts', [b('B1', 10)]), settled()), [already('B1')]);
  });
  await t.test('by an item for the hunk of kept parts', () => {
    const { c, k } = parts();
    unmoved(answer(file('src/new.ts', [b('B1', 10)]), k, { c }), [{ stage: 'reconcile', action: 'block_already_scored', subject: 'src/new.ts B1', reason: 'ignored' }]);
  });
  await t.test('by an item for a block the file does not have', () => {
    unmoved(answer(file('src/a.ts', [b('B9', 99, 'fix', 'x')]), settled()), [{ stage: 'reconcile', action: 'block_not_in_file', subject: 'src/a.ts B9', reason: 'ignored' }]);
  });
  await t.test('by a whole-file score that is not valid', () => {
    unmoved(answer(whole(file('src/a.ts', []), 150, 'fix', 'x'), settled()), [{ stage: 'reconcile', action: 'whole_file_settled', subject: 'src/a.ts', reason: 'ignored' }]);
  });
  await t.test('by a low whole-file score', () => {
    const out = answer(whole(file('src/a.ts', []), 10), settled());
    unmoved(out, [{ stage: 'reconcile', action: 'whole_file_settled', subject: 'src/a.ts', reason: 'ignored' }]);
    assert.equal(out.scores[0]!.wholeFile, null);
  });
  await t.test('by no entry for the file at all', () => {
    unmoved(answer(null, settled()), []);
  });
});

test('a file that was not sent is scored from what it keeps', () => {
  const k = kept({ entries: new Map([['B1', keptEntry(70)], ['B2', keptEntry(40)]]), scoredHunks: new Set(['B1', 'B2']), settled: true, covered: true });
  const [s] = answer(null, k).scores;
  assert.equal(s!.fileLevel, null);
  assert.deepEqual([s!.finalScore, s!.covered], [70, true]);
});

test('a file that is not settled but keeps a score for every block is scored from what it keeps, and may take a whole-file score', async (t) => {
  const k = () => kept({ entries: new Map([['B1', keptEntry(70)], ['B2', keptEntry(40)]]), scoredHunks: new Set(['B1', 'B2']) });
  await t.test('answered with nothing', () => {
    const [s] = answer(null, k()).scores;
    assert.equal(s!.fileLevel, null);
    assert.deepEqual([s!.finalScore, s!.covered], [70, true]);
  });
  await t.test('answered with a whole-file score', () => {
    const out = answer(whole(file('src/a.ts', []), 90, 'business_rule', 'The two blocks together change who may refund.'), k());
    assert.deepEqual(out.scores[0]!.fileLevel, { score: 90, source: 'whole_file' });
    assert.deepEqual([out.scores[0]!.finalScore, out.scores[0]!.covered], [90, true]);
    assert.deepEqual(out.audit, []);
  });
});

test('a file that could not be read counts as 100 whatever it keeps', () => {
  const k = kept({ entries: new Map([['B1', keptEntry(70)], ['B2', keptEntry(40)]]), scoredHunks: new Set(['B1', 'B2']), settled: true, covered: true });
  const [s] = answer(null, k, { notRead: ['src/a.ts'] }).scores;
  assert.deepEqual(s!.fileLevel, { score: 100, source: 'not_scored' });
  assert.deepEqual([s!.finalScore, s!.covered], [100, false]);
});

test('a file that was not sent and has a block with no score is not scored', () => {
  const [s] = answer(null, kept({ entries: new Map([['B1', keptEntry(70)]]), scoredHunks: new Set(['B1']) })).scores;
  assert.deepEqual(s!.fileLevel, { score: 100, source: 'not_scored' });
  assert.deepEqual([s!.finalScore, s!.covered], [100, false]);
});

test('a block the file score stands for needs no entry of its own', () => {
  const k = kept({
    stoodFor: new Set(['B1']), wholeFile: { score: 60, category: 'refactor', reason: 'Kept.' }, entries: new Map([['B2', keptEntry(40)]]),
    scoredHunks: new Set(['B1', 'B2']), settled: true, covered: true,
  });
  const [s] = answer(null, k).scores;
  assert.deepEqual(s!.blocks.map((x) => x.entry?.score ?? null), [null, 40]);
  assert.deepEqual(s!.fileLevel, { score: 60, source: 'whole_file' });
  assert.deepEqual([s!.finalScore, s!.covered], [60, true]);
});

test('a moved file that has its score keeps it whatever the model says', async (t) => {
  const c = () => ctx('lib/a.ts', null, { status: 'renamed', previousPath: 'src/a.ts', additions: 0, deletions: 0 });
  const k = () => kept({ blocks: [], wholeFile: { score: 75, category: 'structure', reason: 'Moves the file.' }, settled: true, covered: true });
  const level = (out: ReturnType<typeof answer>) => [out.scores[0]!.fileLevel, out.scores[0]!.finalScore, out.scores[0]!.covered];
  const kept75 = [{ score: 75, source: 'whole_file' }, 75, true];
  await t.test('with no answer', () => {
    assert.deepEqual(level(answer(null, k(), { c: c() })), kept75);
  });
  await t.test('with a lower answer', () => {
    assert.deepEqual(level(answer(whole(file('lib/a.ts', []), 40, 'structure', 'Moves it.'), k(), { c: c() })), kept75);
  });
  await t.test('with a higher answer, which is named in the audit', () => {
    const out = answer(whole(file('lib/a.ts', []), 90, 'structure', 'Moves it.'), k(), { c: c() });
    assert.deepEqual(level(out), kept75);
    assert.deepEqual(out.audit, [{ stage: 'reconcile', action: 'whole_file_settled', subject: 'lib/a.ts', reason: 'ignored' }]);
  });
});

test('a part split off in any run remembers where it sits in its hunk', () => {
  const out = run([file('src/new.ts', [{ id: 'B1', parts: [part('R1', 'R20', 30, 'test'), part('R21', 'R40', 80, 'data_model', 'Adds a table.')] }])], [forty()]);
  assert.deepEqual(out.scores[0]!.blocks.map((x) => [x.id, x.range]), [['B1.1', [0, 19]], ['B1.2', [20, 39]]]);
});

test('kept parts keep their scores and their places', () => {
  const c = forty();
  const cut = partsAt(c.blocks[0]!, [[0, 19], [20, 39]])!;
  const k = kept({
    blocks: cut, settled: true, covered: true, scoredHunks: new Set(['B1']),
    entries: new Map([['B1.1', keptEntry(30, { range: [0, 19] })], ['B1.2', keptEntry(80, { range: [20, 39], raisedFrom: 50 })]]),
  });
  const [s] = answer(null, k, { c }).scores;
  assert.deepEqual(s!.blocks.map((x) => [x.id, x.hunk, x.entry?.score, x.origin, x.range, x.raisedFrom, x.changedLines]), [
    ['B1.1', 'B1', 30, 'earlier_run', [0, 19], undefined, 20], ['B1.2', 'B1', 80, 'earlier_run', [20, 39], 50, 20],
  ]);
  assert.equal('raisedFrom' in s!.blocks[0]!, false);
  assert.deepEqual(s!.blocks[0]!.lines, { RIGHT: [[1, 20]], LEFT: [] });
  assert.deepEqual([s!.finalScore, s!.covered], [80, true]);
});

test('an entry the scorer gave says so, in the run that gave it and in every run that keeps it', async (t) => {
  await t.test('in the run that gave it', () => {
    const c = ctx('src/a.ts', twoHunks);
    const value: SubmitReviewArgs = { overview: '', findings: [], files: [file('src/a.ts', [b('B1', 20), b('B2', 30)])] };
    const out = reconcileScores([{ value, files: ['src/a.ts'] }], [c], new Set(), parseRepoFile(null), 'scorer');
    assert.deepEqual(out.scores[0]!.blocks.map((x) => x.by), ['scorer', 'scorer']);
  });
  await t.test('in a run that keeps it', () => {
    const out = answer(file('src/a.ts', [b('B2', 30)]), kept({ entries: new Map([['B1', keptEntry(70)]]), scoredHunks: new Set(['B1']) }), { by: 'scorer' });
    assert.deepEqual(out.scores[0]!.blocks.map((x) => [x.id, x.by]), [['B1', 'scorer'], ['B2', 'scorer']]);
  });
  await t.test('and nothing is written when the review model gave it', () => {
    const out = answer(file('src/a.ts', [b('B2', 30)]), kept({ entries: new Map([['B1', keptEntry(70)]]), scoredHunks: new Set(['B1']) }), { by: 'model' });
    assert.deepEqual(out.scores[0]!.blocks.map((x) => 'by' in x), [false, false]);
  });
});

test('a file that still has something to score is not scored after a careless answer, as today', async (t) => {
  const k = () => kept({ entries: new Map([['B1', keptEntry(70)]]), scoredHunks: new Set(['B1']) });
  const voided = (out: ReturnType<typeof answer>) => {
    assert.deepEqual(out.scores[0]!.fileLevel, { score: 100, source: 'not_scored' });
    assert.deepEqual([out.scores[0]!.finalScore, out.scores[0]!.covered], [100, false]);
  };
  await t.test('with an item for a block the file does not have', () => {
    voided(answer(file('src/a.ts', [b('B2', 10), b('B9', 99, 'fix', 'x')]), k()));
  });
  await t.test('with a whole-file score that is not valid', () => {
    voided(answer(whole(file('src/a.ts', [b('B2', 10)]), 150, 'fix', 'x'), k()));
  });
});

test('a file with nothing kept is scored as before, but for the range of its parts', () => {
  const c = ctx('src/a.ts', twoHunks);
  const [h1, h2] = c.blocks;
  const expected = {
    scores: [{
      path: 'src/a.ts', previousPath: null, diffHash: fileDiffHash(c.hunks), changeSummary: 'Summary.', changedLines: 5,
      blocks: [
        { id: 'B1', hunk: 'B1', hunkHash: h1!.hash, hash: h1!.hash, changedLines: 3, span: { side: 'RIGHT', first: 11, last: 12 }, lines: { RIGHT: [[10, 14]], LEFT: [[10, 13]] }, entry: { score: 20, category: 'rename', reason: '' } },
        { id: 'B2', hunk: 'B2', hunkHash: h2!.hash, hash: h2!.hash, changedLines: 2, span: { side: 'RIGHT', first: 52, last: 52 }, lines: { RIGHT: [[51, 53]], LEFT: [[50, 52]] }, entry: { score: 75, category: 'business_rule', reason: 'Changes who may refund.' } },
      ],
      wholeFile: null, fileLevel: null, finalScore: 75, covered: true,
    }],
    audit: [],
  };
  const answered = [file('src/a.ts', [b('B1', 20, 'rename'), b('B2', 75, 'business_rule', 'Changes who may refund.')])];
  assert.deepEqual(run(answered, [c]), expected);
  const value: SubmitReviewArgs = { overview: 'o', findings: [], files: answered };
  assert.deepEqual(reconcileScores([{ value, files: ['src/a.ts'] }], [ctx('src/a.ts', twoHunks)], new Set(), parseRepoFile(null), 'model'), expected);
});
