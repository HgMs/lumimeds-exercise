/**
 * HTTP 层的最小请求/响应形状（`ARCHITECTURE.md` §5.11）。
 *
 * 这里刻意不依赖 Node 的 `IncomingMessage`/`ServerResponse`：handler 与 Router 只认
 * 这个纯数据结构，于是「路由匹配」「错误映射」「handler 行为」都能在没有 socket 的
 * 单测里直接验证；Node 适配只发生在 `server.ts` 一处。
 */

/** 一次请求的只读视图（由 `HttpServer` 从 Node 请求构造）。 */
export interface RequestContext {
  /** 大写方法，例如 `POST`。 */
  readonly method: string;
  /** 去掉 query 的路径，例如 `/orders/ORD-1001`。 */
  readonly path: string;
  /** 路径参数，例如 `/orders/:id` 匹配出的 `{ id: "ORD-1001" }`。 */
  readonly params: Record<string, string>;
  /** 请求头；值为 `undefined` 表示缺失。键名按 Node 的习惯是**小写**，handler 不区分大小写。 */
  readonly headers: Record<string, string | undefined>;
  /** 原始请求体文本（JSON 解析交给 `EnvelopeParser`，HTTP 层不解析）。 */
  readonly body: string;
}

/** handler / Router 的统一返回：HTTP 状态码 + 可 JSON 序列化的响应体。 */
export interface ResponseSpec {
  readonly status: number;
  readonly json: unknown;
}

/** 路由处理函数。所有 handler 类都提供一个符合该签名的方法。 */
export type RouteHandler = (ctx: RequestContext) => Promise<ResponseSpec>;

/** 便捷构造（测试与 handler 共用）。 */
export function response(status: number, json: unknown): ResponseSpec {
  return { status, json };
}
