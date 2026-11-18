/**
 * `PhraseParser` 单测（`ARCHITECTURE.md` §5.8 短语表、`REQUIREMENTS.md` §4.4、
 * `WALKTHROUGHS.md` W1/W3/W13）。
 *
 * 表驱动：每条封闭短语断言**绝对** ET ISO 值，另加组合短语、整串锚定、大小写、
 * 只吃 `at` 的纯函数性。周一是 2026-11-09（EST，-05:00）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PhraseParser } from '../../src/domain/email/phrase-parser.ts';
import type { PhraseDate, PhraseTemporal } from '../../src/domain/email/phrase-parser.ts';
import { calendar, instant, phrases } from './email-fixtures.ts';

/** 周一 07:05 收到——week A 的第一封邮件时刻。 */
const MONDAY_0705 = instant('2026-11-09T07:05:00-05:00');
/** 周二 11:00 收到——evt_027 的时刻。 */
const TUESDAY_1100 = instant('2026-11-10T11:00:00-05:00');
/** 周二 08:00 收到——evt_020 的时刻。 */
const TUESDAY_0800 = instant('2026-11-10T08:00:00-05:00');

/** 把 PhraseDate 化成绝对 ISO；day 粒度按 startOfDay 折算（与验证器一致）。 */
function isoOf(field: PhraseDate | undefined): string | null {
  if (field === undefined) return null;
  const instantValue = field.instant ?? calendar.startOfDay(field.date);
  return calendar.iso(instantValue);
}

function fromIso(parsed: PhraseTemporal | null): string | null {
  return parsed === null ? null : isoOf(parsed.from);
}

function untilIso(parsed: PhraseTemporal | null): string | null {
  return parsed === null ? null : isoOf(parsed.until);
}

describe('PhraseParser：封闭短语表（10 条，断言绝对时间）', () => {
  it('(effective) immediately → from = at（瞬时刻），until 缺省', () => {
    for (const phrase of ['immediately', 'effective immediately', 'Effective Immediately.', 'immediately please']) {
      const parsed = phrases.parse(phrase, MONDAY_0705);
      assert.ok(parsed !== null, `${phrase} 应命中`);
      assert.equal(fromIso(parsed), '2026-11-09T07:05:00-05:00', phrase);
      assert.equal(parsed?.from?.kind, 'instant', phrase);
      assert.equal(parsed?.until, undefined, phrase);
      assert.deepEqual(parsed?.rules, ['immediately'], phrase);
    }
  });

  it('today → [今天 00:00, 明天 00:00)', () => {
    const parsed = phrases.parse('today', MONDAY_0705);
    assert.equal(fromIso(parsed), '2026-11-09T00:00:00-05:00');
    assert.equal(untilIso(parsed), '2026-11-10T00:00:00-05:00');
    assert.deepEqual(parsed?.rules, ['today']);
  });

  it('tomorrow → [明天 00:00, 后天 00:00)（W1：落地为 00:00 的瞬时刻）', () => {
    const parsed = phrases.parse('tomorrow', MONDAY_0705);
    assert.equal(fromIso(parsed), '2026-11-10T00:00:00-05:00');
    assert.equal(untilIso(parsed), '2026-11-11T00:00:00-05:00');
    assert.deepEqual(parsed?.rules, ['tomorrow']);
  });

  it('yesterday → [昨天 00:00, 今天 00:00)', () => {
    const parsed = phrases.parse('yesterday', MONDAY_0705);
    assert.equal(fromIso(parsed), '2026-11-08T00:00:00-05:00');
    assert.equal(untilIso(parsed), '2026-11-09T00:00:00-05:00');
  });

  it('Wednesday / on Wednesday → from = 该日 00:00，until 缺省', () => {
    for (const phrase of ['Wednesday', 'on Wednesday', 'WEDNESDAY']) {
      const parsed = phrases.parse(phrase, MONDAY_0705);
      assert.equal(fromIso(parsed), '2026-11-11T00:00:00-05:00', phrase);
      assert.equal(parsed?.until, undefined, phrase);
      assert.deepEqual(parsed?.rules, ['weekday'], phrase);
    }
  });

  it('next Wednesday → 严格晚于 at 的该星期（Q8）', () => {
    // 周一收到：本周三是严格晚于 at 的最近一个周三。
    assert.equal(fromIso(phrases.parse('next Wednesday', MONDAY_0705)), '2026-11-11T00:00:00-05:00');
    // 周三当天收到：必须跳到下周三。
    const wednesday = instant('2026-11-11T09:00:00-05:00');
    assert.equal(fromIso(phrases.parse('next Wednesday', wednesday)), '2026-11-18T00:00:00-05:00');
    assert.deepEqual(phrases.parse('next Wednesday', wednesday)?.rules, ['next_weekday']);
  });

  it('the rest of the week / end of week → from = at，until = 下周一 00:00', () => {
    for (const phrase of [
      'the rest of the week',
      'end of week',
      'end of the week',
      'for the rest of the week',
    ]) {
      const parsed = phrases.parse(phrase, MONDAY_0705);
      assert.equal(fromIso(parsed), '2026-11-09T07:05:00-05:00', phrase);
      assert.equal(untilIso(parsed), '2026-11-16T00:00:00-05:00', phrase);
      assert.deepEqual(parsed?.rules, ['end_of_week'], phrase);
    }
  });

  it('until Wednesday → until = 该日 00:00（排他）；from 由验证器缺省成 at', () => {
    const parsed = phrases.parse('until Wednesday', MONDAY_0705);
    assert.equal(fromIso(parsed), null, '解析器只报告它实际解析出的字段');
    assert.equal(untilIso(parsed), '2026-11-11T00:00:00-05:00');
    assert.deepEqual(parsed?.rules, ['until_weekday']);
  });

  it('until Monday：周二收到取下一个周一；周一收到取当天（W13 由验证器翻到下周）', () => {
    assert.equal(untilIso(phrases.parse('until Monday', TUESDAY_0800)), '2026-11-16T00:00:00-05:00');
    assert.equal(untilIso(phrases.parse('until Monday', MONDAY_0705)), '2026-11-09T00:00:00-05:00');
  });

  it('from Wednesday → from = 该日 00:00，until 缺省（开放式)', () => {
    const parsed = phrases.parse('from Wednesday', MONDAY_0705);
    assert.equal(fromIso(parsed), '2026-11-11T00:00:00-05:00');
    assert.equal(parsed?.until, undefined);
    assert.deepEqual(parsed?.rules, ['from_weekday']);
  });

  it('back on Wednesday → 只给 until = 该日 00:00（T2）', () => {
    const parsed = phrases.parse('back on Wednesday', MONDAY_0705);
    assert.equal(fromIso(parsed), null);
    assert.equal(untilIso(parsed), '2026-11-11T00:00:00-05:00');
    assert.deepEqual(parsed?.rules, ['back_on_weekday']);
  });
});

describe('PhraseParser：组合子句（W3）', () => {
  it('"from tomorrow ... for the rest of the week" → [11-11 00:00, 11-16 00:00)（T13/evt_027）', () => {
    const parsed = phrases.parse('from tomorrow ... for the rest of the week', TUESDAY_1100);
    assert.ok(parsed !== null);
    assert.equal(fromIso(parsed), '2026-11-11T00:00:00-05:00');
    assert.equal(untilIso(parsed), '2026-11-16T00:00:00-05:00');
    assert.deepEqual(parsed?.rules, ['tomorrow', 'end_of_week']);
  });

  it('"from Wednesday until Friday" → 两个子句各给一个字段', () => {
    const parsed = phrases.parse('from Wednesday until Friday', MONDAY_0705);
    assert.equal(fromIso(parsed), '2026-11-11T00:00:00-05:00');
    assert.equal(untilIso(parsed), '2026-11-13T00:00:00-05:00');
    assert.deepEqual(parsed?.rules, ['from_weekday', 'until_weekday']);
  });

  it('"from tomorrow" 单独出现只给 from（区间开放式，不是整天）', () => {
    const parsed = phrases.parse('from tomorrow', TUESDAY_1100);
    assert.equal(fromIso(parsed), '2026-11-11T00:00:00-05:00');
    assert.equal(parsed?.until, undefined);
    assert.deepEqual(parsed?.rules, ['tomorrow']);
  });
});

describe('PhraseParser：锚定整串、不猜测', () => {
  const parser = new PhraseParser(calendar);

  it('认不出 / 部分认不出 / 空串 / null 一律返回 null', () => {
    for (const phrase of [
      'sometime soon',
      'asap',
      'urgent',
      'Wednesday or Thursday',
      'tomorrow at 2pm',
      'until further notice',
      'by end of day',
      '',
      '   ',
      null,
      undefined,
    ]) {
      assert.equal(parser.parse(phrase, MONDAY_0705), null, `"${String(phrase)}" 应返回 null`);
    }
  });

  it('非字符串输入不抛异常', () => {
    assert.equal(parser.parse(7 as unknown as string, MONDAY_0705), null);
    assert.equal(parser.parse({} as unknown as string, MONDAY_0705), null);
  });

  it('纯函数：只吃 at，不读进程时钟；同一输入两次结果一致', () => {
    const first = parser.parse('tomorrow', MONDAY_0705);
    const second = parser.parse('tomorrow', MONDAY_0705);
    assert.deepEqual(first, second);
    // 换一个 at，相对日期整体平移。
    const later = parser.parse('tomorrow', instant('2026-11-12T12:00:00-05:00'));
    assert.equal(fromIso(later), '2026-11-13T00:00:00-05:00');
  });
});
