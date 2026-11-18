/**
 * `OrderDispatcher`：一次发单的完整语义（`ARCHITECTURE.md` §5.9「OrderDispatcher」、
 * `DATA-CONTRACTS.md` §2.1、§9 失败矩阵）。
 *
 * 状态码表（严格照 §5.9，不要凭直觉改）：
 *
 * | 响应 | 处理 | 计入容量 | 入重试队列 |
 * |---|---|---|---|
 * | `201` | `sent.mark` + `capacity.record` + `inflight.commit` | 是 | 否 |
 * | `409` | 视为已发（`sent.mark`）+ 容量 + `warn` + commit | 是 | 否 |
 * | `400/404` | `error`，不重试（重试也不会成功） | 否 | 否 |
 * | `5xx` | 同药房内联退避 250/500/1000ms（受 `Deadline` 约束）→ 仍失败 `retry.enqueue` | 否 | 是 |
 * | 超时/连接被断 | **结果未知**：同药房重发，绝不改派 → `retry.enqueue`（同药房） | 否 | 是 |
 *
 * 两条最容易写错的不变量：
 * - **INV-2**：`sent.has(orderId)` 为真时直接返回、不发任何请求。
 * - **顺序**：`inflight.begin` → POST → `sent.mark`/`capacity.record` → `inflight.commit`。
 *   `inflight.begin` 失败时**不发送**（不写 WAL 就不发：不发比发两次好）。
 *
 * 会话内对象（`sent`/`capacity`）经 `SessionHolder` 从当前会话取：发单对象是进程级
 * 单例，而 `simulation.started` 会换整个会话，直接注入旧会话的日志会写错对象。
 */
import type { Logger } from '../../kernel/logger.ts';
import { Deadline } from '../../kernel/deadline.ts';
import type { EtCalendar } from '../../kernel/time/et-calendar.ts';
import type { Instant } from '../../kernel/time/instant.ts';
import type { NormalizedOrder } from '../../domain/normalize/order-normalizer.ts';
import type { RoutingDecision } from '../../domain/routing/decision.ts';
import type { PharmacyId } from '../../domain/types.ts';
import type { InflightJournal } from '../ports/inflight-journal.ts';
import type { PharmacyGateway, SendOutcome } from '../ports/pharmacy-gateway.ts';
import type { SessionHolder } from '../session/session-holder.ts';
import type { SimulationSession } from '../session/simulation-session.ts';
import type { RetryItem, RetryQueue } from './retry-queue.ts';

/** `dispatch` 的结果；`status` 只在有 HTTP 结果时出现。 */
export interface DispatchResult {
  kind: 'sent' | 'already_sent' | 'deferred' | 'failed';
  status?: number;
  detail?: string;
}

/** `OrderDispatcher` 的构造依赖。 */
export interface OrderDispatcherDeps {
  gateway: PharmacyGateway;
  /** 发单 WAL：POST 之前 `begin`，201/409 之后 `commit`。 */
  inflight: InflightJournal;
  /** 只重发同一药房；5xx/超时耗尽预算后入队。 */
  retry: RetryQueue;
  holder: SessionHolder;
  calendar: EtCalendar;
  logger: Logger;
  /** 首次调用的超时预算（默认 8_000ms；`Deadline.allocate` 还会再压一次）。 */
  sendTimeoutMs?: number;
  /** 测试接缝：内联退避的休眠实现（默认真实 `setTimeout`）。 */
  sleep?: (ms: number) => Promise<void>;
}

/** 内联退避：每次重试前的等待（§5.9 的 250/500/1000ms）。 */
const INLINE_RETRY_DELAYS_MS = [250, 500, 1_000] as const;
const DEFAULT_SEND_TIMEOUT_MS = 8_000;

/** 默认休眠：真实定时器（`unref` 不需要——调用方在等它）。 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 传输层异常 → 「结果未知」，只用于日志描述。 */
function describeCause(cause: unknown): unknown {
  if (cause instanceof Error) return { name: cause.name, message: cause.message };
  return cause;
}

export class OrderDispatcher {
  constructor(private readonly deps: OrderDispatcherDeps) {}

  /**
   * 发一单。调用方必须已把 `decision` 记录进 `DecisionLog`（这里只做发单副作用，
   * 不回写 decision；`sent` 的补写由用例在拿到结果后 `attachSend`）。
   */
  async dispatch(
    order: NormalizedOrder,
    decision: RoutingDecision,
    at: Instant,
    deadline: Deadline,
  ): Promise<DispatchResult> {
    const session = this.deps.holder.requireSession();
    const orderId = order.orderId;
    const pharmacy = decision.chosen;

    // INV-2：已发过就绝不发第二次（sent 在快照里，重启后依然成立）。
    if (session.sent.has(orderId)) {
      this.deps.logger.info('order-dispatcher: 该单已发出，跳过（INV-2）', {
        order_id: orderId,
        pharmacy: session.sent.get(orderId)?.pharmacy ?? null,
      });
      return { kind: 'already_sent', status: 201 };
    }

    // 顺序的第一环：不写 WAL 就不发（§9：inflight 写失败 → 中止发单）。
    try {
      await this.deps.inflight.begin({
        orderId,
        pharmacy,
        // WAL 里的 at 是业务时间（ET 偏移），恢复时用它记容量、算 ET 日。
        at: this.deps.calendar.iso(at),
        decisionReason: decision.reason,
        // 仅用于排查「卡了多久」，不参与任何业务判断。这是本服务里唯一需要真实墙钟
        // 的地方（INV-1 只约束 domain/kernel；这里用带参数的 Date 构造，不是裸时钟 API）。
        startedAtRealClock: new Date(performance.timeOrigin + performance.now()).toISOString(),
      });
    } catch (cause) {
      this.deps.logger.error('order-dispatcher: inflight.begin 失败，中止发单', {
        order_id: orderId,
        pharmacy,
        cause: describeCause(cause),
      });
      return { kind: 'failed', status: 500, detail: 'inflight_begin_failed' };
    }

    let outcome = await this.send(order, pharmacy, decision.reason, deadline);
    let retries = 0;

    while (true) {
      if (outcome.kind === 'accepted') {
        return await this.recordSent(session, orderId, pharmacy, at, 201);
      }
      if (outcome.kind === 'duplicate') {
        return await this.recordSent(session, orderId, pharmacy, at, 409);
      }
      if (outcome.kind === 'rejected') {
        // 400/404：终局失败，不重试、不改派。
        await this.commitQuietly(orderId);
        this.deps.logger.error('order-dispatcher: 药房终局拒绝发单（不重试）', {
          order_id: orderId,
          pharmacy,
          status: outcome.status,
          message: outcome.message ?? null,
        });
        return { kind: 'failed', status: outcome.status, detail: outcome.message ?? 'rejected' };
      }

      // 5xx / 超时：同一药房内联退避重试，次数与等待由 Deadline 预算约束。
      if (retries >= INLINE_RETRY_DELAYS_MS.length) break;
      const delay = INLINE_RETRY_DELAYS_MS[retries];
      if (deadline.remainingMs() <= delay) {
        this.deps.logger.warn('order-dispatcher: 预算不足以再退避一次，转入后台重试', {
          order_id: orderId,
          remaining_ms: Math.floor(deadline.remainingMs()),
          next_delay_ms: delay,
        });
        break;
      }
      await (this.deps.sleep ?? defaultSleep)(delay);
      retries += 1;
      outcome = await this.send(order, pharmacy, decision.reason, deadline);
    }

    // 结果未知：清掉 WAL（否则下次重启会再重发一次，而重试队列自己会负责收敛），
    // 然后以**同一药房**入后台重试队列——绝不改派。
    await this.commitQuietly(orderId);
    const retryItem: RetryItem = { order, pharmacy, at, reason: decision.reason };
    this.deps.retry.enqueue(retryItem);
    this.deps.logger.warn('order-dispatcher: 内联重试仍失败，转入后台重试（同药房）', {
      order_id: orderId,
      pharmacy,
      attempts: retries + 1,
      last_kind: outcome.kind,
      ...(outcome.kind === 'retryable' && outcome.status !== undefined ? { status: outcome.status } : {}),
    });
    return {
      kind: 'deferred',
      ...(outcome.kind === 'retryable' && outcome.status !== undefined ? { status: outcome.status } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // 单次调用
  // -------------------------------------------------------------------------

  /** 一次网关调用；异常按「结果未知」处理（安全侧：绝不标记已发、绝不改派）。 */
  private async send(
    order: NormalizedOrder,
    pharmacy: PharmacyId | 'MANUAL',
    reason: string | null,
    deadline: Deadline,
  ): Promise<SendOutcome> {
    const timeoutMs = deadline.allocate(this.deps.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS);
    try {
      return await this.deps.gateway.send(
        {
          orderId: order.orderId,
          pharmacy,
          ...(reason === null ? {} : { reason }),
        },
        { timeoutMs },
      );
    } catch (cause) {
      this.deps.logger.error('order-dispatcher: gateway.send 抛异常，按结果未知处理（同药房重试）', {
        order_id: order.orderId,
        pharmacy,
        cause: describeCause(cause),
      });
      return { kind: 'retryable' };
    }
  }

  /** 201/409：标记已发 + 记容量（MANUAL 不占）+ commit WAL。 */
  private async recordSent(
    session: SimulationSession,
    orderId: string,
    pharmacy: PharmacyId | 'MANUAL',
    at: Instant,
    status: 201 | 409,
  ): Promise<DispatchResult> {
    session.sent.mark(orderId, pharmacy, at);
    if (pharmacy !== 'MANUAL') {
      // 容量按**决策时刻**的 ET 日记，不按「现在」（跨午夜发单不会算错日期）。
      session.capacity.record(pharmacy, this.deps.calendar.dateOf(at));
    }
    await this.commitQuietly(orderId);

    if (status === 201) {
      this.deps.logger.info('order-dispatcher: 发单成功', {
        order_id: orderId,
        pharmacy,
        at: this.deps.calendar.iso(at),
      });
    } else {
      this.deps.logger.warn('order-dispatcher: 药房返回 409，视为此前已发出（不重试）', {
        order_id: orderId,
        pharmacy,
        at: this.deps.calendar.iso(at),
      });
    }
    return { kind: status === 201 ? 'sent' : 'already_sent', status };
  }

  /** `inflight.commit` 失败只记日志：内存里已记 sent，重启恢复会按 409 收敛。 */
  private async commitQuietly(orderId: string): Promise<void> {
    try {
      await this.deps.inflight.commit(orderId);
    } catch (cause) {
      this.deps.logger.error('order-dispatcher: inflight.commit 失败（WAL 残留，重启会重发）', {
        order_id: orderId,
        cause: describeCause(cause),
      });
    }
  }
}
