import assert from 'node:assert/strict';
import test from 'node:test';

import type { Range } from '../context/diff.ts';
import type { Finding, Severity } from '../types.ts';
import { reconcileMode } from './mode.ts';

const f = (severity: Severity, line: number): Finding => ({
  path: 'src/a.ts', side: 'RIGHT', line, severity, body: 'Wrong value.', quote: '', requestedLine: null,
});

test('on a line unchanged since the file was last read a blocker is kept, a major is listed and a minor is dropped', () => {
  const changedOf = () => ({ all: false, right: [[10, 12]] as Range[], leftBlocks: [] });
  const out = reconcileMode([f('blocker', 3), f('major', 4), f('minor', 5), f('major', 11), f('minor', 12)], changedOf, () => []);
  assert.deepEqual([out.kept.map((x) => [x.severity, x.line]), out.unchanged.map((x) => x.line), out.audit.map((a) => [a.subject, a.reason])],
    [[['blocker', 3], ['major', 11], ['minor', 12]], [4], [['src/a.ts:5', 'unchanged_line']]]);
  assert.deepEqual(out.audit, [{ stage: 'reconcile', action: 'dropped', subject: 'src/a.ts:5', reason: 'unchanged_line' }]);
});

test('a file that is new to the reviewer, and a file with nothing said about it, keep every finding', async (t) => {
  const findings = [f('blocker', 3), f('major', 4), f('minor', 5)];
  await t.test('a file new to the reviewer', () => {
    const out = reconcileMode(findings, () => ({ all: true, right: [], leftBlocks: [] }), () => []);
    assert.deepEqual([out.kept, out.unchanged, out.audit], [findings, [], []]);
  });
  await t.test('a file with nothing said about it', () => {
    const out = reconcileMode(findings, () => null, () => []);
    assert.deepEqual([out.kept, out.unchanged, out.audit], [findings, [], []]);
  });
});

test('a finding placed on an unchanged line is judged by the line the model named too', async (t) => {
  const changedOf = () => ({ all: false, right: [[9, 9]] as Range[], leftBlocks: [] });
  const moved = (severity: Severity, requestedLine: number): Finding => ({ ...f(severity, 6), requestedLine });
  await t.test('a major and a minor whose requested line changed are kept', () => {
    const out = reconcileMode([moved('major', 9), moved('minor', 9)], changedOf, () => []);
    assert.deepEqual([out.kept.map((x) => x.severity), out.unchanged, out.audit], [['major', 'minor'], [], []]);
  });
  await t.test('with a requested line that did not change the major is listed and the minor dropped', () => {
    const out = reconcileMode([moved('major', 8), moved('minor', 8)], changedOf, () => []);
    assert.deepEqual([out.kept, out.unchanged.map((x) => x.severity), out.audit.map((a) => a.reason)], [[], ['major'], ['unchanged_line']]);
  });
});
