/**
 * `SimulationSession`：一周的聚合根（`ARCHITECTURE.md` §5.9「SimulationSession」、
 * `DATA-CONTRACTS.md` §3.6）。
 *
 * 它把「这一周我们相信什么」全部装在一个对象里：config 的归一化视图（registry /
 * catalogue）、只追加的 fact、容量账本、Sam 列表、已发单、决策日志、幂等集合、
 * id 序号、最后一次事件时刻。`SnapshotMapper` 能从 `PersistedState` 完整重建它
 * （§11.1），所以进程重启后内存对象与磁盘是同一份真值。
 *
 * 可变字段只有三个：
 * - `lastEventAt`：`GET /state` 的求值时刻；初值 = `startedAt`（§5.9）；
 * - `degraded`：写盘曾失败过（§9、§11.1 的新增字段），`/health` 暴露；
 * - 其余集合通过各自的方法（`facts.append`、`sent.mark`……）变更。
 *
 * `validationWindow` 在 `simulation.started` 时算一次，是**闭区间**
 * `[mondayOf(startedAt), mondayOf(startedAt) + 14 天]`（`REQUIREMENTS` §4.3 第 5 条、
 * §16-Q17 已定案）；两端都含，由 `FactValidator` 解释。
 */
import type { IdSequence } from '../../kernel/ids.ts';
import type { EtCalendar } from '../../kernel/time/et-calendar.ts';
import type { EtDate } from '../../kernel/time/et-date.ts';
import type { Instant } from '../../kernel/time/instant.ts';
import type { CapacityLedger } from '../../domain/capacity/capacity-ledger.ts';
import type { Catalogue } from '../../domain/catalogue.ts';
import type { SimConfig } from '../../domain/config.ts';
import type { SamList } from '../../domain/email/sam-list.ts';
import type { FactStore } from '../../domain/facts/fact-store.ts';
import type { PharmacyRegistry } from '../../domain/pharmacy.ts';
import type { DecisionLog } from './decision-log.ts';
import type { SentOrderLog } from './sent-order-log.ts';

/** 校验窗口：闭区间 `[from, to]`（`REQUIREMENTS` §4.3 第 5 条、§16-Q17）。 */
export interface ValidationWindow {
  /** 周一开始日（含）。 */
  from: EtDate;
  /** `from + 14 天`（含）。 */
  to: EtDate;
}

/**
 * 计算某次 `simulation.started` 的校验窗口：`mondayOf(startedAt)` 起 14 天，闭区间。
 *
 * 两处会用到它（新建会话、从快照重建），所以做成纯函数而不是两段复制代码——
 * 窗口公式只有一处真值。
 */
export function validationWindowOf(calendar: EtCalendar, startedAt: Instant): ValidationWindow {
  const from = calendar.mondayOf(calendar.dateOf(startedAt));
  return { from, to: calendar.addDays(from, 14) };
}

/** 构造 `SimulationSession` 的全部字段（工厂与快照重建共用）。 */
export interface SimulationSessionInit {
  /** `simulation.started.config` 原样（落盘时再写回快照）。 */
  config: SimConfig;
  /** `simulation.started.occurred_at` = 本周起点（快照里的 `week_started_at`）。 */
  startedAt: Instant;
  /** 模拟器药房 API base URL。 */
  pharmacyApi: string;
  /** 闭区间校验窗口。 */
  validationWindow: ValidationWindow;
  registry: PharmacyRegistry;
  catalogue: Catalogue;
  facts: FactStore;
  capacity: CapacityLedger;
  sam: SamList;
  sent: SentOrderLog;
  decisions: DecisionLog;
  /** 已处理事件（幂等门，`ARCHITECTURE.md` §11.4 第一道闸）。 */
  seenEventIds: Set<string>;
  /** fact id 序号（`seq.fact`）。 */
  ids: IdSequence;
  /** 最后一次事件时刻；初值 = `startedAt`。 */
  lastEventAt: Instant;
  /** 写盘曾失败过；一旦为 true 不再回落（`/health` 只关心「曾失败」）。 */
  degraded: boolean;
}

export class SimulationSession {
  readonly config: SimConfig;
  readonly startedAt: Instant;
  readonly pharmacyApi: string;
  readonly validationWindow: ValidationWindow;
  readonly registry: PharmacyRegistry;
  readonly catalogue: Catalogue;
  readonly facts: FactStore;
  readonly capacity: CapacityLedger;
  readonly sam: SamList;
  readonly sent: SentOrderLog;
  readonly decisions: DecisionLog;
  readonly seenEventIds: Set<string>;
  readonly ids: IdSequence;

  /** 可变：`/state` 的求值时刻（初值 = `startedAt`）。 */
  lastEventAt: Instant;
  /** 可变：写盘失败标记（sticky）。 */
  degraded: boolean;

  constructor(init: SimulationSessionInit) {
    this.config = init.config;
    this.startedAt = init.startedAt;
    this.pharmacyApi = init.pharmacyApi;
    this.validationWindow = init.validationWindow;
    this.registry = init.registry;
    this.catalogue = init.catalogue;
    this.facts = init.facts;
    this.capacity = init.capacity;
    this.sam = init.sam;
    this.sent = init.sent;
    this.decisions = init.decisions;
    this.seenEventIds = init.seenEventIds;
    this.ids = init.ids;
    this.lastEventAt = init.lastEventAt;
    this.degraded = init.degraded;
  }
}
