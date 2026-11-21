import type { RepoSettings } from '../config/load.ts';
import { enqueueJob, finishJob, requeueJob } from '../db/jobs.ts';
import type { Job } from '../db/jobs.ts';
import { recordBlockScores, reusableScores } from '../db/block-scores.ts';
import { getPullRequest } from '../db/pull-requests.ts';
import { listComments, recordComments } from '../db/review-comments.ts';
import type { StoredComment } from '../db/review-comments.ts';
import { adoptableRun, hasOkRun, hasRun, listRuns, markPublished, recordRun, unpublishedRun } from '../db/review-runs.ts';
import type { RunRecord, StoredRun } from '../db/review-runs.ts';
import type { Db } from '../db/types.ts';
import { renderReview } from '../engine/render/body.ts';
import type { InlineComment } from '../engine/render/body.ts';
import type { Category, ScoredBy, Span } from '../engine/score/types.ts';
import type { EarlierState, Limits, ReviewDeps, ReviewInput, ReviewResult, ThreadVerdict, Usage } from '../engine/types.ts';
import type { ForgeAccess, ForgeWriter, LivePullRequest, PullRequestInfo, PullRequestRef, ReviewThread, Source } from '../forge/types.ts';
import { PAUSE_MS } from './model-health.ts';
import type { ModelHealth } from './model-health.ts';
import { codeOf } from './codes.ts';
import { failureText, mayCommand, refusalText } from './commands.ts';
import { earlierOf, missedComments } from './earlier.ts';
import { matchPosted } from './posted.ts';
import { publishRun } from './publish.ts';
import type { PublishOutcome } from './publish.ts';
import { CATEGORY_NAMES, historyOf, lastReviewOf, scoresToStore } from './history.ts';
import { followUp, planFollowUp } from './thread-followup.ts';
import { QUIET_SECONDS, skipReason } from './triggers.ts';

export const RECORD_WAITS_MS = [1_000, 5_000];
/** The wait before a job the git service failed is tried again: after its first start, then after its second or third. */
export const RETRY_WAITS_MS = [60_000, 900_000];
/** How old a stored, unpublished review may be and still be published by a later start of its job. */
export const STORED_REVIEW_MS = 24 * 3_600_000;
/** How many days back a score another pull request stored may be reused. */
export const REUSE_DAYS = 30;

type Log = (entry: Record<string, unknown>) => void;

export interface ReviewJobDeps {
  db: Db; forge: ForgeAccess; clock: () => Date; log: (entry: Record<string, unknown>) => void;
  sleep: (ms: number) => Promise<void>;
  settingsFor: (fullName: string) => RepoSettings;
  limits: Limits;
  dryRun: boolean;
  /** The only way the job writes to the git service; never called in dry run. */
  writer: ForgeWriter;
  /** The engine's dependencies for one review, around the source it is given. */
  engineDeps: (source: Source) => ReviewDeps;
  /** The engine's entry point. */
  review: (input: ReviewInput, deps: ReviewDeps) => Promise<ReviewResult>;
  lineUrl: (pr: PullRequestInfo, file: { path: string; previousPath: string | null }, span: Span) => string;
  /** A link to one review comment of the pull request. */
  commentUrl: (ref: PullRequestRef, commentId: string) => string;
  /** Whether the app may resolve a review thread. */
  canResolve: () => Promise<boolean>;
  health: Pick<ModelHealth, 'reviewed'>;
  spend: { noteRun(usage: Usage): void };
}

/** The newest published run of these, or null. */
function newestPublished(runs: StoredRun[]): StoredRun | null {
  let newest: StoredRun | null = null;
  for (const r of runs) if (r.published && (newest === null || r.id > newest.id)) newest = r;
  return newest;
}

/** The review ids of the published runs. */
function knownOf(runs: StoredRun[]): Set<string> {
  return new Set(runs.filter((r) => r.published && r.reviewId !== null).map((r) => r.reviewId!));
}

const NO_USAGE: Usage = { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0 };

/** The number of findings of an engine result, or of a stored one; 0 when it has none that can be counted. */
function findingsOf(result: unknown): number {
  const findings = (result as { findings?: unknown } | null | undefined)?.findings;
  return Array.isArray(findings) ? findings.length : 0;
}

/** The thread verdicts an engine result, or a stored one, kept; none when it has none. */
function verdictsOf(result: unknown): ThreadVerdict[] {
  const verdicts = (result as { threadVerdicts?: unknown } | null | undefined)?.threadVerdicts;
  return Array.isArray(verdicts) ? verdicts as ThreadVerdict[] : [];
}

/** How many threads an engine result, or a stored one, owed a verdict; 0 when it does not say. */
function threadsDueOf(result: unknown): number {
  const due = (result as { threadsDue?: unknown } | null | undefined)?.threadsDue;
  return typeof due === 'number' && Number.isFinite(due) ? due : 0;
}

/** How many blocker and major findings an engine result, or a stored one, has on unchanged lines; null when it does not say. */
function blockingOnUnchangedOf(result: unknown): number | null {
  const count = (result as { blockingOnUnchanged?: unknown } | null | undefined)?.blockingOnUnchanged;
  return typeof count === 'number' && Number.isFinite(count) ? count : null;
}

/** Whether an engine result, or a stored one, says it had nothing new. */
function nothingNewOf(result: unknown): boolean {
  return (result as { nothingToDo?: unknown } | null | undefined)?.nothingToDo === true;
}

/** How many findings an engine result, or a stored one, dropped as already discussed; 0 when it does not say. */
function duplicatesOf(result: unknown): number {
  const discussed = (result as { alreadyDiscussed?: unknown } | null | undefined)?.alreadyDiscussed;
  return Array.isArray(discussed) ? discussed.length : 0;
}

/**
 * Takes one claimed job to its end: drops it, puts it back, or reviews and records; not in dry run, then publishes.
 * A manual job is first checked, refused or accepted, and answered on the pull request once it is finished. Never rejects.
 */
export async function runReviewJob(job: Job, deps: ReviewJobDeps): Promise<void> {
  const { db } = deps;
  const repo = `${job.ref.owner}/${job.ref.repo}`;
  const manual = job.trigger === 'manual';
  const requestedBy = manual ? job.requestedBy : null;
  const log: Log = (entry) => {
    try {
      deps.log(entry);
    } catch {
      // a logger that fails changes nothing
    }
  };
  const now = deps.clock();
  const nowIso = now.toISOString();
  const at = (ms: number): string => new Date(now.getTime() + ms).toISOString();
  /** `ms` after the clock as it reads now; after the job's start when the clock fails. */
  const later = (ms: number): string => {
    let t = now;
    try {
      t = deps.clock();
    } catch {
      // a clock that fails leaves the start's time
    }
    return new Date(t.getTime() + ms).toISOString();
  };
  const retryWait = RETRY_WAITS_MS[job.starts <= 1 ? 0 : 1]!;

  /** Runs one write, up to three times, with the waits between. false when the third try failed too. */
  const tried = async (write: () => Promise<void>): Promise<boolean> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await write();
        return true;
      } catch {
        const wait = RECORD_WAITS_MS[attempt];
        if (wait === undefined) return false;
        try {
          await deps.sleep(wait);
        } catch {
          // a sleep that fails only shortens the wait
        }
      }
    }
  };

  const dropped = async (reason: string, write: () => Promise<void>): Promise<void> => {
    const done = await tried(write);
    log({ event: 'job', job: job.id, repo, number: job.ref.number, outcome: done ? 'dropped' : 'drop_failed', reason });
  };
  const drop = (reason: string): Promise<void> =>
    dropped(reason, async () => { await finishJob(db, job.id, 'dropped', reason, nowIso); });

  /** One write on the pull request, made once: never in dry run; one that cannot be made is logged and changes nothing. */
  const say = async (write: (commentId: string) => Promise<void>): Promise<void> => {
    if (deps.dryRun) return;
    if (job.commentId === null) {
      log({ event: 'answer_failed', job: job.id, reason: 'no_comment' });
      return;
    }
    try {
      await write(job.commentId);
    } catch (error) {
      log({ event: 'answer_failed', job: job.id, reason: codeOf(error) });
    }
  };
  /** The answer to a command: a confused reaction on its comment, then one sentence. Only once the job is finished. */
  const answer = async (installation: string, text: string): Promise<void> => {
    await say((commentId) => deps.writer.react(job.ref, installation, commentId, 'confused'));
    await say(() => deps.writer.comment(job.ref, installation, text));
  };
  /** Finishes the job as refused, with `also` in the same transaction, then says so; nothing is said when it could not be finished. true when it was. */
  const refuse = async (installation: string, reason: string, also?: (tx: Db) => Promise<void>): Promise<boolean> => {
    let finished = false;
    const done = await tried(() => db.transaction(async (tx) => {
      finished = await finishJob(tx, job.id, 'done', 'refused', nowIso);
      if (finished && also !== undefined) await also(tx);
    }));
    log({ event: 'job', job: job.id, repo, number: job.ref.number, outcome: done ? 'refused' : 'refuse_failed', reason });
    if (done && finished) await answer(installation, refusalText(job.requestedBy, reason));
    return done;
  };
  /** Says that the command failed; the job has already been given its outcome. */
  const fail = (installation: string, code: string): Promise<void> =>
    manual ? answer(installation, failureText(job.requestedBy, code)) : Promise.resolve();

  /** Stores the posted inline comments of a published run, each with the finding it came from. Never rejects; changes nothing else. */
  const readBack = async (target: StoredRun, installation: string, reviewId: string): Promise<void> => {
    try {
      const posted = await deps.writer.listReviewComments(job.ref, installation, reviewId);
      if (posted === null) {
        log({ event: 'readback_failed', job: job.id, run: target.id, reason: 'cut_short' });
        return;
      }
      const matched = matchPosted(target, posted);
      await recordComments(db, target.id, job.ref, matched);
      log({ event: 'readback', job: job.id, run: target.id, posted: posted.length, stored: matched.length });
    } catch (error) {
      log({ event: 'readback_failed', job: job.id, run: target.id, reason: codeOf(error) });
    }
  };

  /**
   * Writes the verdicts a published run kept into their threads. Only after the publication was recorded and the job finished;
   * never rejects, and nothing in it changes the job's outcome.
   */
  const threadFollowUp = async (target: StoredRun, installation: string, reviewId: string): Promise<void> => {
    try {
      const verdicts = verdictsOf(target.result);
      if (verdicts.length === 0) return;
      const threads = await deps.writer.listThreads(job.ref, installation);
      let canResolve = false;
      try {
        canResolve = await deps.canResolve();
      } catch {
        // a permission that cannot be read is read as not granted
      }
      const plan = planFollowUp({ verdicts, threads, reviewId, head: target.headSha, canResolve });
      const done = await followUp({ writer: deps.writer, sleep: deps.sleep, log }, { installation, actions: plan.actions });
      log({ event: 'thread_followup', job: job.id, run: target.id, review: reviewId, ...done, missing: plan.missing, changed: plan.changed });
    } catch (error) {
      log({ event: 'thread_followup_failed', job: job.id, reason: codeOf(error) });
    }
  };

  let result: ReviewResult | null = null;
  /** The mode of this review, decided once the live pull request and its last review are known; full until then, and in dry run. */
  let mode: RunRecord['mode'] = 'full';
  /** Who gives the block scores of this review. */
  let by: ScoredBy = 'model';
  /** The mode, the first rule that applies: no last review; a command on the last review's head and base; another base branch; the repository's setting. */
  const modeOf = (pr: LivePullRequest, lastReview: StoredRun | null): RunRecord['mode'] => {
    if (lastReview === null) return 'full';
    if (manual && lastReview.headSha === pr.info.headSha && lastReview.baseSha === pr.info.baseSha) return 'recheck';
    if (lastReview.baseBranch === null || lastReview.baseBranch !== pr.info.baseBranch) return 'full';
    return deps.settingsFor(repo).newHead ?? 'incremental';
  };
  /** Stores the scores a recorded run gave, for other pull requests; made once. One that cannot be stored is logged and changes nothing. */
  const keepScores = async (runId: number, finishedAt: string): Promise<void> => {
    try {
      await recordBlockScores(db, runId, job.ref, by, scoresToStore(result), finishedAt);
    } catch (error) {
      log({ event: 'scores_store_failed', job: job.id, run: runId, reason: codeOf(error) });
    }
  };
  try {
    // 1. The installation: the job's own, else the stored pull request's.
    const installation = job.installation ?? (await getPullRequest(db, job.ref))?.installation ?? null;
    if (installation === null) return await drop('no_installation');

    // 1b. Who asked. A refused command may have stood in the way of a push's job: the stored head gets one, unless it has a run in this mode.
    if (manual && !mayCommand(job.association)) {
      await refuse(installation, 'not_allowed', async (tx) => {
        const stored = await getPullRequest(tx, job.ref);
        if (stored === null || stored.state !== 'open') return;
        if (await hasRun(tx, job.ref, stored.headSha, deps.dryRun)) return;
        await enqueueJob(tx, { ref: job.ref, reason: 'opened', headSha: stored.headSha, runAt: nowIso, now: nowIso, delivery: null, replace: false,
          trigger: 'automatic', requestedBy: null, commentId: null, association: null, installation: null });
      });
      return;
    }

    let resumed: StoredRun | null = null;
    /** The pull request's runs, as read out of dry run; empty in dry run. */
    let runs: StoredRun[] = [];
    /** The last review: the newest published run that is not a re-check; null in dry run. */
    let last: StoredRun | null = null;
    let earlier: EarlierState | null = null;

    // 2. The live read.
    let live: LivePullRequest | null = null;
    let prepareError: unknown = null;
    try {
      live = await deps.forge.readPullRequest(job.ref, installation);
    } catch (error) {
      prepareError = error;
    }
    if (prepareError === null) {
      if (live === null) return await drop('not_found');

      // 3. The checks. A manual job reviews the live head of an open pull request, whatever the filters say.
      if (manual) {
        if (live.state !== 'open') {
          await refuse(installation, 'closed');
          return;
        }
      } else {
        const reason = skipReason({ state: live.state, draft: live.info.draft, author: live.info.author, baseBranch: live.info.baseBranch }, deps.settingsFor(repo));
        if (reason !== null) return await drop(reason);
      }
      if (!manual && live.info.headSha !== job.headSha) {
        const head = live.info.headSha;
        return await dropped('stale_head', () => db.transaction(async (tx) => {
          await enqueueJob(tx, { ref: job.ref, reason: job.reason, headSha: head, runAt: at(QUIET_SECONDS * 1000), now: nowIso, delivery: null, replace: false,
            trigger: 'automatic', requestedBy: null, commentId: null, association: null, installation: null });
          await finishJob(tx, job.id, 'dropped', 'stale_head', nowIso);
        }));
      }
      if (deps.dryRun) {
        if (await hasOkRun(db, job.ref, live.info.headSha, live.info.baseSha, true)) return await drop('already_reviewed');
      } else {
        // The record. Already reviewed? Only a published review of this head and this base counts, whatever its mode; a command re-checks it.
        runs = await listRuns(db, job.ref);
        const newest = newestPublished(runs);
        const reviewed = newest !== null && newest.headSha === live.info.headSha && newest.baseSha === live.info.baseSha ? newest : null;
        if (reviewed !== null && !manual) return await drop('already_reviewed');
        last = lastReviewOf(runs);
        mode = modeOf(live, last);
        // A stored review? This start then publishes it: no engine, no render, no guard.
        resumed = await unpublishedRun(db, job.ref, live.info.headSha, live.info.baseSha, new Date(now.getTime() - STORED_REVIEW_MS).toISOString());
        // An older row of a head that has its review is a leftover of the review already posted, not one that waits.
        if (reviewed !== null && resumed !== null && resumed.id <= reviewed.id) resumed = null;
        // What the database may not know: a review of the app's own on the pull request that no published run has. Asked before anything is paid.
        if (resumed === null) {
          let own: Array<{ id: string; commit: string }> | null = null;
          try {
            own = await deps.writer.listOwnReviews(job.ref, installation);
          } catch (error) {
            prepareError = error;
          }
          if (own !== null) {
            const known = knownOf(runs);
            const unknown = own.filter((r) => !known.has(r.id));
            const head = live.info.headSha;
            if (unknown.some((r) => r.commit === head)) {
              if (manual) {
                await refuse(installation, 'already_reviewed');
                return;
              }
              return await drop('already_reviewed');
            }
            let adopted = false;
            // The list is newest first: each other one is looked at oldest first.
            for (const review of [...unknown].reverse()) {
              const found = await adoptableRun(db, job.ref, review.commit);
              if (found === null) {
                log({ event: 'unknown_review', job: job.id, review: review.id });
                continue;
              }
              // Recorded as posted with its inline comments: the read-back stores what it finds.
              await markPublished(db, found.id, { reviewId: review.id, publishedAt: nowIso, body: found.body, inlineDropped: false });
              adopted = true;
              log({ event: 'adopted_late', job: job.id, run: found.id, review: review.id });
              await readBack(found, installation, review.id);
            }
            if (adopted) {
              runs = await listRuns(db, job.ref);
              last = lastReviewOf(runs);
              mode = modeOf(live, last);
            }
          }
          // The earlier state: the last review and its threads, read before anything is paid.
          if (prepareError === null && last !== null) {
            let threads: ReviewThread[] | null = null;
            try {
              threads = await deps.writer.listThreads(job.ref, installation);
            } catch (error) {
              prepareError = error;
            }
            if (threads !== null) {
              let stored = await listComments(db, job.ref);
              try {
                const missed = missedComments({ runs, stored, threads });
                const byRun = new Map<number, StoredComment[]>();
                for (const m of missed) byRun.set(m.run, [...(byRun.get(m.run) ?? []), m]);
                for (const [runId, comments] of byRun) await recordComments(db, runId, job.ref, comments);
                stored = [...stored, ...missed];
              } catch (error) {
                log({ event: 'repair_failed', job: job.id, reason: codeOf(error) });
              }
              earlier = earlierOf({ last, runs, stored, threads });
            }
          }
        }
      }
    }

    // A command that will be honoured: only now its comment gets its eyes.
    if (manual && prepareError === null) await say((commentId) => deps.writer.react(job.ref, installation, commentId, 'eyes'));

    // 4. The review.
    let failure: { stage: string; code: string } | null = null;
    if (prepareError !== null) {
      failure = { stage: 'prepare', code: codeOf(prepareError) };
    } else if (resumed === null) {
      const pr = live!;
      let source: Source | null = null;
      try {
        source = await deps.forge.sourceFor(installation);
      } catch (error) {
        failure = { stage: 'prepare', code: codeOf(error) };
      }
      if (source !== null) {
        const settings = deps.settingsFor(repo);
        try {
          const input: ReviewInput = {
            pullRequest: pr.info, trigger: job.trigger,
            repoConfig: { primaryBranches: settings.primaryBranches, scoreThreshold: settings.scoreThreshold },
            limits: deps.limits, asOf: now, earlier,
          };
          const engine = deps.engineDeps(source);
          if (deps.dryRun) {
            result = await deps.review(input, engine);
          } else {
            by = engine.scorer !== undefined ? 'scorer' : 'model';
            const scoredBy = by;
            const since = new Date(now.getTime() - REUSE_DAYS * 86_400_000).toISOString();
            result = await deps.review({ ...input, mode, history: historyOf({ runs, last, by: scoredBy }) }, {
              ...engine,
              reusableScores: async (blocks) => (await reusableScores(db, job.ref, scoredBy, blocks, since)).map((row) => ({
                path: row.path, hash: row.hash,
                entry: { score: row.score, category: (CATEGORY_NAMES.includes(row.category) ? row.category : 'other') as Category, reason: row.reason },
              })),
            });
          }
        } catch {
          failure = { stage: 'engine', code: 'internal_error' };
        }
      }
    }

    // 5 and 6. What would be posted, and telling the guards.
    let body = '';
    let comments: InlineComment[] = [];
    let refused: 'auth' | 'no_credit' | null = null;
    if (result !== null) {
      const info = live!.info;
      try {
        ({ body, comments } = renderReview(result, {
          trigger: job.trigger, requestedBy, lineUrl: (file, span) => deps.lineUrl(info, file, span), inline: true,
          commentUrl: (id) => deps.commentUrl(job.ref, id),
        }));
      } catch {
        log({ event: 'render_failed', job: job.id, repo, number: job.ref.number });
      }
      try {
        deps.spend.noteRun(result.usage);
      } catch {
        // a guard that fails changes nothing
      }
      const code = result.failure?.code;
      if (code === 'auth' || code === 'no_credit') refused = code;
      try {
        if (refused !== null) deps.health.reviewed(refused, deps.clock());
        else if (result.usage.calls >= 1 && result.dependencies.model === 'ok') deps.health.reviewed(null, deps.clock());
      } catch {
        // a guard that fails changes nothing
      }
    }

    // 7. The record.
    const usage = result === null ? NO_USAGE : result.usage;
    const run: RunRecord = resumed ?? (result === null
      ? {
        ref: job.ref, job: job.id, trigger: job.trigger, mode, dryRun: deps.dryRun, headSha: live?.info.headSha ?? job.headSha, baseSha: null,
        baseBranch: live?.info.baseBranch ?? null,
        outcome: 'failed', failureStage: failure!.stage, failureCode: failure!.code, needsHuman: true, highestScore: 100,
        body: '', comments: [], result: {}, usage: NO_USAGE, startedAt: nowIso, finishedAt: deps.clock().toISOString(),
      }
      : {
        ref: job.ref, job: job.id, trigger: job.trigger, mode: result.mode, dryRun: deps.dryRun,
        headSha: live!.info.headSha, baseSha: live!.info.baseSha, baseBranch: live!.info.baseBranch,
        outcome: result.status, failureStage: result.failure?.stage ?? null, failureCode: result.failure?.code ?? null,
        needsHuman: result.verdict.needsHuman, highestScore: result.verdict.highest,
        body, comments, result, usage: result.usage, startedAt: nowIso, finishedAt: deps.clock().toISOString(),
      });

    const gitFailed = failure?.stage === 'prepare'
      || (result?.failure?.stage === 'context' && result.failure.code.startsWith('github_') && result.usage.calls === 0);
    const putBack = refused !== null
      ? { runAt: later(PAUSE_MS), giveBackStart: usage.calls === 0 }
      : gitFailed ? { runAt: later(retryWait), giveBackStart: false } : null;

    let written: boolean;
    let requeued = false;
    /** The job was ended as nothing new by this start. */
    let endedNothingNew = false;
    /** The recorded run to publish; only ever set when not in dry run. */
    let toPublish: StoredRun | null = resumed;
    if (resumed !== null) {
      written = true;
    } else if (putBack !== null) {
      written = await tried(async () => { await recordRun(db, run); });
      if (written) {
        written = await tried(async () => { requeued = (await requeueJob(db, job.id, putBack.runAt, nowIso, putBack.giveBackStart)) === 'requeued'; });
        // Another job was waiting: this one was dropped as superseded.
        if (written && !requeued) await fail(installation, 'superseded');
      }
    } else if (deps.dryRun || run.outcome !== 'ok') {
      const ended = run.outcome === 'ok' ? 'reviewed' : 'failed';
      written = await tried(() => db.transaction(async (tx) => {
        if (await finishJob(tx, job.id, 'done', ended, nowIso)) await recordRun(tx, run);
      }));
      if (written && ended === 'failed') await fail(installation, 'review_failed');
    } else if (!manual && nothingNewOf(result)) {
      // Nothing new: no review is posted. The run is kept with no body, so that no later start takes it for a review waiting to be published.
      let runId: number | null = null;
      written = await tried(() => db.transaction(async (tx) => {
        // Each try starts afresh: an id from a try that was rolled back is no row's.
        runId = null;
        if (await finishJob(tx, job.id, 'done', 'nothing_new', nowIso)) runId = await recordRun(tx, { ...run, body: '', comments: [] });
      }));
      endedNothingNew = written && runId !== null;
      if (written && runId !== null) await keepScores(runId, run.finishedAt);
    } else if (run.body === '') {
      // A review whose text could not be rendered is never posted.
      let runId: number | null = null;
      written = await tried(() => db.transaction(async (tx) => {
        runId = null;
        if (await finishJob(tx, job.id, 'done', 'render_failed', nowIso)) runId = await recordRun(tx, run);
      }));
      if (written) {
        if (runId !== null) await keepScores(runId, run.finishedAt);
        await fail(installation, 'render_failed');
      }
    } else {
      // Recorded alone: the job stays running until the publication is settled.
      let runId: number | null = null;
      written = await tried(async () => {
        const id = await recordRun(db, run);
        runId = id;
        toPublish = { ...run, id, published: false, reviewId: null, publishedAt: null, inlineDropped: false };
      });
      if (written && runId !== null) await keepScores(runId, run.finishedAt);
    }

    // 8. The publication. Once the review is recorded, only a publication that failed puts the job back.
    let publish: PublishOutcome | null = null;
    const target = toPublish;
    if (!deps.dryRun && written && target !== null) {
      const out = await publishRun({ forge: deps.forge, writer: deps.writer, lineUrl: deps.lineUrl, commentUrl: deps.commentUrl },
        { ref: job.ref, installation, run: target, trigger: job.trigger, requestedBy, known: knownOf(runs) });
      publish = out;
      const finish = (outcome: string): Promise<boolean> => tried(async () => { await finishJob(db, job.id, 'done', outcome, nowIso); });
      if (out.kind === 'published') {
        written = await tried(() => db.transaction(async (tx) => {
          await markPublished(tx, target.id, { reviewId: out.reviewId, publishedAt: later(0), body: out.body, inlineDropped: out.inlineDropped });
          await finishJob(tx, job.id, 'done', 'published', nowIso);
        }));
        if (written) {
          await readBack(target, installation, out.reviewId);
          await threadFollowUp(target, installation, out.reviewId);
        }
      } else if (out.kind === 'moved' && manual && job.reason === 'command') {
        // A command starts over once, as a new job for the live head.
        written = await tried(() => db.transaction(async (tx) => {
          await enqueueJob(tx, { ref: job.ref, reason: 'command_retry', headSha: '', runAt: later(0), now: nowIso, delivery: null, replace: true,
            trigger: 'manual', requestedBy: job.requestedBy, commentId: job.commentId, association: job.association, installation: job.installation });
          await finishJob(tx, job.id, 'done', 'head_moved', nowIso);
        }));
      } else if (out.kind === 'moved' && manual) {
        // A command that started over does not start over again: the live head gets an automatic job.
        written = await tried(() => db.transaction(async (tx) => {
          await enqueueJob(tx, { ref: job.ref, reason: 'synchronize', headSha: out.head, runAt: later(QUIET_SECONDS * 1000), now: nowIso, delivery: null, replace: false,
            trigger: 'automatic', requestedBy: null, commentId: null, association: null, installation: null });
          await finishJob(tx, job.id, 'done', 'head_moved', nowIso);
        }));
        if (written) await fail(installation, 'head_moved');
      } else if (out.kind === 'moved') {
        written = await tried(() => db.transaction(async (tx) => {
          await enqueueJob(tx, { ref: job.ref, reason: job.reason, headSha: out.head, runAt: later(QUIET_SECONDS * 1000), now: nowIso, delivery: null, replace: false,
            trigger: 'automatic', requestedBy: null, commentId: null, association: null, installation: null });
          await finishJob(tx, job.id, 'done', 'head_moved', nowIso);
        }));
      } else if (out.kind === 'closed') {
        written = await finish('closed');
      } else if (out.kind === 'rejected') {
        written = await finish('publish_rejected');
        if (written) await fail(installation, 'publish_rejected');
      } else {
        written = await tried(async () => { requeued = (await requeueJob(db, job.id, later(retryWait), nowIso, false)) === 'requeued'; });
        if (written && !requeued) await fail(installation, 'superseded');
      }
    }

    // 9. The log.
    log({
      event: 'review', job: job.id, repo, number: job.ref.number, head: run.headSha, trigger: job.trigger, mode: run.mode, dry_run: deps.dryRun,
      outcome: written ? run.outcome : 'record_failed', failure_stage: run.failureStage, failure_code: run.failureCode,
      needs_human: run.needsHuman, highest: run.highestScore, findings: findingsOf(result ?? resumed?.result),
      calls: usage.calls, cost: usage.cost, duration_ms: deps.clock().getTime() - now.getTime(), requeued,
      published: publish?.kind === 'published', review: publish?.kind === 'published' ? publish.reviewId : null,
      publish: publish?.kind ?? null, publish_code: publish?.kind === 'failed' ? publish.code : null,
      resumed: resumed !== null, adopted: publish?.kind === 'published' && publish.adopted,
      threads_due: threadsDueOf(result ?? resumed?.result), verdicts: verdictsOf(result ?? resumed?.result).length, duplicates: duplicatesOf(result ?? resumed?.result),
      blocking_on_unchanged: blockingOnUnchangedOf(result ?? resumed?.result), nothing_new: endedNothingNew,
    });
  } catch (error) {
    if (result !== null) {
      // The review was paid for: putting the job back would pay for it again. It is left running, as after three failed tries to record.
      let cost = 0;
      try {
        if (typeof result.usage.cost === 'number') cost = result.usage.cost;
      } catch {
        // a cost that cannot be read is logged as 0
      }
      log({ event: 'review', job: job.id, repo, number: job.ref.number, head: job.headSha, trigger: job.trigger, mode, dry_run: deps.dryRun, outcome: 'record_failed', cost, requeued: false });
      return;
    }
    // Nothing has been spent on this path: put the job back, its start counted, as for a git service failure.
    let requeued = false;
    await tried(async () => { requeued = (await requeueJob(db, job.id, later(retryWait), nowIso, false)) === 'requeued'; });
    log({ event: 'job', job: job.id, repo, number: job.ref.number, outcome: 'error', reason: codeOf(error), requeued });
  }
}
