/**
 * `IdSequence`：`fact_0007` 这类可持久化、跨重启单调递增的 id（`ARCHITECTURE.md` §5.1）。
 *
 * 不变量：
 * - 计数器进快照，所以 fact 的 `(asserted_at, seq)` 排序在重启前后一致——这是
 *   「最后断言者胜」在重启后仍然正确的前提。
 * - `simulation.started` 时 `reset()` 回 0：新周从 `fact_0001` 起，两次重放的编号相同，
 *   INV-11 才能逐条比对决策序列。
 * - 三个 prefix 各自独立计数；`snapshot()` 返回副本，调用方改它不影响本对象。
 */

/** 允许的 id 前缀：fact / decision / sam。 */
export type IdPrefix = 'fact' | 'decision' | 'sam';

/** 序号位宽：`fact_0028`。超过 9999 时自然变长（`padStart` 不会截断）。 */
const WIDTH = 4;

/** 计数器快照（JSON 友好，直接进 `state.json`）。 */
export type IdCounters = Record<string, number>;

/**
 * 生成 `prefix_NNNN` 形式的 id。
 *
 * 构造参数可以来自快照：`new IdSequence({ fact: 27 })`，下一个是 `fact_0028`。
 */
export class IdSequence {
  constructor(private counters: IdCounters = {}) {}

  /** 取下一个 id，并推进该 prefix 的计数器。 */
  next(prefix: IdPrefix): string {
    const n = (this.counters[prefix] ?? 0) + 1;
    this.counters[prefix] = n;
    return `${prefix}_${String(n).padStart(WIDTH, '0')}`;
  }

  /** 当前计数器副本（不可变快照语义：调用方随便改）。 */
  snapshot(): IdCounters {
    return { ...this.counters };
  }

  /** 从快照恢复；复制传入对象，避免两个实例共享同一份计数器。 */
  static restore(s: IdCounters): IdSequence {
    return new IdSequence({ ...s });
  }

  /** 重置所有计数器（`simulation.started` 开新周时用）。 */
  reset(): void {
    this.counters = {};
  }
}
