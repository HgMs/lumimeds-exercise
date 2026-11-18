/**
 * `BeliefResolver`：把「config 视图 + 只追加的 fact + 容量账本」组装成某一时刻的
 * `PharmacyBelief` / `PharmacyView`（`ARCHITECTURE.md` §5.5）。
 *
 * 为什么要有这层：信念的依赖是 5 个对象（base/at/facts/capacity/calendar/defaults），
 * 让 `OrderRouter` / `EligibilityFilter` 自己拼会在每个调用点重复一遍；resolver 是
 * 无状态的装配器（只持有 `calendar` 与 `defaults` 两个进程级依赖）。
 */
import type { Instant } from '../../kernel/time/instant.ts';
import type { EtCalendar } from '../../kernel/time/et-calendar.ts';
import type { CapacityLedger } from '../capacity/capacity-ledger.ts';
import type { FactStore } from '../facts/fact-store.ts';
import type { PharmacyBase } from '../pharmacy.ts';
import type { BeliefDefaults } from './belief-defaults.ts';
import { PharmacyBelief } from './pharmacy-belief.ts';
import type { PharmacyView } from './pharmacy-view.ts';

/** resolver 的进程级依赖（同一周内不变）。 */
export interface BeliefResolverDeps {
  calendar: EtCalendar;
  defaults: BeliefDefaults;
}

/** 每次求值需要的会话状态（同一时刻可跨药房复用）。 */
export interface BeliefSources {
  facts: FactStore;
  capacity: CapacityLedger;
}

export class BeliefResolver {
  constructor(private readonly deps: BeliefResolverDeps) {}

  /** `at` 时刻该药房的信念（资格判定的唯一输入）。 */
  belief(base: PharmacyBase, at: Instant, sources: BeliefSources): PharmacyBelief {
    return new PharmacyBelief({
      base,
      at,
      facts: sources.facts,
      capacity: sources.capacity,
      calendar: this.deps.calendar,
      defaults: this.deps.defaults,
    });
  }

  /** `at` 时刻该药房的展示快照（= `belief(...).toView()`，不另写一份判断）。 */
  view(base: PharmacyBase, at: Instant, sources: BeliefSources): PharmacyView {
    return this.belief(base, at, sources).toView();
  }
}
