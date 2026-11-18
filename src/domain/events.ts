/**
 * 入站事件的形状（`DATA-CONTRACTS.md` §1）：模拟器 → 我们。
 *
 * 信封字段与 JSON 完全一致（snake_case）；这些类型只描述「收到的原始数据」，
 * 解析/校验（400/500 的判定）在 `application/ingest/envelope-parser.ts`。
 * 订单是结构化数据，不过 LLM，归一化由 `domain/normalize/order-normalizer.ts` 负责。
 */
import type { SimConfig } from './config.ts';
import type { Iso, OrderId } from './types.ts';

/** 公共信封（`DATA-CONTRACTS.md` §1.1）；同值也出现在 `x-event-id`/`x-sim-time` 头。 */
export interface EventEnvelope {
  event_id: string;
  type: 'simulation.started' | 'email' | 'order';
  /** `occurred_at` 就是「现在」：业务时间只来自事件，绝不读进程时钟。 */
  occurred_at: Iso;
}

/** `simulation.started`：本周开始，重置状态、记下药房 API 与 config。 */
export interface SimulationStartedEvent extends EventEnvelope {
  type: 'simulation.started';
  /** 模拟器药房 API 的 base URL，例如 `http://localhost:4000`。 */
  pharmacyApi: string;
  config: SimConfig;
}

/** 一封发往 Sam 的邮件（原始文本，未解析 from 里的显示名）。 */
export interface EmailPayload {
  /** 可能是 `"Jen <jen@example>"` 形式；地址解析由 `domain/email/sender.ts` 负责。 */
  from: string;
  subject: string;
  body: string;
}

/** `email` 事件。 */
export interface EmailEvent extends EventEnvelope {
  type: 'email';
  email: EmailPayload;
}

/**
 * 订单的**原始**形状（`DATA-CONTRACTS.md` §1.4）：字段是病人侧的写法，
 * 可能 `state: "Texas"`、`medication: "tirz"`、`dose: "7.5 mg"`。
 */
export interface RawOrder {
  order_id: OrderId;
  state: string;
  medication: string;
  dose: string;
}

/** `order` 事件。 */
export interface OrderEvent extends EventEnvelope {
  type: 'order';
  order: RawOrder;
}

/** 三类入站事件的联合；判型用 `type` 字段。 */
export type InboundEvent = SimulationStartedEvent | EmailEvent | OrderEvent;
