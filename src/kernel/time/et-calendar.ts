/**
 * `EtCalendar`：America/New_York 墙上时间 ↔ 瞬时、日期算术、星期、周边界
 * （`ARCHITECTURE.md` §5.1、§10）。
 *
 * 这是全项目最容易写错的一个类。5 条坑（§5.1）都写进了实现，别改回去：
 *
 * 1. **不能硬编码 `-05:00`。** 所有日期/偏移都经 `Intl.DateTimeFormat`
 *    （`timeZone: 'America/New_York'`）取得；偏移从 `timeZoneName: 'longOffset'`
 *    （`GMT-05:00`）读出。隐藏周可能落在 3 月/11 月的 DST 边界上。
 * 2. **`addDays` 用日历字段加减**（civil-date 天序号），不能用 `epochMs + n*86400_000`：
 *    DST 切换日一天不是 24 小时。
 * 3. **`endOfDay` 必须由「下一天的 `startOfDay`」求出**，不能 `startOfDay + 24h`。
 * 4. 2026 年 ET 的切换日是 3-08（春令时开始，02:00 不存在）与 11-01（冬令时开始，
 *    01:00 重复）；单测显式点名这两个日期。
 * 5. **`startOfDay` 两轮反推**：先假设 UTC 午夜猜一个瞬时，问 Intl 该瞬时的 ET 偏移，
 *    反推；再问一次以处理跨切换的边界（ET 偏移只有两个值，两轮足够）。
 *
 * 本文件不读进程时钟（INV-1）：`Intl` 只用来把**给定瞬时**换算成墙上时间。
 */
import { AppError } from '../errors.ts';
import {
  civilFromDays,
  daysFromCivil,
  etDate,
  etDateFromParts,
  etDateParts,
  type EtDate,
} from './et-date.ts';
import { Instant } from './instant.ts';
import type { Result } from '../result.ts';

const ZONE = 'America/New_York';
const MS_PER_DAY = 86_400_000;

/** 0 = 周日；下标与 `weekdayOf` 的返回值一致。 */
const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/** 墙上时间读数；`offsetMinutes` = ET - UTC（冬令时 -300，夏令时 -240）。 */
interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  offsetMinutes: number;
}

/**
 * 一个格式化器同时取日期字段与偏移：`formatToParts` 比多次调用便宜，
 * 且保证日期字段与偏移出自同一瞬时。
 */
const FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  timeZoneName: 'longOffset',
});

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function pad4(n: number): string {
  return String(n).padStart(4, '0');
}

function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

/** 解析 `longOffset` 的 `GMT-05:00` / `GMT+05:30` / `GMT`。不可识别时返回 null。 */
function parseGmtOffset(value: string): number | null {
  if (value === 'GMT' || value === 'UTC' || value === 'GMT+00:00' || value === 'GMT-00:00') {
    return 0;
  }
  const m = /^GMT([+-])(\d{2}):(\d{2})$/.exec(value);
  if (m === null) return null;
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === '-' ? -minutes : minutes;
}

function wallClockOf(epochMs: number): WallClock {
  const parts = FORMATTER.formatToParts(epochMs);
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let second = 0;
  let offsetMinutes: number | null = null;
  for (const part of parts) {
    switch (part.type) {
      case 'year':
        year = Number(part.value);
        break;
      case 'month':
        month = Number(part.value);
        break;
      case 'day':
        day = Number(part.value);
        break;
      case 'hour':
        hour = Number(part.value);
        break;
      case 'minute':
        minute = Number(part.value);
        break;
      case 'second':
        second = Number(part.value);
        break;
      case 'timeZoneName':
        offsetMinutes = parseGmtOffset(part.value);
        break;
      default:
        break;
    }
  }
  if (offsetMinutes === null) {
    // 退化路径：`timeZoneName` 不可用时用墙上时间反推偏移（整分钟）。
    // 真正的「Intl 退化成 UTC」由 `selfTest()` 在启动时拦下，不靠这里兜底。
    const wallAsUtc = daysFromCivil(year, month, day) * MS_PER_DAY +
      ((hour * 60 + minute) * 60 + second) * 1000;
    offsetMinutes = Math.round((wallAsUtc - Math.floor(epochMs / 1000) * 1000) / 60_000);
  }
  return { year, month, day, hour, minute, second, offsetMinutes };
}

export class EtCalendar {
  static readonly ZONE = ZONE;

  /** 用 Intl 取墙上日期；不看机器时区。 */
  dateOf(t: Instant): EtDate {
    const w = wallClockOf(t.epochMs);
    return etDateFromParts(w.year, w.month, w.day);
  }

  /** 星期几；0 = 周日。 */
  weekdayOf(d: EtDate): 0 | 1 | 2 | 3 | 4 | 5 | 6 {
    const { year, month, day } = etDateParts(d);
    // 1970-01-01 是周四（4）。
    return mod(daysFromCivil(year, month, day) + 4, 7) as 0 | 1 | 2 | 3 | 4 | 5 | 6;
  }

  /** 纯日历字段加减（跨 DST 时一天可能不是 24h，所以绝不做毫秒算术）。 */
  addDays(d: EtDate, n: number): EtDate {
    if (!Number.isInteger(n)) {
      throw new RangeError(`EtCalendar.addDays: n must be an integer, got ${String(n)}`);
    }
    const { year, month, day } = etDateParts(d);
    const target = civilFromDays(daysFromCivil(year, month, day) + n);
    return etDateFromParts(target.year, target.month, target.day);
  }

  /**
   * ET 当天 00:00 的唯一瞬时（两轮反推；ET 的日期边界 00:00 从不落在 DST 跳变上，
   * 但两轮反推对任意墙上时刻都成立，保持不变以便将来复用）。
   */
  startOfDay(d: EtDate): Instant {
    const { year, month, day } = etDateParts(d);
    const wallMidnightAsUtc = daysFromCivil(year, month, day) * MS_PER_DAY;
    // 第 1 轮：用 UTC 午夜的 ET 偏移猜。
    let epochMs = wallMidnightAsUtc - wallClockOf(wallMidnightAsUtc).offsetMinutes * 60_000;
    // 第 2 轮：偏移可能因跨切换而变，用猜出的瞬时再问一次。
    epochMs = wallMidnightAsUtc - wallClockOf(epochMs).offsetMinutes * 60_000;
    return Instant.fromEpochMs(epochMs);
  }

  /** ET 当天结束 = 下一天 00:00（排他），绝不用 `+24h`。 */
  endOfDay(d: EtDate): Instant {
    return this.startOfDay(this.addDays(d, 1));
  }

  /** 不早于 `from` 的最近 `wd`（同一天则返回当天）。 */
  nextOrSameWeekday(from: EtDate, wd: number): EtDate {
    const current = this.weekdayOf(from);
    const target = mod(wd, 7);
    return this.addDays(from, mod(target - current, 7));
  }

  /** 严格晚于 `from` 的最近 `wd`。 */
  nextWeekdayAfter(from: EtDate, wd: number): EtDate {
    const current = this.weekdayOf(from);
    const target = mod(wd, 7);
    const delta = mod(target - current, 7);
    return this.addDays(from, delta === 0 ? 7 : delta);
  }

  /** 自然周的周一（周一起算）：周日回到上一周的周一。 */
  mondayOf(d: EtDate): EtDate {
    const weekday = this.weekdayOf(d); // 0=周日
    const delta = mod(weekday + 6, 7); // 周一 0、周日 6
    return this.addDays(d, -delta);
  }

  /** 严格晚于 `d` 的下一个周一（「the rest of the week」的上界）。 */
  nextMonday(d: EtDate): EtDate {
    return this.nextWeekdayAfter(d, 1);
  }

  /** 以 `anchor` 所在自然周为准的 7 天窗口 `[from, toExclusive)`（WEEK_CALENDAR）。 */
  calendarWeek(anchor: Instant): { from: EtDate; toExclusive: EtDate } {
    const from = this.mondayOf(this.dateOf(anchor));
    return { from, toExclusive: this.addDays(from, 7) };
  }

  /** 规范化输出：`2026-11-10T08:00:00-05:00`（偏移从 Intl 读，永不硬编码）。 */
  iso(t: Instant): string {
    const w = wallClockOf(t.epochMs);
    const sign = w.offsetMinutes < 0 ? '-' : '+';
    const abs = Math.abs(w.offsetMinutes);
    const offset = `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
    return (
      `${pad4(w.year)}-${pad2(w.month)}-${pad2(w.day)}` +
      `T${pad2(w.hour)}:${pad2(w.minute)}:${pad2(w.second)}${offset}`
    );
  }

  /** 给 prompt 用：`"Tuesday 2026-11-10"`。 */
  phrase(t: Instant): string {
    const d = this.dateOf(t);
    return `${WEEKDAY_NAMES[this.weekdayOf(d)]} ${d}`;
  }

  /**
   * 启动自检：断言 `America/New_York` 解析正确（small-icu 会退化成 UTC），失败即抛。
   * 断言点（§5.1、§17.1、§19.4）：
   * - `2026-11-09T06:00:00-05:00` 的 `dateOf` 是 `2026-11-09`，`iso` 原样回来；
   * - 2026-03-08 00:00 是 `-05:00`，2026-11-01 00:00 是 `-04:00`（两个 DST 方向都验到）。
   */
  selfTest(): void {
    const probe = Instant.parse('2026-11-09T06:00:00-05:00');
    if (!probe.ok) {
      throw new Error(`EtCalendar.selfTest: cannot parse probe instant: ${probe.error.message}`);
    }
    const date = this.dateOf(probe.value);
    if (date !== '2026-11-09') {
      throw new Error(
        `EtCalendar.selfTest: Intl degraded (${ZONE} date of 2026-11-09T06:00:00-05:00 is ${date})`,
      );
    }
    const iso = this.iso(probe.value);
    if (iso !== '2026-11-09T06:00:00-05:00') {
      throw new Error(
        `EtCalendar.selfTest: ${ZONE} offset unresolved (expected -05:00, got ${iso})`,
      );
    }
    const springIso = this.iso(this.startOfDay(this.requireEtDate('2026-03-08')));
    if (springIso !== '2026-03-08T00:00:00-05:00') {
      throw new Error(
        `EtCalendar.selfTest: 2026-03-08 should start at -05:00, got ${springIso}`,
      );
    }
    const fallIso = this.iso(this.startOfDay(this.requireEtDate('2026-11-01')));
    if (fallIso !== '2026-11-01T00:00:00-04:00') {
      throw new Error(
        `EtCalendar.selfTest: 2026-11-01 should start at -04:00, got ${fallIso}`,
      );
    }
  }

  /** `selfTest` 内部的字面量日期断言：非法即抛（不可能是业务输入，属实现 bug）。 */
  private requireEtDate(s: string): EtDate {
    const r: Result<EtDate, AppError> = etDate(s);
    if (!r.ok) throw new Error(`EtCalendar.selfTest: bad literal date ${s}: ${r.error.message}`);
    return r.value;
  }
}
