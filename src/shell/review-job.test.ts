import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from '../db/testing.ts';
import type { Db } from '../db/types.ts';
import { enqueueJob, claimJob, finishJob, getJob, requeueJob, unfinishedJobs } from '../db/jobs.ts';
import type { Job } from '../db/jobs.ts';
import { savePullRequest } from '../db/pull-requests.ts';
import { listRuns, markPublished, recordRun } from '../db/review-runs.ts';
import { recordBlockScores } from '../db/block-scores.ts';
import type { RunRecord } from '../db/review-runs.ts';
import { listComments, recordComments } from '../db/review-comments.ts';
import type { StoredComment } from '../db/review-comments.ts';
import type { RepoSettings } from '../config/load.ts';
import type { ForgeWriter, LivePullRequest, PostedComment, ReviewThread, Source } from '../forge/types.ts';
import { review } from '../engine/review.ts';
import { renderReview } from '../engine/render/body.ts';
import { shownOf } from '../engine/score/shown.ts';
import type { BlockScore } from '../engine/score/types.ts';
import { SUBMIT_REVIEW } from '../engine/model/submit-review.ts';
import type { ModelClient, ModelResponse, ReviewDeps, ReviewInput, ReviewResult, ThreadVerdict } from '../engine/types.ts';
import { runReviewJob } from './review-job.ts';
import type { ReviewJobDeps } from './review-job.ts';

const REF = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;
const at = (seconds: number): string => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000).toISOString();

const AUTOMATIC = { trigger: 'automatic' as const, requestedBy: null, commentId: null, association: null, installation: null };

let db: Db;
beforeEach(async () => { db = await testDb(); });
afterEach(async () => { await db.close(); });

const LIMITS = { inputTokensPerCall: 200_000, batchesPerReview: 6, modelTimeoutSeconds: 240 };
const SETTINGS: RepoSettings = { primaryBranches: ['main'], scoreThreshold: 70, ignoredAuthors: ['dependabot[bot]'], baseBranches: [], newHead: null };
const LIVE: LivePullRequest = {
  info: { ref: REF, title: 'Add things', description: '', author: 'octo-dev', baseBranch: 'main', headBranch: 'feat', baseSha: 'merge000', headSha: 'h1', draft: false },
  state: 'open',
};
/** The same pull request against another base: a test that runs two reviews in one database uses it for the second, which would otherwise be dropped as already reviewed. */
const OTHER_BASE: LivePullRequest = { ...LIVE, info: { ...LIVE.info, baseSha: 'merge999' } };
const USAGE = { calls: 2, inputTokens: 1000, outputTokens: 200, cachedTokens: 50, cost: 0.5 };
const NO_CALLS = { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0 };
/** A result as the engine returns it for a finished review, with one finding. */
const okResult = (over: Partial<ReviewResult> = {}): ReviewResult => ({
  status: 'ok', failure: null, mode: 'full', overview: 'Looks fine.',
  findings: [{ path: 'a.ts', side: 'RIGHT', line: 3, severity: 'minor', body: 'A note.', quote: 'x', requestedLine: null }],
  unplaced: [], beyondDiff: [], coverage: { reviewed: ['a.ts'], notReviewed: [] }, usage: USAGE, models: ['m'], providers: [],
  dependencies: { model: 'ok' }, audit: [], scores: [], verdict: { threshold: 70, needsHuman: false, highest: 35 }, teamFileInvalid: null, ...over,
});
const failed = (stage: 'context' | 'model', code: string, over: Partial<ReviewResult> = {}): ReviewResult => okResult({
  status: 'failed', failure: { stage, code }, overview: '', findings: [], coverage: { reviewed: [], notReviewed: [] },
  verdict: { threshold: 70, needsHuman: true, highest: 100 }, ...over,
});
/** A finished review with one block at or above the threshold: its body links that block's lines. */
const flaggedResult = (): ReviewResult => okResult({
  scores: [{
    path: 'a.ts', previousPath: null, diffHash: 'd', changeSummary: '', changedLines: 1, wholeFile: null, fileLevel: null, finalScore: 80, covered: true,
    blocks: [{
      id: 'B1', hunk: 'B1', hunkHash: 'h', hash: 'h', changedLines: 1, span: { side: 'RIGHT', first: 3, last: 3 },
      lines: { old: [], new: [] } as unknown as BlockScore['lines'], entry: { score: 80, category: 'calculation', reason: '' },
    }],
  }],
  verdict: { threshold: 70, needsHuman: true, highest: 80 },
});
/** What the git service answers for the inline comments of okResult's review. */
const POSTED: PostedComment[] = [{
  id: '9001', path: 'a.ts', side: 'RIGHT', line: 3,
  body: renderReview(okResult(), { trigger: 'automatic', requestedBy: null, lineUrl: () => 'https://git.example.test/x', inline: true }).comments[0]!.body,
}];

interface Options {
  live?: LivePullRequest | Error | null; result?: ReviewResult; settings?: RepoSettings; stored?: boolean;
  recordFailures?: number; lostAnswer?: boolean; failQuery?: string;
  /** The job is on its second start: claimed, put back and claimed again. */
  secondStart?: boolean;
  /** The time the clock reads once the review has been called; at(0) before. */
  afterReview?: string;
  dryRun?: boolean;
  /** What listOwnReviews answers, one answer for each call, the last one repeated; an Error rejects. [] when none is given. */
  own?: Array<Array<{ id: string; commit: string }> | Error>;
  /** What each publishReview answers, in turn; { id: '501' } once they are used up. */
  posts?: Array<{ id: string } | Error>;
  /** What listReviewComments answers. */
  posted?: PostedComment[] | Error | null;
  /** What readPullRequest answers from its second call on. */
  liveAfter?: LivePullRequest;
  /** The job's head and the live head. */
  head?: string;
  /** Another pull request number, with its own stored facts. */
  pullRequest?: number;
  /** Claims that job again; nothing is enqueued. */
  reuseJob?: number;
  /** The first n transactions that hold markPublished's statement reject. */
  markFailures?: number;
  /** lineUrl throws, and the review's body needs a link. */
  renderThrows?: boolean;
  /** The job is a manual one, from a /review comment. */
  manual?: boolean;
  /** The association of a manual job's requester; 'member' when not given. */
  association?: string | null;
  /** react and comment reject. */
  writeFails?: boolean;
  /** The first n statements that finish the job reject. */
  finishFailures?: number;
  /** What listThreads answers, one answer for each call, the last one repeated; an Error rejects. [] when none is given. */
  threads?: Array<ReviewThread[] | Error>;
  /** What canResolve answers; true when not given. */
  canResolve?: boolean;
  /** replyToThread, editThreadComment and resolveThread reject. */
  threadWriteFails?: boolean;
}

async function harness(options: Options = {}) {
  const ref = options.pullRequest === undefined ? REF : { ...REF, number: options.pullRequest };
  const head = options.head ?? 'h1';
  if (options.stored !== false) {
    await savePullRequest(db, {
      ref, author: 'octo-dev', authorIsBot: false, baseBranch: 'main', headBranch: 'feat', headSha: head, draft: false, state: 'open',
      mergedAt: null, closedAt: null, mergeCommit: null, installation: '99', updatedAt: at(0),
    });
  }
  let job: Job;
  if (options.reuseJob !== undefined) {
    const again = (await getJob(db, options.reuseJob))!;
    job = (await claimJob(db, again.id, again.runAt))!;
  } else if (options.manual === true) {
    await enqueueJob(db, {
      ref, reason: 'command', headSha: '', runAt: at(0), now: at(0), delivery: 'd1', replace: true, trigger: 'manual', requestedBy: 'octo-lead', commentId: '31',
      association: 'association' in options ? options.association ?? null : 'member', installation: '99',
    });
    const jobs = await unfinishedJobs(db);
    job = (await claimJob(db, jobs.find((j) => j.status === 'pending' && j.ref.number === ref.number)!.id, at(0)))!;
  } else {
    await enqueueJob(db, { ref, reason: 'opened', headSha: head, runAt: at(0), now: at(0), delivery: 'd1', replace: true, ...AUTOMATIC });
    const jobs = await unfinishedJobs(db);
    job = (await claimJob(db, jobs.find((j) => j.status === 'pending' && j.ref.number === ref.number)!.id, at(0)))!;
  }
  if (options.secondStart === true) {
    await requeueJob(db, job.id, at(0), at(0), false);
    job = (await claimJob(db, job.id, at(0)))!;
  }
  const inputs: ReviewInput[] = [];
  /** The engine's dependencies each review was given, beside its input. */
  const engines: ReviewDeps[] = [];
  const healthCalls: Array<'auth' | 'no_credit' | null> = [];
  const healthTimes: string[] = [];
  let reviewCalled = false;
  const spendCalls: unknown[] = [];
  const slept: number[] = [];
  const logged: Array<Record<string, unknown>> = [];
  const live = options.live === undefined ? (head === 'h1' ? LIVE : { ...LIVE, info: { ...LIVE.info, headSha: head } }) : options.live;
  let reads = 0;
  const writes: unknown[][] = [];
  const posts = [...(options.posts ?? [])];
  const owns = [...(options.own ?? [])];
  const threadAnswers = [...(options.threads ?? [])];
  const threadWrite = (): void => { if (options.threadWriteFails === true) throw new Error('github_502'); };
  const writer: ForgeWriter = {
    publishReview: async (_ref, _installation, draft) => {
      writes.push(['publishReview', draft.commit, draft.body, draft.comments.length]);
      const next = posts.shift() ?? { id: '501' };
      if (next instanceof Error) throw next;
      return next;
    },
    listOwnReviews: async () => {
      writes.push(['listOwnReviews']);
      const own = (owns.length > 1 ? owns.shift() : owns[0]) ?? [];
      if (own instanceof Error) throw own;
      return own;
    },
    listReviewComments: async (_ref, _installation, reviewId) => {
      writes.push(['listReviewComments', reviewId]);
      const posted = options.posted === undefined ? POSTED : options.posted;
      if (posted instanceof Error) throw posted;
      return posted;
    },
    react: async (_ref, _installation, commentId, reaction) => {
      writes.push(['react', commentId, reaction]);
      if (options.writeFails === true) throw new Error('github_502');
    },
    comment: async (_ref, _installation, body) => {
      writes.push(['comment', body]);
      if (options.writeFails === true) throw new Error('github_502');
    },
    listThreads: async () => {
      writes.push(['listThreads']);
      const threads = (threadAnswers.length > 1 ? threadAnswers.shift() : threadAnswers[0]) ?? [];
      if (threads instanceof Error) throw threads;
      return threads;
    },
    replyToThread: async (_installation, threadId, body) => { writes.push(['replyToThread', threadId, body]); threadWrite(); },
    editThreadComment: async (_installation, node, body) => { writes.push(['editThreadComment', node, body]); threadWrite(); },
    resolveThread: async (_installation, threadId) => { writes.push(['resolveThread', threadId]); threadWrite(); },
  };
  let finishFailuresLeft = options.finishFailures ?? 0;
  /** Whether this statement is one that finishes the job, and is to reject. */
  const finishFails = (text: string): boolean => {
    if (finishFailuresLeft > 0 && text.includes('set status = $2, outcome = $3')) { finishFailuresLeft -= 1; return true; }
    return false;
  };
  let markFailuresLeft = options.markFailures ?? 0;
  let failuresLeft = options.recordFailures ?? 0;
  let lost = options.lostAnswer === true;
  let queryFails = options.failQuery !== undefined;
  const wrapped: Db = {
    query: (text, params) => {
      if (queryFails && text.includes(options.failQuery!)) { queryFails = false; return Promise.reject(new Error('Something private broke')); }
      if (finishFails(text)) return Promise.reject(new Error('db_down'));
      return db.query(text, params);
    },
    script: (sql) => db.script(sql),
    close: () => db.close(),
    transaction: async (work) => {
      if (failuresLeft > 0) { failuresLeft -= 1; throw new Error('db_down'); }
      const done = await db.transaction((tx) => work({
        query: (text, params) => {
          if (markFailuresLeft > 0 && text.includes('set published = true')) { markFailuresLeft -= 1; return Promise.reject(new Error('db_down')); }
          if (finishFails(text)) return Promise.reject(new Error('db_down'));
          return tx.query(text, params);
        },
        script: (sql) => tx.script(sql),
        close: () => tx.close(),
        transaction: (inner) => tx.transaction(inner),
      }));
      if (lost) { lost = false; throw new Error('db_down'); }
      return done;
    },
  };
  const deps: ReviewJobDeps = {
    db: wrapped,
    forge: {
      readPullRequest: () => {
        reads += 1;
        const answer = reads > 1 && options.liveAfter !== undefined ? options.liveAfter : live;
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      },
      sourceFor: () => Promise.resolve({} as Source),
    },
    clock: () => new Date(reviewCalled && options.afterReview !== undefined ? options.afterReview : at(0)),
    log: (e) => { logged.push(e); },
    sleep: (ms) => { slept.push(ms); return Promise.resolve(); },
    settingsFor: () => options.settings ?? SETTINGS,
    limits: LIMITS,
    dryRun: options.dryRun ?? true,
    writer,
    engineDeps: () => ({}) as ReviewDeps,
    review: (input, engine) => {
      inputs.push(input);
      engines.push(engine);
      reviewCalled = true;
      return Promise.resolve(options.result ?? (options.renderThrows === true ? flaggedResult() : okResult({ mode: input.mode ?? 'full' })));
    },
    lineUrl: () => { if (options.renderThrows === true) throw new Error('no_link'); return 'https://git.example.test/x'; },
    commentUrl: (_ref, commentId) => `https://git.example.test/c/${commentId}`,
    canResolve: () => Promise.resolve(options.canResolve ?? true),
    health: { reviewed: (code, when) => { healthCalls.push(code); healthTimes.push(when.toISOString()); } },
    spend: { noteRun: (usage) => { spendCalls.push(usage); } },
  };
  return { job, deps, inputs, engines, healthCalls, healthTimes, spendCalls, slept, logged, writes, get reads() { return reads; } };
}
const live = (options: Options = {}) => harness({ dryRun: false, ...options });
/** A job a /review comment stored: by octo-lead, comment 31, through installation 99; out of dry run unless given. */
const manualJob = (options: Options = {}) => harness({ dryRun: false, ...options, manual: true });

/** The finding of the review published at h0, and what it rendered. */
const MAJOR = { path: 'src/a.ts', side: 'RIGHT' as const, line: 12, severity: 'major' as const, body: 'A check is missing.', quote: 'y', requestedLine: null };
const EARLIER_RESULT = okResult({ findings: [MAJOR] });
const EARLIER = renderReview(EARLIER_RESULT, { trigger: 'automatic', requestedBy: null, lineUrl: () => 'https://git.example.test/x', inline: true });
const STORED_8001: StoredComment = { commentId: '8001', path: 'src/a.ts', side: 'RIGHT', line: 12, severity: 'major', quote: 'y' };
/** A live run recorded and not published: by default at h1 against merge000, with okResult and its rendered text. */
const recorded = (over: Partial<RunRecord> = {}): Promise<number> => {
  const result = (over.result as ReviewResult | undefined) ?? okResult();
  const text = renderReview(result, { trigger: 'automatic', requestedBy: null, lineUrl: () => 'https://git.example.test/x', inline: true });
  return recordRun(db, {
    ref: REF, job: null, trigger: 'automatic', mode: 'full', dryRun: false, headSha: 'h1', baseSha: 'merge000', baseBranch: null, outcome: 'ok', failureStage: null, failureCode: null,
    needsHuman: false, highestScore: 35, body: text.body, comments: text.comments, result, usage: USAGE, startedAt: at(-3600), finishedAt: at(-3500), ...over,
  });
};
/** A review published as 401: its run at h0 against merge000 on the base branch main, a full review, and its comment 8001 stored, unless told otherwise. */
async function published(over: {
  head?: string; comments?: StoredComment[]; pullRequest?: number; baseBranch?: string | null; mode?: RunRecord['mode']; result?: unknown; reviewId?: string;
} = {}): Promise<number> {
  const ref = over.pullRequest === undefined ? REF : { ...REF, number: over.pullRequest };
  const id = await recorded({
    ref, headSha: over.head ?? 'h0', result: over.result ?? EARLIER_RESULT, baseBranch: over.baseBranch === undefined ? 'main' : over.baseBranch, mode: over.mode ?? 'full',
  });
  await markPublished(db, id, { reviewId: over.reviewId ?? '401', publishedAt: at(-3400), body: EARLIER.body, inlineDropped: false });
  await recordComments(db, id, ref, over.comments ?? [STORED_8001]);
  return id;
}
/** The thread of comment 8001, with one reply by octo-dev. */
const THREAD: ReviewThread = {
  id: 'PRRT_1', path: 'src/a.ts', side: 'RIGHT', line: 12, resolved: false, resolvedByApp: false,
  comments: [
    { id: '8001', node: 'PRRC_1', author: 'visto-test[bot]', authorIsBot: true, byApp: true, reviewId: '401', body: EARLIER.comments[0]!.body, at: at(-3400) },
    { id: '8002', node: 'PRRC_2', author: 'octo-dev', authorIsBot: false, byApp: false, reviewId: null, body: 'The caller checks it.', at: at(-100) },
  ],
};
const VERDICT: ThreadVerdict = { threadId: 'PRRT_1', commentId: '8001', verdict: 'answered', reply: 'The guard is in the caller.', fileChanged: false };
const REPLY = '**Answered.** The guard is in the caller.\n\n<!-- visto-ai: review=501 head=h1 -->';

/** Real engine dependencies around one changed file and a model that answers the forced call with no findings. */
function engineDepsWithStubs(): ReviewDeps {
  const source: Source = {
    listFiles: () => Promise.resolve([{
      path: 'a.ts', previousPath: null, status: 'modified', additions: 1, deletions: 0, patch: '@@ -1,1 +1,2 @@\n head\n+const a = 1;',
    }]),
    getFileContent: () => Promise.resolve(null),
    getDefaultBranchFile: () => Promise.resolve(null),
  };
  const model: ModelClient = {
    complete: (): Promise<ModelResponse> => Promise.resolve({
      toolName: SUBMIT_REVIEW, toolArguments: JSON.stringify({ overview: 'a.ts is fine.', findings: [], files: [] }), text: null, model: 'm', provider: null,
      usage: { calls: 1, inputTokens: 10, outputTokens: 5, cachedTokens: 0, cost: 0.1 },
    }),
  };
  return { source, model, contract: 'You review pull requests.', clock: () => new Date(0), token: () => 'abcdef0123456789', log: () => {} };
}

test('a review is run on the live pull request, recorded with what would be posted, and its job ends as reviewed', async () => {
  const h = await harness();
  await runReviewJob(h.job, h.deps);
  const [stored] = await listRuns(db, REF);
  assert.deepEqual(
    [stored!.job, stored!.trigger, stored!.mode, stored!.dryRun, stored!.headSha, stored!.baseSha, stored!.outcome, stored!.needsHuman, stored!.highestScore],
    [h.job.id, 'automatic', 'full', true, 'h1', 'merge000', 'ok', false, 35]);
  assert.deepEqual(stored!.usage, USAGE);
  assert.match(stored!.body, /Human review/);
  assert.deepEqual((stored!.result as ReviewResult).findings, okResult().findings);
  assert.equal((stored!.comments as unknown[]).length, 1);
  const j = await getJob(db, h.job.id);
  assert.deepEqual([j?.status, j?.outcome], ['done', 'reviewed']);
  assert.deepEqual(h.inputs, [{
    pullRequest: LIVE.info, trigger: 'automatic', repoConfig: { primaryBranches: ['main'], scoreThreshold: 70 }, limits: LIMITS, asOf: new Date(at(0)), earlier: null,
  }]);
  const entry = h.logged.find((e) => e.event === 'review')!;
  assert.deepEqual(
    [entry.repo, entry.number, entry.head, entry.outcome, entry.dry_run, entry.findings, entry.cost, entry.requeued],
    ['acme/shop', 7, 'h1', 'ok', true, 1, 0.5, false]);
});
test('a job is dropped, with no model call and no run, when the pull request is gone, closed, a draft or by an ignored author', async () => {
  const cases: Array<[LivePullRequest | null, string]> = [
    [null, 'not_found'], [{ ...LIVE, state: 'closed' }, 'closed'], [{ ...LIVE, state: 'merged' }, 'closed'],
    [{ ...LIVE, info: { ...LIVE.info, draft: true } }, 'draft'],
    [{ ...LIVE, info: { ...LIVE.info, author: 'dependabot[bot]' } }, 'ignored_author'],
  ];
  for (const [live, reason] of cases) {
    const h = await harness({ live });
    await runReviewJob(h.job, h.deps);
    const j = await getJob(db, h.job.id);
    assert.deepEqual([j?.status, j?.outcome, h.inputs.length, (await listRuns(db, REF)).length], ['dropped', reason, 0, 0]);
    assert.deepEqual(h.logged.at(-1), { event: 'job', job: h.job.id, repo: 'acme/shop', number: 7, outcome: 'dropped', reason });
  }
});
test('a base branch outside the filter drops the job', async () => {
  const h = await harness({ settings: { ...SETTINGS, baseBranches: ['release'] } });
  await runReviewJob(h.job, h.deps);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'base_filtered');
});
test('a pull request the service has no installation for is dropped', async () => {
  const h = await harness({ stored: false });
  await runReviewJob(h.job, h.deps);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'no_installation');
});
test('a job whose head has moved is dropped, and the live head gets a job due after the quiet period', async () => {
  const h = await harness({ live: { ...LIVE, info: { ...LIVE.info, headSha: 'h2' } } });
  await runReviewJob(h.job, h.deps);
  const old = await getJob(db, h.job.id);
  assert.deepEqual([old?.status, old?.outcome, h.inputs.length], ['dropped', 'stale_head', 0]);
  assert.deepEqual((await unfinishedJobs(db)).map((j) => [j.headSha, j.reason, j.runAt, j.starts, j.status]), [['h2', 'opened', at(180), 0, 'pending']]);
});
test('a job whose head has moved leaves the job the newer head already has', async () => {
  const h = await harness({ live: { ...LIVE, info: { ...LIVE.info, headSha: 'h2' } } });
  const own = (await enqueueJob(db, { ref: REF, reason: 'synchronize', headSha: 'h2', runAt: at(100), now: at(1), delivery: 'd9', replace: true, ...AUTOMATIC }))!;
  await runReviewJob(h.job, h.deps);
  assert.deepEqual((await unfinishedJobs(db)).map((j) => [j.id, j.reason, j.runAt]), [[own, 'synchronize', at(100)]]);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'stale_head');
});
test('a head that already has a finished review against the same base is not reviewed again', async () => {
  const first = await harness();
  await runReviewJob(first.job, first.deps);
  const again = await harness();
  await runReviewJob(again.job, again.deps);
  assert.deepEqual([(await getJob(db, again.job.id))?.outcome, again.inputs.length, (await listRuns(db, REF)).length], ['already_reviewed', 0, 1]);
  const retargeted = await harness({ live: OTHER_BASE });
  await runReviewJob(retargeted.job, retargeted.deps);
  assert.deepEqual([(await getJob(db, retargeted.job.id))?.outcome, (await listRuns(db, REF)).length], ['reviewed', 2]);
});
test('a pull request that cannot be read is recorded as a failed run, and the job is tried again in a minute with its start counted', async () => {
  const h = await harness({ live: new Error('github_502') });
  await runReviewJob(h.job, h.deps);
  const [stored] = await listRuns(db, REF);
  assert.deepEqual(
    [stored!.outcome, stored!.failureStage, stored!.failureCode, stored!.headSha, stored!.baseSha, stored!.needsHuman, stored!.highestScore, stored!.usage.cost],
    ['failed', 'prepare', 'github_502', 'h1', null, true, 100, 0]);
  const j = await getJob(db, h.job.id);
  assert.deepEqual([j?.status, j?.runAt, j?.starts, h.inputs.length], ['pending', at(60), 1, 0]);
  assert.equal(h.logged.find((e) => e.event === 'review')!.requeued, true);
});
test('a job that cannot be read on its second start is tried again 15 minutes later', async () => {
  const h = await harness({ live: new Error('github_502'), secondStart: true });
  await runReviewJob(h.job, h.deps);
  const j = await getJob(db, h.job.id);
  assert.deepEqual([j?.status, j?.runAt, j?.starts], ['pending', at(900), 2]);
});
test('an error that is not a short code is recorded as internal_error and its message is logged nowhere', async () => {
  const h = await harness({ live: new Error('Something private went wrong') });
  await runReviewJob(h.job, h.deps);
  assert.equal((await listRuns(db, REF))[0]!.failureCode, 'internal_error');
  assert.equal(JSON.stringify(h.logged).includes('private'), false);
});
test('a failure of the git service inside the engine is tried again too; any other failure before the model is not', async () => {
  const again = await harness({ result: failed('context', 'github_network', { usage: NO_CALLS }) });
  await runReviewJob(again.job, again.deps);
  let j = await getJob(db, again.job.id);
  assert.deepEqual([j?.status, j?.runAt, j?.starts], ['pending', at(60), 1]);
  await finishJob(db, again.job.id, 'dropped', 'test_over', at(1));
  const final = await harness({ result: failed('context', 'too_many_files', { usage: NO_CALLS }) });
  await runReviewJob(final.job, final.deps);
  j = await getJob(db, final.job.id);
  assert.deepEqual([j?.status, j?.outcome], ['done', 'failed']);
});
test('a failed review is recorded with its stage and code and is not run again', async () => {
  const h = await harness({ result: failed('model', 'timeout', { dependencies: { model: 'error' } }) });
  await runReviewJob(h.job, h.deps);
  const [stored] = await listRuns(db, REF);
  const j = await getJob(db, h.job.id);
  assert.deepEqual([stored!.outcome, stored!.failureStage, stored!.failureCode, j?.status, j?.outcome, h.healthCalls], ['failed', 'model', 'timeout', 'done', 'failed', []]);
});
test('a refused key records the run and puts the job back for when the pause is over; the start is given back only when no model call was made', async () => {
  const free = await harness({ result: failed('model', 'auth', { dependencies: { model: 'error' }, usage: NO_CALLS }) });
  await runReviewJob(free.job, free.deps);
  let j = await getJob(db, free.job.id);
  assert.deepEqual([free.healthCalls, j?.status, j?.runAt, j?.starts, (await listRuns(db, REF)).at(-1)!.failureCode], [['auth'], 'pending', at(300), 0, 'auth']);
  await finishJob(db, free.job.id, 'dropped', 'test_over', at(1));
  const unpriced = await harness({ result: failed('model', 'auth', { dependencies: { model: 'error' }, usage: { ...USAGE, cost: 0 } }) });
  await runReviewJob(unpriced.job, unpriced.deps);
  j = await getJob(db, unpriced.job.id);
  assert.deepEqual([j?.status, j?.runAt, j?.starts], ['pending', at(300), 1]);
  await finishJob(db, unpriced.job.id, 'dropped', 'test_over', at(1));
  const paid = await harness({ result: failed('model', 'no_credit', { dependencies: { model: 'error' } }) });
  await runReviewJob(paid.job, paid.deps);
  j = await getJob(db, paid.job.id);
  assert.deepEqual([paid.healthCalls, j?.status, j?.runAt, j?.starts], [['no_credit'], 'pending', at(300), 1]);
});
test('a refusal is dated when it is seen, and the pause is counted from then', async () => {
  const h = await harness({ result: failed('model', 'auth', { dependencies: { model: 'error' } }), afterReview: at(400) });
  await runReviewJob(h.job, h.deps);
  const j = await getJob(db, h.job.id);
  assert.deepEqual([h.healthTimes, j?.status, j?.runAt], [[at(400)], 'pending', at(700)]);
});
test('a failure after the review returned never puts the job back: it is left running and the cost is in the log', async () => {
  const broken = { ...okResult() } as Partial<ReviewResult>;
  delete broken.verdict;
  const h = await harness({ result: broken as ReviewResult });
  await runReviewJob(h.job, h.deps);
  const j = await getJob(db, h.job.id);
  assert.deepEqual([j?.status, j?.starts, (await listRuns(db, REF)).length], ['running', 1, 0]);
  const entry = h.logged.find((e) => e.event === 'review')!;
  assert.deepEqual([entry.outcome, entry.cost, entry.requeued], ['record_failed', 0.5, false]);
  assert.equal(h.logged.some((e) => e.event === 'job'), false);
});
test('a review the model answered tells the health so, and one that made no model call says nothing', async () => {
  const answered = await harness();
  await runReviewJob(answered.job, answered.deps);
  assert.deepEqual(answered.healthCalls, [null]);
  const silent = await harness({ live: OTHER_BASE, result: okResult({ usage: NO_CALLS, findings: [] }) });
  await runReviewJob(silent.job, silent.deps);
  assert.deepEqual([silent.healthCalls, silent.spendCalls.length], [[], 1]);
});
test('a model answer the database would refuse is still recorded', async () => {
  const NUL = String.fromCharCode(0);
  const h = await harness({ result: okResult({ findings: [{ ...okResult().findings[0]!, body: `a${NUL}b` }], overview: `o${NUL}` }) });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([(await listRuns(db, REF)).length, (await getJob(db, h.job.id))?.status], [1, 'done']);
});
test('recording is tried three times; then the cost is in the log and the job is left running', async () => {
  const twice = await harness({ recordFailures: 2 });
  await runReviewJob(twice.job, twice.deps);
  assert.deepEqual([(await listRuns(db, REF)).length, twice.slept, (await getJob(db, twice.job.id))?.status], [1, [1000, 5000], 'done']);
  const always = await harness({ live: OTHER_BASE, recordFailures: 3 });
  await runReviewJob(always.job, always.deps);
  const entry = always.logged.find((e) => e.event === 'review')!;
  assert.deepEqual([entry.outcome, entry.cost, (await getJob(db, always.job.id))?.status, (await listRuns(db, REF)).length], ['record_failed', 0.5, 'running', 1]);
});
test('a record that was committed but looked failed is not written twice', async () => {
  const h = await harness({ lostAnswer: true });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([(await listRuns(db, REF)).length, (await getJob(db, h.job.id))?.status, h.slept], [1, 'done', [1000]]);
});
test('nothing the job does can make it reject', async () => {
  const broken = await harness();
  broken.deps.review = () => Promise.reject(new Error('boom'));
  broken.deps.log = () => { throw new Error('log'); };
  await runReviewJob(broken.job, broken.deps);
  const [stored] = await listRuns(db, REF);
  assert.deepEqual([stored!.failureStage, stored!.failureCode, (await getJob(db, broken.job.id))?.status], ['engine', 'internal_error', 'done']);
});
test('the engine itself runs under the job', async () => {
  const h = await harness();
  h.deps.review = review;
  h.deps.engineDeps = () => engineDepsWithStubs();
  await runReviewJob(h.job, h.deps);
  const [stored] = await listRuns(db, REF);
  assert.deepEqual([stored!.outcome, (stored!.result as ReviewResult).coverage.reviewed], ['ok', ['a.ts']]);
});
test('a read that fails before the review puts the job back in a minute with its start counted, and writes no run', async () => {
  for (const failQuery of ['visto_ai.pull_requests', 'visto_ai.review_runs']) {
    const h = await harness({ failQuery });
    await runReviewJob(h.job, h.deps);
    const j = await getJob(db, h.job.id);
    assert.deepEqual([j?.status, j?.runAt, j?.starts, h.inputs.length, (await listRuns(db, REF)).length], ['pending', at(60), 1, 0, 0]);
    assert.equal(JSON.stringify(h.logged).includes('private'), false);
    assert.equal(h.logged.at(-1)!.requeued, true);
    await finishJob(db, h.job.id, 'dropped', 'test_over', at(1));
  }
});
test('a finished review is recorded, posted, marked published, and its comments stored', async () => {
  const h = await live();
  await runReviewJob(h.job, h.deps);
  const [stored] = await listRuns(db, REF);
  assert.deepEqual([stored!.dryRun, stored!.outcome, stored!.published, stored!.reviewId, stored!.inlineDropped], [false, 'ok', true, '501', false]);
  const j = await getJob(db, h.job.id);
  assert.deepEqual([j?.status, j?.outcome], ['done', 'published']);
  assert.deepEqual(await listComments(db, REF), [{ commentId: '9001', path: 'a.ts', side: 'RIGHT', line: 3, severity: 'minor', quote: 'x', run: stored!.id }]);
  const entry = h.logged.find((e) => e.event === 'review')!;
  assert.deepEqual([entry.published, entry.review, entry.publish, entry.publish_code, entry.resumed, entry.adopted], [true, '501', 'published', null, false, false]);
  assert.deepEqual(h.logged.find((e) => e.event === 'readback'), { event: 'readback', job: h.job.id, run: stored!.id, posted: 1, stored: 1 });
});
test('in dry run nothing is ever written to the git service', async () => {
  const h = await harness();
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([h.writes, (await listRuns(db, REF))[0]!.published, (await getJob(db, h.job.id))?.outcome], [[], false, 'reviewed']);
});
test('a pull request that already has its review is not reviewed again at the same head, and a later head is reviewed against it', async () => {
  const first = await live();
  await runReviewJob(first.job, first.deps);
  const same = await live();
  await runReviewJob(same.job, same.deps);
  const later = await live({ head: 'h2' });
  await runReviewJob(later.job, later.deps);
  assert.deepEqual(
    [(await getJob(db, same.job.id))?.outcome, (await getJob(db, later.job.id))?.outcome, same.inputs.length, later.inputs.length, (await listRuns(db, REF)).length],
    ['already_reviewed', 'published', 0, 1, 2]);
  assert.equal(later.inputs[0]!.earlier?.head, 'h1');
});
test('when the post cannot be made the review stays stored and the job is put back with its start counted', async () => {
  const h = await live({ posts: [new Error('github_502')] });
  await runReviewJob(h.job, h.deps);
  const [stored] = await listRuns(db, REF);
  const j = await getJob(db, h.job.id);
  assert.deepEqual([stored!.outcome, stored!.published, j?.status, j?.runAt, j?.starts], ['ok', false, 'pending', at(60), 1]);
  const entry = h.logged.find((e) => e.event === 'review')!;
  assert.deepEqual([entry.publish, entry.publish_code, entry.requeued], ['failed', 'github_502', true]);
});
test('the next start publishes the stored review without calling the model, and tells no guard', async () => {
  const before = await live({ posts: [new Error('github_502')] });
  await runReviewJob(before.job, before.deps);
  const again = await live({ reuseJob: before.job.id });
  await runReviewJob(again.job, again.deps);
  const runs = await listRuns(db, REF);
  assert.deepEqual([runs.length, runs[0]!.published, runs[0]!.reviewId, again.inputs.length, (await getJob(db, again.job.id))?.outcome], [1, true, '501', 0, 'published']);
  const entry = again.logged.find((e) => e.event === 'review')!;
  assert.deepEqual([entry.resumed, entry.calls, entry.cost, entry.findings, again.healthCalls, again.spendCalls.length], [true, 0, 0, 1, [], 0]);
});
test('a review that was posted but not recorded as such is adopted, not posted again', async () => {
  const lost = await live({ markFailures: 3 });
  await runReviewJob(lost.job, lost.deps);
  assert.deepEqual([(await listRuns(db, REF))[0]!.published, (await getJob(db, lost.job.id))?.status, lost.logged.find((e) => e.event === 'review')!.outcome], [false, 'running', 'record_failed']);
  await requeueJob(db, lost.job.id, at(0), at(0), false);        // what start-up recovery does
  const again = await live({ reuseJob: lost.job.id, own: [[{ id: '501', commit: 'h1' }]] });
  await runReviewJob(again.job, again.deps);
  const [stored] = await listRuns(db, REF);
  assert.deepEqual([stored!.published, stored!.reviewId, again.inputs.length, again.writes.filter((w) => w[0] === 'publishReview').length], [true, '501', 0, 0]);
});
test('a review posted on an earlier head that the database never learned of, and has no run for, is logged and does not stop the review', async () => {
  const h = await live({ head: 'h2', own: [[{ id: '470', commit: 'h1' }]] });
  await runReviewJob(h.job, h.deps);
  const j = await getJob(db, h.job.id);
  assert.deepEqual([j?.status, j?.outcome, h.inputs.length, (await listRuns(db, REF)).length, h.writes.filter((w) => w[0] === 'publishReview').length],
    ['done', 'published', 1, 1, 1]);
  assert.deepEqual(h.logged.filter((e) => e.event === 'unknown_review'), [{ event: 'unknown_review', job: h.job.id, review: '470' }]);
});
test('a review of its own on the live head that the database never learned of drops the job before anything is paid', async () => {
  const h = await live({ own: [[{ id: '480', commit: 'h1' }]] });
  await runReviewJob(h.job, h.deps);
  const j = await getJob(db, h.job.id);
  assert.deepEqual([j?.status, j?.outcome, h.inputs.length, (await listRuns(db, REF)).length], ['dropped', 'already_reviewed', 0, 0]);
});
test('when the git service cannot say which reviews the app has, no model call is made and the job is tried again with its start counted', async () => {
  const h = await live({ own: [new Error('github_502')] });
  await runReviewJob(h.job, h.deps);
  const runs = await listRuns(db, REF);
  const j = await getJob(db, h.job.id);
  assert.deepEqual([h.inputs.length, runs.length, runs[0]!.outcome, runs[0]!.failureStage, runs[0]!.failureCode], [0, 1, 'failed', 'prepare', 'github_502']);
  assert.deepEqual([j?.status, j?.runAt, j?.starts], ['pending', at(60), 1]);
});
test('a review of its own that appears on another commit while the review runs does not stop the post', async () => {
  const h = await live({ own: [[], [{ id: '470', commit: 'h0' }]] });
  await runReviewJob(h.job, h.deps);
  const runs = await listRuns(db, REF);
  assert.deepEqual([h.inputs.length, runs.length, runs[0]!.outcome, runs[0]!.published, runs[0]!.reviewId, h.writes.filter((w) => w[0] === 'publishReview').length],
    [1, 1, 'ok', true, '501', 1]);
  const j = await getJob(db, h.job.id);
  assert.deepEqual([j?.status, j?.outcome], ['done', 'published']);
});
test('a resumed start asks for the own reviews once, inside the publication, and dry run never asks', async () => {
  const before = await live({ posts: [new Error('github_502')] });
  await runReviewJob(before.job, before.deps);
  assert.deepEqual(before.writes.slice(0, 2), [['listOwnReviews'], ['listOwnReviews']]);
  const again = await live({ reuseJob: before.job.id });
  await runReviewJob(again.job, again.deps);
  assert.equal(again.writes.filter((w) => w[0] === 'listOwnReviews').length, 1);
  const dry = await harness({ pullRequest: 8 });
  await runReviewJob(dry.job, dry.deps);
  assert.deepEqual(dry.writes, []);
});
test('a publication for a run that is already marked still finishes the job', async () => {
  const h = await live();
  const post = h.deps.writer.publishReview;
  h.deps.writer = {
    ...h.deps.writer,
    publishReview: async (ref, installation, draft) => {
      const [run] = await listRuns(db, REF);
      await markPublished(db, run!.id, { reviewId: '400', publishedAt: at(0), body: 'earlier', inlineDropped: false });
      return post(ref, installation, draft);
    },
  };
  await runReviewJob(h.job, h.deps);
  const j = await getJob(db, h.job.id);
  assert.deepEqual([j?.status, j?.outcome, (await listRuns(db, REF))[0]!.reviewId], ['done', 'published', '400']);
});
test('a failed publication whose place a newer job took leaves the newer job as it is', async () => {
  const h = await live({ posts: [new Error('github_502')] });
  const post = h.deps.writer.publishReview;
  let newer: number | null = null;
  h.deps.writer = {
    ...h.deps.writer,
    publishReview: async (ref, installation, draft) => {
      newer = await enqueueJob(db, { ref: REF, reason: 'synchronize', headSha: 'h1', runAt: at(100), now: at(1), delivery: 'd9', replace: true, ...AUTOMATIC });
      return post(ref, installation, draft);
    },
  };
  await runReviewJob(h.job, h.deps);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'superseded');
  assert.deepEqual((await unfinishedJobs(db)).map((j) => [j.id, j.reason, j.runAt, j.status]), [[newer, 'synchronize', at(100), 'pending']]);
  const entry = h.logged.find((e) => e.event === 'review')!;
  assert.deepEqual([entry.publish, entry.requeued], ['failed', false]);
});
test('a head or a base that moved while the review ran gets nothing posted and a job of its own', async () => {
  const h = await live({ liveAfter: { ...LIVE, info: { ...LIVE.info, headSha: 'h2' } } });
  await runReviewJob(h.job, h.deps);
  const old = await getJob(db, h.job.id);
  assert.deepEqual([old?.status, old?.outcome, h.writes.filter((w) => w[0] === 'publishReview').length], ['done', 'head_moved', 0]);
  assert.deepEqual((await unfinishedJobs(db)).map((j) => [j.headSha, j.trigger, j.runAt]), [['h2', 'automatic', at(180)]]);
  const based = await live({ pullRequest: 8, liveAfter: OTHER_BASE });
  await runReviewJob(based.job, based.deps);
  assert.equal((await getJob(db, based.job.id))?.outcome, 'head_moved');
});
test('a pull request closed while the review ran, and a review the git service refuses, end the job', async () => {
  const closed = await live({ liveAfter: { ...LIVE, state: 'closed' } });
  await runReviewJob(closed.job, closed.deps);
  assert.equal((await getJob(db, closed.job.id))?.outcome, 'closed');
  const refused = await live({ pullRequest: 8, posts: [new Error('review_rejected'), new Error('review_rejected')] });
  await runReviewJob(refused.job, refused.deps);
  assert.deepEqual([(await getJob(db, refused.job.id))?.outcome, (await listRuns(db, { ...REF, number: 8 }))[0]!.published], ['publish_rejected', false]);
});
test('refused inline comments are recorded as dropped, with the text that was posted', async () => {
  const h = await live({ posts: [new Error('review_rejected'), { id: '502' }], posted: [] });
  await runReviewJob(h.job, h.deps);
  const [stored] = await listRuns(db, REF);
  assert.deepEqual([stored!.published, stored!.reviewId, stored!.inlineDropped, (await listComments(db, REF)).length], [true, '502', true, 0]);
  assert.equal(stored!.body, h.writes.filter((w) => w[0] === 'publishReview').at(-1)![2]);
});
test('a read-back that is cut short or fails is logged and the publication stands', async () => {
  for (const [posted, number] of [[null, 8], [new Error('github_502'), 9]] as const) {
    const h = await live({ posted, pullRequest: number });
    await runReviewJob(h.job, h.deps);
    assert.equal((await getJob(db, h.job.id))?.outcome, 'published');
    assert.equal(h.logged.some((e) => e.event === 'readback_failed'), true);
  }
});
test('a review that failed, or whose text could not be rendered, is recorded and never posted', async () => {
  const failedRun = await live({ result: failed('model', 'timeout', { dependencies: { model: 'error' } }) });
  await runReviewJob(failedRun.job, failedRun.deps);
  assert.deepEqual([(await getJob(db, failedRun.job.id))?.outcome, failedRun.writes, (await listRuns(db, REF))[0]!.published], ['failed', [['listOwnReviews']], false]);
  const unrendered = await live({ pullRequest: 8, renderThrows: true });
  await runReviewJob(unrendered.job, unrendered.deps);
  assert.deepEqual([(await getJob(db, unrendered.job.id))?.outcome, unrendered.writes], ['render_failed', [['listOwnReviews']]]);
  const next = await live({ pullRequest: 8 });
  await runReviewJob(next.job, next.deps);
  assert.deepEqual([next.inputs.length, (await getJob(db, next.job.id))?.outcome], [1, 'published']);
});
test('a /review from a member is accepted, reviewed as requested, and published', async () => {
  const h = await manualJob();
  await runReviewJob(h.job, h.deps);
  assert.deepEqual(h.writes.map((w) => w[0]), ['listOwnReviews', 'react', 'listOwnReviews', 'publishReview', 'listReviewComments']);
  assert.deepEqual(h.writes[1], ['react', '31', 'eyes']);
  assert.deepEqual([h.inputs[0]!.trigger, (await listRuns(db, REF))[0]!.trigger, (await getJob(db, h.job.id))?.outcome], ['manual', 'manual', 'published']);
  assert.equal((await listRuns(db, REF))[0]!.body.includes('requested by @octo-lead'), true);
});
test('a /review from someone without access is refused before anything is read, and the head still gets its job', async () => {
  for (const [association, number] of [['none', 7], [null, 8], ['contributor', 9]] as const) {
    const h = await manualJob({ association, pullRequest: number });
    await runReviewJob(h.job, h.deps);
    assert.deepEqual(h.writes, [['react', '31', 'confused'], ['comment', '@octo-lead The review was not started (`not_allowed`).']]);
    assert.deepEqual([h.reads, h.inputs.length, (await getJob(db, h.job.id))?.outcome], [0, 0, 'refused']);
    const left = (await unfinishedJobs(db)).filter((j) => j.ref.number === number);
    assert.deepEqual(left.map((j) => [j.trigger, j.reason, j.headSha, j.status]), [['automatic', 'opened', 'h1', 'pending']]);
  }
});
test('a /review from someone without access on a head whose paid review failed stores no job, in dry run and out of it', async () => {
  for (const [dryRun, number] of [[true, 7], [false, 8]] as const) {
    const first = await harness({ dryRun, pullRequest: number, result: failed('model', 'timeout', { dependencies: { model: 'error' } }) });
    await runReviewJob(first.job, first.deps);
    assert.equal((await getJob(db, first.job.id))?.outcome, 'failed');
    const h = await manualJob({ dryRun, association: 'none', pullRequest: number });
    await runReviewJob(h.job, h.deps);
    assert.deepEqual([(await getJob(db, h.job.id))?.outcome, h.inputs.length], ['refused', 0]);
    assert.deepEqual((await unfinishedJobs(db)).filter((j) => j.ref.number === number), []);
  }
});
test('a stranger\'s command that superseded the head\'s job gives the head its job back, and its start posts the recorded review', async () => {
  const STRANGER = { ref: REF, reason: 'command', headSha: '', runAt: at(1), now: at(1), delivery: 'd8', replace: false,
    trigger: 'manual' as const, requestedBy: 'octo-dev', commentId: '32', association: 'none', installation: '99' };
  const first = await live({ posts: [new Error('github_502')] });
  const post = first.deps.writer.publishReview;
  let command: number | null = null;
  first.deps.writer = { ...first.deps.writer, publishReview: async (ref, installation, draft) => { command = await enqueueJob(db, STRANGER); return post(ref, installation, draft); } };
  await runReviewJob(first.job, first.deps);
  assert.equal((await getJob(db, first.job.id))?.outcome, 'superseded');
  const refused = await manualJob({ reuseJob: command!, association: 'none' });
  await runReviewJob(refused.job, refused.deps);
  assert.equal((await getJob(db, command!))?.outcome, 'refused');
  const waiting = await unfinishedJobs(db);
  assert.deepEqual(waiting.map((j) => [j.trigger, j.headSha, j.status]), [['automatic', 'h1', 'pending']]);
  const again = await live({ reuseJob: waiting[0]!.id });
  await runReviewJob(again.job, again.deps);
  const [stored] = await listRuns(db, REF);
  assert.deepEqual([again.inputs.length, (await getJob(db, again.job.id))?.outcome, stored!.published, (await listRuns(db, REF)).length], [0, 'published', true, 1]);
  assert.deepEqual(again.writes.filter((w) => w[0] === 'publishReview'), [['publishReview', 'h1', stored!.body, 1]]);

  // in dry run: a read that fails, a put-back superseded by a stranger's waiting command, and the refusal stores the head's job again
  const dry = await harness({ pullRequest: 8, live: new Error('github_502') });
  const waits = (await enqueueJob(db, { ...STRANGER, ref: { ...REF, number: 8 } }))!;
  await runReviewJob(dry.job, dry.deps);
  assert.equal((await getJob(db, dry.job.id))?.outcome, 'superseded');
  const no = await manualJob({ dryRun: true, pullRequest: 8, reuseJob: waits, association: 'none' });
  await runReviewJob(no.job, no.deps);
  assert.deepEqual((await unfinishedJobs(db)).filter((j) => j.ref.number === 8).map((j) => [j.trigger, j.headSha, j.status]), [['automatic', 'h1', 'pending']]);
});
test('a /review on a closed pull request is refused with no eyes first, and one on a head that has its review re-checks it', async () => {
  const closed = await manualJob({ live: { ...LIVE, state: 'closed' } });
  await runReviewJob(closed.job, closed.deps);
  assert.deepEqual(closed.writes, [['react', '31', 'confused'], ['comment', '@octo-lead The review was not started (`closed`).']]);
  const first = await live({ pullRequest: 8 });
  await runReviewJob(first.job, first.deps);
  const second = await manualJob({ pullRequest: 8, own: [[{ id: '501', commit: 'h1' }]] });
  await runReviewJob(second.job, second.deps);
  assert.deepEqual(second.writes.filter((w) => w[0] === 'react'), [['react', '31', 'eyes']]);
  assert.deepEqual([second.inputs.length, second.inputs[0]!.mode, (await getJob(db, second.job.id))?.outcome], [1, 'recheck', 'published']);
});
test('a /review on a head whose review only the git service knows of is refused before anything is paid; one on another commit does not stop it', async () => {
  const h = await manualJob({ own: [[{ id: '470', commit: 'h1' }]] });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual(h.writes, [['listOwnReviews'], ['react', '31', 'confused'], ['comment', '@octo-lead The review was not started (`already_reviewed`).']]);
  assert.deepEqual([h.inputs.length, (await getJob(db, h.job.id))?.outcome], [0, 'refused']);
  const other = await manualJob({ pullRequest: 8, own: [[{ id: '470', commit: 'h0' }]] });
  await runReviewJob(other.job, other.deps);
  assert.deepEqual([other.inputs.length, (await getJob(db, other.job.id))?.outcome, other.writes.filter((w) => w[0] === 'publishReview').length], [1, 'published', 1]);
});
test('a draft, an ignored author and a filtered base branch do not stop a /review, and the live head is the one reviewed', async () => {
  const h = await manualJob({ live: { ...LIVE, info: { ...LIVE.info, draft: true, author: 'dependabot[bot]', headSha: 'h9' } }, settings: { ...SETTINGS, baseBranches: ['release'] } });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([(await getJob(db, h.job.id))?.outcome, (await listRuns(db, REF))[0]!.headSha], ['published', 'h9']);
});
test('a head that moves under a /review starts it over once, as a new job', async () => {
  const moved = { ...LIVE, info: { ...LIVE.info, headSha: 'h2' } };
  const first = await manualJob({ liveAfter: moved });
  await runReviewJob(first.job, first.deps);
  assert.deepEqual([(await getJob(db, first.job.id))?.outcome, first.writes.some((w) => w[0] === 'comment')], ['head_moved', false]);
  const [retry] = await unfinishedJobs(db);
  assert.deepEqual([retry!.trigger, retry!.reason, retry!.requestedBy, retry!.commentId, retry!.association, retry!.runAt], ['manual', 'command_retry', 'octo-lead', '31', 'member', at(0)]);
  const second = await manualJob({ reuseJob: retry!.id, live: moved, liveAfter: { ...LIVE, info: { ...LIVE.info, headSha: 'h3' } } });
  await runReviewJob(second.job, second.deps);
  assert.deepEqual([(await getJob(db, second.job.id))?.outcome, second.writes.at(-1)], ['head_moved', ['comment', '@octo-lead The review did not finish (`head_moved`).']]);
  assert.deepEqual((await unfinishedJobs(db)).map((j) => [j.trigger, j.headSha, j.runAt]), [['automatic', 'h3', at(180)]]);
});
test('a /review whose review fails, or whose publication is refused, says so', async () => {
  const failedRun = await manualJob({ result: failed('model', 'timeout', { dependencies: { model: 'error' } }) });
  await runReviewJob(failedRun.job, failedRun.deps);
  assert.deepEqual(failedRun.writes.slice(-2), [['react', '31', 'confused'], ['comment', '@octo-lead The review did not finish (`review_failed`).']]);
  const refused = await manualJob({ pullRequest: 8, posts: [new Error('review_rejected'), new Error('review_rejected')] });
  await runReviewJob(refused.job, refused.deps);
  assert.deepEqual(refused.writes.at(-1), ['comment', '@octo-lead The review did not finish (`publish_rejected`).']);
});
test('a /review put back while another job waits is superseded and says so', async () => {
  const early = await manualJob({ live: new Error('github_502') });
  const waiting = await enqueueJob(db, { ref: REF, reason: 'synchronize', headSha: 'h2', runAt: at(100), now: at(1), delivery: 'd9', replace: false, ...AUTOMATIC });
  await runReviewJob(early.job, early.deps);
  assert.deepEqual([(await getJob(db, early.job.id))?.outcome, (await getJob(db, waiting!))?.status], ['superseded', 'pending']);
  assert.deepEqual(early.writes, [['react', '31', 'confused'], ['comment', '@octo-lead The review did not finish (`superseded`).']]);
  const late = await manualJob({ pullRequest: 8, posts: [new Error('github_502')] });
  const post = late.deps.writer.publishReview;
  late.deps.writer = {
    ...late.deps.writer,
    publishReview: async (ref, installation, draft) => {
      await enqueueJob(db, { ref: { ...REF, number: 8 }, reason: 'synchronize', headSha: 'h2', runAt: at(100), now: at(1), delivery: 'd10', replace: false, ...AUTOMATIC });
      return post(ref, installation, draft);
    },
  };
  await runReviewJob(late.job, late.deps);
  assert.equal((await getJob(db, late.job.id))?.outcome, 'superseded');
  assert.deepEqual(late.writes.slice(-2), [['react', '31', 'confused'], ['comment', '@octo-lead The review did not finish (`superseded`).']]);
});
test('a /review whose text could not be rendered says so', async () => {
  const h = await manualJob({ renderThrows: true });
  await runReviewJob(h.job, h.deps);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'render_failed');
  assert.deepEqual(h.writes.slice(-2), [['react', '31', 'confused'], ['comment', '@octo-lead The review did not finish (`render_failed`).']]);
});
test('a /review whose publication finds a review of its own on another commit is published', async () => {
  const h = await manualJob({ own: [[], [{ id: '470', commit: 'h0' }]] });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([(await getJob(db, h.job.id))?.outcome, h.inputs.length, h.writes.filter((w) => w[0] === 'publishReview').length], ['published', 1, 1]);
  assert.equal(h.writes.some((w) => w[0] === 'react' && w[2] === 'confused'), false);
});
test('in dry run a /review writes nothing, whether it is honoured, refused or fails', async () => {
  const ok = await manualJob({ dryRun: true });
  await runReviewJob(ok.job, ok.deps);
  const stranger = await manualJob({ dryRun: true, association: 'none', pullRequest: 8 });
  await runReviewJob(stranger.job, stranger.deps);
  const closed = await manualJob({ dryRun: true, pullRequest: 9, live: { ...LIVE, state: 'closed' } });
  await runReviewJob(closed.job, closed.deps);
  const failing = await manualJob({ dryRun: true, pullRequest: 10, result: failed('model', 'timeout', { dependencies: { model: 'error' } }) });
  await runReviewJob(failing.job, failing.deps);
  assert.deepEqual([ok.writes, stranger.writes, closed.writes, failing.writes], [[], [], [], []]);
  assert.deepEqual(
    [(await getJob(db, ok.job.id))?.outcome, (await getJob(db, stranger.job.id))?.outcome, (await getJob(db, closed.job.id))?.outcome, (await getJob(db, failing.job.id))?.outcome, stranger.inputs.length],
    ['reviewed', 'refused', 'refused', 'failed', 0]);
});
test('a refusal is recorded before it is answered, and an answer that cannot be written changes nothing', async () => {
  const h = await manualJob({ association: 'none', writeFails: true });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([(await getJob(db, h.job.id))?.outcome, h.logged.filter((e) => e.event === 'answer_failed').length], ['refused', 2]);
  const unrecorded = await manualJob({ association: 'none', pullRequest: 8, finishFailures: 3 });
  await runReviewJob(unrecorded.job, unrecorded.deps);
  assert.deepEqual([unrecorded.writes, (await getJob(db, unrecorded.job.id))?.status], [[], 'running']);
});
test('what is recorded is what was rendered, and a resumed start posts exactly that', async () => {
  const NUL = String.fromCharCode(0);
  const text = [`see @${NUL}victim and <${NUL}!-- hidden and &${NUL}#64;victim`, `\`\`${NUL}\``, '@victim', `${NUL}## Overall`, `end ${String.fromCharCode(0xd800)}`].join('\n');
  const result = okResult({ overview: text, findings: [{ ...okResult().findings[0]!, body: text }] });
  const expected = renderReview(result, { trigger: 'automatic', requestedBy: null, lineUrl: () => 'https://git.example.test/x', inline: true });
  const before = await live({ result, posts: [new Error('github_502')] });
  await runReviewJob(before.job, before.deps);
  const [stored] = await listRuns(db, REF);
  assert.equal(stored!.body, expected.body);
  assert.deepEqual(stored!.comments, expected.comments);
  const again = await live({ reuseJob: before.job.id });
  await runReviewJob(again.job, again.deps);
  assert.deepEqual(again.writes.filter((w) => w[0] === 'publishReview'), [['publishReview', 'h1', expected.body, 1]]);
});
test('a push after a published review is reviewed in full with its threads, published, and the verdict written into the thread', async () => {
  await published();
  const h = await live({ own: [[{ id: '401', commit: 'h0' }]], threads: [[THREAD]], result: okResult({ threadVerdicts: [VERDICT], threadsDue: 1 }) });
  await runReviewJob(h.job, h.deps);
  assert.equal(h.inputs[0]!.earlier?.head, 'h0');
  assert.deepEqual(h.inputs[0]!.earlier?.threads.map((t) => [t.id, t.commentId, t.severity, t.settled, t.replies.length]), [['PRRT_1', '8001', 'major', false, 1]]);
  assert.deepEqual(h.writes.map((w) => w[0]), ['listOwnReviews', 'listThreads', 'listOwnReviews', 'publishReview', 'listReviewComments', 'listThreads', 'replyToThread', 'resolveThread']);
  assert.deepEqual(h.writes[6], ['replyToThread', 'PRRT_1', REPLY]);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'published');
  assert.deepEqual(h.logged.filter((e) => e.event === 'thread_followup').map((e) => [e.review, e.replied, e.resolved, e.failed, e.missing, e.changed]), [['501', 1, 1, 0, 0, 0]]);
});
test('a thread someone wrote in after it was judged is left as it is, and the log counts it as changed', async () => {
  await published();
  const later: ReviewThread = { ...THREAD, comments: [...THREAD.comments, { ...THREAD.comments[1]!, id: '8003', node: 'PRRC_3', body: 'Wait, it is a bug.' }] };
  const h = await live({ own: [[{ id: '401', commit: 'h0' }]], threads: [[THREAD], [later]], result: okResult({ threadVerdicts: [{ ...VERDICT, replies: 1 }], threadsDue: 1 }) });
  await runReviewJob(h.job, h.deps);
  assert.equal(h.writes.some((w) => w[0] === 'replyToThread' || w[0] === 'resolveThread'), false);
  assert.deepEqual(h.logged.filter((e) => e.event === 'thread_followup').map((e) => [e.replied, e.resolved, e.missing, e.changed]), [[0, 0, 0, 1]]);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'published');
});
test('a later review posts the finding its thread already raised with the link to that thread', async () => {
  await published();
  const discussed = { path: 'src/a.ts', side: 'RIGHT' as const, line: 12, severity: 'major' as const, body: 'A check is missing.', commentId: '8001', resolved: false, settled: false };
  const h = await live({ own: [[{ id: '401', commit: 'h0' }]], threads: [[THREAD]], result: okResult({ alreadyDiscussed: [discussed], threadsDue: 1 }) });
  await runReviewJob(h.job, h.deps);
  const posts = h.writes.filter((w) => w[0] === 'publishReview');
  assert.equal(posts.length, 1);
  assert.ok(String(posts[0]![2]).includes('## Already discussed'));
  assert.ok(String(posts[0]![2]).includes('(https://git.example.test/c/8001)'));
});
test('a first review reads no thread and is told of no earlier state', async () => {
  const h = await live();
  await runReviewJob(h.job, h.deps);
  assert.equal(h.writes.some((w) => w[0] === 'listThreads'), false);
  assert.equal(h.inputs[0]!.earlier, null);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'published');
});
test('a head and base that are already reviewed are not reviewed again by a push, and a command re-checks them', async () => {
  await published({ head: 'h1' });
  const push = await live();
  await runReviewJob(push.job, push.deps);
  const j = await getJob(db, push.job.id);
  assert.deepEqual([j?.status, j?.outcome, push.inputs.length], ['dropped', 'already_reviewed', 0]);
  const command = await manualJob({ own: [[{ id: '401', commit: 'h1' }]] });
  await runReviewJob(command.job, command.deps);
  assert.deepEqual([(await getJob(db, command.job.id))?.outcome, command.inputs.length, command.inputs[0]!.mode], ['published', 1, 'recheck']);
  assert.equal(command.writes.some((w) => w[0] === 'comment'), false);
});
test('a /review on a later head is honoured', async () => {
  await published();
  const h = await manualJob({ own: [[{ id: '401', commit: 'h0' }]], threads: [[THREAD]] });
  await runReviewJob(h.job, h.deps);
  assert.equal(h.writes.some((w) => w[0] === 'react' && w[2] === 'eyes'), true);
  assert.equal(h.inputs[0]!.earlier?.head, 'h0');
  assert.equal((await getJob(db, h.job.id))?.outcome, 'published');
});
test('threads that cannot be read fail the start before anything is paid', async () => {
  await published();
  const h = await live({ threads: [new Error('github_502')] });
  await runReviewJob(h.job, h.deps);
  assert.equal(h.inputs.length, 0);
  const failedRuns = (await listRuns(db, REF)).filter((r) => r.outcome === 'failed');
  assert.deepEqual(failedRuns.map((r) => [r.failureStage, r.failureCode]), [['prepare', 'github_502']]);
  const j = await getJob(db, h.job.id);
  assert.deepEqual([j?.status, j?.runAt, j?.starts], ['pending', at(60), 1]);
  assert.equal(h.writes.some((w) => w[0] === 'publishReview'), false);
});
test('a review the database lost track of is adopted into its recorded run, and the push is then reviewed against it', async () => {
  const lostRun = await recorded({ headSha: 'h0', result: EARLIER_RESULT });
  const h = await live({ own: [[{ id: '401', commit: 'h0' }]], threads: [[THREAD]] });
  await runReviewJob(h.job, h.deps);
  const adopted = (await listRuns(db, REF)).find((r) => r.id === lostRun)!;
  assert.deepEqual([adopted.published, adopted.reviewId, adopted.publishedAt, adopted.body, adopted.inlineDropped], [true, '401', at(0), EARLIER.body, false]);
  assert.deepEqual(h.logged.filter((e) => e.event === 'adopted_late'), [{ event: 'adopted_late', job: h.job.id, run: lostRun, review: '401' }]);
  assert.deepEqual(h.writes.slice(0, 3), [['listOwnReviews'], ['listReviewComments', '401'], ['listThreads']]);
  assert.equal(h.inputs[0]!.earlier?.head, 'h0');
  assert.equal(h.inputs[0]!.earlier?.threads.length, 1);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'published');
});
test('a review of ours with no recorded run is logged and the pull request is reviewed without it', async () => {
  const h = await live({ own: [[{ id: '401', commit: 'h0' }]] });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual(h.logged.filter((e) => e.event === 'unknown_review'), [{ event: 'unknown_review', job: h.job.id, review: '401' }]);
  assert.equal(h.inputs[0]!.earlier, null);
  assert.equal(h.writes.some((w) => w[0] === 'listThreads'), false);
  assert.equal(h.writes.filter((w) => w[0] === 'publishReview').length, 1);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'published');
});
test('a comment the read-back missed is stored from its thread before the review', async () => {
  const run = await published({ comments: [] });
  const h = await live({ own: [[{ id: '401', commit: 'h0' }]], threads: [[THREAD]] });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual((await listComments(db, REF)).filter((c) => c.commentId === '8001'), [{ ...STORED_8001, run }]);
  assert.equal(h.inputs[0]!.earlier?.threads.length, 1);
});
test('no verdict kept, no second read of the threads', async () => {
  await published();
  const h = await live({ own: [[{ id: '401', commit: 'h0' }]], threads: [[THREAD]] });
  await runReviewJob(h.job, h.deps);
  assert.equal(h.writes.filter((w) => w[0] === 'listThreads').length, 1);
  assert.equal(h.logged.some((e) => e.event === 'thread_followup'), false);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'published');
});
test('without the permission the thread is answered and not resolved', async () => {
  await published();
  const h = await live({ threads: [[THREAD]], canResolve: false, result: okResult({ threadVerdicts: [VERDICT], threadsDue: 1 }) });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual(h.writes.filter((w) => w[0] === 'replyToThread' || w[0] === 'resolveThread'), [['replyToThread', 'PRRT_1', REPLY]]);
  const resolving = await live({ pullRequest: 8, threads: [[THREAD]], result: okResult({ threadVerdicts: [VERDICT], threadsDue: 1 }) });
  resolving.deps.canResolve = () => Promise.reject(new Error('github_502'));
  await published({ pullRequest: 8 });
  await runReviewJob(resolving.job, resolving.deps);
  assert.deepEqual(resolving.writes.filter((w) => w[0] === 'replyToThread' || w[0] === 'resolveThread'), [['replyToThread', 'PRRT_1', REPLY]]);
});
test('a follow-up that fails leaves the job published', async () => {
  await published();
  const h = await live({ threads: [[THREAD]], threadWriteFails: true, result: okResult({ threadVerdicts: [VERDICT], threadsDue: 1 }) });
  await runReviewJob(h.job, h.deps);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'published');
  assert.deepEqual(h.logged.filter((e) => e.event === 'thread_followup').map((e) => [e.replied, e.resolved, e.failed]), [[0, 0, 1]]);
  await published({ pullRequest: 8 });
  const unread = await live({ pullRequest: 8, threads: [[THREAD], new Error('github_502')], result: okResult({ threadVerdicts: [VERDICT], threadsDue: 1 }) });
  await runReviewJob(unread.job, unread.deps);
  assert.deepEqual(unread.logged.filter((e) => e.event === 'thread_followup_failed'), [{ event: 'thread_followup_failed', job: unread.job.id, reason: 'github_502' }]);
  const j = await getJob(db, unread.job.id);
  assert.deepEqual([j?.status, j?.outcome], ['done', 'published']);
  assert.equal(unread.writes.some((w) => w[0] === 'replyToThread'), false);
});
test('a recorded review that is published by a later start writes its verdicts too', async () => {
  await published();
  await recorded({ result: okResult({ threadVerdicts: [VERDICT], threadsDue: 1 }) });
  const h = await live({ own: [[{ id: '401', commit: 'h0' }]], threads: [[THREAD]] });
  await runReviewJob(h.job, h.deps);
  assert.equal(h.inputs.length, 0);
  assert.deepEqual(h.writes.map((w) => w[0]), ['listOwnReviews', 'publishReview', 'listReviewComments', 'listThreads', 'replyToThread', 'resolveThread']);
  assert.deepEqual(h.writes[4], ['replyToThread', 'PRRT_1', REPLY]);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'published');
  // the review was posted already: publishRun adopts it, and its verdicts are written under its id
  const ref8 = { ...REF, number: 8 };
  await published({ pullRequest: 8 });
  await recorded({ ref: ref8, result: okResult({ threadVerdicts: [VERDICT], threadsDue: 1 }) });
  const adopted = await live({ pullRequest: 8, own: [[{ id: '502', commit: 'h1' }, { id: '401', commit: 'h0' }]], threads: [[THREAD]] });
  await runReviewJob(adopted.job, adopted.deps);
  assert.equal(adopted.writes.some((w) => w[0] === 'publishReview'), false);
  assert.deepEqual(adopted.writes.filter((w) => w[0] === 'replyToThread'), [['replyToThread', 'PRRT_1', REPLY.replace('review=501', 'review=502')]]);
  assert.deepEqual(adopted.logged.filter((e) => e.event === 'thread_followup').map((e) => e.review), ['502']);
});
test('a retargeted pull request at a head already reviewed is reviewed and posted, not adopted', async () => {
  await published({ head: 'h1' });
  const h = await live({ live: OTHER_BASE, own: [[{ id: '401', commit: 'h1' }]] });
  await runReviewJob(h.job, h.deps);
  assert.equal(h.inputs.length, 1);
  assert.equal(h.writes.filter((w) => w[0] === 'publishReview').length, 1);
  const newest = (await listRuns(db, REF)).at(-1)!;
  assert.deepEqual([newest.baseSha, newest.published, newest.reviewId], ['merge999', true, '501']);
});
test('in dry run a later head is reviewed as before, and nothing is read or written', async () => {
  await published();
  const h = await harness({ dryRun: true });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual(h.writes, []);
  assert.equal(h.inputs[0]!.earlier, null);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'reviewed');
});
test('the review entry counts the threads that were due, the verdicts and the duplicates', async () => {
  await published();
  const h = await live({ threads: [[THREAD]], result: okResult({ threadVerdicts: [VERDICT], threadsDue: 1 }) });
  await runReviewJob(h.job, h.deps);
  const entry = h.logged.find((e) => e.event === 'review')!;
  assert.deepEqual([entry.threads_due, entry.verdicts, entry.duplicates], [1, 1, 0]);
  await recorded({ ref: { ...REF, number: 8 } });
  const resumed = await live({ pullRequest: 8 });
  await runReviewJob(resumed.job, resumed.deps);
  const stored = resumed.logged.find((e) => e.event === 'review')!;
  assert.deepEqual([stored.resumed, stored.threads_due, stored.verdicts, stored.duplicates], [true, 0, 0, 0]);
});

/** The rows of block_scores, oldest first. */
const blockRows = (): Promise<Array<{ run: number; number: number; path: string; hash: string; score: number; category: string; reason: string; scored_by: string; scored_at: Date }>> =>
  db.query('select run, number, path, hash, score, category, reason, scored_by, scored_at from visto_ai.block_scores order by id');
/** A finished review with flaggedResult's one scored block. */
const scoredResult = (over: Partial<ReviewResult> = {}): ReviewResult => okResult({ scores: flaggedResult().scores, verdict: flaggedResult().verdict, ...over });
const OWN_401 = [[{ id: '401', commit: 'h0' }]];

test('a push after a review is reviewed incrementally, with the history of the earlier runs', async () => {
  await published({ head: 'h0' });
  const h = await live({ own: OWN_401 });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([h.inputs[0]!.mode, h.inputs[0]!.history?.lastReview?.head, h.inputs[0]!.history?.by], ['incremental', 'h0', 'model']);
  assert.deepEqual([(await listRuns(db, REF)).at(-1)!.mode, (await listRuns(db, REF)).at(-1)!.baseBranch], ['incremental', 'main']);
});
test('a repository set to full is reviewed in full at every head, with its history', async () => {
  await published({ head: 'h0' });
  const h = await live({ own: OWN_401, settings: { ...SETTINGS, newHead: 'full' } });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([h.inputs[0]!.mode, h.inputs[0]!.history?.lastReview?.head], ['full', 'h0']);
  assert.equal((await listRuns(db, REF)).at(-1)!.mode, 'full');
});
test('a first review is a full review with an empty history', async () => {
  const h = await live();
  await runReviewJob(h.job, h.deps);
  assert.equal(h.inputs[0]!.mode, 'full');
  assert.deepEqual([h.inputs[0]!.history?.files, h.inputs[0]!.history?.lastReview, h.inputs[0]!.history?.shown], [[], null, null]);
  assert.equal((await listRuns(db, REF))[0]!.mode, 'full');
});
test('a pull request moved to another base branch is reviewed in full', async () => {
  await published({ baseBranch: 'main' });
  const h = await live({ own: OWN_401, live: { ...LIVE, info: { ...LIVE.info, baseBranch: 'release' } } });
  await runReviewJob(h.job, h.deps);
  assert.equal(h.inputs[0]!.mode, 'full');
  assert.deepEqual([(await listRuns(db, REF)).at(-1)!.mode, (await listRuns(db, REF)).at(-1)!.baseBranch], ['full', 'release']);
});
test('a review stored before base branches were kept is followed by one full review', async () => {
  await published({ baseBranch: null });
  const h = await live({ own: OWN_401 });
  await runReviewJob(h.job, h.deps);
  assert.equal(h.inputs[0]!.mode, 'full');
  const next = await live({ head: 'h2', own: [[{ id: '501', commit: 'h1' }, { id: '401', commit: 'h0' }]] });
  await runReviewJob(next.job, next.deps);
  assert.equal(next.inputs[0]!.mode, 'incremental');
});
test('a /review on a head that has its review is a re-check, not a refusal', async () => {
  await published({ head: 'h1' });
  const h = await manualJob({ own: [[{ id: '401', commit: 'h1' }]] });
  await runReviewJob(h.job, h.deps);
  assert.equal(h.writes.some((w) => w[0] === 'react' && w[2] === 'eyes'), true);
  assert.equal(h.writes.some((w) => w[0] === 'react' && w[2] === 'confused'), false);
  assert.equal(h.writes.some((w) => w[0] === 'comment' && String(w[1]).includes('was not started')), false);
  assert.deepEqual([h.inputs[0]!.mode, h.inputs[0]!.history?.lastReview?.head, (await getJob(db, h.job.id))?.outcome], ['recheck', 'h1', 'published']);
  assert.equal((await listRuns(db, REF)).at(-1)!.mode, 'recheck');
});
test('a /review on a head whose review was stored before this plan is a re-check too', async () => {
  const old: Record<string, unknown> = { ...EARLIER_RESULT };
  delete old['mode'];
  await published({ head: 'h1', baseBranch: null, result: old });
  const h = await manualJob({ own: [[{ id: '401', commit: 'h1' }]] });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([h.inputs[0]!.mode, (await getJob(db, h.job.id))?.outcome], ['recheck', 'published']);
});
test('a push on a head that has its review is still dropped', async () => {
  await published({ head: 'h1' });
  const h = await live({ own: [[{ id: '401', commit: 'h1' }]] });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([(await getJob(db, h.job.id))?.status, (await getJob(db, h.job.id))?.outcome, h.inputs.length], ['dropped', 'already_reviewed', 0]);
});
test('a /review on a head with a review the database does not know is still refused', async () => {
  await published({ head: 'h1' });
  const h = await manualJob({ own: [[{ id: '470', commit: 'h1' }, { id: '401', commit: 'h1' }]] });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([h.inputs.length, (await getJob(db, h.job.id))?.outcome], [0, 'refused']);
  assert.deepEqual(h.writes.at(-1), ['comment', '@octo-lead The review was not started (`already_reviewed`).']);
});
test('a /review on a reviewed head does not post a leftover row of the review that is already there', async () => {
  const leftover = await recorded({ headSha: 'h1', baseBranch: 'main' });
  await published({ head: 'h1' });
  const h = await manualJob({ own: [[{ id: '401', commit: 'h1' }]] });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([h.inputs.length, h.inputs[0]!.mode, (await getJob(db, h.job.id))?.outcome], [1, 'recheck', 'published']);
  const runs = await listRuns(db, REF);
  assert.equal(runs.find((r) => r.id === leftover)!.published, false);
  assert.deepEqual([runs.length, runs.at(-1)!.published, runs.at(-1)!.mode], [3, true, 'recheck']);
});
test('a /review on a reviewed head publishes a stored review newer than the published one, as it was recorded', async () => {
  await published({ head: 'h1' });
  const waiting = await recorded({ headSha: 'h1', baseBranch: 'main', mode: 'incremental', result: okResult({ mode: 'incremental', since: 'h0' }) });
  const stored = (await listRuns(db, REF)).find((r) => r.id === waiting)!;
  const h = await manualJob({ own: [[{ id: '401', commit: 'h1' }]] });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([h.inputs.length, (await getJob(db, h.job.id))?.outcome], [0, 'published']);
  const posts = h.writes.filter((w) => w[0] === 'publishReview');
  assert.deepEqual(posts, [['publishReview', 'h1', stored.body, 1]]);
  assert.equal(String(posts[0]![2]).split('\n')[0], stored.body.split('\n')[0]);
  const after = (await listRuns(db, REF)).find((r) => r.id === waiting)!;
  assert.deepEqual([after.published, after.mode], [true, 'incremental']);
});
test('a review the engine threw on is stored with the mode that was decided', async () => {
  await published({ head: 'h0' });
  const h = await live({ own: OWN_401 });
  h.deps.review = () => Promise.reject(new Error('boom'));
  await runReviewJob(h.job, h.deps);
  const run = (await listRuns(db, REF)).at(-1)!;
  assert.deepEqual([run.outcome, run.failureStage, run.mode], ['failed', 'engine', 'incremental']);
});
test('a re-check is not the last review: the next push is planned from the review before it', async () => {
  await published({ head: 'h0', result: okResult({ overview: 'First.' }) });
  const recheck = okResult({ mode: 'recheck', overview: 'Second.', scores: flaggedResult().scores, verdict: flaggedResult().verdict });
  await published({ head: 'h0', mode: 'recheck', reviewId: '402', comments: [], result: recheck });
  const h = await live({ own: [[{ id: '402', commit: 'h0' }, { id: '401', commit: 'h0' }]] });
  await runReviewJob(h.job, h.deps);
  assert.equal(h.inputs[0]!.history?.lastReview?.overview, 'First.');
  assert.equal(h.inputs[0]!.history?.shown, shownOf(recheck));
  assert.notEqual(shownOf(recheck), shownOf(okResult({ overview: 'First.' })));
});
test('with a scorer in force the history and the stored scores are the scorer\'s', async () => {
  await published({ head: 'h0' });
  const h = await live({ own: OWN_401, result: scoredResult({ mode: 'incremental' }) });
  h.deps.engineDeps = () => ({ scorer: { score: () => Promise.reject(new Error('not_expected')) } }) as unknown as ReviewDeps;
  await runReviewJob(h.job, h.deps);
  assert.equal(h.inputs[0]!.history?.by, 'scorer');
  assert.deepEqual((await blockRows()).map((r) => [r.hash, r.scored_by]), [['h', 'scorer']]);
});
test('with nothing new a push is finished without a review', async () => {
  await published({ head: 'h0' });
  const nothing = okResult({ nothingToDo: true, mode: 'incremental' });
  const h = await live({ own: OWN_401, threads: [[THREAD]], result: nothing });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([(await getJob(db, h.job.id))?.status, (await getJob(db, h.job.id))?.outcome], ['done', 'nothing_new']);
  const run = (await listRuns(db, REF)).at(-1)!;
  assert.deepEqual([run.outcome, run.body, run.comments, run.published, run.mode], ['ok', '', [], false, 'incremental']);
  assert.equal(h.writes.some((w) => w[0] === 'publishReview'), false);
  assert.equal(h.writes.filter((w) => w[0] === 'listThreads').length, 1);
  assert.equal(h.writes.some((w) => w[0] === 'react' || w[0] === 'comment'), false);
});
test('a second start on a head that had nothing new publishes nothing', async () => {
  await published({ head: 'h0' });
  const nothing = okResult({ nothingToDo: true, mode: 'incremental' });
  const first = await live({ own: OWN_401, result: nothing });
  await runReviewJob(first.job, first.deps);
  const again = await live({ own: OWN_401, result: nothing });
  await runReviewJob(again.job, again.deps);
  assert.deepEqual([again.inputs.length, (await getJob(db, again.job.id))?.outcome], [1, 'nothing_new']);
  assert.equal(again.writes.some((w) => w[0] === 'publishReview'), false);
});
test('with nothing new a command gets its review', async () => {
  await published({ head: 'h0' });
  const h = await manualJob({ own: OWN_401, result: okResult({ nothingToDo: true, mode: 'incremental' }) });
  await runReviewJob(h.job, h.deps);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'published');
  assert.equal(h.writes.filter((w) => w[0] === 'publishReview').length, 1);
});
test('a review with no model call that is not nothing new is published', async () => {
  await published({ head: 'h0' });
  const h = await live({ own: OWN_401, result: okResult({ mode: 'incremental', usage: NO_CALLS, coverage: { reviewed: [], notReviewed: [{ path: 'logo.bin', reason: 'no_diff' }] } }) });
  await runReviewJob(h.job, h.deps);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'published');
});
test('the scores a run gave are stored for other pull requests', async () => {
  const h = await live({ result: scoredResult() });
  await runReviewJob(h.job, h.deps);
  const [run] = await listRuns(db, REF);
  assert.deepEqual((await blockRows()).map((r) => [r.run, r.number, r.path, r.hash, r.score, r.category, r.reason, r.scored_by, r.scored_at.toISOString()]),
    [[run!.id, 7, 'a.ts', 'h', 80, 'calculation', '', 'model', run!.finishedAt]]);
});
test('a failure to store the scores changes nothing, and they are stored once', async () => {
  const h = await live({ result: scoredResult() });
  let attempts = 0;
  const inner = h.deps.db;
  h.deps.db = {
    ...inner,
    query: (text, params) => {
      if (text.includes('insert into visto_ai.block_scores')) { attempts += 1; return Promise.reject(new Error('Something private broke')); }
      return inner.query(text, params);
    },
  };
  await runReviewJob(h.job, h.deps);
  const runs = await listRuns(db, REF);
  assert.deepEqual([(await getJob(db, h.job.id))?.outcome, runs.length, attempts, (await blockRows()).length], ['published', 1, 1, 0]);
  assert.deepEqual(h.logged.filter((e) => e.event === 'scores_store_failed'), [{ event: 'scores_store_failed', job: h.job.id, run: runs[0]!.id, reason: 'internal_error' }]);
});
test('the scores of a run whose text could not be rendered are stored, and a resumed run stores none again', async () => {
  const unrendered = await live({ renderThrows: true });
  await runReviewJob(unrendered.job, unrendered.deps);
  assert.equal((await getJob(db, unrendered.job.id))?.outcome, 'render_failed');
  assert.deepEqual((await blockRows()).map((r) => [r.number, r.hash]), [[7, 'h']]);
  const before = await live({ pullRequest: 8, result: scoredResult(), posts: [new Error('github_502')] });
  await runReviewJob(before.job, before.deps);
  const again = await live({ pullRequest: 8, reuseJob: before.job.id });
  await runReviewJob(again.job, again.deps);
  assert.deepEqual([again.inputs.length, (await getJob(db, again.job.id))?.outcome], [0, 'published']);
  assert.deepEqual((await blockRows()).map((r) => [r.number, r.hash]), [[7, 'h'], [8, 'h']]);
});
test('the scores of a push with nothing new are stored', async () => {
  await published({ head: 'h0' });
  const h = await live({ own: OWN_401, result: scoredResult({ nothingToDo: true, mode: 'incremental' }) });
  await runReviewJob(h.job, h.deps);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'nothing_new');
  assert.deepEqual((await blockRows()).map((r) => [r.run, r.hash]), [[(await listRuns(db, REF)).at(-1)!.id, 'h']]);
});
test('the engine can look up scores other pull requests stored in the last 30 days', async () => {
  const other = { ...REF, number: 8 };
  const day = 86_400;
  await recordBlockScores(db, 1, other, 'model', [{ path: 'src/a.ts', hash: 'k1', score: 60, category: 'calculation', reason: 'Totals.' }], at(-29 * day));
  await recordBlockScores(db, 2, other, 'model', [{ path: 'src/a.ts', hash: 'k2', score: 50, category: 'fix', reason: 'Old.' }], at(-31 * day));
  await recordBlockScores(db, 3, other, 'model', [{ path: 'src/a.ts', hash: 'k3', score: 40, category: 'made_up', reason: 'Odd.' }], at(-29 * day));
  const h = await live();
  await runReviewJob(h.job, h.deps);
  const lookUp = h.engines[0]!.reusableScores!;
  assert.deepEqual(await lookUp([{ path: 'src/a.ts', hash: 'k1' }, { path: 'src/a.ts', hash: 'k2' }, { path: 'src/a.ts', hash: 'k3' }]), [
    { path: 'src/a.ts', hash: 'k1', entry: { score: 60, category: 'calculation', reason: 'Totals.' } },
    { path: 'src/a.ts', hash: 'k3', entry: { score: 40, category: 'other', reason: 'Odd.' } },
  ]);
});
test('in dry run nothing of this happens', async () => {
  await published({ head: 'h0' });
  const h = await harness({ dryRun: true, result: scoredResult() });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual(['mode' in h.inputs[0]!, 'history' in h.inputs[0]!, 'reusableScores' in h.engines[0]!], [false, false, false]);
  assert.deepEqual(await blockRows(), []);
  assert.equal((await listRuns(db, REF)).at(-1)!.mode, 'full');
});
test('the review entry says the mode, the count and whether nothing was new', async () => {
  await published({ head: 'h0' });
  const h = await live({ own: OWN_401 });
  await runReviewJob(h.job, h.deps);
  const entry = h.logged.find((e) => e.event === 'review')!;
  assert.deepEqual([entry.mode, entry.blocking_on_unchanged, entry.nothing_new], ['incremental', null, false]);
  await published({ head: 'h0', pullRequest: 8 });
  const full = await live({ pullRequest: 8, own: OWN_401, settings: { ...SETTINGS, newHead: 'full' }, result: okResult({ blockingOnUnchanged: 2 }) });
  await runReviewJob(full.job, full.deps);
  const later = full.logged.find((e) => e.event === 'review')!;
  assert.deepEqual([later.mode, later.blocking_on_unchanged, later.nothing_new], ['full', 2, false]);
  const nothing = await live({ pullRequest: 9, result: okResult({ nothingToDo: true, mode: 'incremental' }) });
  await runReviewJob(nothing.job, nothing.deps);
  assert.equal(nothing.logged.find((e) => e.event === 'review')!.nothing_new, true);
});
test('a review with nothing new whose text cannot be rendered still ends as nothing new', async () => {
  await published({ head: 'h0' });
  const h = await live({ own: OWN_401, renderThrows: true, result: { ...flaggedResult(), nothingToDo: true, mode: 'incremental' } });
  await runReviewJob(h.job, h.deps);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'nothing_new');
  assert.equal(h.logged.some((e) => e.event === 'render_failed'), true);
  assert.equal(h.writes.some((w) => w[0] === 'publishReview'), false);
});
test('a review adopted late is the last review the mode is worked out from', async () => {
  await recorded({ headSha: 'h0', result: EARLIER_RESULT, baseBranch: 'main' });
  const h = await live({ own: [[{ id: '401', commit: 'h0' }]], threads: [[THREAD]] });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([h.inputs[0]!.mode, h.inputs[0]!.history?.lastReview?.head], ['incremental', 'h0']);
});
test('a write tried again that finds the job finished stores no scores under the run that was rolled back', async () => {
  await published({ head: 'h0' });
  const h = await live({ own: OWN_401, result: scoredResult({ nothingToDo: true, mode: 'incremental' }) });
  const inner = h.deps.db;
  let first = true;
  h.deps.db = {
    ...inner,
    transaction: async (work) => {
      let recordedRun = false;
      try {
        return await inner.transaction(async (tx) => {
          const out = await work({ ...tx, query: (text, params) => { if (text.includes('insert into visto_ai.review_runs')) recordedRun = true; return tx.query(text, params); } });
          if (first && recordedRun) throw new Error('db_down');
          return out;
        });
      } catch (error) {
        // Rolled back; before the write is tried again another start finishes the job.
        if (first && recordedRun) { first = false; await finishJob(db, h.job.id, 'done', 'nothing_new', at(0)); }
        throw error;
      }
    },
  };
  await runReviewJob(h.job, h.deps);
  assert.equal(first, false);
  assert.deepEqual(await blockRows(), []);
  assert.equal(h.logged.some((e) => e.event === 'scores_store_failed'), false);
});
test('the review entry says nothing was new only when the job ended so', async () => {
  await published({ head: 'h0' });
  const h = await manualJob({ own: OWN_401, result: okResult({ nothingToDo: true, mode: 'incremental' }) });
  await runReviewJob(h.job, h.deps);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'published');
  assert.equal(h.logged.find((e) => e.event === 'review')!.nothing_new, false);
});
