import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  civilFromDays,
  daysFromCivil,
  daysInMonth,
  etDate,
  etDateFromParts,
  etDateParts,
  isLeapYear,
  type EtDate,
} from '../../../src/kernel/time/et-date.ts';
import type { Result } from '../../../src/kernel/result.ts';

function mustOk<T, E>(r: Result<T, E>): T {
  if (!r.ok) throw new Error(`expected Ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}

function mustEtDate(s: string): EtDate {
  return mustOk(etDate(s));
}

test('etDate 接受真实存在的 YYYY-MM-DD', () => {
  assert.equal(mustEtDate('2026-11-10'), '2026-11-10');
  assert.equal(mustEtDate('2026-11-01'), '2026-11-01');
  assert.equal(mustEtDate('2024-02-29'), '2024-02-29');
});

test('etDate 拒绝形态错误与不存在的日期', () => {
  for (const bad of ['2026-2-3', '2026/11/10', '20261110', '2026-11-10T00:00:00Z', '', 'x']) {
    const r = etDate(bad);
    assert.equal(r.ok, false, `should reject ${JSON.stringify(bad)}`);
    if (!r.ok) assert.equal(r.error.code, 'bad_timestamp');
  }
  for (const bad of ['2026-02-29', '2026-02-30', '2026-13-01', '2026-00-10', '2026-04-31', '0000-01-01']) {
    assert.equal(etDate(bad).ok, false, `should reject ${JSON.stringify(bad)}`);
  }
});

test('daysInMonth / isLeapYear', () => {
  assert.equal(daysInMonth(2026, 2), 28);
  assert.equal(daysInMonth(2024, 2), 29);
  assert.equal(daysInMonth(2000, 2), 29);
  assert.equal(daysInMonth(1900, 2), 28);
  assert.equal(daysInMonth(2026, 4), 30);
  assert.equal(daysInMonth(2026, 12), 31);
  assert.equal(isLeapYear(2024), true);
  assert.equal(isLeapYear(2100), false);
});

test('daysFromCivil / civilFromDays 是逆运算（含 1970 前后）', () => {
  assert.equal(daysFromCivil(1970, 1, 1), 0);
  assert.equal(daysFromCivil(1970, 1, 2), 1);
  assert.equal(daysFromCivil(1969, 12, 31), -1);
  assert.equal(daysFromCivil(2026, 11, 10), 20_767);
  for (const [y, m, d] of [
    [1970, 1, 1],
    [1969, 12, 31],
    [2000, 2, 29],
    [2026, 3, 8],
    [2026, 11, 1],
    [2100, 12, 31],
  ] as const) {
    const back = civilFromDays(daysFromCivil(y, m, d));
    assert.deepEqual(back, { year: y, month: m, day: d });
  }
});

test('etDateParts / etDateFromParts 往返，非法字段抛错', () => {
  const d = mustEtDate('2026-11-10');
  assert.deepEqual(etDateParts(d), { year: 2026, month: 11, day: 10 });
  assert.equal(etDateFromParts(2026, 11, 10), d);
  assert.equal(etDateFromParts(2024, 2, 29), '2024-02-29');
  assert.throws(() => etDateFromParts(2026, 2, 29));
  assert.throws(() => etDateFromParts(2026, 13, 1));
});
