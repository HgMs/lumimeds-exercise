/**
 * `DecisionLog`：本周每单一条路由决策（`ARCHITECTURE.md` §5.9、INV-4）。
 *
 * `record` 是**幂等 upsert**（同 `order_id` 覆盖，不抛异常）：重投与恢复路径可能
 * 重复构造同一个 `order_id` 的 decision，抛异常会把正常路径变成 500。「每单恰好一条」
 * 由集成测试断言，不靠运行时崩溃（W8）。
 *
 * `attachSend` 在发单成功后补上 `sent: {status, at}`：重试路径要在同一 `order_id`
 * 上补写，而不是新建一条（§5.9 RetryQueue）。
 *
 * `snapshot()`/`restore()` 用领域内 camelCase 的 `RoutingDecision`；落盘/审计的
 * snake_case 由 `SnapshotMapper` / `AuditRecorder` 转换。
 */
import type { Instant } from '../../kernel/time/instant.ts';
import type { RoutingDecision } from '../../domain/routing/decision.ts';

export class DecisionLog {
  private readonly byOrderId = new Map<string, RoutingDecision>();

  /** upsert：同 `orderId` 覆盖（保留原插入位置，快照顺序稳定）。 */
  record(decision: RoutingDecision): void {
    this.byOrderId.set(decision.orderId, {
      ...decision,
      candidates: decision.candidates.map((candidate) => ({
        ...candidate,
        failures: [...candidate.failures],
      })),
    });
  }

  get(orderId: string): RoutingDecision | undefined {
    return this.byOrderId.get(orderId);
  }

  /** 全部决策，插入顺序（= 首次记录顺序，确定）。 */
  all(): readonly RoutingDecision[] {
    return [...this.byOrderId.values()];
  }

  /**
   * 发单成功后补 `sent`。没有对应 decision 时是无害 no-op：调用方在重试路径上
   * 总会先构造 decision，找不到说明状态被外部改坏——但审计不是真值，不该因此 500。
   */
  attachSend(orderId: string, sent: { status: number; at: Instant }): void {
    const decision = this.byOrderId.get(orderId);
    if (decision === undefined) return;
    this.byOrderId.set(orderId, { ...decision, sent: { status: sent.status, at: sent.at } });
  }

  /** 便于 `SnapshotMapper` 生成 `Record<order_id, PersistedRoutingDecision>`。 */
  snapshot(): Record<string, RoutingDecision> {
    const out: Record<string, RoutingDecision> = {};
    for (const [orderId, decision] of this.byOrderId) out[orderId] = decision;
    return out;
  }

  static restore(records: Record<string, RoutingDecision>): DecisionLog {
    const log = new DecisionLog();
    for (const decision of Object.values(records)) log.byOrderId.set(decision.orderId, decision);
    return log;
  }
}
