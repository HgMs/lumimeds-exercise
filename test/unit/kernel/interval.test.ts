import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { Instant } from '../../../src/kernel/time/instant.ts';
import { Interval } from '../../../src/kernel/time/interval.ts';
import type { Result } from '../../../src/kernel/result.ts';

function mustOk<T, E>(r: Result<T, E>): T {
  if (!r.ok) throw new Error(`expected Ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}

function mustErr<T, E>(r: Result<T, E>): E {
  if (r.ok) throw new Error(`expected Err, got ${JSON.stringify(r.value)}`);
  return r.error;
}

function at(iso: string): Instant {
  return mustOk(Instant.parse(iso));
}

test('of 要求 until 严格晚于 from', () => {
  const from = at('2026-11-09T07:05:00-05:00');
  const until = at('2026-11-11T00:00:00-05:00');
  assert.equal(Interval.of(from, until).ok, true);
  assert.equal(Interval.of(from, null).ok, true);
  assert.equal(mustErr(Interval.of(from, from)).code, 'bad_interval');
  assert.equal(mustErr(Interval.of(until, from)).code, 'bad_interval');
});

test('covers 是 [from, until)：from 含、until 不含', () => {
  const from = at('2026-11-09T07:05:00-05:00');
  const until = at('2026-11-11T00:00:00-05:00');
  const interval = mustOk(Interval.of(from, until));
  assert.equal(interval.covers(from), true, '左端闭');
  assert.equal(interval.covers(until), false, '右端开（until 一律排他）');
  assert.equal(interval.covers(at('2026-11-10T12:00:00-05:00')), true);
  assert.equal(interval.covers(at('2026-11-09T07:04:59-05:00')), false);
});

test('until === null 表示一直有效', () => {
  const from = at('2026-11-09T07:40:00-05:00');
  const interval = mustOk(Interval.of(from, null));
  assert.equal(interval.until, null);
  assert.equal(interval.covers(at('2026-11-09T07:39:59-05:00')), false);
  assert.equal(interval.covers(at('2099-01-01T00:00:00Z')), true);
});

test('「until Wednesday」= startOfDay(周三)：周二 23:59:59 仍覆盖', () => {
  const from = at('2026-11-09T07:05:00-05:00');
  const untilWednesday = at('2026-11-11T00:00:00-05:00');
  const interval = mustOk(Interval.of(from, untilWednesday));
  assert.equal(interval.covers(at('2026-11-10T23:59:59-05:00')), true);
  assert.equal(interval.covers(at('2026-11-11T00:00:00-05:00')), false);
});
