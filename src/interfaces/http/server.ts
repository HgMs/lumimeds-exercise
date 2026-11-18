/**
 * `HttpServer`：Node `http` 的薄适配层（`ARCHITECTURE.md` §5.11）。
 *
 * 职责刻意收得很窄（不解析 JSON、不认识事件），只做四件事：
 * 1. 读请求体，**上限 1 MiB**；超限直接 413，不把大 body 读进内存；
 * 2. 把 Node 请求折成 `RequestContext` 交给 `Router`；
 * 3. 路由未命中 → 404；任何未捕获异常 → 500 + `logger.error`（状态码统一由
 *    `ErrorMapper` 决定，本文件不硬编码语义）；
 * 4. 每个请求记一行耗时日志（method/path/status/duration_ms）。
 *
 * 不变量：
 * - **不读进程时钟做业务判断**：`performance.now()` 只用来量耗时（与 `Deadline` 同理）；
 * - `listen()` 返回**实际端口**（测试传 0 让内核分配）；
 * - `close()` 幂等；先停接受新连接、再关空闲连接，最后兜底 5s 强制断开。
 */
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http';

import type { Logger } from '../../kernel/logger.ts';
import { ErrorMapper } from './error-mapper.ts';
import type { RequestContext, ResponseSpec } from './request-context.ts';
import type { Router } from './router.ts';

/** body 读取上限（`DATA-CONTRACTS` §1.5 / `ARCHITECTURE` §5.11）：1 MiB。 */
export const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;

/** `close()` 的兜底：活动连接超过该时长仍未结束就强制断开。 */
const CLOSE_GRACE_MS = 5_000;

export interface HttpServerDeps {
  readonly router: Router;
  /** 监听端口；0 = 内核分配（测试用）。 */
  readonly port: number;
  /** 监听地址；缺省时交给 Node 决定（双栈，localhost 可达）。 */
  readonly host?: string;
  /** 请求体上限，默认 1 MiB。 */
  readonly bodyLimitBytes?: number;
  readonly logger: Logger;
  /** 测试接缝：默认 `new ErrorMapper()`。 */
  readonly errorMapper?: ErrorMapper;
}

/** 读 body 的结果：成功给文本；失败区分「太大」与「连接坏了」。 */
type BodyReadResult =
  | { readonly ok: true; readonly body: string }
  | { readonly ok: false; readonly reason: 'too_large' | 'read_error'; readonly message: string };

/** 从 `req.url` 取 pathname（剥掉 query）；无法解析时退化为按 `?` 切。 */
function pathOf(rawUrl: string | undefined): string {
  if (rawUrl === undefined || rawUrl === '') return '/';
  try {
    return new URL(rawUrl, 'http://http-server.invalid').pathname;
  } catch {
    const withoutQuery = rawUrl.split('?')[0];
    return withoutQuery === undefined || withoutQuery === '' ? '/' : withoutQuery;
  }
}

/** Node 请求头 → 纯 Record；数组值（重复头）用 `, ` 连接。 */
function headersOf(headers: IncomingHttpHeaders): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

export class HttpServer {
  private readonly deps: HttpServerDeps;
  private readonly errorMapper: ErrorMapper;
  private readonly bodyLimitBytes: number;
  private server: Server | undefined;
  private listeningPort: number | undefined;

  constructor(deps: HttpServerDeps) {
    this.deps = deps;
    this.errorMapper = deps.errorMapper ?? new ErrorMapper();
    this.bodyLimitBytes =
      deps.bodyLimitBytes === undefined ? DEFAULT_BODY_LIMIT_BYTES : deps.bodyLimitBytes;
  }

  /** 实际监听端口；未监听时 `undefined`。 */
  get port(): number | undefined {
    return this.listeningPort;
  }

  /**
   * 开始监听，返回实际端口（端口传 0 时由内核分配）。
   * 重复调用是程序错误，直接抛（不做隐式重启）。
   */
  async listen(): Promise<number> {
    if (this.server !== undefined) throw new Error('HttpServer.listen called more than once');

    const server = createServer((req, res) => {
      // 每条请求独立异步处理；并发与串行语义由 EventProcessor 的 SerialQueue 保证。
      void this.handle(req, res);
    });
    this.server = server;

    const port = await new Promise<number>((resolve, reject) => {
      const onError = (cause: NodeJS.ErrnoException): void => {
        server.off('listening', onListening);
        reject(
          new Error(
            `HttpServer could not listen on port ${String(this.deps.port)}: ${cause.message}`,
          ),
        );
      };
      const onListening = (): void => {
        server.off('error', onError);
        const address = server.address();
        resolve(
          typeof address === 'object' && address !== null ? address.port : this.deps.port,
        );
      };
      server.once('error', onError);
      server.once('listening', onListening);
      if (this.deps.host === undefined) server.listen(this.deps.port);
      else server.listen(this.deps.port, this.deps.host);
    });

    this.listeningPort = port;
    this.deps.logger.info('http server listening', {
      port,
      body_limit_bytes: this.bodyLimitBytes,
      routes: this.deps.router.size,
    });
    return port;
  }

  /**
   * 停止监听并关闭连接。
   *
   * 先 `server.close()` 停止接受新连接 → 关空闲 keep-alive 连接 → 若 5s 后仍有
   * 活动连接（卡住的 handler），强制 `closeAllConnections()` 兜底，保证 shutdown 不挂。
   * 幂等：未监听时直接返回。
   */
  async close(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    this.server = undefined;
    this.listeningPort = undefined;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        server.closeAllConnections();
      }, CLOSE_GRACE_MS);
      timer.unref();
      server.close((cause) => {
        clearTimeout(timer);
        if (cause === undefined) resolve();
        else reject(cause);
      });
      // 不等待「还在发请求的客户端」：idle keep-alive 连接是唯一的阻塞源，先关掉。
      server.closeIdleConnections();
    });
  }

  /** 单请求处理：读 body → 路由 → handler → 写响应 → 记一行耗时。 */
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startedAtRealMs = performance.now();
    const method = (req.method ?? 'GET').toUpperCase();
    const path = pathOf(req.url);

    let spec: ResponseSpec;
    try {
      const read = await this.readBody(req);
      if (!read.ok) {
        if (read.reason === 'too_large') {
          spec = this.errorMapper.payloadTooLarge(this.bodyLimitBytes);
        } else {
          this.deps.logger.error('http request body could not be read', {
            method,
            path,
            detail: read.message,
          });
          spec = this.errorMapper.fromThrown(new Error(`request body read failed: ${read.message}`));
        }
      } else {
        const match = this.deps.router.match(method, path);
        if (match === null) {
          spec = this.errorMapper.notFound(method, path);
        } else {
          const ctx: RequestContext = {
            method,
            path,
            params: match.params,
            headers: headersOf(req.headers),
            body: read.body,
          };
          spec = await match.handler(ctx);
        }
      }
    } catch (cause) {
      // 未捕获异常是 bug/基础设施故障：500，并且必须留日志（§9）。
      this.deps.logger.error('http request handler threw', {
        method,
        path,
        error: cause,
      });
      spec = this.errorMapper.fromThrown(cause);
    }

    this.writeJson(res, spec);

    const durationMs = Math.round((performance.now() - startedAtRealMs) * 100) / 100;
    this.deps.logger.info('http request', {
      method,
      path,
      status: spec.status,
      duration_ms: durationMs,
    });
  }

  /** 写入 JSON 响应；客户端提前断开时静默跳过（连接错误不是服务端 bug）。 */
  private writeJson(res: ServerResponse, spec: ResponseSpec): void {
    if (res.writableEnded || res.destroyed) return;
    let status = spec.status;
    let payload: string;
    try {
      payload = JSON.stringify(spec.json ?? null);
    } catch (cause) {
      // handler 返回了不可序列化的值：这是实现 bug，切换成 500 而不是崩掉进程。
      status = 500;
      payload = JSON.stringify({
        ok: false,
        error: { code: 'internal_error', message: `response is not JSON-serializable: ${String(cause)}` },
      });
    }
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('content-length', String(Buffer.byteLength(payload)));
    res.end(payload);
  }

  /**
   * 读请求体（上限内的字节），超限后**停止缓冲**但继续丢弃剩余数据：
   * 若此时立刻断开，客户端可能收不到 413（Node 会先 reset 连接）。丢弃比断连更稳。
   */
  private readBody(req: IncomingMessage): Promise<BodyReadResult> {
    return new Promise<BodyReadResult>((resolve) => {
      let chunks: Buffer[] = [];
      let size = 0;
      let tooLarge = false;
      let settled = false;

      const settle = (result: BodyReadResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      req.on('data', (chunk: Buffer | string) => {
        if (settled) return;
        const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        size += buffer.length;
        if (!tooLarge && size > this.bodyLimitBytes) {
          tooLarge = true;
          chunks = []; // 丢掉已缓冲的部分，把内存让给「丢弃模式」
          return;
        }
        if (!tooLarge) chunks.push(buffer);
      });

      req.on('end', () => {
        if (tooLarge) {
          settle({
            ok: false,
            reason: 'too_large',
            message: `request body exceeds ${String(this.bodyLimitBytes)} bytes (read at least ${String(size)})`,
          });
          return;
        }
        settle({ ok: true, body: Buffer.concat(chunks).toString('utf8') });
      });

      req.on('error', (cause: unknown) => {
        settle({
          ok: false,
          reason: 'read_error',
          message: cause instanceof Error ? cause.message : String(cause),
        });
      });

      // 客户端在 body 未发完时断开（`req.complete === false`）。
      req.on('close', () => {
        if (req.complete || settled) return;
        settle({ ok: false, reason: 'read_error', message: 'client closed the connection early' });
      });
    });
  }
}
