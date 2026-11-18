/**
 * `EtDate`：ET（America/New_York）业务日期，形态 `"2026-11-10"`（`ARCHITECTURE.md` §5.1、§10）。
 *
 * 为什么用 branded string：`EtDate` 是业务日期（容量、星期、周窗口、`until` 边界都用它），
 * 不允许和任意字符串混用；构造必须过 `etDate()` 校验（真实存在的日历日）。
 *
 * 实现说明：只 import 类型/`AppError`，不读进程时钟。日历日 ↔ 天序号的换算用
 * civil-date 算法（Howard Hinnant 的 `days_from_civil`/`civil_from_days`），
 * 不用 `Date`，因此不受机器时区与 DST 影响；`et-calendar.ts` 与 `instant.ts`
 * 共用这里的换算（单一来源）。
 */
import { AppError } from '../errors.ts';
import type { Result } from '../result.ts';

declare const etDateBrand: unique symbol;

/** ET 业务日期（YYYY-MM-DD）。只能由 `etDate()` 或内部换算构造。 */
export type EtDate = string & { readonly [etDateBrand]: 'EtDate' };

const ET_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function pad4(n: number): string {
  return String(n).padStart(4, '0');
}

/** 是否闰年（公历）。 */
export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** 某年某月的天数（1-based 月份）。 */
export function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 2:
      return isLeapYear(year) ? 29 : 28;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return 31;
  }
}

/**
 * 公历日期 → 距 1970-01-01 的天数（可为负）。
 * 对非法日期（如 2026-02-30）会得到「溢出到下个月」的结果，调用方要用
 * `civilFromDays(daysFromCivil(...))` 往返校验。
 */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400; // [0, 399]
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1; // [0, 365]
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy; // [0, 146096]
  return era * 146097 + doe - 719468;
}

/** 距 1970-01-01 的天数 → 公历日期。`daysFromCivil` 的逆运算。 */
export function civilFromDays(days: number): { year: number; month: number; day: number } {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097; // [0, 146096]
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)); // [0, 365]
  const mp = Math.floor((5 * doy + 2) / 153); // [0, 11]
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1; // [1, 31]
  const month = mp + (mp < 10 ? 3 : -9); // [1, 12]
  return { year: y + (month <= 2 ? 1 : 0), month, day };
}

/** 拆分一个已经合法的 `EtDate`；违反 brand 不变量时抛（内部错误，不是业务失败）。 */
export function etDateParts(d: EtDate): { year: number; month: number; day: number } {
  const m = ET_DATE_RE.exec(d);
  if (m === null) {
    throw new Error(`EtDate invariant violated: ${JSON.stringify(d)}`);
  }
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/**
 * 由公历字段组装 `EtDate`。
 * 只给内部换算用（`addDays` 等），仍会做范围校验；业务输入请走 `etDate()` 拿 `Result`。
 */
export function etDateFromParts(year: number, month: number, day: number): EtDate {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month)
  ) {
    throw new Error(`invalid calendar date: ${year}-${pad2(month)}-${pad2(day)}`);
  }
  return `${pad4(year)}-${pad2(month)}-${pad2(day)}` as EtDate;
}

/**
 * 构造并校验一个 `EtDate`：形态必须是 `YYYY-MM-DD`，且是真实存在的日历日
 * （`2026-02-30`、`2026-13-01`、`0000-01-01` 都拒绝）。
 */
export function etDate(s: string): Result<EtDate, AppError> {
  if (typeof s !== 'string') {
    return {
      ok: false,
      error: new AppError('bad_timestamp', 'ET date must be a string', { value: s }),
    };
  }
  const m = ET_DATE_RE.exec(s);
  if (m === null) {
    return {
      ok: false,
      error: new AppError(
        'bad_timestamp',
        `not an ET date (expected YYYY-MM-DD): ${JSON.stringify(s)}`,
        { value: s },
      ),
    };
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const valid =
    year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
  if (!valid) {
    return {
      ok: false,
      error: new AppError(
        'bad_timestamp',
        `not a real calendar date: ${JSON.stringify(s)}`,
        { value: s },
      ),
    };
  }
  return { ok: true, value: s as EtDate };
}
