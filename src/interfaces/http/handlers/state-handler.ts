/**
 * `StateHandler`：`GET /state`（`ARCHITECTURE.md` §5.11；`DATA-CONTRACTS` §3.3）。
 *
 * 在会话的 `lastEventAt`（**最后一次事件时刻**，不是进程时钟）对每家药房求值出
 * `PharmacyView[]`：展示「此刻我们相信什么」。求值走 `BeliefResolver.view`，与
 * 路由用的 `PharmacyBelief` 是同一套判断，不存在「展示一套、判定另一套」。
 *
 * 无会话 → 200 `[]`（`DATA-CONTRACTS` §5：不报错，方便演示时探测）。
 */
import type { BeliefResolver } from '../../../domain/belief/belief-resolver.ts';
import type { PharmacyView } from '../../../domain/belief/pharmacy-view.ts';
import type { SessionHolder } from '../../../application/session/session-holder.ts';
import type { RequestContext, ResponseSpec } from '../request-context.ts';
import { response } from '../request-context.ts';

export interface StateHandlerDeps {
  readonly holder: SessionHolder;
  readonly resolver: BeliefResolver;
}

export class StateHandler {
  constructor(private readonly deps: StateHandlerDeps) {}

  async handle(ctx: RequestContext): Promise<ResponseSpec> {
    void ctx; // 路径无参数；保留统一签名。
    const session = this.deps.holder.current();
    if (session === null) return response(200, []);

    const at = session.lastEventAt;
    const sources = { facts: session.facts, capacity: session.capacity };
    const views: PharmacyView[] = session.registry
      .all()
      .map((base) => this.deps.resolver.view(base, at, sources));
    return response(200, views);
  }
}
