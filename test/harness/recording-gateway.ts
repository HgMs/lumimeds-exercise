/**
 * 记录型假药房网关（`ARCHITECTURE.md` §12.3「集成重放夹具」）。
 *
 * 它实现生产端口 `PharmacyGateway`，但**不发真实 HTTP 请求**：
 * - 默认行为模拟 `sim/sim.mjs` 的药房 API：同一 `order_id` 第一次 → `201`，
 *   第二次 → `409`（已受理是终局）；
 * - `enqueue(...)` 可以按调用顺序注入 `201/409/400/404/5xx/timeout`，用来覆盖
 *   `OrderDispatcher` 的状态码表与 `RecoveryService` 的 WAL 恢复分支；
 * - 记录每一次 `send` 的 `{orderId, pharmacy, reason, timeoutMs, outcome}`，
 *   集成测试据此断言「38 单各一次」「绝不发到第二家药房」。
 *
 * `injectAcceptedButLost` 是给重启测试的显式窗口注入：模拟「POST 已到药房并返回
 * 201，但我们在 `sent.mark` / 快照提交前崩溃」——药房侧已受理，而我们的 WAL 里还留着
 * 这条在途记录。恢复时按 WAL 原样重发会拿到 `409`（§11.3 的已知代价）。
 */
import type { PharmacyGateway, SendOutcome } from '../../src/application/ports/pharmacy-gateway.ts';
import type { OrderId, PharmacyId } from '../../src/domain/types.ts';

/** 一次 `send` 的调用记录（含注入的「响应丢失」伪调用）。 */
export interface SendCall {
  readonly orderId: OrderId;
  readonly pharmacy: PharmacyId | 'MANUAL';
  readonly reason: string | null;
  readonly timeoutMs: number;
  readonly outcome: SendOutcome;
  /**
   * `accepted-lost`：这条记录是 `injectAcceptedButLost` 注入的「药房已受理、响应没回来」，
   * 不是本轮测试里一次正常的 `gateway.send` 返回。恢复时它会让下一次重发得到 409。
   */
  readonly injected?: 'accepted-lost';
}

/**
 * 按顺序注入的单次响应。
 *
 * `timeout` 是「结果未知」：上层只能对**同一药房**重发（`OrderDispatcher`/`RetryQueue`），
 * 绝不能改派。若想模拟「药房其实已经受理、只是响应丢了」，用
 * `injectAcceptedButLost()`（重启窗口测试）。
 */
export type GatewayScriptStep =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'rejected'; readonly status: 400 | 404; readonly message?: string }
  | { readonly kind: 'retryable'; readonly status?: number };

export class RecordingGateway implements PharmacyGateway {
  private base: string | undefined;
  /** 药房侧「已经受理过哪些单」——跨 container 重启保留（模拟真实药房）。 */
  private readonly recorded = new Map<OrderId, PharmacyId | 'MANUAL'>();
  private readonly script: GatewayScriptStep[] = [];
  /** 全部 `send` 调用（按发生顺序；含 `injectAcceptedButLost` 的伪调用）。 */
  readonly calls: SendCall[] = [];

  /** `simulation.started` / 恢复路径注入的 base URL（测试断言用）。 */
  get baseUrl(): string | undefined {
    return this.base;
  }

  setBaseUrl(url: string): void {
    const normalized = url.trim().replace(/\/+$/, '');
    if (normalized === '') {
      throw new Error('RecordingGateway.setBaseUrl: base URL must be non-empty');
    }
    this.base = normalized;
  }

  /** 排入后续调用的脚本响应（先入先出）；脚本用尽后回到默认「201/409」行为。 */
  enqueue(...steps: readonly GatewayScriptStep[]): void {
    this.script.push(...steps);
  }

  /** 尚未消费的脚本步数（测试断言用）。 */
  get pendingScript(): number {
    return this.script.length;
  }

  /** 清空脚本（不影响调用记录与药房侧已受理状态）。 */
  clearScript(): void {
    this.script.length = 0;
  }

  /** 清空「药房已经受理过哪些单」；用于同一 gateway 的第二周重放（让订单重新是 201）。 */
  clearPharmacyRecords(): void {
    this.recorded.clear();
  }

  /** 清空调用记录（保留脚本、base URL 与药房侧状态）。 */
  clearCalls(): void {
    this.calls.length = 0;
  }

  async send(
    req: { orderId: OrderId; pharmacy: PharmacyId | 'MANUAL'; reason?: string },
    opts: { timeoutMs: number },
  ): Promise<SendOutcome> {
    const outcome = this.nextOutcome(req);
    this.calls.push({
      orderId: req.orderId,
      pharmacy: req.pharmacy,
      reason: req.reason ?? null,
      timeoutMs: opts.timeoutMs,
      outcome,
    });
    return outcome;
  }

  // -------------------------------------------------------------------------
  // 查询辅助（集成测试用）
  // -------------------------------------------------------------------------

  /** 某个订单的全部调用（按发生顺序）。 */
  callsFor(orderId: OrderId): readonly SendCall[] {
    return this.calls.filter((call) => call.orderId === orderId);
  }

  /** 被发过单的订单 id（去重、保持首次出现顺序）。 */
  get orderIds(): readonly OrderId[] {
    return [...new Set(this.calls.map((call) => call.orderId))];
  }

  /** 断言用：某一单被发到过的药房集合。 */
  pharmaciesFor(orderId: OrderId): readonly (PharmacyId | 'MANUAL')[] {
    return [...new Set(this.calls.filter((call) => call.orderId === orderId).map((call) => call.pharmacy))];
  }

  /**
   * 注入「药房已受理（201）但响应在我们的快照提交前丢失」的窗口（§11.3）。
   *
   * 只给重启测试用：它把订单记进药房侧状态，并留下一条 `injected: 'accepted-lost'`
   * 的调用记录；之后 `RecoveryService` 按 WAL 重发同一单会得到 `409`。
   */
  injectAcceptedButLost(req: {
    orderId: OrderId;
    pharmacy: PharmacyId | 'MANUAL';
    reason?: string;
  }): void {
    this.recorded.set(req.orderId, req.pharmacy);
    this.calls.push({
      orderId: req.orderId,
      pharmacy: req.pharmacy,
      reason: req.reason ?? null,
      timeoutMs: 0,
      outcome: { kind: 'timeout' },
      injected: 'accepted-lost',
    });
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private nextOutcome(req: {
    orderId: OrderId;
    pharmacy: PharmacyId | 'MANUAL';
  }): SendOutcome {
    const step = this.script.shift();
    if (step === undefined) return this.deliver(req);
    switch (step.kind) {
      case 'accepted': {
        return this.deliver(req, { forceAccepted: true });
      }
      case 'duplicate': {
        this.recorded.set(req.orderId, req.pharmacy);
        return { kind: 'duplicate', status: 409 };
      }
      case 'timeout': {
        return { kind: 'timeout' };
      }
      case 'rejected': {
        return { kind: 'rejected', status: step.status, ...(step.message === undefined ? {} : { message: step.message }) };
      }
      case 'retryable': {
        return { kind: 'retryable', ...(step.status === undefined ? {} : { status: step.status }) };
      }
    }
  }

  /** 默认药房语义：未受理过 → 201 并记下；受理过 → 409。 */
  private deliver(
    req: { orderId: OrderId; pharmacy: PharmacyId | 'MANUAL' },
    options: { forceAccepted?: boolean } = {},
  ): SendOutcome {
    if (!options.forceAccepted && this.recorded.has(req.orderId)) {
      return { kind: 'duplicate', status: 409 };
    }
    this.recorded.set(req.orderId, req.pharmacy);
    return { kind: 'accepted', status: 201 };
  }
}
