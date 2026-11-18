/**
 * `RetryQueue`：发单推迟后的后台重试（`ARCHITECTURE.md` §5.9「RetryQueue」、§6.4）。
 *
 * 两条不可动摇的语义：
 * 1. **只重发同一个药房，绝不重新路由**（复审 R3-9）：能进队列的只有「结果未知」
 *    （超时/5xx）或「事件预算耗尽、根本没发」两种情况；重发是幂等的（`409` 会确认
 *    「已发」），重新路由会把同一单发给两家药房，那是本系统最坏的失败模式。
 * 2. **每次重试也经同一个 `SerialQueue`**：后台重试不能插在某个事件处理中间
 *    （包括插在别人 `stateStore.save` 的 await 之间），否则会读到半更新状态。
 *
 * 时间语义：定时器只决定「什么时候再试一次」，业务时间仍然是订单的 `occurred_at`
 * （`item.at`）。容量按 `item.at` 的 ET 日记账，绝不用重试时刻。
 *
 * 依赖为什么用 `SessionHolder` 而不是直接注入 `sent`/`capacity`/`decisions`：
 * 这三个对象属于**当前会话**，`simulation.started` 会换掉整个会话。若构造时把旧会话
 * 的日志注入进来，新周重试就会写进旧对象（快照里根本看不到）。所以这里统一从
 * `holder.requireSession()` 取（与 `EventProcessor` 同一份真值）。
 *
 * 重试成功后要做四件事（缺一个就会自相矛盾，§5.9）：
 * 1. `sent.mark` + `capacity.record`（`MANUAL` 不占容量）；
 * 2. `decisions.attachSend` 并确保同 `order_id` 的 decision 已在日志里（upsert）；
 * 3. `recorder.record(d)` → `recorder.flush()`（审计唯一写入口仍是 `AuditRecorder`）；
 * 4. `stateStore.save(mapper.toPersisted(session))`：否则「发了但没落盘」会在重启或
 *    `/orders/:id` 上暴露。
 */
import type { Logger } from '../../kernel/logger.ts';
import type { SerialQueue } from '../../kernel/serial-queue.ts';
import { Deadline } from '../../kernel/deadline.ts';
import type { EtCalendar } from '../../kernel/time/et-calendar.ts';
import type { Instant } from '../../kernel/time/instant.ts';
import type { AuditRecorder } from '../audit/audit-recorder.ts';
import type { PharmacyGateway, SendOutcome } from '../ports/pharmacy-gateway.ts';
import type { StateStore } from '../ports/state-store.ts';
import type { SessionHolder } from '../session/session-holder.ts';
import type { SimulationSession } from '../session/simulation-session.ts';
import type { SnapshotMapper } from '../session/snapshot-mapper.ts';
import type { NormalizedOrder } from '../../domain/normalize/order-normalizer.ts';
import type { RoutingDecision } from '../../domain/routing/decision.ts';
import type { PharmacyId } from '../../domain/types.ts';

/** 一条待重试的发单。`pharmacy` 就是首次发单时选定的那家，永不改变。 */
export interface RetryItem {
  order: NormalizedOrder;
  pharmacy: PharmacyId | 'MANUAL';
  /** 原始决策时刻（订单事件的 `occurred_at`），容量按它的 ET 日记账。 */
  at: Instant;
  reason: string | null;
}

/** `RetryQueue` 的构造依赖（会话内对象一律经 `holder` 取，见文件头）。 */
export interface RetryQueueDeps {
  /** 与 `EventProcessor` 共用的同一个串行队列。 */
  queue: SerialQueue;
  holder: SessionHolder;
  gateway: PharmacyGateway;
  calendar: EtCalendar;
  recorder: AuditRecorder;
  stateStore: StateStore;
  mapper: SnapshotMapper;
  logger: Logger;
  /** 单次重试的发送超时；默认 8_000ms（与首次发单一致）。测试可调小。 */
  sendTimeoutMs?: number;
  /** 默认 `start` 的调度间隔；默认 1_000ms。 */
  intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_SEND_TIMEOUT_MS = 8_000;

export class RetryQueue {
  /** `order_id` → 待重试项（同一单重复入队是 upsert，不会发出两次）。 */
  private readonly entries = new Map<string, RetryItem>();
  private timer: ReturnType<typeof setInterval> | undefined;
  /** 已有一个 tick 排进 SerialQueue 时不再重复排队（避免积压）。 */
  private tickScheduled = false;

  constructor(private readonly deps: RetryQueueDeps) {}

  /** 入队（幂等 upsert）：只重发同一药房，绝不重新路由。 */
  enqueue(item: RetryItem): void {
    const orderId = item.order.orderId;
    const replaced = this.entries.has(orderId);
    this.entries.set(orderId, {
      order: { ...item.order },
      pharmacy: item.pharmacy,
      at: item.at,
      reason: item.reason,
    });
    this.deps.logger.info(replaced ? 'retry-queue: 同一单再次入队（覆盖旧项）' : 'retry-queue: 发单推迟，已入队', {
      order_id: orderId,
      pharmacy: item.pharmacy,
      pending: this.entries.size,
    });
  }

  /** 当前待重试数量（`/health` 与测试用）。 */
  pending(): number {
    return this.entries.size;
  }

  /**
   * 开始周期性重试（只做调度，不读业务时间）。重复调用不会创建第二个定时器。
   *
   * 定时器 `unref()`：它不该阻止进程退出；退出前由 wiring 调 `drain()` 把该发的
   * 发完（§6.4）。
   */
  start(intervalMs: number = this.deps.intervalMs ?? DEFAULT_INTERVAL_MS): void {
    if (this.timer !== undefined) {
      this.deps.logger.warn('retry-queue: start() 被重复调用，保持原定时器', { interval_ms: intervalMs });
      return;
    }
    const period = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_INTERVAL_MS;
    const timer = setInterval(() => {
      this.scheduleTick();
    }, period);
    timer.unref?.();
    this.timer = timer;
    this.deps.logger.info('retry-queue: 已启动', { interval_ms: period });
  }

  /**
   * 清空待重试项（`simulation.started` 开新周时用：旧周的在途/推迟单不该发进新周）。
   *
   * **只清条目，不停止定时器**：发单对象是进程级单例，`simulation.started` 之后同一
   * 个队列还要继续服务新周（定时器停了新周的 deferred 单就永远不发）。停机时停表是
   * `drain()` 的职责。
   */
  clear(): void {
    if (this.entries.size > 0) {
      this.deps.logger.info('retry-queue: clear() 丢弃旧周的推迟单', { dropped: this.entries.size });
    }
    this.entries.clear();
  }

  /**
   * 停机前把当前队列尽量发完：停掉定时器，然后在 `timeoutMs` 预算内对每个待重试项
   * 再尝试一次（仍失败就留在队列里，交给调用方决定——进程随后退出）。
   */
  async drain(timeoutMs: number): Promise<void> {
    this.clearTimer();
    const budget = Math.max(0, timeoutMs);
    const startedAtMs = performance.now();
    try {
      await this.deps.queue.run(async () => {
        for (const item of [...this.entries.values()]) {
          if (performance.now() - startedAtMs >= budget) {
            this.deps.logger.warn('retry-queue: drain 预算耗尽，剩余推迟单未重试', {
              remaining: this.entries.size,
              timeout_ms: budget,
            });
            return;
          }
          await this.attempt(item);
        }
      });
    } catch (cause) {
      this.deps.logger.error('retry-queue: drain 失败（推迟单可能丢失）', { cause });
    }
  }

  // -------------------------------------------------------------------------
  // 调度与尝试
  // -------------------------------------------------------------------------

  private clearTimer(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 把一次「处理当前队列」排进共享 SerialQueue（保证不与 webhook 事件交错）。 */
  private scheduleTick(): void {
    if (this.tickScheduled) return;
    this.tickScheduled = true;
    const task = this.deps.queue.run(async () => {
      try {
        await this.processPending();
      } finally {
        this.tickScheduled = false;
      }
    });
    // SerialQueue 会把异常只抛给本任务的调用方；没人 await 时必须自己接住。
    task.catch((cause: unknown) => {
      this.tickScheduled = false;
      this.deps.logger.error('retry-queue: tick 处理失败', { cause });
    });
  }

  private async processPending(): Promise<void> {
    if (!this.deps.holder.hasSession()) {
      this.deps.logger.warn('retry-queue: 当前无会话，跳过本轮重试', { pending: this.entries.size });
      return;
    }
    for (const item of [...this.entries.values()]) {
      await this.attempt(item);
    }
  }

  /**
   * 对一条待重试项做一次发送尝试。
   *
   * 返回语义只用于日志/测试：成功或终局失败会从队列移除；结果未知的保留到下一轮。
   */
  private async attempt(item: RetryItem): Promise<'done' | 'retry' | 'failed'> {
    const holder = this.deps.holder;
    if (!holder.hasSession()) return 'retry';
    const session = holder.requireSession();
    const orderId = item.order.orderId;

    // 每次重试前再查 sent：模拟器重投/恢复路径并发时也不会双发（INV-2）。
    if (session.sent.has(orderId)) {
      this.entries.delete(orderId);
      this.deps.logger.info('retry-queue: 该单已在发送前确认发出，移出队列', { order_id: orderId });
      return 'done';
    }

    const deadline = Deadline.after(item.at, this.deps.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS);
    const outcome = await this.send(orderId, item, deadline);

    if (outcome.kind === 'accepted' || outcome.kind === 'duplicate') {
      const status = outcome.kind === 'accepted' ? 201 : 409;
      await this.recordSuccess(session, item, status);
      this.entries.delete(orderId);
      return 'done';
    }

    if (outcome.kind === 'rejected') {
      // 400/404 是终局：重试不会成功。不重新路由（那会改派到另一家，最坏失败模式）。
      this.entries.delete(orderId);
      this.deps.logger.error('retry-queue: 重试被终局拒绝，不再重试', {
        order_id: orderId,
        pharmacy: item.pharmacy,
        status: outcome.status,
        message: outcome.message ?? null,
      });
      return 'failed';
    }

    // timeout / retryable：结果未知，保留同药房重试。
    this.deps.logger.warn('retry-queue: 本次重试结果未知，保留到下一轮（同药房）', {
      order_id: orderId,
      pharmacy: item.pharmacy,
      kind: outcome.kind,
    });
    return 'retry';
  }

  /** 一次网关调用；异常按「结果未知」处理（安全侧：绝不改派、绝不标记已发）。 */
  private async send(
    orderId: string,
    item: RetryItem,
    deadline: Deadline,
  ): Promise<SendOutcome> {
    const timeoutMs = deadline.allocate(this.deps.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS);
    try {
      return await this.deps.gateway.send(
        {
          orderId,
          pharmacy: item.pharmacy,
          ...(item.reason === null ? {} : { reason: item.reason }),
        },
        { timeoutMs },
      );
    } catch (cause) {
      this.deps.logger.error('retry-queue: gateway.send 抛异常，按结果未知处理（同药房重试）', {
        order_id: orderId,
        pharmacy: item.pharmacy,
        cause,
      });
      return { kind: 'retryable' };
    }
  }

  /**
   * 重试成功后的四件事（见文件头）。所有写盘/审计失败都只记日志、不改变「已发」事实：
   * `sent.mark` 已在内存里，随后的快照若失败会把 `session.degraded` 置真。
   */
  private async recordSuccess(
    session: SimulationSession,
    item: RetryItem,
    status: 201 | 409,
  ): Promise<void> {
    const orderId = item.order.orderId;

    // 1) 已发 + 容量（MANUAL 不占容量，容量按原始决策时刻的 ET 日）。
    session.sent.mark(orderId, item.pharmacy, item.at);
    if (item.pharmacy !== 'MANUAL') {
      session.capacity.record(item.pharmacy, this.deps.calendar.dateOf(item.at));
    }

    // 2) decision：已有则补 sent，没有则构造一条（防御；正常路径主流水线已记录）。
    if (session.decisions.get(orderId) !== undefined) {
      session.decisions.attachSend(orderId, { status, at: item.at });
    } else {
      session.decisions.record(this.buildFallbackDecision(item, status));
    }
    const decision = session.decisions.get(orderId);
    if (decision !== undefined) this.deps.recorder.record(decision);

    // 3) 快照（temp + rename 由 StateStore 保证原子）。
    try {
      const saved = await this.deps.stateStore.save(this.deps.mapper.toPersisted(session));
      if (!saved.ok) {
        session.degraded = true;
        this.deps.logger.error('retry-queue: 重试成功后快照写盘失败（degraded=true）', {
          order_id: orderId,
          code: saved.error.code,
          message: saved.error.message,
        });
      }
    } catch (cause) {
      session.degraded = true;
      this.deps.logger.error('retry-queue: 快照序列化/写盘抛异常（degraded=true）', {
        order_id: orderId,
        cause,
      });
    }

    // 4) 审计（AuditRecorder 内部吞错；flush 失败只记日志）。
    await this.deps.recorder.flush();

    if (status === 201) {
      this.deps.logger.info('retry-queue: 重试发送成功', {
        order_id: orderId,
        pharmacy: item.pharmacy,
        at: this.deps.calendar.iso(item.at),
      });
    } else {
      this.deps.logger.warn('retry-queue: 重试返回 409，视为此前已发出', {
        order_id: orderId,
        pharmacy: item.pharmacy,
      });
    }
  }

  /** 防御：主流水线没留下 decision 时（不应发生），构造一条最小可解释的记录。 */
  private buildFallbackDecision(item: RetryItem, status: 201 | 409): RoutingDecision {
    return {
      orderId: item.order.orderId,
      at: item.at,
      order: item.order,
      chosen: item.pharmacy,
      basis: 'manual',
      reason: item.reason ?? 'retry_after_deferral',
      candidates: [],
      preference: null,
      override: null,
      sent: { status, at: item.at },
    };
  }
}
