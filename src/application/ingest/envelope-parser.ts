/**
 * `EnvelopeParser`：把 webhook 的 HTTP body 解析成入站信封
 * （`ARCHITECTURE.md` §5.9；`DATA-CONTRACTS.md` §1.1/§1.5）。
 *
 * 边界（严格照 §5.9/§1.5）：
 * - **只用 body**。`x-event-id` / `x-sim-time` 头只做交叉校验；body 缺字段时才回退。
 * - 坏 JSON / 顶层不是对象 → `bad_request`（HTTP 400）。
 * - 缺 `event_id` / `type` / `occurred_at` → `missing_field`（400）。
 * - `occurred_at` 不能解析或缺偏移 → `bad_timestamp`（400）。
 * - **未知 `type` 不是错误**：原样放进 `Envelope.type`，由 `EventProcessor` 判
 *   `ignored_type` 并回 200（不写 `seen`、不写盘）。
 *
 * 解析器不做业务校验（例如 `simulation.started` 的 config 形状）：那属于
 * `SessionFactory` / 各用例，对应 500 而不是 400。
 *
 * 错误形状刻意做成 `{ code, detail }` 而不是 `AppError`：`ErrorMapper` 只需要
 * HTTP 状态码，`IngestError` 是「传输层失败」的最小表示，不必进领域错误体系。
 */
import type { ErrorCode } from '../../kernel/errors.ts';
import { err, ok } from '../../kernel/result.ts';
import type { Result } from '../../kernel/result.ts';
import { Instant } from '../../kernel/time/instant.ts';
import type { Iso } from '../../domain/types.ts';

/** 解析失败码：只允许 §1.5 里对应 400 的三个。 */
export type IngestErrorCode = Extract<ErrorCode, 'bad_request' | 'missing_field' | 'bad_timestamp'>;

/** 入站解析失败（`ErrorMapper` 按 `code` 映射成 400）。 */
export interface IngestError {
  readonly code: IngestErrorCode;
  readonly detail: string;
}

/** 已知事件类型（未知类型不报错，留给 `EventProcessor` 判 `ignored_type`）。 */
export const KNOWN_EVENT_TYPES = ['simulation.started', 'email', 'order'] as const;

export type KnownEventType = (typeof KNOWN_EVENT_TYPES)[number];

/** `type` 是否是已知事件类型（类型守卫；未知 type 仍是一个合法信封）。 */
export function isKnownEventType(type: string): type is KnownEventType {
  return (KNOWN_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * 解析成功后的信封。
 *
 * - `event_id` / `occurred_at` 可能是从 headers 回退来的（此时 `headerWarnings`
 *   里会留下说明）；
 * - `body` 保留整个解析后的 JSON 对象（含信封字段），已知类型的 `EventProcessor`
 *   可以直接把它当作 `SimulationStartedEvent` / `EmailEvent` / `OrderEvent` 使用；
 * - `occurred_at` 保留原始字符串（已用 `Instant.parse` 验证过带偏移），与
 *   `domain/events.ts` 的 `occurred_at: Iso` 形状一致。
 */
export interface Envelope {
  readonly event_id: string;
  /** 原样保留（未知类型也合法，交给 EventProcessor 判 ignored_type）。 */
  readonly type: string;
  /** 已验证可解析的、带偏移的时间串。 */
  readonly occurred_at: Iso;
  /** 整个 body JSON 对象。 */
  readonly body: Record<string, unknown>;
  /** body 与 headers 不一致、或用了 header 回退的说明（仅日志用，不参与判断）。 */
  readonly headerWarnings: readonly string[];
}

/** 大小写不敏感地取 header（Node 的 `req.headers` 通常已小写，但不假设）。 */
function headerValue(headers: Record<string, string | undefined>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted && typeof value === 'string' && value.trim() !== '') {
      return value;
    }
  }
  return undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

export class EnvelopeParser {
  /**
   * `headers` 可选：测试/内部调用可以只给 body。
   * 返回 `Result<Envelope, IngestError>`；**不抛异常**。
   */
  parse(
    body: string,
    headers: Record<string, string | undefined> = {},
  ): Result<Envelope, IngestError> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return err({ code: 'bad_request', detail: 'body 不是合法 JSON' });
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return err({ code: 'bad_request', detail: 'body 顶层必须是 JSON 对象' });
    }
    const record = parsed as Record<string, unknown>;
    const warnings: string[] = [];

    // ---- event_id（body 优先；缺失时回退 x-event-id） ----
    const bodyEventId = nonEmptyString(record.event_id);
    const headerEventId = headerValue(headers, 'x-event-id');
    let eventId: string;
    if (bodyEventId !== undefined) {
      eventId = bodyEventId;
      if (headerEventId !== undefined && headerEventId !== bodyEventId) {
        warnings.push(`x-event-id(${headerEventId}) != body.event_id(${bodyEventId})；以 body 为准`);
      }
    } else if (headerEventId !== undefined) {
      eventId = headerEventId;
      warnings.push('body.event_id 缺失，回退 x-event-id');
    } else {
      return err({ code: 'missing_field', detail: '缺少 event_id' });
    }

    // ---- type（只有 body 有；未知 type 不算错误） ----
    const type = nonEmptyString(record.type);
    if (type === undefined) {
      return err({ code: 'missing_field', detail: '缺少 type' });
    }

    // ---- occurred_at（body 优先；缺失时回退 x-sim-time；必须带偏移） ----
    const bodyOccurredAt = nonEmptyString(record.occurred_at);
    const headerOccurredAt = headerValue(headers, 'x-sim-time');
    let occurredAt: string;
    if (bodyOccurredAt !== undefined) {
      occurredAt = bodyOccurredAt;
    } else if (headerOccurredAt !== undefined) {
      occurredAt = headerOccurredAt;
      warnings.push('body.occurred_at 缺失，回退 x-sim-time');
    } else {
      return err({ code: 'missing_field', detail: '缺少 occurred_at' });
    }
    const instant = Instant.parse(occurredAt);
    if (!instant.ok) {
      return err({ code: 'bad_timestamp', detail: `occurred_at 不可解析：${occurredAt}` });
    }
    if (
      bodyOccurredAt !== undefined &&
      headerOccurredAt !== undefined &&
      headerOccurredAt !== bodyOccurredAt
    ) {
      const headerInstant = Instant.parse(headerOccurredAt);
      if (!headerInstant.ok || !headerInstant.value.equals(instant.value)) {
        warnings.push(
          `x-sim-time(${headerOccurredAt}) != body.occurred_at(${bodyOccurredAt})；以 body 为准`,
        );
      }
    }

    return ok({ event_id: eventId, type, occurred_at: occurredAt, body: record, headerWarnings: warnings });
  }
}
