/**
 * `PharmacyBelief`：`T` 时刻对某家药房的信念（`ARCHITECTURE.md` §5.5）。
 *
 * 四条硬条件做成方法，**`failuresFor(order)` 是唯一一处定义「哪一条不过」的地方**：
 * 资格过滤（`EligibilityFilter`）只调它，不再自己判断一遍（评审 B6）。
 *
 * 语义要点：
 * - **只看向 `occurred_at` 那一刻**：`isOpen()` 不预检未来停业（「明天停店」的邮件
 *   不影响今天的单）。每个方法都是 `resolve(subjectKey, at)` 的单点求值。
 * - **INV-5（安全侧 fallback）**：没有 fact 覆盖 `at` 时取 `BeliefDefaults` 的 config
 *   值（缺货/不可发/容量取 config），绝不把「没有事实」解释成「可以发」。
 * - **`capacityToday` 按决策时刻求值**（§16-Q10）：取覆盖 `at` 的最新 `capacity` fact，
 *   而不是「与 ET 日相交」；`capacityLeft = max(0, today - used)`，永不为负。
 * - **一套表示**：`toView()` 只是展示用 DTO；它的动态字段（openNow/容量）同样走
 *   本类的方法，不另写一份判断。
 */
import type { Instant } from '../../kernel/time/instant.ts';
import type { EtCalendar } from '../../kernel/time/et-calendar.ts';
import type { CapacityLedger } from '../capacity/capacity-ledger.ts';
import type { NormalizedOrder } from '../normalize/order-normalizer.ts';
import type { PharmacyBase } from '../pharmacy.ts';
import type { FailureCode } from '../routing/decision.ts';
import type { DoseId, MedicationId, PharmacyId, StateCode } from '../types.ts';
import type { FactStore } from '../facts/fact-store.ts';
import { subjectKeyOf } from '../facts/fact.ts';
import type { BeliefDefaults } from './belief-defaults.ts';
import type { PharmacyView } from './pharmacy-view.ts';

/** `PharmacyBelief` 的构造入参（由 `BeliefResolver` 组装）。 */
export interface PharmacyBeliefInit {
  /** config 的归一化视图（身份/价格/config fallback 的来源）。 */
  base: PharmacyBase;
  /** 求值时刻 = 决策事件的 `occurred_at`（业务时间，唯一「现在」）。 */
  at: Instant;
  /** 只追加的事实存储。 */
  facts: FactStore;
  /** 当日已发单计数（按 ET 日）。 */
  capacity: CapacityLedger;
  /** 用来把 `at` 换成 ET 日期（容量按 ET 自然日重置）。 */
  calendar: EtCalendar;
  /** 无 fact 覆盖时的回落值（INV-5）。 */
  defaults: BeliefDefaults;
}

/** 库存主体的键：用 `subjectKeyOf` 生成，保证与 `FactStore` 的 cell 完全一致。 */
function stockKey(pharmacy: PharmacyId, medication: MedicationId, dose: DoseId): string {
  return subjectKeyOf({ type: 'stock_available', pharmacy, medication, dose });
}

function coverageKey(pharmacy: PharmacyId, state: StateCode): string {
  return subjectKeyOf({ type: 'state_blocked', pharmacy, state });
}

function closureKey(pharmacy: PharmacyId): string {
  return subjectKeyOf({ type: 'closed', pharmacy });
}

function capacityKey(pharmacy: PharmacyId): string {
  return subjectKeyOf({ type: 'capacity', pharmacy });
}

export class PharmacyBelief {
  readonly id: PharmacyId;
  readonly name: string;
  readonly shipsInDays: number;
  readonly price: Readonly<Record<MedicationId, number>>;

  private readonly base: PharmacyBase;
  private readonly at: Instant;
  private readonly facts: FactStore;
  private readonly capacity: CapacityLedger;
  private readonly calendar: EtCalendar;
  private readonly defaults: BeliefDefaults;

  constructor(init: PharmacyBeliefInit) {
    this.base = init.base;
    this.at = init.at;
    this.facts = init.facts;
    this.capacity = init.capacity;
    this.calendar = init.calendar;
    this.defaults = init.defaults;
    this.id = init.base.id;
    this.name = init.base.name;
    this.shipsInDays = init.base.shipsInDays;
    this.price = init.base.price;
  }

  /**
   * 求值时刻是否营业。规则：取覆盖 `at` 的最后一条 `closed`/`reopened`；
   * `reopened` → 营业、`closed` → 停业、没有 → `base.openByDefault`（INV-5 的 config 侧）。
   */
  isOpen(): boolean {
    const fact = this.facts.resolve(closureKey(this.id), this.at);
    if (fact === undefined) return this.defaults.closure(this.base);
    return fact.type === 'reopened';
  }

  /** 求值时刻能否发某州：`state_allowed` → 可以、`state_blocked` → 不行、没有 → config。 */
  shipsTo(state: StateCode): boolean {
    const fact = this.facts.resolve(coverageKey(this.id, state), this.at);
    if (fact === undefined) return this.defaults.coverage(this.base, state);
    return fact.type === 'state_allowed';
  }

  /** 求值时刻某药某剂量是否有现货（精确剂量；不做单位推断）。 */
  hasStock(medication: MedicationId, dose: DoseId): boolean {
    const fact = this.facts.resolve(stockKey(this.id, medication, dose), this.at);
    if (fact === undefined) return this.defaults.stock(this.base, medication, dose);
    return fact.type === 'stock_available';
  }

  /** 求值时刻的有效日容量（最新覆盖 `at` 的 `capacity` fact，否则 config）。 */
  capacityToday(): number {
    const fact = this.facts.resolve(capacityKey(this.id), this.at);
    if (fact === undefined) return this.defaults.capacity(this.base);
    return fact.type === 'capacity' ? fact.perDay : this.defaults.capacity(this.base);
  }

  /** `at` 所在 ET 自然日已经真实发到本药房的单数（MANUAL 不计，见 `CapacityLedger`）。 */
  capacityUsedToday(): number {
    return this.capacity.used(this.id, this.calendar.dateOf(this.at));
  }

  /** 当日剩余容量，**不得为负**：容量下调到低于已发数时当天立即停接、不追回。 */
  capacityLeft(): number {
    return Math.max(0, this.capacityToday() - this.capacityUsedToday());
  }

  /**
   * 唯一一处定义「哪一条不过」的地方；返回按固定顺序排列的失败码
   * （closed → state_blocked → no_stock → capacity_full）。
   *
   * 四条都属于**安全**条件：任何一条不过，这家药房就不能进候选集。
   * 只对 `order` 的州/药/剂量在本时刻求值，不看未来（§16-Q13）。
   */
  failuresFor(order: NormalizedOrder): FailureCode[] {
    const failures: FailureCode[] = [];
    if (!this.isOpen()) failures.push('closed');
    if (!this.shipsTo(order.state)) failures.push(`state_blocked:${order.state}`);
    if (!this.hasStock(order.medication, order.dose)) {
      failures.push(`no_stock:${order.medication}:${order.dose}`);
    }
    // 安全条件：容量用完（left === 0）即不可接单。`capacityLeft()` 已保证 ≥ 0。
    if (this.capacityLeft() <= 0) failures.push('capacity_full');
    return failures;
  }

  /**
   * 只读展示快照（`GET /state`）。动态字段全部来自本时刻的信念：
   * - `openNow` / `capacity*` 直接调本类方法；
   * - `blockedStates` / `stock` 展示**求值时刻仍生效**的值（config 宇宙 + 本药房的
   *   coverage/stock fact），否则 `/state` 会显示「config 说封锁/有货」而与邮件相矛盾。
   *
   * 注意：展示口径不是判定口径——判定只走 `failuresFor()`。
   */
  toView(): PharmacyView {
    return {
      id: this.id,
      name: this.name,
      openNow: this.isOpen(),
      shipsInDays: this.shipsInDays,
      capacityToday: this.capacityToday(),
      capacityUsedToday: this.capacityUsedToday(),
      capacityLeft: this.capacityLeft(),
      price: this.price,
      blockedStates: this.effectiveBlockedStates(),
      stock: this.effectiveStock(),
    };
  }

  /**
   * 求值时刻仍被封锁的州：先保留 config 里仍然封锁的项，再补上 fact 新封锁的州
   * （顺序确定：config 顺序 → fact append 顺序）。
   */
  private effectiveBlockedStates(): readonly StateCode[] {
    const blocked: StateCode[] = [];
    for (const state of this.base.blockedStates) {
      if (!this.shipsTo(state)) blocked.push(state);
    }
    for (const fact of this.facts.factsOf(this.id)) {
      if (fact.type !== 'state_blocked') continue;
      const resolved = this.facts.resolve(subjectKeyOf(fact), this.at);
      if (resolved === undefined || resolved.type !== 'state_blocked') continue;
      if (!blocked.includes(resolved.state)) blocked.push(resolved.state);
    }
    return Object.freeze(blocked);
  }

  /**
   * 求值时刻有现货的剂量：每个 catalogue 药品先按 config 剂量过滤，再补上 fact
   * 新断言有货的剂量（顺序确定：药品按 config 顺序、剂量按 config/fact 出现顺序）。
   */
  private effectiveStock(): Readonly<Record<MedicationId, readonly DoseId[]>> {
    const stock: Record<MedicationId, DoseId[]> = {};
    for (const medication of Object.keys(this.base.stock)) {
      const doses = this.base.stock[medication] ?? [];
      stock[medication] = doses.filter((dose) => this.hasStock(medication, dose));
    }
    for (const fact of this.facts.factsOf(this.id)) {
      if (fact.type !== 'stock_available') continue;
      const resolved = this.facts.resolve(subjectKeyOf(fact), this.at);
      if (resolved === undefined || resolved.type !== 'stock_available') continue;
      const doses = stock[resolved.medication];
      if (doses === undefined) continue; // 目录外的药（校验器不允许，防御性跳过）
      if (!doses.includes(resolved.dose)) doses.push(resolved.dose);
    }
    for (const medication of Object.keys(stock)) {
      Object.freeze(stock[medication]);
    }
    return Object.freeze(stock);
  }
}
