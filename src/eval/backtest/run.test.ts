import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { DeploymentConfig } from '../../config/load.ts';
import { SUBMIT_REVIEW } from '../../engine/model/submit-review.ts';
import type { ChangedFile, ModelClient, ModelResponse, ReviewDeps, ScoreAnswer, Scorer, Source } from '../../engine/types.ts';
import type { HistoryCase } from '../history/file.ts';
import { readCaseScores, runBacktest, toBacktestInput } from './run.ts';
import type { BacktestSummary } from './run.ts';

const config: DeploymentConfig = {
  model: {
    baseUrl: 'https://models.example.test/v1', apiKey: 'k', model: 'm', fallbacks: [],
    effort: { default: {}, elevated: {} }, extraBody: {}, extraHeaders: {}, prices: null, timeoutSeconds: 45,
  },
  scorer: null,
  app: null, database: null, server: { port: 8080 }, dryRun: false, alerts: null,
  limits: { inputTokensPerCall: 200_000, batchesPerReview: 6, spendPerDay: 50, queueConcurrency: 2 },
  repositories: { defaults: { primaryBranches: ['main'], scoreThreshold: 70, ignoredAuthors: [], baseBranches: [], newHead: null }, overrides: {} },
};

const bulk = Array.from({ length: 30 }, (_, i) => `+const value${i} = ${i * 7919};`).join('\n');
const patch = `@@ -1,1 +1,31 @@\n head\n${bulk}`;
const fileAt = (path: string): ChangedFile => ({ path, previousPath: null, status: 'modified', additions: 30, deletions: 0, patch });

// The path decides the score, as a model reading the file would.
const table: Record<string, number> = { 'src/a.ts': 80, 'src/b.ts': 10 };

const mkCase = (pr: number, path: string, extra: Partial<HistoryCase> = {}): HistoryCase => ({
  version: 1, repo: 'acme/shop', pr_number: pr, title: 'Add things', body: 'Adds things.', author: 'dev-one', branch: 'topic', base_branch: 'main',
  merged_at: '2026-01-02T00:00:00Z', review_head: `head${pr}`.padEnd(12, '0'), review_base: 'base0000', review_at: '2026-01-01T00:00:00Z',
  reviewed_by_person: true, final_head: 'final000', final_base: 'base0000',
  final_files: [{ path, previous_path: null, status: 'modified', patch }],
  activity: [{
    kind: 'inline', id: `c${pr}`, author: 'bob', bot: false, association: 'member', at: '2026-01-01T01:00:00Z', body: 'x',
    commit: `head${pr}`.padEnd(12, '0'), path, side: 'RIGHT', line: 5,
  }],
  ...extra,
});
const caseA = mkCase(1, 'src/a.ts');
const caseB = mkCase(2, 'src/b.ts');

function stubDeps(failPr: number[] = []): ReviewDeps {
  const model: ModelClient = {
    complete: (request): Promise<ModelResponse> => {
      const text = request.messages[2]!.content;
      const path = Object.keys(table).find((p) => text.includes(p))!;
      const answer = {
        overview: `${path} is changed.`, findings: [],
        files: [{ path, change_summary: 'Adds values.', blocks: [{ id: 'B1', score: table[path], category: 'other', reason: 'Plain change.' }] }],
      };
      return Promise.resolve({
        toolName: SUBMIT_REVIEW, toolArguments: JSON.stringify(answer), text: null, model: 'm', provider: null,
        usage: { calls: 1, inputTokens: 100, outputTokens: 10, cachedTokens: 0, cost: 0.5 },
      });
    },
  };
  const source: Source = {
    listFiles: (pr) => (failPr.includes(pr.ref.number) ? Promise.reject(new Error('boom')) : Promise.resolve([fileAt(pr.ref.number === 2 ? 'src/b.ts' : 'src/a.ts')])),
    getFileContent: () => Promise.resolve(null), getDefaultBranchFile: () => Promise.resolve(null),
  };
  return { source, model, contract: 'You review pull requests.', clock: () => new Date(0), token: () => 'abcdef0123456789', log: () => {} };
}

const tmp = (): string => mkdtempSync(tmpdir() + '/');
const baseArgs = (extra: Record<string, unknown> = {}) => ({
  cases: [caseA, caseB], historyFile: 'history.jsonl', historySha256: 'a'.repeat(64), label: 'run-one',
  outDir: join(tmp(), 'out'), maxCases: 60, maxCost: 10, concurrency: 2, config, deps: stubDeps(), ...extra,
});
const lines = (path: string): unknown[] => readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as unknown);

test('a case becomes a review at its frozen base and head, as of the review time', () => {
  const i = toBacktestInput(caseA, config);
  assert.deepEqual([i.pullRequest.baseSha, i.pullRequest.headSha, i.earlier, i.trigger], ['base0000', 'head10000000', null, 'automatic']);
  assert.deepEqual(i.pullRequest.ref, { service: 'github', owner: 'acme', repo: 'shop', number: 1 });
  assert.equal(i.asOf.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.deepEqual(i.repoConfig, { primaryBranches: ['main'], scoreThreshold: 70 });
  assert.deepEqual(i.limits, { inputTokensPerCall: 200_000, batchesPerReview: 6, modelTimeoutSeconds: 45 });
  assert.throws(() => toBacktestInput(mkCase(1, 'x', { repo: 'shop' }), config), /^Error: bad_case_repo$/);
});

test('two cases produce the four files, and the numbers have one row per threshold then own', async () => {
  const args = baseArgs();
  const s = await runBacktest(args);
  assert.deepEqual(readdirSync(args.outDir).sort(), ['results.jsonl', 'scores.jsonl', 'summary.json', 'summary.md']);
  const onDisk = JSON.parse(readFileSync(join(args.outDir, 'summary.json'), 'utf8')) as BacktestSummary;
  assert.deepEqual(onDisk, s);
  assert.deepEqual(s.numbers.map((n) => n.threshold), [20, 40, 70, 90, 'own']);
  assert.deepEqual([s.label, s.cases, s.failed_cases, s.reviewed_by_person, s.stopped_reason, s.cases_not_started, s.total_cost], ['run-one', 2, 0, 2, null, 0, 1]);
  assert.deepEqual(s.comments, { counted: 2, off_head: 0, outside_diff: 0, in_bot_thread: 0 });
  assert.equal(s.final_missing, 0);
  const results = lines(join(args.outDir, 'results.jsonl')) as { key: string; status: string; verdict: { highest: number; needsHuman: boolean }; blocks: number; blocks_unscored: number; files_flagged_whole: number }[];
  assert.equal(results.length, 2);
  const a = results.find((r) => r.key === 'acme/shop#1@head10000000')!;
  assert.deepEqual([a.status, a.verdict.highest, a.verdict.needsHuman, a.blocks, a.blocks_unscored, a.files_flagged_whole], ['ok', 80, true, 1, 0, 0]);
  const md = readFileSync(join(args.outDir, 'summary.md'), 'utf8');
  assert.match(md, /^\| threshold \| safety_blocks \| safety_blocks_n /);
  assert.equal(md.trim().split('\n').length, 10);
  assert.match(md, /\n\nComments by a person left out because a bot started their thread: 0\. Labelled blocks and files with no final patch: 0\.\nScorer: the review model\n$/);
});

test('the summary names the configured scorer, or null, and summary.md has the line', async () => {
  const without = await runBacktest(baseArgs());
  assert.equal(without.scorer, null);
  const args = baseArgs({ config: { ...config, scorer: { baseUrl: 'https://scorer.example.test/api', apiKey: 'k', model: 'vendor/decision-model', timeoutSeconds: 60 } } });
  const s = await runBacktest(args);
  assert.equal(s.scorer, 'vendor/decision-model');
  assert.match(readFileSync(join(args.outDir, 'summary.md'), 'utf8'), /\nScorer: vendor\/decision-model\nFiles the scorer failed on or was not asked about: 0\n$/);
});

test('each row and the summary count the files the scorer failed on or was not asked about', async () => {
  const scorerConfig = { ...config, scorer: { baseUrl: 'https://scorer.example.test/api', apiKey: 'k', model: 'vendor/decision-model', timeoutSeconds: 60 } };
  const usage = { calls: 1, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0 };
  const failed: ScoreAnswer = { blocks: {}, usage, failure: 'provider' };
  const answered: ScoreAnswer = { blocks: { B1: { score: 20, category: 'other', reason: 'Plain change.' } }, usage, failure: null };
  const scorer: Scorer = { score: (request) => Promise.resolve(request.text.includes('src/b.ts') ? failed : answered) };
  const args = baseArgs({ cases: [caseA, caseB, mkCase(3, 'src/a.ts')], config: scorerConfig, deps: { ...stubDeps([3]), scorer } });
  const s = await runBacktest(args);
  const rows = lines(join(args.outDir, 'results.jsonl')) as { key: string; scorer_failed_files: number }[];
  const byPr = (n: number): number => rows.find((r) => r.key.includes(`#${n}@`))!.scorer_failed_files;
  assert.deepEqual([byPr(1), byPr(2), byPr(3)], [0, 1, 0]);
  assert.equal(s.scorer_failed_files, 1);
  assert.match(readFileSync(join(args.outDir, 'summary.md'), 'utf8'), /\nScorer: vendor\/decision-model\nFiles the scorer failed on or was not asked about: 1\n$/);

  const without = baseArgs();
  const none = await runBacktest(without);
  assert.equal(none.scorer_failed_files, 0);
  assert.doesNotMatch(readFileSync(join(without.outDir, 'summary.md'), 'utf8'), /Files the scorer/);
});

test('the numbers follow the scores: at 70 one of two pull requests is clear, and a commented block left out counts against safety', async () => {
  // src/b.ts scores 10 and a person commented on it; its final patch differs, so its label is strict.
  const changed = patch.replace('+const value0 = 0;', '+const value0 = 1;');
  const b = mkCase(2, 'src/b.ts', { final_files: [{ path: 'src/b.ts', previous_path: null, status: 'modified', patch: changed }] });
  const s = await runBacktest(baseArgs({ cases: [caseA, b] }));
  const at70 = s.numbers.find((n) => n.threshold === 70)!;
  assert.deepEqual([at70.benefit, at70.benefit_n, at70.focus_n], [0.5, 2, 1]);
  assert.deepEqual([at70.safety_blocks, at70.safety_blocks_n], [1, 1]);
  assert.deepEqual([at70.safety_blocks_loose, at70.safety_blocks_loose_n], [0.5, 2]);
});

test('scores.jsonl reads back into the shape scoreNoise takes', async () => {
  const args = baseArgs();
  await runBacktest(args);
  const back = readCaseScores(join(args.outDir, 'scores.jsonl'));
  const a = back.find((c) => c.key === 'acme/shop#1@head10000000')!;
  assert.deepEqual([a.threshold, a.status, a.scores[0]!.path, a.scores[0]!.finalScore], [70, 'ok', 'src/a.ts', 80]);
  assert.equal(a.labels.blocks.get('src/a.ts\nB1')!.loose, true);
  assert.equal(a.labels.files.get('src/a.ts')!.loose, true);
  assert.deepEqual(a.labels.comments, { counted: 1, off_head: 0, outside_diff: 0, in_bot_thread: 0 });
  assert.equal(a.labels.final_missing, 0);
});

test('a failed review is counted, written with its status and left out of the numbers', async () => {
  const args = baseArgs({ cases: [caseA, mkCase(3, 'src/a.ts'), caseB], deps: stubDeps([3]) });
  const s = await runBacktest(args);
  assert.deepEqual([s.cases, s.failed_cases], [3, 1]);
  assert.equal(s.numbers[2]!.benefit_n, 2);
  const failed = (lines(join(args.outDir, 'scores.jsonl')) as { key: string; status: string; scores: unknown[] }[]).find((l) => l.key.includes('#3@'))!;
  assert.deepEqual([failed.status, failed.scores], ['failed', []]);
  const row = (lines(join(args.outDir, 'results.jsonl')) as { key: string; status: string; failure_stage: string }[]).find((l) => l.key.includes('#3@'))!;
  assert.deepEqual([row.status, typeof row.failure_stage], ['failed', 'string']);
});

test('a case that fails in the eval records a short code and no private text', async () => {
  const args = baseArgs({ cases: [mkCase(1, 'src/a.ts', { repo: 'shop' })] });
  const s = await runBacktest(args);
  assert.equal(s.failed_cases, 1);
  const row = lines(join(args.outDir, 'results.jsonl'))[0] as { failure_stage: string; failure_code: string; verdict: unknown };
  assert.deepEqual([row.failure_stage, row.failure_code, row.verdict], ['eval', 'bad_case_repo', null]);
});

test('the run stops starting cases at the cost limit', async () => {
  const s = await runBacktest({ ...baseArgs(), cases: [caseA, caseB, mkCase(3, 'src/a.ts')], maxCost: 0.5, concurrency: 1 });
  assert.deepEqual([s.stopped_reason, s.cases_not_started, s.cases], ['max_cost', 2, 1]);
});

test('max_cases takes the first cases in file order', async () => {
  const args = baseArgs({ maxCases: 1 });
  const s = await runBacktest(args);
  assert.deepEqual([s.cases, s.case_count, s.max_cases, s.stopped_reason], [1, 2, 1, null]);
  assert.deepEqual((lines(join(args.outDir, 'results.jsonl')) as { key: string }[]).map((r) => r.key), ['acme/shop#1@head10000000']);
});

test('two cases with the same key are refused before any case runs', async () => {
  const args = baseArgs({ cases: [caseA, caseA] });
  let requests = 0;
  const base = stubDeps();
  const deps = { ...base, model: { complete: (r: Parameters<typeof base.model.complete>[0]) => { requests += 1; return base.model.complete(r); } } };
  await assert.rejects(runBacktest({ ...args, deps }), /^Error: duplicate_history_case$/);
  assert.equal(requests, 0);
  assert.ok(!existsSync(args.outDir));
});

test('summary files of an earlier run are removed when a run begins, even if the run then fails', async () => {
  const args = baseArgs();
  mkdirSync(args.outDir);
  for (const f of ['summary.json', 'summary.md']) writeFileSync(join(args.outDir, f), 'stale');
  mkdirSync(join(args.outDir, 'scores.jsonl')); // makes the run fail after the removals
  await assert.rejects(runBacktest(args));
  assert.deepEqual(readdirSync(args.outDir), ['scores.jsonl']);
});

test('a reused directory starts the result files afresh', async () => {
  const args = baseArgs();
  await runBacktest(args);
  await runBacktest({ ...args, cases: [caseA] });
  assert.equal(lines(join(args.outDir, 'results.jsonl')).length, 1);
  assert.equal(lines(join(args.outDir, 'scores.jsonl')).length, 1);
});

test('a link planted at a result file is replaced, and what it pointed at is left alone', async () => {
  const args = baseArgs();
  mkdirSync(args.outDir);
  const elsewhere = join(tmp(), 'other.txt');
  writeFileSync(elsewhere, 'keep');
  symlinkSync(elsewhere, join(args.outDir, 'scores.jsonl'));
  await runBacktest(args);
  assert.equal(lstatSync(join(args.outDir, 'scores.jsonl')).isFile(), true);
  assert.equal(readFileSync(elsewhere, 'utf8'), 'keep');
  assert.equal(lines(join(args.outDir, 'scores.jsonl')).length, 2);
});

test('a share with nothing to divide by is written as an em dash', async () => {
  const args = baseArgs({ cases: [mkCase(3, 'src/a.ts')], deps: stubDeps([3]) });
  const s = await runBacktest(args);
  assert.equal(s.numbers[0]!.benefit, null);
  const md = readFileSync(join(args.outDir, 'summary.md'), 'utf8');
  assert.match(md, /^\| 20 \| \u2014 \| 0 \|/m);
  assert.ok(!md.includes('null'));
});

test('the summary totals comments left out in bot threads and labels with no final patch', async () => {
  const bot = { kind: 'inline' as const, id: 'b1', author: 'ci', bot: true, association: 'none' as const, at: '2026-01-01T00:30:00Z', body: 'x', commit: 'head10000000', path: 'src/a.ts', side: 'RIGHT' as const, line: 5 };
  const inBot = { ...bot, id: 'r1', author: 'bob', bot: false, association: 'member' as const, reply_to: 'b1' };
  const args = baseArgs({ cases: [mkCase(1, 'src/a.ts', { final_files: [], activity: [...caseA.activity, bot, inBot] })] });
  const s = await runBacktest(args);
  assert.equal(s.comments.in_bot_thread, 1);
  assert.equal(s.final_missing, 2); // the labelled block and its file
  assert.match(readFileSync(join(args.outDir, 'summary.md'), 'utf8'), /bot started their thread: 1\. Labelled blocks and files with no final patch: 2\./);
});

test('files_flagged_whole counts only files flagged as a whole at the case threshold', async () => {
  const rename: ChangedFile = { path: 'src/new.ts', previousPath: 'src/old.ts', status: 'renamed', additions: 0, deletions: 0, patch: null };
  const base = stubDeps();
  const source: Source = {
    listFiles: () => Promise.resolve([rename]), getFileContent: () => Promise.resolve('same\n'), getDefaultBranchFile: () => Promise.resolve(null),
  };
  const args = baseArgs({ cases: [mkCase(1, 'src/new.ts')], deps: { ...base, source } });
  await runBacktest(args);
  const [row] = lines(join(args.outDir, 'results.jsonl')) as { verdict: { highest: number }; files_flagged_whole: number }[];
  assert.deepEqual([row!.verdict.highest, row!.files_flagged_whole], [30, 0]);
});

test('the summary records the models that answered and the contract the run used', async () => {
  const s = await runBacktest(baseArgs());
  assert.deepEqual(s.models, ['m']);
  assert.equal(s.contract_sha256, createHash('sha256').update('You review pull requests.').digest('hex'));
});

test('reviewed_by_person counts only cases that ran', async () => {
  const args = baseArgs({ cases: [caseA, mkCase(3, 'src/a.ts'), caseB], deps: stubDeps([3]) });
  const s = await runBacktest(args);
  assert.deepEqual([s.cases, s.failed_cases, s.reviewed_by_person], [3, 1, 2]);
});
