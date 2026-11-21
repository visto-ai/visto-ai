import assert from 'node:assert/strict';
import test from 'node:test';
import { unitTokens } from './context/batches.ts';
import { buildFileContexts, hunksOf } from './context/build.ts';
import { buildMessages, fixedTokens } from './context/prompt.ts';
import { ProviderError } from './model/errors.ts';
import { SUBMIT_REVIEW, submitReviewTool, submitReviewWithThreadsTool } from './model/submit-review.ts';
import { NOTHING_READ } from './plan.ts';
import { chooseEffort, review } from './review.ts';
import { blocksOf, fileDiffHash } from './score/blocks.ts';
import { shownOf } from './score/shown.ts';
import type { BlockScore, ScoreHistory } from './score/types.ts';
import type {
  ChangedFile, EarlierThread, ModelClient, ModelRequest, ModelResponse, PullRequestInfo, RepoConfig, ReviewDeps, ReviewInput, ReviewResult, ScoreAnswer, ScoreRequest, Scorer,
  Severity, Source, Usage,
} from './types.ts';

const CONTRACT = 'You review pull requests.';
const repo: RepoConfig = { primaryBranches: ['main'], scoreThreshold: 70 };
const prTo = (baseBranch: string): PullRequestInfo => ({
  ref: { service: 'github', owner: 'acme', repo: 'shop', number: 7 },
  title: 'Add things', description: 'Adds things.', author: 'dev-one',
  baseBranch, headBranch: 'topic', baseSha: 'b'.repeat(40), headSha: 'h'.repeat(40), draft: false,
});
const input: ReviewInput = {
  pullRequest: prTo('feature'), trigger: 'automatic', repoConfig: repo,
  limits: { inputTokensPerCall: 200_000, batchesPerReview: 6, modelTimeoutSeconds: 30 }, asOf: new Date(0), earlier: null,
};
const smallLimits: ReviewInput = {
  ...input, limits: { ...input.limits, inputTokensPerCall: fixedTokens(CONTRACT, input.pullRequest) + 420 },
};

const bulk = Array.from({ length: 30 }, (_, i) => `+const value${i} = ${i * 7919};`).join('\n');
const fileAt = (path: string): ChangedFile => ({
  path, previousPath: null, status: 'modified', additions: 31, deletions: 0,
  patch: `@@ -1,1 +1,31 @@\n head\n${bulk}`,
});
const fileA = fileAt('src/a.ts');
const fileB = fileAt('src/b.ts');
const binaryNoPatch: ChangedFile = { path: 'logo.bin', previousPath: null, status: 'modified', additions: 0, deletions: 0, patch: null };

const answerOnA = {
  overview: 'src/a.ts has a problem.',
  findings: [{ path: 'src/a.ts', side: 'RIGHT', line: 2, severity: 'major', body: 'Wrong value.', quote: '', beyond_diff: false }],
  files: [],
};
const answerOnB = { overview: 'src/b.ts is fine.', findings: [], files: [] };
const ungrounded = { overview: 'A long article about city gardens.', findings: [], files: [] };

const usage = (): Usage => ({ calls: 1, inputTokens: 100, outputTokens: 10, cachedTokens: 5, cost: 0.5 });
const respond = (answer: unknown): ModelResponse =>
  ({ toolName: SUBMIT_REVIEW, toolArguments: JSON.stringify(answer), text: null, model: 'm', provider: null, usage: usage() });

type Step = unknown | ProviderError;
function deps(spec: {
  files: ChangedFile[]; answers?: Step[]; answerFor?: Record<string, Step>; delayMs?: number; listError?: Error; scorer?: Scorer;
}):
  ReviewDeps & { model: ModelClient & { requests: ModelRequest[]; maxInFlight: number }; logged: Array<Record<string, unknown>>; tokens: number } {
  const requests: ModelRequest[] = [];
  const logged: Array<Record<string, unknown>> = [];
  let inFlight = 0;
  const model = {
    requests,
    maxInFlight: 0,
    async complete(request: ModelRequest): Promise<ModelResponse> {
      requests.push(request);
      inFlight += 1;
      model.maxInFlight = Math.max(model.maxInFlight, inFlight);
      try {
        if (spec.delayMs) await new Promise((r) => setTimeout(r, spec.delayMs));
        let step: Step;
        if (spec.answerFor) {
          const last = request.messages[2]!.content; // the file sections; a retry appends later messages
          const key = Object.keys(spec.answerFor).find((p) => last.includes(p));
          step = key === undefined ? undefined : spec.answerFor[key];
        } else {
          step = (spec.answers ?? [])[requests.length - 1];
        }
        if (step === undefined) throw new Error('stub model exhausted');
        if (step instanceof ProviderError) throw step;
        return respond(step);
      } finally {
        inFlight -= 1;
      }
    },
  };
  const source: Source = {
    listFiles: () => (spec.listError ? Promise.reject(spec.listError) : Promise.resolve(spec.files)),
    getFileContent: () => Promise.resolve(null),
    getDefaultBranchFile: () => Promise.resolve(null),
  };
  const d = {
    source, model, contract: CONTRACT, clock: () => new Date(0), logged, tokens: 0,
    token: () => { d.tokens += 1; return 'abcdef0123456789'; },
    log: (e: Record<string, unknown>) => { logged.push(e); },
    ...(spec.scorer === undefined ? {} : { scorer: spec.scorer }),
  };
  return d;
}

test('an empty pull request makes no model call', async () => {
  const d = deps({ files: [] });
  const r = await review(input, d);
  assert.deepEqual([r.status, r.overview, d.model.requests.length], ['ok', 'No changes to review.', 0]);
});

test('one file, one finding, end to end', async () => {
  const r = await review(input, deps({ files: [fileA], answers: [answerOnA] }));
  assert.deepEqual(r.findings.map((f) => [f.path, f.side, f.line, f.severity]), [['src/a.ts', 'RIGHT', 2, 'major']]);
  assert.deepEqual(r.coverage, { reviewed: ['src/a.ts'], notReviewed: [] });
  assert.equal(r.usage.calls, 1);
  assert.equal(r.overview, 'src/a.ts has a problem.');
  assert.deepEqual([r.status, r.failure, r.mode, r.dependencies.model], ['ok', null, 'full', 'ok']);
});

test('a file with no patch and no content is listed, and the rest is reviewed', async () => {
  const r = await review(input, deps({ files: [fileA, binaryNoPatch], answers: [answerOnA] }));
  assert.deepEqual(r.coverage.notReviewed, [{ path: 'logo.bin', reason: 'no_diff' }]);
  assert.equal(r.status, 'ok');
});

test('files but nothing reviewable: ok, no call, files listed', async () => {
  const d = deps({ files: [binaryNoPatch] });
  const r = await review(input, d);
  assert.deepEqual([r.status, r.overview, d.model.requests.length], ['ok', 'No reviewable changes.', 0]);
  assert.deepEqual(r.coverage.notReviewed, [{ path: 'logo.bin', reason: 'no_diff' }]);
});

test('a rename inside its directory is neither reviewed nor listed as not reviewed, and is audited', async () => {
  const rename: ChangedFile = { path: 'src/new.ts', previousPath: 'src/old.ts', status: 'renamed', additions: 0, deletions: 0, patch: null };
  const d = deps({ files: [fileA, rename], answers: [answerOnA] });
  d.source.getFileContent = async (_p, path) => (path === 'src/old.ts' || path === 'src/new.ts' ? 'same\n' : null);
  const r = await review(input, d);
  assert.deepEqual(r.coverage, { reviewed: ['src/a.ts'], notReviewed: [] });
  assert.deepEqual(r.audit.filter((e) => e.subject === 'src/new.ts'), [{ stage: 'context', action: 'scored_by_rule', subject: 'src/new.ts', reason: 'rule_rename' }]);
});

test('characters stripped from the title and the description reach the audit', async () => {
  const pr = { ...input.pullRequest, title: 'Add\u200b things\u202e', description: 'Adds\u00ad things.' };
  const r = await review({ ...input, pullRequest: pr }, deps({ files: [fileA], answers: [answerOnA] }));
  assert.deepEqual(r.audit.filter((e) => e.subject === 'title' || e.subject === 'description'), [
    { stage: 'context', action: 'control_characters_stripped', subject: 'title', reason: '2' },
    { stage: 'context', action: 'control_characters_stripped', subject: 'description', reason: '1' },
  ]);
});

test('a budget below the fixed part fails with no call', async () => {
  const d = deps({ files: [fileA] });
  const r = await review({ ...input, limits: { ...input.limits, inputTokensPerCall: 10 } }, d);
  assert.deepEqual([r.status, r.failure, d.model.requests.length], ['failed', { stage: 'context', code: 'budget_too_small' }, 0]);
  assert.equal(r.overview, '');
});

test('effort', () => {
  assert.equal(chooseEffort(prTo('feature'), Array(16).fill(fileA), repo), 'elevated');
  assert.equal(chooseEffort(prTo('feature'), Array(15).fill({ ...fileA, additions: 1 }), repo), 'default');
  assert.equal(chooseEffort(prTo('feature'), [{ ...fileA, additions: 501 }], repo), 'elevated');
  assert.equal(chooseEffort(prTo('feature'), [{ ...fileA, additions: 500 }], repo), 'default');
  assert.equal(chooseEffort(prTo('main'), [fileA], repo), 'elevated');
  assert.equal(chooseEffort(prTo('feature'), [fileA], repo), 'default');
});

test('never more than two batches in flight', async () => {
  const files = ['a', 'b', 'c', 'd', 'e'].map((n) => fileAt(`src/${n}.ts`));
  const answerFor = Object.fromEntries(files.map((f) => [f.path, { overview: `${f.path} ok`, findings: [], files: [] }]));
  const d = deps({ files, answerFor, delayMs: 10 });
  const r = await review(smallLimits, d);
  assert.equal(d.model.requests.length, 5);
  assert.equal(d.model.maxInFlight, 2);
  assert.equal(r.coverage.reviewed.length, 5);
});

test('a timed-out batch of two files is split and each half is called once', async () => {
  const d = deps({ files: [fileA, fileB], answers: [new ProviderError('timeout', 't', null, null), answerOnA, answerOnB] });
  const r = await review(input, d);
  assert.deepEqual([d.model.requests.length, r.coverage.reviewed.length], [3, 2]);
  assert.deepEqual(r.coverage.reviewed, ['src/a.ts', 'src/b.ts']);
  assert.equal(r.dependencies.model, 'ok');
});

test('a split half that fails again is given up, the other half counts', async () => {
  const t = new ProviderError('timeout', 't', null, null);
  const d = deps({ files: [fileA, fileB], answers: [t, answerOnA, t] });
  const r = await review(input, d);
  assert.equal(d.model.requests.length, 3);
  assert.deepEqual(r.coverage.reviewed, ['src/a.ts']);
  assert.deepEqual(r.coverage.notReviewed, [{ path: 'src/b.ts', reason: 'batch_failed' }]);
  assert.equal(r.dependencies.model, 'error');
  assert.equal(r.status, 'ok');
});

test('a timeout on a single file is retried as the same batch', async () => {
  const d = deps({ files: [fileA], answers: [new ProviderError('timeout', 't', null, null), answerOnA] });
  const r = await review(input, d);
  assert.deepEqual([d.model.requests.length, r.status, r.coverage.reviewed], [2, 'ok', ['src/a.ts']]);
  assert.deepEqual(d.model.requests[0]!.messages, d.model.requests[1]!.messages);
});

test('a provider failure is tried once more, then the batch is given up', async () => {
  const down = new ProviderError('provider', 'p', 502, null);
  const d = deps({ files: [fileA], answers: [down, down] });
  const r = await review(input, d);
  assert.deepEqual([d.model.requests.length, r.status, r.failure], [2, 'failed', { stage: 'model', code: 'provider' }]);
  assert.equal(r.dependencies.model, 'error');
  assert.equal(r.usage.calls, 0); // a thrown provider error carries no usage
});

test('invalid output gets no further attempt beyond its own retry', async () => {
  const d = deps({ files: [fileA], answers: [ungrounded, ungrounded, answerOnA] });
  const r = await review(input, d);
  assert.equal(d.model.requests.length, 2);
  assert.deepEqual(r.failure, { stage: 'model', code: 'invalid_output' });
  assert.equal(r.dependencies.model, 'ok');
  assert.equal(r.usage.calls, 2);
});

test('a failed batch does not waste the others', async () => {
  const r = await review(smallLimits, deps({ files: [fileA, fileB], answerFor: { 'src/a.ts': answerOnA, 'src/b.ts': ungrounded } }));
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.coverage.reviewed, ['src/a.ts']);
  assert.deepEqual(r.coverage.notReviewed, [{ path: 'src/b.ts', reason: 'batch_failed' }]);
  assert.ok(r.audit.some((e) => e.action === 'batch_failed' && e.subject === 'src/b.ts' && e.reason === 'invalid_output'));
  assert.equal(r.dependencies.model, 'ok');
});

test('every model call is logged with its effort and outcome', async () => {
  const d = deps({ files: [fileA], answers: [answerOnA] });
  await review(input, d);
  assert.deepEqual(d.logged.map((e) => [e.event, e.effort, e.code, e.files, e.model, e.provider]), [['model_call', 'default', 'ok', 1, 'm', null]]);
  assert.equal((e0(d.logged).usage as Usage).calls, 1);
});

test('the models and providers that answered reach the result and the log', async () => {
  const d = deps({ files: [fileA, fileB], answerFor: { 'src/a.ts': answerOnA, 'src/b.ts': answerOnB } });
  const complete = d.model.complete.bind(d.model);
  d.model.complete = async (request) => {
    const r = await complete(request);
    return request.messages[2]!.content.includes('src/a.ts')
      ? { ...r, model: 'vendor/a', provider: 'Up One' }
      : { ...r, model: 'vendor/b', provider: 'Up One' };
  };
  const r = await review(smallLimits, d);
  assert.deepEqual([r.models, r.providers], [['vendor/a', 'vendor/b'], ['Up One']]);
  assert.deepEqual(d.logged.map((e) => [e.model, e.provider]).sort(), [['vendor/a', 'Up One'], ['vendor/b', 'Up One']]);
});

test('a call that fails without an answer logs a null model and provider', async () => {
  const down = new ProviderError('provider', 'p', 502, null);
  const d = deps({ files: [fileA], answers: [down, down] });
  const r = await review(input, d);
  assert.deepEqual(d.logged.map((e) => [e.code, e.model, e.provider]), [['provider', null, null], ['provider', null, null]]);
  assert.deepEqual([r.models, r.providers], [[], []]);
});
const e0 = (l: Array<Record<string, unknown>>): Record<string, unknown> => l[0]!;

test('a key out of credit fails the review and marks the model', async () => {
  const d = deps({ files: [fileA], answers: [new ProviderError('no_credit', 'c', 402, null)] });
  const r = await review(input, d);
  assert.deepEqual([r.status, r.failure, r.dependencies.model], ['failed', { stage: 'model', code: 'no_credit' }, 'error']);
  assert.equal(d.model.requests.length, 1);
  assert.equal(r.verdict.needsHuman, true);
  assert.deepEqual(r.scores, []);
});

test('auth fails the review even when another batch succeeded', async () => {
  const r = await review(smallLimits, deps({
    files: [fileA, fileB],
    answerFor: { 'src/a.ts': answerOnA, 'src/b.ts': new ProviderError('auth', 'a', 401, null) },
  }));
  assert.deepEqual([r.status, r.failure], ['failed', { stage: 'model', code: 'auth' }]);
  assert.deepEqual(r.findings, []);
  assert.equal(r.verdict.needsHuman, true);
  assert.deepEqual(r.scores, []);
});

test('a source error is a failed result, not an exception', async () => {
  const secret = new Error('boom secret-detail');
  const d = deps({ files: [], listError: secret });
  const r = await review(input, d);
  assert.deepEqual([r.status, r.failure], ['failed', { stage: 'context', code: 'source_error' }]);
  assert.ok(!JSON.stringify(r).includes('secret-detail'));
  assert.deepEqual(d.logged, [{ event: 'internal_error', stage: 'context', name: 'Error' }]);
});

test('an error reading file content is a source error too', async () => {
  const d = deps({ files: [{ ...fileA, patch: null }] });
  d.source.getFileContent = () => Promise.reject(new Error('Content read failed'));
  const r = await review(input, d);
  assert.deepEqual(r.failure, { stage: 'context', code: 'source_error' });
});

test('a source error whose message is a short code keeps that code', async () => {
  for (const code of ['github_401', 'too_many_files', 'github_network']) {
    const d = deps({ files: [], listError: new Error(code) });
    const r = await review(input, d);
    assert.deepEqual(r.failure, { stage: 'context', code });
    assert.deepEqual(d.logged, [{ event: 'internal_error', stage: 'context', name: 'Error' }]);
  }
  const d = deps({ files: [{ ...fileA, patch: null }] });
  d.source.getFileContent = () => Promise.reject(new Error('github_502'));
  assert.deepEqual((await review(input, d)).failure, { stage: 'context', code: 'github_502' });
});

test('a source error whose message is not a short code is source_error', async () => {
  for (const message of ['Github_401', 'github 401', `g${'x'.repeat(40)}`, '']) {
    const r = await review(input, deps({ files: [], listError: new Error(message) }));
    assert.deepEqual(r.failure, { stage: 'context', code: 'source_error' }, message);
  }
});

test('a failed probe for a paired test does not fail the review', async () => {
  const d = deps({ files: [fileA], answers: [answerOnA] });
  d.source.getFileContent = (_p, path) => (path === 'src/a.test.ts' ? Promise.reject(new Error('github_503')) : Promise.resolve(null));
  const r = await review(input, d);
  assert.equal(r.status, 'ok');
  assert.ok(r.audit.some((e) => e.action === 'test_probe_failed' && e.subject === 'src/a.test.ts' && e.reason === 'github_503'));
});

test('an answer is grounded only by the files of its own batch', async () => {
  const namesOther = { overview: 'The change in src/a.ts is fine.', findings: [], files: [] };
  const d = deps({ files: [fileA, fileB], answerFor: { 'src/a.ts': answerOnA, 'src/b.ts': namesOther } });
  const r = await review(smallLimits, d);
  assert.deepEqual(r.coverage.reviewed, ['src/a.ts']);
  assert.deepEqual(r.coverage.notReviewed, [{ path: 'src/b.ts', reason: 'batch_failed' }]);
  assert.ok(r.audit.some((e) => e.action === 'retry' && e.reason.startsWith('ungrounded')));
});

test('a finding on a file of another batch is dropped', async () => {
  const crossing = { overview: 'src/b.ts is fine.', findings: [{ ...answerOnA.findings[0]!, severity: 'blocker' }], files: [] };
  const r = await review(smallLimits, deps({ files: [fileA, fileB], answerFor: { 'src/a.ts': answerOnB, 'src/b.ts': crossing } }));
  assert.deepEqual(r.findings, []);
  assert.ok(r.audit.some((e) => e.action === 'dropped' && e.subject === 'src/a.ts' && e.reason === 'path_not_in_batch'));
});

test('file numbers run across batches', async () => {
  const d = deps({ files: [fileA, fileB], answerFor: { 'src/a.ts': answerOnA, 'src/b.ts': answerOnB } });
  await review(smallLimits, d);
  const sections = d.model.requests.map((q) => q.messages[2]!.content);
  const first = sections.find((t) => t.includes('Batch 1 of 2'))!;
  const second = sections.find((t) => t.includes('Batch 2 of 2'))!;
  assert.ok(first.includes('## File 1/2: src/a.ts'));
  assert.ok(second.includes('## File 2/2: src/b.ts'));
  assert.ok(!first.includes('## File 2/2') && !second.includes('## File 1/2'));
});

test('an unexpected error in the model phase is internal_error', async () => {
  const d = deps({ files: [fileA], answers: [] }); // the stub throws a plain Error
  const r = await review(input, d);
  assert.deepEqual([r.status, r.failure], ['failed', { stage: 'model', code: 'internal_error' }]);
  assert.deepEqual(d.logged.filter((e) => e.event === 'internal_error'), [{ event: 'internal_error', stage: 'model', name: 'Error' }]);
  assert.equal(r.verdict.needsHuman, true);
  assert.deepEqual(r.scores, []);
});

test('one marker token is used for the whole review', async () => {
  const d = deps({ files: [fileA, fileB], answerFor: { 'src/a.ts': answerOnA, 'src/b.ts': answerOnB } });
  await review(smallLimits, d);
  assert.equal(d.tokens, 1);
  const seen = d.model.requests.map((q) => q.messages[1]!.content);
  assert.equal(new Set(seen).size, 1);
  assert.ok(seen[0]!.includes('abcdef0123456789'));
});

test('requests carry the timeout and numbering of the whole review', async () => {
  const d = deps({ files: [fileA, fileB], answerFor: { 'src/a.ts': answerOnA, 'src/b.ts': answerOnB } });
  await review(smallLimits, d);
  assert.ok(d.model.requests.every((q) => q.timeoutMs === 30_000));
  const lasts = d.model.requests.map((q) => q.messages[2]!.content).sort();
  assert.ok(lasts.some((t) => t.includes('Batch 1 of 2') && t.includes('1 of 2')));
  assert.ok(lasts.some((t) => t.includes('Batch 2 of 2')));
});

test('usage sums every call, failed ones included', async () => {
  const r = await review(smallLimits, deps({ files: [fileA, fileB], answerFor: { 'src/a.ts': answerOnA, 'src/b.ts': ungrounded } }));
  assert.equal(r.usage.calls, 3);
  assert.equal(r.usage.inputTokens, 300);
});

test('a retry inside the model call shows in usage and audit', async () => {
  const d = deps({ files: [fileA], answers: [ungrounded, ungrounded] });
  const r = await review(input, d);
  assert.equal(r.usage.calls, 2);
  assert.ok(r.audit.some((e) => e.action === 'retry'));
});

const fourFiles = ['a', 'b', 'c', 'd'].map((n) => fileAt(`src/${n}.ts`));
const okFor = (f: ChangedFile): { overview: string; findings: never[]; files: never[] } => ({ overview: `${f.path} ok`, findings: [], files: [] });

test('an unexpected error stops the pool: nothing runs after review returns', async () => {
  const answerFor: Record<string, unknown> = Object.fromEntries(fourFiles.map((f) => [f.path, okFor(f)]));
  delete answerFor['src/a.ts']; // the stub throws a plain Error for this file
  const d = deps({ files: fourFiles, answerFor, delayMs: 10 });
  const r = await review(smallLimits, d);
  const requests = d.model.requests.length;
  const logs = d.logged.length;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual([d.model.requests.length, d.logged.length], [requests, logs]);
  assert.ok(requests <= 2);
  assert.deepEqual(r.failure, { stage: 'model', code: 'internal_error' });
  assert.equal(r.usage.calls, requests - 1); // the call that threw carries no usage; the in-flight one finished
});

test('a dead key stops new batches: at most the two in flight', async () => {
  const answerFor: Record<string, unknown> = Object.fromEntries(fourFiles.map((f) => [f.path, okFor(f)]));
  answerFor['src/a.ts'] = new ProviderError('no_credit', 'c', 402, null);
  const d = deps({ files: fourFiles, answerFor, delayMs: 10 });
  const r = await review(smallLimits, d);
  assert.ok(d.model.requests.length <= 2);
  assert.deepEqual(r.failure, { stage: 'model', code: 'no_credit' });
  assert.equal(r.usage.calls, d.model.requests.length - 1);
});

test('a logger that always throws changes nothing in the result', async () => {
  const answerFor = { 'src/a.ts': answerOnA, 'src/b.ts': answerOnB };
  const normal = await review(smallLimits, deps({ files: [fileA, fileB], answerFor }));
  const broken = deps({ files: [fileA, fileB], answerFor });
  broken.log = () => { throw new Error('logger down'); };
  const r = await review(smallLimits, broken);
  assert.equal(r.usage.calls, 2);
  assert.deepEqual(r, normal);
});

// Scores and the verdict.
const scored = (path: string, score: number): unknown => ({
  overview: `${path} reviewed.`, findings: [],
  files: [{ path, change_summary: 'Changes the retry delay.', blocks: [{ id: 'B1', score, category: 'fix', reason: 'Changes the retry delay.' }] }],
});
const withRepoFile = (d: ReturnType<typeof deps>, text: string | Error): void => {
  d.source.getDefaultBranchFile = () => (text instanceof Error ? Promise.reject(text) : Promise.resolve(text));
};

test('a review returns scores and a verdict', async () => {
  const r = await review(input, deps({ files: [fileA], answers: [scored('src/a.ts', 45)] }));
  assert.equal(r.scores.length, 1);
  assert.deepEqual(r.verdict, { threshold: 70, needsHuman: false, highest: 45 });
});

test('the threshold comes from the repository config', async () => {
  const r = await review({ ...input, repoConfig: { ...repo, scoreThreshold: 40 } }, deps({ files: [fileA], answers: [scored('src/a.ts', 45)] }));
  assert.deepEqual(r.verdict, { threshold: 40, needsHuman: true, highest: 45 });
});

test('a model that returns no files sends the pull request to a person', async () => {
  const r = await review(input, deps({ files: [fileA], answers: [{ overview: 'src/a.ts is fine.', findings: [], files: [] }] }));
  assert.deepEqual(r.verdict, { threshold: 70, needsHuman: true, highest: 100 });
  assert.equal(r.scores[0]!.fileLevel?.source, 'not_scored');
});

test('a team floor is read from the default branch', async () => {
  const d = deps({ files: [fileA], answers: [scored('src/a.ts', 10)] });
  withRepoFile(d, 'human_review:\n  - src/\n');
  const r = await review(input, d);
  assert.deepEqual(r.scores[0]!.fileLevel, { score: 100, source: 'team_floor' });
  assert.equal(r.verdict.needsHuman, true);
});

test('an unusable repository file floors every file', async () => {
  const d = deps({ files: [fileA], answers: [scored('src/a.ts', 10)] });
  withRepoFile(d, '- a\n');
  const r = await review(input, d);
  assert.equal(r.scores[0]!.fileLevel?.source, 'team_file_invalid');
  assert.equal(r.verdict.needsHuman, true);
});

test('a failed read of the repository file fails the review at the context stage', async () => {
  const d = deps({ files: [fileA], answers: [scored('src/a.ts', 10)] });
  withRepoFile(d, new Error('github_500'));
  const r = await review(input, d);
  assert.deepEqual([r.status, r.failure, r.scores], ['failed', { stage: 'context', code: 'github_500' }, []]);
  assert.deepEqual(r.verdict, { threshold: 70, needsHuman: true, highest: 100 });
  assert.equal(d.model.requests.length, 0);
});

test('the repository file is not read when there are no files', async () => {
  const d = deps({ files: [] });
  let reads = 0;
  d.source.getDefaultBranchFile = () => { reads += 1; return Promise.resolve(null); };
  await review(input, d);
  assert.equal(reads, 0);
});

test('a failed review needs a person', async () => {
  const down = new ProviderError('provider', 'p', 502, null);
  const r = await review({ ...input, repoConfig: { ...repo, scoreThreshold: 33 } }, deps({ files: [fileA], answers: [down, down] }));
  assert.equal(r.status, 'failed');
  assert.deepEqual(r.scores, []);
  assert.deepEqual(r.verdict, { threshold: 33, needsHuman: true, highest: 100 });
});

test('a budget that is too small needs a person', async () => {
  const r = await review({ ...input, limits: { ...input.limits, inputTokensPerCall: 10 } }, deps({ files: [fileA] }));
  assert.deepEqual([r.scores, r.verdict], [[], { threshold: 70, needsHuman: true, highest: 100 }]);
});

test('no files: nothing to judge', async () => {
  const r = await review(input, deps({ files: [] }));
  assert.deepEqual([r.scores, r.verdict], [[], { threshold: 70, needsHuman: false, highest: 0 }]);
});

test('files but no batch: the scores come from rules, floors and not_scored', async () => {
  const r = await review(input, deps({ files: [binaryNoPatch] }));
  assert.equal(r.scores.length, 1);
  assert.equal(r.scores[0]!.path, 'logo.bin');
  assert.equal(r.scores[0]!.fileLevel?.source, 'not_scored');
  assert.equal(r.verdict.needsHuman, true);
});

test('files in a failed batch are not scored', async () => {
  const r = await review(smallLimits, deps({
    files: [fileA, fileB], answerFor: { 'src/a.ts': scored('src/a.ts', 10), 'src/b.ts': ungrounded },
  }));
  const byPath = new Map(r.scores.map((s) => [s.path, s]));
  assert.equal(byPath.get('src/b.ts')!.fileLevel?.source, 'not_scored');
  assert.equal(byPath.get('src/a.ts')!.fileLevel, null);
  assert.deepEqual(r.verdict, { threshold: 70, needsHuman: true, highest: 100 });
});

test('the score audit entries follow the findings audit entries', async () => {
  const bad = { overview: 'src/a.ts has a problem.', findings: [], files: [{ path: 'src/zzz.ts', change_summary: 'x', blocks: [] }] };
  const r = await review(input, deps({ files: [fileA], answers: [bad] }));
  assert.equal(r.audit.at(-1)!.action, 'score_path_not_in_pull_request');
});

test('a rename whose only change is a hidden character needs a person', async () => {
  const rename: ChangedFile = { path: 'src/new.ts', previousPath: 'src/old.ts', status: 'renamed', additions: 0, deletions: 0, patch: null };
  const d = deps({ files: [rename], answers: [scored('src/new.ts', 5)] });
  const contents: Record<string, string> = { 'src/old.ts': 'const s = "ab";\n', 'src/new.ts': 'const s = "a\u200bb";\n' };
  d.source.getFileContent = (_pr, path) => Promise.resolve(contents[path] ?? null);
  const r = await review(input, d);
  assert.deepEqual(r.scores[0]!.fileLevel, { score: 100, source: 'hidden_characters' });
  assert.equal(r.scores[0]!.covered, false);
  assert.equal(r.verdict.needsHuman, true);
});

test('a service patch with a direction override on an added line needs a person', async () => {
  const f: ChangedFile = { path: 'src/a.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+a\u202e' };
  const r = await review(input, deps({ files: [f], answers: [scored('src/a.ts', 5)] }));
  assert.deepEqual(r.scores[0]!.fileLevel, { score: 100, source: 'hidden_characters' });
  assert.equal(r.verdict.needsHuman, true);
});

test('a repository file that is not text floors every file', async () => {
  const d = deps({ files: [fileA], answers: [scored('src/a.ts', 10)] });
  withRepoFile(d, 'human_review:\n  - docs/\n# \u0000\n');
  const r = await review(input, d);
  assert.deepEqual(r.scores[0]!.fileLevel, { score: 100, source: 'team_file_invalid' });
  assert.equal(r.verdict.needsHuman, true);
  assert.equal(r.teamFileInvalid, 'not_text');
});

test('the reason the repository file cannot be used reaches the result and the audit', async () => {
  const d = deps({ files: [fileA], answers: [scored('src/a.ts', 10)] });
  withRepoFile(d, 'human_review:\n  - "./db/migrate/"\n');
  const r = await review(input, d);
  assert.equal(r.teamFileInvalid, 'bad_patterns');
  assert.ok(r.audit.some((e) => e.stage === 'context' && e.action === 'team_file_invalid' && e.subject === '.visto-ai.yml' && e.reason === 'bad_patterns'));
});

test('a usable repository file, a failed review and no files leave teamFileInvalid null', async () => {
  const ok = deps({ files: [fileA], answers: [scored('src/a.ts', 10)] });
  withRepoFile(ok, 'human_review:\n  - docs/\n');
  assert.equal((await review(input, ok)).teamFileInvalid, null);
  const failed = deps({ files: [fileA], answers: [scored('src/a.ts', 10)] });
  withRepoFile(failed, '- a\n');
  assert.equal((await review({ ...input, limits: { ...input.limits, inputTokensPerCall: 10 } }, failed)).teamFileInvalid, null);
  assert.equal((await review(input, deps({ files: [] }))).teamFileInvalid, null);
});

// A second scorer.
const scorerUsage = (): Usage => ({ calls: 2, inputTokens: 40, outputTokens: 4, cachedTokens: 0, cost: 0.25 });
function scorerStub(reply: (request: ScoreRequest) => Partial<ScoreAnswer>): Scorer & { requests: ScoreRequest[] } {
  const requests: ScoreRequest[] = [];
  return {
    requests,
    score: (request) => {
      requests.push(request);
      return Promise.resolve({ blocks: {}, usage: scorerUsage(), failure: null, ...reply(request) });
    },
  };
}
const refunds = { score: 85, category: 'business_rule', reason: 'Changes who may refund.' };

test('with a scorer set, the scores are the scorer\'s and the summaries the review model\'s', async () => {
  const scorer = scorerStub(() => ({ blocks: { B1: refunds } }));
  const r = await review(input, deps({ files: [fileA], answers: [scored('src/a.ts', 20)], scorer }));
  assert.equal(scorer.requests.length, 1);
  assert.deepEqual(r.scores[0]!.blocks.map((b) => b.entry), [refunds]);
  assert.deepEqual(r.verdict, { threshold: 70, needsHuman: true, highest: 85 });
  assert.equal(r.scores[0]!.changeSummary, 'Changes the retry delay.');
});

test('with a scorer set, a review answer that scores no block loses nothing', async () => {
  const scorer = scorerStub(() => ({ blocks: { B1: refunds } }));
  const unscored = { ...answerOnA, files: [{ path: 'src/a.ts', change_summary: 'Changes the retry delay.', blocks: [] }] };
  const r = await review(input, deps({ files: [fileA], answers: [unscored], scorer }));
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.scores[0]!.blocks.map((b) => b.entry), [refunds]);
  assert.equal(r.scores[0]!.fileLevel, null);
  assert.equal(r.scores[0]!.covered, true);
  assert.equal(r.scores[0]!.changeSummary, 'Changes the retry delay.');
  assert.deepEqual(r.findings.map((f) => f.path), ['src/a.ts']);
  assert.deepEqual(r.audit, []);
});

test('a file the scorer fails on is not scored, and the review and its findings stand', async () => {
  const both = {
    ...answerOnA,
    files: ['src/a.ts', 'src/b.ts'].map((path) => ({ path, change_summary: 'x', blocks: [{ id: 'B1', score: 10, category: 'fix', reason: '' }] })),
  };
  const scorer = scorerStub((req) => (req.text.includes('src/b.ts') ? { failure: 'provider' } : { blocks: { B1: { ...refunds, score: 10 } } }));
  const r = await review(input, deps({ files: [fileA, fileB], answers: [both], scorer }));
  const byPath = new Map(r.scores.map((s) => [s.path, s]));
  assert.deepEqual(byPath.get('src/b.ts')!.fileLevel, { score: 100, source: 'not_scored' });
  assert.equal(byPath.get('src/a.ts')!.fileLevel, null);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.findings.map((f) => f.path), ['src/a.ts']);
  assert.ok(r.audit.some((e) => e.stage === 'scorer' && e.action === 'file_failed' && e.subject === 'src/b.ts' && e.reason === 'provider'));
});

test('only files the review model read are sent to the scorer', async () => {
  const fileC = fileAt('src/c.ts');
  const asset: ChangedFile = { path: 'logo.png', previousPath: null, status: 'modified', additions: 0, deletions: 0, patch: null };
  const scorer = scorerStub(() => ({ blocks: { B1: refunds } }));
  const r = await review({ ...smallLimits, limits: { ...smallLimits.limits, batchesPerReview: 2 } }, deps({
    files: [fileA, fileB, fileC, asset], answerFor: { 'src/a.ts': scored('src/a.ts', 10), 'src/b.ts': ungrounded }, scorer,
  }));
  assert.deepEqual(r.coverage.reviewed, ['src/a.ts']);
  assert.deepEqual(r.coverage.notReviewed.map((n) => n.reason).sort(), ['batch_failed', 'over_batch_limit']);
  assert.equal(scorer.requests.length, 1);
  assert.ok(scorer.requests[0]!.text.includes('## File 1/1: src/a.ts'));
  for (const path of ['src/b.ts', 'src/c.ts', 'logo.png']) assert.ok(!scorer.requests[0]!.text.includes(path));
});

test('the scorer\'s usage is added to the review\'s', async () => {
  const scorer = scorerStub(() => ({ blocks: { B1: refunds } }));
  const r = await review(input, deps({ files: [fileA], answers: [scored('src/a.ts', 20)], scorer }));
  assert.equal(r.usage.calls, 1 + 2);
  assert.equal(r.usage.cost, 0.5 + 0.25);
});

test('nothing reviewable, or every batch failed: the scorer is never asked', async () => {
  const none = scorerStub(() => ({}));
  await review(input, deps({ files: [binaryNoPatch], scorer: none }));
  const down = new ProviderError('provider', 'p', 502, null);
  const failed = scorerStub(() => ({}));
  const r = await review(input, deps({ files: [fileA], answers: [down, down], scorer: failed }));
  assert.equal(r.status, 'failed');
  assert.deepEqual([none.requests.length, failed.requests.length], [0, 0]);
});

const movedAway: ChangedFile = { path: 'lib/x.ts', previousPath: 'src/x.ts', status: 'renamed', additions: 0, deletions: 0, patch: null };
const movedAndA = {
  overview: 'Moves lib/x.ts and changes src/a.ts.', findings: [],
  files: [
    { path: 'lib/x.ts', change_summary: 'Moves the file.', blocks: [], score: 35, category: 'rename', reason: 'Moves the file.' },
    { path: 'src/a.ts', change_summary: 'Changes the retry delay.', score: 95, category: 'fix', reason: 'Changes the retry delay.', blocks: [{ id: 'B1', score: 20, category: 'fix', reason: 'Changes the retry delay.' }] },
  ],
};

test('with a scorer set, a file moved to another directory keeps the review model\'s whole-file score', async () => {
  const scorer = scorerStub(() => ({ blocks: { B1: refunds } }));
  const d = deps({ files: [fileA, movedAway], answers: [movedAndA], scorer });
  d.source.getFileContent = async (_p, path) => (path === 'src/x.ts' || path === 'lib/x.ts' ? 'same\n' : null);
  const r = await review(input, d);
  assert.equal(scorer.requests.length, 1);
  assert.ok(!scorer.requests[0]!.text.includes('lib/x.ts'));
  const byPath = new Map(r.scores.map((s) => [s.path, s]));
  assert.deepEqual(byPath.get('lib/x.ts')!.fileLevel, { score: 35, source: 'whole_file' });
  assert.deepEqual(byPath.get('src/a.ts')!.blocks.map((b) => b.entry), [refunds]);
  assert.ok(!r.audit.some((e) => e.action === 'score_path_not_in_batch'));
});

test('with a scorer set, a review-model whole-file score for a file with a diff is not used', async () => {
  const scorer = scorerStub(() => ({ blocks: { B1: { ...refunds, score: 15 } } }));
  const d = deps({ files: [fileA, movedAway], answers: [movedAndA], scorer });
  d.source.getFileContent = async (_p, path) => (path === 'src/x.ts' || path === 'lib/x.ts' ? 'same\n' : null);
  const r = await review(input, d);
  const a = r.scores.find((s) => s.path === 'src/a.ts')!;
  assert.equal(a.fileLevel, null);
  assert.equal(a.finalScore, 15);
});

test('the scorer is sent the file as the review model received it, with the full file cut', async () => {
  const scorer = scorerStub(() => ({ blocks: { B1: refunds } }));
  const d = deps({ files: [fileA], answers: [scored('src/a.ts', 20)], scorer });
  const content = Array.from({ length: 60 }, (_, i) => `const line${i} = ${i * 104729};`).join('\n');
  d.source.getFileContent = async (_p, path) => (path === 'src/a.ts' ? content : null);
  const r = await review(smallLimits, d);
  assert.ok(r.audit.some((e) => e.action === 'full_file_cut' && e.subject === 'src/a.ts'));
  assert.equal(scorer.requests.length, 1);
  assert.ok(!scorer.requests[0]!.text.includes('### Full file'));
  assert.ok(!d.model.requests[0]!.messages[2]!.content.includes('### Full file'));
});

test('a later review shows the thread in the call that holds its file, and a first review is sent nothing new', async () => {
  const dueThread = {
    id: 'PRRT_1', commentId: 'C1', path: 'src/a.ts', side: 'RIGHT' as const, line: 2, severity: 'major' as const, quote: '', body: 'Wrong value.',
    openedAt: { head: 'abcdef0', diffHash: null }, resolved: false, settled: false, lastVerdict: null, replies: [],
  };
  const later = deps({ files: [fileA], answers: [answerOnA] });
  await review({ ...input, earlier: { head: 'abcdef0', threads: [dueThread] } }, later);
  const sent = later.model.requests[0]!;
  assert.ok(sent.messages[2]!.content.includes('### Thread T1'));
  assert.deepEqual(sent.tools, [submitReviewWithThreadsTool]);
  const first = deps({ files: [fileA], answers: [answerOnA] });
  await review(input, first);
  const away = deps({ files: [fileA], answers: [answerOnA] });
  const r = await review({ ...input, earlier: { head: 'abcdef0', threads: [{ ...dueThread, path: 'src/gone.ts' }] } }, away);
  assert.deepEqual(away.model.requests, first.model.requests);
  assert.deepEqual(first.model.requests[0]!.tools, [submitReviewTool]);
  assert.ok(r.audit.some((e) => e.action === 'thread_not_shown' && e.subject === 'T1' && e.reason === 'file_not_in_diff'));
});
test('a thread on a file that was not reviewed is named even when no call is made', async () => {
  const dueThread = {
    id: 'PRRT_1', commentId: 'C1', path: 'src/a.ts', side: 'RIGHT' as const, line: 2, severity: 'major' as const, quote: '', body: 'Wrong value.',
    openedAt: { head: 'abcdef0', diffHash: null }, resolved: false, settled: false, lastVerdict: null, replies: [],
  };
  const tiny: ReviewInput = {
    ...input, earlier: { head: 'abcdef0', threads: [dueThread] },
    limits: { ...input.limits, inputTokensPerCall: fixedTokens(CONTRACT, input.pullRequest, true) + 50 },
  };
  const d = deps({ files: [fileA] });
  const r = await review(tiny, d);
  assert.equal(d.model.requests.length, 0);
  assert.deepEqual(r.coverage.notReviewed, [{ path: 'src/a.ts', reason: 'too_large' }]);
  assert.ok(r.audit.some((e) => e.action === 'thread_not_shown' && e.subject === 'T1' && e.reason === 'file_not_reviewed'));
});

const earlierThread = (over: Partial<EarlierThread> = {}): EarlierThread => ({
  id: 'PRRT_1', commentId: 'C1', path: 'src/a.ts', side: 'RIGHT', line: 2, severity: 'major', quote: 'const a = 1;', body: 'Wrong value.',
  openedAt: { head: 'abcdef0', diffHash: null }, resolved: true, settled: false, lastVerdict: null, replies: [], ...over,
});
test('a later review keeps a verdict, drops a finding its thread already raised, and counts the threads that were due', async () => {
  const answer = {
    ...answerOnA,
    findings: [{ ...answerOnA.findings[0]!, quote: 'const a = 1;' }],
    thread_verdicts: [{ thread_id: 'T1', verdict: 'open' }],
  };
  const threads = [earlierThread(), earlierThread({ id: 'PRRT_2', commentId: 'C2', path: 'src/gone.ts' })];
  const r = await review({ ...input, earlier: { head: 'abcdef0', threads } }, deps({ files: [fileA], answers: [answer] }));
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.alreadyDiscussed, [
    { path: 'src/a.ts', side: 'RIGHT', line: 2, severity: 'major', body: 'Wrong value.', commentId: 'C1', resolved: true, settled: false },
  ]);
  assert.deepEqual(r.threadVerdicts, [{ threadId: 'PRRT_1', commentId: 'C1', verdict: 'open', reply: '', fileChanged: false, replies: 0 }]);
  assert.equal(r.threadsDue, 2);
  assert.ok(r.audit.some((e) => e.action === 'thread_not_shown' && e.subject === 'T2' && e.reason === 'file_not_in_diff'));
  assert.ok(r.audit.some((e) => e.stage === 'reconcile' && e.action === 'duplicate' && e.subject === 'src/a.ts:2' && e.reason === 'near_thread'));
});
test('a review that fails, and one with nothing to read, still say how many threads were due', async () => {
  const earlier = { head: 'abcdef0', threads: [earlierThread(), earlierThread({ id: 'PRRT_2', severity: 'minor' })] };
  const failed = await review({ ...input, earlier }, deps({ files: [fileA], answers: [new ProviderError('auth', 'a', null, null)] }));
  const empty = await review({ ...input, earlier }, deps({ files: [] }));
  const unreadable = await review({ ...input, earlier }, deps({ files: [binaryNoPatch] }));
  const tooSmall = await review({ ...input, earlier, limits: { ...input.limits, inputTokensPerCall: 1 } }, deps({ files: [fileA] }));
  const first = await review(input, deps({ files: [fileA], answers: [answerOnA] }));
  for (const [name, r, status] of [['failed', failed, 'failed'], ['empty', empty, 'ok'], ['unreadable', unreadable, 'ok'], ['too small', tooSmall, 'failed']] as const) {
    assert.deepEqual([r.status, r.threadsDue, r.threadVerdicts, r.alreadyDiscussed], [status, 1, [], []], name);
  }
  assert.deepEqual([first.threadsDue, first.threadVerdicts, first.alreadyDiscussed, first.findings.length], [0, [], [], 1]);
});
test('with two calls, each thread keeps the verdict of the call that showed it, and the other call\'s is dropped as not shown', async () => {
  const replied = [{ author: 'octo-dev', kind: 'person' as const, body: 'ok' }];
  const threads = [
    earlierThread({ resolved: false, quote: 'zzz', replies: replied }),
    earlierThread({ id: 'PRRT_2', commentId: 'C2', path: 'src/b.ts', resolved: false, quote: 'zzz', replies: replied }),
  ];
  const both = (from: string) => ({
    overview: `${from} reviewed.`, findings: [], files: [],
    thread_verdicts: [{ thread_id: 'T1', verdict: 'fixed', reply: `From the call of ${from}.` }, { thread_id: 'T2', verdict: 'answered', reply: `From the call of ${from}.` }],
  });
  const two: ReviewInput = {
    ...input, earlier: { head: 'abcdef0', threads },
    limits: { ...input.limits, inputTokensPerCall: fixedTokens(CONTRACT, input.pullRequest, true) + 900 },
  };
  const d = deps({ files: [fileA, fileB], answerFor: { ': src/a.ts\n': both('src/a.ts'), ': src/b.ts\n': both('src/b.ts') } });
  const r = await review(two, d);
  assert.deepEqual([r.status, d.model.requests.length], ['ok', 2]);
  assert.deepEqual(d.model.requests.map((q) => q.messages[2]!.content.match(/### Thread T\d/g)), [['### Thread T1'], ['### Thread T2']]);
  assert.deepEqual(r.threadVerdicts?.map((v) => [v.threadId, v.verdict, v.reply]), [['PRRT_1', 'fixed', 'From the call of src/a.ts.'], ['PRRT_2', 'answered', 'From the call of src/b.ts.']]);
  assert.deepEqual(r.audit.filter((e) => e.action === 'verdict_dropped').map((e) => [e.subject, e.reason]), [['T2', 'not_shown'], ['T1', 'not_shown']]);
});

// Scores that hold across reviews.
const twoHunkPatch = [
  '@@ -10,3 +10,3 @@', ' keep', '-const delay = 1;', '+const delay = 2;', ' keep',
  '@@ -50,3 +50,3 @@', ' keep', '-const tries = 1;', '+const tries = 3;', ' keep',
].join('\n');
const fileTwo: ChangedFile = { path: 'src/t.ts', previousPath: null, status: 'modified', additions: 2, deletions: 2, patch: twoHunkPatch };
const [hashB1, hashB2] = blocksOf(hunksOf(twoHunkPatch).hunks).map((b) => b.hash);
// `covered`: a published review read the file with the diff of fileTwo.
const historyOf = (blocks: Array<[string, number]>, covered = false): ScoreHistory => ({
  by: 'model', lastReview: null, shown: null,
  files: [{
    path: 'src/t.ts', blocks: blocks.map(([hash, score]) => ({ hash, entry: { score, category: 'fix', reason: '' }, raisedFrom: null })),
    splits: [], stoodFor: [], wholeFile: null, coveredAt: covered ? [fileDiffHash(hunksOf(twoHunkPatch).hunks)!] : [], readAt: null,
  }],
});
const answerOnT = { overview: 'src/t.ts reviewed.', findings: [], files: [] };
const headersOf = (d: ReturnType<typeof deps>): string[] => d.model.requests[0]!.messages[2]!.content.match(/### Block B\d \([^)]*\)/g) ?? [];

test('a later review asks the model only for the blocks that have no score', async () => {
  const d = deps({ files: [fileTwo], answers: [answerOnT] });
  const r = await review({ ...input, history: historyOf([[hashB1!, 40]]) }, d);
  assert.equal(r.status, 'ok');
  assert.deepEqual(headersOf(d), ['### Block B1 (2 changed lines, scored)', '### Block B2 (2 changed lines, not scored)']);
  assert.ok(d.model.requests[0]!.messages[2]!.content.includes('whole-file score: allowed'));
  // Every block scored and the file read as it is: the file is told it takes no whole-file score.
  const all = deps({ files: [fileTwo], answers: [answerOnT] });
  await review({ ...input, history: historyOf([[hashB1!, 40], [hashB2!, 10]], true) }, all);
  assert.deepEqual(headersOf(all), ['### Block B1 (2 changed lines, scored)', '### Block B2 (2 changed lines, scored)']);
  assert.ok(all.model.requests[0]!.messages[2]!.content.includes('whole-file score: not allowed. Every block of this file already has its score.'));
});

test('a later review asks the second scorer only for the blocks that have no score', async () => {
  const scorer = scorerStub(() => ({ blocks: { B2: refunds } }));
  const d = deps({ files: [fileTwo, fileA], answers: [answerOnT], scorer });
  await review({ ...input, history: { ...historyOf([[hashB1!, 40]]), by: 'scorer' } }, d);
  const byFile = scorer.requests.map((q) => [q.text.includes('src/t.ts') ? 'src/t.ts' : 'src/a.ts', q.blocks]);
  assert.deepEqual(byFile.sort(), [['src/a.ts', ['B1']], ['src/t.ts', ['B2']]]);
});

test('a failed lookup across pull requests is named in the audit and the review goes on', async () => {
  const d = deps({ files: [fileTwo], answers: [answerOnT] });
  const asked: Array<Array<{ path: string; hash: string }>> = [];
  d.reusableScores = (blocks) => { asked.push(blocks); return Promise.reject(new Error('db_down')); };
  const r = await review(input, d);
  assert.equal(r.status, 'ok');
  assert.deepEqual(asked, [[{ path: 'src/t.ts', hash: hashB1 }, { path: 'src/t.ts', hash: hashB2 }]]);
  assert.deepEqual(r.audit.filter((e) => e.action === 'reuse_failed'), [{ stage: 'context', action: 'reuse_failed', subject: 'scores', reason: 'db_down' }]);
  assert.deepEqual(headersOf(d), ['### Block B1 (2 changed lines, not scored)', '### Block B2 (2 changed lines, not scored)']);
  // An error without a short code is named internal_error.
  const odd = deps({ files: [fileTwo], answers: [answerOnT] });
  odd.reusableScores = () => Promise.reject(new Error('Connection refused at 10.0.0.1'));
  const again = await review(input, odd);
  assert.equal(again.status, 'ok');
  assert.deepEqual(again.audit.filter((e) => e.action === 'reuse_failed').map((e) => e.reason), ['internal_error']);
  // Nothing to look up: no call.
  const settled = deps({ files: [fileTwo], answers: [answerOnT] });
  let calls = 0;
  settled.reusableScores = () => { calls += 1; return Promise.resolve([]); };
  await review({ ...input, history: historyOf([[hashB1!, 40], [hashB2!, 10]]) }, settled);
  assert.equal(calls, 0);
});

test('an answer of the lookup for a block that was not asked, or with a score that is none, is not used', async () => {
  const fix = (score: number) => ({ score, category: 'fix' as const, reason: '' });
  const d = deps({ files: [fileTwo], answers: [answerOnT] });
  d.reusableScores = () => Promise.resolve([
    { path: 'src/t.ts', hash: hashB1!, entry: fix(50.5) },
    { path: 'src/t.ts', hash: hashB1!, entry: fix(101) },
    { path: 'src/t.ts', hash: hashB1!, entry: fix(-1) },
    { path: 'src/other.ts', hash: hashB1!, entry: fix(50) },
    { path: 'src/t.ts', hash: 'f'.repeat(64), entry: fix(50) },
    { path: 'src/t.ts', hash: hashB2!, entry: fix(20) },
  ]);
  const r = await review(input, d);
  assert.equal(r.status, 'ok');
  assert.deepEqual(headersOf(d), ['### Block B1 (2 changed lines, not scored)', '### Block B2 (2 changed lines, scored)']);
});

test('with no history and no lookup the request is the one a first review sends today', async () => {
  const d = deps({ files: [fileTwo], answers: [answerOnT] });
  await review(input, d);
  const none = deps({ files: [fileTwo], answers: [answerOnT] });
  await review({ ...input, history: null }, none);
  assert.deepEqual(none.model.requests, d.model.requests);
  const built = await buildFileContexts(input.pullRequest, [fileTwo], d.source);
  assert.deepEqual(d.model.requests[0]!.messages, buildMessages({
    contract: CONTRACT, pr: input.pullRequest, fileCount: 1, firstFileNumber: 1,
    batch: { files: built.contexts, tokens: 0 }, batchIndex: 0, batchCount: 1, token: 'abcdef0123456789',
  }));
  assert.equal(built.contexts[0]!.kept, undefined);
  assert.deepEqual(d.model.requests[0]!.tools, [submitReviewTool]);
});

// The history a first review's stored result leaves, read as the shell reads it: each block with its entry,
// and each hunk the run cut wholly into scored parts with their places.
// `covered`: the first review was published, so each file it read is covered at the diff it had.
// `readAt`: the head of the published run that read each file the first review read, with the hashes it had then.
// A block with no score of its own is stood for by the whole-file score of a file the first review left covered.
function historyFrom(first: ReviewResult, extra: {
  covered?: boolean; lastReview?: ScoreHistory['lastReview']; shown?: string | null; readAt?: string;
} = {}): ScoreHistory {
  const stored = JSON.parse(JSON.stringify(first)) as ReviewResult;
  const read = new Set(extra.covered === true ? stored.coverage.reviewed : []);
  const readAtOf = (f: ReviewResult['scores'][number]) => (extra.readAt !== undefined && stored.coverage.reviewed.includes(f.path)
    ? { head: extra.readAt, hashes: [...new Set(f.blocks.flatMap((one) => [one.hash, one.hunkHash]))] }
    : null);
  return {
    by: 'model', lastReview: extra.lastReview ?? null, shown: extra.shown ?? null,
    files: stored.scores.map((f) => {
      const hunks = new Map<string, BlockScore[]>();
      for (const one of f.blocks) hunks.set(one.hunkHash, [...(hunks.get(one.hunkHash) ?? []), one]);
      return {
        path: f.path,
        blocks: f.blocks.filter((one) => one.entry !== null).map((one) => ({ hash: one.hash, entry: one.entry!, raisedFrom: one.raisedFrom ?? null })),
        splits: [...hunks].filter(([, parts]) => parts.every((p) => p.range !== undefined && p.entry !== null))
          .map(([hunkHash, parts]) => ({ hunkHash, parts: parts.map((p) => ({ hash: p.hash, range: p.range! })) })),
        stoodFor: f.covered && f.wholeFile !== null ? f.blocks.filter((one) => one.entry === null).map((one) => one.hash) : [],
        wholeFile: f.wholeFile, coveredAt: read.has(f.path) && f.diffHash !== null ? [f.diffHash] : [], readAt: readAtOf(f),
      };
    }),
  };
}
const withoutOrigin = (blocks: BlockScore[]) => blocks.map((one) => { const rest = { ...one }; delete rest.origin; return rest; });

test('a second review of an unchanged file gives it the same scores without asking for them', async () => {
  const scoredT = { ...answerOnT, files: [{ path: 'src/t.ts', change_summary: 'Changes the delay and the tries.', blocks: [
    { id: 'B1', score: 45, category: 'calculation', reason: 'Doubles the delay.' }, { id: 'B2', score: 10, category: 'fix', reason: '' },
  ] }] };
  const first = await review(input, deps({ files: [fileTwo], answers: [scoredT] }));
  const none = { ...answerOnT, files: [{ path: 'src/t.ts', change_summary: 'Changes the delay and the tries.', blocks: [] }] };
  const d = deps({ files: [fileTwo], answers: [none] });
  const second = await review({ ...input, history: historyFrom(first) }, d);
  assert.deepEqual(headersOf(d), ['### Block B1 (2 changed lines, scored)', '### Block B2 (2 changed lines, scored)']);
  assert.deepEqual(second.scores[0]!.blocks.map((one) => one.origin), ['earlier_run', 'earlier_run']);
  assert.deepEqual(withoutOrigin(second.scores[0]!.blocks), first.scores[0]!.blocks);
  assert.deepEqual([second.scores[0]!.finalScore, second.scores[0]!.covered], [45, true]);
});

const delayPatch = (value: number) => ['@@ -10,3 +10,3 @@', ' keep', '-const delay = 1;', `+const delay = ${value};`, ' keep'].join('\n');
const delayFile = (value: number): ChangedFile => ({ path: 'src/t.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, patch: delayPatch(value) });
const onT = (file: Record<string, unknown>) => ({ ...answerOnT, files: [{ path: 'src/t.ts', change_summary: 'Changes the delay.', blocks: [], ...file }] });

test('an edited block cannot buy a lower score, by a block score or by a whole-file score', async (t) => {
  const first = await review(input, deps({ files: [delayFile(2)], answers: [onT({ blocks: [{ id: 'B1', score: 80, category: 'calculation', reason: 'Changes the delay.' }] })] }));
  assert.equal(first.scores[0]!.finalScore, 80);
  await t.test('by a block score', async () => {
    const second = await review({ ...input, history: historyFrom(first) }, deps({
      files: [delayFile(5)], answers: [onT({ blocks: [{ id: 'B1', score: 20, category: 'fix', reason: 'Small change.' }] })],
    }));
    const [block] = second.scores[0]!.blocks;
    assert.deepEqual([block!.entry, block!.raisedFrom], [{ score: 80, category: 'fix', reason: 'Small change.' }, 20]);
    assert.equal(second.scores[0]!.finalScore, 80);
  });
  await t.test('by a whole-file score', async () => {
    const second = await review({ ...input, history: historyFrom(first) }, deps({
      files: [delayFile(5)], answers: [onT({ score: 20, category: 'fix', reason: 'Small change.' })],
    }));
    const [block] = second.scores[0]!.blocks;
    assert.deepEqual([block!.entry, block!.raisedFrom], [{ score: 80, category: 'fix', reason: 'Small change.' }, 20]);
    assert.equal(second.scores[0]!.finalScore, 80);
  });
});

test('a hunk split in a first review keeps its parts and their scores in the second', async () => {
  const fortyLines = ['@@ -0,0 +1,40 @@', ...Array.from({ length: 40 }, (_, i) => `+const row${i} = ${i * 31};`)].join('\n');
  const added: ChangedFile = { path: 'src/t.ts', previousPath: null, status: 'added', additions: 40, deletions: 0, patch: fortyLines };
  const split = onT({ blocks: [{ id: 'B1', parts: [
    { first: 'R1', last: 'R20', score: 30, category: 'test' }, { first: 'R21', last: 'R40', score: 80, category: 'data_model', reason: 'Adds a table.' },
  ] }] });
  const first = await review(input, deps({ files: [added], answers: [split] }));
  assert.deepEqual(first.scores[0]!.blocks.map((one) => [one.id, one.range]), [['B1.1', [0, 19]], ['B1.2', [20, 39]]]);
  const d = deps({ files: [added], answers: [onT({})] });
  const second = await review({ ...input, history: historyFrom(first) }, d);
  assert.deepEqual(headersOf(d), ['### Block B1 (40 changed lines, scored)']);
  assert.deepEqual(second.scores[0]!.blocks.map((one) => [one.id, one.entry?.score, one.range, one.origin]), [
    ['B1.1', 30, [0, 19], 'earlier_run'], ['B1.2', 80, [20, 39], 'earlier_run'],
  ]);
  assert.deepEqual([second.scores[0]!.finalScore, second.scores[0]!.covered], [80, true]);
});

test('a file with an earlier thread and a history still shows its scored blocks', async () => {
  const d = deps({ files: [fileTwo], answers: [answerOnT] });
  const earlier = { head: 'abcdef0', threads: [earlierThread({ path: 'src/t.ts', line: 11, quote: 'const delay = 2;' })] };
  await review({ ...input, earlier, history: historyOf([[hashB1!, 40]]) }, d);
  assert.ok(d.model.requests[0]!.messages[2]!.content.includes('### Thread T1'));
  assert.deepEqual(headersOf(d), ['### Block B1 (2 changed lines, scored)', '### Block B2 (2 changed lines, not scored)']);
});

test('with a scorer set, each score the scorer gave says so', async () => {
  const scorer = scorerStub(() => ({ blocks: { B1: refunds } }));
  const r = await review(input, deps({ files: [fileA], answers: [scored('src/a.ts', 20)], scorer }));
  assert.deepEqual(r.scores[0]!.blocks.map((one) => one.by), ['scorer']);
  const plain = await review(input, deps({ files: [fileA], answers: [scored('src/a.ts', 20)] }));
  assert.equal('by' in plain.scores[0]!.blocks[0]!, false);
});

// Reading less.
const HEAD0 = 'c'.repeat(40);
const LAST = { head: HEAD0, overview: 'Changes the retry delay and the tries.' };
const LAST_LINE = 'The last review of this pull request summarized it as below. It describes an earlier state of the code and proves nothing about the code you are given.';
const valueFile = (path: string, value: number): ChangedFile => ({ path, previousPath: null, status: 'modified', additions: 1, deletions: 1, patch: delayPatch(value) });
const fileT = valueFile('src/t.ts', 2);
const fileU = valueFile('src/u.ts', 2);
const blockAnswer = (scores: Record<string, number>) => ({
  overview: `${Object.keys(scores).join(' and ')} reviewed.`, findings: [],
  files: Object.entries(scores).map(([path, score]) => ({ path, change_summary: 'Changes the delay.', blocks: [{ id: 'B1', score, category: 'fix', reason: 'Changes the delay.' }] })),
});
const firstOf = (files: ChangedFile[], answer: unknown): Promise<ReviewResult> => review(input, deps({ files, answers: [answer] }));
const named = (d: ReturnType<typeof deps>, path: string): number => d.model.requests.filter((q) => q.messages[2]!.content.includes(path)).length;
const finals = (r: ReviewResult): Record<string, number> => Object.fromEntries(r.scores.map((one) => [one.path, one.finalScore]));
const notSent = (r: ReviewResult): string[][] => r.audit.filter((e) => e.action === 'not_sent').map((e) => [e.subject, e.reason]);
const asset: ChangedFile = { path: 'logo.png', previousPath: null, status: 'modified', additions: 0, deletions: 0, patch: null };

test('an incremental review sends only the file whose diff changed, and scores the other from what it keeps', async () => {
  const first = await firstOf([fileT, fileU], blockAnswer({ 'src/t.ts': 40, 'src/u.ts': 20 }));
  const d = deps({ files: [fileT, valueFile('src/u.ts', 5)], answers: [blockAnswer({ 'src/u.ts': 30 })] });
  const r = await review({ ...input, mode: 'incremental', history: historyFrom(first, { covered: true, lastReview: LAST }) }, d);
  assert.equal(r.status, 'ok');
  assert.equal(d.model.requests.length, 1);
  assert.deepEqual([named(d, 'src/u.ts'), named(d, 'src/t.ts')], [1, 0]);
  assert.deepEqual(finals(r), { 'src/t.ts': 40, 'src/u.ts': 30 });
  assert.deepEqual(r.scores.find((one) => one.path === 'src/t.ts')!.blocks.map((one) => [one.entry?.score, one.origin]), [[40, 'earlier_run']]);
  assert.deepEqual(notSent(r), [['src/t.ts', 'covered']]);
  assert.deepEqual(r.coverage, { reviewed: ['src/u.ts'], notReviewed: [] });
  assert.deepEqual([r.mode, r.since], ['incremental', HEAD0]);
  assert.ok(d.model.requests[0]!.messages[1]!.content.endsWith(
    `\n${LAST_LINE}\n<<<data abcdef0123456789 last review overview>>>\n${LAST.overview}\n<<<end abcdef0123456789>>>`,
  ));
});

test('a moved file an earlier review scored is not sent again and keeps its score, in an incremental review and in a full one', async (t) => {
  const movedAnswer = {
    overview: 'Moves lib/x.ts and changes src/a.ts.', findings: [],
    files: [
      { path: 'lib/x.ts', change_summary: 'Moves the file.', blocks: [], score: 35, category: 'rename', reason: 'Moves the file.' },
      { path: 'src/a.ts', change_summary: 'Changes the values.', blocks: [{ id: 'B1', score: 20, category: 'fix', reason: '' }] },
    ],
  };
  const withMoved = (d: ReturnType<typeof deps>): ReturnType<typeof deps> => {
    d.source.getFileContent = async (_p, path) => (path === 'src/x.ts' || path === 'lib/x.ts' ? 'same\n' : null);
    return d;
  };
  const first = await review(input, withMoved(deps({ files: [fileA, movedAway], answers: [movedAnswer] })));
  assert.deepEqual(first.scores.find((one) => one.path === 'lib/x.ts')!.fileLevel, { score: 35, source: 'whole_file' });
  const history = historyFrom(first, { covered: true, lastReview: LAST });
  await t.test('incremental', async () => {
    const d = withMoved(deps({ files: [fileA, movedAway] }));
    const r = await review({ ...input, mode: 'incremental', history }, d);
    assert.equal(d.model.requests.length, 0);
    assert.deepEqual(r.scores.find((one) => one.path === 'lib/x.ts')!.fileLevel, { score: 35, source: 'whole_file' });
    assert.deepEqual(notSent(r), [['src/a.ts', 'covered'], ['lib/x.ts', 'covered']]);
    assert.deepEqual(r.coverage, { reviewed: [], notReviewed: [] });
  });
  await t.test('full', async () => {
    const d = withMoved(deps({ files: [fileA, movedAway], answers: [answerOnA] }));
    const r = await review({ ...input, mode: 'full', history }, d);
    assert.equal(d.model.requests.length, 1);
    assert.deepEqual([named(d, 'src/a.ts'), named(d, 'lib/x.ts')], [1, 0]);
    assert.deepEqual(r.scores.find((one) => one.path === 'lib/x.ts')!.fileLevel, { score: 35, source: 'whole_file' });
    assert.deepEqual(notSent(r), [['lib/x.ts', 'covered']]);
    assert.deepEqual(r.coverage, { reviewed: ['src/a.ts'], notReviewed: [] });
  });
});

test('the sentence of a last review that read nothing is not passed on as its overview', async () => {
  const plain = deps({ files: [fileA], answers: [answerOnA] });
  await review(input, plain);
  const d = deps({ files: [fileA], answers: [answerOnA] });
  await review({ ...input, mode: 'incremental', history: { by: 'model', lastReview: { head: HEAD0, overview: NOTHING_READ }, shown: null, files: [] } }, d);
  assert.equal(d.model.requests[0]!.messages[1]!.content, plain.model.requests[0]!.messages[1]!.content);
});

test('a last review whose overview is empty passes on no overview', async () => {
  const plain = deps({ files: [fileA], answers: [answerOnA] });
  await review(input, plain);
  const d = deps({ files: [fileA], answers: [answerOnA] });
  await review({ ...input, mode: 'recheck', history: { by: 'model', lastReview: { head: HEAD0, overview: ' \n ' }, shown: null, files: [] } }, d);
  assert.equal(d.model.requests[0]!.messages[1]!.content, plain.model.requests[0]!.messages[1]!.content);
});

test('an overview made only of characters nobody can see is not shown', async () => {
  const plain = deps({ files: [fileA], answers: [answerOnA] });
  await review(input, plain);
  const d = deps({ files: [fileA], answers: [answerOnA] });
  await review({ ...input, mode: 'incremental', history: { by: 'model', lastReview: { head: HEAD0, overview: '\u200b\u202e \u2066' }, shown: null, files: [] } }, d);
  assert.equal(d.model.requests[0]!.messages[1]!.content, plain.model.requests[0]!.messages[1]!.content);
});

test('the room the last review overview takes is counted, with threads and without', async (t) => {
  const overview = `Changes the retry delay. ${'Each try waits longer. '.repeat(40)}`;
  const history: ScoreHistory = { by: 'model', lastReview: { head: HEAD0, overview }, shown: null, files: [] };
  await t.test('without threads', async () => {
    const limits = { ...input.limits, inputTokensPerCall: fixedTokens(CONTRACT, input.pullRequest, false, overview) };
    const r = await review({ ...input, limits, mode: 'incremental', history }, deps({ files: [fileA], answers: [answerOnA] }));
    assert.deepEqual([r.status, r.failure], ['failed', { stage: 'context', code: 'budget_too_small' }]);
  });
  await t.test('with threads', async () => {
    const limits = { ...input.limits, inputTokensPerCall: fixedTokens(CONTRACT, input.pullRequest, true, overview) };
    const earlier = { head: HEAD0, threads: [earlierThread({ resolved: false })] };
    const r = await review({ ...input, limits, mode: 'incremental', history, earlier }, deps({ files: [fileA], answers: [answerOnA] }));
    assert.deepEqual([r.status, r.failure], ['failed', { stage: 'context', code: 'budget_too_small' }]);
  });
});

test('a full review shows no last review overview', async () => {
  const plain = deps({ files: [fileA], answers: [answerOnA] });
  await review(input, plain);
  const d = deps({ files: [fileA], answers: [answerOnA] });
  await review({ ...input, mode: 'full', history: { by: 'model', lastReview: LAST, shown: null, files: [] } }, d);
  assert.deepEqual(d.model.requests, plain.model.requests);
});

const fortyAdded: ChangedFile = {
  path: 'src/t.ts', previousPath: null, status: 'added', additions: 40, deletions: 0,
  patch: ['@@ -0,0 +1,40 @@', ...Array.from({ length: 40 }, (_, i) => `+const row${i} = ${i * 31};`)].join('\n'),
};
const splitInTwo = onT({ blocks: [{ id: 'B1', parts: [
  { first: 'R1', last: 'R20', score: 30, category: 'test' }, { first: 'R21', last: 'R40', score: 80, category: 'data_model', reason: 'Adds a table.' },
] }] });

test('a hunk split in the first review does not send its file again', async () => {
  const first = await firstOf([fortyAdded], splitInTwo);
  assert.deepEqual(first.scores[0]!.blocks.map((one) => [one.id, one.range]), [['B1.1', [0, 19]], ['B1.2', [20, 39]]]);
  const d = deps({ files: [fortyAdded, fileA], answers: [answerOnA] });
  const r = await review({ ...input, mode: 'incremental', history: historyFrom(first, { covered: true, lastReview: LAST }) }, d);
  assert.equal(d.model.requests.length, 1);
  assert.equal(named(d, 'src/t.ts'), 0);
  assert.deepEqual(r.scores.find((one) => one.path === 'src/t.ts')!.blocks.map((one) => [one.id, one.entry?.score]), [['B1.1', 30], ['B1.2', 80]]);
  assert.deepEqual(notSent(r), [['src/t.ts', 'covered']]);
});

test('a thread that is not due on a file left out is named in the audit and not shown', async () => {
  const first = await firstOf([fileT, fileU], blockAnswer({ 'src/t.ts': 40, 'src/u.ts': 20 }));
  const minor = earlierThread({ path: 'src/t.ts', line: 11, severity: 'minor', resolved: false });
  const d = deps({ files: [fileT, valueFile('src/u.ts', 5)], answers: [blockAnswer({ 'src/u.ts': 30 })] });
  const r = await review({
    ...input, mode: 'incremental', earlier: { head: HEAD0, threads: [minor] }, history: historyFrom(first, { covered: true, lastReview: LAST }),
  }, d);
  assert.equal(d.model.requests.length, 1);
  assert.deepEqual(d.model.requests[0]!.tools, [submitReviewTool]);
  assert.ok(!d.model.requests[0]!.messages[2]!.content.includes('### Thread'));
  assert.deepEqual(r.audit.filter((e) => e.action === 'thread_not_shown'), [{ stage: 'context', action: 'thread_not_shown', subject: 'T1', reason: 'file_covered' }]);
  assert.deepEqual([r.threadsDue, r.threadVerdicts], [0, []]);
});

test('a thread that is due keeps its covered file in an incremental review', async () => {
  const first = await firstOf([fileT, fileU], blockAnswer({ 'src/t.ts': 40, 'src/u.ts': 20 }));
  const due = earlierThread({ path: 'src/t.ts', line: 11, resolved: false });
  const d = deps({ files: [fileT, fileU], answers: [{ ...blockAnswer({ 'src/t.ts': 40 }), thread_verdicts: [{ thread_id: 'T1', verdict: 'open' }] }] });
  const r = await review({ ...input, mode: 'incremental', earlier: { head: HEAD0, threads: [due] }, history: historyFrom(first, { covered: true, lastReview: LAST }) }, d);
  assert.deepEqual([d.model.requests.length, named(d, 'src/t.ts'), named(d, 'src/u.ts')], [1, 1, 0]);
  assert.deepEqual(d.model.requests[0]!.tools, [submitReviewWithThreadsTool]);
  assert.deepEqual(notSent(r), [['src/u.ts', 'covered']]);
  assert.deepEqual(r.threadVerdicts?.map((v) => v.verdict), ['open']);
});

test('with nothing new the model is not called and the result says so', async () => {
  const first = await firstOf([fileT, fileU], blockAnswer({ 'src/t.ts': 40, 'src/u.ts': 20 }));
  const history = historyFrom(first, { covered: true, lastReview: LAST, shown: shownOf(first) });
  for (const mode of ['incremental', 'recheck'] as const) {
    const d = deps({ files: [fileT, fileU] });
    const r = await review({ ...input, mode, history }, d);
    assert.deepEqual([d.model.requests.length, r.nothingToDo, r.status, r.overview, r.mode, r.since], [0, true, 'ok', NOTHING_READ, mode, HEAD0], mode);
    assert.deepEqual(finals(r), { 'src/t.ts': 40, 'src/u.ts': 20 }, mode);
    assert.deepEqual(r.scores.map((one) => one.blocks.map((b) => b.origin)), [['earlier_run'], ['earlier_run']], mode);
    assert.deepEqual([r.findings, r.usage.calls, r.coverage], [[], 0, { reviewed: [], notReviewed: [] }], mode);
    assert.deepEqual(r.verdict, first.verdict, mode);
    assert.deepEqual(notSent(r), [['src/t.ts', 'covered'], ['src/u.ts', 'covered']], mode);
  }
});

test('a review that would say something the newest one does not is not nothing new', async (t) => {
  const first = await firstOf([fileT, fileU], blockAnswer({ 'src/t.ts': 40, 'src/u.ts': 20 }));
  const history = historyFrom(first, { covered: true, lastReview: LAST, shown: shownOf(first) });
  const quiet = (r: ReviewResult, d: ReturnType<typeof deps>): void => {
    assert.deepEqual([d.model.requests.length, r.status, r.overview, 'nothingToDo' in r], [0, 'ok', NOTHING_READ, false]);
  };
  await t.test('a new file with no diff', async () => {
    const d = deps({ files: [fileT, fileU, binaryNoPatch] });
    const r = await review({ ...input, mode: 'incremental', history }, d);
    quiet(r, d);
    assert.deepEqual(r.coverage.notReviewed, [{ path: 'logo.bin', reason: 'no_diff' }]);
    assert.equal(finals(r)['logo.bin'], 100);
  });
  await t.test('a due thread whose file left the diff', async () => {
    const d = deps({ files: [fileT, fileU] });
    const r = await review({ ...input, mode: 'incremental', earlier: { head: HEAD0, threads: [earlierThread({ path: 'src/gone.ts', resolved: false })] }, history }, d);
    quiet(r, d);
    assert.equal(r.threadsDue, 1);
  });
  await t.test('a flagged block put back into a covered file', async () => {
    const flagged = await firstOf([fileT, fileU], blockAnswer({ 'src/t.ts': 80, 'src/u.ts': 20 }));
    // The newest review was of a head where src/t.ts had left the diff: it did not list the block.
    const newest = await review({ ...input, mode: 'incremental', history: historyFrom(flagged, { covered: true, lastReview: LAST }) }, deps({ files: [fileU] }));
    assert.deepEqual(finals(newest), { 'src/u.ts': 20 });
    const d = deps({ files: [fileT, fileU] });
    const r = await review({ ...input, mode: 'incremental', history: historyFrom(flagged, { covered: true, lastReview: LAST, shown: shownOf(newest) }) }, d);
    quiet(r, d);
    assert.deepEqual(finals(r), { 'src/t.ts': 80, 'src/u.ts': 20 });
    assert.equal(r.verdict.needsHuman, true);
  });
  await t.test('a new file scored by a fixed rule', async () => {
    const d = deps({ files: [fileT, fileU, asset] });
    const r = await review({ ...input, mode: 'incremental', history }, d);
    quiet(r, d);
    assert.equal(finals(r)['logo.png'], 10);
  });
  await t.test('a history that does not say what the newest review showed', async () => {
    const d = deps({ files: [fileT, fileU] });
    const r = await review({ ...input, mode: 'incremental', history: { ...history, shown: null } }, d);
    quiet(r, d);
  });
});

test('a pull request with a file nobody can read still ends as nothing new when nothing else changed', async () => {
  const first = await firstOf([fileT, fileU, binaryNoPatch], blockAnswer({ 'src/t.ts': 40, 'src/u.ts': 20 }));
  assert.deepEqual(first.coverage.notReviewed, [{ path: 'logo.bin', reason: 'no_diff' }]);
  const d = deps({ files: [fileT, fileU, binaryNoPatch] });
  const r = await review({ ...input, mode: 'incremental', history: historyFrom(first, { covered: true, lastReview: LAST, shown: shownOf(first) }) }, d);
  assert.deepEqual([d.model.requests.length, r.nothingToDo, r.coverage.notReviewed], [0, true, [{ path: 'logo.bin', reason: 'no_diff' }]]);
});

test('a file with a stripped character on a changed line is read once, then left out, and still counts as 100', async () => {
  const hiddenFile: ChangedFile = { path: 'src/h.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+a\u202e' };
  const first = await firstOf([hiddenFile], blockAnswer({ 'src/h.ts': 5 }));
  assert.deepEqual([first.coverage.reviewed, first.scores[0]!.covered, first.scores[0]!.finalScore], [['src/h.ts'], false, 100]);
  const d = deps({ files: [hiddenFile, fileA], answers: [answerOnA] });
  const r = await review({ ...input, mode: 'incremental', history: historyFrom(first, { covered: true, lastReview: LAST }) }, d);
  assert.equal(d.model.requests.length, 1);
  assert.equal(named(d, 'src/h.ts'), 0);
  assert.deepEqual(notSent(r), [['src/h.ts', 'covered']]);
  assert.deepEqual(r.scores.find((one) => one.path === 'src/h.ts')!.fileLevel, { score: 100, source: 'hidden_characters' });
  assert.equal(finals(r)['src/h.ts'], 100);
});

test('a covered file that finds no room is scored from what it keeps and not listed as not reviewed', async (t) => {
  const [fa, fb, fc, fd, fe] = ['a', 'b', 'c', 'd', 'e'].map((n) => fileAt(`src/${n}.ts`)) as [ChangedFile, ChangedFile, ChangedFile, ChangedFile, ChangedFile];
  const first = await firstOf([fc, fd], blockAnswer({ 'src/c.ts': 30, 'src/d.ts': 40 }));
  const history = historyFrom(first, { covered: true, lastReview: LAST });
  const built = await buildFileContexts(input.pullRequest, [fa], deps({ files: [] }).source);
  const unit = unitTokens(built.contexts[0]!);
  const roomForTwo: ReviewInput = {
    ...input, mode: 'full', history,
    limits: { ...input.limits, batchesPerReview: 1, inputTokensPerCall: fixedTokens(CONTRACT, input.pullRequest) + 2 * unit + Math.floor(unit / 2) },
  };
  await t.test('the covered files keep their scores and are not listed', async () => {
    const d = deps({ files: [fc, fd, fa, fb], answers: [blockAnswer({ 'src/a.ts': 10, 'src/b.ts': 15 })] });
    const r = await review(roomForTwo, d);
    assert.equal(d.model.requests.length, 1);
    assert.deepEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'].map((p) => named(d, p)), [1, 1, 0, 0]);
    assert.deepEqual(r.coverage, { reviewed: ['src/a.ts', 'src/b.ts'], notReviewed: [] });
    assert.deepEqual(notSent(r), [['src/c.ts', 'covered'], ['src/d.ts', 'covered']]);
    assert.deepEqual(finals(r), { 'src/a.ts': 10, 'src/b.ts': 15, 'src/c.ts': 30, 'src/d.ts': 40 });
  });
  await t.test('an uncovered file that finds no room is still listed and counts as 100', async () => {
    const d = deps({ files: [fc, fd, fa, fb, fe], answers: [blockAnswer({ 'src/a.ts': 10, 'src/b.ts': 15 })] });
    const r = await review(roomForTwo, d);
    assert.deepEqual(r.coverage.notReviewed, [{ path: 'src/e.ts', reason: 'over_batch_limit' }]);
    assert.equal(finals(r)['src/e.ts'], 100);
    assert.deepEqual(notSent(r), [['src/c.ts', 'covered'], ['src/d.ts', 'covered']]);
  });
  await t.test('a thread on a covered file that finds no room is named as on a covered file and gets no verdict', async () => {
    const minor = earlierThread({ path: 'src/c.ts', severity: 'minor', resolved: false });
    const withThread: ReviewInput = {
      ...roomForTwo, earlier: { head: HEAD0, threads: [minor] },
      limits: { ...roomForTwo.limits, inputTokensPerCall: fixedTokens(CONTRACT, input.pullRequest, true) + 2 * unit + Math.floor(unit / 2) },
    };
    const d = deps({ files: [fc, fd, fa, fb], answers: [{ ...blockAnswer({ 'src/a.ts': 10, 'src/b.ts': 15 }), thread_verdicts: [{ thread_id: 'T1', verdict: 'open' }] }] });
    const r = await review(withThread, d);
    assert.deepEqual([d.model.requests.length, named(d, 'src/c.ts'), r.coverage.notReviewed], [1, 0, []]);
    assert.deepEqual(r.audit.filter((e) => e.action === 'thread_not_shown'), [{ stage: 'context', action: 'thread_not_shown', subject: 'T1', reason: 'file_covered' }]);
    assert.deepEqual(r.threadVerdicts, []);
    // The thread left the list of those shown: a verdict for it is for a thread the run does not know.
    assert.deepEqual(r.audit.filter((e) => e.action === 'verdict_dropped').map((e) => [e.subject, e.reason]), [['T1', 'unknown_thread']]);
  });
});

test('a failed review says the mode it was given', async () => {
  const history: ScoreHistory = { by: 'model', lastReview: LAST, shown: null, files: [] };
  const r = await review({ ...input, mode: 'incremental', history }, deps({ files: [], listError: new Error('github_502') }));
  assert.deepEqual([r.status, r.failure, r.mode, r.since], ['failed', { stage: 'context', code: 'github_502' }, 'incremental', HEAD0]);
});

test('every result a review ends with early says the mode and the head it was given', async () => {
  const at: ReviewInput = { ...input, mode: 'recheck', history: { by: 'model', lastReview: LAST, shown: null, files: [] } };
  const down = new ProviderError('provider', 'p', 502, null);
  const empty = await review(at, deps({ files: [] }));
  const tooSmall = await review({ ...at, limits: { ...at.limits, inputTokensPerCall: 10 } }, deps({ files: [fileA] }));
  const failed = await review(at, deps({ files: [fileA], answers: [down, down] }));
  const thrown = await review(at, deps({ files: [fileA], answers: [] }));
  for (const [name, r, overview] of [['empty', empty, 'No changes to review.'], ['too small', tooSmall, ''], ['failed', failed, ''], ['thrown', thrown, '']] as const) {
    assert.deepEqual([r.overview, r.mode, r.since], [overview, 'recheck', HEAD0], name);
  }
  // With no last review there is nothing it is measured from.
  const noLast = await review({ ...at, history: null }, deps({ files: [] }));
  assert.deepEqual([noLast.mode, 'since' in noLast], ['recheck', false]);
});

test('a full review of a later head reads every file, the uncovered ones first', async () => {
  const first = await firstOf([fileT, fileU], blockAnswer({ 'src/t.ts': 40, 'src/u.ts': 20 }));
  // The new file is as large as the others and its path sorts last: only the rule puts it first.
  const d = deps({ files: [fileT, fileU, valueFile('src/z.ts', 2)], answers: [blockAnswer({ 'src/z.ts': 10 })] });
  const r = await review({ ...input, mode: 'full', history: historyFrom(first, { covered: true, lastReview: LAST }) }, d);
  assert.equal(d.model.requests.length, 1);
  const sent = d.model.requests[0]!.messages[2]!.content;
  const order = ['## File 1/3: src/z.ts', '## File 2/3: src/t.ts', '## File 3/3: src/u.ts'].map((h) => sent.indexOf(h));
  assert.ok(order.every((n) => n >= 0));
  assert.deepEqual([...order].sort((x, y) => x - y), order);
  assert.deepEqual(r.coverage.reviewed, ['src/z.ts', 'src/t.ts', 'src/u.ts']);
  assert.deepEqual([r.mode, 'since' in r, 'nothingToDo' in r], ['full', false, false]);
  assert.ok(!d.model.requests[0]!.messages[1]!.content.includes(LAST_LINE));
});

test('a review with no mode is a full review', async () => {
  const r = await review({ ...input, history: { by: 'model', lastReview: LAST, shown: null, files: [] } }, deps({ files: [fileA], answers: [answerOnA] }));
  assert.deepEqual([r.mode, 'since' in r, 'nothingToDo' in r], ['full', false, false]);
});

// Lines changed since a file was last read.
const NOW = input.pullRequest.headSha;
const CHANGED_LINE = 'lines changed since this file was last reviewed: ';
const sixLines = (delay: number, top = ''): string => `${top}l1\nconst a = 1;\nl3\nconst delay = ${delay};\nl5\nl6\n`;
const sixPatch = (delay: number, start = 1): string =>
  [`@@ -${start},6 +${start},6 @@`, ' l1', '-const a = 0;', '+const a = 1;', ' l3', ` const delay = ${delay};`, ' l5', ' l6'].join('\n');
const sixFile = (delay: number, extra: Partial<ChangedFile> = {}): ChangedFile =>
  ({ path: 'src/t.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, patch: sixPatch(delay), ...extra });
const onLines = (...found: Array<[Severity, number]>) => ({
  overview: 'src/t.ts reviewed.', files: [],
  findings: found.map(([severity, line]) => ({ path: 'src/t.ts', side: 'RIGHT', line, severity, body: `Look at line ${line}.`, quote: '', beyond_diff: false })),
});
// The file's content at each `<sha>:<path>`; every read is recorded, and a value that is an Error is a rejection.
function contents(d: ReturnType<typeof deps>, at: Record<string, string | Error>): string[] {
  const asked: string[] = [];
  d.source.getFileContent = async (_p, path, sha) => {
    asked.push(`${sha}:${path}`);
    const value = at[`${sha}:${path}`];
    if (value instanceof Error) throw value;
    return value ?? null;
  };
  return asked;
}
const sentText = (d: ReturnType<typeof deps>): string => d.model.requests[0]!.messages[2]!.content;
const linesOf = (findings: Array<{ severity: Severity; line: number }> | undefined) => (findings ?? []).map((f) => [f.severity, f.line]);

test('an incremental review tells the model which lines changed, lists a major on an unchanged line and keeps one on a changed line', async (t) => {
  const first = await firstOf([sixFile(2)], onLines());
  const d = deps({ files: [sixFile(5)], answers: [onLines(['major', 4], ['major', 2])] });
  contents(d, { [`${HEAD0}:src/t.ts`]: sixLines(2), [`${NOW}:src/t.ts`]: sixLines(5) });
  const r = await review({ ...input, mode: 'incremental', history: historyFrom(first, { lastReview: LAST, readAt: HEAD0 }) }, d);
  await t.test('the header names the changed line', () => {
    assert.ok(sentText(d).includes(`\nwhole-file score: allowed\n${CHANGED_LINE}R4\n`));
  });
  await t.test('the major on the changed line is a finding', () => {
    assert.deepEqual(linesOf(r.findings), [['major', 4]]);
  });
  await t.test('the major on the unchanged line is listed', () => {
    assert.deepEqual(linesOf(r.unchanged), [['major', 2]]);
  });
});

test('a re-check treats every line of a file read at this head as unchanged', async (t) => {
  const first = await firstOf([sixFile(5)], onLines());
  const d = deps({ files: [sixFile(5)], answers: [onLines(['major', 4], ['blocker', 2])] });
  const r = await review({ ...input, mode: 'recheck', history: historyFrom(first, { lastReview: LAST, readAt: NOW }) }, d);
  await t.test('the header says none', () => {
    assert.ok(sentText(d).includes(`\n${CHANGED_LINE}none\n`));
  });
  await t.test('a major goes to unchanged', () => {
    assert.deepEqual(linesOf(r.unchanged), [['major', 4]]);
  });
  await t.test('a blocker stays', () => {
    assert.deepEqual(linesOf(r.findings), [['blocker', 2]]);
  });
});

test('a re-check of a file the last review listed as not reviewed measures from the review that did read it', async (t) => {
  const first = await firstOf([sixFile(2)], onLines());
  const d = deps({ files: [sixFile(5)], answers: [onLines(['major', 4])] });
  contents(d, { [`${HEAD0}:src/t.ts`]: sixLines(2), [`${NOW}:src/t.ts`]: sixLines(5) });
  const history = historyFrom(first, { lastReview: { head: NOW, overview: LAST.overview }, readAt: HEAD0 });
  const r = await review({ ...input, mode: 'recheck', history }, d);
  await t.test('the file is sent', () => {
    assert.equal(named(d, 'src/t.ts'), 1);
  });
  await t.test('the header says R4', () => {
    assert.ok(sentText(d).includes(`\n${CHANGED_LINE}R4\n`));
  });
  await t.test('the major on line 4 is a finding, not listed as unchanged', () => {
    assert.deepEqual([linesOf(r.findings), linesOf(r.unchanged)], [[['major', 4]], []]);
  });
});

test('a file no published review has read is changed throughout', async (t) => {
  const first = await firstOf([sixFile(2)], onLines());
  const d = deps({ files: [sixFile(5)], answers: [onLines(['minor', 2])] });
  const r = await review({ ...input, mode: 'incremental', history: historyFrom(first, { lastReview: LAST }) }, d);
  await t.test('the header says all', () => {
    assert.ok(sentText(d).includes(`\n${CHANGED_LINE}all\n`));
  });
  await t.test('a minor on it is kept', () => {
    assert.deepEqual(linesOf(r.findings), [['minor', 2]]);
  });
});

test('the same block at other line numbers is not changed', async () => {
  const first = await firstOf([sixFile(2)], onLines());
  const top = Array.from({ length: 10 }, (_, i) => `top ${i}\n`).join('');
  const d = deps({ files: [sixFile(2, { patch: sixPatch(2, 11) })], answers: [onLines()] });
  contents(d, { [`${HEAD0}:src/t.ts`]: sixLines(2), [`${NOW}:src/t.ts`]: sixLines(2, top) });
  await review({ ...input, mode: 'incremental', history: historyFrom(first, { lastReview: LAST, readAt: HEAD0 }) }, d);
  assert.ok(sentText(d).includes(`\n${CHANGED_LINE}R1-R10\n`));
});

test('a file that cannot be read at the earlier head counts as changed throughout', async (t) => {
  const first = await firstOf([sixFile(2)], onLines());
  const d = deps({ files: [sixFile(5, { status: 'renamed', previousPath: 'src/old.ts' })], answers: [onLines()] });
  const asked = contents(d, { [`${NOW}:src/t.ts`]: sixLines(5) });
  await review({ ...input, mode: 'incremental', history: historyFrom(first, { lastReview: LAST, readAt: HEAD0 }) }, d);
  await t.test('it is looked for at its path and at its previous path', () => {
    assert.deepEqual(asked.filter((key) => key.startsWith(HEAD0)), [`${HEAD0}:src/t.ts`, `${HEAD0}:src/old.ts`]);
  });
  await t.test('the header says all', () => {
    assert.ok(sentText(d).includes(`\n${CHANGED_LINE}all\n`));
  });
});

test('a removed file read before has no changed line but the removed lines of a new hunk', async (t) => {
  const gone = (patch: string[]): ChangedFile => ({ path: 'src/gone.ts', previousPath: null, status: 'removed', additions: 0, deletions: 4, patch: patch.join('\n') });
  const hunkOne = ['@@ -1,2 +0,0 @@', '-const a = 1;', '-const b = 2;'];
  const answer = { overview: 'src/gone.ts is removed.', findings: [], files: [] };
  const first = await firstOf([gone(hunkOne)], answer);
  const d = deps({ files: [gone([...hunkOne, '@@ -10,2 +0,0 @@', '-const c = 3;', '-const d = 4;'])], answers: [answer] });
  const asked = contents(d, {});
  await review({ ...input, mode: 'incremental', history: historyFrom(first, { lastReview: LAST, readAt: HEAD0 }) }, d);
  await t.test('no content is read for it', () => {
    assert.deepEqual(asked.filter((key) => key.endsWith(':src/gone.ts')), []);
  });
  await t.test('the header names the removed lines of the new hunk', () => {
    assert.ok(sentText(d).includes(`\n${CHANGED_LINE}removed lines of B2\n`));
  });
});

test('a failed read of the earlier content fails an incremental review before any model call', async () => {
  const first = await firstOf([sixFile(2)], onLines());
  const d = deps({ files: [sixFile(5)], answers: [onLines()] });
  contents(d, { [`${HEAD0}:src/t.ts`]: new Error('github_502'), [`${NOW}:src/t.ts`]: sixLines(5) });
  const r = await review({ ...input, mode: 'incremental', history: historyFrom(first, { lastReview: LAST, readAt: HEAD0 }) }, d);
  assert.deepEqual([r.status, r.failure, r.usage.calls, d.model.requests.length], ['failed', { stage: 'context', code: 'github_502' }, 0, 0]);
});

test('a full review of a later head counts its blocking findings on unchanged lines and changes nothing else', async (t) => {
  const first = await firstOf([sixFile(2)], onLines());
  const d = deps({ files: [sixFile(5)], answers: [onLines(['blocker', 2], ['major', 4], ['minor', 3])] });
  contents(d, { [`${HEAD0}:src/t.ts`]: sixLines(2), [`${NOW}:src/t.ts`]: sixLines(5) });
  const r = await review({ ...input, mode: 'full', history: historyFrom(first, { lastReview: LAST, readAt: HEAD0 }) }, d);
  await t.test('the count is the blocker on an unchanged line', () => {
    assert.equal(r.blockingOnUnchanged, 1);
  });
  await t.test('the findings are as returned', () => {
    assert.deepEqual([linesOf(r.findings), 'unchanged' in r], [[['blocker', 2], ['major', 4], ['minor', 3]], false]);
  });
  await t.test('no header line', () => {
    assert.ok(!sentText(d).includes(CHANGED_LINE));
  });
});

test('a failed read while counting leaves the count out and the review whole', async (t) => {
  const first = await firstOf([sixFile(2)], onLines());
  const d = deps({ files: [sixFile(5)], answers: [onLines(['blocker', 2])] });
  contents(d, { [`${HEAD0}:src/t.ts`]: new Error('github_502'), [`${NOW}:src/t.ts`]: sixLines(5) });
  const r = await review({ ...input, mode: 'full', history: historyFrom(first, { lastReview: LAST, readAt: HEAD0 }) }, d);
  await t.test('the review is ok and keeps its findings', () => {
    assert.deepEqual([r.status, linesOf(r.findings)], ['ok', [['blocker', 2]]]);
  });
  await t.test('the count is absent', () => {
    assert.equal('blockingOnUnchanged' in r, false);
  });
  await t.test('the audit names the failed count', () => {
    assert.deepEqual(r.audit.filter((e) => e.action === 'unchanged_count_failed'),
      [{ stage: 'reconcile', action: 'unchanged_count_failed', subject: 'src/t.ts', reason: 'github_502' }]);
  });
});

test('a first review has no such count', async () => {
  const r = await review(input, deps({ files: [sixFile(5)], answers: [onLines(['blocker', 2])] }));
  assert.deepEqual([r.status, 'blockingOnUnchanged' in r], ['ok', false]);
});

test('a new hunk that only adds lines is not named for its removed lines, and a new hunk with a removed line is', async () => {
  const first = await firstOf([sixFile(2)], onLines());
  const patch = ['@@ -1,2 +1,3 @@', ' a1', '+new2', ' a3', '@@ -8,3 +9,3 @@', ' b9', '-old', '+b10', ' b11'].join('\n');
  const d = deps({ files: [sixFile(2, { patch, additions: 2 })], answers: [onLines()] });
  contents(d, {
    [`${HEAD0}:src/t.ts`]: 'a1\na3\nl4\nl5\nl6\nl7\nl8\nb9\nold\nb11\n',
    [`${NOW}:src/t.ts`]: 'a1\nnew2\na3\nl4\nl5\nl6\nl7\nl8\nb9\nb10\nb11\n',
  });
  await review({ ...input, mode: 'incremental', history: historyFrom(first, { lastReview: LAST, readAt: HEAD0 }) }, d);
  assert.ok(sentText(d).includes(`\n${CHANGED_LINE}R2, R10; removed lines of B2\n`));
});

test('a major the model raised on a changed line outside the diff is not hidden when it is placed on a neighbouring line', async (t) => {
  const first = await firstOf([sixFile(5)], onLines());
  const d = deps({ files: [sixFile(5)], answers: [onLines(['major', 9])] });
  contents(d, { [`${HEAD0}:src/t.ts`]: `${sixLines(5)}l7\nl8\nprChanged9\n`, [`${NOW}:src/t.ts`]: `${sixLines(5)}l7\nl8\nbase9\n` });
  const r = await review({ ...input, mode: 'incremental', history: historyFrom(first, { lastReview: LAST, readAt: HEAD0 }) }, d);
  await t.test('the header says R9', () => {
    assert.ok(sentText(d).includes(`\n${CHANGED_LINE}R9\n`));
  });
  await t.test('the major is a finding, placed on 6', () => {
    assert.deepEqual([r.findings.map((f) => [f.severity, f.line, f.requestedLine]), linesOf(r.unchanged)], [[['major', 6, 9]], []]);
  });
});

test('in a full review a major placed on an unchanged line is not counted when the line the model named changed', async () => {
  const first = await firstOf([sixFile(5)], onLines());
  const d = deps({ files: [sixFile(5)], answers: [onLines(['major', 9])] });
  contents(d, { [`${HEAD0}:src/t.ts`]: `${sixLines(5)}l7\nl8\nprChanged9\n`, [`${NOW}:src/t.ts`]: `${sixLines(5)}l7\nl8\nbase9\n` });
  const r = await review({ ...input, mode: 'full', history: historyFrom(first, { lastReview: LAST, readAt: HEAD0 }) }, d);
  assert.deepEqual(r.findings.map((f) => [f.severity, f.line, f.requestedLine]), [['major', 6, 9]]);
  assert.equal(r.blockingOnUnchanged, 0);
});

test('a file whose present content cannot be read counts as changed throughout', async () => {
  const first = await firstOf([sixFile(2)], onLines());
  const d = deps({ files: [sixFile(5)], answers: [onLines()] });
  contents(d, { [`${HEAD0}:src/t.ts`]: sixLines(2) });
  await review({ ...input, mode: 'incremental', history: historyFrom(first, { lastReview: LAST, readAt: HEAD0 }) }, d);
  assert.ok(sentText(d).includes(`\n${CHANGED_LINE}all\n`));
});

test('two contents too different to compare count as changed throughout', async () => {
  const many = (count: number, prefix: string): string => Array.from({ length: count }, (_, i) => `${prefix} ${i}`).join('\n') + '\n';
  const first = await firstOf([sixFile(2)], onLines());
  const d = deps({ files: [sixFile(5)], answers: [onLines()] });
  contents(d, { [`${HEAD0}:src/t.ts`]: many(6000, 'old'), [`${NOW}:src/t.ts`]: many(6000, 'new') });
  await review({ ...input, mode: 'incremental', history: historyFrom(first, { lastReview: LAST, readAt: HEAD0 }) }, d);
  assert.ok(sentText(d).includes(`\n${CHANGED_LINE}all\n`));
});

test('line endings are made alike before the two contents are compared', async () => {
  const first = await firstOf([sixFile(2)], onLines());
  const d = deps({ files: [sixFile(5)], answers: [onLines()] });
  contents(d, { [`${HEAD0}:src/t.ts`]: sixLines(2).replaceAll('\n', '\r\n'), [`${NOW}:src/t.ts`]: sixLines(5) });
  await review({ ...input, mode: 'incremental', history: historyFrom(first, { lastReview: LAST, readAt: HEAD0 }) }, d);
  assert.ok(sentText(d).includes(`\n${CHANGED_LINE}R4\n`));
});

test('the packer counts the line of what changed', async () => {
  const first = await firstOf([sixFile(2)], onLines());
  const at = { [`${HEAD0}:src/t.ts`]: sixLines(2), [`${NOW}:src/t.ts`]: sixLines(5) };
  const probe = deps({ files: [sixFile(5)] });
  contents(probe, at);
  const [without] = (await buildFileContexts(input.pullRequest, [sixFile(5)], probe.source)).contexts;
  // Room for the file as it is without the line, and not with it: the packer must cut the full file to make room.
  const limits = { ...input.limits, inputTokensPerCall: fixedTokens(CONTRACT, input.pullRequest, false, LAST.overview) + unitTokens(without!) };
  const d = deps({ files: [sixFile(5)], answers: [onLines()] });
  contents(d, at);
  const r = await review({ ...input, limits, mode: 'incremental', history: historyFrom(first, { lastReview: LAST, readAt: HEAD0 }) }, d);
  assert.ok(without!.full !== null);
  assert.deepEqual(r.audit.filter((e) => e.action === 'full_file_cut').map((e) => e.subject), ['src/t.ts']);
});

test('a full review with a history and no last review has no count', async () => {
  const first = await firstOf([sixFile(2)], onLines());
  const d = deps({ files: [sixFile(5)], answers: [onLines(['blocker', 2])] });
  contents(d, { [`${HEAD0}:src/t.ts`]: sixLines(2), [`${NOW}:src/t.ts`]: sixLines(5) });
  const r = await review({ ...input, mode: 'full', history: historyFrom(first, { readAt: HEAD0 }) }, d);
  assert.deepEqual([r.status, linesOf(r.findings), 'blockingOnUnchanged' in r], ['ok', [['blocker', 2]], false]);
});

// A file is settled only where a published review of this pull request read it as it is.
const WHOLE = 'whole-file score: allowed';
const NOT_ALLOWED = 'whole-file score: not allowed';
const twoAndWhole = (blocks: Record<string, number>, whole?: number) => ({
  overview: 'src/t.ts reviewed.', findings: [],
  files: [{
    path: 'src/t.ts', change_summary: 'Changes the delay and the tries.',
    blocks: Object.entries(blocks).map(([id, score]) => ({ id, score, category: 'fix', reason: '' })),
    ...(whole === undefined ? {} : { score: whole, category: 'business_rule', reason: 'The two changes together decide how long a refund waits.' }),
  }],
});
const lookupOf = (first: ReviewResult) => (blocks: Array<{ path: string; hash: string }>) => Promise.resolve(blocks.flatMap((w) => first.scores
  .filter((f) => f.path === w.path).flatMap((f) => f.blocks.filter((one) => one.hash === w.hash && one.entry !== null))
  .map((one) => ({ path: w.path, hash: w.hash, entry: one.entry! }))));

test('the same change opened as another pull request may still take its whole-file score', async () => {
  const first = await firstOf([fileTwo], twoAndWhole({ B1: 20, B2: 20 }, 90));
  assert.equal(first.scores[0]!.finalScore, 90);
  const d = deps({ files: [fileTwo], answers: [twoAndWhole({}, 95)] });
  d.reusableScores = lookupOf(first);
  const r = await review(input, d);
  assert.deepEqual(headersOf(d), ['### Block B1 (2 changed lines, scored)', '### Block B2 (2 changed lines, scored)']);
  assert.ok(sentText(d).includes(`\n${WHOLE}\n`));
  assert.ok(!sentText(d).includes(NOT_ALLOWED));
  assert.deepEqual(r.scores[0]!.blocks.map((one) => [one.entry?.score, one.origin]), [[20, 'other_pull_request'], [20, 'other_pull_request']]);
  assert.deepEqual([r.scores[0]!.fileLevel, r.scores[0]!.finalScore], [{ score: 95, source: 'whole_file' }, 95]);
});

test('a push that adds a block another pull request scored leaves the file open to a whole-file score', async () => {
  const first = await firstOf([delayFile(2)], onT({ blocks: [{ id: 'B1', score: 20, category: 'fix', reason: '' }] }));
  const elsewhere = await firstOf([fileTwo], twoAndWhole({ B1: 20, B2: 15 }));
  const d = deps({ files: [fileTwo], answers: [twoAndWhole({}, 90)] });
  d.reusableScores = lookupOf(elsewhere);
  const r = await review({ ...input, mode: 'full', history: historyFrom(first, { covered: true, lastReview: LAST }) }, d);
  assert.deepEqual(headersOf(d), ['### Block B1 (2 changed lines, scored)', '### Block B2 (2 changed lines, scored)']);
  assert.ok(sentText(d).includes(`\n${WHOLE}\n`));
  assert.deepEqual(r.scores[0]!.blocks.map((one) => [one.entry?.score, one.origin]), [[20, 'earlier_run'], [15, 'other_pull_request']]);
  assert.deepEqual([r.scores[0]!.fileLevel, r.scores[0]!.finalScore], [{ score: 90, source: 'whole_file' }, 90]);
});

test('a reviewed file moved to another directory with the same change is read once where it now stands', async () => {
  const before: ChangedFile = { path: 'src/util/x.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, patch: delayPatch(2) };
  const after: ChangedFile = { path: 'app/api/x.ts', previousPath: 'src/util/x.ts', status: 'renamed', additions: 1, deletions: 1, patch: delayPatch(2) };
  const onX = (path: string, file: Record<string, unknown>) => ({ overview: `${path} reviewed.`, findings: [], files: [{ path, change_summary: 'Moves the file.', blocks: [], ...file }] });
  const first = await firstOf([before], onX('src/util/x.ts', { blocks: [{ id: 'B1', score: 20, category: 'fix', reason: '' }] }));
  const d = deps({ files: [after], answers: [onX('app/api/x.ts', { score: 95, category: 'security', reason: 'The code is now served on a public route.' })] });
  const second = await review({ ...input, mode: 'incremental', history: historyFrom(first, { covered: true, lastReview: LAST, readAt: HEAD0 }) }, d);
  assert.equal(d.model.requests.length, 1);
  assert.deepEqual(headersOf(d), ['### Block B1 (2 changed lines, scored)']);
  assert.ok(sentText(d).includes(`\n${WHOLE}\n`));
  assert.deepEqual([second.scores[0]!.blocks[0]!.entry?.score, second.scores[0]!.finalScore], [20, 95]);
  const third = deps({ files: [after] });
  const r = await review({ ...input, mode: 'incremental', history: historyFrom(second, { covered: true, lastReview: LAST, readAt: NOW }) }, third);
  assert.equal(third.model.requests.length, 0);
  assert.deepEqual(notSent(r), [['app/api/x.ts', 'covered']]);
  assert.equal(r.scores[0]!.finalScore, 95);
});

test('a new file a later push renames keeps its scores', async () => {
  const billing = (path: string): ChangedFile => ({ path, previousPath: null, status: 'added', additions: 1, deletions: 1, patch: delayPatch(2) });
  const onBilling = (path: string, score: number) => ({ overview: `${path} reviewed.`, findings: [], files: [{ path, change_summary: 'Adds billing.', blocks: [{ id: 'B1', score, category: 'business_rule', reason: 'Charges the card.' }] }] });
  const first = await firstOf([billing('src/billing.ts')], onBilling('src/billing.ts', 92));
  const d = deps({ files: [billing('src/billing2.ts')], answers: [onBilling('src/billing2.ts', 10)] });
  const r = await review({ ...input, mode: 'full', history: historyFrom(first, { covered: true, lastReview: LAST }) }, d);
  assert.deepEqual(headersOf(d), ['### Block B1 (2 changed lines, scored)']);
  assert.deepEqual(r.scores[0]!.blocks.map((one) => [one.entry?.score, one.origin]), [[92, 'earlier_run']]);
  assert.equal(r.scores[0]!.finalScore, 92);
});

test('a block the whole-file score stood for is still stood for at the next review', async () => {
  const first = await firstOf([fileTwo], twoAndWhole({}, 60));
  assert.deepEqual([first.scores[0]!.blocks.map((one) => one.entry), first.scores[0]!.finalScore, first.scores[0]!.covered], [[null, null], 60, true]);
  const d = deps({ files: [fileTwo] });
  const r = await review({ ...input, mode: 'incremental', history: historyFrom(first, { covered: true, lastReview: LAST }) }, d);
  assert.equal(d.model.requests.length, 0);
  assert.deepEqual(notSent(r), [['src/t.ts', 'covered']]);
  assert.deepEqual([r.scores[0]!.blocks.map((one) => one.entry), r.scores[0]!.fileLevel, r.scores[0]!.finalScore], [[null, null], { score: 60, source: 'whole_file' }, 60]);
});

test('a new file the model scored as a whole only keeps that score when a later push renames it', async () => {
  const billing = (path: string): ChangedFile => ({ path, previousPath: null, status: 'added', additions: 1, deletions: 1, patch: delayPatch(2) });
  const asWhole = (path: string, score: number) => ({ overview: `${path} reviewed.`, findings: [], files: [{ path, change_summary: 'Adds billing.', blocks: [], score, category: 'business_rule', reason: 'Charges the card.' }] });
  const first = await firstOf([billing('src/billing.ts')], asWhole('src/billing.ts', 92));
  const d = deps({ files: [billing('src/billing2.ts')], answers: [asWhole('src/billing2.ts', 10)] });
  const r = await review({ ...input, mode: 'full', history: historyFrom(first, { covered: true, lastReview: LAST }) }, d);
  assert.deepEqual(headersOf(d), ['### Block B1 (2 changed lines, scored)']);
  assert.deepEqual([r.scores[0]!.blocks.map((one) => one.entry), r.scores[0]!.fileLevel, r.scores[0]!.finalScore], [[null], { score: 92, source: 'whole_file' }, 92]);
});

test('a copy of a new file keeps its scores, and keeps them once the original is gone', async () => {
  const added = (path: string): ChangedFile => ({ path, previousPath: null, status: 'added', additions: 1, deletions: 1, patch: delayPatch(2) });
  const onFile = (path: string, blocks: unknown[] = []) => ({ overview: `${path} reviewed.`, findings: [], files: [{ path, change_summary: 'Adds billing.', blocks }] });
  const first = await firstOf([added('a.ts')], onFile('a.ts', [{ id: 'B1', score: 92, category: 'business_rule', reason: 'Charges the card.' }]));
  const d = deps({ files: [added('a.ts'), added('b.ts')], answers: [onFile('b.ts', [{ id: 'B1', score: 10, category: 'fix', reason: '' }])] });
  const second = await review({ ...input, mode: 'incremental', history: historyFrom(first, { covered: true, lastReview: LAST }) }, d);
  assert.deepEqual([d.model.requests.length, named(d, 'b.ts'), headersOf(d)], [1, 1, ['### Block B1 (2 changed lines, scored)']]);
  assert.deepEqual(finals(second), { 'a.ts': 92, 'b.ts': 92 });
  const third = deps({ files: [added('b.ts')] });
  const r = await review({ ...input, mode: 'incremental', history: historyFrom(second, { covered: true, lastReview: LAST }) }, third);
  assert.equal(third.model.requests.length, 0);
  assert.deepEqual(finals(r), { 'b.ts': 92 });
});

test('the reason of a score taken from another pull request is dropped where it is taken', async () => {
  const d = deps({ files: [fileTwo], answers: [answerOnT] });
  d.reusableScores = () => Promise.resolve([
    { path: 'src/t.ts', hash: hashB1!, entry: { score: 30, category: 'fix', reason: 'See [the notes](https://example.test/x).' } },
    { path: 'src/t.ts', hash: hashB2!, entry: { score: 20, category: 'fix', reason: 'See ![x](https://example.test/i.png).' } },
  ]);
  const taken = await review(input, d);
  assert.deepEqual(taken.scores[0]!.blocks.map((one) => [one.entry?.score, one.entry?.reason, one.origin]), [[30, '', 'other_pull_request'], [20, '', 'other_pull_request']]);
  const later = await review({ ...input, history: historyFrom(taken, { covered: true }) }, deps({ files: [fileTwo], answers: [answerOnT] }));
  assert.deepEqual(later.scores[0]!.blocks.map((one) => one.origin), ['earlier_run', 'earlier_run']);
  assert.ok(!JSON.stringify(later).includes('example.test'));
});
