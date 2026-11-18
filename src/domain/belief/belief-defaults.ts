/**
 * `BeliefDefaults`：每类事实「没有覆盖该时刻的 fact 时取什么」的默认表
 * （`ARCHITECTURE.md` §5.5）。
 *
 * **INV-5（安全侧 fallback）**：默认值一律取更保守的一侧——缺货、不可发、容量取
 * config 值。「没有事实」永远不能被解释成「可以发」。所以这张表直接对应
 * `PharmacyBase` 的 config 字段，而不是「默认允许」。
 */
import type { PharmacyBase } from '../pharmacy.ts';
import type { DoseId, MedicationId, StateCode } from '../types.ts';

/** 无 fact 覆盖时的回落值；`BeliefResolver` 注入，测试可换实现。 */
export interface BeliefDefaults {
  /** 营业状态：没有覆盖时刻的 `closed`/`reopened` → `base.openByDefault`。 */
  closure(base: PharmacyBase): boolean;
  /** 能否发某州：没有覆盖的 `state_blocked`/`state_allowed` → `!base.blockedStates.includes(state)`。 */
  coverage(base: PharmacyBase, state: StateCode): boolean;
  /** 是否有现货：没有覆盖的库存断言 → config 的现货表。 */
  stock(base: PharmacyBase, medication: MedicationId, dose: DoseId): boolean;
  /** 当日容量：没有覆盖的 `capacity` fact → `base.dailyCapacity`。 */
  capacity(base: PharmacyBase): number;
}

/** 默认实现：完全由 config 归一化视图给出（D9 的 fallback 一侧）。 */
export class ConfigBeliefDefaults implements BeliefDefaults {
  closure(base: PharmacyBase): boolean {
    return base.openByDefault;
  }

  coverage(base: PharmacyBase, state: StateCode): boolean {
    return !base.blockedStates.includes(state);
  }

  stock(base: PharmacyBase, medication: MedicationId, dose: DoseId): boolean {
    const doses = base.stock[medication];
    return doses !== undefined && doses.includes(dose);
  }

  capacity(base: PharmacyBase): number {
    return base.dailyCapacity;
  }
}

/** 生产路径共享的无状态单例（`ConfigBeliefDefaults` 没有可变状态）。 */
export const DEFAULT_BELIEF_DEFAULTS: BeliefDefaults = new ConfigBeliefDefaults();
