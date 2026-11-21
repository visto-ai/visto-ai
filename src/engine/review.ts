import { buildFileContexts } from './context/build.ts';
import type { FileContext } from './context/build.ts';
import { packBatches } from './context/batches.ts';
import type { Batch } from './context/batches.ts';
import { changedLines, leftBlocksOf } from './context/increment.ts';
import type { Changed } from './context/increment.ts';
import { renderAnchoredDiff } from './context/diff.ts';
import { orderByPriority } from './context/priority.ts';
import { attachThreads, isDue } from './context/threads.ts';
import { stripControl } from './context/untrusted.ts';
import type { ShownThread } from './context/threads.ts';
import { buildMessages, fixedTokens, headerStripCounts } from './context/prompt.ts';
import { callBatch } from './model/call.ts';
import type { BatchAnswer } from './model/call.ts';
import type { SubmitReviewArgs } from './model/submit-review.ts';
import { NOTHING_READ, filesToSend } from './plan.ts';
import { inPool } from './pool.ts';
import type { Control } from './pool.ts';
import { reconcile } from './reconcile/index.ts';
import { onChangedLine, reconcileMode } from './reconcile/mode.ts';
import { normalizePath } from './reconcile/placement.ts';
import { reconcileScores, verdictOf } from './reconcile/scores.ts';
import { dropDuplicates, reconcileVerdicts } from './reconcile/threads.ts';
import { REPO_FILE, parseRepoFile } from './score/floors.ts';
import { blocksToLookUp, keptScores } from './score/history.ts';
import { shownOf } from './score/shown.ts';
import type { ScoredBy, ScoreEntry, ScoreHistory } from './score/types.ts';
import { askScorer, summariesOf } from './scorer/ask.ts';
import type {
  AuditEntry, ChangedFile, Discussed, EarlierThread, Effort, Finding, NotReviewed, PullRequestInfo, RepoConfig, ReviewDeps, ReviewInput, ReviewResult, Severity, Side, Source, Usage,
} from './types.ts';

const CONCURRENCY = 2;
const PROVIDER_CODES = new Set(['auth', 'no_credit', 'provider', 'timeout', 'rate_limited']);
const ELEVATED_FILES = 15;
const ELEVATED_ADDITIONS = 500;
const SOURCE_CODE = /^[a-z][a-z0-9_]{0,39}$/;

const zeroUsage = (): Usage => ({ calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0 });
function addUsage(a: Usage, b: Usage): Usage {
  return {
    calls: a.calls + b.calls,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    cost: a.cost + b.cost,
  };
}

export function chooseEffort(pr: PullRequestInfo, files: ChangedFile[], repo: RepoConfig): Effort {
  const additions = files.reduce((sum, f) => sum + f.additions, 0);
  return files.length > ELEVATED_FILES || additions > ELEVATED_ADDITIONS || repo.primaryBranches.includes(pr.baseBranch)
    ? 'elevated'
    : 'default';
}

type Answered = { models: string[]; providers: string[] };
const noneAnswered = (): Answered => ({ models: [], providers: [] });

// The mode a run was given, and the head of the last review it reads on from.
interface Said { mode: ReviewResult['mode']; since?: string }

// A review that did not finish never tells anyone that a pull request needs no person.
function failedResult(
  stage: 'context' | 'model', code: string, usage: Usage, audit: AuditEntry[], model: 'ok' | 'error', threshold: number, due: number, said: Said,
  answered: Answered = noneAnswered(),
): ReviewResult {
  return {
    threadVerdicts: [], threadsDue: due, alreadyDiscussed: [],
    scores: [], verdict: { threshold, needsHuman: true, highest: 100 }, teamFileInvalid: null,
    status: 'failed', failure: { stage, code }, ...said, overview: '', findings: [], unplaced: [], beyondDiff: [],
    coverage: { reviewed: [], notReviewed: [] }, usage, ...answered, dependencies: { model }, audit,
  };
}

function okResult(overview: string, threshold: number, due: number, said: Said, rest: Partial<ReviewResult>): ReviewResult {
  return {
    threadVerdicts: [], threadsDue: due, alreadyDiscussed: [],
    scores: [], verdict: verdictOf([], threshold), teamFileInvalid: null,
    status: 'ok', failure: null, ...said, overview, findings: [], unplaced: [], beyondDiff: [],
    coverage: { reviewed: [], notReviewed: [] }, usage: zeroUsage(), models: [], providers: [], dependencies: { model: 'ok' }, audit: [], ...rest,
  };
}

const distinct = (values: string[]): string[] => [...new Set(values)];

// A major or blocker finding dropped as a duplicate, with the thread that already raised it; a minor one is not kept.
function discussed(f: { path: string; side: Side; line: number; severity: Severity; body: string }, thread: EarlierThread): Discussed[] {
  if (f.severity === 'minor') return [];
  return [{
    path: f.path, side: f.side, line: f.line, severity: f.severity, body: f.body,
    commentId: thread.commentId, resolved: thread.resolved, settled: thread.settled,
  }];
}

interface BatchOutcome {
  answers: { value: SubmitReviewArgs; files: string[]; threads?: string[] }[]; // each answer with the paths of the files it was given, and, in a run with threads, the keys of their threads
  reviewed: string[];
  failedFiles: string[];
  failedCodes: string[]; // codes of the parts that ended failed, in order
  usage: Usage;
  models: string[];
  providers: string[];
  audit: AuditEntry[];
}

interface Run {
  contexts: FileContext[];
  limits: ReviewInput['limits'];
  effort: Effort;
  token: string;
  pr: PullRequestInfo;
  deps: ReviewDeps;
  fileCount: number;
  batchCount: number;
  withThreads: boolean; // the run shows earlier threads: its calls take the tool with verdicts
  lastOverview: string | undefined; // the last review's overview, shown in every call's header; undefined when there is none to show
}

// A failing logger must never change a review.
function safeLog(deps: ReviewDeps, entry: Record<string, unknown>): void {
  try {
    deps.log(entry);
  } catch {
    // ignored on purpose
  }
}

async function oneCall(run: Run, files: FileContext[], firstFileNumber: number, batchIndex: number): Promise<BatchAnswer> {
  const batch: Batch = { files, tokens: 0 };
  const messages = buildMessages({
    contract: run.deps.contract, pr: run.pr, fileCount: run.fileCount, firstFileNumber, batch,
    batchIndex, batchCount: run.batchCount, token: run.token, ...(run.lastOverview === undefined ? {} : { lastOverview: run.lastOverview }),
  });
  const answer = await callBatch(
    { messages, effort: run.effort, timeoutMs: run.limits.modelTimeoutSeconds * 1000, prPaths: files.map((f) => f.file.path), ...(run.withThreads ? { withThreads: true } : {}) },
    run.deps.model,
  );
  safeLog(run.deps, {
    event: 'model_call', files: files.length, effort: run.effort, code: answer.ok ? 'ok' : answer.code, usage: answer.usage,
    model: answer.models.at(-1) ?? null, provider: answer.providers.at(-1) ?? null,
  });
  return answer;
}

// Never rejects: an unexpected error is recorded in `ctl`, which stops every worker from starting more work.
async function runBatch(run: Run, ctl: Control, batch: Batch, firstFileNumber: number, batchIndex: number): Promise<BatchOutcome> {
  const out: BatchOutcome = { answers: [], reviewed: [], failedFiles: [], failedCodes: [], usage: zeroUsage(), models: [], providers: [], audit: [] };
  try {
    await attempt(run, ctl, out, batch, firstFileNumber, batchIndex);
  } catch (error) {
    if (!ctl.failed) {
      ctl.failed = true;
      ctl.error = error;
    }
    ctl.stopped = true;
  }
  return out;
}

async function attempt(run: Run, ctl: Control, out: BatchOutcome, batch: Batch, firstFileNumber: number, batchIndex: number): Promise<void> {
  const take = (answer: BatchAnswer, files: FileContext[]): void => {
    out.usage = addUsage(out.usage, answer.usage);
    out.models.push(...answer.models);
    out.providers.push(...answer.providers);
    out.audit.push(...answer.audit);
    if (answer.ok) {
      const paths = files.map((f) => f.file.path);
      out.answers.push(run.withThreads
        ? { value: answer.value, files: paths, threads: files.flatMap((f) => (f.threads ?? []).map((t) => t.key)) }
        : { value: answer.value, files: paths });
      out.reviewed.push(...files.map((f) => f.file.path));
    }
  };
  const giveUp = (code: string, files: FileContext[]): void => {
    for (const f of files) out.failedFiles.push(f.file.path);
    out.failedCodes.push(code);
    out.audit.push({ stage: 'model', action: 'batch_failed', subject: files.map((f) => f.file.path).join(', '), reason: code });
    if (code === 'auth' || code === 'no_credit') ctl.stopped = true;
  };

  const first = await oneCall(run, batch.files, firstFileNumber, batchIndex);
  take(first, batch.files);
  if (first.ok) return;
  if (first.code === 'auth' || first.code === 'no_credit') ctl.stopped = true;

  const splits = first.code === 'timeout' && batch.files.length > 1;
  const again = first.code === 'timeout' || first.code === 'provider' || first.code === 'rate_limited';
  if (ctl.stopped || !again) {
    giveUp(first.code, batch.files);
    return;
  }
  const parts = splits
    ? [batch.files.slice(0, Math.ceil(batch.files.length / 2)), batch.files.slice(Math.ceil(batch.files.length / 2))]
    : [batch.files];
  let number = firstFileNumber;
  for (const part of parts) {
    if (ctl.stopped) {
      giveUp(first.code, part);
    } else {
      const answer = await oneCall(run, part, number, batchIndex);
      take(answer, part);
      if (!answer.ok) giveUp(answer.code, part);
    }
    number += part.length;
  }
}

const isWholeScore = (value: unknown): boolean => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 100;

/**
 * Sets on each context what its history, or another pull request, already settles, and shows those hunks as scored.
 * Touches nothing when there is no history and no lookup. A failed lookup is named in the audit and counts as no answer.
 */
async function keepScores(contexts: FileContext[], history: ScoreHistory | null, deps: ReviewDeps): Promise<AuditEntry[]> {
  if (history === null && deps.reusableScores === undefined) return [];
  const audit: AuditEntry[] = [];
  const wanted = blocksToLookUp(contexts, history);
  const reused: Array<{ path: string; hash: string; entry: ScoreEntry }> = [];
  if (wanted.length > 0 && deps.reusableScores !== undefined) {
    const asked = new Set(wanted.map((w) => `${w.path}\n${w.hash}`));
    let answer: unknown = [];
    try {
      answer = await deps.reusableScores(wanted);
    } catch (error) {
      const reason = error instanceof Error && SOURCE_CODE.test(error.message) ? error.message : 'internal_error';
      audit.push({ stage: 'context', action: 'reuse_failed', subject: 'scores', reason });
    }
    for (const one of Array.isArray(answer) ? (answer as unknown[]) : []) {
      if (typeof one !== 'object' || one === null) continue;
      const { path, hash, entry } = one as { path?: unknown; hash?: unknown; entry?: { score?: unknown } | null };
      if (typeof path !== 'string' || typeof hash !== 'string' || !asked.has(`${path}\n${hash}`)) continue;
      if (typeof entry !== 'object' || entry === null || !isWholeScore(entry.score)) continue;
      reused.push({ path, hash, entry: entry as ScoreEntry });
    }
  }
  for (const context of contexts) {
    const kept = keptScores(context, history, reused.filter((r) => r.path === context.file.path));
    if (kept === null) continue;
    context.kept = kept;
    if (kept.scoredHunks.size > 0) context.diffText = renderAnchoredDiff(context.hunks, kept.scoredHunks);
  }
  return audit;
}

type Content = (path: string, sha: string) => Promise<string | null>;
const everything = (): Changed => ({ all: true, right: [], leftBlocks: [] });
const errorCode = (error: unknown): string => (error instanceof Error && SOURCE_CODE.test(error.message) ? error.message : 'source_error');

/** What of a file changed since a published review last read it. A read that rejects is passed on. */
async function changedSince(c: FileContext, headSha: string, content: Content): Promise<Changed> {
  const readAt = c.kept?.readAt ?? null;
  if (readAt === null) return everything();
  if (readAt.head === headSha) return { all: false, right: [], leftBlocks: [] };
  const leftBlocks = leftBlocksOf(c.blocks, readAt.hashes);
  if (c.file.status === 'removed') return { all: false, right: [], leftBlocks };
  const now = await content(c.file.path, headSha);
  if (now === null) return everything();
  let before = await content(c.file.path, readAt.head);
  if (before === null && c.file.previousPath !== null) before = await content(c.file.previousPath, readAt.head);
  if (before === null) return everything();
  const right = changedLines(before.replaceAll('\r\n', '\n'), now.replaceAll('\r\n', '\n'));
  return right === null ? everything() : { all: false, right, leftBlocks };
}

/**
 * In a full review of a later head: how many placed blocker and major findings sit on a line unchanged since their file was last read.
 * A read that rejects leaves the count out and is named in the audit: the review is already paid for.
 */
async function countUnchanged(findings: Finding[], contexts: FileContext[], headSha: string, content: Content, audit: AuditEntry[]): Promise<number | undefined> {
  const blocking = findings.filter((f) => f.severity !== 'minor');
  const known = new Map<string, { changed: Changed; blocks: FileContext['blocks'] }>();
  for (const path of distinct(blocking.map((f) => f.path))) {
    const c = contexts.find((one) => one.file.path === path && one.plan.kind === 'model');
    if (c === undefined) continue;
    try {
      known.set(path, { changed: await changedSince(c, headSha, content), blocks: c.blocks });
    } catch (error) {
      audit.push({ stage: 'reconcile', action: 'unchanged_count_failed', subject: path, reason: errorCode(error) });
      return undefined;
    }
  }
  return blocking.filter((f) => {
    const one = known.get(f.path);
    // The same test as an incremental review's: the line it was placed on, or the line the model named.
    return one !== undefined && !onChangedLine(f, one.changed, one.blocks);
  }).length;
}

export async function review(input: ReviewInput, deps: ReviewDeps): Promise<ReviewResult> {
  let stage: 'context' | 'model' = 'context';
  const sourceErrors = new Set<unknown>(); // what the source rejected with; a caught probe failure is not fatal
  let usage = zeroUsage();
  let answered = noneAnswered();
  const audit: AuditEntry[] = [];
  let due = 0;
  const mode = input.mode ?? 'full';
  // A stored history may be old: a last review whose head or overview is not text reads as none.
  const last = mode === 'full' ? null : (input.history?.lastReview ?? null);
  const said: Said = typeof last?.head === 'string' ? { mode, since: last.head } : { mode };
  // An overview with nothing left once the characters nobody can see are stripped is not shown.
  const lastText = typeof last?.overview === 'string' ? stripControl(last.overview).text.trim() : '';
  const lastOverview = lastText !== '' && lastText !== NOTHING_READ ? last!.overview : undefined;
  try {
    // Every thread the run owes a verdict, whether or not its file is shown.
    due = (input.earlier?.threads ?? []).filter(isDue).length;
    const pr = input.pullRequest;
    const guard = async <T>(call: () => Promise<T>): Promise<T> => {
      try {
        return await call();
      } catch (error) {
        sourceErrors.add(error);
        throw error;
      }
    };
    const source: Source = {
      listFiles: (p) => guard(() => deps.source.listFiles(p)),
      getFileContent: (p, path, sha) => guard(() => deps.source.getFileContent(p, path, sha)),
      getDefaultBranchFile: (p, path) => guard(() => deps.source.getDefaultBranchFile(p, path)),
    };

    const threshold = input.repoConfig.scoreThreshold;
    // Who gives the block scores of this run; a moved file's whole-file score is the review model's either way.
    const by: ScoredBy = deps.scorer !== undefined ? 'scorer' : 'model';
    const files = await source.listFiles(pr);
    if (files.length === 0) return okResult('No changes to review.', threshold, due, said, {});

    // Read only when there is something to floor; a rejection fails the review here, like any source error.
    const floors = parseRepoFile(await source.getDefaultBranchFile(pr, REPO_FILE));
    const teamFileInvalid = floors.invalid;
    if (teamFileInvalid !== null) audit.push({ stage: 'context', action: 'team_file_invalid', subject: REPO_FILE, reason: teamFileInvalid });

    let budget = input.limits.inputTokensPerCall - fixedTokens(deps.contract, pr, false, lastOverview);
    if (budget <= 0) return failedResult('context', 'budget_too_small', usage, audit, 'ok', threshold, due, said);

    const stripped = headerStripCounts(pr);
    for (const subject of ['title', 'description'] as const) {
      if (stripped[subject] > 0) audit.push({ stage: 'context', action: 'control_characters_stripped', subject, reason: String(stripped[subject]) });
    }
    const built = await buildFileContexts(pr, orderByPriority(files), source);
    // Before the threads are attached, so that the copies attachThreads makes carry what is kept.
    const reuseAudit = await keepScores(built.contexts, input.history ?? null, deps);
    const attached = attachThreads(built.contexts, input.earlier);
    // What an earlier review covers is not sent: it is not a file that was not reviewed, and it is scored from what it keeps.
    const plan = filesToSend(attached.contexts, mode);
    const leftOutPaths = new Set<string>();
    const leaveOut = (c: FileContext): AuditEntry[] => {
      leftOutPaths.add(c.file.path);
      return [
        { stage: 'context', action: 'not_sent', subject: c.file.path, reason: 'covered' },
        ...(c.threads ?? []).map((t): AuditEntry => ({ stage: 'context', action: 'thread_not_shown', subject: t.key, reason: 'file_covered' })),
      ];
    };
    const leftOutAudit = plan.leftOut.flatMap(leaveOut);
    // Before packing, so that the size of a file counts its line of what changed; a read that rejects fails the review here.
    if (mode !== 'full') {
      for (const c of plan.send) if (c.plan.kind === 'model') c.changed = await changedSince(c, pr.headSha, built.content);
    }
    let shown: ShownThread[] = attached.shown.filter((s) => !leftOutPaths.has(s.file));
    const withThreads = shown.length > 0;
    if (withThreads) {
      budget = input.limits.inputTokensPerCall - fixedTokens(deps.contract, pr, true, lastOverview);
      if (budget <= 0) return failedResult('context', 'budget_too_small', usage, audit, 'ok', threshold, due, said);
    }
    const packed = packBatches(plan.send, budget, input.limits.batchesPerReview);
    audit.push(...built.audit, ...reuseAudit, ...attached.audit, ...leftOutAudit, ...packed.audit);
    // A covered file that found no room was read, as it is, by an earlier review: it is left out too.
    const roomless = plan.send.filter((c) => c.kept?.covered === true && packed.notReviewed.some((n) => n.path === c.file.path && n.reason === 'over_batch_limit'));
    audit.push(...roomless.flatMap(leaveOut));
    const notSent: NotReviewed[] = packed.notReviewed.filter((n) => !leftOutPaths.has(n.path));
    shown = shown.filter((s) => !leftOutPaths.has(s.file));
    if (packed.batches.length === 0) {
      for (const s of shown) {
        if (notSent.some((n) => n.path === s.file)) audit.push({ stage: 'context', action: 'thread_not_shown', subject: s.key, reason: 'file_not_reviewed' });
      }
      const scored = reconcileScores([], built.contexts, new Set(notSent.map((n) => n.path)), floors, by);
      const result = okResult(mode === 'full' ? 'No reviewable changes.' : NOTHING_READ, threshold, due, said, {
        coverage: { reviewed: [], notReviewed: notSent }, audit: [...audit, ...scored.audit],
        scores: scored.scores, verdict: verdictOf(scored.scores, threshold), teamFileInvalid,
      });
      if (mode === 'full' || due > 0) return result;
      // Nothing new: the review would tell a person what the newest published one already tells.
      const told = shownOf(result);
      return told !== null && told === input.history?.shown ? { ...result, nothingToDo: true } : result;
    }

    stage = 'model';
    const run: Run = {
      contexts: built.contexts, limits: input.limits,
      effort: chooseEffort(pr, files, input.repoConfig), token: deps.token(), pr, deps,
      fileCount: packed.batches.reduce((n, b) => n + b.files.length, 0), batchCount: packed.batches.length, withThreads, lastOverview,
    };
    const firsts: number[] = [];
    let seen = 0;
    for (const b of packed.batches) {
      firsts.push(seen + 1);
      seen += b.files.length;
    }
    const ctl: Control = { stopped: false, error: null, failed: false };
    const settled = await inPool(packed.batches.length, CONCURRENCY, ctl, (i) => runBatch(run, ctl, packed.batches[i]!, firsts[i]!, i));
    const outcomes = settled.filter((o): o is BatchOutcome => o !== undefined);

    for (const o of outcomes) {
      usage = addUsage(usage, o.usage);
      audit.push(...o.audit);
    }
    answered = {
      models: distinct(outcomes.flatMap((o) => o.models)), providers: distinct(outcomes.flatMap((o) => o.providers)),
    };
    if (ctl.failed) throw ctl.error;
    const codes = outcomes.flatMap((o) => o.failedCodes);
    const modelState = codes.some((c) => PROVIDER_CODES.has(c)) ? 'error' : 'ok';
    const fatal = codes.find((c) => c === 'auth' || c === 'no_credit');
    const everyBatchFailed = outcomes.every((o) => o.answers.length === 0);
    if (fatal !== undefined || everyBatchFailed) {
      return failedResult('model', fatal ?? codes[0] ?? 'internal_error', usage, audit, modelState, threshold, due, said, answered);
    }

    const rec = reconcile(outcomes.flatMap((o) => o.answers), built.contexts);
    audit.push(...rec.audit);
    const notReviewed: NotReviewed[] = [
      ...notSent,
      ...outcomes.flatMap((o) => o.failedFiles.map((path): NotReviewed => ({ path, reason: 'batch_failed' }))),
    ];
    const notRead = new Set(notReviewed.map((n) => n.path));
    for (const s of shown) {
      if (notRead.has(s.file)) audit.push({ stage: 'context', action: 'thread_not_shown', subject: s.key, reason: 'file_not_reviewed' });
    }
    const judged = reconcileVerdicts(outcomes.flatMap((o) => o.answers), shown, built.contexts, pr.headSha);
    audit.push(...judged.audit);
    const earlierThreads = input.earlier?.threads ?? [];
    const placed = dropDuplicates(rec.findings, earlierThreads, judged.verdicts, files);
    const away = dropDuplicates(rec.unplaced, earlierThreads, judged.verdicts, files);
    audit.push(...placed.audit, ...away.audit);
    const alreadyDiscussed = [...placed.dropped, ...away.dropped].flatMap(({ finding, thread }) => discussed(finding, thread));
    let findings = placed.kept;
    let byMode: { unchanged: Finding[] } | { blockingOnUnchanged: number } | Record<string, never> = {};
    if (mode !== 'full') {
      const sent = new Map(plan.send.map((c) => [c.file.path, c]));
      const moded = reconcileMode(placed.kept, (path) => sent.get(path)?.changed ?? null, (path) => sent.get(path)?.blocks ?? []);
      audit.push(...moded.audit);
      findings = moded.kept;
      byMode = { unchanged: moded.unchanged };
    } else if ((input.history?.lastReview ?? null) !== null) {
      const count = await countUnchanged(placed.kept, built.contexts, pr.headSha, built.content, audit);
      if (count !== undefined) byMode = { blockingOnUnchanged: count };
    }
    let scoreAnswers = outcomes.flatMap((o) => o.answers);
    if (deps.scorer !== undefined) {
      const reviewed = new Set(outcomes.flatMap((o) => o.reviewed));
      const asked = await askScorer({
        scorer: deps.scorer,
        // The copies the review model was sent, with the paired test or the full file cut where one was.
        contexts: packed.batches.flatMap((b) => b.files).filter((c) => reviewed.has(c.file.path) && c.plan.kind === 'model'),
        pr, token: run.token, summaries: summariesOf(scoreAnswers, built.contexts), log: (entry) => safeLog(deps, entry),
      });
      usage = addUsage(usage, asked.usage);
      audit.push(...asked.audit);
      // A file moved to another directory with no content change keeps the review model's own score.
      const known: ReadonlySet<string> = new Set(built.contexts.map((c) => c.file.path));
      const whole: ReadonlySet<string> = new Set(built.contexts.filter((c) => c.plan.kind === 'model_whole').map((c) => c.file.path));
      const wholeAnswers = scoreAnswers.map((a) => ({
        value: { ...a.value, files: a.value.files.filter((raw) => whole.has(normalizePath(raw.path, known) ?? '')) },
        files: a.files.filter((path) => whole.has(path)),
      }));
      scoreAnswers = [...asked.answers, ...wholeAnswers];
    }
    const scored = reconcileScores(scoreAnswers, built.contexts, notRead, floors, by);
    audit.push(...scored.audit);
    return okResult(rec.overview, threshold, due, said, {
      findings, ...byMode, unplaced: away.kept, beyondDiff: rec.beyondDiff,
      threadVerdicts: judged.verdicts, alreadyDiscussed,
      coverage: { reviewed: outcomes.flatMap((o) => o.reviewed), notReviewed },
      usage, ...answered, dependencies: { model: modelState }, audit,
      scores: scored.scores, verdict: verdictOf(scored.scores, threshold), teamFileInvalid,
    });
  } catch (error) {
    let code = 'internal_error';
    if (stage === 'context' && sourceErrors.has(error)) code = errorCode(error);
    const name = error instanceof Error ? error.name : 'unknown';
    safeLog(deps, { event: 'internal_error', stage, name });
    return failedResult(stage, code, usage, audit, 'ok', input.repoConfig.scoreThreshold, due, said, answered);
  }
}
