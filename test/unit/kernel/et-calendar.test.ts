import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { EtCalendar } from '../../../src/kernel/time/et-calendar.ts';
import { etDate, type EtDate } from '../../../src/kernel/time/et-date.ts';
import { Instant } from '../../../src/kernel/time/instant.ts';
import type { Result } from '../../../src/kernel/result.ts';

function mustOk<T, E>(r: Result<T, E>): T {
  if (!r.ok) throw new Error(`expected Ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}

function at(iso: string): Instant {
  return mustOk(Instant.parse(iso));
}

function day(s: string): EtDate {
  return mustOk(etDate(s));
}

const cal = new EtCalendar();
const HOUR = 3_600_000;

test('ZONE 是 America/New_York', () => {
  assert.equal(EtCalendar.ZONE, 'America/New_York');
});

test('dateOf 用 ET 墙上日期，不看机器时区', () => {
  assert.equal(cal.dateOf(at('2026-11-09T06:00:00-05:00')), '2026-11-09');
  // ET 的日期边界 = 05:00Z（冬令时）：04:59:59Z 还是 11-09，05:00Z 变 11-10。
  assert.equal(cal.dateOf(at('2026-11-10T04:59:59Z')), '2026-11-09');
  assert.equal(cal.dateOf(at('2026-11-10T05:00:00Z')), '2026-11-10');
  // 夏令时边界同理（-04:00）：07-01T03:59:59Z = 06-30 23:59:59 ET。
  assert.equal(cal.dateOf(at('2026-07-01T03:59:59Z')), '2026-06-30');
  assert.equal(cal.dateOf(at('2026-07-01T04:00:00Z')), '2026-07-01');
});

test('weekdayOf：0=周日；2026-11-08 周日、11-09 周一、11-10 周二', () => {
  assert.equal(cal.weekdayOf(day('2026-11-08')), 0);
  assert.equal(cal.weekdayOf(day('2026-11-09')), 1);
  assert.equal(cal.weekdayOf(day('2026-11-10')), 2);
  assert.equal(cal.weekdayOf(day('2026-11-14')), 6);
  assert.equal(cal.weekdayOf(day('2026-03-08')), 0, '2026-03-08 是周日');
  assert.equal(cal.weekdayOf(day('2026-11-01')), 0, '2026-11-01 是周日');
});

test('addDays 用日历字段：跨月/跨年/闰日/跨 DST 都正确', () => {
  assert.equal(cal.addDays(day('2026-11-09'), 1), '2026-11-10');
  assert.equal(cal.addDays(day('2026-03-08'), 1), '2026-03-09');
  assert.equal(cal.addDays(day('2026-11-01'), 1), '2026-11-02');
  assert.equal(cal.addDays(day('2026-12-31'), 1), '2027-01-01');
  assert.equal(cal.addDays(day('2028-02-28'), 1), '2028-02-29');
  assert.equal(cal.addDays(day('2026-11-09'), -7), '2026-11-02');
  assert.equal(cal.addDays(day('2026-01-01'), -1), '2025-12-31');
  // 跨 DST 加 1 天仍是「日历上的下一天」，不是 +24h。
  assert.equal(cal.addDays(day('2026-03-07'), 1), '2026-03-08');
  assert.equal(cal.addDays(day('2026-10-31'), 1), '2026-11-01');
});

test('startOfDay / endOfDay：2026-03-08（春令时开始）', () => {
  const d = day('2026-03-08');
  const start = cal.startOfDay(d);
  // 03-08 00:00 ET = 05:00Z（还是 EST）
  assert.equal(start.epochMs, Date.UTC(2026, 2, 8, 5, 0, 0));
  assert.equal(cal.iso(start), '2026-03-08T00:00:00-05:00');

  const end = cal.endOfDay(d);
  // 03-09 00:00 ET = 04:00Z（已切到 EDT）
  assert.equal(end.epochMs, Date.UTC(2026, 2, 9, 4, 0, 0));
  assert.equal(cal.iso(end), '2026-03-09T00:00:00-04:00');
  assert.equal(end.equals(cal.startOfDay(cal.addDays(d, 1))), true, 'endOfDay = 下一天 startOfDay');

  // 春令时开始这天只有 23 小时。
  assert.equal(end.epochMs - start.epochMs, 23 * HOUR);
  // 3-07 → 3-08 是正常的 24 小时（别记错一天）。
  assert.equal(
    cal.startOfDay(day('2026-03-08')).epochMs - cal.startOfDay(day('2026-03-07')).epochMs,
    24 * HOUR,
  );
  // 3-08 → 3-09 也是 23 小时（切换发生在 02:00）。
  assert.equal(
    cal.startOfDay(day('2026-03-09')).epochMs - cal.startOfDay(day('2026-03-08')).epochMs,
    23 * HOUR,
  );
});

test('startOfDay / endOfDay：2026-11-01（冬令时开始）', () => {
  const d = day('2026-11-01');
  const start = cal.startOfDay(d);
  // 11-01 00:00 ET = 04:00Z（还是 EDT）
  assert.equal(start.epochMs, Date.UTC(2026, 10, 1, 4, 0, 0));
  assert.equal(cal.iso(start), '2026-11-01T00:00:00-04:00');

  const end = cal.endOfDay(d);
  // 11-02 00:00 ET = 05:00Z（已切到 EST）
  assert.equal(end.epochMs, Date.UTC(2026, 10, 2, 5, 0, 0));
  assert.equal(cal.iso(end), '2026-11-02T00:00:00-05:00');
  assert.equal(end.equals(cal.startOfDay(cal.addDays(d, 1))), true);

  // 冬令时开始这天有 25 小时。
  assert.equal(end.epochMs - start.epochMs, 25 * HOUR);
  assert.equal(
    cal.startOfDay(day('2026-11-02')).epochMs - cal.startOfDay(day('2026-11-01')).epochMs,
    25 * HOUR,
  );
  // 10-31 → 11-01 是正常的 24 小时（两地都是 EDT 午夜；切换发生在 11-01 02:00）。
  assert.equal(
    cal.startOfDay(day('2026-11-01')).epochMs - cal.startOfDay(day('2026-10-31')).epochMs,
    24 * HOUR,
  );
});

test('startOfDay 是当天的 00:00（含冬令时常态日）', () => {
  assert.equal(cal.iso(cal.startOfDay(day('2026-11-09'))), '2026-11-09T00:00:00-05:00');
  assert.equal(cal.iso(cal.startOfDay(day('2026-07-01'))), '2026-07-01T00:00:00-04:00');
  assert.equal(cal.startOfDay(day('2026-11-09')).epochMs, Date.UTC(2026, 10, 9, 5, 0, 0));
  // 同一日期反复求值稳定。
  assert.equal(cal.startOfDay(day('2026-11-01')).epochMs, cal.startOfDay(day('2026-11-01')).epochMs);
});

test('nextOrSameWeekday / nextWeekdayAfter', () => {
  const tue = day('2026-11-10');
  assert.equal(cal.nextOrSameWeekday(tue, 2), '2026-11-10');
  assert.equal(cal.nextWeekdayAfter(tue, 2), '2026-11-17');
  assert.equal(cal.nextOrSameWeekday(tue, 1), '2026-11-16');
  assert.equal(cal.nextWeekdayAfter(tue, 0), '2026-11-15');
  assert.equal(cal.nextOrSameWeekday(tue, 0), '2026-11-15');
});

test('mondayOf 周一起算；nextMonday 严格晚于', () => {
  assert.equal(cal.mondayOf(day('2026-11-09')), '2026-11-09');
  assert.equal(cal.mondayOf(day('2026-11-10')), '2026-11-09');
  assert.equal(cal.mondayOf(day('2026-11-15')), '2026-11-09', '周日属于本周');
  assert.equal(cal.mondayOf(day('2026-11-08')), '2026-11-02', '周日回到上一周的周一');
  assert.equal(cal.mondayOf(day('2026-03-08')), '2026-03-02', 'DST 周日也回上一周周一');

  assert.equal(cal.nextMonday(day('2026-11-09')), '2026-11-16', '周一的下一周一是下周一');
  assert.equal(cal.nextMonday(day('2026-11-10')), '2026-11-16');
  assert.equal(cal.nextMonday(day('2026-11-15')), '2026-11-16');
  assert.equal(cal.nextMonday(day('2026-10-31')), '2026-11-02', '跨 DST 也按日下一天');
});

test('calendarWeek：周一开始的 7 天窗口', () => {
  const mon = cal.calendarWeek(at('2026-11-09T06:00:00-05:00'));
  assert.deepEqual(mon, { from: '2026-11-09', toExclusive: '2026-11-16' });
  // 周日 23:00 仍属于上一个自然周。
  const sunday = cal.calendarWeek(at('2026-11-08T23:00:00-05:00'));
  assert.deepEqual(sunday, { from: '2026-11-02', toExclusive: '2026-11-09' });
  // 跨 DST 的一周还是 7 个 ET 日期。
  const dstWeek = cal.calendarWeek(at('2026-03-08T06:00:00-05:00'));
  assert.deepEqual(dstWeek, { from: '2026-03-02', toExclusive: '2026-03-09' });
});

test('iso 输出带 ET 偏移（-05:00 / -04:00，永不硬编码）', () => {
  assert.equal(cal.iso(at('2026-11-09T06:00:00-05:00')), '2026-11-09T06:00:00-05:00');
  assert.equal(cal.iso(at('2026-11-09T06:00:00Z')), '2026-11-09T01:00:00-05:00');
  assert.equal(cal.iso(at('2026-07-01T12:00:00-04:00')), '2026-07-01T12:00:00-04:00');
  // 冬令时重复的 01:00–02:00：同一墙上时间有不同瞬时，偏移必须跟着瞬时走。
  assert.equal(cal.iso(at('2026-11-01T05:30:00Z')), '2026-11-01T01:30:00-04:00');
  assert.equal(cal.iso(at('2026-11-01T06:30:00Z')), '2026-11-01T01:30:00-05:00');
  // 春令时不存在的 02:30：不存在，但相邻瞬时仍要正确。
  assert.equal(cal.iso(at('2026-03-08T06:59:59Z')), '2026-03-08T01:59:59-05:00');
  assert.equal(cal.iso(at('2026-03-08T07:00:00Z')), '2026-03-08T03:00:00-04:00');
});

test('iso / dateOf 往返：每个输出都能被 Instant.parse 接回去', () => {
  for (const iso of [
    '2026-11-09T06:00:00-05:00',
    '2026-11-10T08:00:00-05:00',
    '2026-03-08T01:59:59-05:00',
    '2026-11-01T01:30:00-04:00',
    '2026-11-01T01:30:00-05:00',
  ]) {
    const t = at(iso);
    const printed = cal.iso(t);
    assert.equal(printed, iso);
    assert.equal(at(printed).epochMs, t.epochMs);
    assert.equal(cal.iso(at(printed)), printed);
  }
});

test('phrase 给 "Tuesday 2026-11-10" 形式', () => {
  assert.equal(cal.phrase(at('2026-11-10T10:00:00-05:00')), 'Tuesday 2026-11-10');
  assert.equal(cal.phrase(at('2026-11-09T06:00:00-05:00')), 'Monday 2026-11-09');
  assert.equal(cal.phrase(at('2026-11-08T23:59:59-05:00')), 'Sunday 2026-11-08');
  // prompt 的 WEEK_CALENDAR 用 7 天的 phrase：日期不错位。
  const week = cal.calendarWeek(at('2026-11-09T06:00:00-05:00'));
  const phrases: string[] = [];
  let d = week.from;
  for (let i = 0; i < 7; i += 1) {
    phrases.push(cal.phrase(cal.startOfDay(d)));
    d = cal.addDays(d, 1);
  }
  assert.deepEqual(phrases, [
    'Monday 2026-11-09',
    'Tuesday 2026-11-10',
    'Wednesday 2026-11-11',
    'Thursday 2026-11-12',
    'Friday 2026-11-13',
    'Saturday 2026-11-14',
    'Sunday 2026-11-15',
  ]);
});

test('selfTest 在正常 ICU 上通过（否则启动就该失败）', () => {
  assert.doesNotThrow(() => new EtCalendar().selfTest());
});
