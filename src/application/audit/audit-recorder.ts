/**
 * `AuditRecorder`：审计的**唯一写入口**（`ARCHITECTURE.md` §5.9、复审 R3-11、D12）。
 *
 * 用例（`HandleOrderUseCase` / `HandleEmailUseCase` / `RetryQueue`）只**构造**记录
 * 并交给这里；真正写 `AuditSink` 的只有 `flush()`，由 `EventProcessor`（步骤 12）与
 * `RetryQueue`（重试成功后）调用。这样不会出现「两处都在写 decisions.jsonl」或
 * 「写了审计但没人 flush」。
 *
 * 两条不变量：
 * - `record(decision)` 负责把领域 `RoutingDecision` 转成落盘/审计 DTO
 *   （`PersistedRoutingDecision`，时间用 `calendar.iso` 的 ET 偏移形式）；
 * - `flush()` 失败只 `logger.error`，**不回滚状态**（审计不是真值，快照才是）：
 *   证据丢一行不影响路由与发单的正确性（§15 D12）。
 */
import type { AuditSink, FactAuditRecord } from '../ports/audit-sink.ts';
import type { PersistedRoutingDecision, RoutingDecision } from '../../domain/routing/decision.ts';
import type { EtCalendar } from '../../kernel/time/et-calendar.ts';
import type { Logger } from '../../kernel/logger.ts';
import { toPersistedDecision } from '../session/snapshot-mapper.ts';

/** `AuditRecorder` 的构造依赖。 */
export interface AuditRecorderDeps {
  sink: AuditSink;
  /** 决策落盘时间统一用 ET 偏移（与 `SnapshotMapper` 同一规则）。 */
  calendar: EtCalendar;
  logger: Logger;
}

export class AuditRecorder {
  /** 尚未交给 sink 的决策（`PersistedRoutingDecision`，audit DTO）。 */
  private stagedDecisions: PersistedRoutingDecision[] = [];
  /** 尚未交给 sink 的邮件事实行。 */
  private stagedFacts: FactAuditRecord[] = [];

  constructor(private readonly deps: AuditRecorderDeps) {}

  /** 暂存一条决策（同步、不 IO）；转换失败只记日志，不让审计拖垮事件。 */
  record(decision: RoutingDecision): void {
    try {
      this.stagedDecisions.push(toPersistedDecision(decision, this.deps.calendar));
    } catch (cause) {
      this.deps.logger.error('audit recorder: 决策序列化失败（跳过该审计行）', {
        order_id: decision.orderId,
        cause,
      });
    }
  }

  /** 暂存一条邮件审计行（形状已由用例按 `FactAuditRecord` 构造，原样保留）。 */
  fact(record: FactAuditRecord): void {
    this.stagedFacts.push(record);
  }

  /** 还有多少条未交出去（测试 / 排错用）。 */
  pending(): { decisions: number; facts: number } {
    return { decisions: this.stagedDecisions.length, facts: this.stagedFacts.length };
  }

  /**
   * 把暂存的记录交给 `AuditSink` 并等它落盘。
   *
   * - 先取走再 await：flush 失败时这些记录不再重试（审计可丢，重复写更糟）；
   * - 失败只 `logger.error`，**不抛**、不回滚状态（D12）。
   */
  async flush(): Promise<void> {
    if (this.stagedDecisions.length === 0 && this.stagedFacts.length === 0) return;
    const decisions = this.stagedDecisions;
    const facts = this.stagedFacts;
    this.stagedDecisions = [];
    this.stagedFacts = [];
    try {
      for (const decision of decisions) await this.deps.sink.decision(decision);
      for (const record of facts) await this.deps.sink.fact(record);
      await this.deps.sink.flush();
    } catch (cause) {
      this.deps.logger.error('audit flush 失败（审计不是真值，不回滚状态）', {
        decisions: decisions.length,
        facts: facts.length,
        cause,
      });
    }
  }
}
