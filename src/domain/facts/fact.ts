/**
 * Fact：只追加、带生效区间的事实（`DATA-CONTRACTS.md` §3.1、`ARCHITECTURE.md` §5.4）。
 *
 * 领域内部使用 Instant 值对象表示时间；落盘时的 snake_case DTO 由
 * `application/session/snapshot-mapper.ts` 负责转换（`PersistedFact`）。
 *
 * 这里同时实现 `subjectKeyOf`：它是「哪些 fact 互相覆盖」的唯一依据。
 * 写错会让对立陈述互相看不见（例如缺货被 fallback 成有货），因此单独成函数并有单测。
 */
import type { Instant } from '../../kernel/time/instant.ts';
import type { Interval } from '../../kernel/time/interval.ts';
import type {
  DoseId,
  FactId,
  MedicationId,
  PharmacyId,
  StateCode,
  SubjectKey,
} from '../types.ts';

/** fact 的八种类型（`no_change` 不是 fact，见 `CandidateFact`）。 */
export type FactType =
  | 'stock_unavailable'
  | 'stock_available'
  | 'state_blocked'
  | 'state_allowed'
  | 'closed'
  | 'reopened'
  | 'capacity'
  | 'routing_preference';

/** 所有 fact 共有的字段。 */
export interface FactCommon {
  id: FactId;
  /** 全局单调序号，来自 IdSequence；也是同刻断言的最终平局键。 */
  seq: number;
  /** 来源邮件（基础事实则是 simulation.started 的 event_id）。 */
  eventId: string;
  /** 断言时刻 = 来源事件的 occurred_at（业务时间，不是墙钟）。 */
  assertedAt: Instant;
  pharmacy: PharmacyId;
  /** [from, until)，until === null 表示一直有效。 */
  interval: Interval;
  /** 原邮件里的说法，审计用。 */
  note?: string;
}

/** 只追加的事实联合类型。 */
export type Fact =
  | (FactCommon & { type: 'stock_unavailable'; medication: MedicationId; dose: DoseId })
  | (FactCommon & { type: 'stock_available'; medication: MedicationId; dose: DoseId })
  | (FactCommon & { type: 'state_blocked'; state: StateCode })
  | (FactCommon & { type: 'state_allowed'; state: StateCode })
  | (FactCommon & { type: 'closed' })
  | (FactCommon & { type: 'reopened' })
  | (FactCommon & { type: 'capacity'; perDay: number })
  | (FactCommon & {
      type: 'routing_preference';
      medication: MedicationId;
      dose?: DoseId;
      state?: StateCode;
    });

/** 校验通过、尚未分配 id/seq 的事实草稿。 */
export interface FactDraft {
  type: FactType;
  pharmacy: PharmacyId;
  interval: Interval;
  medication?: MedicationId;
  dose?: DoseId;
  state?: StateCode;
  perDay?: number;
  note?: string;
}

/**
 * 参与主体键计算的最小字段集合。
 *
 * 不用 `Pick<Fact, ...>`：Pick 作用在联合类型上会要求每个成员都声明这些字段，
 * 而 `closed` 之类的 fact 根本没有 `medication` 字段。这里用结构化类型描述即可。
 */
export interface FactSubjectFields {
  type: FactType;
  pharmacy: PharmacyId;
  medication?: MedicationId;
  dose?: DoseId;
  state?: StateCode;
}

/**
 * 主体键：同一主体上的对立陈述互相覆盖。
 *
 * | 类型 | 主体键 |
 * |---|---|
 * | stock_available / stock_unavailable | `stock:{pharmacy}:{medication}:{dose}` |
 * | state_blocked / state_allowed | `coverage:{pharmacy}:{state}` |
 * | closed / reopened | `closure:{pharmacy}` |
 * | capacity | `capacity:{pharmacy}` |
 * | routing_preference | `preference:{pharmacy}:{medication}:{dose ?? '*'}:{state ?? '*'}`（不参与 cells 求值） |
 */
export function subjectKeyOf(f: FactSubjectFields): SubjectKey {
  switch (f.type) {
    case 'stock_available':
    case 'stock_unavailable':
      return `stock:${f.pharmacy}:${f.medication}:${f.dose}`;
    case 'state_blocked':
    case 'state_allowed':
      return `coverage:${f.pharmacy}:${f.state}`;
    case 'closed':
    case 'reopened':
      return `closure:${f.pharmacy}`;
    case 'capacity':
      return `capacity:${f.pharmacy}`;
    case 'routing_preference':
      return `preference:${f.pharmacy}:${f.medication}:${f.dose ?? '*'}:${f.state ?? '*'}`;
  }
}

/** 两条 fact 是否属于同一主体（用于「最后断言者胜」与冲突检测）。 */
export function sameSubject(a: Fact, b: Fact): boolean {
  return subjectKeyOf(a) === subjectKeyOf(b);
}
