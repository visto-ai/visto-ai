import test from 'node:test';
import assert from 'node:assert/strict';
import { fitBody, inert, MAX_BODY_CHARS, renderReview } from './body.ts';
import type { Discussed, Finding, NotReviewed, RawFinding, ReviewResult, ThreadVerdict, UnplacedFinding } from '../types.ts';
import type { BlockScore, Category, FileLevelSource, FileScore, Span } from '../score/types.ts';

const ZW = '\u200b';
const usage = { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0 };
const finding = (over: Partial<Finding> = {}): Finding => ({
  path: 'src/a.ts', side: 'RIGHT', line: 10, severity: 'major', body: 'Breaks on empty input.', quote: 'q', requestedLine: null, ...over,
});
const unplaced = (over: Partial<UnplacedFinding> = {}): UnplacedFinding => ({
  path: 'src/b.ts', side: 'RIGHT', line: 4, severity: 'minor', body: 'Name is unclear.', quote: 'q', reason: 'line_not_in_diff', ...over,
});
const beyond = (over: Partial<RawFinding> = {}): RawFinding => ({
  path: 'src/c.ts', side: 'RIGHT', line: 7, severity: 'minor', body: 'Caller ignores the error.', quote: 'q', beyond_diff: true, ...over,
});
const result = (over: Partial<ReviewResult> = {}): ReviewResult => ({
  status: 'ok', failure: null, mode: 'full', overview: 'Changes a.ts.', findings: [], unplaced: [], beyondDiff: [],
  coverage: { reviewed: [], notReviewed: [] }, usage, models: [], providers: [], dependencies: { model: 'ok' }, audit: [],
  scores: [], verdict: { threshold: 70, needsHuman: false, highest: 0 }, teamFileInvalid: null, ...over,
});
const auto = { trigger: 'automatic', requestedBy: null, lineUrl: null, inline: true } as const;
const notReviewed = (n: number): NotReviewed[] =>
  (['no_diff', 'too_large', 'over_batch_limit', 'batch_failed'] as const).slice(0, n).map((reason, i) => ({ path: `f${i}.bin`, reason }));
const full = result({
  findings: [finding({ severity: 'blocker', line: 3 }), finding({ line: 5 }), finding({ line: 6, requestedLine: 15 })],
  unplaced: [unplaced({ side: 'LEFT' })],
  beyondDiff: [beyond()],
  coverage: { reviewed: ['src/a.ts'], notReviewed: notReviewed(3) },
});

test('no findings', () => {
  assert.match(renderReview(result(), auto).body, /## Summary\n\nChanges a\.ts\.\n\n## Human review\n\nNothing here is at or above 70%\. The highest score is 0%\.\n\n## Overall\n\nNo findings\. Human review: not needed \(highest score 0%\)\.$/);
  assert.equal(renderReview(result(), auto).body, '## Summary\n\nChanges a.ts.\n\n## Human review\n\nNothing here is at or above 70%. The highest score is 0%.\n\n## Overall\n\nNo findings. Human review: not needed (highest score 0%).');
});
test('an empty overview leaves the summary out', () => {
  assert.equal(renderReview(result({ overview: '  ' }), auto).body, '## Human review\n\nNothing here is at or above 70%. The highest score is 0%.\n\n## Overall\n\nNo findings. Human review: not needed (highest score 0%).');
});
test('an inline comment carries its tag, and a moved one its note', () => {
  const { comments } = renderReview(result({ findings: [finding({ line: 12, requestedLine: 15 })] }), auto);
  assert.deepEqual(comments, [{ path: 'src/a.ts', side: 'RIGHT', line: 12, body: '**\\[major]** _(Refers to line 15, just outside the diff.)_\n\nBreaks on empty input.' }]);
});
test('an unmoved comment has no note', () => {
  assert.equal(renderReview(result({ findings: [finding({ severity: 'minor' })] }), auto).comments[0]!.body, '**\\[minor]**\n\nBreaks on empty input.');
});
test('the left side says old line', () => {
  const { comments } = renderReview(result({ findings: [finding({ side: 'LEFT', line: 8, requestedLine: 9 })] }), auto);
  assert.equal(comments[0]!.body, '**\\[major]** _(Refers to old line 9, just outside the diff.)_\n\nBreaks on empty input.');
  assert.equal(comments[0]!.side, 'LEFT');
});
test('sections appear in order and only when they have content', () => {
  const b = renderReview(full, auto).body;
  const order = ['## Summary', '## Human review', '## Findings', '## Findings not placed on the diff', '## Beyond the diff', '## Coverage', '## Overall'].map((h) => b.indexOf(h + '\n'));
  assert.deepEqual(order, [...order].sort((x, y) => x - y));
  assert.ok(order.every((i) => i >= 0));
  const bare = renderReview(result(), auto).body;
  for (const h of ['## Findings', '## Beyond the diff', '## Coverage']) assert.equal(bare.includes(h), false);
});
test('the overall line counts', () => {
  assert.match(renderReview(full, auto).body, /1 blocker, 2 major, 0 minor\. 1 could not be placed on the diff\. 3 files were not reviewed\. Human review: not needed \(highest score 0%\)\.$/);
});
test('overall: unplaced only, and not-reviewed only', () => {
  assert.match(renderReview(result({ unplaced: [unplaced()] }), auto).body, /## Overall\n\n0 blocker, 0 major, 0 minor\. 1 could not be placed on the diff\. Human review: not needed \(highest score 0%\)\.$/);
  assert.match(renderReview(result({ coverage: { reviewed: [], notReviewed: notReviewed(2) } }), auto).body, /## Overall\n\nNo findings\. 2 files were not reviewed\. Human review: not needed \(highest score 0%\)\.$/);
  assert.match(renderReview(result({ findings: [finding()], coverage: { reviewed: [], notReviewed: notReviewed(1) } }), auto).body, /0 blocker, 1 major, 0 minor\. 1 files were not reviewed\. Human review: not needed \(highest score 0%\)\.$/);
});
test('beyond-the-diff items do not count in the overall line', () => {
  assert.match(renderReview(result({ beyondDiff: [beyond()] }), auto).body, /## Overall\n\nNo findings\. Human review: not needed \(highest score 0%\)\.$/);
});
test('finding, unplaced, beyond and coverage bullets have the exact shape', () => {
  const b = renderReview(full, auto).body;
  assert.ok(b.includes('\n- **\\[blocker]** `src/a.ts:3` \u2014 Breaks on empty input.\n'));
  assert.ok(b.includes('\n- `src/b.ts:4` (old file) \u2014 Name is unclear.\n'));
  assert.ok(b.includes('## Beyond the diff\n\n- **\\[minor]** `src/c.ts:7` \u2014 Caller ignores the error.\n'));
  assert.ok(b.includes("GitHub cannot show these inline: the line is outside this pull request's diff, or the file has no diff GitHub can comment on. They do not block the merge.\n\n- `src/b.ts:4`"));
  assert.ok(b.includes('## Coverage\n\nThese files were not reviewed:\n\n- `f0.bin`: no_diff\n- `f1.bin`: too_large\n- `f2.bin`: over_batch_limit\n\n## Overall'));
});
test('a right-side unplaced item has no old-file note', () => {
  assert.ok(renderReview(result({ unplaced: [unplaced()] }), auto).body.includes('- `src/b.ts:4` \u2014 Name is unclear.\n'));
});
test('the first line is the first non-empty line, cut to 300 characters', () => {
  const long = '\n\n  ' + 'y'.repeat(400) + '\nsecond';
  const b = renderReview(result({ findings: [finding({ body: long })] }), auto).body;
  assert.ok(b.includes(` \u2014 ${'y'.repeat(299)}\u2026\n`));
  assert.equal(b.includes('second'), false);
});
test('the first-line cut never splits a surrogate pair', () => {
  const b = renderReview(result({ findings: [finding({ body: 'y'.repeat(298) + '\u{1F600}\u{1F600}' })] }), auto).body;
  assert.ok(b.isWellFormed());
});
test('a path with a backtick is shown between double backticks', () => {
  const b = renderReview(result({ findings: [finding({ path: 'a`b.ts' })], beyondDiff: [beyond({ path: 'x`y' })] }), auto).body;
  assert.ok(b.includes('`` a`b.ts:10 `` \u2014'));
  assert.ok(b.includes('`` x`y:7 `` \u2014'));
});
test('a manual run is prefixed', () => {
  assert.match(renderReview(result(), { trigger: 'manual', requestedBy: 'dev-one', lineUrl: null, inline: true }).body, /^\*\*Full review\*\* requested by @dev-one\.\n\n## Summary/);
  assert.match(renderReview(result(), { trigger: 'manual', requestedBy: null, lineUrl: null, inline: true }).body, /^\*\*Full review\*\* requested\.\n\n## Summary/);
  assert.doesNotMatch(renderReview(result(), auto).body, /Full review/);
});
test('a long list is capped at 25', () => {
  const many = Array.from({ length: 30 }, (_, i) => unplaced({ line: i + 1 }));
  const b = renderReview(result({ unplaced: many }), auto).body;
  assert.equal((b.match(/^- `src\/b\.ts:/gm) ?? []).length, 25);
  assert.ok(b.includes('\n- \u2026and 5 more.\n'));
  assert.match(b, /30 could not be placed on the diff\. Human review: not needed \(highest score 0%\)\.$/);
});
test('the other lists are capped too', () => {
  const nr = Array.from({ length: 27 }, (_, i): NotReviewed => ({ path: `p${i}`, reason: 'no_diff' }));
  const b = renderReview(result({ findings: Array.from({ length: 26 }, (_, i) => finding({ line: i + 1 })), coverage: { reviewed: [], notReviewed: nr } }), auto).body;
  assert.ok(b.includes('- \u2026and 1 more.'));
  assert.ok(b.includes('- \u2026and 2 more.'));
  assert.equal(renderReview(result({ findings: Array.from({ length: 26 }, (_, i) => finding({ line: i + 1 })) }), auto).comments.length, 26);
});
test('renderReview returns a body within the limit', () => {
  const huge = result({ overview: 'x\n'.repeat(60_000), findings: [finding()] });
  const { body } = renderReview(huge, auto);
  assert.ok(body.length <= MAX_BODY_CHARS);
  assert.match(body, /cut to fit GitHub's limit\]_/);
  assert.match(body, /## Overall\n\n0 blocker, 1 major, 0 minor\. Human review: not needed \(highest score 0%\)\.$/);
});

const MARKER_RE = /^_\\\[\u2026 (\d+) characters of the review were cut to fit GitHub's limit\]_$/m;
const OVERALL = '## Overall\n\nNo findings.';
const UNPLACED = "## Findings not placed on the diff\n\nGitHub cannot show these inline.\n\n- `a.ts:9` \u2014 text";

test('a body within the limit is returned unchanged', () => {
  assert.equal(fitBody('## Summary\n\nshort', '', 100), '## Summary\n\nshort');
  assert.equal(fitBody('x'.repeat(100), '', 100), 'x'.repeat(100));
  assert.equal(fitBody('## Summary\n\nshort', OVERALL, 100), `## Summary\n\nshort\n\n${OVERALL}`);
  assert.equal(fitBody('', OVERALL, 100), OVERALL);
});
test('a body over the limit keeps its tail and says how much was cut', () => {
  const out = fitBody('## Summary\n\n' + 'x\n'.repeat(60_000), '## Overall\n\nNo findings.', 1_000);
  assert.ok(out.length <= 1_000);
  assert.match(out, /cut to fit GitHub's limit\]_\n\n## Overall\n\nNo findings\.$/);
});
test('the tail is kept whole after the cut, and the count is exact', () => {
  const head = '## Summary\n\n' + 'x\n'.repeat(2_000) + '\n';
  const tail = `${UNPLACED}\n\n## Coverage\n\nc\n\n${OVERALL}`;
  const out = fitBody(head, tail, 1_000);
  assert.ok(out.length <= 1_000);
  assert.ok(out.endsWith(`\n\n${tail}`));
  const m = out.match(MARKER_RE)!;
  const kept = out.slice(0, m.index).replace(/\n+$/, '');
  assert.ok(head.startsWith(kept));
  assert.match(head.slice(kept.length), /^\s*\n/);
  assert.equal(Number(m[1]), head.length - kept.length);
});
test('a cut never splits an astral character', () => {
  for (const long of [`## Summary\n${'\u{1F600}'.repeat(40_000)}\n\n${OVERALL}`, `## Summary\n${'\u{1F600}'.repeat(40_000)}`]) {
    const out = fitBody(long, '', 1_001);
    assert.ok(out.length <= 1_001);
    assert.ok(out.isWellFormed());
  }
  const withTail = fitBody(`## Summary\n${'\u{1F600}'.repeat(40_000)}`, OVERALL, 1_001);
  assert.ok(withTail.isWellFormed());
  assert.match(withTail, MARKER_RE);
});
test('the count excludes the fence close it adds, and the fence is closed', () => {
  const head = '## Summary\n```ts\n' + 'x\n'.repeat(40_000);
  const long = `${head}\`\`\``;
  const out = fitBody(long, OVERALL, 1_000);
  assert.ok(out.length <= 1_000);
  assert.ok(out.endsWith(`\n\n${OVERALL}`));
  const m = out.match(MARKER_RE)!;
  const before = out.slice(0, m.index).replace(/\n+$/, '');
  assert.ok(before.endsWith('\n```'));
  const kept = before.slice(0, -'\n```'.length);
  assert.ok(long.startsWith(kept));
  assert.equal(Number(m[1]), long.length - kept.length);
  assert.equal((out.match(/^```/gm) ?? []).length % 2, 0);
});
test('a fence left open inside a list item is closed at the same indent', () => {
  const out = fitBody('## Summary\n- item\n  ```ts\n' + '  x\n'.repeat(40_000) + '  ```', OVERALL, 1_000);
  const lines = out.split('\n');
  const at = lines.findIndex((l) => MARKER_RE.test(l));
  assert.ok(at > 1);
  assert.equal(lines[at - 1], '');
  assert.equal(lines[at - 2], '  ```');
});
test('a tail that fits but leaves no room for the head is kept behind the marker, or alone', () => {
  const tail = `## Overall\n\n${'v'.repeat(1_000 - 12 - 90)}`;
  const out = fitBody(`## Summary\n${'h\n'.repeat(500)}`, tail, 1_000);
  assert.ok(out.length <= 1_000);
  assert.ok(out.endsWith(tail));
  const exact = `## Overall\n\n${'v'.repeat(1_000 - 12)}`;
  assert.equal(fitBody(`## Summary\n${'h\n'.repeat(500)}`, exact, 1_000), exact);
});
test('a tail over the limit is cut from the end, with the marker', () => {
  const out = fitBody('## Summary\nshort', `## Overall\n\n${'z'.repeat(5_000)}`, 1_000);
  assert.ok(out.length <= 1_000);
  assert.match(out, /^## Summary\nshort\n/);
  assert.match(out, /cut to fit GitHub's limit\]_$/);
});
test('a body with no tail is cut from the end, and never split mid-pair', () => {
  for (const long of [`## Summary\n${'x'.repeat(5_000)}`, `## Summary\n${'\u{1F600}'.repeat(5_000)}`]) {
    const out = fitBody(long, '', 1_000);
    assert.ok(out.length <= 1_000);
    assert.ok(out.isWellFormed());
    assert.match(out, MARKER_RE);
  }
});
test('the default limit is 65,536', () => {
  assert.equal(MAX_BODY_CHARS, 65_536);
  const out = fitBody('a\n'.repeat(40_000), '');
  assert.ok(out.length <= 65_536);
  assert.equal(fitBody('a'.repeat(65_536), '').length, 65_536);
});

test('a failed review renders only its Overall line, after the manual prefix', () => {
  const failed = result({ status: 'failed', failure: { stage: 'model', code: 'no_credit' }, overview: 'x', findings: [finding()], unplaced: [unplaced()] });
  assert.deepEqual(renderReview(failed, auto), { body: '## Overall\n\nThe review could not be completed (model: no_credit).\n\nHuman review: needed, because the review did not finish.', comments: [] });
  const manual = renderReview(failed, { trigger: 'manual', requestedBy: 'dev-one', lineUrl: null, inline: true });
  assert.equal(manual.body, '**Full review** requested by @dev-one.\n\n## Overall\n\nThe review could not be completed (model: no_credit).\n\nHuman review: needed, because the review did not finish.');
  assert.deepEqual(manual.comments, []);
});
test('an Overall line written by the model cannot move the cut', () => {
  const overview = `Intro.\n## Overall\n\nAll fine.\n${'w\n'.repeat(40_000)}`;
  const plain = renderReview(result({ overview, findings: [finding()] }), auto).body;
  assert.ok(plain.length <= MAX_BODY_CHARS);
  assert.match(plain, /cut to fit GitHub's limit\]_\n\n## Overall\n\n0 blocker, 1 major, 0 minor\. Human review: not needed \(highest score 0%\)\.$/);
  const withUnplaced = renderReview(result({ overview, findings: [finding()], unplaced: [unplaced()] }), auto).body;
  assert.ok(withUnplaced.length <= MAX_BODY_CHARS);
  assert.ok(withUnplaced.includes('## Findings not placed on the diff\n'));
  assert.ok(withUnplaced.includes('\n- `src/b.ts:4` \u2014 Name is unclear.\n'));
  assert.match(withUnplaced, /\n## Overall\n\n0 blocker, 1 major, 0 minor\. 1 could not be placed on the diff\. Human review: not needed \(highest score 0%\)\.$/);
});
test('an HTML comment opener written by the model is neutralised', () => {
  const r = renderReview(result({ overview: 'See <!-- hidden -->.', findings: [finding({ body: 'Bad <!-- x' })], beyondDiff: [beyond({ body: 'Also <!-- y' })] }), auto);
  assert.equal(r.body.includes('<!--'), false);
  assert.ok(r.body.includes(`See <${ZW}!-- hidden -->.`));
  assert.ok(r.body.includes(`Bad <${ZW}!-- x`));
  assert.ok(r.body.includes(`Also <${ZW}!-- y`));
  assert.equal(r.comments[0]!.body, `**\\[major]**\n\nBad <${ZW}!-- x`);
});
test('a heading line in the overview is escaped', () => {
  const b = renderReview(result({ overview: 'Text.\n## Overall\n   # Title\n    # code\nnot # a heading' }), auto).body;
  assert.ok(b.includes('## Summary\n\nText.\n\\## Overall\n   \\# Title\n    # code\nnot # a heading\n\n## Human review\n\nNothing here is at or above 70%. The highest score is 0%.\n\n## Overall\n\nNo findings. Human review: not needed (highest score 0%).'));
  assert.equal((b.match(/^## Overall$/gm) ?? []).length, 1);
});
test('a path with a newline or a tab stays on its bullet line', () => {
  const b = renderReview(result({ beyondDiff: [beyond({ path: 'src/c.ts\n## Overall\tx' })], unplaced: [unplaced({ path: 'src/b\r\n.ts' })] }), auto).body;
  assert.ok(b.includes('- **\\[minor]** `src/c.ts ## Overall x:7` \u2014 Caller ignores the error.\n'));
  assert.ok(b.includes('- `src/b  .ts:4` \u2014 Name is unclear.\n'));
  assert.equal((b.match(/^## Overall$/gm) ?? []).length, 1);
});

const lineUrl = (f: { path: string }, s: Span): string => 'u:' + f.path + ':' + s.first;
const withUrl = { trigger: 'automatic', requestedBy: null, lineUrl, inline: true } as const;
const span = (first: number, last: number, side: Span['side'] = 'RIGHT'): Span => ({ side, first, last });
const block = (id: string, s: Span, score: number | null, category: Category = 'calculation', reason = ''): BlockScore => ({
  id, hunk: id, hunkHash: 'h', hash: 'h', changedLines: s.last - s.first + 1, span: s,
  lines: { old: [], new: [] } as unknown as BlockScore['lines'],
  entry: score === null ? null : { score, category, reason },
});
const file = (path: string, over: Partial<FileScore> = {}): FileScore => {
  const blocks = over.blocks ?? [];
  const best = Math.max(0, over.fileLevel?.score ?? 0, ...blocks.map((b) => b.entry?.score ?? 0));
  return { path, previousPath: null, diffHash: 'd', changeSummary: '', changedLines: 1, blocks, wholeFile: null, fileLevel: null, finalScore: best, covered: true, ...over };
};
const level = (score: number, source: FileLevelSource): FileScore['fileLevel'] => ({ score, source });
const verdictOf = (scores: FileScore[], threshold = 70) => {
  const highest = Math.max(0, ...scores.map((f) => f.finalScore));
  return { threshold, needsHuman: highest >= threshold, highest };
};
const scored = (scores: FileScore[], threshold = 70): ReviewResult => result({ scores, verdict: verdictOf(scores, threshold) });
const section = (body: string): string => /## Human review\n\n([\s\S]*?)(?=\n\n## |$)/.exec(body)![1]!;
const noted = (over: Partial<BlockScore>): string =>
  section(renderReview(scored([file('src/a.ts', { blocks: [{ ...block('B1', span(5, 6), 85, 'calculation', 'Changes tax.'), ...over }] })]), withUrl).body).split('\n').pop()!;
test('a block kept from an earlier review says so', () => {
  assert.equal(noted({ origin: 'earlier_run' }), '- [lines 5-6](u:src/a.ts:5), 85% `calculation` \u2014 Changes tax. _(kept from an earlier review)_');
});
test('a block scored on another pull request says so, with its category and without its reason', () => {
  assert.equal(noted({ origin: 'other_pull_request' }), '- [lines 5-6](u:src/a.ts:5), 85% `calculation` _(scored on another pull request)_');
});
test('a reason written on another pull request, links and all, is not shown', () => {
  const linked = { ...block('B1', span(5, 6), 85, 'calculation', 'See [the docs](https://example.test/x) and ![x](https://example.test/i.png).'), origin: 'other_pull_request' as const };
  const body = renderReview(scored([file('src/a.ts', { blocks: [linked] })]), withUrl).body;
  assert.ok(!body.includes('example.test'));
  assert.ok(!body.includes('the docs'));
  const kept = renderReview(scored([file('src/a.ts', { blocks: [{ ...linked, origin: 'earlier_run' }] })]), withUrl).body;
  assert.ok(kept.includes('See [the docs]'));
});
test('a raised block says what was given and what a lost block had scored', () => {
  assert.equal(noted({ raisedFrom: 60 }), '- [lines 5-6](u:src/a.ts:5), 85% `calculation` \u2014 Changes tax. _(60% was given; a block this file lost had scored 85%)_');
});
test('a kept block that was raised gets the raised note only', () => {
  assert.equal(noted({ origin: 'earlier_run', raisedFrom: 60 }), '- [lines 5-6](u:src/a.ts:5), 85% `calculation` \u2014 Changes tax. _(60% was given; a block this file lost had scored 85%)_');
});
test('a block with none of the fields is written as before', () => {
  assert.equal(noted({}), '- [lines 5-6](u:src/a.ts:5), 85% `calculation` \u2014 Changes tax.');
});

test('nothing at or above the threshold is one line', () => {
  const r = scored([file('src/a.ts', { blocks: [block('B1', span(1, 2), 45)] })]);
  const b = renderReview(r, withUrl).body;
  assert.ok(b.includes('## Human review\n\nNothing here is at or above 70%. The highest score is 45%.\n\n## Overall'));
});
test('the section lists what a person should read', () => {
  const r = scored([
    file('db/migrate/20260101_add_plan.rb', { fileLevel: level(100, 'team_floor') }),
    file('src/billing/invoice.ts', {
      blocks: [block('B1', span(85, 90), 40, 'refactor', 'Moves code.'), block('B2', span(12, 14, 'LEFT'), 72, 'business_rule', 'Removes the refund limit.'), block('B3', span(40, 58), 85, 'calculation', 'Changes how tax is rounded.')],
    }),
  ]);
  const b = renderReview(r, { ...withUrl }).body;
  assert.equal(section(b), [
    'A person should read these parts. Each is at or above 70%.',
    '',
    '**`db/migrate/20260101_add_plan.rb`**',
    '- whole file, 100% \u2014 a path the team marked as always needing a person',
    '',
    '**`src/billing/invoice.ts`**',
    '- [lines 40-58](u:src/billing/invoice.ts:40), 85% `calculation` \u2014 Changes how tax is rounded.',
    '- [old lines 12-14](u:src/billing/invoice.ts:12), 72% `business_rule` \u2014 Removes the refund limit.',
  ].join('\n'));
});
test('the section sits between Summary and Findings', () => {
  const b = renderReview(scored([file('src/a.ts', { blocks: [block('B1', span(1, 1), 90)] })]), { ...withUrl }).body;
  const order = ['## Summary', '## Human review'].map((h) => b.indexOf(h + '\n'));
  assert.ok(order[0]! >= 0 && order[0]! < order[1]!);
  const withFinding = renderReview({ ...scored([file('src/a.ts', { blocks: [block('B1', span(1, 1), 90)] })]), findings: [finding()] }, withUrl).body;
  assert.ok(withFinding.indexOf('## Human review') < withFinding.indexOf('## Findings\n'));
});
test('files are ordered by final score, then path', () => {
  const r = scored([
    file('b.ts', { blocks: [block('B1', span(1, 1), 80)] }),
    file('c.ts', { blocks: [block('B1', span(1, 1), 95)] }),
    file('a.ts', { blocks: [block('B1', span(1, 1), 80)] }),
  ]);
  const heads = section(renderReview(r, auto).body).split('\n').filter((l) => l.startsWith('**'));
  assert.deepEqual(heads, ['**`c.ts`**', '**`a.ts`**', '**`b.ts`**']);
});
test('blocks are ordered by score, then by position in the diff', () => {
  const r = scored([file('a.ts', { blocks: [block('B1', span(1, 1), 75), block('B2', span(5, 5), 90), block('B3', span(9, 9), 75)] })]);
  const lines = section(renderReview(r, auto).body).split('\n').filter((l) => l.startsWith('- '));
  assert.deepEqual(lines.map((l) => l.split(' `')[0]), ['- line 5, 90%', '- line 1, 75%', '- line 9, 75%']);
});
test('a file flagged as a whole gets its whole file line first, then its blocks', () => {
  const r = scored([file('a.ts', { fileLevel: level(100, 'not_scored'), blocks: [block('B1', span(2, 3), 80, 'fix', 'Fixes it.'), block('B2', span(9, 9), 20)] })]);
  const lines = section(renderReview(r, auto).body).split('\n').filter((l) => l.startsWith('- '));
  assert.deepEqual(lines, ['- whole file, 100% \u2014 not read, or left without a score', '- lines 2-3, 80% `fix` \u2014 Fixes it.']);
});
test('every whole-file source has its text', () => {
  const text: Record<string, string> = {
    builtin_floor: "it changes the reviewer's own file, code owners or CI",
    team_floor: 'a path the team marked as always needing a person',
    team_file_invalid: "the repository's .visto-ai.yml cannot be used (not_yaml), so every file needs a person",
    not_scored: 'not read, or left without a score',
    hidden_characters: 'a changed line holds invisible or direction-changing characters',
    rule_rename: 'scored by rule',
    rule_asset: 'scored by rule',
  };
  for (const [source, expected] of Object.entries(text)) {
    const r = { ...scored([file('a.ts', { fileLevel: level(100, source as FileLevelSource) })]), teamFileInvalid: 'not_yaml' };
    assert.ok(section(renderReview(r, auto).body).includes(`- whole file, 100% \u2014 ${expected}`), source);
  }
});
test('a whole-file score from the model shows its category and reason', () => {
  const r = scored([file('a.ts', { fileLevel: level(88, 'whole_file'), wholeFile: { score: 88, category: 'permission', reason: 'Widens access.' } })]);
  assert.ok(section(renderReview(r, auto).body).includes('- whole file, 88% `permission` \u2014 Widens access.'));
});
test('an unusable repository file is named, with the reason', () => {
  const r = { ...scored([file('a.ts', { fileLevel: level(100, 'team_file_invalid') })]), teamFileInvalid: 'bad_patterns' };
  assert.ok(renderReview(r, auto).body.includes("- whole file, 100% \u2014 the repository's .visto-ai.yml cannot be used (bad_patterns), so every file needs a person"));
});
test('without a link builder the label is plain text', () => {
  const r = scored([file('a.ts', { blocks: [block('B1', span(40, 58), 85, 'calculation', 'Changes tax.')] })]);
  assert.ok(section(renderReview(r, auto).body).includes('\n- lines 40-58, 85% `calculation` \u2014 Changes tax.'));
});
test('a block below 40 at a low threshold shows its category and no reason', () => {
  const r = scored([file('a.ts', { blocks: [block('B1', span(7, 7), 25, 'rename')] })], 20);
  const b = renderReview(r, auto).body;
  assert.ok(section(b).includes('Each is at or above 20%.'));
  assert.ok(section(b).endsWith('\n- line 7, 25% `rename`'));
});
test('the list stops at 50 entries', () => {
  const blocks = Array.from({ length: 60 }, (_, i) => block(`B${i + 1}`, span(i + 1, i + 1), 80));
  const lines = section(renderReview(scored([file('a.ts', { blocks })]), auto).body).split('\n');
  assert.equal(lines.filter((l) => l.startsWith('- ')).length, 51);
  assert.equal(lines.at(-1), '- \u2026and 10 more.');
  assert.equal(lines.at(-2), '- line 50, 80% `calculation`');
});
test('heading lines do not count toward the 50 entries, and a file with nothing written has no heading', () => {
  const a = file('a.ts', { blocks: Array.from({ length: 50 }, (_, i) => block(`B${i + 1}`, span(i + 1, i + 1), 90)) });
  const c = file('c.ts', { blocks: [block('B1', span(1, 1), 80), block('B2', span(2, 2), 80)] });
  const text = section(renderReview(scored([a, c]), auto).body);
  assert.equal(text.includes('c.ts'), false);
  assert.ok(text.endsWith('\n- \u2026and 2 more.'));
});
test('Overall says whether a person is needed', () => {
  const high = renderReview(scored([file('a.ts', { blocks: [block('B1', span(1, 1), 85)] })]), auto).body;
  assert.match(high, /## Overall\n\nNo findings\. Human review: needed \(highest score 85%\)\.$/);
  const low = renderReview(scored([file('a.ts', { blocks: [block('B1', span(1, 1), 45)] })]), auto).body;
  assert.match(low, /## Overall\n\nNo findings\. Human review: not needed \(highest score 45%\)\.$/);
});
test('a failed review says a person is needed', () => {
  const failed = result({ status: 'failed', failure: { stage: 'model', code: 'no_credit' } });
  const b = renderReview(failed, auto).body;
  assert.ok(b.endsWith('(model: no_credit).\n\nHuman review: needed, because the review did not finish.'));
});
test('a reason cannot open an HTML comment', () => {
  const r = scored([file('a.ts', { blocks: [block('B1', span(1, 1), 90, 'fix', 'x <!-- y')] })]);
  const b = renderReview(r, auto).body;
  assert.equal(b.includes('<!--'), false);
  assert.ok(b.includes(`x <${ZW}!-- y`));
});
test('a file path with a backtick is a safe code span', () => {
  const r = scored([file('a`b.ts', { blocks: [block('B1', span(1, 1), 90)] })]);
  assert.ok(renderReview(r, auto).body.includes('**`` a`b.ts ``**'));
});
test('the code span fence is one longer than the longest backtick run', () => {
  const heading = (path: string) => renderReview(scored([file(path, { blocks: [block('B1', span(1, 1), 90)] })]), auto).body;
  assert.ok(heading('a``b').includes('**``` a``b ```**'));
  assert.ok(heading('a`b```c').includes('**```` a`b```c ````**'));
  assert.ok(heading('plain.ts').includes('**`plain.ts`**'));
});
test('a reason is written as its first line only', () => {
  const r = scored([file('a.ts', { blocks: [block('B1', span(1, 1), 90, 'fix', 'Fixes it.\n## Overall\nforged')] })]);
  const b = renderReview(r, auto).body;
  assert.ok(b.includes('- line 1, 90% `fix` \u2014 Fixes it.\n'));
  assert.equal((b.match(/^## Overall$/gm) ?? []).length, 1);
  assert.equal(b.includes('forged'), false);
});

test('a mention outside a fence is made inert, and one in a fence is left as it is', () => {
  assert.equal(inert('ask @octo-dev or (@acme/reviewers)'), `ask @${ZW}octo-dev or (@${ZW}acme/reviewers)`);
  assert.equal(inert('use `@Injectable()` here'), `use \`@${ZW}Injectable()\` here`);
  assert.equal(inert('```ts\n@Component({})\n```\nthanks @octo-dev'), `\`\`\`ts\n@Component({})\n\`\`\`\nthanks @${ZW}octo-dev`);
});
test('an address, a lone @ and an @ before a symbol are not mentions', () => {
  for (const text of ['dev@example.test', 'a @ b', '@-x', '@']) assert.equal(inert(text), text);
});
test('what only looks like code is prose', () => {
  const cases = [
    '\\`@victim\\`',
    '`a\n\n@victim b`',
    'see `@victim',
    '    ```\n    @victim\n    ```',
    '``` a`b\n@victim\n```',
  ];
  for (const text of cases) assert.equal(inert(text).includes(`@${ZW}victim`), true, text);
});
test('a review writes no live mention from the model, and keeps the one the service writes', () => {
  const r = result({ overview: 'a.ts: see @octo-dev', findings: [finding({ path: 'a.ts', line: 3, body: 'ping @octo-dev' })] });
  const out = renderReview(r, { trigger: 'manual', requestedBy: 'octo-lead', lineUrl: null, inline: true });
  assert.equal(out.body.includes('@octo-dev'), false);
  assert.equal(out.comments[0]!.body.includes('@octo-dev'), false);
  assert.equal(out.body.includes('requested by @octo-lead'), true);
});
test('a first line cut out of a span is prose', () => {
  const r = result({ findings: [finding({ path: 'a.ts', line: 3, body: '`@victim\nrest`' })] });
  const out = renderReview(r, { trigger: 'automatic', requestedBy: null, lineUrl: null, inline: true });
  assert.equal(out.body.includes('@victim'), false);
  assert.equal(out.body.includes(`@${ZW}victim`), true);
});
test('without inline comments, every finding carries its whole text in the body and cannot forge a heading', () => {
  const many = Array.from({ length: 30 }, (_, i) => finding({ path: 'a.ts', line: i + 1, body: `Finding ${i + 1}.\n\n## Overall\n\nDetail ${i + 1}.` }));
  const r = result({ findings: many });
  const inline = renderReview(r, { trigger: 'automatic', requestedBy: null, lineUrl: null, inline: true });
  const bodyOnly = renderReview(r, { trigger: 'automatic', requestedBy: null, lineUrl: null, inline: false });
  assert.deepEqual([inline.comments.length, bodyOnly.comments.length], [30, 0]);
  assert.equal(inline.body.includes('Detail 1.'), false);
  assert.equal(bodyOnly.body.includes('Detail 1.') && bodyOnly.body.includes('Detail 30.'), true);
  assert.equal(bodyOnly.body.match(/^## Overall$/gm)?.length, 1);
});
test('a fence opened by the first line of a finding does not swallow the next bullet', () => {
  const b = renderReview(result({ findings: [finding({ body: '```ts' }), finding({ line: 11, body: 'Next @octo-dev' })] }), auto).body;
  assert.equal(b.includes('```'), true);
  assert.equal(b.includes('@octo-dev'), false);
  assert.equal(/^```/m.test(b), false);
});
test('a score reason and the whole-file reason are made inert too', () => {
  const r = scored([file('a.ts', { blocks: [block('B1', span(1, 1), 90, 'fix', 'ask @octo-dev <b>')] })]);
  const b = renderReview(r, auto).body;
  assert.equal(b.includes('@octo-dev'), false);
  assert.ok(b.includes(`ask @${ZW}octo-dev <${ZW}b>`));
  const whole = scored([file('a.ts', { fileLevel: level(90, 'whole_file'), wholeFile: { score: 90, category: 'permission', reason: 'ask @octo-dev <b>' } })]);
  const w = renderReview(whole, auto).body;
  assert.equal(w.includes('@octo-dev'), false);
  assert.ok(w.includes(`- whole file, 90% \`permission\` \u2014 ask @${ZW}octo-dev <${ZW}b>`));
});

test('a fence is honoured only where it is certainly one', () => {
  assert.equal(inert('```\nx\n```\t\n@victim'), `\`\`\`\nx\n\`\`\`\t\n@${ZW}victim`);
  assert.equal(inert('```\nx\n   ```\n@victim'), `\`\`\`\nx\n\`\`\`\n@${ZW}victim`);
});
test("an inline comment keeps the model's text off the service's own line", () => {
  const out = renderReview(result({ findings: [finding({ path: 'a.ts', line: 3, severity: 'minor', body: '~~~\n@victim\n~~~' })] }), auto);
  assert.equal(out.comments[0]!.body, '**\\[minor]**\n\n~~~\n@victim\n~~~');
  const uneven = result({ findings: [finding({ path: 'a.ts', line: 3, severity: 'minor', body: '```\n@victim\n````\nafter @victim' })] });
  assert.equal(renderReview(uneven, auto).comments[0]!.body, '**\\[minor]**\n\n```\n@victim\n````\nafter @' + ZW + 'victim');
});
test('the body-only form carries the note about a moved line', () => {
  const r = result({ findings: [finding({ path: 'a.ts', line: 3, body: 'Detail.', requestedLine: 5 })] });
  const out = renderReview(r, { trigger: 'automatic', requestedBy: null, lineUrl: null, inline: false });
  assert.equal(out.body.includes('Refers to line 5, just outside the diff.'), true);
});

test('an indented fence is moved to the first column, where it is the same fence to GitHub as to the service', () => {
  assert.equal(inert('intro\n  ```\nx @victim'), 'intro\n```\nx @victim\n```');
  assert.equal(inert('   ~~~ts\ncode\n   ~~~\nafter @victim'), `~~~ts\ncode\n~~~\nafter @${ZW}victim`);
  assert.equal(inert('a\n\n    ```\n@victim'), `a\n\n    \`\`\`\n@${ZW}victim`);
  assert.equal(inert('- ```\n  x\n  ```\n\n@victim'), '- ```\n  x\n```\n\n@victim\n```');
});
test('a fence the summary leaves open cannot swallow the sections after it', () => {
  const body = renderReview(result({ overview: 'intro\n  ```\nx' }), auto).body;
  assert.equal(body.includes('intro\n```\nx\n```\n\n## '), true);
});
test('a line of = or - under a line of text makes no heading, and a fence is left as it is', () => {
  const text = 'Overall\n---\nfine\n\nTitle\n ===\n\n---\n\n```yaml\na: 1\n---\n# c\n```';
  const body = renderReview(result({ overview: text }), auto).body;
  assert.equal(body.includes('Overall\n\\---\nfine\n\nTitle\n \\===\n\n---\n\n```yaml\na: 1\n---\n# c\n```'), true);
  const bodyOnly = renderReview(result({ findings: [finding({ body: 'Overall\n---' })] }), { ...auto, inline: false }).body;
  assert.equal(bodyOnly.includes('  Overall\n  \\---'), true);
});
test('a cut inside a fence that came from an indented line closes it before the cut marker', () => {
  const overview = `- \`\`\`\n  x\n  \`\`\`\n\n${'word word\n'.repeat(10_000)}`;
  const body = renderReview(result({ overview }), auto).body;
  const kept = body.slice(0, body.indexOf('\n\n_\\['));
  assert.equal(kept.endsWith('\n```'), true);
  assert.equal(kept.split('\n').filter((line) => line === '```').length, 2);
});

test('outside a fence nothing is treated as code', () => {
  const live = (text: string): boolean => /(^|[^A-Za-z0-9])@[A-Za-z0-9]/.test(inert(text)) || /<[A-Za-z\/!?]/.test(inert(text));
  for (const text of [
    '`@victim`', '\\`` x `@victim`', 'x `a\n` @victim `y`', '| `a | @victim` |', '`a\r\r@victim\r\r`', '\u00e9@victim',
    '[a](`) @victim `', '[a](/u "`") @victim <b> `', '[`]: /u\n\n[a][`] @victim `',
    'see https://x.co/` @victim `', 'www.x.co/` @victim <img src=x> `',
    '_x_@victim', 'x_@victim', '**a**@victim', '\\@victim',
  ]) assert.equal(live(text), false, JSON.stringify(text));
  assert.equal(inert('use `@Injectable()` here'), `use \`@${ZW}Injectable()\` here`);
  for (const text of ['dev@example.test', 'a1@b', 'a @ b', '@-x', '@']) assert.equal(inert(text), text);
});
test('raw HTML and character references are shown as typed, by a character that cannot be seen', () => {
  assert.equal(inert('<details><summary>x</summary>'), `<${ZW}details><${ZW}summary>x<${ZW}/summary>`);
  assert.equal(inert('a <!-- b, <?php and <!DOCTYPE'), `a <${ZW}!-- b, <${ZW}?php and <${ZW}!DOCTYPE`);
  assert.equal(inert('use `Array<string>` here: a < b, x <= y, 1 <2, <-'), `use \`Array<${ZW}string>\` here: a < b, x <= y, 1 <2, <-`);
  assert.equal(inert('ping &#64;octo-dev, &#x40;octo-dev and &commat;octo-lead'), `ping &${ZW}#64;octo-dev, &${ZW}#x40;octo-dev and &${ZW}commat;octo-lead`);
  assert.equal(inert('a && b, R&D, &mut x, &#12345678; and a&b;c'), `a && b, R&D, &mut x, &#12345678; and a&${ZW}b;c`);
  assert.equal(inert('```ts\nconst a: Array<string> = []; // &amp; @x'), '```ts\nconst a: Array<string> = []; // &amp; @x\n```');
});
test('a tab before a fence line means the same under a bullet as at the top level', () => {
  assert.equal(inert('```\n\t```\n@victim\n```'), '```\n    ```\n@victim\n```');
  assert.equal(inert('~~~\n \t~~~~\nx'), '~~~\n    ~~~~\nx\n~~~');
  assert.equal(inert('```make\nall:\n\tcc x.c\n```'), '```make\nall:\n\tcc x.c\n```');
  assert.equal(inert('\t```\n```\n@victim <img src=x>\n\t```'), '    ```\n```\n@victim <img src=x>\n    ```\n```');
  assert.equal(inert('a\n\tb\n  \tc\td'), 'a\n    b\n    c\td');
  const bodyOnly = renderReview(result({ findings: [finding({ body: 'Overall\n\t---\n\n\t## Overall' })] }), { ...auto, inline: false }).body;
  assert.equal(bodyOnly.includes('  Overall\n      ---\n\n      ## Overall'), true);
});
test('a closing fence is written at the first column too', () => {
  assert.equal(inert('```\nx\n  ```  \nafter @victim'), `\`\`\`\nx\n\`\`\`  \nafter @${ZW}victim`);
});
test('only spaces and tabs make a line blank', () => {
  const body = (text: string): string => renderReview(result({ overview: text }), auto).body;
  for (const gap of ['\u00a0', '\u3000', '\ufeff', '\u2003', '\v', '\f']) assert.equal(body(`Title\n${gap}\n---`).includes(`${gap}\n\\---`), true, JSON.stringify(gap));
  for (const gap of ['', ' ', '\t', ' \t ']) assert.equal(body(`Title\n${gap}\n---\n\nend`).includes('\n---\n\nend'), true, JSON.stringify(gap));
  assert.equal(body('a\n\n```\nx\n```\n---\nb').includes('```\nx\n```\n---\nb'), true);
});
test('a line separator in a fence line does not hide the fence', () => {
  for (const sep of ['\u2028', '\u2029']) {
    // the first line opens a fence, the second closes it, and what follows is prose
    assert.equal(inert(`\`\`\`${sep}x\n\`\`\`\n@victim <img src=x> &#64;octo`), `\`\`\`${sep}x\n\`\`\`\n@${ZW}victim <${ZW}img src=x> &${ZW}#64;octo`, JSON.stringify(sep));
    assert.equal(inert(`~~~${sep}\n~~~\n@victim`), `~~~${sep}\n~~~\n@${ZW}victim`, JSON.stringify(sep));
    // a backtick after the separator: no fence opens, since the rest of a backtick fence's line holds no backtick
    assert.equal(inert(`\`\`\`${sep}\`\n@victim`), `\`\`\`${sep}\`\n@${ZW}victim`, JSON.stringify(sep));
    // the summary's sections are not swallowed and no heading is forged
    const body = renderReview(result({ overview: `\`\`\`${sep}\n\`\`\`\nOverall\n---` }), auto).body;
    assert.equal(body.includes(`\`\`\`${sep}\n\`\`\`\nOverall\n\\---\n\n## `), true, JSON.stringify(sep));
  }
});

test('what is rendered holds no NUL and no lone surrogate, so storing it changes nothing', () => {
  const NUL = String.fromCharCode(0);
  const HALF = String.fromCharCode(0xd800);
  const text = [`see @${NUL}victim and <${NUL}!-- hidden and &${NUL}#64;victim`, `\`\`${NUL}\``, '@victim', `${NUL}## Overall`, `end ${HALF}`].join('\n');
  const out = renderReview(result({ overview: text, findings: [finding({ body: text })] }), auto);
  // what storing would have made of it: every NUL deleted
  const stored = (t: string): string => t.replaceAll(NUL, '');
  for (const t of [out.body, ...out.comments.map((c) => c.body)]) {
    assert.equal(t.includes(NUL), false);
    assert.equal(stored(t), t);
    assert.equal(t.isWellFormed(), true);
    for (const s of [t, stored(t)]) {
      assert.equal(/@[A-Za-z]/.test(s), false, JSON.stringify(s));
      assert.equal(/&#64;/.test(s), false, JSON.stringify(s));
      assert.equal(s.includes('<!--'), false, JSON.stringify(s));
    }
  }
  for (const s of [out.body, stored(out.body)]) assert.equal((s.match(/^## Overall/gm) ?? []).length, 1);
  for (const s of out.comments.map((c) => c.body)) assert.equal(/^## Overall/m.test(stored(s)), false);
});
test("the service's own tags are written with an escaped bracket, so a definition the model wrote cannot make them links", () => {
  const out = renderReview(result({ overview: '[major]: https://example.test/x', findings: [finding({ body: 'A note.\n\n[major]: https://example.test/x' })] }), auto);
  for (const t of [out.body, out.comments[0]!.body]) {
    assert.equal(t.includes('**\\[major]**'), true);
    assert.equal(t.includes('**[major]**'), false);
  }
});
test('a heading inside a quote or a list item is escaped, and indentation alone escapes nothing', () => {
  // the overview is trimmed: a first paragraph keeps the text's own indentation
  const summary = (text: string): string => /## Summary\n\nIntro\.\n\n([\s\S]*?)\n\n## Human review/.exec(renderReview(result({ overview: `Intro.\n\n${text}` }), auto).body)![1]!;
  assert.equal(summary('> ## Overall'), '> \\## Overall');
  assert.equal(summary('- ## Overall'), '- \\## Overall');
  assert.equal(summary('1. # x'), '1. \\# x');
  assert.equal(summary('> > - # x'), '> > - \\# x');
  assert.equal(summary('> Overall\n> ---'), '> Overall\n> \\---');
  for (const text of ['    # code', '- item #12', '>= 3 # x']) {
    assert.equal(summary(text), text);
    assert.equal(summary(`\`\`\`\n${text}\n\`\`\``), `\`\`\`\n${text}\n\`\`\``);
  }
  for (const text of ['> ## Overall', '- ## Overall', '1. # x', '> > - # x', '> Overall\n> ---']) assert.equal(summary(`\`\`\`\n${text}\n\`\`\``), `\`\`\`\n${text}\n\`\`\``);
});
test('an address keeps working: its @ is written %40, and a link in angle brackets stays one', () => {
  assert.equal(inert('see https://www.npmjs.com/package/@types/node and [x](https://example.test/packages/@scope/x)'),
    'see https://www.npmjs.com/package/%40types/node and [x](https://example.test/packages/%40scope/x)');
  // before the ://, and where there is none, the rule is as it was
  assert.equal(inert('[@types/node](https://example.test/@types/node) @octo-dev packages/@scope/x'),
    `[@${ZW}types/node](https://example.test/%40types/node) @${ZW}octo-dev packages/@${ZW}scope/x`);
  // an @ after a letter or digit is left as it is, in an address too
  assert.equal(inert('ssh://git@example.test/x https://example.test/a@b'), 'ssh://git@example.test/x https://example.test/a@b');
  // white space ends the run
  assert.equal(inert('https://example.test/ @victim'), `https://example.test/ @${ZW}victim`);
  assert.equal(inert('<https://example.test/@x> <http://example.test/x> <ftp://example.test/x> <httpx>'),
    `<https://example.test/%40x> <http://example.test/x> <${ZW}ftp://example.test/x> <${ZW}httpx>`);
  const live = (text: string): boolean => /@[A-Za-z0-9]/.test(inert(text).replace(/[A-Za-z0-9]@/g, ''));
  for (const text of ['://@victim', 'x://@victim', 'https://@victim', '(https://example.test/)@victim', 'a://b\t@victim', '://x@@victim'])
    assert.equal(live(text), false, JSON.stringify(text));
});

const discussed = (over: Partial<Discussed> = {}): Discussed => ({
  path: 'src/a.ts', side: 'RIGHT', line: 14, severity: 'major', body: 'The total is never checked.', commentId: '9001', resolved: false, settled: false, ...over,
});
const aThreadVerdict = (v: ThreadVerdict['verdict'], n: number): ThreadVerdict => ({ threadId: `PRRT_${n}`, commentId: String(9000 + n), verdict: v, reply: '', fileChanged: true });
const withLink = { ...auto, commentUrl: (id: string) => `https://git.example.test/c/${id}` } as const;

test('a finding an earlier thread raised is listed with a link to that thread, between the unplaced findings and what lies beyond the diff', () => {
  const r = result({ unplaced: [unplaced()], beyondDiff: [beyond()], alreadyDiscussed: [discussed()] });
  const b = renderReview(r, withLink).body;
  assert.ok(b.includes('## Already discussed\n\nThese were raised in an earlier review. They are not posted again.\n\n- **\\[major]** `src/a.ts:14`'));
  assert.ok(b.includes(' ([earlier thread](https://git.example.test/c/9001))'));
  const order = ['## Findings not placed on the diff', '## Already discussed', '## Beyond the diff', '## Overall'].map((h) => b.indexOf(h + '\n'));
  assert.ok(order.every((i) => i >= 0));
  assert.deepEqual(order, [...order].sort((x, y) => x - y));
  const bare = renderReview(result({ alreadyDiscussed: [discussed()] }), withLink).body;
  assert.ok(bare.indexOf('## Already discussed') < bare.indexOf('## Overall'));
});
test('without a link builder the entry is written with no link', () => {
  const b = renderReview(result({ alreadyDiscussed: [discussed()] }), auto).body;
  assert.ok(b.includes('- **\\[major]** `src/a.ts:14` \u2014 The total is never checked.\n'));
  assert.equal(b.includes('earlier thread'), false);
  assert.equal(renderReview(result({ alreadyDiscussed: [discussed()] }), { ...auto, commentUrl: null }).body.includes('earlier thread'), false);
});
test('Overall counts the earlier threads, and says "No new findings." when the only ones were already discussed', () => {
  const three = result({ threadsDue: 3, threadVerdicts: [aThreadVerdict('fixed', 1), aThreadVerdict('answered', 2), aThreadVerdict('open', 3)] });
  assert.ok(renderReview(three, auto).body.endsWith('Earlier threads: 2 cleared, 1 still open. Human review: not needed (highest score 0%).'));
  const part = result({ threadsDue: 3, threadVerdicts: [aThreadVerdict('fixed', 1)] });
  assert.ok(renderReview(part, auto).body.endsWith('Earlier threads: 1 cleared, 0 still open. 2 could not be judged. Human review: not needed (highest score 0%).'));
  assert.ok(renderReview(result({ alreadyDiscussed: [discussed()] }), auto).body.endsWith('No new findings. Human review: not needed (highest score 0%).'));
  assert.ok(renderReview(result(), auto).body.includes('No findings.'));
});
test('a result stored before threads were read renders as it did', () => {
  const old = result({ findings: [finding()] });
  const empty = renderReview({ ...old, threadVerdicts: [], threadsDue: 0, alreadyDiscussed: [] }, auto).body;
  assert.equal(renderReview(old, auto).body, empty);
  assert.equal(empty.includes('Already discussed'), false);
  assert.equal(empty.includes('Earlier threads'), false);
});

const manual = { trigger: 'manual', requestedBy: 'octo-dev', lineUrl: null, inline: true } as const;
const manualNoLogin = { trigger: 'manual', requestedBy: null, lineUrl: null, inline: true } as const;
const SINCE = '0123456789abcdef0123456789abcdef01234567';
const RECHECK_TAIL = 'code that was reviewed before was not reviewed again.';
const firstOf = (r: ReviewResult, m: Parameters<typeof renderReview>[1]): string => renderReview(r, m).body.split('\n')[0]!;

test('the first line of an incremental review and of a re-check', () => {
  const inc = result({ mode: 'incremental', since: SINCE });
  assert.equal(firstOf(inc, auto), '**Incremental review** of the changes since `0123456789ab`.');
  assert.equal(firstOf(inc, manual), '**Incremental review** requested by @octo-dev, of the changes since `0123456789ab`.');
  assert.equal(firstOf(inc, manualNoLogin), '**Incremental review** requested, of the changes since `0123456789ab`.');
  const re = result({ mode: 'recheck', threadsDue: 2, threadVerdicts: [aThreadVerdict('open', 1)] });
  assert.equal(firstOf(re, manual), `**Re-check** requested by @octo-dev. The earlier threads were judged again; ${RECHECK_TAIL}`);
  assert.equal(firstOf(re, manualNoLogin), `**Re-check** requested. The earlier threads were judged again; ${RECHECK_TAIL}`);
  assert.equal(firstOf(result({ mode: 'recheck' }), manual), `**Re-check** requested by @octo-dev. No earlier thread was waiting for a verdict; ${RECHECK_TAIL}`);
  assert.equal(firstOf(result({ mode: 'recheck', threadsDue: 0 }), manualNoLogin), `**Re-check** requested. No earlier thread was waiting for a verdict; ${RECHECK_TAIL}`);
  assert.equal(firstOf(result({ mode: 'full' }), manual), '**Full review** requested by @octo-dev.');
});
test('a re-check that owed verdicts and kept none says no earlier thread could be judged', () => {
  const none = result({ mode: 'recheck', threadsDue: 2, threadVerdicts: [] });
  assert.equal(firstOf(none, manual), `**Re-check** requested by @octo-dev. No earlier thread could be judged; ${RECHECK_TAIL}`);
  assert.equal(firstOf(none, manualNoLogin), `**Re-check** requested. No earlier thread could be judged; ${RECHECK_TAIL}`);
  assert.equal(firstOf({ ...none, threadVerdicts: undefined as unknown as [] }, manualNoLogin), `**Re-check** requested. No earlier thread could be judged; ${RECHECK_TAIL}`);
});
test('without a usable since the first line leaves out the changes it names', () => {
  assert.equal(firstOf(result({ mode: 'incremental' }), auto), '**Incremental review**.');
  assert.equal(firstOf(result({ mode: 'incremental' }), manual), '**Incremental review** requested by @octo-dev.');
  for (const since of ['abc123', 'A'.repeat(12), '0123456789ab`x', `${'a'.repeat(65)}`, '', '0123456789ab\n## x']) {
    const line = renderReview(result({ mode: 'incremental', since }), manualNoLogin).body.split('\n\n')[0]!;
    assert.equal(line, '**Incremental review** requested.');
  }
  assert.equal(firstOf(result({ mode: 'incremental', since: 'abcdef0' }), auto), '**Incremental review** of the changes since `abcdef0`.');
  assert.equal(firstOf(result({ mode: 'incremental', since: 5 as unknown as string }), auto), '**Incremental review**.');
});
test('a mode that is not one of the three reads as full', () => {
  const odd = result({ mode: 'weird' as unknown as 'full' });
  assert.equal(renderReview(odd, auto).body, renderReview(result(), auto).body);
  assert.equal(firstOf(odd, manual), '**Full review** requested by @octo-dev.');
  const gone = { ...result() } as Partial<ReviewResult>;
  delete gone.mode;
  assert.equal(renderReview(gone as ReviewResult, auto).body, renderReview(result(), auto).body);
});
test('a failed incremental review keeps the first line of its mode', () => {
  const failed = result({ status: 'failed', failure: { stage: 'model', code: 'no_credit' }, mode: 'incremental', since: SINCE });
  assert.equal(renderReview(failed, auto).body, '**Incremental review** of the changes since `0123456789ab`.\n\n## Overall\n\nThe review could not be completed (model: no_credit).\n\nHuman review: needed, because the review did not finish.');
});
test('the section for code unchanged since the last review stands after Findings and before the unplaced and the discussed ones', () => {
  const longBody = 'The total is never checked.\n\nSecond paragraph.\n\n## Not a heading';
  const r = result({
    mode: 'incremental', since: SINCE, unplaced: [unplaced()], alreadyDiscussed: [discussed()],
    unchanged: [finding({ line: 21, body: longBody })],
  });
  const b = renderReview(r, auto).body;
  const heading = '## On code unchanged since the last review';
  const order = [heading, '## Findings not placed on the diff', '## Already discussed', '## Overall'].map((h) => b.indexOf(`${h}\n`));
  assert.deepEqual(order, [...order].sort((x, y) => x - y));
  assert.ok(order.every((i) => i >= 0));
  assert.ok(b.includes(`${heading}\n\nThese are on lines that have not changed since the reviewer last read their file. They are not posted as comments and do not hold a merge.\n\n- **\\[major]** \`src/a.ts:21\` \u2014 The total is never checked.\n\n  The total is never checked.\n\n  Second paragraph.\n\n  \\## Not a heading\n\n## Findings not placed on the diff`));
  const withFinding = renderReview({ ...r, findings: [finding()] }, auto).body;
  assert.ok(withFinding.indexOf('## Findings\n') < withFinding.indexOf(heading));
  assert.ok(withFinding.indexOf(heading) < withFinding.indexOf('## Findings not placed on the diff'));
  // whole text, whatever meta.inline says
  assert.equal(renderReview(r, { ...auto, inline: false }).body, b);
  assert.deepEqual(renderReview(r, auto).comments, []);
});
test('the section stands before the discussed ones when nothing is unplaced, and is absent when empty or missing', () => {
  const r = result({ alreadyDiscussed: [discussed()], unchanged: [finding()], beyondDiff: [beyond()] });
  const b = renderReview(r, auto).body;
  assert.ok(b.indexOf('## On code unchanged') < b.indexOf('## Already discussed'));
  assert.ok(b.indexOf('## Already discussed') < b.indexOf('## Beyond the diff'));
  assert.equal(renderReview(result({ unchanged: [] }), auto).body, renderReview(result(), auto).body);
});
test('Overall opens with No findings, No new findings or the counts, and names the unchanged majors', () => {
  const end = ' Human review: not needed (highest score 0%).';
  assert.ok(renderReview(result(), auto).body.endsWith(`## Overall\n\nNo findings.${end}`));
  assert.ok(renderReview(result({ alreadyDiscussed: [discussed()] }), auto).body.endsWith(`No new findings.${end}`));
  const one = renderReview(result({ unchanged: [finding()] }), auto).body;
  assert.ok(one.endsWith(`## Overall\n\nNo new findings. 1 major on code unchanged since the last review.${end}`));
  const two = renderReview(result({ unchanged: [finding(), finding({ line: 2 })], coverage: { reviewed: [], notReviewed: notReviewed(1) } }), auto).body;
  assert.ok(two.endsWith(`No new findings. 2 major on code unchanged since the last review. 1 files were not reviewed.${end}`));
  const counts = renderReview(result({ findings: [finding()], unchanged: [finding()] }), auto).body;
  assert.ok(counts.endsWith(`0 blocker, 1 major, 0 minor. 1 major on code unchanged since the last review.${end}`));
});
test('a review with no model call is written like any other', () => {
  const sentence = 'No file was read in this review: every file that can be sent was read, as it is now, by an earlier review.';
  const r = result({
    mode: 'incremental', since: SINCE, nothingToDo: true, overview: sentence,
    scores: [file('src/a.ts', { fileLevel: level(10, 'whole_file') })], verdict: { threshold: 70, needsHuman: false, highest: 10 },
    coverage: { reviewed: [], notReviewed: [{ path: 'logo.png', reason: 'no_diff' }] },
  });
  const b = renderReview(r, auto).body;
  assert.ok(b.startsWith('**Incremental review** of the changes since `0123456789ab`.\n\n'));
  for (const h of ['## Summary', '## Human review', '## Coverage', '## Overall']) assert.ok(b.includes(`${h}\n`), h);
  assert.ok(b.includes(`## Summary\n\n${sentence}\n\n`));
  assert.equal(b.includes('## Findings'), false);
  assert.ok(b.endsWith('No findings. 1 files were not reviewed. Human review: not needed (highest score 10%).'));
});
test('a result stored before the new fields renders as before', () => {
  const old = result({ findings: [finding()], unplaced: [unplaced()] });
  const added = { ...old, mode: 'full' as const, unchanged: [], blockingOnUnchanged: 0, nothingToDo: false };
  assert.equal(renderReview(added, auto).body, renderReview(old, auto).body);
  assert.equal(renderReview(old, auto).body.includes('unchanged'), false);
  assert.equal(renderReview({ ...old, unchanged: null as unknown as Finding[] }, auto).body, renderReview(old, auto).body);
});

test('a damaged list of unchanged findings is skipped', () => {
  const base = renderReview(result(), auto).body;
  const damaged: unknown[][] = [[null], ['str'], [5], [{}], [{ path: 'a', line: 1, severity: 'major' }], [{ path: 'a', line: 1, severity: 'major', body: 7 }],
    [{ path: 'a', line: 1.5, severity: 'major', body: 'x' }], [{ path: 'a', line: 1, severity: 'huge', body: 'x' }], [{ path: 1, line: 1, severity: 'major', body: 'x' }]];
  for (const list of damaged) {
    const b = renderReview(result({ unchanged: list as Finding[] }), auto).body;
    assert.equal(b, base);
  }
  const mixed = renderReview(result({ unchanged: [null as unknown as Finding, finding({ line: 21 })] }), auto).body;
  assert.equal((mixed.match(/^- \*\*/gm) ?? []).length, 1);
  assert.ok(mixed.includes('1 major on code unchanged since the last review.'));
});
test('an unchanged finding whose requested line is absent or not a number has no note of where it refers to', () => {
  for (const requestedLine of [undefined, 'x', 2.5, null]) {
    const damaged = { path: 'src/a.ts', side: 'RIGHT', line: 21, severity: 'major', body: 'The total is never checked here.', quote: '', requestedLine };
    const b = renderReview(result({ unchanged: [damaged as unknown as Finding] }), auto).body;
    assert.ok(b.includes('`src/a.ts:21`'), String(requestedLine));
    assert.ok(!b.includes('Refers to'), String(requestedLine));
  }
  assert.ok(renderReview(result({ unchanged: [finding({ line: 21, requestedLine: 23 })] }), auto).body.includes('_(Refers to line 23, just outside the diff.)_'));
});
test('a long unchanged section is cut in the head and never pushes Overall out', () => {
  const many = Array.from({ length: 4000 }, (_, i) => finding({ line: i + 1, body: 'The total is never checked here.' }));
  const b = renderReview(result({ unchanged: many, unplaced: [unplaced()] }), auto).body;
  assert.ok(b.length <= MAX_BODY_CHARS);
  assert.ok(b.includes('## Human review\n'));
  assert.ok(b.includes('characters of the review were cut'));
  assert.ok(b.endsWith('4000 major on code unchanged since the last review. Human review: not needed (highest score 0%).'));
  assert.ok(b.includes('## Findings not placed on the diff\n'));
});
const rf = (over: Partial<BlockScore>): string => noted(over);
test('a raised note is written only for a whole number from 0 to 100', () => {
  const plain = '- [lines 5-6](u:src/a.ts:5), 85% `calculation` \u2014 Changes tax.';
  for (const raisedFrom of [NaN, -5, 0.5, 101, 'x']) assert.equal(rf({ raisedFrom: raisedFrom as unknown as number }), plain);
  assert.equal(rf({ raisedFrom: NaN, origin: 'earlier_run' }), `${plain} _(kept from an earlier review)_`);
  assert.equal(rf({ raisedFrom: 0 }), `${plain} _(0% was given; a block this file lost had scored 85%)_`);
  assert.equal(rf({ raisedFrom: 60, origin: 'other_pull_request' }), '- [lines 5-6](u:src/a.ts:5), 85% `calculation` _(60% was given; a block this file lost had scored 85%)_');
  assert.equal(rf({ origin: 'elsewhere' as unknown as 'earlier_run' }), plain);
});
