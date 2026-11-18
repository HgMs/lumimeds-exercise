import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { Deadline, DeadlineExceededError } from '../../../src/kernel/deadline.ts';
import { Instant } from '../../../src/kernel/time/instant.ts';
import type { Result } from '../../../src/kernel/result.ts';

function mustOk<T, E>(r: Result<T, E>): T {
  if (!r.ok) throw new Error(`expected Ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}

const at = mustOk(Instant.parse('2026-11-09T06:00:00-05:00'));

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('remainingMs 在 (0, budget] 内且随真实时间递减', async () => {
  const d = Deadline.after(at, 500);
  const first = d.remainingMs();
  assert.ok(first > 0 && first <= 500, `first=${first}`);
  assert.equal(d.expired(), false);
  await sleep(20);
  assert.ok(d.remainingMs() < first);
});

test('allocate = min(希望值, 剩余 - reserve)，下限 0', async () => {
  const d = Deadline.after(at, 400);
  assert.equal(d.allocate(50), 50);
  assert.equal(d.allocate(10_000) <= 400, true);
  assert.equal(d.allocate(10_000, 10_000), 0, 'reserve 吃光预算时返回 0');
  assert.equal(d.allocate(0), 0);
  await sleep(10);
  const left = d.remainingMs();
  const allocated = d.allocate(10_000);
  assert.ok(allocated <= left && allocated >= 0);
});

test('预算耗尽：expired、remainingMs=0、allocate=0、signal aborted', async () => {
  const d = Deadline.after(at, 15);
  assert.equal(d.signal().aborted, false);
  await sleep(45);
  assert.equal(d.expired(), true);
  assert.equal(d.remainingMs(), 0);
  assert.equal(d.allocate(1000), 0);
  assert.equal(d.signal().aborted, true);
  assert.equal(d.signal().reason instanceof DeadlineExceededError, true);
});

test('零预算创建即过期（不是负数预算）', () => {
  const d = Deadline.after(at, 0);
  assert.equal(d.budgetMs, 0);
  assert.equal(d.expired(), true);
  assert.equal(d.signal().aborted, true);
});

test('startedAt 只用于日志：原样保留业务时刻', () => {
  const d = Deadline.after(at, 100);
  assert.equal(d.startedAt, at);
});
