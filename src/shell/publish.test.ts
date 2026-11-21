import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReview } from '../engine/render/body.ts';
import type { ReviewResult } from '../engine/types.ts';
import type { ForgeAccess, ForgeWriter, LivePullRequest, PostedComment } from '../forge/types.ts';
import type { StoredRun } from '../db/review-runs.ts';
import { publishRun } from './publish.ts';
import type { PublishOutcome } from './publish.ts';

const REF = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;
const at = (seconds: number): string => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000).toISOString();
const LIVE: LivePullRequest = {
  info: { ref: REF, title: 'Add things', description: '', author: 'octo-dev', baseBranch: 'main', headBranch: 'feat', baseSha: 'merge000', headSha: 'h1', draft: false },
  state: 'open',
};
const USAGE = { calls: 2, inputTokens: 1000, outputTokens: 200, cachedTokens: 50, cost: 0.5 };
const okResult = (): ReviewResult => ({
  status: 'ok', failure: null, mode: 'full', overview: 'Looks fine.',
  findings: [{ path: 'a.ts', side: 'RIGHT', line: 3, severity: 'minor', body: 'A note.', quote: 'x', requestedLine: null }],
  unplaced: [], beyondDiff: [], coverage: { reviewed: ['a.ts'], notReviewed: [] }, usage: USAGE, models: ['m'], providers: [],
  dependencies: { model: 'ok' }, audit: [], scores: [], verdict: { threshold: 70, needsHuman: false, highest: 35 }, teamFileInvalid: null,
});
const lineUrl = (): string => 'https://forge.example.test/line';
const rendered = renderReview(okResult(), { trigger: 'automatic', requestedBy: null, lineUrl, inline: true });
const run: StoredRun = {
  id: 4, ref: REF, job: 1, trigger: 'automatic', mode: 'full', dryRun: false, headSha: 'h1', baseSha: 'merge000', baseBranch: null,
  outcome: 'ok', failureStage: null, failureCode: null, needsHuman: false, highestScore: 35,
  body: rendered.body, comments: rendered.comments, result: okResult(), usage: USAGE, startedAt: at(0), finishedAt: at(1),
  published: false, reviewId: null, publishedAt: null, inlineDropped: false,
};

interface Options {
  live?: LivePullRequest | Error | null;
  own?: Array<{ id: string; commit: string }> | Error;
  posted?: PostedComment[] | Error;
  posts?: Array<{ id: string } | Error>;
  run?: StoredRun;
  /** The ids of the reviews the database holds as published; none when not given. */
  known?: ReadonlySet<string>;
}

function harness(options: Options = {}) {
  const calls: unknown[][] = [];
  const posts = [...(options.posts ?? [])];
  const live = options.live === undefined ? LIVE : options.live;
  const forge = {
    readPullRequest: async () => { if (live instanceof Error) throw live; return live; },
  } as unknown as ForgeAccess;
  const writer: ForgeWriter = {
    publishReview: async (_ref, _installation, draft) => {
      calls.push(['publishReview', draft.commit, draft.body, draft.comments.length]);
      const next = posts.shift() ?? { id: '501' };
      if (next instanceof Error) throw next;
      return next;
    },
    listOwnReviews: async () => {
      calls.push(['listOwnReviews']);
      const own = options.own ?? [];
      if (own instanceof Error) throw own;
      return own;
    },
    listReviewComments: async () => {
      calls.push(['listReviewComments']);
      const posted = options.posted ?? [{ id: '9001', path: 'a.ts', side: 'RIGHT', line: 3, body: 'x' }];
      if (posted instanceof Error) throw posted;
      return posted;
    },
    react: async () => { calls.push(['react']); },
    comment: async () => { calls.push(['comment']); },
    listThreads: () => Promise.reject(new Error('not_expected')),
    replyToThread: () => Promise.reject(new Error('not_expected')),
    editThreadComment: () => Promise.reject(new Error('not_expected')),
    resolveThread: () => Promise.reject(new Error('not_expected')),
  };
  return {
    calls, deps: { forge, writer, lineUrl, commentUrl: (_ref: unknown, id: string) => `https://forge.example.test/c/${id}` },
    args: { ref: REF, installation: '99', run: options.run ?? run, trigger: 'automatic' as const, requestedBy: null, known: options.known ?? new Set<string>() },
  };
}

test('a review is posted pinned to the commit it was computed for', async () => {
  const h = harness();
  assert.deepEqual(await publishRun(h.deps, h.args), { kind: 'published', reviewId: '501', body: run.body, inlineDropped: false, adopted: false });
  assert.deepEqual(h.calls, [['listOwnReviews'], ['publishReview', 'h1', run.body, 1]]);
});
test('a review an earlier attempt already posted is adopted, and nothing is posted', async () => {
  const h = harness({ own: [{ id: '480', commit: 'h1' }] });
  assert.deepEqual(await publishRun(h.deps, h.args), { kind: 'published', reviewId: '480', body: run.body, inlineDropped: false, adopted: true });
  assert.equal(h.calls.some((c) => c[0] === 'publishReview'), false);
});
test('an adopted review that was posted without its inline comments is recorded as such', async () => {
  const h = harness({ own: [{ id: '480', commit: 'h1' }], posted: [] });
  const out = await publishRun(h.deps, h.args);
  assert.equal(out.kind, 'published');
  if (out.kind !== 'published') return;
  assert.deepEqual([out.reviewId, out.adopted, out.inlineDropped, out.body !== run.body], ['480', true, true, true]);
});
test('a review on another commit does not stop the post', async () => {
  const h = harness({ own: [{ id: '401', commit: 'h0' }], known: new Set(['401']) });
  assert.deepEqual(await publishRun(h.deps, h.args), { kind: 'published', reviewId: '501', body: run.body, inlineDropped: false, adopted: false });
  assert.deepEqual(h.calls, [['listOwnReviews'], ['publishReview', 'h1', run.body, 1]]);
});
test('only a review on this commit that the database does not know is adopted', async () => {
  const unknown = harness({ own: [{ id: '401', commit: 'h1' }] });
  assert.deepEqual(await publishRun(unknown.deps, unknown.args), { kind: 'published', reviewId: '401', body: run.body, inlineDropped: false, adopted: true });
  assert.equal(unknown.calls.some((c) => c[0] === 'publishReview'), false);
  const known = harness({ own: [{ id: '401', commit: 'h1' }], known: new Set(['401']) });
  assert.deepEqual(await publishRun(known.deps, known.args), { kind: 'published', reviewId: '501', body: run.body, inlineDropped: false, adopted: false });
  assert.deepEqual(known.calls, [['listOwnReviews'], ['publishReview', 'h1', run.body, 1]]);
});
test('nothing is posted for a head or a base that moved, or on a pull request that is closed or gone', async () => {
  const cases: Array<[LivePullRequest | null, PublishOutcome]> = [
    [{ ...LIVE, info: { ...LIVE.info, headSha: 'h2' } }, { kind: 'moved', head: 'h2' }],
    [{ ...LIVE, info: { ...LIVE.info, baseSha: 'merge999' } }, { kind: 'moved', head: 'h1' }],
    [{ ...LIVE, state: 'closed' }, { kind: 'closed' }], [{ ...LIVE, state: 'merged' }, { kind: 'closed' }], [null, { kind: 'closed' }],
  ];
  for (const [live, expected] of cases) {
    const h = harness({ live });
    assert.deepEqual(await publishRun(h.deps, h.args), expected);
    assert.deepEqual(h.calls, []);
  }
});
test('a run with no base moved: its base never equals the live one', async () => {
  const h = harness({ run: { ...run, baseSha: null } });
  assert.deepEqual(await publishRun(h.deps, h.args), { kind: 'moved', head: 'h1' });
  assert.deepEqual(h.calls, []);
});
test('when the inline comments are refused, the review is posted with their text in its body, still pinned', async () => {
  const h = harness({ posts: [new Error('review_rejected'), { id: '502' }] });
  const out = await publishRun(h.deps, h.args);
  assert.equal(out.kind, 'published');
  if (out.kind !== 'published') return;
  assert.deepEqual([out.reviewId, out.inlineDropped, out.adopted, out.body !== run.body], ['502', true, false, true]);
  assert.deepEqual(h.calls.slice(1), [['publishReview', 'h1', run.body, 1], ['publishReview', 'h1', out.body, 0]]);
});
test("the fallback's body is the review rendered without inline comments", async () => {
  const h = harness({ posts: [new Error('review_rejected'), { id: '502' }] });
  const out = await publishRun(h.deps, h.args);
  assert.equal(out.kind, 'published');
  if (out.kind !== 'published') return;
  assert.equal(out.body, renderReview(okResult(), { trigger: 'automatic', requestedBy: null, lineUrl, inline: false }).body);
});
test('a review the git service refuses twice, or refuses with no inline comment, is rejected', async () => {
  const twice = harness({ posts: [new Error('review_rejected'), new Error('review_rejected')] });
  assert.deepEqual(await publishRun(twice.deps, twice.args), { kind: 'rejected' });
  const bare = harness({ posts: [new Error('review_rejected')], run: { ...run, comments: [] } });
  assert.deepEqual(await publishRun(bare.deps, bare.args), { kind: 'rejected' });
  assert.equal(bare.calls.filter((c) => c[0] === 'publishReview').length, 1);
});
test('any other failure says so with its code, and a post that failed is not repeated', async () => {
  const cases: Array<[Options, string]> = [
    [{ live: new Error('github_502') }, 'github_502'], [{ own: new Error('github_network') }, 'github_network'],
    [{ own: [{ id: '480', commit: 'h1' }], posted: new Error('github_502') }, 'github_502'],
    [{ posts: [new Error('github_502')] }, 'github_502'], [{ posts: [new Error('Something private')] }, 'internal_error'],
    [{ posts: [new Error('review_rejected'), new Error('github_network')] }, 'github_network'],
  ];
  for (const [options, code] of cases) {
    const h = harness(options);
    assert.deepEqual(await publishRun(h.deps, h.args), { kind: 'failed', code });
    assert.equal(h.calls.filter((c) => c[0] === 'publishReview').length, options?.posts?.length ?? 0);
  }
});
test("the body-only form links each finding already discussed to its earlier thread", async () => {
  const result: ReviewResult = { ...okResult(), alreadyDiscussed: [{ path: 'a.ts', side: 'RIGHT', line: 3, severity: 'major', body: 'Raised before.', commentId: '8001', resolved: false, settled: false }] };
  const h = harness({ posts: [new Error('review_rejected'), { id: '502' }], run: { ...run, result } });
  const out = await publishRun(h.deps, h.args);
  assert.equal(out.kind, 'published');
  if (out.kind !== 'published') return;
  assert.equal(out.inlineDropped, true);
  assert.ok(out.body.includes('## Already discussed'));
  assert.ok(out.body.includes('(https://forge.example.test/c/8001)'));
});
