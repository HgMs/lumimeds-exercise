/**
 * `FactStore`：只追加、按主体求值的事实存储（`ARCHITECTURE.md` §5.4、
 * `DATA-CONTRACTS.md` §3.2、`REQUIREMENTS.md` §3.2）。
 *
 * 机制只有两句话：
 * 1. `append` 只增不改（INV-3）——历史永不改写，所以「T 时刻我们相信什么」可回答；
 * 2. `resolve(key, at)` 从**后往前**找第一条 `interval.covers(at)` 的断言——
 *    「覆盖 at 的最后断言者胜」，过期的旧 fact 自然被跳过，无需删除。
 *
 * 排序键固定为 `(assertedAt, seq)` 升序：`assertedAt` 来自邮件时间，可能相同
 * （同一分钟两封邮件），`seq` 是最终平局键（来自持久化 `IdSequence`，不能用数组下标）。
 *
 * `routing_preference` 按 §5.4 的表格**不进 cells**（它不参与「哪条信念生效」的
 * 单值求值，而是由 `PreferenceResolver` 按药品/剂量/州查询），单独存列表。
 *
 * 分层说明：`snapshot()` 的形状 == `application/ports/state-store.ts` 的
 * `PersistedFact`（snake_case），但 `domain/` 不能 import `application/`（§2.1 R2），
 * 所以这里用结构完全等价的本地接口 `PersistedFact`；两边可以直接互相赋值，
 * 不需要 adapter 层再转换一遍字段。时间用 `Instant.toISOString()`（UTC `Z`，
 * RFC3339 带偏移，`Instant.parse` 可原样读回）；ET 偏移形式留给审计/HTTP 输出。
 */
import type { AppError } from '../../kernel/errors.ts';
import { Instant } from '../../kernel/time/instant.ts';
import { Interval } from '../../kernel/time/interval.ts';
import type { Result } from '../../kernel/result.ts';
import type { FactId, MedicationId, PharmacyId, StateCode, SubjectKey } from '../types.ts';
import type { Fact, FactType } from './fact.ts';
import { subjectKeyOf } from './fact.ts';

/**
 * 落盘版 fact（`DATA-CONTRACTS.md` §3.1 的 snake_case 形状）。
 * `seq` 不落盘：从 `id` 的 `fact_NNNN` 后缀解析（§5.4）。
 */
export interface PersistedFact {
  id: FactId;
  type: FactType;
  event_id: string;
  asserted_at: string;
  pharmacy: PharmacyId;
  interval: { from: string; until: string | null };
  medication?: MedicationId;
  dose?: string;
  state?: StateCode;
  per_day?: number;
  note?: string;
}

/** `history` 的空结果（冻结共享，避免调用方改内部数组）。 */
const EMPTY_HISTORY: readonly Fact[] = Object.freeze([]);

/** `(assertedAt, seq)` 升序比较：`assertedAt` 先比，`seq` 是平局键。 */
function compareFacts(a: Fact, b: Fact): number {
  const byTime = a.assertedAt.compare(b.assertedAt);
  if (byTime !== 0) return byTime;
  return a.seq - b.seq;
}

/** 把 fact 插到保持 `(assertedAt, seq)` 升序的位置（cell 很小，从尾部线性回退即可）。 */
function insertOrdered(cell: Fact[], fact: Fact): void {
  let index = cell.length;
  while (index > 0 && compareFacts(cell[index - 1], fact) > 0) {
    index -= 1;
  }
  cell.splice(index, 0, fact);
}

function parseInstant(iso: string, where: string): Instant {
  const parsed: Result<Instant, AppError> = Instant.parse(iso);
  if (!parsed.ok) {
    throw new Error(
      `FactStore.restore: ${where} 时间不可解析：${JSON.stringify(iso)}（${parsed.error.message}）`,
    );
  }
  return parsed.value;
}

/** 从 `PersistedFact.id` 解析 seq；格式非法 → 抛（快照被外部改坏，属不变量破坏）。 */
function seqFromPersistedId(id: FactId): number {
  const match = /^fact_(\d+)$/.exec(id);
  if (match === null) {
    throw new Error(`FactStore.restore: 非法 fact id：${JSON.stringify(id)}`);
  }
  const seq = Number(match[1]);
  if (!Number.isSafeInteger(seq) || seq <= 0) {
    throw new Error(`FactStore.restore: fact id 序号非正：${JSON.stringify(id)}`);
  }
  return seq;
}

function intervalFromPersisted(persisted: PersistedFact): Interval {
  const from = parseInstant(persisted.interval.from, 'interval.from');
  const until =
    persisted.interval.until === null
      ? null
      : parseInstant(persisted.interval.until, 'interval.until');
  const interval = Interval.of(from, until);
  if (!interval.ok) {
    throw new Error(`FactStore.restore: fact ${persisted.id} 的 interval 非法（until 必须晚于 from）`);
  }
  return interval.value;
}

/** `T extends string | number` 的必填字段；缺失说明写快照的一方有 bug。 */
function persistedRequired<T extends string | number>(
  persisted: PersistedFact,
  field: 'medication' | 'dose' | 'state' | 'per_day',
): T {
  const value = persisted[field];
  if (value === undefined) {
    throw new Error(`FactStore.restore: fact ${persisted.id}（${persisted.type}）缺少 ${field}`);
  }
  return value as T;
}

function toPersisted(fact: Fact): PersistedFact {
  const base = {
    id: fact.id,
    event_id: fact.eventId,
    asserted_at: fact.assertedAt.toISOString(),
    pharmacy: fact.pharmacy,
    interval: {
      from: fact.interval.from.toISOString(),
      until: fact.interval.until === null ? null : fact.interval.until.toISOString(),
    },
    ...(fact.note === undefined ? {} : { note: fact.note }),
  };
  switch (fact.type) {
    case 'stock_available':
      return { ...base, type: fact.type, medication: fact.medication, dose: fact.dose };
    case 'stock_unavailable':
      return { ...base, type: fact.type, medication: fact.medication, dose: fact.dose };
    case 'state_blocked':
      return { ...base, type: fact.type, state: fact.state };
    case 'state_allowed':
      return { ...base, type: fact.type, state: fact.state };
    case 'closed':
      return { ...base, type: 'closed' };
    case 'reopened':
      return { ...base, type: 'reopened' };
    case 'capacity':
      return { ...base, type: 'capacity', per_day: fact.perDay };
    case 'routing_preference':
      return {
        ...base,
        type: 'routing_preference',
        medication: fact.medication,
        ...(fact.dose === undefined ? {} : { dose: fact.dose }),
        ...(fact.state === undefined ? {} : { state: fact.state }),
      };
  }
}

function fromPersisted(persisted: PersistedFact, seq: number): Fact {
  const common = {
    id: persisted.id,
    seq,
    eventId: persisted.event_id,
    assertedAt: parseInstant(persisted.asserted_at, 'asserted_at'),
    pharmacy: persisted.pharmacy,
    interval: intervalFromPersisted(persisted),
    ...(persisted.note === undefined ? {} : { note: persisted.note }),
  };
  switch (persisted.type) {
    case 'stock_available':
      return {
        ...common,
        type: 'stock_available',
        medication: persistedRequired(persisted, 'medication'),
        dose: persistedRequired(persisted, 'dose'),
      };
    case 'stock_unavailable':
      return {
        ...common,
        type: 'stock_unavailable',
        medication: persistedRequired(persisted, 'medication'),
        dose: persistedRequired(persisted, 'dose'),
      };
    case 'state_blocked':
      return { ...common, type: 'state_blocked', state: persistedRequired(persisted, 'state') };
    case 'state_allowed':
      return { ...common, type: 'state_allowed', state: persistedRequired(persisted, 'state') };
    case 'closed':
      return { ...common, type: 'closed' };
    case 'reopened':
      return { ...common, type: 'reopened' };
    case 'capacity':
      return { ...common, type: 'capacity', perDay: persistedRequired(persisted, 'per_day') };
    case 'routing_preference':
      return {
        ...common,
        type: 'routing_preference',
        medication: persistedRequired(persisted, 'medication'),
        ...(persisted.dose === undefined ? {} : { dose: persisted.dose }),
        ...(persisted.state === undefined ? {} : { state: persisted.state }),
      };
  }
}

export class FactStore {
  /** 主体键 → 该主体上的断言，按 `(assertedAt, seq)` 升序。 */
  private readonly cells = new Map<SubjectKey, Fact[]>();
  /** 全部 fact，按 append 顺序（= seq 升序；快照与 `factsOf` 的稳定顺序）。 */
  private readonly ordered: Fact[] = [];
  /** `routing_preference` 的独立列表（不进 cells，§5.4）。 */
  private readonly preferenceList: Fact[] = [];
  /** 产生过 fact 的 event_id（幂等兜底 `hasEvent`）。 */
  private readonly eventIds = new Set<string>();
  /** 已接收的最大 seq：append 时校验全局单调，拒绝重复/倒序。 */
  private lastSeq = 0;

  /**
   * 追加一批 fact。只增不改；同一批内按**传入顺序**接收（调用方应已按数组顺序领 seq）。
   *
   * `seq` 必须严格大于已接收的最大值——这是 INV-3 的运行时校验：`(assertedAt, seq)`
   * 不会重复，`resolve` 的「最后断言者」才有唯一含义。违反是**不变量破坏**
   * （快照/调用方 bug），按 §2.2「异常只留给不该发生的事」抛 `Error`。
   */
  append(facts: readonly Fact[]): void {
    for (const fact of facts) {
      if (fact.seq <= this.lastSeq) {
        throw new Error(
          `FactStore.append: seq 必须单调递增（收到 ${fact.seq}，已接收 ${this.lastSeq}，fact ${fact.id}）`,
        );
      }
      this.lastSeq = fact.seq;
      this.ordered.push(fact);
      // 每一条 fact（包括偏好的来源事件）都让 hasEvent 为真：§11.4 第三道幂等闸。
      this.eventIds.add(fact.eventId);

      if (fact.type === 'routing_preference') {
        // 偏好不进 cells（§5.4 主体分组表最后一行），否则会被当成「单值信念」求值。
        this.preferenceList.push(fact);
        continue;
      }
      const key = subjectKeyOf(fact);
      const cell = this.cells.get(key);
      if (cell === undefined) {
        this.cells.set(key, [fact]);
      } else {
        insertOrdered(cell, fact);
      }
    }
  }

  /**
   * `at` 时刻该主体的信念：覆盖 `at` 的**最后断言者**；没有则 `undefined`
   * （交给 `BeliefDefaults` 的 fallback，INV-5）。
   */
  resolve(key: SubjectKey, at: Instant): Fact | undefined {
    const cell = this.cells.get(key);
    if (cell === undefined) return undefined;
    // 从后往前：最后断言的一条先看，`interval` 不覆盖 at 就继续往回找。
    for (let index = cell.length - 1; index >= 0; index -= 1) {
      const fact = cell[index];
      if (fact.interval.covers(at)) return fact;
    }
    return undefined;
  }

  /** 某主体的全部断言（含已过期/未来生效的），按 `(assertedAt, seq)` 升序。 */
  history(key: SubjectKey): readonly Fact[] {
    return this.cells.get(key) ?? EMPTY_HISTORY;
  }

  /** 某药房的 fact（可按类型过滤），按 append 顺序（= seq 升序）。 */
  factsOf(pharmacy: PharmacyId, type?: FactType): readonly Fact[] {
    return this.ordered.filter(
      (fact) => fact.pharmacy === pharmacy && (type === undefined || fact.type === type),
    );
  }

  /** 全部 `routing_preference`（append 顺序）。 */
  preferences(): readonly Fact[] {
    return this.preferenceList;
  }

  /**
   * 该 `event_id` 是否产生过 fact。**只对「产生 fact」的邮件有效**（W9）：
   * 被拒绝的邮件没有 fact，去重仍以 `seenEventIds` 为准；这里只是 LLM 调用前的省流闸。
   */
  hasEvent(eventId: string): boolean {
    return this.eventIds.has(eventId);
  }

  /** 快照：全部 fact 的 snake_case 表示，顺序 = append 顺序（restore 可直接反解）。 */
  snapshot(): readonly PersistedFact[] {
    return this.ordered.map(toPersisted);
  }

  /**
   * 从快照恢复。`seq` 从 `id` 后缀解析并校验严格单调——快照顺序被破坏时抛错
   * （不变量破坏，不是业务失败）。恢复后的 `resolve` 结果与恢复前一致（§12.2）。
   */
  static restore(facts: readonly PersistedFact[]): FactStore {
    const store = new FactStore();
    const restored: Fact[] = [];
    let previousSeq = 0;
    for (const persisted of facts) {
      const seq = seqFromPersistedId(persisted.id);
      if (seq <= previousSeq) {
        throw new Error(
          `FactStore.restore: fact 序号必须严格单调（${persisted.id} 在 ${previousSeq} 之后）`,
        );
      }
      previousSeq = seq;
      restored.push(fromPersisted(persisted, seq));
    }
    store.append(restored);
    return store;
  }
}
