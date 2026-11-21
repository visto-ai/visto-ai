import assert from 'node:assert/strict';
import test from 'node:test';
import type { FileContext } from './context/build.ts';
import type { ShownThread } from './context/threads.ts';
import { filesToSend } from './plan.ts';
import type { KeptScores } from './score/history.ts';
import type { ScorePlan } from './score/rules.ts';

const PLANS: Record<'model' | 'model_whole' | 'rule', ScorePlan> = {
  model: { kind: 'model' },
  model_whole: { kind: 'model_whole' },
  rule: { kind: 'rule', score: 10, source: 'rule_asset' },
};

const keptWith = (covered: boolean): KeptScores => ({
  blocks: [], entries: new Map(), stoodFor: new Set(), wholeFile: null, floor: 0, settled: covered, covered, scoredHunks: new Set(), readAt: null,
});

const threadOn = (path: string, due: boolean): ShownThread => ({
  key: 'T1', file: path, due, thread: {
    id: 'PRRT_1', commentId: 'C1', path, side: 'RIGHT', line: 2, severity: due ? 'major' : 'minor', quote: '', body: 'Wrong value.',
    openedAt: { head: 'abcdef0', diffHash: null }, resolved: false, settled: false, lastVerdict: null, replies: [],
  },
});

// A minimal context: `kept.covered` when `covered` is given, and one thread on a file the model reads, unless `thread` is false.
function ctx(path: string, opts: { covered?: boolean; due?: boolean; plan?: keyof typeof PLANS; thread?: boolean }): FileContext {
  const plan = PLANS[opts.plan ?? 'model'];
  return {
    file: { path, previousPath: null, status: 'modified', additions: 1, deletions: 1, patch: '' },
    hunks: [], ranges: null, diffText: null, full: null, test: null, skip: null, blocks: [], plan, hidden: false,
    ...(opts.covered === undefined ? {} : { kept: keptWith(opts.covered) }),
    ...(plan.kind === 'model' && opts.thread !== false ? { threads: [threadOn(path, opts.due === true)] } : {}),
  };
}
const paths = (out: { send: FileContext[]; leftOut: FileContext[] }): string[][] => [out.send.map((x) => x.file.path), out.leftOut.map((x) => x.file.path)];

test('a full review reads what is not covered before what it reads again, and leaves out only a moved file that has its score', () => {
  const [a, b, c, d, e] = [ctx('a.ts', { covered: true }), ctx('b.ts', {}), ctx('c.ts', { covered: true, due: true }), ctx('d.ts', { covered: false }), ctx('e.ts', { covered: true, plan: 'model_whole' })];
  const out = filesToSend([a!, b!, c!, d!, e!], 'full');
  assert.deepEqual(paths(out), [['c.ts', 'b.ts', 'd.ts', 'a.ts'], ['e.ts']]);
});

const incrementalInput = (): FileContext[] =>
  [ctx('a.ts', { covered: true }), ctx('b.ts', { covered: false }), ctx('c.ts', { covered: true, due: true }), ctx('d.png', { plan: 'rule' }), ctx('e.ts', { covered: true, plan: 'model_whole' })];

test('an incremental review leaves out a file an earlier review covers, unless a thread on it is due', () => {
  const out = filesToSend(incrementalInput(), 'incremental');
  assert.deepEqual(paths(out), [['c.ts', 'b.ts', 'd.png'], ['a.ts', 'e.ts']]);
});

test('a re-check reads the same files as an incremental review', () => {
  assert.deepEqual(paths(filesToSend(incrementalInput(), 'recheck')), paths(filesToSend(incrementalInput(), 'incremental')));
  assert.deepEqual(paths(filesToSend(incrementalInput(), 'recheck')), [['c.ts', 'b.ts', 'd.png'], ['a.ts', 'e.ts']]);
});

test('with no history the order is the order given, in every mode', () => {
  const given = [ctx('z.ts', { thread: false }), ctx('m.ts', { plan: 'model_whole' }), ctx('a.png', { plan: 'rule' }), ctx('b.ts', { thread: false })];
  for (const mode of ['full', 'incremental', 'recheck'] as const) {
    const out = filesToSend(given, mode);
    assert.deepEqual(out.send, given, mode);
    assert.deepEqual(out.leftOut, [], mode);
  }
});

test('a moved file that has no score yet is sent, in every mode', () => {
  for (const mode of ['full', 'incremental', 'recheck'] as const) {
    assert.deepEqual(paths(filesToSend([ctx('m.ts', { covered: false, plan: 'model_whole' })], mode)), [['m.ts'], []], mode);
  }
});
