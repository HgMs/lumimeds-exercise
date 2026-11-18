import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { IdSequence } from '../../../src/kernel/ids.ts';

test('next 输出 prefix_NNNN 并从 0001 起', () => {
  const ids = new IdSequence();
  assert.equal(ids.next('fact'), 'fact_0001');
  assert.equal(ids.next('fact'), 'fact_0002');
  assert.equal(ids.next('decision'), 'decision_0001');
  assert.equal(ids.next('sam'), 'sam_0001');
});

test('快照里的计数被接续：{fact:27} → fact_0028', () => {
  const ids = new IdSequence({ fact: 27 });
  assert.equal(ids.next('fact'), 'fact_0028');
  assert.equal(ids.next('fact'), 'fact_0029');
});

test('snapshot / restore 往返一致，且互不共享状态', () => {
  const ids = new IdSequence();
  ids.next('fact');
  ids.next('fact');
  ids.next('decision');
  const snap = ids.snapshot();
  assert.deepEqual(snap, { fact: 2, decision: 1 });

  const restored = IdSequence.restore(snap);
  assert.equal(restored.next('fact'), 'fact_0003');
  // 修改快照对象不影响 restored；restored 也不影响快照。
  snap['fact'] = 100;
  assert.equal(restored.next('fact'), 'fact_0004');
  assert.equal(ids.next('fact'), 'fact_0003');
});

test('reset 供 simulation.started 开新周：编号回 fact_0001', () => {
  const ids = new IdSequence();
  ids.next('fact');
  ids.next('decision');
  ids.reset();
  assert.deepEqual(ids.snapshot(), {});
  assert.equal(ids.next('fact'), 'fact_0001');
  assert.equal(ids.next('decision'), 'decision_0001');
});

test('超过 9999 时自然变长（不截断）', () => {
  const ids = new IdSequence({ fact: 9999 });
  assert.equal(ids.next('fact'), 'fact_10000');
});
