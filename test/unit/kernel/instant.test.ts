import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { Instant } from '../../../src/kernel/time/instant.ts';
import type { Result } from '../../../src/kernel/result.ts';

function mustOk<T, E>(r: Result<T, E>): T {
  if (!r.ok) throw new Error(`expected Ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}

function mustErr<T, E>(r: Result<T, E>): E {
  if (r.ok) throw new Error(`expected Err, got ${JSON.stringify(r.value)}`);
  return r.error;
}

test('parse 接受带偏移的时间串（-05:00 / Z / 小数秒）', () => {
  const et = mustOk(Instant.parse('2026-11-10T08:00:00-05:00'));
  assert.equal(et.epochMs, Date.UTC(2026, 10, 10, 13, 0, 0));
  const z = mustOk(Instant.parse('2026-11-10T13:00:00Z'));
  assert.equal(z.epochMs, et.epochMs);
  assert.equal(z.equals(et), true);

  const summer = mustOk(Instant.parse('2026-07-01T12:00:00-04:00'));
  assert.equal(summer.epochMs, Date.UTC(2026, 6, 1, 16, 0, 0));
  const withMs = mustOk(Instant.parse('2026-11-10T08:00:00.250-05:00'));
  assert.equal(withMs.epochMs, Date.UTC(2026, 10, 10, 13, 0, 0, 250));
});

test('parse 拒绝没有偏移的时间串（bad_timestamp）', () => {
  const e = mustErr(Instant.parse('2026-11-10T08:00:00'));
  assert.equal(e.code, 'bad_timestamp');
  mustErr(Instant.parse('2026-11-10'));
  mustErr(Instant.parse('2026-11-10T08:00:00.5'));
  mustErr(Instant.parse('2026-11-10 08:00'));
});

test('parse 拒绝不存在的日历日与越界字段', () => {
  mustErr(Instant.parse('2026-02-30T00:00:00Z'));
  mustErr(Instant.parse('2026-13-01T00:00:00Z'));
  mustErr(Instant.parse('2026-00-01T00:00:00Z'));
  mustErr(Instant.parse('2026-01-01T24:00:00Z'));
  mustErr(Instant.parse('2026-01-01T00:60:00Z'));
  mustErr(Instant.parse('2026-01-01T00:00:60Z'));
  mustErr(Instant.parse('2026-01-01T00:00:00+24:00'));
  mustErr(Instant.parse('not a timestamp'));
});

test('compare / equals / isBefore / isBeforeOrEqual', () => {
  const a = mustOk(Instant.parse('2026-11-09T06:00:00-05:00'));
  const b = mustOk(Instant.parse('2026-11-09T06:00:01-05:00'));
  const a2 = mustOk(Instant.parse('2026-11-09T11:00:00Z'));
  assert.equal(a.compare(b), -1);
  assert.equal(b.compare(a), 1);
  assert.equal(a.compare(a2), 0);
  assert.equal(a.isBefore(b), true);
  assert.equal(a.isBefore(a2), false);
  assert.equal(a.isBeforeOrEqual(a2), true);
  assert.equal(b.isBeforeOrEqual(a), false);
  assert.equal(a.equals(a2), true);
});

test('fromEpochMs 与 parse 互逆；toISOString 是 UTC 形式', () => {
  const t = mustOk(Instant.parse('2026-11-10T08:30:00-05:00'));
  const round = Instant.fromEpochMs(t.epochMs);
  assert.equal(round.epochMs, t.epochMs);
  assert.equal(round.toISOString(), '2026-11-10T13:30:00.000Z');
  const parsedBack = mustOk(Instant.parse(round.toISOString()));
  assert.equal(parsedBack.epochMs, t.epochMs);
  assert.equal(parsedBack.source, '2026-11-10T13:30:00.000Z');
});

test('source 保留原始输入串（排查用）', () => {
  const t = mustOk(Instant.parse('2026-11-10T08:00:00-05:00'));
  assert.equal(t.source, '2026-11-10T08:00:00-05:00');
});
