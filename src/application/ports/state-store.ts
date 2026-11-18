/**
 * 快照端口（`ARCHITECTURE.md` §5.9、§11.1；`DATA-CONTRACTS.md` §3.6）。
 *
 * `data/state.json` 是唯一提交点：facts / sent_orders / seen_event_ids 等
 * 一起原子提交，所以「看到 seen 为真」等价于「副作用已落盘」。
 * 落盘一律 snake_case；domain 内部 camelCase，由 SnapshotMapper 转换。
 */
import type { AppError } from '../../kernel/errors.ts';
import type { Result } from '../../kernel/result.ts';
import type { SimConfig } from '../../domain/config.ts';
import type { SamEntry } from '../../domain/email/sam-list.ts';
import type { FactType } from '../../domain/facts/fact.ts';
import type { PersistedRoutingDecision } from '../../domain/routing/decision.ts';
import type { DoseId, MedicationId, PharmacyId, StateCode } from '../../domain/types.ts';

/** 落盘版 fact：`DATA-CONTRACTS.md` §3.1 的 snake_case 形状。 */
export interface PersistedFact {
  id: string;
  type: FactType;
  event_id: string;
  asserted_at: string;
  pharmacy: PharmacyId;
  interval: { from: string; until: string | null };
  medication?: MedicationId;
  dose?: DoseId;
  state?: StateCode;
  per_day?: number;
  note?: string;
}

/** `data/state.json` 的形状（`DATA-CONTRACTS.md` §3.6）。 */
export interface PersistedState {
  version: 1;
  week_started_at: string;
  pharmacy_api: string;
  config: SimConfig;
  facts: PersistedFact[];
  seen_event_ids: string[];
  /** at = 该订单事件的 occurred_at，不是发单墙钟。 */
  sent_orders: Record<string, { pharmacy: PharmacyId | 'MANUAL'; at: string }>;
  decisions: Record<string, PersistedRoutingDecision>;
  sam: SamEntry[];
  seq: { fact: number };
  last_event_at: string;
  degraded: boolean;
}

export interface StateStore {
  load(): Promise<Result<PersistedState | null, AppError>>;
  /** 原子写（tmp + rename）。 */
  save(s: PersistedState): Promise<Result<void, AppError>>;
  clear(): Promise<Result<void, AppError>>;
}
