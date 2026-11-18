/**
 * `ErrorMapper`：把传输/领域错误映射成 HTTP 响应（`ARCHITECTURE.md` §5.11、
 * `DATA-CONTRACTS.md` §1.5、§9）。
 *
 * 为什么要有这一层：400/413/500 的**语义**只在这里定义一次。`EnvelopeParser` 只
 * 返回 `IngestError`（码），`HttpServer` 只负责「读 body / 调 handler / 兜住异常」，
 * `WebhookHandler` 只把 `IngestResult` 翻成响应——三处都不该各自硬编码状态码。
 *
 * 映射表（§1.5 / §9）：
 *
 * | 情况 | 码 |
 * |---|---|
 * | body 不是 JSON / 缺 event_id,type,occurred_at / occurred_at 解析失败 | 400 |
 * | body 超过 1 MiB | 413（由 `HttpServer` 在读取阶段判定） |
 * | 未知 `type` | 200（不是错误，由 `IngestResult.status` 决定） |
 * | `simulation.started` 缺 config/pharmacyApi、config 不可用 | 500 |
 * | 无会话收到 `order`/`email` | 500 `no_session` |
 * | 副作用已发生但快照 3 次写失败、未预期异常 | 500 |
 *
 * 本文件不写日志（日志是 `HttpServer` 的职责：它知道方法、路径与耗时），也不读
 * 进程时钟。响应体形状固定为 `{ok:false, error:{code, message, ...}}`，方便排错；
 * `POST /webhooks` 成功的响应体仍是 `{ok:true}`（`DATA-CONTRACTS` §5）。
 */
import type { IngestError } from '../../application/ingest/envelope-parser.ts';
import type { ResponseSpec } from './request-context.ts';
import { response } from './request-context.ts';

/** `DATA-CONTRACTS` §1.5 里对应 400 的入站错误码。 */
const CLIENT_ERROR_CODES: ReadonlySet<string> = new Set([
  'bad_request',
  'missing_field',
  'bad_timestamp',
]);

/** 明确对应 404 的码（只有「查不到」这类查询语义）。 */
const NOT_FOUND_CODES: ReadonlySet<string> = new Set(['not_found']);

/** `IngestOutcome`（`ARCHITECTURE.md` §5.9）→ HTTP 状态码；`IngestResult.status` 的兜底来源。 */
const OUTCOME_STATUS: Readonly<Record<string, number>> = {
  started: 200,
  email_applied: 200,
  email_no_change: 200,
  email_rejected: 200,
  order_sent: 200,
  order_manual: 200,
  order_deferred: 200,
  duplicate: 200,
  ignored_type: 200,
  bad_request: 400,
  no_session: 500,
  persist_failed: 500,
  internal_error: 500,
};

/** 把任意 thrown 值变成可放进 JSON 的一行说明（不泄漏调用栈）。 */
function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

export class ErrorMapper {
  /**
   * 错误码 → HTTP 状态码（§1.5/§9）。
   *
   * 只有三个入站码是 400；其余已登记码（`persist_failed`、`bad_started_config`、
   * `gateway_failed` ……）都是服务端失败（500）。未知码一律 500：宁可暴露问题，
   * 不把「我们没想清楚」映射成 4xx 掩盖过去。
   */
  statusForCode(code: string): number {
    if (CLIENT_ERROR_CODES.has(code)) return 400;
    if (NOT_FOUND_CODES.has(code)) return 404;
    return 500;
  }

  /**
   * `IngestOutcome` → 状态码。`IngestResult.status` 是权威值；这个映射只用于
   * 测试/调试核对「outcome 与 status 是否自洽」，以及构造没有 status 的旧调用点。
   */
  statusForOutcome(outcome: string): number {
    return OUTCOME_STATUS[outcome] ?? 500;
  }

  /** `EnvelopeParser` 的失败值 → 400（不写盘、不建会话）。 */
  fromIngestError(error: IngestError): ResponseSpec {
    return response(400, {
      ok: false,
      error: { code: error.code, message: error.detail },
    });
  }

  /** 任意抛出的异常 → 500。调用方（`HttpServer`）负责先记日志。 */
  fromThrown(cause: unknown): ResponseSpec {
    return response(500, {
      ok: false,
      error: { code: 'internal_error', message: describe(cause) },
    });
  }

  /** 已登记的失败码 → 响应（如 persist_failed / bad_started_config → 500）。 */
  fromCode(code: string, message?: string, detail?: Record<string, unknown>): ResponseSpec {
    const status = this.statusForCode(code);
    return response(status, {
      ok: false,
      error: {
        code,
        message: message ?? code,
        ...(detail === undefined ? {} : { detail }),
      },
    });
  }

  /** 路由未命中 → 404（`GET /orders/:id` 的「没这个订单」由 handler 自己回）。 */
  notFound(method?: string, path?: string): ResponseSpec {
    return response(404, {
      ok: false,
      error: {
        code: 'not_found',
        message:
          method === undefined || path === undefined
            ? 'no route matches this request'
            : `no route matches ${method} ${path}`,
      },
    });
  }

  /** body 超过 1 MiB → 413（`HttpServer` 在读取阶段直接回，不进入解析）。 */
  payloadTooLarge(limitBytes: number): ResponseSpec {
    return response(413, {
      ok: false,
      error: {
        code: 'payload_too_large',
        message: `request body exceeds the ${String(limitBytes)}-byte limit`,
        limit_bytes: limitBytes,
      },
    });
  }
}
