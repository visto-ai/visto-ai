import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { DeploymentConfig } from '../config/load.ts';
import { SUBMIT_REVIEW } from '../engine/model/submit-review.ts';
import type { ChangedFile, ModelClient, ModelResponse, ReviewDeps, Source } from '../engine/types.ts';
import type { EvalCase } from './cases.ts';
import { assertOutsideProject, replayCase, runReplay, sampleUnmatched, toReviewInput } from './replay.ts';
import { METRICS } from './score.ts';
import type { CaseScore, ReplayFinding } from './score.ts';

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

const mkCase = (pr: number, extra: Partial<EvalCase> = {}): EvalCase => ({
  repo: 'acme/shop', pr_number: pr, head_sha: 'abcdef0123456789', compare_base: 'base000', title: 'Add things',
  body: 'Adds things.', branch: 'topic', base_branch: 'main', author: 'dev-one',
  labels: [{ comment_id: '1', path: 'src/a.ts', line: 2, side: 'RIGHT', severity: 'major', label: 'valid' }],
  ...extra,
});
const caseA = mkCase(7);

const bulk = Array.from({ length: 30 }, (_, i) => `+const value${i} = ${i * 7919};`).join('\n');
const fileA: ChangedFile = {
  path: 'src/a.ts', previousPath: null, status: 'modified', additions: 31, deletions: 0,
  patch: `@@ -1,1 +1,31 @@\n head\n${bulk}`,
};
const finding = (line: number) => ({ path: 'src/a.ts', side: 'RIGHT', line, severity: 'major', body: 'Wrong value.', quote: '', beyond_diff: false });

function stubDeps(findings: unknown[] = [finding(2)], overrides: Partial<ReviewDeps> = {}): ReviewDeps {
  const model: ModelClient = {
    complete: (): Promise<ModelResponse> => Promise.resolve({
      toolName: SUBMIT_REVIEW,
      toolArguments: JSON.stringify({ overview: 'src/a.ts has a problem.', findings, files: [] }),
      text: null, model: 'm', provider: null, usage: { calls: 1, inputTokens: 100, outputTokens: 10, cachedTokens: 0, cost: 0.0123 },
    }),
  };
  const source: Source = { listFiles: () => Promise.resolve([fileA]), getFileContent: () => Promise.resolve(null), getDefaultBranchFile: () => Promise.resolve(null) };
  return { source, model, contract: 'You review pull requests.', clock: () => new Date(0), token: () => 'abcdef0123456789', log: () => {}, ...overrides };
}

const tmp = (): string => mkdtempSync(tmpdir() + '/');
const baseArgs = (extra: Record<string, unknown> = {}) => ({
  cases: [caseA, mkCase(8), mkCase(9)], casesFile: 'cases.jsonl', casesSha256: 'a'.repeat(64), label: 'run-one',
  outDir: join(tmp(), 'out'), maxCases: 60, maxCost: 10, concurrency: 2, config, deps: stubDeps(), ...extra,
});

test('a case becomes a full review at its frozen base and head, with no earlier state', () => {
  const i = toReviewInput(caseA, config, new Date(0));
  assert.deepEqual([i.pullRequest.baseSha, i.pullRequest.headSha, i.earlier, i.trigger], ['base000', 'abcdef0123456789', null, 'automatic']);
  assert.deepEqual(i.pullRequest.ref, { service: 'github', owner: 'acme', repo: 'shop', number: 7 });
  assert.deepEqual([i.pullRequest.description, i.pullRequest.headBranch, i.pullRequest.baseBranch, i.pullRequest.draft], ['Adds things.', 'topic', 'main', false]);
  assert.deepEqual(i.limits, { inputTokensPerCall: 200_000, batchesPerReview: 6, modelTimeoutSeconds: 45 });
  assert.deepEqual(i.repoConfig, { primaryBranches: ['main'], scoreThreshold: 70 });
});

test('a repo that is not owner/name throws bad_case_repo', () => {
  assert.throws(() => toReviewInput(mkCase(1, { repo: 'shop' }), config, new Date(0)), /^Error: bad_case_repo$/);
  assert.throws(() => toReviewInput(mkCase(1, { repo: 'a/b/c' }), config, new Date(0)), /bad_case_repo/);
});

test('only placed findings are scored', async () => {
  const r = await replayCase(caseA, config, stubDeps([finding(2), finding(500)]));
  assert.equal(r.findings.length, 1);
  assert.deepEqual([r.status, r.failure_stage, r.failure_reason, r.total_tokens, r.total_cost], ['ok', null, null, 110, 0.0123]);
  assert.deepEqual(r.findings[0], { path: 'src/a.ts', line: 2, side: 'RIGHT', severity: 'major', body: 'Wrong value.' });
  assert.equal(r.key, 'acme/shop#7@abcdef012345');
  assert.ok(r.duration_ms >= 0);
});

test('a case result explains the run: calls, cached tokens, models, unplaced and coverage', async () => {
  const files: ChangedFile[] = [fileA, { path: 'logo.bin', previousPath: null, status: 'modified', additions: 0, deletions: 0, patch: null }];
  const model: ModelClient = {
    complete: (): Promise<ModelResponse> => Promise.resolve({
      toolName: SUBMIT_REVIEW,
      toolArguments: JSON.stringify({ overview: 'src/a.ts has a problem.', findings: [finding(2), finding(500)], files: [] }),
      text: null, model: 'vendor/model-a', provider: 'Up One', usage: { calls: 1, inputTokens: 100, outputTokens: 10, cachedTokens: 40, cost: 0.01 },
    }),
  };
  const r = await replayCase(caseA, config, stubDeps([], { model, source: { listFiles: () => Promise.resolve(files), getFileContent: () => Promise.resolve(null), getDefaultBranchFile: () => Promise.resolve(null) } }));
  assert.deepEqual(
    [r.calls, r.cached_tokens, r.models, r.unplaced, r.files_reviewed, r.not_reviewed],
    [1, 40, ['vendor/model-a'], 1, 1, { no_diff: 1 }],
  );
});

test('a case that fails in eval has empty explanations', async () => {
  const r = await replayCase(mkCase(1, { repo: 'shop' }), config, stubDeps());
  assert.deepEqual([r.calls, r.cached_tokens, r.models, r.unplaced, r.files_reviewed, r.not_reviewed], [0, 0, [], 0, 0, {}]);
});

test('the summary file carries the coverage of the run, and the summary object is unchanged', async () => {
  const twoFiles: ChangedFile[] = [fileA, { path: 'logo.bin', previousPath: null, status: 'modified', additions: 0, deletions: 0, patch: null }];
  const source: Source = {
    listFiles: (p) => Promise.resolve(p.ref.number === 8 ? twoFiles : [fileA]),
    getFileContent: () => Promise.resolve(null), getDefaultBranchFile: () => Promise.resolve(null),
  };
  const s = await runReplay(baseArgs({ deps: stubDeps([finding(2)], { source }) }));
  assert.deepEqual(s.coverage, { files_reviewed: 3, files_not_reviewed: { no_diff: 1 }, cases_with_files_not_reviewed: 1, calls: 3, models: ['m'] });
  assert.deepEqual(Object.keys(s.summary), ['label', ...METRICS.map((m) => m.name)]);
});

test('a failed review fills the failure stage and reason', async () => {
  const deps = stubDeps([], { source: { listFiles: () => Promise.reject(new Error('boom')), getFileContent: () => Promise.resolve(null), getDefaultBranchFile: () => Promise.resolve(null) } });
  const r = await replayCase(caseA, config, deps);
  assert.equal(r.status, 'failed');
  assert.equal(typeof r.failure_stage, 'string');
  assert.equal(typeof r.failure_reason, 'string');
});

test('a result carries the verdict of the review, and null when the case failed in the eval', async () => {
  const r = await replayCase(caseA, config, stubDeps());
  assert.equal(typeof r.highest_score, 'number');
  assert.equal(typeof r.needs_human, 'boolean');
  const bad = await replayCase(mkCase(1, { repo: 'shop' }), config, stubDeps());
  assert.deepEqual([bad.highest_score, bad.needs_human], [null, null]);
});

test('a bad repo gives a failed result at stage eval and never throws', async () => {
  const r = await replayCase(mkCase(1, { repo: 'shop' }), config, stubDeps());
  assert.deepEqual([r.status, r.failure_stage, r.failure_reason, r.findings], ['failed', 'eval', 'bad_case_repo', []]);
});

test('an unexpected error reports its name, never its message', async () => {
  const deps = stubDeps([], { clock: () => { throw new TypeError('private text from a case'); } });
  const r = await replayCase(caseA, config, deps);
  assert.deepEqual([r.status, r.failure_stage, r.failure_reason], ['failed', 'eval', 'unexpected_error']);
  assert.ok(!JSON.stringify(r).includes('private'));
});

test('a run writes its four files and a 64-character case hash', async () => {
  const args = baseArgs();
  const s = await runReplay(args);
  assert.deepEqual(readdirSync(args.outDir).sort(), ['results.jsonl', 'summary.json', 'summary.md', 'unmatched-sample.jsonl']);
  assert.match(s.cases_sha256, /^[0-9a-f]{64}$/);
  const lines = readFileSync(join(args.outDir, 'results.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  const onDisk = JSON.parse(readFileSync(join(args.outDir, 'summary.json'), 'utf8')) as typeof s;
  assert.deepEqual(onDisk, s);
  assert.deepEqual(s.scored.map((x) => x.key), args.cases.map((c) => `acme/shop#${c.pr_number}@abcdef012345`));
  assert.deepEqual([s.summary.label, s.summary.cases, s.stopped_reason, s.cases_not_started, s.case_count, s.max_cases], ['run-one', 3, null, 0, 3, 60]);
  const md = readFileSync(join(args.outDir, 'summary.md'), 'utf8');
  assert.match(md, /^\| metric \| value \|\n\| --- \| --- \|\n\| cases \| 3 \|\n/);
  assert.match(md, /\| escaped_recall \| \u2014 \|/);
});

test('the run stops starting cases at the cost limit', async () => {
  const s = await runReplay({ ...baseArgs(), maxCost: 0.02, concurrency: 1 });
  assert.deepEqual([s.stopped_reason, s.cases_not_started, s.scored.length], ['max_cost', 1, 2]);
});

test('max_cases takes the first cases in file order', async () => {
  const s = await runReplay({ ...baseArgs(), maxCases: 2 });
  assert.deepEqual(s.scored.map((x) => x.key), ['acme/shop#7@abcdef012345', 'acme/shop#8@abcdef012345']);
  assert.deepEqual([s.stopped_reason, s.cases_not_started], [null, 0]);
});

test('a failing case does not stop the run', async () => {
  const s = await runReplay({ ...baseArgs(), cases: [caseA, mkCase(8, { repo: 'shop' }), mkCase(9)] });
  assert.equal(s.summary.failed_cases, 1);
  assert.equal(s.scored.length, 3);
});

test('an existing output directory is reused', async () => {
  const args = baseArgs({ outDir: tmp() });
  await runReplay(args);
  assert.equal(readdirSync(args.outDir).length, 4);
});

const unmatched = (path: string, line: number, severity: ReplayFinding['severity']): ReplayFinding => ({ path, line, side: 'RIGHT', severity, body: 'x' });
const scored: CaseScore[] = [
  { key: 'k1', status: 'ok', comment_count: 3, blocking_count: 2, labels: [], unmatched: [unmatched('a.ts', 1, 'major'), unmatched('b.ts', 2, 'minor'), unmatched('c.ts', 3, 'blocker')] },
  { key: 'k2', status: 'ok', comment_count: 2, blocking_count: 2, labels: [], unmatched: [unmatched('a.ts', 1, 'major'), unmatched('d.ts', 9, 'major')] },
];

test('the unmatched sample is the same on every call, blocking only, with the case key', () => {
  assert.deepEqual(sampleUnmatched(scored, 's', 2), sampleUnmatched(scored, 's', 2));
  const all = sampleUnmatched(scored, 's', 10);
  assert.equal(all.length, 4);
  assert.ok(all.every((f) => f.severity !== 'minor'));
  assert.deepEqual(all.map((f) => f.key).sort(), ['k1', 'k1', 'k2', 'k2']);
  assert.deepEqual(sampleUnmatched(scored, 's', 2), all.slice(0, 2));
  assert.notDeepEqual(sampleUnmatched(scored, 'other-seed', 10), all);
});

test('paths inside the project are refused', () => {
  assert.throws(() => assertOutsideProject('/work/proj/runs/x', '/work/proj'), /^Error: path_inside_project$/);
  assert.throws(() => assertOutsideProject('/work/proj', '/work/proj'), /path_inside_project/);
  assert.throws(() => assertOutsideProject('/work/proj/../proj/x', '/work/proj'), /path_inside_project/);
  assert.doesNotThrow(() => assertOutsideProject('/work/eval/x', '/work/proj'));
  assert.doesNotThrow(() => assertOutsideProject('/work/project-two/x', '/work/proj'));
});

test('real paths are compared: a link into the project is refused, existing or not', () => {
  const base = mkdtempSync(tmpdir() + '/');
  const project = join(base, 'proj');
  const elsewhere = join(base, 'elsewhere');
  mkdirSync(join(project, 'inner'), { recursive: true });
  mkdirSync(join(elsewhere, 'plain'), { recursive: true });
  symlinkSync(join(project, 'inner'), join(elsewhere, 'link'));
  assert.throws(() => assertOutsideProject(join(elsewhere, 'link'), project), /path_inside_project/);
  assert.throws(() => assertOutsideProject(join(elsewhere, 'link', 'not', 'yet'), project), /path_inside_project/);
  assert.doesNotThrow(() => assertOutsideProject(join(elsewhere, 'plain'), project));
  assert.doesNotThrow(() => assertOutsideProject(join(elsewhere, 'plain', 'not', 'yet'), project));
  assert.doesNotThrow(() => assertOutsideProject(join(elsewhere, 'new'), project));
  assert.throws(() => assertOutsideProject(project, project), /path_inside_project/);
});

test('stale summary files are removed when a run begins, and a failed write ends the run', async () => {
  const args = baseArgs({ outDir: tmp() });
  for (const f of ['summary.json', 'summary.md', 'unmatched-sample.jsonl']) writeFileSync(join(args.outDir, f), 'stale');
  mkdirSync(join(args.outDir, 'results.jsonl'));
  let requests = 0;
  const base = stubDeps();
  const deps = { ...base, model: { complete: (r: Parameters<typeof base.model.complete>[0]) => { requests += 1; return base.model.complete(r); } } };
  await assert.rejects(runReplay({ ...args, deps }));
  assert.deepEqual(readdirSync(args.outDir), ['results.jsonl']);
  assert.equal(requests, 0);
});

test('after a result line cannot be written, no new case starts and the run rejects once started cases settle', async () => {
  for (const concurrency of [1, 2]) {
    const args = baseArgs({ outDir: tmp(), cases: [caseA, mkCase(8), mkCase(9), mkCase(10)], concurrency });
    const base = stubDeps();
    let requests = 0;
    let inFlight = 0;
    const deps = {
      ...base,
      model: {
        complete: async (r: Parameters<typeof base.model.complete>[0]) => {
          requests += 1;
          inFlight += 1;
          try {
            await new Promise((done) => setTimeout(done, 20));
            const path = join(args.outDir, 'results.jsonl');
            if (!statSync(path).isDirectory()) { rmSync(path, { force: true }); mkdirSync(path); }
            return await base.model.complete(r);
          } finally { inFlight -= 1; }
        },
      },
    };
    await assert.rejects(runReplay({ ...args, deps }));
    assert.equal(inFlight, 0);
    assert.equal(requests, concurrency);
    assert.ok(!existsSync(join(args.outDir, 'summary.json')));
  }
});
