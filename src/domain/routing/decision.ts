/**
 * 路由决策的领域类型（`DATA-CONTRACTS.md` §3.3/§3.4、`ARCHITECTURE.md` §5.7）。
 *
 * 领域内部用 Instant；落盘/审计用的 snake_case DTO 由 `PersistedRoutingDecision`
 * 表示，`SnapshotMapper` 负责转换。内部的 `RoutingDecision` 是唯一真值。
 */
import type { Instant } from '../../kernel/time/instant.ts';
import type { NormalizedOrder } from '../normalize/order-normalizer.ts';
import type { DoseId, MedicationId, OrderId, PharmacyId, StateCode } from '../types.ts';

/**
 * 资格失败码。格式是封闭且固定的，`ManualReasonBuilder` 与 verify 都依赖它。
 */
export type FailureCode =
  | 'closed'
  | `state_blocked:${StateCode}`
  | `no_stock:${MedicationId}:${DoseId}`
  | 'capacity_full';

/** 对一家药房在某一时刻、针对某订单的资格评估。 */
export interface CandidateEvaluation {
  pharmacy: PharmacyId;
  eligible: boolean;
  shipsInDays: number;
  price: number | null;
  capacityLeft: number;
  failures: FailureCode[];
}

/** 路由依据：排名 / ops 偏好命中 / 手工。 */
export type RoutingBasis = 'rank' | 'ops_preference' | 'manual';

/** 一次订单路由的完整决策（领域内 camelCase）。 */
export interface RoutingDecision {
  orderId: OrderId;
  /** 决策时刻 = 订单事件的 occurred_at。 */
  at: Instant;
  /** 归一化后的订单。 */
  order: NormalizedOrder;
  chosen: PharmacyId | 'MANUAL';
  basis: RoutingBasis;
  reason: string | null;
  candidates: CandidateEvaluation[];
  preference: { pharmacy: PharmacyId; eventId: string } | null;
  override: string | null;
  sent: { status: number; at: Instant } | null;
}

/** `data/state.json` 里的 decisions DTO（snake_case，`DATA-CONTRACTS.md` §3.4）。 */
export interface PersistedRoutingDecision {
  order_id: OrderId;
  at: string;
  order: { order_id: OrderId; state: StateCode; medication: MedicationId; dose: DoseId };
  chosen: PharmacyId | 'MANUAL';
  basis: RoutingBasis;
  reason: string | null;
  candidates: CandidateEvaluation[];
  preference: { pharmacy: PharmacyId; event_id: string } | null;
  override: string | null;
  sent: { status: number; at: string } | null;
}
