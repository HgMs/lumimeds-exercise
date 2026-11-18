/**
 * `Instant`：唯一的时间容器（`ARCHITECTURE.md` §5.1、§10）。
 *
 * - 业务时间只以 `Instant` 出现，从事件的 `occurred_at` 一路显式传参（C1/INV-1）；
 *   kernel/domain 里不允许读进程时钟（无参 `new Date`、`Date.now`）。
 * - `epochMs` 只用于比较与传给日历；**对外输出**走 `EtCalendar.iso`（带 ET 偏移），
 *   `toISOString()` 只用于日志/持久化等不需要 ET 偏移的场合。
 * - `parse` 要求显式偏移（`Z` 或 `±HH:MM`）：`"2026-11-10T08:00:00"` 没有偏移，
 *   无法唯一确定瞬时，必须拒绝（`bad_timestamp`）。
 *
 * 本文件不 import `EtCalendar`（避免环）：日期合法性与 UTC 格式化用
 * `et-date.ts` 的 civil-date 换算，不碰机器时区。
 */
import { AppError } from '../errors.ts';
import { civilFromDays, daysFromCivil } from './et-date.ts';
import type { Result } from '../result.ts';

/** RFC3339/ISO8601 且**必须带偏移**：`2026-11-10T08:00:00-05:00`、`...Z`、可带小数秒。 */
const ISO_WITH_OFFSET_RE =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|z|[+-]\d{2}:\d{2})$/;

const MS_PER_DAY = 86_400_000;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function pad4(n: number): string {
  return String(n).padStart(4, '0');
}

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

function invalid(iso: string, message: string): Result<Instant, AppError> {
  return {
    ok: false,
    error: new AppError('bad_timestamp', `${message}: ${JSON.stringify(iso)}`, { value: iso }),
  };
}

/** 一个绝对时刻。构造方式只有 `parse`（外部输入）与 `fromEpochMs`（内部换算）。 */
export class Instant {
  private constructor(
    /** UTC 毫秒数；只用于比较与日历换算。 */
    readonly epochMs: number,
    /** 原始输入串（`fromEpochMs` 时是 UTC ISO 形式），仅用于日志排查。 */
    readonly source: string,
  ) {}

  /**
   * 解析带偏移的时间串。**没有偏移就失败**——那是「本地时间」，不是瞬时。
   * 失败码固定 `bad_timestamp`（§9：`occurred_at` 不可解析 → 400）。
   */
  static parse(iso: string): Result<Instant, AppError> {
    if (typeof iso !== 'string') return invalid(String(iso), 'timestamp must be a string');
    const m = ISO_WITH_OFFSET_RE.exec(iso);
    if (m === null) {
      return invalid(iso, 'invalid timestamp (RFC3339 with explicit offset required)');
    }
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const hour = Number(m[4]);
    const minute = Number(m[5]);
    const second = Number(m[6]);
    const millis = m[7] === undefined ? 0 : Number(m[7].padEnd(3, '0').slice(0, 3));

    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
      return invalid(iso, 'field out of range');
    }
    // 日历合法性：往返校验（2026-02-30 会溢出到 03-02，从而被拒绝）。
    const days = daysFromCivil(year, month, day);
    const back = civilFromDays(days);
    if (back.year !== year || back.month !== month || back.day !== day) {
      return invalid(iso, 'not a real calendar date');
    }

    let offsetMinutes = 0;
    const offset = m[8];
    if (offset !== 'Z' && offset !== 'z') {
      const sign = offset.startsWith('-') ? -1 : 1;
      const offsetHours = Number(offset.slice(1, 3));
      const offsetMins = Number(offset.slice(4, 6));
      if (offsetHours > 23 || offsetMins > 59) return invalid(iso, 'offset out of range');
      offsetMinutes = sign * (offsetHours * 60 + offsetMins);
    }

    const wallMs = days * MS_PER_DAY + ((hour * 60 + minute) * 60 + second) * 1000 + millis;
    return { ok: true, value: new Instant(wallMs - offsetMinutes * 60_000, iso) };
  }

  /** 由 UTC 毫秒构造（`EtCalendar.startOfDay` 等内部换算用）；不读进程时钟。 */
  static fromEpochMs(epochMs: number): Instant {
    if (!Number.isFinite(epochMs)) {
      throw new RangeError(`Instant.fromEpochMs: not a finite epoch: ${String(epochMs)}`);
    }
    const ms = Math.trunc(epochMs);
    const days = Math.floor(ms / MS_PER_DAY);
    const msOfDay = ms - days * MS_PER_DAY;
    const { year, month, day } = civilFromDays(days);
    const hour = Math.floor(msOfDay / 3_600_000);
    const minute = Math.floor((msOfDay % 3_600_000) / 60_000);
    const second = Math.floor((msOfDay % 60_000) / 1000);
    const millis = msOfDay % 1000;
    const source = `${pad4(year)}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}.${pad3(millis)}Z`;
    return new Instant(ms, source);
  }

  /** 比较：-1 / 0 / 1（按时间先后）。 */
  compare(other: Instant): -1 | 0 | 1 {
    if (this.epochMs < other.epochMs) return -1;
    if (this.epochMs > other.epochMs) return 1;
    return 0;
  }

  /** 是否同一瞬时（与构造来源无关）。 */
  equals(other: Instant): boolean {
    return this.epochMs === other.epochMs;
  }

  /** 严格早于。 */
  isBefore(o: Instant): boolean {
    return this.epochMs < o.epochMs;
  }

  /** 早于或等于。 */
  isBeforeOrEqual(o: Instant): boolean {
    return this.epochMs <= o.epochMs;
  }

  /** UTC ISO 形式（**不是**对外输出格式；对外用 `EtCalendar.iso`）。 */
  toISOString(): string {
    return this.source.endsWith('Z') ? this.source : Instant.fromEpochMs(this.epochMs).source;
  }
}
