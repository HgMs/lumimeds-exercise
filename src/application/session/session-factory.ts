/**
 * `SessionFactory`：把 `simulation.started` 变成一个全新的 `SimulationSession`
 * （`ARCHITECTURE.md` §5.9、§9 失败矩阵「`SessionFactory`（§5.2）」）。
 *
 * 只做四件事：
 * 1. 形状校验（`pharmacyApi` / `config`）——失败一律 `bad_started_config`，
 *    `EventProcessor` 据此回 500 且**不建会话**（`DATA-CONTRACTS` §1.5）；
 * 2. `Catalogue.from` + `PharmacyRegistry.from`（含 §5.2 的 5 条形状校验）；
 * 3. 算一次闭区间校验窗口（`validationWindowOf`）；
 * 4. `BaseFactExpander.expand` 展开基础 fact（stock / blockedStates / capacity）。
 *
 * 副作用约定：**调用方必须先把 `ids.reset()` 掉**（新周编号从 `fact_0001` 起，
 * `ARCHITECTURE.md` §5.9）。`StartSimulationUseCase` 负责这一步；单独测试本工厂时
 * 也要自己 reset，否则同一 `IdSequence` 会接着上一周的序号分配。
 *
 * 本工厂不碰 IO、不碰 HTTP、不改 `SessionHolder`：它只产出一个纯内存对象。
 */
import { AppError } from '../../kernel/errors.ts';
import { err, ok } from '../../kernel/result.ts';
import type { Result } from '../../kernel/result.ts';
import type { IdSequence } from '../../kernel/ids.ts';
import type { EtCalendar } from '../../kernel/time/et-calendar.ts';
import { Instant } from '../../kernel/time/instant.ts';
import { CapacityLedger } from '../../domain/capacity/capacity-ledger.ts';
import { Catalogue } from '../../domain/catalogue.ts';
import type { PharmacyConfig } from '../../domain/config.ts';
import { SamList } from '../../domain/email/sam-list.ts';
import { BaseFactExpander } from '../../domain/facts/base-facts.ts';
import { FactStore } from '../../domain/facts/fact-store.ts';
import { StateNormalizer } from '../../domain/normalize/state-normalizer.ts';
import { PharmacyRegistry } from '../../domain/pharmacy.ts';
import type { SimulationStartedEvent } from '../../domain/events.ts';
import { DecisionLog } from './decision-log.ts';
import { SentOrderLog } from './sent-order-log.ts';
import { SimulationSession, validationWindowOf } from './simulation-session.ts';

/** `SessionFactory` 的构造依赖。 */
export interface SessionFactoryDeps {
  calendar: EtCalendar;
  /** fact id 序号；调用方在 `create` 前 `reset()`。 */
  ids: IdSequence;
  /** 州归一化器（可注入测试替身；默认直接 new）。 */
  states?: StateNormalizer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function badConfig(message: string, detail?: Record<string, unknown>): Result<never, AppError> {
  return err(new AppError('bad_started_config', message, detail));
}

export class SessionFactory {
  private readonly states: StateNormalizer;

  constructor(private readonly deps: SessionFactoryDeps) {
    this.states = deps.states ?? new StateNormalizer();
  }

  /**
   * 新建会话。返回值是 `Result` 而不是异常：config 坏是**合法失败**
   * （`bad_started_config` → 500），不该用 `try/catch` 表达。
   */
  create(evt: SimulationStartedEvent): Result<SimulationSession, AppError> {
    const raw = evt as Partial<SimulationStartedEvent> | null | undefined;

    // ---- 1. 外部形状（DATA-CONTRACTS §1.5：缺 config/pharmacyApi → 500） ----
    const pharmacyApi = raw?.pharmacyApi;
    if (typeof pharmacyApi !== 'string' || pharmacyApi.trim() === '') {
      return badConfig('simulation.started 缺少非空 pharmacyApi', { field: 'pharmacyApi' });
    }

    const config = raw?.config;
    if (
      !isRecord(config) ||
      !isRecord(config.catalogue) ||
      !Array.isArray(config.pharmacies) ||
      !Array.isArray(config.lumimedsOps)
    ) {
      return badConfig('simulation.started 的 config 形状非法', {
        field: 'config',
        require: 'catalogue(object) + pharmacies(array) + lumimedsOps(array)',
      });
    }

    const occurredAt = raw?.occurred_at;
    if (typeof occurredAt !== 'string') {
      return err(new AppError('bad_timestamp', 'simulation.started 缺少 occurred_at', {}));
    }
    const parsedAt = Instant.parse(occurredAt);
    if (!parsedAt.ok) {
      return err(parsedAt.error);
    }
    const startedAt = parsedAt.value;

    // ---- 2. 目录 + 注册表（形状校验在这里一次性做完） ----
    let catalogue: Catalogue;
    try {
      catalogue = Catalogue.from(config.catalogue as Readonly<Record<string, readonly string[]>>);
    } catch (cause) {
      return badConfig('config.catalogue 无法构建目录', {
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }

    const registry = PharmacyRegistry.from(config.pharmacies as readonly PharmacyConfig[], {
      catalogue,
      states: this.states,
    });
    if (!registry.ok) return err(registry.error);

    // ---- 3. 校验窗口 ----
    const validationWindow = validationWindowOf(this.deps.calendar, startedAt);

    // ---- 4. 基础 fact（ids 必须已 reset；见类注释） ----
    const facts = new FactStore();
    const expander = new BaseFactExpander({
      ids: this.deps.ids,
      registry: registry.value,
      catalogue,
      calendar: this.deps.calendar,
    });
    const eventId = raw?.event_id;
    if (typeof eventId !== 'string' || eventId.trim() === '') {
      return badConfig('simulation.started 缺少非空 event_id（基础 fact 的来源）', {
        field: 'event_id',
      });
    }
    facts.append(expander.expand({ eventId, at: startedAt }));

    return ok(
      new SimulationSession({
        config: config as unknown as SimulationSession['config'],
        startedAt,
        pharmacyApi,
        validationWindow,
        registry: registry.value,
        catalogue,
        facts,
        capacity: new CapacityLedger(),
        sam: new SamList(),
        sent: new SentOrderLog(),
        decisions: new DecisionLog(),
        seenEventIds: new Set<string>(),
        ids: this.deps.ids,
        // lastEventAt 初值 = startedAt（ARCHITECTURE §5.9：GET /state 要有求值时刻）。
        lastEventAt: startedAt,
        degraded: false,
      }),
    );
  }
}
