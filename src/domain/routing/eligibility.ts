/**
 * `EligibilityFilter`：把一家药房的信念 + 一张订单折成一条 `CandidateEvaluation`
 * （`ARCHITECTURE.md` §5.7、`REQUIREMENTS.md` §5）。
 *
 * 这是资格判定的**唯一入口**，但它自己不做四条硬条件的判断：判断只由
 * `PharmacyBelief.failuresFor(order)` 做（§5.5 的「一套表示」）。本类只负责把
 * 信念上的展示/排序字段（速度、价格、剩余容量）与失败码装进审计用的形状。
 *
 * 为什么是纯函数：`OrderRouter.route` 的输出必须只由输入决定（C7、INV-1）；
 * 本类不持有状态、不读时钟。
 */
import type { PharmacyBelief } from '../belief/pharmacy-belief.ts';
import type { NormalizedOrder } from '../normalize/order-normalizer.ts';
import type { CandidateEvaluation } from './decision.ts';

export class EligibilityFilter {
  /**
   * 评估一家药房。
   *
   * - `eligible` 当且仅当 `failuresFor` 返回空数组（四条安全条件全过）；
   * - `failures` 原样沿用信念给的固定顺序（closed → state_blocked → no_stock →
   *   capacity_full），`ManualReasonBuilder` 与 verify 都依赖这个顺序与格式；
   * - `price` 取该药品的 config 价，**缺失时为 `null`**（排名时排最后），
   *   不猜价格、不因为缺价把药房判成不合格（缺价不是安全条件）；
   * - `capacityLeft` 来自信念，已保证 ≥ 0。
   */
  evaluate(belief: PharmacyBelief, order: NormalizedOrder): CandidateEvaluation {
    const failures = belief.failuresFor(order);
    return {
      pharmacy: belief.id,
      eligible: failures.length === 0,
      shipsInDays: belief.shipsInDays,
      price: belief.price[order.medication] ?? null,
      capacityLeft: belief.capacityLeft(),
      failures,
    };
  }
}
