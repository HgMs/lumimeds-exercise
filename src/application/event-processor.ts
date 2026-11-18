/**
 * `EventProcessor`：webhook 事件的主干（`ARCHITECTURE.md` §5.9、§6.1/§6.2）。
 *
 * 处理步骤（**顺序即语义，不要重排**）：
 *
 * ```
 * 1. parseEnvelope(body)                 失败 → 400（不建会话、不写盘）
 * 2. queue.run(async () => {             单飞：同一时刻只处理一个事件
 * 3.   deadline = Deadline.after(occurred_at, 25_000)
 * 4.   simulation.started → 在幂等门**之前**无条件重置；清 seen；goto 8
 * 5.   无会话 → 500 no_session
 * 6.   seen 幂等门 → 200 duplicate（不更新 lastEventAt）
 * 7.   email / order / 未知 type → 200 ignored_type（不写 seen、不写盘）
 * 8.   seen.add + lastEventAt = occurred_at
 * 9-10 mapper.toPersisted
 * 11.  saveWithRetry（3 次，50/200ms 间隔）失败 → degraded + 500 persist_failed
 * 12.  recorder.flush（失败只记日志，不回滚状态）
 * 13.  200 outcome
 * })
 * ```
 *
 * 三个容易写错的点：
 * - **`simulation.started` 必须排在幂等门之前**：隐藏周会重放同一份 week 文件，
 *   若 started 被判 duplicate，旧快照里的 `seen`/`sent`/facts 就不会被重置，整周
 *   要么全是 duplicate（0 单发出），要么新事件混进旧周 fact（不安全）。
 * - **`seen` 与副作用在同一份成功落盘的快照里提交**，所以「看到 seen 为真」等价于
 *   「副作用已落盘」；save 失败必须回 500（可见），不能静默 ACK。
 * - **未知 type 不写 `seen`**：否则同一未知事件重投会被当成 duplicate，日志里少一条
 *   证据；它也不该有副作用，所以直接 200。
 */
import type { Logger } from '../kernel/logger.ts';
import { Deadline } from '../kernel/deadline.ts';
import type { SerialQueue } from '../kernel/serial-queue.ts';
import { Instant } from '../kernel/time/instant.ts';
import type {
  EmailEvent,
  OrderEvent,
  SimulationStartedEvent,
} from '../domain/events.ts';
import type { AuditRecorder } from './audit/audit-recorder.ts';
import type { Envelope } from './ingest/envelope-parser.ts';
import { EnvelopeParser, isKnownEventType } from './ingest/envelope-parser.ts';
import type { StateStore } from './ports/state-store.ts';
import type { RecoveryService } from './recovery/recovery-service.ts';
import type { SessionHolder } from './session/session-holder.ts';
import type { SimulationSession } from './session/simulation-session.ts';
import type { SnapshotMapper } from './session/snapshot-mapper.ts';
import type { StartSimulationUseCase } from './use-cases/start-simulation.ts';
import type { HandleEmailUseCase } from './use-cases/handle-email.ts';
import type { HandleOrderUseCase } from './use-cases/handle-order.ts';

/** 一次 webhook 的输入：HTTP body + 可选 headers（header 只做交叉校验）。 */
export interface IngestInput {
  body: string;
  headers?: Record<string, string | undefined>;
}

/** §5.9 的封闭结果枚举（`persist_failed` / `internal_error` 都映射 500）。 */
export type IngestOutcome =
  | 'started'
  | 'email_applied'
  | 'email_no_change'
  | 'email_rejected'
  | 'order_sent'
  | 'order_manual'
  | 'order_deferred'
  | 'duplicate'
  | 'ignored_type'
  | 'bad_request'
  | 'no_session'
  | 'persist_failed'
  | 'internal_error';

/** webhook 的响应（`WebhookHandler` 据此写 HTTP status + `{"ok": ...}`）。 */
export interface IngestResult {
  status: 200 | 400 | 413 | 500;
  outcome: IngestOutcome;
}

/** `EventProcessor` 的构造依赖。 */
export interface EventProcessorDeps {
  /** 与 `RetryQueue` 共用的同一个串行队列（单飞）。 */
  queue: SerialQueue;
  holder: SessionHolder;
  started: StartSimulationUseCase;
  order: HandleOrderUseCase;
  email: HandleEmailUseCase;
  stateStore: StateStore;
  mapper: SnapshotMapper;
  recorder: AuditRecorder;
  logger: Logger;
  /**
   * 启动恢复服务。**`EventProcessor` 不调用它**（恢复只发生在启动序列里，由 wiring
   * 在 `server.listen()` 之前执行）；保留这个可选字段只是为了与 §5.9 的对象图对齐。
   */
  recovery?: RecoveryService;
  /** 事件总预算（默认 25_000ms，§5.9 步骤 3）。测试可调小。 */
  eventBudgetMs?: number;
  /** 写盘重试前的等待（默认 [50, 200]ms）。测试可注入。 */
  persistRetryDelaysMs?: readonly number[];
}

const DEFAULT_EVENT_BUDGET_MS = 25_000;
const DEFAULT_PERSIST_RETRY_DELAYS_MS = [50, 200] as const;
const PERSIST_ATTEMPTS = 3;

/** 把信封 body 收窄成领域事件：信封三字段以解析结果为准（body 缺失时可能来自 header）。 */
function toEvent<T extends EmailEvent | OrderEvent | SimulationStartedEvent>(
  envelope: Envelope,
): T {
  return {
    ...envelope.body,
    event_id: envelope.event_id,
    type: envelope.type,
    occurred_at: envelope.occurred_at,
  } as unknown as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class EventProcessor {
  private readonly envelopeParser = new EnvelopeParser();
  private readonly eventBudgetMs: number;
  private readonly persistRetryDelaysMs: readonly number[];

  constructor(private readonly deps: EventProcessorDeps) {
    this.eventBudgetMs = deps.eventBudgetMs ?? DEFAULT_EVENT_BUDGET_MS;
    this.persistRetryDelaysMs = deps.persistRetryDelaysMs ?? DEFAULT_PERSIST_RETRY_DELAYS_MS;
  }

  /** 处理一个 webhook 事件。永不抛异常：失败都折成 `IngestResult` 的 4xx/5xx。 */
  async process(input: IngestInput): Promise<IngestResult> {
    // ---- 1. 信封解析（纯函数，失败即 400，不进队列、不建会话、不写盘） ----
    const parsed = this.envelopeParser.parse(input.body, input.headers ?? {});
    if (!parsed.ok) {
      this.deps.logger.warn('event-processor: 信封解析失败', {
        code: parsed.error.code,
        detail: parsed.error.detail,
      });
      return { status: 400, outcome: 'bad_request' };
    }
    const envelope = parsed.value;
    for (const warning of envelope.headerWarnings) {
      this.deps.logger.warn('event-processor: 信封 header 交叉校验告警', {
        event_id: envelope.event_id,
        warning,
      });
    }

    // ---- 2. 单飞：事件之间不交错，幂等门才有意义 ----
    try {
      return await this.deps.queue.run(() => this.processInQueue(envelope));
    } catch (cause) {
      // processInQueue 里的预期失败都返回 Result；能走到这里的只有实现 bug。
      this.deps.logger.error('event-processor: 未预期异常（事件未提交）', {
        event_id: envelope.event_id,
        type: envelope.type,
        cause,
      });
      return { status: 500, outcome: 'internal_error' };
    }
  }

  private async processInQueue(envelope: Envelope): Promise<IngestResult> {
    // ---- 3. 单事件预算：所有外部调用（LLM/POST/写盘）都从它分配超时 ----
    const atParsed = Instant.parse(envelope.occurred_at);
    if (!atParsed.ok) {
      // 信封解析已经用 Instant.parse 验过；这里再失败属实现 bug，按 400 兜底。
      this.deps.logger.error('event-processor: 已通过解析的 occurred_at 再次解析失败', {
        event_id: envelope.event_id,
        occurred_at: envelope.occurred_at,
      });
      return { status: 400, outcome: 'bad_request' };
    }
    const at = atParsed.value;
    const deadline = Deadline.after(at, this.eventBudgetMs);
    const log = this.deps.logger.child({
      event_id: envelope.event_id,
      type: envelope.type,
      at: envelope.occurred_at,
    });

    // ---- 4. simulation.started：在幂等门**之前**无条件重置 ----
    if (envelope.type === 'simulation.started') {
      const startedEvent = toEvent<SimulationStartedEvent>(envelope);
      const started = await this.deps.started.execute(startedEvent);
      if (!started.ok) {
        // §9：config 不可用 → 500 且不建会话；用例已 holder.clear()。
        log.error('event-processor: simulation.started 被拒绝', {
          code: started.error.code,
          message: started.error.message,
          detail: started.error.detail ?? null,
        });
        return { status: 500, outcome: 'internal_error' };
      }
      const session = this.deps.holder.requireSession();
      session.seenEventIds.add(startedEvent.event_id);
      session.lastEventAt = at;
      const outcome = await this.commitAndFlush(session, log);
      if (outcome !== null) return outcome;
      log.info('event-processor: simulation.started 已提交');
      return { status: 200, outcome: 'started' };
    }

    // ---- 5. 无会话：不建会话、不写盘（§16-Q3） ----
    if (!this.deps.holder.hasSession()) {
      log.error('event-processor: 无会话（simulation.started 未成功处理或快照不可用）', {});
      return { status: 500, outcome: 'no_session' };
    }
    const session = this.deps.holder.requireSession();

    // ---- 6. 幂等门（C3）：seen 在快照里，所以「为真」= 副作用已落盘 ----
    if (session.seenEventIds.has(envelope.event_id)) {
      // 不更新 lastEventAt：重投不能把「现在」拨回过去（§WALKTHROUGHS S1）。
      log.info('event-processor: 重复事件，直接 200', {});
      return { status: 200, outcome: 'duplicate' };
    }

    // ---- 7. 分派；未知 type 不写 seen、不写盘 ----
    if (!isKnownEventType(envelope.type)) {
      log.warn('event-processor: 未知事件类型，忽略', {});
      return { status: 200, outcome: 'ignored_type' };
    }

    let outcome: IngestOutcome;
    switch (envelope.type) {
      case 'email': {
        const emailEvent = toEvent<EmailEvent>(envelope);
        const result = await this.deps.email.execute(emailEvent, deadline);
        outcome = result.kind;
        break;
      }
      case 'order': {
        const orderEvent = toEvent<OrderEvent>(envelope);
        const result = await this.deps.order.execute(orderEvent, deadline);
        outcome = result.kind;
        break;
      }
      default: {
        // `isKnownEventType` 已收窄成三个已知类型，这里不可达。
        log.warn('event-processor: 已知类型未分派', {});
        return { status: 200, outcome: 'ignored_type' };
      }
    }

    // ---- 8-9. 与副作用同一份快照提交幂等键 + 求值时刻 ----
    session.seenEventIds.add(envelope.event_id);
    session.lastEventAt = at;

    // ---- 10-12. 快照 →（失败 500）→ 审计 ----
    const failed = await this.commitAndFlush(session, log);
    if (failed !== null) return failed;
    return { status: 200, outcome };
  }

  // -------------------------------------------------------------------------
  // 提交
  // -------------------------------------------------------------------------

  /**
   * 步骤 10–12：`mapper.toPersisted` → `saveWithRetry`（3 次）→ `recorder.flush()`。
   *
   * @returns `null` 表示提交成功；否则返回要回给调用方的失败响应。
   */
  private async commitAndFlush(
    session: SimulationSession,
    log: Logger,
  ): Promise<IngestResult | null> {
    let snapshot;
    try {
      snapshot = this.deps.mapper.toPersisted(session);
    } catch (cause) {
      log.error('event-processor: 快照序列化失败（事件未提交）', { cause });
      return { status: 500, outcome: 'internal_error' };
    }

    const saved = await this.saveWithRetry(snapshot, log);
    if (!saved) {
      session.degraded = true;
      log.error('event-processor: 快照写盘 3 次仍失败（degraded=true，回 500 让 sim 记 problem）', {
        degraded: true,
      });
      return { status: 500, outcome: 'persist_failed' };
    }

    // 审计不是真值：flush 失败只记日志，不回滚状态（§15 D12）。
    await this.deps.recorder.flush();
    return null;
  }

  /** 写快照：失败重试 3 次（第 2/3 次前分别等 50/200ms）。 */
  private async saveWithRetry(
    snapshot: Parameters<StateStore['save']>[0],
    log: Logger,
  ): Promise<boolean> {
    const delays = this.persistRetryDelaysMs;
    for (let attempt = 0; attempt < PERSIST_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        const wait = delays[attempt - 1] ?? 0;
        if (wait > 0) await sleep(wait);
      }
      const saved = await this.deps.stateStore.save(snapshot);
      if (saved.ok) return true;
      log.warn('event-processor: 快照写盘失败，准备重试', {
        attempt: attempt + 1,
        attempts: PERSIST_ATTEMPTS,
        code: saved.error.code,
        message: saved.error.message,
      });
    }
    return false;
  }
}
