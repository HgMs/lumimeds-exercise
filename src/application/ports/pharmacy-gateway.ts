/**
 * 药房发单端口（`ARCHITECTURE.md` §5.9、`DATA-CONTRACTS.md` §2）。
 *
 * 网关只做「一次调用 + 状态码翻译」，不做重试：重试是业务语义，属编排层。
 */
import type { OrderId, PharmacyId } from '../../domain/types.ts';

/** 一次发单调用的结果。 */
export type SendOutcome =
  | { kind: 'accepted'; status: 201 }
  | { kind: 'duplicate'; status: 409 }
  | { kind: 'rejected'; status: 400 | 404; message?: string }
  | { kind: 'retryable'; status?: number; message?: string }
  | { kind: 'timeout' };

export interface PharmacyGateway {
  send(
    req: { orderId: OrderId; pharmacy: PharmacyId | 'MANUAL'; reason?: string },
    opts: { timeoutMs: number },
  ): Promise<SendOutcome>;

  /** `simulation.started` 之后、以及恢复时由快照注入 base URL。 */
  setBaseUrl?(url: string): void;
}
