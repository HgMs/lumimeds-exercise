/**
 * `SnapshotMapper`：`SimulationSession`（领域 camelCase）↔ `PersistedState`
 * （落盘 snake_case）（`ARCHITECTURE.md` §5.9/§11.1；`DATA-CONTRACTS.md` §3.6）。
 *
 * 这里是两级时间的唯一转换点：
 * - 领域内是 `Instant` 值对象；
 * - 落盘一律 `calendar.iso(...)`，即**带 ET 偏移**的字符串（`-05:00` / `-04:00`），
 *   不是 UTC `Z`。这样 `state.json` 与 `out/*.jsonl` 的读法一致，人眼可对照 `sim/`；
 *   `Instant.parse` 对两种偏移形式都能原样读回。
 *
 * `capacity` 不进快照：`fromPersisted` 用 `sent_orders` + 时区重新派生（D4，避免两份
 * 真值）。`seq` 只存 `fact`；decision / sam 以业务 id 为键，不需要序号（§11.1）。
 *
 * 失败语义：`fromPersisted` 只在快照本身不可用时返回 `Err(AppError('persist_failed'))`
 * （坏 JSON 已由 `StateStore.load` 拦下；这里管 `version !== 1`、字段缺失、时间不可
 * 解析、config 无法重建 registry、fact 序号非法等）。快照是「曾经成功提交过的状态」，
 * 所以任何读不回来的情况都说明**快照损坏/不可用**，而不是业务输入错误——因此选
 * `persist_failed`（已登记码，`ARCHITECTURE.md` §6.3：快照不可用 → 无会话 → 后续
 * 事件 500 `no_session`），而不是 `bad_started_config`。
 */
import { AppError } from '../../kernel/errors.ts';
import { IdSequence } from '../../kernel/ids.ts';
import { err, ok } from '../../kernel/result.ts';
import type { Result } from '../../kernel/result.ts';
import type { EtCalendar } from '../../kernel/time/et-calendar.ts';
import { Instant } from '../../kernel/time/instant.ts';
import { CapacityLedger } from '../../domain/capacity/capacity-ledger.ts';
import { Catalogue } from '../../domain/catalogue.ts';
import type { PharmacyConfig } from '../../domain/config.ts';
import type { SamEntry } from '../../domain/email/sam-list.ts';
import { SamList } from '../../domain/email/sam-list.ts';
import type { PersistedFact as DomainPersistedFact } from '../../domain/facts/fact-store.ts';
import { FactStore } from '../../domain/facts/fact-store.ts';
import { StateNormalizer } from '../../domain/normalize/state-normalizer.ts';
import { PharmacyRegistry } from '../../domain/pharmacy.ts';
import type {
  CandidateEvaluation,
  FailureCode,
  PersistedRoutingDecision,
  RoutingDecision,
} from '../../domain/routing/decision.ts';
import type { PersistedFact, PersistedState } from '../ports/state-store.ts';
import { DecisionLog } from './decision-log.ts';
import { SentOrderLog } from './sent-order-log.ts';
import type { PersistedSentOrder } from './sent-order-log.ts';
import { SimulationSession, validationWindowOf } from './simulation-session.ts';

/** 快照不可用（§6.3）：快照是提交点，读不回来即损坏，用 `persist_failed`。 */
function badSnapshot(message: string, detail?: Record<string, unknown>): AppError {
  return new AppError('persist_failed', `快照不可用：${message}`, detail);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw badSnapshot(`${field} 必须是非空字符串`, { field });
  }
  return value;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw badSnapshot(`${field} 必须是数字`, { field });
  }
  return value;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw badSnapshot(`${field} 必须是布尔值`, { field });
  }
  return value;
}

/** 解析落盘时间串（带偏移）；失败 → 快照损坏。 */
function parseInstant(raw: unknown, field: string): Instant {
  const value = requiredString(raw, field);
  const parsed = Instant.parse(value);
  if (!parsed.ok) {
    throw badSnapshot(`${field} 不是带偏移的合法时间：${JSON.stringify(value)}`, {
      field,
      value,
      parse_error: parsed.error.message,
    });
  }
  return parsed.value;
}

/**
 * `RoutingDecision` → `PersistedRoutingDecision`（`DATA-CONTRACTS.md` §3.4）。
 * 审计（`AuditRecorder`）与快照（本文件）共用这一份转换，避免两处漂移。
 */
export function toPersistedDecision(
  decision: RoutingDecision,
  calendar: EtCalendar,
): PersistedRoutingDecision {
  return {
    order_id: decision.orderId,
    at: calendar.iso(decision.at),
    order: {
      order_id: decision.order.orderId,
      state: decision.order.state,
      medication: decision.order.medication,
      dose: decision.order.dose,
    },
    chosen: decision.chosen,
    basis: decision.basis,
    reason: decision.reason,
    candidates: decision.candidates.map((candidate) => ({
      pharmacy: candidate.pharmacy,
      eligible: candidate.eligible,
      shipsInDays: candidate.shipsInDays,
      price: candidate.price,
      capacityLeft: candidate.capacityLeft,
      failures: [...candidate.failures],
    })),
    preference:
      decision.preference === null
        ? null
        : { pharmacy: decision.preference.pharmacy, event_id: decision.preference.eventId },
    override: decision.override,
    sent:
      decision.sent === null
        ? null
        : { status: decision.sent.status, at: calendar.iso(decision.sent.at) },
  };
}

function fromPersistedCandidate(raw: unknown, index: number): CandidateEvaluation {
  if (!isRecord(raw)) {
    throw badSnapshot(`decisions.candidates[${index}] 不是对象`, { index });
  }
  const failures = raw.failures;
  if (!Array.isArray(failures)) {
    throw badSnapshot(`decisions.candidates[${index}].failures 必须是数组`, { index });
  }
  return {
    pharmacy: requiredString(raw.pharmacy, `decisions.candidates[${index}].pharmacy`),
    eligible: requiredBoolean(raw.eligible, `decisions.candidates[${index}].eligible`),
    shipsInDays: requiredNumber(raw.shipsInDays, `decisions.candidates[${index}].shipsInDays`),
    price:
      raw.price === null
        ? null
        : requiredNumber(raw.price, `decisions.candidates[${index}].price`),
    capacityLeft: requiredNumber(
      raw.capacityLeft,
      `decisions.candidates[${index}].capacityLeft`,
    ),
    failures: failures.map((failure, failureIndex) =>
      requiredString(failure, `decisions.candidates[${index}].failures[${failureIndex}]`),
    ) as FailureCode[],
  };
}

/**
 * `PersistedRoutingDecision` → `RoutingDecision`。字段与 `toPersistedDecision` 对称；
 * 遇到坏形状抛 `AppError('persist_failed')`，由 `fromPersisted` 折成 `Result`。
 */
export function fromPersistedDecision(persisted: PersistedRoutingDecision): RoutingDecision {
  const raw = persisted as unknown;
  if (!isRecord(raw)) throw badSnapshot('decision 不是对象');
  const order = raw.order;
  if (!isRecord(order)) throw badSnapshot(`订单 ${String(raw.order_id)} 的 order 不是对象`);
  const preference = raw.preference;
  const sent = raw.sent;
  if (!Array.isArray(raw.candidates)) {
    throw badSnapshot(`订单 ${String(raw.order_id)} 的 candidates 必须是数组`);
  }
  return {
    orderId: requiredString(raw.order_id, 'decisions.order_id'),
    at: parseInstant(raw.at, `decisions[${String(raw.order_id)}].at`),
    order: {
      orderId: requiredString(order.order_id, 'decisions.order.order_id'),
      state: requiredString(order.state, 'decisions.order.state'),
      medication: requiredString(order.medication, 'decisions.order.medication'),
      dose: requiredString(order.dose, 'decisions.order.dose'),
    },
    chosen: requiredString(raw.chosen, 'decisions.chosen'),
    basis: requiredString(raw.basis, 'decisions.basis') as RoutingDecision['basis'],
    reason: raw.reason === null ? null : requiredString(raw.reason, 'decisions.reason'),
    candidates: raw.candidates.map((candidate, index) =>
      fromPersistedCandidate(candidate, index),
    ),
    preference:
      preference === null
        ? null
        : {
            pharmacy: requiredString(
              (preference as Record<string, unknown>).pharmacy,
              'decisions.preference.pharmacy',
            ),
            eventId: requiredString(
              (preference as Record<string, unknown>).event_id,
              'decisions.preference.event_id',
            ),
          },
    override: raw.override === null ? null : requiredString(raw.override, 'decisions.override'),
    sent:
      sent === null
        ? null
        : {
            status: requiredNumber(
              (sent as Record<string, unknown>).status,
              'decisions.sent.status',
            ),
            at: parseInstant((sent as Record<string, unknown>).at, 'decisions.sent.at'),
          },
  };
}

/** 从落盘 id 取 `fact_NNNN` 的序号；用于让 `IdSequence` 不会与已存在的 fact 撞号。 */
function factIdSequence(id: string): number {
  const match = /^fact_(\d+)$/.exec(id);
  if (match === null) return 0;
  const seq = Number(match[1]);
  return Number.isSafeInteger(seq) && seq > 0 ? seq : 0;
}

/** `SnapshotMapper` 的构造依赖：只需要日历（registry/catalogue 由快照里的 config 重建）。 */
export interface SnapshotMapperDeps {
  calendar: EtCalendar;
}

export class SnapshotMapper {
  constructor(private readonly deps: SnapshotMapperDeps) {}

  /** 会话 → 落盘快照。所有时间用 `calendar.iso` 输出（ET 偏移）。 */
  toPersisted(session: SimulationSession): PersistedState {
    const calendar = this.deps.calendar;
    const config = session.config;

    const facts: PersistedFact[] = session.facts.snapshot().map((fact) =>
      this.toPersistedFact(fact),
    );

    const sentOrders: Record<string, PersistedSentOrder> = {};
    for (const entry of session.sent.entries()) {
      sentOrders[entry.orderId] = { pharmacy: entry.pharmacy, at: calendar.iso(entry.at) };
    }

    const decisions: Record<string, PersistedRoutingDecision> = {};
    for (const [orderId, decision] of Object.entries(session.decisions.snapshot())) {
      decisions[orderId] = toPersistedDecision(decision, calendar);
    }

    return {
      version: 1,
      week_started_at: calendar.iso(session.startedAt),
      pharmacy_api: session.pharmacyApi,
      config,
      facts,
      seen_event_ids: [...session.seenEventIds],
      sent_orders: sentOrders,
      decisions,
      sam: [...session.sam.snapshot()],
      seq: { fact: session.ids.snapshot()['fact'] ?? 0 },
      last_event_at: calendar.iso(session.lastEventAt),
      degraded: session.degraded,
    };
  }

  /**
   * 落盘快照 → 会话。`version !== 1`、字段缺失、时间/序号非法、config 无法重建
   * registry 等一律 `Err(persist_failed)`（见文件头注释）。
   */
  fromPersisted(persisted: PersistedState): Result<SimulationSession, AppError> {
    try {
      return ok(this.build(persisted));
    } catch (cause) {
      if (cause instanceof AppError) return err(cause);
      const message = cause instanceof Error ? cause.message : String(cause);
      return err(badSnapshot(message));
    }
  }

  private build(persisted: PersistedState): SimulationSession {
    const raw = persisted as unknown;
    if (!isRecord(raw)) throw badSnapshot('state.json 顶层不是对象');

    // `version` 先判：不认识的版本不做任何猜测式读取（§5.9 / §6.3）。
    if (raw.version !== 1) {
      throw new AppError(
        'persist_failed',
        `快照 version 不支持：${JSON.stringify(raw.version)}（只支持 1）`,
        { version: raw.version ?? null },
      );
    }

    // ---- config → registry / catalogue ----
    const configRaw = raw.config;
    if (
      !isRecord(configRaw) ||
      !isRecord(configRaw.catalogue) ||
      !Array.isArray(configRaw.pharmacies) ||
      !Array.isArray(configRaw.lumimedsOps)
    ) {
      throw badSnapshot('config 形状非法', { field: 'config' });
    }
    const config = configRaw as unknown as SimulationSession['config'];
    const catalogue = Catalogue.from(
      configRaw.catalogue as Readonly<Record<string, readonly string[]>>,
    );
    const registry = PharmacyRegistry.from(configRaw.pharmacies as readonly PharmacyConfig[], {
      catalogue,
      states: new StateNormalizer(),
    });
    if (!registry.ok) {
      throw new AppError(
        'persist_failed',
        `快照的 config 无法重建药房注册表：${registry.error.message}`,
        { rule: registry.error.detail?.['rule'] ?? null },
      );
    }

    // ---- 时间 ----
    const startedAt = parseInstant(raw.week_started_at, 'week_started_at');
    const lastEventAt = parseInstant(raw.last_event_at, 'last_event_at');
    const pharmacyApi = requiredString(raw.pharmacy_api, 'pharmacy_api');

    // ---- facts ----
    if (!Array.isArray(raw.facts)) throw badSnapshot('facts 必须是数组');
    const persistedFacts = raw.facts as readonly DomainPersistedFact[];
    const facts = FactStore.restore(persistedFacts);
    let maxFactSeq = 0;
    for (const fact of persistedFacts) {
      maxFactSeq = Math.max(maxFactSeq, factIdSequence(fact.id));
    }

    // ---- sent_orders ----
    if (!isRecord(raw.sent_orders)) throw badSnapshot('sent_orders 必须是对象');
    const sent = SentOrderLog.restore(raw.sent_orders as Record<string, PersistedSentOrder>);

    // ---- decisions（快照 key 必须与 decision.order_id 一致） ----
    if (!isRecord(raw.decisions)) throw badSnapshot('decisions 必须是对象');
    const restoredDecisions: Record<string, RoutingDecision> = {};
    for (const [orderId, value] of Object.entries(raw.decisions)) {
      const decision = fromPersistedDecision(value as PersistedRoutingDecision);
      if (decision.orderId !== orderId) {
        throw badSnapshot(
          `decisions 的 key 与 order_id 不一致：${JSON.stringify(orderId)} vs ${JSON.stringify(decision.orderId)}`,
        );
      }
      restoredDecisions[orderId] = decision;
    }
    const decisions = DecisionLog.restore(restoredDecisions);

    // ---- sam ----
    if (!Array.isArray(raw.sam)) throw badSnapshot('sam 必须是数组');
    const sam = SamList.restore(raw.sam as readonly SamEntry[]);

    // ---- seen_event_ids ----
    if (!Array.isArray(raw.seen_event_ids)) throw badSnapshot('seen_event_ids 必须是数组');
    const seenEventIds = new Set<string>();
    for (const eventId of raw.seen_event_ids) {
      if (typeof eventId !== 'string' || eventId === '') {
        throw badSnapshot('seen_event_ids 含非字符串项');
      }
      seenEventIds.add(eventId);
    }

    // ---- ids：seq.fact + facts 的最大序号（防撞号） ----
    const rawSeq = raw.seq;
    const seqFact =
      isRecord(rawSeq) &&
      typeof rawSeq.fact === 'number' &&
      Number.isInteger(rawSeq.fact) &&
      rawSeq.fact >= 0
        ? rawSeq.fact
        : 0;
    const ids = IdSequence.restore({ fact: Math.max(seqFact, maxFactSeq) });

    // ---- capacity：由 sent_orders 派生（不进快照，D4） ----
    const capacity = CapacityLedger.rebuild(
      [...sent.entries()].map((entry) => ({ pharmacy: entry.pharmacy, at: entry.at })),
      this.deps.calendar,
    );

    return new SimulationSession({
      config,
      startedAt,
      pharmacyApi,
      validationWindow: validationWindowOf(this.deps.calendar, startedAt),
      registry: registry.value,
      catalogue,
      facts,
      capacity,
      sam,
      sent,
      decisions,
      seenEventIds,
      ids,
      lastEventAt,
      degraded: raw.degraded === true,
    });
  }

  /** 单条 fact：时间串统一换成 ET 偏移形式（`calendar.iso`）。 */
  private toPersistedFact(fact: DomainPersistedFact): PersistedFact {
    const calendar = this.deps.calendar;
    const assertedAt = parseInstant(fact.asserted_at, `facts[${fact.id}].asserted_at`);
    const from = parseInstant(fact.interval.from, `facts[${fact.id}].interval.from`);
    const until =
      fact.interval.until === null
        ? null
        : parseInstant(fact.interval.until, `facts[${fact.id}].interval.until`);
    return {
      ...fact,
      asserted_at: calendar.iso(assertedAt),
      interval: {
        from: calendar.iso(from),
        until: until === null ? null : calendar.iso(until),
      },
    };
  }
}
