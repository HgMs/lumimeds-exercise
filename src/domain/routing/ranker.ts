/**
 * `CandidateRanker`：安全候选之间的确定性排名（`ARCHITECTURE.md` §5.7、
 * `REQUIREMENTS.md` §2/§5）。
 *
 * 键的顺序就是目标优先级：**速度优先于价格**，只有同样快时才比价；
 * 最后一键是 `pharmacy` id 的码点比较，保证「两个相等元素顺序随机」不可能发生
 * （C7：同一周重放三次结果一致）。
 *
 * `price === null`（config 里没给该药品价格）排最后，但仍可被选中——缺价不是安全
 * 条件；三键也不会因此在同样条件下产生随机性。
 */
import type { CandidateEvaluation } from './decision.ts';

/**
 * 药房 id 的确定性比较：码点升序，不用 `localeCompare`（结果依赖机器 locale，
 * 会破坏跨机器重放的一致性）。
 */
export function comparePharmacyIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** 价格比较：`null` 排最后。 */
function comparePrice(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

export class CandidateRanker {
  /** `(shipsInDays, price, pharmacy id)` 升序；负值 = a 更优。 */
  compare(a: CandidateEvaluation, b: CandidateEvaluation): number {
    if (a.shipsInDays !== b.shipsInDays) return a.shipsInDays - b.shipsInDays;
    const byPrice = comparePrice(a.price, b.price);
    if (byPrice !== 0) return byPrice;
    return comparePharmacyIds(a.pharmacy, b.pharmacy);
  }

  /** 池中排名最前的一条；空池返回 `undefined`（不抛异常，交给调用方走兜底）。 */
  best(pool: readonly CandidateEvaluation[]): CandidateEvaluation | undefined {
    let best: CandidateEvaluation | undefined;
    for (const evaluation of pool) {
      if (best === undefined || this.compare(evaluation, best) < 0) {
        best = evaluation;
      }
    }
    return best;
  }
}
