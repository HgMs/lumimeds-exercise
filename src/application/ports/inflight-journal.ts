/**
 * 发单 WAL 端口（`ARCHITECTURE.md` §5.9、§11.3；`DATA-CONTRACTS.md` §3.8）。
 *
 * 发单**之前** `begin`，`201`/`409` 之后 `commit`。崩溃恢复靠它区分
 * 「已发」与「结果未知」；恢复时按 WAL 里记的药房原样重发，绝不重新路由。
 */
import type { OrderId, PharmacyId } from '../../domain/types.ts';

export interface InflightEntry {
  orderId: OrderId;
  pharmacy: PharmacyId | 'MANUAL';
  /** 原始决策时刻（业务时间 ISO）。恢复时用它记容量、算 ET 日期，绝不用重启时刻。 */
  at: string;
  decisionReason: string | null;
  /** 仅用于排查「卡了多久」，不参与任何业务判断。 */
  startedAtRealClock: string;
}

export interface InflightJournal {
  begin(e: InflightEntry): Promise<void>;
  commit(orderId: OrderId): Promise<void>;
  load(): Promise<readonly InflightEntry[]>;
  clear(): Promise<void>;
}
