import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { pgliteDb } from './db/pglite.ts';
import type { Db, InstanceLock } from './db/types.ts';
import { loadMigrations, MIGRATIONS_DIR, migrate } from './db/migrate.ts';
import { claimJob, enqueueJob, finishJob, getJob, unfinishedJobs } from './db/jobs.ts';
import { recordRun } from './db/review-runs.ts';
import type { RunRecord } from './db/review-runs.ts';
import { beat, readHeartbeat } from './db/heartbeat.ts';
import { serviceConfig, parseConfig } from './config/load.ts';
import type { AppIdentity, FeatureOff, ForgeEvent, HookDelivery, LivePullRequest, PullRequestAction, PullRequestFacts, Source } from './forge/types.ts';
import type { ReviewDeps, ReviewInput, ReviewResult } from './engine/types.ts';
import { BEAT_MS, CLOSE_WAIT_MS, DRAIN_WAIT_MS, startService, STOP_WAIT_MS, TICK_MS, UPKEEP_MS } from './service.ts';
import type { Listening } from './service.ts';
import type { RequestLike, ResponseLike } from './shell/http.ts';

const REF = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;
const at = (seconds: number): string => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000).toISOString();

const job = (over = {}) => ({ ref: REF, reason: 'opened', headSha: 'h1', runAt: at(0), now: at(0), delivery: 'd1', replace: true,
  trigger: 'automatic' as const, requestedBy: null, commentId: null, association: null, installation: null, ...over });
const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  ref: REF, job: null, trigger: 'automatic', mode: 'full', dryRun: true, headSha: 'h1', baseSha: 'b1', baseBranch: null,
  outcome: 'ok', failureStage: null, failureCode: null, needsHuman: false, highestScore: 35,
  body: 'text', comments: [{ path: 'a.ts', side: 'RIGHT', line: 3, body: 'note' }], result: { findings: [] },
  usage: { calls: 2, inputTokens: 1000, outputTokens: 200, cachedTokens: 50, cost: 0.0375 },
  startedAt: at(0), finishedAt: at(90), ...over,
});
const facts = (over: Partial<PullRequestFacts> = {}): PullRequestFacts => ({
  ref: REF, author: 'octo-dev', authorIsBot: false, baseBranch: 'main', headBranch: 'feat', headSha: 'h1', draft: false,
  state: 'open', mergedAt: null, closedAt: null, mergeCommit: null, installation: '99', updatedAt: at(0), ...over,
});
type PullRequestEvent = Extract<ForgeEvent, { kind: 'pull_request' }>;
const pr = (action: PullRequestAction, over: Partial<PullRequestFacts> = {}): PullRequestEvent => ({ kind: 'pull_request', action, facts: facts(over) });
const PING = { kind: 'ping' } as ForgeEvent;
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

const appKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const config = serviceConfig(parseConfig(
  'model:\n  apiKey: { env: K }\n  model: vendor/model-a\napp:\n  id: 12345\n  privateKey: { env: A }\n  webhookSecret: { env: S }\ndatabase:\n  url: { env: U }\nserver:\n  port: 9191\nlimits:\n  spendPerDay: 50\ndryRun: true\n',
  { K: 'k', A: appKey, S: 's', U: 'postgres://u:p@db.example.test/d' }));

const never = (): Promise<never> => new Promise(() => {});

interface Options {
  lock?: null; listenError?: Error; now?: string; holdReview?: boolean;
  listings?: Array<{ deliveries: HookDelivery[]; complete: boolean } | Error>;
  migrationError?: Error; closeNever?: boolean; closeError?: Error; listenerCloseError?: Error; logThrows?: boolean;
  /** The status the model endpoint's key route answers with; 200 when not given. */
  keyStatus?: number;
  /** What the app lacks; an Error makes the check reject. Nothing when not given. */
  lacks?: FeatureOff[] | Error;
  /** false to leave dry run; true when not given. */
  dryRun?: boolean;
  /** The key route's answer waits for this when given. */
  keyGate?: Promise<void>;
}
interface Timer { ms: number; work: () => Promise<void>; cancelled: boolean }

const opened: Db[] = [];
const started: Array<{ stop(): Promise<void> }> = [];
afterEach(async () => {
  for (const service of started.splice(0)) await service.stop();
  for (const db of opened.splice(0)) await db.close();
});

async function harness(options: Options = {}) {
  const real = await pgliteDb();
  opened.push(real);
  const events: string[] = [];
  const timers: Timer[] = [];
  const inputs: ReviewInput[] = [];
  const fetched: string[] = [];
  const listedSince: string[] = [];
  const logged: Array<Record<string, unknown>> = [];
  const writes: unknown[][] = [];
  const listings = [...(options.listings ?? [])];
  let listener: ((req: RequestLike, res: ResponseLike) => void) | null = null;
  let current: ForgeEvent = PING;
  let delivered = 'd-1';
  let releaseReview!: () => void;
  const reviewHeld = new Promise<void>((done) => { releaseReview = done; });
  let reviewCalled!: () => void;
  const reviewed = new Promise<void>((done) => { reviewCalled = done; });
  let publishCalled!: () => void;
  const published = new Promise<void>((done) => { publishCalled = done; });
  const order: string[] = [];
  const lacksCalls: boolean[] = [];
  const appInfo: AppIdentity = {
    read: () => Promise.reject(new Error('not_used')),
    canResolve: () => Promise.resolve(false),
    lacks: (dryRun) => (order.push('lacks'), lacksCalls.push(dryRun), options.lacks instanceof Error ? Promise.reject(options.lacks) : Promise.resolve(options.lacks ?? [])),
  };

  const db: Db = {
    query: (text, params) => real.query(text, params),
    script: (sql) => (options.migrationError === undefined ? real.script(sql) : Promise.reject(options.migrationError)),
    transaction: async (work) => {
      if (h.beforeTransaction !== undefined) await h.beforeTransaction();
      return real.transaction(work);
    },
    close: () => {
      events.push('close');
      if (options.closeNever === true) return never();
      if (options.closeError !== undefined) return Promise.reject(options.closeError);
      return Promise.resolve();
    },
  };
  const lock: InstanceLock = { release: async () => { events.push('release'); } };

  const h = {
    db, events, order, lacksCalls, timers, inputs, fetched, listedSince, logged, writes,
    port: 0,
    /** What the clock reads; a test may move it. */
    now: options.now ?? at(0),
    onListen: undefined as (() => Promise<void>) | undefined,
    beforeListing: undefined as (() => Promise<void>) | undefined,
    beforeTransaction: undefined as (() => Promise<void>) | undefined,
    releaseReview: () => { releaseReview(); },
    reviewed: () => reviewed,
    published: () => published,
    start: async () => {
      const service = await startService(options.dryRun === false ? { ...config, dryRun: false } : config, {
      db, appInfo,
      reader: { read: () => ({ ok: true as const, delivery: delivered, name: current.kind, action: current.kind === 'pull_request' ? current.action : null, event: current }) },
      clock: () => new Date(h.now),
      log: (e) => { logged.push(e); if (options.logThrows === true) throw new Error('logger down'); },
      listen: async (l, p) => {
        events.push('listen');
        listener = l;
        h.port = p;
        if (h.onListen !== undefined) await h.onListen();
        if (options.listenError !== undefined) throw options.listenError;
        const listening: Listening = {
          close: () => {
            events.push('listener-close');
            return options.listenerCloseError === undefined ? Promise.resolve() : Promise.reject(options.listenerCloseError);
          },
        };
        return listening;
      },
      takeLock: async () => {
        events.push('lock');
        return options.lock === null ? null : lock;
      },
      forge: { readPullRequest: () => Promise.resolve(LIVE), sourceFor: () => Promise.resolve({} as Source) },
      hooks: {
        listSince: async (since) => {
          listedSince.push(since);
          order.push('listing');
          if (h.beforeListing !== undefined) await h.beforeListing();
          const next = listings.shift() ?? { deliveries: [], complete: true };
          if (next instanceof Error) throw next;
          return next;
        },
        redeliver: () => Promise.resolve(),
      },
      writer: {
        publishReview: async (_ref, _installation, draft) => { writes.push(['publishReview', draft.commit]); publishCalled(); return { id: '501' }; },
        listOwnReviews: async () => { writes.push(['listOwnReviews']); return []; },
        listReviewComments: async () => { writes.push(['listReviewComments']); return []; },
        react: async () => { writes.push(['react']); },
        comment: async () => { writes.push(['comment']); },
        listThreads: () => Promise.reject(new Error('not_expected')),
        replyToThread: () => Promise.reject(new Error('not_expected')),
        editThreadComment: () => Promise.reject(new Error('not_expected')),
        resolveThread: () => Promise.reject(new Error('not_expected')),
      },
      fetch: (async (url: string | URL | Request) => {
        fetched.push(String(url));
        if (String(url).endsWith('/key')) {
          order.push('key');
          if (options.keyGate !== undefined) await options.keyGate;
        }
        return new Response('{}', { status: String(url).endsWith('/key') ? options.keyStatus ?? 200 : 200 });
      }) as typeof fetch,
      sleep: () => Promise.resolve(),
      every: (ms, work) => {
        const timer: Timer = { ms, work, cancelled: false };
        timers.push(timer);
        return () => { timer.cancelled = true; };
      },
      engineDeps: (source) => ({ source }) as ReviewDeps,
      review: async (input) => {
        inputs.push(input);
        reviewCalled();
        if (options.holdReview === true) await reviewHeld;
        return okResult();
      },
      lineUrl: () => 'https://git.example.test/x',
      commentUrl: (_ref, commentId) => `https://git.example.test/c/${commentId}`,
      });
      started.push(service);
      return service;
    },
    runTimer: (ms: number) => timers.find((t) => t.ms === ms)!.work(),
    webhook: (event: ForgeEvent, delivery: string) => new Promise<{ status: number | null; body: string | null }>((resolve) => {
      current = event;
      delivered = delivery;
      const answer = { status: null as number | null, body: null as string | null };
      const req: RequestLike = { method: 'POST', url: '/webhooks/github', headers: {}, async *[Symbol.asyncIterator]() { yield Buffer.from('{}'); } };
      listener!(req, {
        writeHead(status: number) { answer.status = status; },
        end(body: string) { answer.body = body; resolve(answer); },
      });
    }),
    flush: async () => {
      for (let i = 0; i < 5; i += 1) await new Promise((done) => setImmediate(done));
    },
  };
  return h;
}

/** The log entries of a stop, without those every start writes. */
const ofStop = (logged: Array<Record<string, unknown>>) => logged.filter((e) => e.event !== 'recovery' && e.event !== 'model_check' && e.event !== 'app_check');

test('start takes the lock, then migrates and recovers, then listens', async () => {
  const h = await harness();
  await migrate(h.db, loadMigrations(MIGRATIONS_DIR));
  const cut = (await enqueueJob(h.db, job()))!;
  await claimJob(h.db, cut, at(0));
  let seenAtListen: string | undefined;
  h.onListen = async () => { seenAtListen = (await getJob(h.db, cut))?.status; };
  await h.start();
  assert.deepEqual([h.events.slice(0, 2), seenAtListen], [['lock', 'listen'], 'pending']);
});
test('a second instance is refused before it migrates or listens', async () => {
  const h = await harness({ lock: null });
  await assert.rejects(h.start(), /^Error: another_instance_running$/);
  assert.deepEqual(h.events, ['lock', 'close']);
  await assert.rejects(h.db.query('select 1 from visto_ai.jobs'));
});
test('when a later step of the start fails the lock is released and the database closed', async () => {
  const h = await harness({ listenError: new Error('EADDRINUSE') });
  await assert.rejects(h.start(), /EADDRINUSE/);
  assert.deepEqual(h.events.slice(-2).sort(), ['close', 'release']);
});
test('a delivery that queues a review is run without waiting for the timer', async () => {
  const h = await harness();
  const service = await h.start();
  await service.settled;
  assert.deepEqual(await h.webhook(pr('opened'), 'd1'), { status: 202, body: 'accepted' });
  await h.reviewed();
  assert.equal(h.inputs[0]!.pullRequest.headSha, 'h1');
});
test('after listening it checks the key, asks for failed deliveries since the last heartbeat less two minutes, then starts beating', async () => {
  const h = await harness({ now: at(600) });
  await migrate(h.db, loadMigrations(MIGRATIONS_DIR));
  await beat(h.db, at(0));
  const service = await h.start();
  await service.settled;
  assert.deepEqual([h.fetched.some((u) => u.endsWith('/key')), h.listedSince, await readHeartbeat(h.db)], [true, [at(-120)], at(600)]);
  assert.deepEqual(h.timers.map((t) => t.ms), [TICK_MS, UPKEEP_MS, BEAT_MS]);
  assert.deepEqual(h.logged.filter((e) => e.event === 'model_check'), [{ event: 'model_check', result: 'ok' }]);
});
test('on a first start nothing is asked for again, and the beat starts', async () => {
  const h = await harness();
  const service = await h.start();
  await service.settled;
  assert.deepEqual([h.listedSince, await readHeartbeat(h.db), h.timers.some((t) => t.ms === BEAT_MS)], [[], at(0), true]);
});
test('a redelivery that does not get through is alerted once and tried again by the upkeep with the same look-back; the beat starts only when one does', async () => {
  const h = await harness({ now: at(600), listings: [new Error('github_502'), new Error('github_502'), { deliveries: [], complete: true }] });
  await migrate(h.db, loadMigrations(MIGRATIONS_DIR));
  await beat(h.db, at(0));
  const service = await h.start();
  await service.settled;
  assert.deepEqual([h.listedSince, await readHeartbeat(h.db), h.timers.some((t) => t.ms === BEAT_MS)], [[at(-120)], at(0), false]);
  await h.runTimer(UPKEEP_MS);
  await h.runTimer(UPKEEP_MS);
  assert.deepEqual([h.listedSince, await readHeartbeat(h.db), h.timers.some((t) => t.ms === BEAT_MS)], [[at(-120), at(-120), at(-120)], at(600), true]);
  const raised = h.logged.filter((e) => e.event === 'alert' && e.code === 'redelivery_failed');
  assert.deepEqual(raised, [{ event: 'alert', code: 'redelivery_failed', reason: 'github_502', failed: 0, complete: false }]);
  await h.runTimer(UPKEEP_MS);
  assert.equal(h.listedSince.length, 3);
});
test('the upkeep checks the key and deletes jobs finished more than fourteen days ago', async () => {
  const h = await harness();
  const service = await h.start();
  await service.settled;
  const old = (await enqueueJob(h.db, job()))!;
  await finishJob(h.db, old, 'done', 'reviewed', at(-15 * 86_400));
  h.fetched.length = 0;
  await h.runTimer(UPKEEP_MS);
  assert.deepEqual([h.fetched.some((u) => u.endsWith('/key')), await getJob(h.db, old)], [true, null]);
});
test('nothing starts once the daily limit is reached, and the operator is told once', async () => {
  const h = await harness();
  const service = await h.start();
  await service.settled;
  await recordRun(h.db, run({ startedAt: at(0), usage: { ...run().usage, cost: 50 } }));
  await h.webhook(pr('opened'), 'd1');
  await h.runTimer(TICK_MS);
  await h.runTimer(TICK_MS);
  assert.deepEqual([h.inputs.length, (await unfinishedJobs(h.db))[0]!.status], [0, 'pending']);
  assert.equal(h.logged.filter((e) => e.event === 'alert' && e.code === 'spend_limit').length, 1);
});
test('stop drains first: a running review finishes while webhooks are still accepted, then the listener, the database and the lock', async () => {
  const h = await harness({ holdReview: true });
  const service = await h.start();
  await service.settled;
  await h.webhook(pr('opened'), 'd1');
  await h.reviewed();
  const stopping = service.stop();
  assert.deepEqual(await h.webhook(pr('opened', { headSha: 'h2', updatedAt: at(5) }), 'd2'), { status: 202, body: 'accepted' });
  assert.equal(h.events.includes('listener-close'), false);
  h.releaseReview();
  await stopping;
  assert.deepEqual(h.events.slice(-3), ['listener-close', 'close', 'release']);
  const pending = await h.db.query<{ n: number }>("select count(*)::int as n from visto_ai.jobs where status = 'pending'");
  assert.deepEqual([h.timers.every((t) => t.cancelled), pending[0]!.n], [true, 1]);
});
test('stop goes on once DRAIN_WAIT_MS has passed, and says how many reviews were cut', async (t) => {
  const h = await harness({ holdReview: true });
  const service = await h.start();
  await service.settled;
  await h.webhook(pr('opened'), 'd1');
  await h.reviewed();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stopping = service.stop();
  await h.flush();
  t.mock.timers.tick(DRAIN_WAIT_MS);
  await stopping;
  assert.deepEqual(h.logged.find((e) => e.event === 'drain_timeout'), { event: 'drain_timeout', running: 1 });
  assert.equal((await h.db.query<{ status: string }>('select status from visto_ai.jobs'))[0]!.status, 'running');
});
test('a redelivery attempt that is still under way when the upkeep runs is not started twice, and one beat is registered', async () => {
  let release!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  const h = await harness({ now: at(600) });
  h.beforeListing = () => held;
  await migrate(h.db, loadMigrations(MIGRATIONS_DIR));
  await beat(h.db, at(0));
  const service = await h.start();
  await h.flush();
  const upkept = h.runTimer(UPKEEP_MS);
  await h.flush();
  assert.equal(h.listedSince.length, 1);
  release();
  await service.settled;
  await upkept;
  assert.deepEqual([h.listedSince.length, h.timers.filter((t) => t.ms === BEAT_MS).length], [1, 1]);
  await service.stop();
});
test('a refused key stops the service from reviewing until the pause is over', async () => {
  const h = await harness({ keyStatus: 401 });
  const service = await h.start();
  await service.settled;
  await h.webhook(pr('opened'), 'd1');
  await h.runTimer(TICK_MS);
  await h.runTimer(TICK_MS);
  assert.deepEqual([h.inputs.length, (await unfinishedJobs(h.db))[0]!.status], [0, 'pending']);
  h.now = at(300);
  await h.runTimer(TICK_MS);
  await h.reviewed();
  assert.equal(h.inputs.length, 1);
  await service.stop();
});
test('a stop that comes while failed deliveries are being asked for starts no beat', async () => {
  let release!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  const h = await harness({ now: at(600) });
  h.beforeListing = () => held;               // listSince waits for this before it answers
  await migrate(h.db, loadMigrations(MIGRATIONS_DIR));
  await beat(h.db, at(0));
  const service = await h.start();
  await h.flush();
  const stopping = service.stop();
  release();
  await stopping;
  await service.settled;
  assert.deepEqual([await readHeartbeat(h.db), h.timers.some((t) => t.ms === BEAT_MS)], [at(0), false]);
});

test('out of dry run, a review is posted through the writer the service was given; in dry run that writer is never reached', async () => {
  const out = await harness({ dryRun: false });
  const service = await out.start();
  await service.settled;
  await out.webhook(pr('opened'), 'd1');
  const gave = await Promise.race([out.published().then(() => 'posted'), new Promise<string>((done) => { setTimeout(() => { done('no post within 5 seconds'); }, 5_000).unref(); })]);
  assert.equal(gave, 'posted');
  assert.equal(out.writes.some((w) => w[0] === 'publishReview'), true);
  const dry = await harness();
  await (await dry.start()).settled;
  await dry.webhook(pr('opened'), 'd1');
  await dry.reviewed();
  await dry.flush();
  assert.deepEqual(dry.writes, []);
});
test('at start the service says what the app lacks, once for each thing, and keeps running', async () => {
  const h = await harness({ dryRun: false, lacks: [{ feature: 'publishing', missing: 'pull_requests:write' }, { feature: 'commands', missing: 'issues:write' }] });
  const service = await h.start();
  await service.settled;
  assert.deepEqual(h.logged.filter((e) => e.event === 'feature_off'), [
    { event: 'feature_off', feature: 'publishing', missing: 'pull_requests:write' },
    { event: 'feature_off', feature: 'commands', missing: 'issues:write' },
  ]);
  assert.deepEqual(h.logged.filter((e) => e.event === 'alert' && e.code === 'feature_off'), [
    { event: 'alert', code: 'feature_off', feature: 'publishing', missing: 'pull_requests:write' },
    { event: 'alert', code: 'feature_off', feature: 'commands', missing: 'issues:write' },
  ]);
  assert.deepEqual(h.lacksCalls, [false]);
  assert.deepEqual(await h.webhook(pr('opened'), 'd1'), { status: 202, body: 'accepted' });
});
test('the app check comes after the key check and before the redelivery', async () => {
  const h = await harness({ now: at(600) });
  await migrate(h.db, loadMigrations(MIGRATIONS_DIR));
  await beat(h.db, at(0));
  await (await h.start()).settled;
  assert.deepEqual(h.order, ['key', 'lacks', 'listing']);
});
test('in dry run the service asks what the app lacks for dry run', async () => {
  const h = await harness();
  await (await h.start()).settled;
  assert.deepEqual(h.lacksCalls, [true]);
});
test('a stop that comes while the key check is pending ends the start: the app is not asked and nothing is raised', async () => {
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  const h = await harness({ keyGate: gate, lacks: [{ feature: 'publishing', missing: 'pull_requests:write' }] });
  const service = await h.start();
  await h.flush();
  const stopping = service.stop();
  release();
  await stopping;
  await service.settled;
  assert.deepEqual([h.lacksCalls, h.logged.filter((e) => e.event === 'app_check' || e.event === 'feature_off')], [[], []]);
});
test('an app that lacks nothing is logged as such, and a check that cannot be made does not stop the start', async () => {
  const ok = await harness();
  await (await ok.start()).settled;
  assert.deepEqual(ok.logged.filter((e) => e.event === 'app_check'), [{ event: 'app_check', missing: 0 }]);
  const down = await harness({ lacks: new Error('github_network') });
  await (await down.start()).settled;
  assert.equal(down.logged.some((e) => e.event === 'start_step_failed' && e.step === 'app_check' && e.reason === 'github_network'), true);
});

// Plan 3's tests of the start and the stop, on the new harness.

test('startService migrates before it listens, on the configured port, and serves webhooks', async () => {
  const h = await harness();
  let tableAtListen: unknown[] = [];
  h.onListen = async () => {
    tableAtListen = await h.db.query("select 1 as x from information_schema.tables where table_schema = 'visto_ai' and table_name = 'deliveries'");
  };
  const service = await h.start();
  assert.equal(h.port, 9191);
  assert.equal(tableAtListen.length, 1);
  await h.webhook(PING, 'd-1');
  assert.deepEqual(await h.db.query('select id from visto_ai.deliveries'), [{ id: 'd-1' }]);
  await service.stop();
});
test('stop closes the listener, then waits for a request in flight, then closes the database', async () => {
  const h = await harness();
  const service = await h.start();
  await service.settled;
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  h.beforeTransaction = () => gate;
  const answered = h.webhook(PING, 'd-1').then(() => { h.events.push('answered'); });
  await h.flush();
  const stopped = service.stop().then(() => { h.events.push('stopped'); });
  await h.flush();
  assert.deepEqual(h.events.slice(-1), ['listener-close']);
  release();
  await answered;
  await stopped;
  assert.deepEqual(h.events.slice(-5), ['listener-close', 'answered', 'close', 'release', 'stopped']);
});
test('when a migration rejects startService rejects, nothing listens, and the database is closed', async () => {
  const h = await harness({ migrationError: new Error('bad sql') });
  await assert.rejects(h.start(), { message: 'bad sql' });
  assert.equal(h.events.includes('listen'), false);
  assert.deepEqual(h.events.slice(-2).sort(), ['close', 'release']);
});
test('stop goes on to close the database once STOP_WAIT_MS has passed when a request never finishes', async (t) => {
  const h = await harness();
  const service = await h.start();
  await service.settled;
  h.beforeTransaction = never;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  void h.webhook(PING, 'd-1');
  await h.flush();
  const stopped = service.stop();
  await h.flush();
  assert.deepEqual([h.events.includes('listener-close'), h.events.includes('close')], [true, false]);
  t.mock.timers.tick(STOP_WAIT_MS);
  await stopped;
  assert.equal(h.events.includes('close'), true);
});
test('stop resolves once CLOSE_WAIT_MS has passed when the database never closes', async (t) => {
  const h = await harness({ closeNever: true });
  const service = await h.start();
  await service.settled;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stopped = service.stop();
  while (!h.events.includes('close')) await h.flush();
  t.mock.timers.tick(CLOSE_WAIT_MS);
  await stopped;
  assert.deepEqual(ofStop(h.logged), [{ event: 'database_close_timeout' }]);
});
test('stop called twice returns the same promise and closes the database once', async () => {
  const h = await harness();
  const service = await h.start();
  const first = service.stop();
  assert.equal(service.stop(), first);
  await first;
  assert.deepEqual(h.events.filter((e) => e === 'close'), ['close']);
});
test('a database whose close rejects does not make stop reject, and its message is not logged', async () => {
  const h = await harness({ closeError: Object.assign(new Error('do-not-log-this'), { code: 'X1' }) });
  const service = await h.start();
  await service.settled;
  await service.stop();
  assert.deepEqual(ofStop(h.logged), [{ event: 'database_close_failed', error: 'Error', code: 'X1' }]);
  assert.ok(!JSON.stringify(h.logged).includes('do-not-log-this'));
});
test('a listener whose close rejects does not make stop reject; stop goes on and closes the database', async () => {
  const h = await harness({ listenerCloseError: Object.assign(new Error('do-not-log-this'), { code: 'L1' }) });
  const service = await h.start();
  await service.settled;
  await service.stop();
  assert.deepEqual(h.events.slice(-2), ['close', 'release']);
  assert.deepEqual(ofStop(h.logged), [{ event: 'listener_close_failed', error: 'Error', code: 'L1' }]);
  assert.ok(!JSON.stringify(h.logged).includes('do-not-log-this'));
});
test('a logger that throws changes nothing about stop', async () => {
  const h = await harness({ logThrows: true, closeError: new Error('close failed'), listenerCloseError: new Error('listener failed') });
  const service = await h.start();
  await service.settled;
  await service.stop();
  assert.deepEqual(h.events.slice(-2), ['close', 'release']);
});
