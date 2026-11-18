/**
 * `WebhookHandler`：`POST /webhooks`（`ARCHITECTURE.md` §5.11）。
 *
 * 只做三件事：读 `ctx.body` → `processor.process({body, headers})` → 把 `IngestResult`
 * 翻成响应。**它不知道 fact、药房、订单是什么**，也不知道 JSON 解析规则——那些都在
 * `EventProcessor` / `EnvelopeParser` 里。
 *
 * 响应契约（`DATA-CONTRACTS` §5）：
 * - 成功（2xx）→ 固定 `{"ok":true}`，只表达「我收到了」；路由结果去 `/orders/:id`
 *   与 `out/run-log.jsonl` 查；
 * - 失败（400/413/500）→ `ErrorMapper` 的 `{ok:false, error:{code,...}}`，HTTP 状态码
 *   由 `IngestOutcome` 决定（`no_session` / `persist_failed` → 500）。
 *
 * 为什么这里用一个「结构化的 processor 端口」而不是直接 import `EventProcessor`：
 * HTTP 层只需要 `process(input) → IngestResult` 这一件事；用结构类型让 handler 单测
 * 可以注入一个 3 行的替身，同时真实的 `EventProcessor` 天然满足它（wiring 会做类型
 * 检查）。这不是重复实现流水线，只是接口隔离。
 */
import type { RequestContext, ResponseSpec } from '../request-context.ts';
import { response } from '../request-context.ts';
import { ErrorMapper } from '../error-mapper.ts';

/**
 * `IngestResult` 的结构子集（`ARCHITECTURE.md` §5.9：`{status, outcome}`）。
 * 真实的 `EventProcessor.process` 返回同形状对象，wiring 里做类型检查；
 * 这里不 import 它，避免 HTTP 层与主流水线互相绑定到具体类。
 */
export interface IngestResultLike {
  readonly status: number;
  readonly outcome: string;
}

/** `POST /webhooks` 的处理器端口（`EventProcessor.process` 的子集）。 */
export interface WebhookProcessor {
  process(input: {
    body: string;
    headers: Record<string, string | undefined>;
  }): Promise<IngestResultLike>;
}

export interface WebhookHandlerDeps {
  readonly processor: WebhookProcessor;
  /** 测试接缝；默认 `new ErrorMapper()`。 */
  readonly errorMapper?: ErrorMapper;
}

export class WebhookHandler {
  private readonly processor: WebhookProcessor;
  private readonly errorMapper: ErrorMapper;

  constructor(deps: WebhookHandlerDeps) {
    this.processor = deps.processor;
    this.errorMapper = deps.errorMapper ?? new ErrorMapper();
  }

  /** `RouteHandler` 签名；异常向上抛给 `HttpServer`（→ 500 + logger.error）。 */
  async handle(ctx: RequestContext): Promise<ResponseSpec> {
    const result = await this.processor.process({ body: ctx.body, headers: ctx.headers });
    if (result.status >= 400) {
      return this.errorMapper.fromCode(result.outcome, `ingest rejected: ${result.outcome}`);
    }
    return response(result.status, { ok: true });
  }
}
