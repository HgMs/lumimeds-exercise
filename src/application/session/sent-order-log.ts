/**
 * `SentOrderLog`：本周已成功发出的订单（`ARCHITECTURE.md` §5.9、INV-2）。
 *
 * 两条不变量：
 * - **每个 `order_id` 最多一条记录**：`mark` 对同一 id 是幂等的（保留第一次的证据），
 *   重复调用不产生第二条、不抛异常（重放/恢复路径可能重复 mark，`W8`）。
 * - **`at` 是订单事件的 `occurred_at`（业务时间），不是发单墙钟**。`CapacityLedger`
 *   的 ET 日键依赖它（`DATA-CONTRACTS` §3.6、评审 D6）。
 *
 * `snapshot()` 返回内部 DTO（字符串时间是 `Instant.toISOString()`，UTC `Z`）；
 * `SnapshotMapper` 在写入 `state.json` 前统一转成 ET 偏移（`calendar.iso`）。这样
 * domain/application 的 DTO 不依赖日历，同时落盘格式仍由 mapper 单点决定。
 */
import { Instant } from '../../kernel/time/instant.ts';
import type { PharmacyId } from '../../domain/types.ts';

/** 一条已发单记录（camelCase，领域内部用 `Instant`）。 */
export interface SentOrderRecord {
  orderId: string;
  pharmacy: PharmacyId | 'MANUAL';
  /** 订单事件的 `occurred_at`（业务时间）。 */
  at: Instant;
}

/** `data/state.json` 里的 `sent_orders` 行（snake_case 由 mapper 落盘）。 */
export interface PersistedSentOrder {
  pharmacy: PharmacyId | 'MANUAL';
  at: string;
}

export class SentOrderLog {
  /** 插入顺序 = 发单顺序（快照与审计的稳定顺序）。 */
  private readonly byOrderId = new Map<string, SentOrderRecord>();

  /** 是否已成功发过（`OrderDispatcher` 的 INV-2 短路判据）。 */
  has(orderId: string): boolean {
    return this.byOrderId.has(orderId);
  }

  /**
   * 记一条已发单。幂等：同一 `orderId` 重复 `mark` **不覆盖**第一次记录
   * （`409` 恢复重发时也要保留原始药房与原始时刻，INV-2）。
   */
  mark(orderId: string, pharmacy: PharmacyId | 'MANUAL', at: Instant): void {
    if (this.byOrderId.has(orderId)) return;
    this.byOrderId.set(orderId, { orderId, pharmacy, at });
  }

  /** 取一条记录（拷贝，调用方拿不到内部引用）。 */
  get(orderId: string): SentOrderRecord | undefined {
    const record = this.byOrderId.get(orderId);
    return record === undefined ? undefined : { ...record };
  }

  /** 全部记录（插入顺序），逐条拷贝。 */
  entries(): Iterable<SentOrderRecord> {
    return [...this.byOrderId.values()].map((record) => ({ ...record }));
  }

  /** 快照（内部 DTO；落盘的 ET 偏移由 `SnapshotMapper` 统一转换）。 */
  snapshot(): Record<string, PersistedSentOrder> {
    const out: Record<string, PersistedSentOrder> = {};
    for (const record of this.byOrderId.values()) {
      out[record.orderId] = { pharmacy: record.pharmacy, at: record.at.toISOString() };
    }
    return out;
  }

  /**
   * 从快照恢复。时间字符串不可解析时**抛错**（快照被外部改坏，属不变量破坏）；
   * `SnapshotMapper.fromPersisted` 接住并折成 `persist_failed`。
   */
  static restore(records: Record<string, PersistedSentOrder>): SentOrderLog {
    const log = new SentOrderLog();
    for (const [orderId, record] of Object.entries(records)) {
      const parsed = Instant.parse(record.at);
      if (!parsed.ok) {
        throw new Error(
          `SentOrderLog.restore: 订单 ${orderId} 的 at 不可解析：${JSON.stringify(record.at)}`,
        );
      }
      log.byOrderId.set(orderId, { orderId, pharmacy: record.pharmacy, at: parsed.value });
    }
    return log;
  }
}
