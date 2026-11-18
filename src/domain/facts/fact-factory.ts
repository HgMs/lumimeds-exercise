/**
 * `FactFactory`：把校验通过的 `FactDraft` 变成可落库的 `Fact`
 * （`ARCHITECTURE.md` §5.4、`DATA-CONTRACTS.md` §3.1）。
 *
 * 分配 `id`/`seq` 的唯一入口：
 * - `id` 来自持久化的 `IdSequence`（`fact_0028`），跨重启单调；
 * - `seq` 从 `id` 后缀解析，**不额外落盘**（§5.4：`PersistedFact` 与契约逐字段一致）；
 * - `createAll` 按传入数组顺序逐个 `create`，所以同一封邮件里落在同一 cell 的两条
 *   fact 天然「后者 seq 更大」（W4：`state_allowed` 覆盖 `state_blocked`、
 *   `reopened` 覆盖 `closed`、更正邮件里两条库存断言）。
 *
 * 领域内不抛业务异常；`required` 抛的是**不变量破坏**（validator 已保证必填字段
 * 齐全，缺字段说明上游有 bug），不属于「合法失败」。
 */
import type { IdSequence } from '../../kernel/ids.ts';
import type { Instant } from '../../kernel/time/instant.ts';
import type { Fact, FactCommon, FactDraft, FactType } from './fact.ts';

/** `create`/`createAll` 的上下文：来源事件、断言时刻、id 序列。 */
export interface FactFactoryContext {
  /** 来源事件 id（邮件事件；基础事实是 `simulation.started` 的 event_id）。 */
  eventId: string;
  /** 断言时刻 = 来源事件的 `occurred_at`。 */
  at: Instant;
  /** 持久化的 fact id 序号（`fact_0001` 起）。 */
  ids: IdSequence;
  /** 审计备注的后备值：draft 自己没有 `note` 时才用它（§5.4 的 `note?`）。 */
  note?: string;
}

/** 从 `fact_0028` 解析序号 28；格式非法说明快照/调用方破坏了不变量。 */
export function seqFromFactId(id: string): number {
  const match = /^fact_(\d+)$/.exec(id);
  if (match === null) {
    throw new Error(`FactFactory: 非法 fact id：${JSON.stringify(id)}`);
  }
  const seq = Number(match[1]);
  if (!Number.isSafeInteger(seq) || seq <= 0) {
    throw new Error(`FactFactory: fact id 序号非正：${JSON.stringify(id)}`);
  }
  return seq;
}

function required<T>(value: T | undefined, field: string, type: FactType): T {
  if (value === undefined) {
    throw new Error(`FactFactory: ${type} fact 缺少必填字段 ${field}`);
  }
  return value;
}

function requiredNumber(value: number | undefined, field: string, type: FactType): number {
  if (value === undefined) {
    throw new Error(`FactFactory: ${type} fact 缺少必填字段 ${field}`);
  }
  return value;
}

export class FactFactory {
  /** 单个 draft → fact（领一次 `seq`）。 */
  create(draft: FactDraft, ctx: FactFactoryContext): Fact {
    const id = ctx.ids.next('fact');
    const seq = seqFromFactId(id);
    const note = draft.note ?? ctx.note;
    const common: FactCommon = {
      id,
      seq,
      eventId: ctx.eventId,
      assertedAt: ctx.at,
      pharmacy: draft.pharmacy,
      interval: draft.interval,
      ...(note === undefined ? {} : { note }),
    };

    // 逐类型显式构造：FactDraft 的必填字段是可选的（校验前形状），这里把它们收窄。
    switch (draft.type) {
      case 'stock_available':
        return {
          ...common,
          type: 'stock_available',
          medication: required(draft.medication, 'medication', draft.type),
          dose: required(draft.dose, 'dose', draft.type),
        };
      case 'stock_unavailable':
        return {
          ...common,
          type: 'stock_unavailable',
          medication: required(draft.medication, 'medication', draft.type),
          dose: required(draft.dose, 'dose', draft.type),
        };
      case 'state_blocked':
        return {
          ...common,
          type: 'state_blocked',
          state: required(draft.state, 'state', draft.type),
        };
      case 'state_allowed':
        return {
          ...common,
          type: 'state_allowed',
          state: required(draft.state, 'state', draft.type),
        };
      case 'closed':
        return { ...common, type: 'closed' };
      case 'reopened':
        return { ...common, type: 'reopened' };
      case 'capacity':
        return {
          ...common,
          type: 'capacity',
          perDay: requiredNumber(draft.perDay, 'perDay', draft.type),
        };
      case 'routing_preference':
        return {
          ...common,
          type: 'routing_preference',
          medication: required(draft.medication, 'medication', draft.type),
          ...(draft.dose === undefined ? {} : { dose: draft.dose }),
          ...(draft.state === undefined ? {} : { state: draft.state }),
        };
    }
  }

  /**
   * 一批 draft → fact 数组，**严格按数组顺序**领 `seq`（W4）。
   * 用 `for` 而不是 `map`：意图就是「顺序是语义的一部分」，不依赖任何遍历实现的细节。
   */
  createAll(drafts: readonly FactDraft[], ctx: FactFactoryContext): Fact[] {
    const facts: Fact[] = [];
    for (const draft of drafts) {
      facts.push(this.create(draft, ctx));
    }
    return facts;
  }
}
