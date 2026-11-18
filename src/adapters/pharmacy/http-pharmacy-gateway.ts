/**
 * 药房 API 的 HTTP 适配器（`ARCHITECTURE.md` §5.9/§5.10；`DATA-CONTRACTS.md` §2.1）。
 *
 * 只做「一次调用 + 状态码翻译」，**不做重试**：重试是业务语义（同一药房、退避、
 * 预算），属 `OrderDispatcher`/`RetryQueue`。这样测试替身能精准注入
 * `duplicate`/`timeout`，而不用猜网关内部重试了几次。
 *
 * 关键不变量：
 * - `setBaseUrl` 由 `StartSimulationUseCase` 与 `RecoveryService`（快照里的
 *   `pharmacy_api`）调用；base 未设置就 `send` 属**不变量破坏**，直接抛
 *   （不是返回 `SendOutcome`）——静默发错地址比启动失败更糟。
 * - 超时只认 `opts.timeoutMs`（`Deadline.allocate(8_000)` 的结果），用
 *   `AbortSignal.timeout` 实现；超时与「连接被断」同属**结果未知**（§2.1），
 *   都映射成 `timeout`，由上层对同一药房重发（§5.9 R3-9），绝不改派。
 */
import type {
  PharmacyGateway,
  SendOutcome,
} from '../../application/ports/pharmacy-gateway.ts';
import type { Logger } from '../../kernel/logger.ts';
import type { OrderId, PharmacyId } from '../../domain/types.ts';

/** 可用于注入的最小 fetch 形状（默认为 `globalThis.fetch`，测试可换成假实现）。 */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** `HttpPharmacyGateway` 的构造参数。 */
export interface HttpPharmacyGatewayOptions {
  /** 默认 `globalThis.fetch`；测试注入假 fetch。 */
  fetch?: FetchLike;
  /** base URL（通常由 `setBaseUrl` 在 `simulation.started` 后注入，这里可预置）。 */
  baseUrl?: string;
  /** 可选日志：只记传输层告警，不改变返回值。 */
  logger?: Logger;
}

/** 状态码 → `SendOutcome` 的完整映射见文件末尾 `mapStatus`。 */
export class HttpPharmacyGateway implements PharmacyGateway {
  private readonly fetchImpl: FetchLike;
  private readonly logger: Logger | undefined;
  private baseUrl: string | undefined;

  constructor(options: HttpPharmacyGatewayOptions = {}) {
    const impl = options.fetch ?? globalThis.fetch;
    // 包一层，避免把 fetch 当方法调用时 `this` 绑定错误。
    this.fetchImpl = (input, init) => impl(input, init);
    this.logger = options.logger;
    this.baseUrl = options.baseUrl === undefined ? undefined : normalizeBaseUrl(options.baseUrl);
  }

  /** 注入药房 API 的 base URL（`simulation.started.pharmacyApi` / 快照里的 `pharmacy_api`）。 */
  setBaseUrl(url: string): void {
    this.baseUrl = normalizeBaseUrl(url);
  }

  async send(
    req: { orderId: OrderId; pharmacy: PharmacyId | 'MANUAL'; reason?: string },
    opts: { timeoutMs: number },
  ): Promise<SendOutcome> {
    const baseUrl = this.baseUrl;
    if (baseUrl === undefined) {
      // 评审 B2：不变量破坏，抛而不是返回一个「看起来合法」的 outcome。
      throw new Error(
        'HttpPharmacyGateway.send called before setBaseUrl(); pharmacy API base URL is unknown',
      );
    }

    const timeoutMs = opts.timeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      // 预算已经用完：没有请求可发，语义上等价于「超时/结果未知」。
      return { kind: 'timeout' };
    }

    const body = {
      order_id: req.orderId,
      pharmacy: req.pharmacy,
      // `reason` 可选：undefined 会被 JSON.stringify 丢掉，符合 §2.1 的「可选」。
      reason: req.reason,
    };

    let response: Response;
    try {
      response = await this.fetchImpl(`${baseUrl}/pharmacy-orders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      // 超时与「连接被断」在数据契约里是同一类：**结果未知**（§2.1）。
      // 两者都映射成 `timeout`，上层只对同一药房重发、绝不改派；区别只进日志，
      // 便于排查是「预算用完了」还是「网络/DNS 不通」。
      if (classifyTransportFailure(cause) === 'timeout') {
        this.logger?.warn('pharmacy send timed out', {
          order_id: req.orderId,
          pharmacy: req.pharmacy,
          timeout_ms: timeoutMs,
        });
      } else {
        this.logger?.warn('pharmacy send network error', {
          order_id: req.orderId,
          pharmacy: req.pharmacy,
          error: describeNetworkFailure(cause),
        });
      }
      return { kind: 'timeout' };
    }

    // 只在需要 message 时读响应体；201/409 不读，省一次 body 解析。
    const outcome = mapStatus(response.status);
    if (outcome.kind === 'rejected' || outcome.kind === 'retryable') {
      const message = await readResponseText(response);
      if (message !== undefined && message !== '') {
        return { ...outcome, message } as SendOutcome;
      }
    }
    return outcome;
  }
}

/** 去掉末尾斜杠；空白 URL 属配置错误，早失败。 */
function normalizeBaseUrl(url: string): string {
  const normalized = url.trim().replace(/\/+$/, '');
  if (normalized === '') {
    throw new Error('HttpPharmacyGateway: base URL must be a non-empty string');
  }
  return normalized;
}

/**
 * 状态码映射（`DATA-CONTRACTS` §2.1）：
 *
 * | 响应 | SendOutcome |
 * |---|---|
 * | 201 | `accepted` |
 * | 409 | `duplicate`（已发过；上层视为已发，不重试） |
 * | 400 / 404 | `rejected`（我们的 bug 或订单不在本周；重试不会成功） |
 * | 5xx（以及 408/429 这类可重试 4xx） | `retryable` |
 * | 其余非 2xx | `retryable`（契约外的状态按「结果未知」处理，安全侧） |
 *
 * 2xx 里只认 201：`accepted` 的 `status` 在端口类型里就是字面量 201，其余 2xx
 * 属契约外响应，按 `retryable` 交给上层（它会得到 409 从而收敛为已发）。
 */
function mapStatus(status: number): SendOutcome {
  if (status === 201) return { kind: 'accepted', status: 201 };
  if (status === 409) return { kind: 'duplicate', status: 409 };
  if (status === 400 || status === 404) return { kind: 'rejected', status };
  return { kind: 'retryable', status };
}

/** 响应体只留前 500 字符做 message，避免把大 body 带进日志/审计。 */
async function readResponseText(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text();
    const trimmed = text.trim();
    if (trimmed === '') return undefined;
    return trimmed.length <= 500 ? trimmed : `${trimmed.slice(0, 500)}…`;
  } catch {
    return undefined;
  }
}

/** 传输层错误分类：超时/外部 abort → `timeout`；其余（含 DNS/连接拒绝）→ network。 */
function classifyTransportFailure(cause: unknown): 'timeout' | 'network' {
  const name =
    typeof cause === 'object' && cause !== null && typeof (cause as { name?: unknown }).name === 'string'
      ? (cause as { name: string }).name
      : '';
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  return 'network';
}

/**
 * Node 22 的 `fetch` 失败时抛 `TypeError: fetch failed`，具体原因在 `cause`
 * （`ECONNREFUSED` / `ENOTFOUND` / `EAI_AGAIN` …）。把它们拼进 message 便于排查；
 * 没有 cause 时退回错误消息。
 */
function describeNetworkFailure(cause: unknown): string {
  if (typeof cause !== 'object' || cause === null) return `network error: ${String(cause)}`;
  const error = cause as { name?: unknown; message?: unknown; cause?: unknown };
  const name = typeof error.name === 'string' ? error.name : 'Error';
  const message = typeof error.message === 'string' ? error.message : String(cause);
  const nested = error.cause;
  if (typeof nested === 'object' && nested !== null) {
    const nestedError = nested as { message?: unknown; code?: unknown };
    const nestedMessage =
      typeof nestedError.message === 'string' ? nestedError.message : undefined;
    const code = typeof nestedError.code === 'string' ? nestedError.code : undefined;
    const detail = [code, nestedMessage].filter((part) => part !== undefined).join(': ');
    if (detail !== '') return `network error (${name}: ${message}) ${detail}`;
  }
  return `network error (${name}: ${message})`;
}
