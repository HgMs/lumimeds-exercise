/**
 * `HealthHandler`：`GET /health`（`ARCHITECTURE.md` §5.11；
 * `DATA-CONTRACTS` §5）。
 *
 * 返回 `{ok, events, orders_sent, sam, pending_sends, degraded}`：
 * - `events` = 已处理事件数（`seen_event_ids.size`）；
 * - `orders_sent` = 本周已成功发出的订单数（`sent_orders` 条数）；
 * - `sam` = 被挂起的邮件数；
 * - `pending_sends` = 重试队列里的订单数（wiring 注入 `retryQueue.pending()`）；
 * - `degraded` = 写盘曾失败过（sticky）。
 *
 * **无会话时也回 200**（计数全 0，`pending_sends` 仍取真实队列）：/health 是存活探针，
 * 不是业务接口；服务进程活着就该回 2xx，让「还没收到 simulation.started」也能被探测到。
 */
import type { SessionHolder } from '../../../application/session/session-holder.ts';
import type { RequestContext, ResponseSpec } from '../request-context.ts';
import { response } from '../request-context.ts';

/** `RetryQueue.pending()` 的结构子集（避免 HTTP 层依赖具体重试实现）。 */
export interface PendingSendsSource {
  pending(): number;
}

export interface HealthHandlerDeps {
  readonly holder: SessionHolder;
  readonly retryQueue: PendingSendsSource;
}

/** `/health` 响应体（`DATA-CONTRACTS` §5）。 */
export interface HealthResponse {
  readonly ok: true;
  readonly events: number;
  readonly orders_sent: number;
  readonly sam: number;
  readonly pending_sends: number;
  readonly degraded: boolean;
}

export class HealthHandler {
  constructor(private readonly deps: HealthHandlerDeps) {}

  async handle(ctx: RequestContext): Promise<ResponseSpec> {
    void ctx; // 路径无参数；保留统一签名。
    const session = this.deps.holder.current();

    let events = 0;
    let ordersSent = 0;
    let sam = 0;
    let degraded = false;
    if (session !== null) {
      events = session.seenEventIds.size;
      ordersSent = [...session.sent.entries()].length;
      sam = session.sam.all().length;
      degraded = session.degraded;
    }

    const body: HealthResponse = {
      ok: true,
      events,
      orders_sent: ordersSent,
      sam,
      pending_sends: this.deps.retryQueue.pending(),
      degraded,
    };
    return response(200, body);
  }
}
