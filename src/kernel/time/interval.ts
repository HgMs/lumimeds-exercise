/**
 * `Interval`：半开区间 `[from, until)`（`ARCHITECTURE.md` §5.1、§10）。
 *
 * 不变量：
 * - `until` 一律**排他**：「until Wednesday」= `until = startOfDay(周三)`。
 * - `until === null` 表示一直有效。
 * - `of` 要求 `until > from`；相等或倒置是 `bad_interval`（不是「空区间」）。
 */
import { AppError } from '../errors.ts';
import type { Result } from '../result.ts';
import { Instant } from './instant.ts';

export class Interval {
  private constructor(
    readonly from: Instant,
    /** 排他上界；`null` = 一直有效。 */
    readonly until: Instant | null,
  ) {}

  /** 构造并校验；`until > from`（严格），否则 `bad_interval`。 */
  static of(from: Instant, until: Instant | null): Result<Interval, AppError> {
    if (until !== null && !from.isBefore(until)) {
      return {
        ok: false,
        error: new AppError('bad_interval', 'interval until must be after from', {
          from: from.toISOString(),
          until: until.toISOString(),
        }),
      };
    }
    return { ok: true, value: new Interval(from, until) };
  }

  /** `from <= t < (until ?? +∞)`。 */
  covers(t: Instant): boolean {
    if (t.isBefore(this.from)) return false;
    return this.until === null || t.isBefore(this.until);
  }
}
