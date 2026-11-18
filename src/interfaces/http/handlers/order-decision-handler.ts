/**
 * `OrderDecisionHandler`：`GET /orders/:id`（`ARCHITECTURE.md` §5.11；
 * `DATA-CONTRACTS` §3.4）。
 *
 * 「解释某个订单的路由决定」是审计/演示入口：返回落盘/审计同款的
 * `PersistedRoutingDecision`（snake_case，时间用 ET 偏移），所以 `GET /orders/:id`
 * 的输出与 `out/decisions.jsonl` 里那一行**逐字段一致**——转换只有
 * `SnapshotMapper.toPersistedDecision` 一处。
 *
 * 查不到（没这个订单，或还没有会话）→ 404；不区分「会话不存在」与「订单不存在」，
 * 因为对调用方来说都是「我这里没有这条记录」。
 */
import { toPersistedDecision } from '../../../application/session/snapshot-mapper.ts';
import type { SessionHolder } from '../../../application/session/session-holder.ts';
import type { EtCalendar } from '../../../kernel/time/et-calendar.ts';
import type { RequestContext, ResponseSpec } from '../request-context.ts';
import { response } from '../request-context.ts';
import { requireParam } from '../router.ts';

export interface OrderDecisionHandlerDeps {
  readonly holder: SessionHolder;
  /** 决策时间统一输出 ET 偏移（与快照/审计同一规则）。 */
  readonly calendar: EtCalendar;
}

export class OrderDecisionHandler {
  constructor(private readonly deps: OrderDecisionHandlerDeps) {}

  async handle(ctx: RequestContext): Promise<ResponseSpec> {
    const orderId = requireParam(ctx, 'id');
    const session = this.deps.holder.current();
    if (session === null) {
      return notFound(orderId);
    }
    const decision = session.decisions.get(orderId);
    if (decision === undefined) {
      return notFound(orderId);
    }
    return response(200, toPersistedDecision(decision, this.deps.calendar));
  }
}

/** 404 响应体与 `ErrorMapper` 的形状一致，附上被查的订单 id 便于排错。 */
function notFound(orderId: string): ResponseSpec {
  return response(404, {
    ok: false,
    error: { code: 'not_found', message: `no routing decision for order ${JSON.stringify(orderId)}` },
  });
}
