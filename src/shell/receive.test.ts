import test from 'node:test';
import assert from 'node:assert/strict';
import { receive } from './receive.ts';
import { testDb } from '../db/testing.ts';
import { listActivity } from '../db/human-activity.ts';
import { getPullRequest } from '../db/pull-requests.ts';
import type { Db } from '../db/types.ts';
import type {
  ForgeEvent, GeneralComment, HumanReview, PullRequestFacts, WebhookReader, WebhookReading,
} from '../forge/types.ts';

const ref = { service: 'github' as const, owner: 'acme', repo: 'shop', number: 7 };
const clock = () => new Date('2026-03-01T12:30:00.000Z');

const reader = (reading: WebhookReading): WebhookReader => ({ read: () => reading });
function read(delivery: string, event: ForgeEvent, name = 'pull_request_review', action: string | null = 'submitted'): WebhookReading {
  return { ok: true, delivery, name, action, event };
}
function facts(over: Partial<PullRequestFacts> = {}): PullRequestFacts {
  return {
    ref, author: 'octo-dev', authorIsBot: false, baseBranch: 'main', headBranch: 'feature', headSha: 'aaa111',
    draft: false, state: 'open', mergedAt: null, closedAt: null, mergeCommit: null,
    installation: '555', updatedAt: '2026-03-01T10:00:00.000Z', ...over,
  };
}
const review: HumanReview = {
  id: 'r-1', author: 'octo-dev', authorIsBot: false, association: 'member', state: 'approved',
  commit: 'bbb222', at: '2026-03-01T10:00:00.000Z', body: 'Looks good.',
};
const reviewEvent: ForgeEvent = { kind: 'review', ref, review };
function prEvent(over: Partial<PullRequestFacts> = {}): ForgeEvent {
  return { kind: 'pull_request', action: 'synchronize', facts: facts(over) };
}
const NO_JOBS = {
  settingsFor: () => ({ primaryBranches: ['main'], scoreThreshold: 70, ignoredAuthors: [], baseBranches: [], newHead: null }),
  onQueued: () => {},
};
const headers = {};
const empty = Buffer.from('');

async function run(db: Db, reading: WebhookReading, logs: Record<string, unknown>[] = []) {
  return receive({ db, reader: reader(reading), clock, log: (e) => logs.push(e), ...NO_JOBS }, headers, empty);
}

test('a review by a person is stored before the answer, and answered accepted', async () => {
  const db = await testDb();
  try {
    const logs: Record<string, unknown>[] = [];
    const answer = await receive({ db, reader: reader(read('d-1', reviewEvent)), clock, log: (e) => logs.push(e), ...NO_JOBS }, {}, Buffer.from(''));
    assert.deepEqual(answer, { status: 202, body: 'accepted' });
    assert.equal((await listActivity(db, ref)).length, 1);
    assert.deepEqual(logs, [{ event: 'webhook', delivery: 'd-1', name: 'pull_request_review', action: 'submitted', outcome: 'accepted', reason: null }]);
  } finally { await db.close(); }
});

test('a pull request event stores its facts', async () => {
  const db = await testDb();
  try {
    const answer = await run(db, read('d-1', prEvent(), 'pull_request', 'synchronize'));
    assert.deepEqual(answer, { status: 202, body: 'accepted' });
    assert.deepEqual(await getPullRequest(db, ref), facts());
  } finally { await db.close(); }
});

test('an ignored event answers ignored and stores only the delivery row', async () => {
  const db = await testDb();
  try {
    const logs: Record<string, unknown>[] = [];
    const answer = await run(db, read('d-1', { kind: 'ignored', reason: 'unknown_event' }, 'star', null), logs);
    assert.deepEqual(answer, { status: 202, body: 'ignored' });
    const rows = await db.query('select outcome, reason from visto_ai.deliveries where id = $1', ['d-1']);
    assert.deepEqual(rows, [{ outcome: 'ignored', reason: 'unknown_event' }]);
    assert.equal((await db.query('select 1 from visto_ai.pull_requests')).length, 0);
    assert.equal((await db.query('select 1 from visto_ai.human_activity')).length, 0);
    assert.deepEqual(logs, [{ event: 'webhook', delivery: 'd-1', name: 'star', action: null, outcome: 'ignored', reason: 'unknown_event' }]);
  } finally { await db.close(); }
});

for (const [reason, status, body] of [
  ['bad_signature', 401, 'invalid_signature'],
  ['not_json', 400, 'not_json'],
  ['no_delivery_id', 400, 'no_delivery_id'],
  ['no_event_name', 400, 'no_event_name'],
] as const) {
  test(`${reason} is rejected and no delivery row is stored`, async () => {
    const db = await testDb();
    try {
      const logs: Record<string, unknown>[] = [];
      const answer = await run(db, { ok: false, reason }, logs);
      assert.deepEqual(answer, { status, body });
      assert.equal((await db.query('select 1 from visto_ai.deliveries')).length, 0);
      assert.deepEqual(logs, [{ event: 'webhook', delivery: null, name: null, action: null, outcome: 'rejected', reason }]);
    } finally { await db.close(); }
  });
}

test('the same delivery twice answers accepted then duplicate, with one activity row', async () => {
  const db = await testDb();
  try {
    const logs: Record<string, unknown>[] = [];
    assert.deepEqual(await run(db, read('d-1', reviewEvent), logs), { status: 202, body: 'accepted' });
    assert.deepEqual(await run(db, read('d-1', reviewEvent), logs), { status: 202, body: 'duplicate' });
    assert.equal((await listActivity(db, ref)).length, 1);
    assert.equal(logs[1]?.['outcome'], 'duplicate');
    assert.equal(logs[1]?.['reason'], null);
  } finally { await db.close(); }
});

test('two calls started together give one accepted and one duplicate', async () => {
  const db = await testDb();
  try {
    const answers = await Promise.all([run(db, read('d-1', reviewEvent)), run(db, read('d-1', reviewEvent))]);
    assert.deepEqual(answers.map((a) => a.body).sort(), ['accepted', 'duplicate']);
    assert.equal((await listActivity(db, ref)).length, 1);
  } finally { await db.close(); }
});

test('an older pull request event is accepted and does not roll the facts back', async () => {
  const db = await testDb();
  try {
    const newer = prEvent({ updatedAt: '2026-03-01T11:00:00.000Z', headSha: 'new111' });
    const older = prEvent({ updatedAt: '2026-03-01T10:00:00.000Z', headSha: 'old111' });
    await run(db, read('d-1', newer, 'pull_request', 'synchronize'));
    assert.deepEqual(await run(db, read('d-2', older, 'pull_request', 'synchronize')), { status: 202, body: 'accepted' });
    assert.deepEqual(await getPullRequest(db, ref), facts({ updatedAt: '2026-03-01T11:00:00.000Z', headSha: 'new111' }));
  } finally { await db.close(); }
});

test('a database that fails in the middle stores nothing, answers 503, and logs no message', async () => {
  const real = await testDb();
  try {
    const boom = Object.assign(new Error('do-not-log-this'), { code: '57P01' });
    const failing: Db = {
      query: (t, p) => real.query(t, p),
      script: (s) => real.script(s),
      close: () => real.close(),
      transaction: (work) => real.transaction(async (tx) => {
        let n = 0;
        return work({
          query: async (t, p) => { n += 1; if (n === 2) throw boom; return tx.query(t, p); },
          script: (s) => tx.script(s),
          transaction: (w) => tx.transaction(w),
          close: () => tx.close(),
        });
      }),
    };
    const logs: Record<string, unknown>[] = [];
    const answer = await run(failing, read('d-1', reviewEvent), logs);
    assert.deepEqual(answer, { status: 503, body: 'storage_unavailable' });
    assert.deepEqual(await run(real, read('d-1', reviewEvent)), { status: 202, body: 'accepted' });
    assert.equal(logs.length, 1);
    assert.deepEqual(logs[0], {
      event: 'webhook', delivery: 'd-1', name: 'pull_request_review', action: 'submitted',
      outcome: 'failed', reason: 'storage_unavailable', error: 'Error', code: '57P01',
    });
    assert.ok(!JSON.stringify(logs).includes('do-not-log-this'));
  } finally { await real.close(); }
});

test('a reader that throws answers 500 and does not reject', async () => {
  const db = await testDb();
  try {
    const logs: Record<string, unknown>[] = [];
    const throwing: WebhookReader = { read: () => { throw new TypeError('do-not-log-this'); } };
    const answer = await receive({ db, reader: throwing, clock, log: (e) => logs.push(e), ...NO_JOBS }, headers, empty);
    assert.deepEqual(answer, { status: 500, body: 'internal_error' });
    assert.deepEqual(logs, [{
      event: 'webhook', delivery: null, name: null, action: null,
      outcome: 'failed', reason: 'internal_error', error: 'TypeError', code: null,
    }]);
  } finally { await db.close(); }
});

test('a comment is stored and its text reaches no log', async () => {
  const db = await testDb();
  try {
    const comment: GeneralComment = {
      id: 'g-1', author: 'octo-dev', authorIsBot: false, association: 'owner',
      at: '2026-03-01T10:10:00.000Z', body: 'secret-looking-text',
    };
    const logs: Record<string, unknown>[] = [];
    const answer = await run(db, read('d-1', { kind: 'general_comment', ref, installation: null, comment }, 'issue_comment', 'created'), logs);
    assert.deepEqual(answer, { status: 202, body: 'accepted' });
    assert.equal((await listActivity(db, ref))[0]?.body, 'secret-looking-text');
    assert.ok(!JSON.stringify(logs).includes('secret-looking-text'));
  } finally { await db.close(); }
});

test('a logger that throws does not change the answer', async () => {
  const db = await testDb();
  try {
    const log = () => { throw new Error('logger down'); };
    const answer = await receive({ db, reader: reader(read('d-1', reviewEvent)), clock, log, ...NO_JOBS }, headers, empty);
    assert.deepEqual(answer, { status: 202, body: 'accepted' });
    assert.equal((await listActivity(db, ref)).length, 1);
  } finally { await db.close(); }
});
