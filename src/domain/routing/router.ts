/**
 * `OrderRouter`：纯函数路由层（`ARCHITECTURE.md` §5.7、`REQUIREMENTS.md` §5）。
 *
 * 判定顺序（顺序本身就是需求，别改）：
 *
 * ```
 * evals      = beliefs.map(b => filter.evaluate(b, order))   // 保持传入 beliefs 的顺序
 * candidates = evals.filter(eligible)                        // 安全：四条硬条件全过
 *
 * candidates 为空 → MANUAL, basis 'manual', reason = ManualReasonBuilder.build(evals)
 *                    （即使有偏好也只记 manual，不记 override：§16-Q12、INV-5）
 * 否则 prefs = PreferenceResolver.active(...)                // 已排好序
 *      hit   = prefs 中第一个「药房在 candidates 里」的         ← 偏好顺序决定，不由排名决定
 *      hit 存在 → chosen = hit.pharmacy, basis 'ops_preference', preference = {pharmacy, eventId}
 *      hit 不存在 → chosen = ranker.best(candidates), basis 'rank'
 *                   prefs 非空时 override 说明每家偏好药房为什么不行；preference = null
 * ```
 *
 * 纯函数（INV-1、C7、INV-10）：不读进程时钟、不调 LLM、没有 IO；输出只由输入决定。
 * 传入的 `beliefs` 必须是调用方按 `PharmacyRegistry.all()` 的 id 升序给的（§5.7 的
 * 「evals 固定按 pharmacy id 顺序」）；本类**不重新排序**，如实保留传入顺序。
 *
 * `ManualReasonBuilder` 放在本文件而非 `decision.ts`：`decision.ts` 的类型由 lead
 * 写死，本切片只 import 不改，避免两个写者对同一文件并发修改。
 */
import type { Instant } from '../../kernel/time/instant.ts';
import type { PharmacyBelief } from '../belief/pharmacy-belief.ts';
import type { Fact } from '../facts/fact.ts';
import type { NormalizedOrder } from '../normalize/order-normalizer.ts';
import type { PharmacyId } from '../types.ts';
import type { CandidateEvaluation, RoutingDecision } from './decision.ts';
import { EligibilityFilter } from './eligibility.ts';
import { PreferenceResolver } from './preferences.ts';
import type { ActivePreference } from './preferences.ts';
import { CandidateRanker, comparePharmacyIds } from './ranker.ts';

/** `OrderRouter` 的三个协作者（全部无状态，可跨请求复用）。 */
export interface OrderRouterDeps {
  filter: EligibilityFilter;
  prefs: PreferenceResolver;
  ranker: CandidateRanker;
}

/** `route` 的输入；`at` = 订单事件的 `occurred_at`（唯一「现在」）。 */
export interface RouteInput {
  order: NormalizedOrder;
  at: Instant;
  /** 必须按 pharmacy id 升序传入（`registry.all()` 的顺序）。 */
  beliefs: readonly PharmacyBelief[];
  /** 全部 `routing_preference` fact（`FactStore.preferences()`）；可混入别的 fact。 */
  preferences: readonly Fact[];
}

/** 排名/命中理由里的价格描述：缺价不是安全条件，只是排在最后。 */
function describePrice(price: number | null): string {
  return price === null ? 'price unknown' : `$${price}`;
}

/** 「速度」的可读形式，rank 与 ops_preference 的 reason 共用。 */
function describeSpeed(shipsInDays: number): string {
  return `${shipsInDays} day${shipsInDays === 1 ? '' : 's'}`;
}

/**
 * `MANUAL` 的固定原因文案：逐家点名失败码，按 pharmacy id 升序（确定性）。
 *
 * 格式固定为 `no eligible pharmacy: A(closed); B(no_stock:<medication>:<dose>)`：
 * `; ` 分隔药房，括号内是该药房的失败码（多条用 `,` 连接）。verify 与 Sam 都靠
 * 这个格式快速定位「哪家为什么不行」，不要随手改。
 */
export class ManualReasonBuilder {
  build(evals: readonly CandidateEvaluation[]): string {
    if (evals.length === 0) return 'no eligible pharmacy: none';
    const sorted = [...evals].sort((a, b) => comparePharmacyIds(a.pharmacy, b.pharmacy));
    const parts = sorted.map((evaluation) => {
      const failures =
        evaluation.failures.length > 0 ? evaluation.failures.join(',') : 'ineligible';
      return `${evaluation.pharmacy}(${failures})`;
    });
    return `no eligible pharmacy: ${parts.join('; ')}`;
  }
}

export class OrderRouter {
  private readonly manualReasons = new ManualReasonBuilder();

  constructor(private readonly deps: OrderRouterDeps) {}

  /**
   * 为一张订单产出决策。同样的输入永远得到逐字段相同的输出；`sent` 恒为 `null`
   * （由发单方在真正发出后回填，路由阶段不知道也不该知道发单结果）。
   */
  route(input: RouteInput): RoutingDecision {
    const order = input.order;

    // 1) 资格评估：顺序 = 传入 beliefs 的顺序（调用方按 id 升序给）。
    const evals: CandidateEvaluation[] = [];
    for (const belief of input.beliefs) {
      evals.push(this.deps.filter.evaluate(belief, order));
    }
    const candidates = evals.filter((evaluation) => evaluation.eligible);

    // 2) 无安全候选 → MANUAL。偏好即使存在也只记 manual、不记 override（Q12/INV-5）。
    if (candidates.length === 0) {
      return {
        orderId: order.orderId,
        at: input.at,
        order,
        chosen: 'MANUAL',
        basis: 'manual',
        reason: this.manualReasons.build(evals),
        candidates: evals,
        preference: null,
        override: null,
        sent: null,
      };
    }

    // 3) 按偏好顺序找第一个「药房在候选集里」的。偏好只缩窄、不扩大选择范围。
    const active = this.deps.prefs.active(input.preferences, order, input.at);
    const evaluationsById = new Map<PharmacyId, CandidateEvaluation>();
    for (const evaluation of candidates) {
      evaluationsById.set(evaluation.pharmacy, evaluation);
    }
    let hit: ActivePreference | undefined;
    let hitEvaluation: CandidateEvaluation | undefined;
    for (const preference of active) {
      const evaluation = evaluationsById.get(preference.fact.pharmacy);
      if (evaluation !== undefined) {
        hit = preference;
        hitEvaluation = evaluation;
        break;
      }
    }

    if (hit !== undefined && hitEvaluation !== undefined) {
      return {
        orderId: order.orderId,
        at: input.at,
        order,
        chosen: hit.fact.pharmacy,
        basis: 'ops_preference',
        reason:
          `ops preference: ${hit.fact.pharmacy} ` +
          `(${describeSpeed(hitEvaluation.shipsInDays)}, ${describePrice(hitEvaluation.price)})`,
        candidates: evals,
        preference: { pharmacy: hit.fact.pharmacy, eventId: hit.fact.eventId },
        override: null,
        sent: null,
      };
    }

    // 4) 回落排名：偏好存在但未命中时记录 override（含偏好药房与失败原因）。
    const best = this.deps.ranker.best(candidates);
    if (best === undefined) {
      // 理论上不可达（candidates 非空时 best 必有值）；真出现也绝不留下未发订单，
      // 按 INV-5 的兜底口径回 MANUAL，并用 `internal_error:` 前缀与「无候选」区分。
      return {
        orderId: order.orderId,
        at: input.at,
        order,
        chosen: 'MANUAL',
        basis: 'manual',
        reason: 'internal_error:candidate_ranker_returned_none',
        candidates: evals,
        preference: null,
        override: null,
        sent: null,
      };
    }

    return {
      orderId: order.orderId,
      at: input.at,
      order,
      chosen: best.pharmacy,
      basis: 'rank',
      reason: `fastest safe: ${best.pharmacy} ` + `(${describeSpeed(best.shipsInDays)}, ${describePrice(best.price)})`,
      candidates: evals,
      preference: null,
      override: active.length === 0 ? null : this.buildOverride(active, evals),
      sent: null,
    };
  }

  /**
   * 偏好未命中的 override 文案：
   * `ops preferred A/B but: A(state_blocked:NJ); B(unknown_pharmacy)`。
   *
   * 每条生效偏好都要点名（按偏好顺序，即 ops 意图的优先序），否则审计无法解释
   * 「ops 指定了谁、为什么没发过去」。WALKTHROUGHS 的断言要求文本里包含具体失败码
   * （如 `no_stock:<medication>:<dose>`），所以这里直接复用 `failures` 的固定格式。
   */
  private buildOverride(
    active: readonly ActivePreference[],
    evals: readonly CandidateEvaluation[],
  ): string {
    const evaluationsById = new Map<PharmacyId, CandidateEvaluation>();
    for (const evaluation of evals) {
      evaluationsById.set(evaluation.pharmacy, evaluation);
    }
    const preferred = active.map((preference) => preference.fact.pharmacy);
    const reasons = active.map((preference) => {
      const pharmacy = preference.fact.pharmacy;
      const evaluation = evaluationsById.get(pharmacy);
      if (evaluation === undefined) {
        // 偏好指向 beliefs 里不存在的药房：不是候选，也没有失败码可引用。
        return `${pharmacy}(unknown_pharmacy)`;
      }
      const failures = evaluation.failures.length > 0 ? evaluation.failures.join(',') : 'not_a_candidate';
      return `${pharmacy}(${failures})`;
    });
    return `ops preferred ${preferred.join('/')} but: ${reasons.join('; ')}`;
  }
}
