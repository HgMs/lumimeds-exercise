/**
 * `FactValidator`：候选 fact → 生效草稿 / 拒绝码（`ARCHITECTURE.md` §5.8）。
 *
 * 这是邮件流水线的安全关键路径：模型只产出「候选」，进不进状态由这里决定。
 * 流水线顺序是规范的一部分（先报哪个错决定 Sam 列表里的可读性），严格按 §5.8 的
 * 1–11 步执行：
 *
 * 1. 身份门（`unknown` 一律拒绝，**先于** `unrelated` 短路）；
 * 2. `intent === 'unrelated'`（已知发件人）→ `no_change`；
 * 3. `unclear` / 空 facts → 拒绝；
 * 4. `no_change` 候选：整封都是它 → `no_change`；混排时丢弃（不参与校验、不进草稿）；
 * 5. 药房缺省（药房发件人取自己那家；ops 必须显式写）；
 * 6. 逐类必填字段（模型给 `null` 也不放过）与禁止字段；
 * 7. 权限（在剂量/州校验之前：权限是「谁在说话」，比内容错误更该优先报告）；
 * 8. 值域：药品 ∈ catalogue、剂量精确命中、州可归一化；
 * 9. 时间：逐字段合并 + 按 ET 日期比粒度 + 真冲突拒绝 + 缺省/无限期 + 窗口闭区间
 *    + `until <= from` 改取下个星期；
 * 10. 原子性：任何一条候选被拒，整封 `rejected`，`drafts` 一条都不生效；
 * 11. `correction` 不改变落库方式（求值规则自动覆盖，无需 supersede）。
 *
 * 第 5–9 步按「步」全局遍历候选，而不是逐候选串完所有步：这样「第 5 步的错」
 * 总是先于「第 7 步的错」被报告，与 §5.8 的顺序完全一致。
 */
import { Interval } from '../../kernel/time/interval.ts';
import { etDate } from '../../kernel/time/et-date.ts';
import type { EtCalendar } from '../../kernel/time/et-calendar.ts';
import type { EtDate } from '../../kernel/time/et-date.ts';
import type { Instant } from '../../kernel/time/instant.ts';
import type { ErrorCode } from '../../kernel/errors.ts';
import type { Catalogue } from '../catalogue.ts';
import type { FactDraft, FactType } from '../facts/fact.ts';
import {
  DEFAULT_MEDICATION_ALIASES,
  MedicationNormalizer,
} from '../normalize/medication-normalizer.ts';
import { DoseNormalizer } from '../normalize/dose-normalizer.ts';
import { StateNormalizer } from '../normalize/state-normalizer.ts';
import type { PharmacyRegistry } from '../pharmacy.ts';
import type { DoseId, MedicationId, PharmacyId, StateCode } from '../types.ts';
import type { CandidateFact, ExtractionResult } from './extraction.ts';
import type { PermissionPolicy } from './permission.ts';
import type { PhraseParser, PhraseTemporal } from './phrase-parser.ts';
import type { SenderIdentity } from './sender.ts';

/** 每个时间字段的采用来源（`out/facts.jsonl` 的 `dateOverrides`；§5.8）。 */
export interface DateOverride {
  field: 'from' | 'until';
  /** 模型给的 `YYYY-MM-DD`（或 null）。 */
  model: string | null;
  /** 最终采用的 ISO（含 ET 偏移）。 */
  used: string;
  /** `parser:<rule>` / `model` / `default:occurred_at` / `default:next_weekday`。 */
  source: string;
}

/** 一个时间字段的来源（`FactAuditRecord.sources`）。 */
export interface FactDateSources {
  from?: string;
  until?: string;
}

/** 校验结论（`ARCHITECTURE.md` §5.8）。 */
export type ValidationOutcome =
  | {
      kind: 'applied';
      drafts: FactDraft[];
      /** 抽取结果自带的 notes（审计可见性用；`FactAuditRecord` 本身没有 notes 字段）。 */
      notes: string[];
      /** 采取的安全侧假设（例如缺 `until` 按无限期）。 */
      assumptions: string[];
      /** 每个时间字段的采用来源（只记被覆盖的字段）。 */
      dateOverrides: DateOverride[];
      /** 与 `drafts` 一一对应的 `{from, until}` 来源（扇出成多条草稿时重复同一份）。 */
      sources: FactDateSources[];
    }
  | {
      kind: 'rejected';
      code: ErrorCode;
      /** 具体值/字段的可读说明；Sam 的 reason 可用 `${code}:${detail}` 组成。 */
      detail: string;
      /** 在 `result.facts` 里的下标（含被丢弃的 no_change 占位）；无具体候选时为 null。 */
      offendingIndex: number | null;
    }
  | { kind: 'no_change'; reason: 'unrelated' | 'no_change_candidates' };

/** `validate` 的上下文（时间、「现在」、已解析的发件人）。 */
export interface ValidationContext {
  eventId: string;
  /** 事件发生时刻 = 「现在」；绝不读进程时钟。 */
  at: Instant;
  sender: SenderIdentity;
}

/** `FactValidator` 的依赖（§5.8）。`window` 是**闭区间** `[from, to]`（§16-Q17）。 */
export interface FactValidatorDeps {
  calendar: EtCalendar;
  catalogue: Catalogue;
  registry: PharmacyRegistry;
  permission: PermissionPolicy;
  phrases: PhraseParser;
  window: { from: EtDate; to: EtDate };
}

/** 八种 fact 类型（`no_change` 不是 fact）。 */
const FACT_TYPES: ReadonlySet<string> = new Set<FactType>([
  'stock_unavailable',
  'stock_available',
  'state_blocked',
  'state_allowed',
  'closed',
  'reopened',
  'capacity',
  'routing_preference',
]);

/** 必填字段表（`REQUIREMENTS.md` §4.3-7 / §5.8 第 6 步）；`from` 表示「起点必须显式给出」。 */
const REQUIRED_FIELDS: Readonly<Record<FactType, readonly RequiredField[]>> = {
  stock_available: ['medication', 'dose'],
  stock_unavailable: ['medication', 'dose'],
  state_blocked: ['states'],
  state_allowed: ['states'],
  closed: [],
  reopened: ['from'],
  capacity: ['per_day'],
  routing_preference: ['medication'],
};

type RequiredField = 'medication' | 'dose' | 'states' | 'per_day' | 'from';

/** 禁止字段表（同上）。出现即 `bad_request`：宁可让人看一眼，也不静默忽略多给的东西。 */
const FORBIDDEN_FIELDS: Readonly<Record<FactType, readonly ForbiddenField[]>> = {
  stock_available: ['states', 'per_day'],
  stock_unavailable: ['states', 'per_day'],
  state_blocked: ['medication', 'dose'],
  state_allowed: ['medication', 'dose'],
  closed: ['medication', 'states'],
  reopened: ['medication', 'states'],
  capacity: ['medication', 'states'],
  routing_preference: ['per_day'],
};

type ForbiddenField = 'medication' | 'dose' | 'states' | 'per_day';

/** 缺 `until` 时按「无限期」处理并记 assumption 的否定类事实（W5 / Q18）。 */
const INDEFINITE_WHEN_NO_UNTIL: ReadonlySet<FactType> = new Set<FactType>([
  'closed',
  'stock_unavailable',
  'routing_preference',
]);

/** 合法的 `until` 子句规则：`until <= from` 时改取「下一个该星期」（W13）。 */
const WEEKDAY_UNTIL_RULES: ReadonlySet<string> = new Set(['until_weekday', 'back_on_weekday']);

/** 值域归一化后的候选字段（第 8 步产出，第 9 步与草稿使用）。 */
interface NormalizedValues {
  medication?: MedicationId;
  dose?: DoseId;
  states?: readonly StateCode[];
}

/** 一个参与校验的候选 + 它在原数组里的下标（`offendingIndex` 用）。 */
interface WorkItem {
  candidate: CandidateFact;
  index: number;
}

/** 第 9 步合并结果。 */
interface TimeMerge {
  interval: Interval;
  sources: FactDateSources;
  assumptions: string[];
  dateOverrides: DateOverride[];
}

type TimeMergeResult =
  | { ok: true; value: TimeMerge }
  | { ok: false; code: ErrorCode; detail: string };

/** 文本字段：空白串视为「没给」。 */
function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** 非负整数（`capacity.per_day` 的域；负或非整数都走 `bad_request`，R4-4）。 */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** 该字段「有信息量」：空数组/空串等同于模型没给。 */
function isFactType(value: unknown): value is FactType {
  return typeof value === 'string' && FACT_TYPES.has(value);
}

function rejected(
  code: ErrorCode,
  detail: string,
  offendingIndex: number | null,
): ValidationOutcome {
  return { kind: 'rejected', code, detail, offendingIndex };
}

/**
 * 候选 fact 校验器。纯函数（除构造时建立的只读依赖外无状态）：
 * 同一 `(result, ctx)` 永远同一结论。
 */
export class FactValidator {
  private readonly calendar: EtCalendar;
  private readonly registry: PharmacyRegistry;
  private readonly permission: PermissionPolicy;
  private readonly phrases: PhraseParser;
  private readonly window: { from: EtDate; to: EtDate };
  private readonly medications: MedicationNormalizer;
  private readonly doses: DoseNormalizer;
  private readonly states: StateNormalizer;

  constructor(deps: FactValidatorDeps) {
    this.calendar = deps.calendar;
    this.registry = deps.registry;
    this.permission = deps.permission;
    this.phrases = deps.phrases;
    this.window = deps.window;
    // 值域校验是「归一化 + 落在 catalogue 里」：复用 domain/normalize 的唯一实现，
    // 不在验证器里重写一份更宽松的匹配（`25mg` 不许猜成 `2.5mg`）。
    this.medications = new MedicationNormalizer(deps.catalogue, DEFAULT_MEDICATION_ALIASES);
    this.doses = new DoseNormalizer(deps.catalogue);
    this.states = new StateNormalizer();
    if (deps.window.to < deps.window.from) {
      throw new Error(
        `FactValidator: invalid window [${deps.window.from}, ${deps.window.to}] (to < from)`,
      );
    }
  }

  /**
   * 校验一封邮件的抽取结果。
   *
   * 返回值三态（`applied` / `rejected` / `no_change`）由调用方映射为
   * `FactFactory` + `FactStore.append` / `SamList.add` / 只审计。
   */
  validate(result: ExtractionResult, ctx: ValidationContext): ValidationOutcome {
    const facts = Array.isArray(result.facts) ? result.facts : [];

    // ---- 1. 身份门：unknown 一律拒绝，先于 unrelated 短路（评审 A9 / Q19）。 ----
    if (ctx.sender.role === 'unknown') {
      return rejected('unknown_sender', ctx.sender.address, null);
    }

    // ---- 2. unrelated（发件人已知）→ 不产 fact、不进 Sam，只记 no_change 审计。 ----
    if (result.intent === 'unrelated') {
      return { kind: 'no_change', reason: 'unrelated' };
    }

    // ---- 3. unclear / 空 facts → 拒绝（没有可校验的断言）。 ----
    if (result.intent === 'unclear') {
      return rejected('missing_field_for_type', 'intent:unclear', null);
    }
    if (facts.length === 0) {
      return rejected('missing_field_for_type', 'facts:empty', null);
    }

    // ---- 4. no_change 候选：整封都是它 → no_change；否则丢弃、不参与任何校验。 ----
    const items: WorkItem[] = [];
    for (let i = 0; i < facts.length; i += 1) {
      if (facts[i].type !== 'no_change') items.push({ candidate: facts[i], index: i });
    }
    if (items.length === 0) {
      return { kind: 'no_change', reason: 'no_change_candidates' };
    }

    // 短语解析是纯函数，且第 6 步判断 `reopened` 的必填 `from` 要用到解析结果，
    // 所以先算一次（不产生任何错误，不影响步骤顺序）。
    const phrases = items.map((item) => this.phrases.parse(item.candidate.phrase, ctx.at));

    // ---- 5. 药房解析 + 缺省。 ----
    const pharmacies: PharmacyId[] = [];
    for (const item of items) {
      const resolved = this.resolvePharmacy(item, ctx);
      if ('outcome' in resolved) return resolved.outcome;
      pharmacies.push(resolved.pharmacy);
    }

    // ---- 6. 逐类必填字段 / 禁止字段 / 字段形状。 ----
    for (const [pos, item] of items.entries()) {
      const outcome = this.checkFields(item, phrases[pos]);
      if (outcome !== null) return outcome;
    }

    // ---- 7. 权限（在剂量/州校验之前）。 ----
    for (const item of items) {
      const verdict = this.permission.canAssert(ctx.sender, item.candidate);
      if (!verdict.allowed) {
        return rejected(verdict.code, verdict.detail, item.index);
      }
    }

    // ---- 8. 值域：药品 ∈ catalogue、剂量精确命中、州可归一化。 ----
    const normalized: NormalizedValues[] = [];
    for (const item of items) {
      const values = this.normalizeValues(item);
      if ('outcome' in values) return values.outcome;
      normalized.push(values.values);
    }

    // ---- 9. 时间：逐字段合并 / ET 日期比对 / 窗口 / until<=from。 ----
    const times: TimeMerge[] = [];
    for (const [pos, item] of items.entries()) {
      const merged = this.mergeTime(item, phrases[pos], result.confidence, ctx);
      if (!merged.ok) return rejected(merged.code, merged.detail, item.index);
      times.push(merged.value);
    }

    // ---- 10. 组装草稿（全部候选都通过才会走到这里 = 原子性）。 ----
    return this.buildApplied(items, pharmacies, normalized, times, result);
  }

  // -------------------------------------------------------------------------
  // 第 5 步：药房解析 / 缺省
  // -------------------------------------------------------------------------

  private resolvePharmacy(
    item: WorkItem,
    ctx: ValidationContext,
  ): { pharmacy: PharmacyId } | { outcome: ValidationOutcome } {
    const raw = textValue(item.candidate.pharmacy);
    if (raw !== null) {
      const pharmacy = this.registryResolve(raw);
      if (pharmacy === undefined) {
        return {
          outcome: rejected('unknown_pharmacy', raw, item.index),
        };
      }
      return { pharmacy };
    }

    // 正文没点名药房：只有药房发件人有缺省（默认自己那家）；ops 必须显式写。
    if (ctx.sender.role === 'pharmacy' && ctx.sender.pharmacy !== undefined) {
      return { pharmacy: ctx.sender.pharmacy };
    }
    return {
      outcome: rejected('missing_field_for_type', 'pharmacy', item.index),
    };
  }

  /** `registry.resolve` 的薄封装：解析不到 → `unknown_pharmacy`。 */
  private registryResolve(raw: string): PharmacyId | undefined {
    return this.registry.resolve(raw)?.id;
  }

  // -------------------------------------------------------------------------
  // 第 6 步：必填 / 禁止 / 形状
  // -------------------------------------------------------------------------

  private checkFields(item: WorkItem, phrase: PhraseTemporal | null): ValidationOutcome | null {
    const raw = item.candidate as unknown as Record<string, unknown>;
    const type = item.candidate.type;
    if (!isFactType(type)) {
      return rejected('bad_request', `type:${String(type)}`, item.index);
    }

    const med = raw['medication'];
    const dose = raw['dose'];
    const perDay = raw['per_day'];
    const rawStates = raw['states'];

    // 字段形状：类型不对一律 bad_request（R4-4：不要拖到下游变成 undefined）。
    if (med !== undefined && med !== null && typeof med !== 'string') {
      return rejected('bad_request', `${type}.medication`, item.index);
    }
    if (dose !== undefined && dose !== null && typeof dose !== 'string') {
      return rejected('bad_request', `${type}.dose`, item.index);
    }
    if (perDay !== undefined && perDay !== null && typeof perDay !== 'number') {
      return rejected('bad_request', `${type}.per_day`, item.index);
    }
    let statesList: readonly unknown[] | null = null;
    if (rawStates !== undefined && rawStates !== null) {
      if (!Array.isArray(rawStates)) {
        return rejected('bad_request', `${type}.states`, item.index);
      }
      for (const state of rawStates) {
        if (typeof state !== 'string' || state.trim() === '') {
          return rejected('bad_request', `${type}.states`, item.index);
        }
      }
      statesList = rawStates;
    }

    const medText = textValue(med);
    const doseText = textValue(dose);
    const hasPerDay = perDay !== undefined && perDay !== null;
    const hasStates = statesList !== null && statesList.length > 0;
    const hasFrom =
      (raw['from_date'] !== undefined && raw['from_date'] !== null) ||
      phrase?.from !== undefined;

    // 必填（缺字段 → missing_field_for_type；值域非法 → bad_request）。
    for (const field of REQUIRED_FIELDS[type]) {
      switch (field) {
        case 'medication':
          if (medText === null) {
            return rejected('missing_field_for_type', `${type}.medication`, item.index);
          }
          break;
        case 'dose':
          if (doseText === null) {
            return rejected('missing_field_for_type', `${type}.dose`, item.index);
          }
          break;
        case 'states':
          // 需要 states 的类型：没给 → 缺字段；给了空数组 → 值域非法（R4-4）。
          if (statesList === null) {
            return rejected('missing_field_for_type', `${type}.states`, item.index);
          }
          if (statesList.length === 0) {
            return rejected('bad_request', `${type}.states`, item.index);
          }
          break;
        case 'per_day':
          if (!hasPerDay) {
            return rejected('missing_field_for_type', `${type}.per_day`, item.index);
          }
          if (!isNonNegativeInteger(perDay)) {
            return rejected('bad_request', `${type}.per_day`, item.index);
          }
          break;
        case 'from':
          if (!hasFrom) {
            return rejected('missing_field_for_type', `${type}.from`, item.index);
          }
          break;
      }
    }

    // 禁止字段（空数组/空串/缺省不算「出现」；否则模型总带 `states: []` 会误伤）。
    for (const field of FORBIDDEN_FIELDS[type]) {
      switch (field) {
        case 'medication':
          if (medText !== null) {
            return rejected('bad_request', `${type}.medication`, item.index);
          }
          break;
        case 'dose':
          if (doseText !== null) {
            return rejected('bad_request', `${type}.dose`, item.index);
          }
          break;
        case 'states':
          if (hasStates) {
            return rejected('bad_request', `${type}.states`, item.index);
          }
          break;
        case 'per_day':
          if (hasPerDay) {
            return rejected('bad_request', `${type}.per_day`, item.index);
          }
          break;
      }
    }

    return null;
  }

  // -------------------------------------------------------------------------
  // 第 8 步：值域
  // -------------------------------------------------------------------------

  private normalizeValues(
    item: WorkItem,
  ): { values: NormalizedValues } | { outcome: ValidationOutcome } {
    const raw = item.candidate as unknown as Record<string, unknown>;
    const type = item.candidate.type;
    const values: NormalizedValues = {};

    const medText = textValue(raw['medication']);
    if (medText !== null) {
      const medication = this.medications.normalize(medText);
      if (!medication.ok) {
        return { outcome: rejected('unknown_medication', medication.raw, item.index) };
      }
      values.medication = medication.value;
    }

    const doseText = textValue(raw['dose']);
    if (doseText !== null) {
      // 剂量必须属于该药品；药品没解析出来时不可能有合法剂量（必填表已挡住）。
      const medication = values.medication;
      if (medication !== undefined) {
        const dose = this.doses.normalize(doseText, medication);
        if (!dose.ok) {
          return { outcome: rejected('unknown_dose', dose.raw, item.index) };
        }
        values.dose = dose.value;
      }
    }

    const statesList = Array.isArray(raw['states']) ? (raw['states'] as readonly string[]) : null;
    if (statesList !== null && statesList.length > 0) {
      const needed = FACT_TYPES.has(type) && type !== 'closed' && type !== 'reopened' && type !== 'capacity';
      // 只有州类/偏好类候选真的用到 states；其余类型的非法组合已在第 6 步拒绝。
      if (needed) {
        const normalizedStates: StateCode[] = [];
        for (const state of statesList) {
          const normalizedState = this.states.normalize(state);
          if (!normalizedState.ok) {
            return { outcome: rejected('unknown_state', normalizedState.raw, item.index) };
          }
          normalizedStates.push(normalizedState.value);
        }
        values.states = normalizedStates;
      }
    }

    return { values };
  }

  // -------------------------------------------------------------------------
  // 第 9 步：时间
  // -------------------------------------------------------------------------

  private mergeTime(
    item: WorkItem,
    phrase: PhraseTemporal | null,
    confidence: ExtractionResult['confidence'],
    ctx: ValidationContext,
  ): TimeMergeResult {
    const candidate = item.candidate;
    const raw = candidate as unknown as Record<string, unknown>;
    const atDate = this.calendar.dateOf(ctx.at);

    // 9a. 模型日期必须先过 `etDate()`（模型输出是外部输入，不信它「看起来像日期」）。
    const modelFrom = this.parseModelDate(raw['from_date'], 'from_date');
    if (!modelFrom.ok) return modelFrom;
    const modelUntil = this.parseModelDate(raw['until_date'], 'until_date');
    if (!modelUntil.ok) return modelUntil;
    const fromModelDate = modelFrom.value;
    const untilModelDate = modelUntil.value;

    // 9b. 置信度门：解析器没命中时只有 high 才采信模型日期；
    //     low 必须由确定性解析器独立确认时间（§5.8 末段）。
    const parserHit = phrase !== null;
    if (!parserHit && confidence === 'low') {
      return { ok: false, code: 'bad_request', detail: 'low_confidence_without_phrase' };
    }
    if (!parserHit && confidence !== 'high' && (fromModelDate !== null || untilModelDate !== null)) {
      return { ok: false, code: 'bad_request', detail: 'unverified_model_date' };
    }

    // 9c. from：解析器优先；否则模型日期（同日/合法才用）；再否则缺省 = at。
    let fromDate: EtDate;
    let fromInstant: Instant;
    let fromSource: string;
    if (phrase?.from !== undefined) {
      fromDate = phrase.from.date;
      if (fromModelDate !== null && fromModelDate !== fromDate) {
        return {
          ok: false,
          code: 'bad_interval',
          detail: `from:model=${fromModelDate},phrase=${fromDate}`,
        };
      }
      fromInstant = this.instantOf(phrase.from);
      fromSource = `parser:${phrase.from.rule}`;
    } else if (fromModelDate !== null) {
      fromDate = fromModelDate;
      fromInstant = this.calendar.startOfDay(fromModelDate);
      fromSource = 'model';
    } else {
      fromDate = atDate;
      fromInstant = ctx.at;
      fromSource = 'default:occurred_at';
    }

    // 9d. until：解析器优先；否则模型日期；再否则 null（一直有效）。
    let untilDate: EtDate | null = null;
    let untilInstant: Instant | null = null;
    let untilSource = 'default:null';
    if (phrase?.until !== undefined) {
      untilDate = phrase.until.date;
      if (untilModelDate !== null && untilModelDate !== untilDate) {
        return {
          ok: false,
          code: 'bad_interval',
          detail: `until:model=${untilModelDate},phrase=${untilDate}`,
        };
      }
      untilInstant = this.instantOf(phrase.until);
      untilSource = `parser:${phrase.until.rule}`;
    } else if (untilModelDate !== null) {
      untilDate = untilModelDate;
      untilInstant = this.calendar.startOfDay(untilModelDate);
      untilSource = 'model';
    }

    // 9e. `until <= from`：星期类子句（如周一收到 "until Monday"）改取下一个该星期，
    //     并记 assumption；其它来源的矛盾直接拒绝（W13）。
    const assumptions: string[] = [];
    if (untilInstant !== null && untilDate !== null && !fromInstant.isBefore(untilInstant)) {
      const rule = phrase?.until?.rule;
      if (rule !== undefined && WEEKDAY_UNTIL_RULES.has(rule)) {
        untilDate = this.calendar.addDays(untilDate, 7);
        untilInstant = this.calendar.startOfDay(untilDate);
        untilSource = 'default:next_weekday';
        assumptions.push('until <= from → used next weekday');
      } else {
        return { ok: false, code: 'bad_interval', detail: 'until<=from' };
      }
      if (!fromInstant.isBefore(untilInstant)) {
        return { ok: false, code: 'bad_interval', detail: 'until<=from' };
      }
    }

    // 9f. 窗口：闭区间 [weekStart, weekStart+14 天]，两端都含（§16-Q17）。
    if (fromDate < this.window.from || fromDate > this.window.to) {
      return {
        ok: false,
        code: 'interval_out_of_window',
        detail: `from:${fromDate}`,
      };
    }
    if (untilDate !== null && (untilDate < this.window.from || untilDate > this.window.to)) {
      return {
        ok: false,
        code: 'interval_out_of_window',
        detail: `until:${untilDate}`,
      };
    }

    const interval = Interval.of(fromInstant, untilInstant);
    if (!interval.ok) {
      return { ok: false, code: 'bad_interval', detail: 'interval:invalid' };
    }

    // 9g. 否定类事实缺 `until` = 无限期：记一条安全侧假设（W5 / Q18；不进 Sam）。
    if (untilInstant === null && INDEFINITE_WHEN_NO_UNTIL.has(item.candidate.type as FactType)) {
      assumptions.push(`${item.candidate.type} without until → indefinite`);
    }

    // 9h. 每个被覆盖的时间字段都记来源（模型给了日期时才算「覆盖」）。
    const dateOverrides: DateOverride[] = [];
    if (fromModelDate !== null && fromSource !== 'model') {
      dateOverrides.push({
        field: 'from',
        model: fromModelDate,
        used: this.calendar.iso(fromInstant),
        source: fromSource,
      });
    }
    if (untilModelDate !== null && untilSource !== 'model' && untilInstant !== null) {
      dateOverrides.push({
        field: 'until',
        model: untilModelDate,
        used: this.calendar.iso(untilInstant),
        source: untilSource,
      });
    }

    return {
      ok: true,
      value: {
        interval: interval.value,
        // 两个字段都显式写来源：`until` 缺省也要出现（审计示例里直到："default:null"）。
        sources: { from: fromSource, until: untilSource },
        assumptions,
        dateOverrides,
      },
    };
  }

  /** 解析模型给的 `YYYY-MM-DD`；`null`/缺省返回 null，非法返回 `bad_request`（9a）。 */
  private parseModelDate(
    value: unknown,
    field: string,
  ): { ok: true; value: EtDate | null } | { ok: false; code: ErrorCode; detail: string } {
    if (value === undefined || value === null) return { ok: true, value: null };
    if (typeof value !== 'string' || value.trim() === '') {
      // 空串按缺省处理；非字符串是形状错误。
      if (typeof value === 'string') return { ok: true, value: null };
      return { ok: false, code: 'bad_request', detail: field };
    }
    const parsed = etDate(value.trim());
    if (!parsed.ok) {
      return { ok: false, code: 'bad_request', detail: `${field}:${value}` };
    }
    return { ok: true, value: parsed.value };
  }

  /** `PhraseDate` → 绝对瞬时刻：`day` 粒度取该 ET 日 00:00。 */
  private instantOf(field: NonNullable<PhraseTemporal['from']>): Instant {
    return field.instant ?? this.calendar.startOfDay(field.date);
  }

  // -------------------------------------------------------------------------
  // 第 10 步：组装草稿
  // -------------------------------------------------------------------------

  private buildApplied(
    items: readonly WorkItem[],
    pharmacies: readonly PharmacyId[],
    normalized: readonly NormalizedValues[],
    times: readonly TimeMerge[],
    result: ExtractionResult,
  ): ValidationOutcome {
    const drafts: FactDraft[] = [];
    const sources: FactDateSources[] = [];
    const assumptions: string[] = [];
    const dateOverrides: DateOverride[] = [];

    for (const [pos, item] of items.entries()) {
      const type = item.candidate.type as FactType;
      const values = normalized[pos];
      const merged = times[pos];
      const base = { pharmacy: pharmacies[pos], interval: merged.interval };

      // 同一封邮件里的 assumption / override 是邮件级事实，扇出的多条草稿共享。
      assumptions.push(...merged.assumptions);
      dateOverrides.push(...merged.dateOverrides);

      switch (type) {
        case 'stock_unavailable':
        case 'stock_available': {
          drafts.push({ ...base, type, medication: values.medication, dose: values.dose });
          sources.push({ ...merged.sources });
          break;
        }
        case 'state_blocked':
        case 'state_allowed': {
          // 一个候选带多个州 → 每州一条 fact（`coverage:{pharmacy}:{state}` 一 cell）。
          for (const state of values.states ?? []) {
            drafts.push({ ...base, type, state });
            sources.push({ ...merged.sources });
          }
          break;
        }
        case 'closed':
        case 'reopened': {
          drafts.push({ ...base, type });
          sources.push({ ...merged.sources });
          break;
        }
        case 'capacity': {
          drafts.push({ ...base, type, perDay: item.candidate.per_day as number });
          sources.push({ ...merged.sources });
          break;
        }
        case 'routing_preference': {
          // `dose`/`state` 缺省 = 通配（T13/W2）：没给 dose 就不带 dose；states 为空 = 所有州。
          const basePreference: FactDraft = {
            ...base,
            type,
            medication: values.medication,
            ...(values.dose === undefined ? {} : { dose: values.dose }),
          };
          const states = values.states ?? [];
          if (states.length === 0) {
            drafts.push(basePreference);
            sources.push({ ...merged.sources });
          } else {
            for (const state of states) {
              drafts.push({ ...basePreference, state });
              sources.push({ ...merged.sources });
            }
          }
          break;
        }
      }
    }

    return {
      kind: 'applied',
      drafts,
      notes: typeof result.notes === 'string' && result.notes.trim() !== '' ? [result.notes] : [],
      assumptions: [...new Set(assumptions)],
      dateOverrides,
      sources,
    };
  }
}
