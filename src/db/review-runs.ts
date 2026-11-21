import type { PullRequestRef } from '../forge/types.ts';
import { storable, storableJson, storableOrNull } from './text.ts';
import type { Db } from './types.ts';

export interface RunUsage { calls: number; inputTokens: number; outputTokens: number; cachedTokens: number; cost: number }
export interface RunRecord {
  ref: PullRequestRef; job: number | null;
  trigger: 'automatic' | 'manual'; mode: 'full' | 'incremental' | 'recheck'; dryRun: boolean;
  headSha: string; baseSha: string | null;          // baseSha and baseBranch are null when the run failed before the pull request was read
  baseBranch: string | null;
  outcome: 'ok' | 'failed'; failureStage: string | null; failureCode: string | null;
  needsHuman: boolean; highestScore: number;
  body: string;                                     // the review text as it would be posted; '' when none was rendered
  comments: unknown;                                // the inline comments as they would be posted
  result: unknown;                                  // the engine's result
  usage: RunUsage;
  startedAt: string; finishedAt: string;
}
export interface StoredRun extends RunRecord {
  id: number;
  published: boolean; reviewId: string | null; publishedAt: string | null; inlineDropped: boolean;
}

/** A finite number at or above 0, else 0: what the provider reported must not break the row or the day's sum. */
const amount = (n: number): number => (Number.isFinite(n) && n >= 0 ? n : 0);
const count = (n: number): number => Math.round(amount(n));

/** Appends one row. Returns its id. Each count is rounded; a count or a cost that is not a finite number at or above 0 is stored as 0. */
export async function recordRun(db: Db, run: RunRecord): Promise<number> {
  const rows = await db.query<{ id: number }>(
    `insert into visto_ai.review_runs
       (service, owner, repo, number, job, trigger, mode, dry_run, head_sha, base_sha, base_branch, outcome,
        failure_stage, failure_code, needs_human, highest_score, body, comments, result,
        calls, input_tokens, output_tokens, cached_tokens, cost, started_at, finished_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19::jsonb,
             $20, $21, $22, $23, $24, $25::timestamptz, $26::timestamptz)
     returning id`,
    [
      run.ref.service, storable(run.ref.owner).toLowerCase(), storable(run.ref.repo).toLowerCase(), run.ref.number,
      run.job, run.trigger, run.mode, run.dryRun, storable(run.headSha), storableOrNull(run.baseSha), storableOrNull(run.baseBranch), run.outcome,
      storableOrNull(run.failureStage), storableOrNull(run.failureCode), run.needsHuman, run.highestScore,
      storable(run.body), storableJson(run.comments), storableJson(run.result),
      count(run.usage.calls), count(run.usage.inputTokens), count(run.usage.outputTokens), count(run.usage.cachedTokens), amount(run.usage.cost),
      run.startedAt, run.finishedAt,
    ]);
  return rows[0]!.id;
}

interface Row {
  id: number; job: number | null; trigger: RunRecord['trigger']; mode: RunRecord['mode']; dry_run: boolean;
  head_sha: string; base_sha: string | null; base_branch: string | null; outcome: RunRecord['outcome'];
  failure_stage: string | null; failure_code: string | null; needs_human: boolean; highest_score: number;
  body: string; comments: unknown; result: unknown;
  calls: number; input_tokens: number; output_tokens: number; cached_tokens: number; cost: number;
  started_at: Date; finished_at: Date;
  published: boolean; review_id: string | null; published_at: Date | null; inline_dropped: boolean;
}

const COLUMNS = `id, job, trigger, mode, dry_run, head_sha, base_sha, base_branch, outcome, failure_stage, failure_code,
            needs_human, highest_score, body, comments, result,
            calls, input_tokens, output_tokens, cached_tokens, cost::float8 as cost, started_at, finished_at,
            published, review_id, published_at, inline_dropped`;

function toRun(r: Row, ref: PullRequestRef): StoredRun {
  return {
    id: r.id, ref, job: r.job,
    trigger: r.trigger, mode: r.mode, dryRun: r.dry_run, headSha: r.head_sha, baseSha: r.base_sha, baseBranch: r.base_branch,
    outcome: r.outcome, failureStage: r.failure_stage, failureCode: r.failure_code,
    needsHuman: r.needs_human, highestScore: r.highest_score,
    body: r.body, comments: r.comments, result: r.result,
    usage: { calls: r.calls, inputTokens: r.input_tokens, outputTokens: r.output_tokens, cachedTokens: r.cached_tokens, cost: r.cost },
    startedAt: r.started_at.toISOString(), finishedAt: r.finished_at.toISOString(),
    published: r.published, reviewId: r.review_id, publishedAt: r.published_at?.toISOString() ?? null, inlineDropped: r.inline_dropped,
  };
}

const lowered = (ref: PullRequestRef): PullRequestRef => ({
  service: ref.service, owner: storable(ref.owner).toLowerCase(), repo: storable(ref.repo).toLowerCase(), number: ref.number,
});

/** A pull request's runs, lowest id first. */
export async function listRuns(db: Db, ref: PullRequestRef): Promise<StoredRun[]> {
  const r = lowered(ref);
  const rows = await db.query<Row>(
    `select ${COLUMNS}
     from visto_ai.review_runs
     where service = $1 and owner = $2 and repo = $3 and number = $4
     order by id`,
    [r.service, r.owner, r.repo, r.number]);
  return rows.map((row) => toRun(row, r));
}

/** Fills in a run's publication, once. false when the run was already marked. */
export async function markPublished(db: Db, runId: number, p: { reviewId: string; publishedAt: string; body: string; inlineDropped: boolean }): Promise<boolean> {
  const rows = await db.query(
    `update visto_ai.review_runs set published = true, review_id = $2, published_at = $3::timestamptz, body = $4, inline_dropped = $5
     where id = $1 and published = false
     returning id`,
    [runId, storable(p.reviewId), p.publishedAt, storable(p.body), p.inlineDropped]);
  return rows.length === 1;
}

/** The newest run of the pull request that is not a dry run, ended ok, has a body that is not empty, is not published, has this head and base, and started at or after `since`. */
export async function unpublishedRun(db: Db, ref: PullRequestRef, headSha: string, baseSha: string, since: string): Promise<StoredRun | null> {
  const r = lowered(ref);
  const rows = await db.query<Row>(
    `select ${COLUMNS}
     from visto_ai.review_runs
     where service = $1 and owner = $2 and repo = $3 and number = $4
       and dry_run = false and outcome = 'ok' and body <> '' and published = false
       and head_sha = $5 and base_sha = $6 and started_at >= $7::timestamptz
     order by id desc
     limit 1`,
    [r.service, r.owner, r.repo, r.number, storable(headSha), storable(baseSha), since]);
  return rows[0] === undefined ? null : toRun(rows[0], r);
}

/** The newest run of the pull request at this head that is not a dry run, ended ok, has a body that is not empty and is not published. */
export async function adoptableRun(db: Db, ref: PullRequestRef, headSha: string): Promise<StoredRun | null> {
  const r = lowered(ref);
  const rows = await db.query<Row>(
    `select ${COLUMNS}
     from visto_ai.review_runs
     where service = $1 and owner = $2 and repo = $3 and number = $4
       and dry_run = false and outcome = 'ok' and body <> '' and published = false and head_sha = $5
     order by id desc
     limit 1`,
    [r.service, r.owner, r.repo, r.number, storable(headSha)]);
  return rows[0] === undefined ? null : toRun(rows[0], r);
}

/** The newest published run of the pull request. */
export async function lastPublishedRun(db: Db, ref: PullRequestRef): Promise<StoredRun | null> {
  const r = lowered(ref);
  const rows = await db.query<Row>(
    `select ${COLUMNS}
     from visto_ai.review_runs
     where service = $1 and owner = $2 and repo = $3 and number = $4 and published
     order by id desc
     limit 1`,
    [r.service, r.owner, r.repo, r.number]);
  return rows[0] === undefined ? null : toRun(rows[0], r);
}

/** The summed cost of the runs started at or after `since`. 0 when there are none. */
export async function spentSince(db: Db, since: string): Promise<number> {
  const rows = await db.query<{ spent: number }>(
    'select coalesce(sum(cost), 0)::float8 as spent from visto_ai.review_runs where started_at >= $1::timestamptz',
    [since]);
  return rows[0]!.spent;
}

/** Whether the pull request has a run at this head, of the same kind (dry or live), whatever its outcome; a run whose job ended dropped as superseded does not count. */
export async function hasRun(db: Db, ref: PullRequestRef, headSha: string, dryRun: boolean): Promise<boolean> {
  const rows = await db.query(
    `select 1 from visto_ai.review_runs r
     where r.service = $1 and r.owner = $2 and r.repo = $3 and r.number = $4
       and r.head_sha = $5 and r.dry_run = $6
       and not exists (select 1 from visto_ai.jobs j where j.id = r.job and j.status = 'dropped' and j.outcome = 'superseded')
     limit 1`,
    [ref.service, storable(ref.owner).toLowerCase(), storable(ref.repo).toLowerCase(), ref.number, storable(headSha), dryRun]);
  return rows.length === 1;
}

/** Whether the pull request has a run with outcome `ok` at this head and this base, of the same kind (dry or live). */
export async function hasOkRun(db: Db, ref: PullRequestRef, headSha: string, baseSha: string, dryRun: boolean): Promise<boolean> {
  const rows = await db.query(
    `select 1 from visto_ai.review_runs
     where service = $1 and owner = $2 and repo = $3 and number = $4
       and head_sha = $5 and base_sha = $6 and dry_run = $7 and outcome = 'ok'
     limit 1`,
    [ref.service, storable(ref.owner).toLowerCase(), storable(ref.repo).toLowerCase(), ref.number,
      storable(headSha), storable(baseSha), dryRun]);
  return rows.length === 1;
}
