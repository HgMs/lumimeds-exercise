/**
 * `Deadline`：单事件时间预算（25s）的集中分配（`ARCHITECTURE.md` §5.1）。
 *
 * 为什么需要：`8s 超时 × 4 次尝试 + 250/500/1000ms 退避 ≈ 33.75s`，会撞穿 30s 的
 * webhook 回复窗口。预算必须集中分配，不能各调用各的常量。
 *
 * **它不参与业务时间**：本文件是 kernel 内唯一允许读真实时钟的地方——`performance.now()`
 * 只用来量「还能等多久」；业务时间仍然只有事件的 `occurred_at`（`Instant`）。
 * 不要把这里的时间当 `now()` 用（C1/INV-1 的唯一例外）。
 */
import type { Instant } from './time/instant.ts';

/** 预算耗尽后的 abort 原因（`AbortSignal.reason`，便于日志区分「超时」与其他 abort）。 */
export class DeadlineExceededError extends Error {
  constructor() {
    super('deadline exceeded');
    this.name = 'DeadlineExceededError';
  }
}

export class Deadline {
  private readonly startedAtRealMs: number;
  private readonly controller = new AbortController();

  private constructor(
    /** 事件发生的业务时刻；仅用于日志关联，不参与预算计算。 */
    readonly startedAt: Instant,
    readonly budgetMs: number,
  ) {
    this.startedAtRealMs = performance.now();
    if (budgetMs > 0) {
      // 不阻止进程退出：Deadline 只是「等多久」，不是后台任务。
      setTimeout(() => {
        this.controller.abort(new DeadlineExceededError());
      }, budgetMs).unref();
    } else {
      // 零预算：创建即过期。
      this.controller.abort(new DeadlineExceededError());
    }
  }

  /** 创建预算；`startedAt` 只用于日志。 */
  static after(startedAt: Instant, budgetMs: number): Deadline {
    return new Deadline(startedAt, Math.max(0, budgetMs));
  }

  /** 剩余毫秒数：可能为 0，永不为负。 */
  remainingMs(): number {
    return Math.max(0, this.startedAtRealMs + this.budgetMs - performance.now());
  }

  /** 预算是否已耗尽。 */
  expired(): boolean {
    return this.remainingMs() <= 0;
  }

  /**
   * 从预算里划出一段超时：`min(desiredMs, 剩余 - reserve)`，下限 0。
   * 所有外部调用都用它的返回值当超时（LLM 最多 12_000；药房 POST 首次 8_000；
   * 内联重试每次 `allocate(剩余/剩余次数, 1_000)`；写盘 2_000）。
   */
  allocate(desiredMs: number, reserveMs = 0): number {
    const free = this.remainingMs() - Math.max(0, reserveMs);
    // 取整毫秒：定时器/超时参数都是整数，测试断言也更好写。
    return Math.max(0, Math.floor(Math.min(Math.max(0, desiredMs), free)));
  }

  /** 到达预算时统一 abort 的 signal；外部调用共享它。 */
  signal(): AbortSignal {
    return this.controller.signal;
  }
}
