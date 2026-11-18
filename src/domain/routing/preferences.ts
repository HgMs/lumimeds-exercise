/**
 * `PreferenceResolver`：把 `routing_preference` fact 列表解析成「此刻对这张订单
 * 生效的 ops 偏好」，并给出确定性的优先级顺序（`ARCHITECTURE.md` §5.7、§16-Q1、
 * `REQUIREMENTS.md` §10）。
 *
 * 三条语义（写错会让 week A 的四张偏好单全变）：
 * 1. **匹配**：`medication` 必须相等；`dose`/`state` 缺省 = **通配**（不是「只匹配
 *    未指定」）。ops 只写药品、不写剂量/州时，意图是「该药品的所有单」。
 * 2. **生效窗口**：只保留 `interval.covers(at)` 的偏好（`at` = 决策时刻）。
 * 3. **顺序**：`specificity` 降序 → `assertedAt` 降序（后断言者优先）→ `seq` 降序。
 *    这是「按偏好顺序取第一条其药房合格的」，不是「求集合再按速度排名」。
 *
 * 纯函数：不读时钟、不查 fact store、不依赖 `Map` 迭代序；输入数组顺序被显式排序
 * 覆盖，最终一样输出同样的顺序。
 */
import type { Instant } from '../../kernel/time/instant.ts';
import type { Fact } from '../facts/fact.ts';
import type { NormalizedOrder } from '../normalize/order-normalizer.ts';

/** 收窄后的 `routing_preference` fact（`Fact` 联合类型的一个成员）。 */
export type RoutingPreferenceFact = Extract<Fact, { type: 'routing_preference' }>;

/** `active()` 的一条结果：命中的偏好 + 它的特异性分数。 */
export interface ActivePreference {
  fact: RoutingPreferenceFact;
  /** `(dose?2:0) + (state?1:0)`：同时限定 dose 与 state 的最具体。 */
  specificity: number;
}

/** 运行时收窄：`Fact` 联合里只有 `routing_preference` 有关系语义。 */
export function isRoutingPreference(fact: Fact): fact is RoutingPreferenceFact {
  return fact.type === 'routing_preference';
}

/** 特异性分数：dose 比 state 更有分量（§16-Q1 的定案）。 */
export function specificityOf(fact: RoutingPreferenceFact): number {
  return (fact.dose === undefined ? 0 : 2) + (fact.state === undefined ? 0 : 1);
}

/** 码点比较（不用 localeCompare：确定性不受机器 locale 影响）。 */
function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * 偏好顺序：特异性降序 → `assertedAt` 降序 → `seq` 降序。
 *
 * 真实 fact 的 `seq` 全局唯一，所以前三键已经全序；再加 `id` 作为**显式最终平局键**
 * 只是防御手工构造的同 seq 测试输入，保证「同输入永远同输出」。
 */
function compareActive(a: ActivePreference, b: ActivePreference): number {
  if (a.specificity !== b.specificity) return b.specificity - a.specificity;
  const byAssertedAt = b.fact.assertedAt.compare(a.fact.assertedAt);
  if (byAssertedAt !== 0) return byAssertedAt;
  if (a.fact.seq !== b.fact.seq) return b.fact.seq - a.fact.seq;
  return compareIds(a.fact.id, b.fact.id);
}

export class PreferenceResolver {
  /**
   * `at` 时刻对 `order` 生效的偏好，已按上面的顺序排好。
   *
   * `facts` 可以是 `FactStore.preferences()` 的原样输出，也可以混入别的 fact：
   * 非 `routing_preference` 的一律忽略（调用方不必先过滤，多一道防御）。
   */
  active(
    facts: readonly Fact[],
    order: NormalizedOrder,
    at: Instant,
  ): ActivePreference[] {
    const active: ActivePreference[] = [];
    for (const fact of facts) {
      if (!isRoutingPreference(fact)) continue;
      if (!fact.interval.covers(at)) continue;
      if (!this.matches(fact, order)) continue;
      active.push({ fact, specificity: specificityOf(fact) });
    }
    active.sort(compareActive);
    return active;
  }

  /**
   * 单条偏好是否匹配订单：`medication` 必须相等；`dose`/`state` 缺省 = 通配。
   * 不管区间（区间由 `active` 按 `at` 过滤），也不关心所指点药房是否存在——
   * 「偏好指向不存在的药房」属于「未命中」，由 `OrderRouter` 处理。
   */
  matches(pref: Fact, order: NormalizedOrder): boolean {
    if (!isRoutingPreference(pref)) return false;
    if (pref.medication !== order.medication) return false;
    if (pref.dose !== undefined && pref.dose !== order.dose) return false;
    if (pref.state !== undefined && pref.state !== order.state) return false;
    return true;
  }
}
