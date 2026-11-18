/**
 * `BaseFactExpander`：把 `simulation.started` 的 config 展开成一批**基础 fact**
 * （`ARCHITECTURE.md` §5.4、`DATA-CONTRACTS.md` §3.1）。
 *
 * 产物（每家药房）：
 * - 每个现货剂量一条 `stock_available`；
 * - 每个 `blockedStates` 一条 `state_blocked`；
 * - 一条 `capacity`（`perDay = dailyCapacity`，`until: null`）。
 *
 * **`open` 不展开成 fact**（契约 §3.1）：营业状态用「没有覆盖该时刻的 `closed` fact +
 * `BeliefDefaults.closure(base) = base.openByDefault`」表示，避免为默认值造 fact，
 * 查询时只有一条规则、不用分支。
 *
 * 定位（§5.4）：基础 fact **不是**安全判定的负荷路径——`BeliefDefaults` 仍保留 config
 * fallback（INV-5），所以即使这里漏展开，判定仍然安全，只是快照里少一条「信念来自
 * config 还是邮件」的证据。它们只留在快照里，**不进 `out/facts.jsonl`**（那个文件
 * 是「每封邮件一行」，`simulation.started` 不是邮件）。
 *
 * 顺序确定（C7）：registry 已按 id 升序；药品按 catalogue 顺序；剂量/州按 config 顺序。
 * 同一 `IdSequence` + 同一 started 事件，两次展开得到逐字段相同的 fact 列表。
 */
import { Interval } from '../../kernel/time/interval.ts';
import type { IdSequence } from '../../kernel/ids.ts';
import type { Instant } from '../../kernel/time/instant.ts';
import type { EtCalendar } from '../../kernel/time/et-calendar.ts';
import type { Catalogue } from '../catalogue.ts';
import type { PharmacyRegistry } from '../pharmacy.ts';
import { FactFactory } from './fact-factory.ts';
import type { Fact, FactDraft } from './fact.ts';

/** `BaseFactExpander` 的依赖（§5.4 签名；顺序即 fact id 的分配顺序）。 */
export interface BaseFactExpanderDeps {
  /** fact id 序号（同一周的 `simulation.started` 先 `reset()`）。 */
  ids: IdSequence;
  /** 归一化后的药房（`all()` 已按 id 升序）。 */
  registry: PharmacyRegistry;
  /** 目录（决定药品的展开顺序）。 */
  catalogue: Catalogue;
  /** 日历（签名保留：基础区间目前只是 `[started.at, ∞)`，不需要日期换算）。 */
  calendar: EtCalendar;
}

/** `simulation.started` 里与展开相关的两个字段。 */
export interface BaseFactSeed {
  /** 来源事件 id（基础事实的 `event_id`，用于在审计里区分 config 与邮件）。 */
  eventId: string;
  /** 事件发生时刻 = 基础事实的 `asserted_at`，也是区间起点。 */
  at: Instant;
}

export class BaseFactExpander {
  private readonly factory = new FactFactory();

  constructor(private readonly deps: BaseFactExpanderDeps) {}

  /** config → `Fact[]`。按 registry/catalogue/config 的稳定顺序领 seq。 */
  expand(seed: BaseFactSeed): Fact[] {
    const interval = Interval.of(seed.at, null);
    if (!interval.ok) {
      // `until === null` 时 `Interval.of` 不可能失败；失败只可能是 `at` 不合法（构造时已排除）。
      throw new Error(`BaseFactExpander: 基础区间非法：${interval.error.message}`);
    }
    const baseInterval = interval.value;
    const catalogue = this.deps.catalogue;
    const drafts: FactDraft[] = [];

    for (const pharmacy of this.deps.registry.all()) {
      // 1) 现货：每个 catalogue 药品的每个 config 现货剂量。
      for (const medication of catalogue.medications()) {
        const doses = pharmacy.stock[medication] ?? [];
        for (const dose of doses) {
          drafts.push({
            type: 'stock_available',
            pharmacy: pharmacy.id,
            medication,
            dose,
            interval: baseInterval,
          });
        }
      }
      // 2) 封锁州：config 里的每一项（已归一化成两位码）。
      for (const state of pharmacy.blockedStates) {
        drafts.push({
          type: 'state_blocked',
          pharmacy: pharmacy.id,
          state,
          interval: baseInterval,
        });
      }
      // 3) 日容量：一条 capacity，until = null（一直有效，直到被邮件覆盖）。
      drafts.push({
        type: 'capacity',
        pharmacy: pharmacy.id,
        perDay: pharmacy.dailyCapacity,
        interval: baseInterval,
      });
    }

    return this.factory.createAll(drafts, {
      eventId: seed.eventId,
      at: seed.at,
      ids: this.deps.ids,
    });
  }
}
