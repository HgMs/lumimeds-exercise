/**
 * `SamHandler`：`GET /sam`（`ARCHITECTURE.md` §5.11；`DATA-CONTRACTS` §3.5）。
 *
 * 直接返回 `SamList.all()`（形状已按契约是 snake_case）。无会话 → 200 `[]`：
 * 与 `/state` 一样，「还没开始」不是错误，方便演示时探测。
 */
import type { SessionHolder } from '../../../application/session/session-holder.ts';
import type { SamEntry } from '../../../domain/email/sam-list.ts';
import type { RequestContext, ResponseSpec } from '../request-context.ts';
import { response } from '../request-context.ts';

export interface SamHandlerDeps {
  readonly holder: SessionHolder;
}

export class SamHandler {
  constructor(private readonly deps: SamHandlerDeps) {}

  async handle(ctx: RequestContext): Promise<ResponseSpec> {
    void ctx; // 路径无参数；保留统一签名。
    const session = this.deps.holder.current();
    const entries: readonly SamEntry[] = session === null ? [] : session.sam.all();
    return response(200, entries);
  }
}
