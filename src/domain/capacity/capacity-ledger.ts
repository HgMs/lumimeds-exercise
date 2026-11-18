/**
 * `CapacityLedger`：按 `(药房, ET 日)` 计数的发单账本（`ARCHITECTURE.md` §5.6、
 * `REQUIREMENTS.md` §3.3）。
 *
 * 键是 `` `${pharmacy}|${ET date}` ``——日期做 key，本地午夜自然重置，**不需要
 * 「新的一天」事件**（也就没有翻转逻辑可写错）。
 *
 * 三条不变量：
 * - **INV-6**：只有真正落地的发单（`201`，或恢复时 `409` 确认「此前已发」）才
 *   `record`，且每个 `order_id` 只记一次（调用方去重）；`MANUAL` 不计数。
 * - **D4（去双真值）**：ledger **不进快照**；恢复时由 `sent_orders` + `calendar`
 *   经 `rebuild` 派生。单独存一份计数会造出「快照说发了、ledger 说没发」两个真值。
 * - `used` 只增不减，所以 `capacityLeft = max(0, capacityToday - used)` 由
 *   `PharmacyBelief` 计算（容量被下调到低于已发数时，当天立即停接，不追回已发单）。
 */
import type { Instant } from '../../kernel/time/instant.ts';
import type { EtCalendar } from '../../kernel/time/et-calendar.ts';
import type { EtDate } from '../../kernel/time/et-date.ts';
import type { PharmacyId } from '../types.ts';

/** `snapshot()` 的一行（§5.6 形状；`date` 是 ET 日期串）。 */
export interface CapacitySnapshotEntry {
  pharmacy: PharmacyId;
  date: string;
  count: number;
}

/** `rebuild` 的输入项：`sent_orders` 里的一条（`at` = 该订单事件的 occurred_at）。 */
export interface SentOrderCapacityEntry {
  pharmacy: PharmacyId;
  at: Instant;
}

/** `MANUAL` 不是药房，不占任何容量（`REQUIREMENTS.md` §3.3、INV-6）。 */
const MANUAL_PHARMACY = 'MANUAL';

export class CapacityLedger {
  /** `pharmacy|ET-date` → 已发单数。 */
  private readonly counts = new Map<string, number>();

  /** 键格式是 §5.6 的契约；pharmacy id 是 config 标识符，不含 `|`。 */
  private static key(pharmacy: PharmacyId, date: EtDate): string {
    return `${pharmacy}|${date}`;
  }

  /** 某药房某 ET 日已发单数；没有记录 = 0（不是 undefined）。 */
  used(pharmacy: PharmacyId, date: EtDate): number {
    return this.counts.get(CapacityLedger.key(pharmacy, date)) ?? 0;
  }

  /** 记一笔**真实落地**的发单（调用方负责「同一 order_id 只记一次」）。 */
  record(pharmacy: PharmacyId, date: EtDate): void {
    const key = CapacityLedger.key(pharmacy, date);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  /**
   * 从 `sent_orders` 派生账本（D4：恢复路径用，ledger 本身不进快照）。
   *
   * **内部跳过 `pharmacy === 'MANUAL'`**：`sent_orders` 里含 MANUAL 行（§5.6），
   * MANUAL 不是真实发单、不占任何药房的容量。调用方因此可以直接把**全部**
   * sent_orders 条目传进来，不需要先过滤；额外地再过滤一遍也不影响结果。
   *
   * ET 日一律由 `calendar.dateOf(at)` 得出（不是机器时区、不是墙钟）。
   */
  static rebuild(
    entries: Iterable<SentOrderCapacityEntry>,
    cal: EtCalendar,
  ): CapacityLedger {
    const ledger = new CapacityLedger();
    for (const entry of entries) {
      if (entry.pharmacy === MANUAL_PHARMACY) continue;
      ledger.record(entry.pharmacy, cal.dateOf(entry.at));
    }
    return ledger;
  }

  /**
   * 快照：按 `pharmacy|date` 键**排序**输出，保证同一份账本两次 `snapshot()`
   * 逐字段相同（C7：不依赖 `Map` 迭代序）。
   */
  snapshot(): CapacitySnapshotEntry[] {
    const keys = [...this.counts.keys()].sort();
    return keys.map((key) => {
      const separator = key.indexOf('|');
      const pharmacy = key.slice(0, separator);
      const date = key.slice(separator + 1);
      return { pharmacy, date, count: this.counts.get(key) ?? 0 };
    });
  }
}
