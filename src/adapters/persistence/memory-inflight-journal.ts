/**
 * `InflightJournal` 的内存测试替身（`ARCHITECTURE.md` §5.10）。
 *
 * 语义与 `FileInflightJournal` 对齐：
 * - `begin` 按 `orderId` upsert（重试同一单不会变成两条 WAL 条目）；
 * - `commit` 幂等移除；
 * - `load()` 返回深拷贝，调用方无法通过改数组影响内部状态。
 */
import type {
  InflightEntry,
  InflightJournal,
} from '../../application/ports/inflight-journal.ts';
import type { OrderId } from '../../domain/types.ts';

export class MemoryInflightJournal implements InflightJournal {
  private entries: InflightEntry[] = [];

  async begin(entry: InflightEntry): Promise<void> {
    const index = this.entries.findIndex((existing) => existing.orderId === entry.orderId);
    if (index >= 0) this.entries[index] = cloneEntry(entry);
    else this.entries.push(cloneEntry(entry));
  }

  async commit(orderId: OrderId): Promise<void> {
    this.entries = this.entries.filter((entry) => entry.orderId !== orderId);
  }

  async load(): Promise<readonly InflightEntry[]> {
    return this.entries.map(cloneEntry);
  }

  async clear(): Promise<void> {
    this.entries = [];
  }

  /** 测试断言用：当前条目数。 */
  get size(): number {
    return this.entries.length;
  }
}

function cloneEntry(entry: InflightEntry): InflightEntry {
  return {
    orderId: entry.orderId,
    pharmacy: entry.pharmacy,
    at: entry.at,
    decisionReason: entry.decisionReason,
    startedAtRealClock: entry.startedAtRealClock,
  };
}
