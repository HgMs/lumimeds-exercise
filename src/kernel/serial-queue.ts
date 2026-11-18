/**
 * `SerialQueue`：异步互斥 + 严格 FIFO（`ARCHITECTURE.md` §5.1）。
 *
 * 为什么需要：模拟器串行，但客户端可能并行重投（15s 重试 + 我们卡住时）。
 * 「同一 `event_id` 两次并发」如果不在锁内判重，会双发（C3/C4）。
 *
 * 注意：锁内包含 LLM 调用与药房 POST，所以一个事件最长能占锁 25s（`Deadline` 的总额）；
 * 这与模拟器 30s 超时留 5s 余量。
 */
export class SerialQueue {
  /** 链尾：始终是一个不会 reject 的 promise，保证后一个任务总能接上。 */
  private tail: Promise<void> = Promise.resolve();
  /** 已提交、尚未完成（含正在跑和排队）的任务数。 */
  private total = 0;

  /** 把任务排进队列；返回该任务自己的 promise（异常只抛给它的调用方）。 */
  run<T>(task: () => Promise<T>): Promise<T> {
    this.total += 1;
    const start = this.tail;
    const result: Promise<T> = start.then(async () => {
      try {
        return await task();
      } finally {
        this.total -= 1;
      }
    });
    // 链尾吞掉异常：前一个任务失败不能让后续任务永远排队。
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** 队列深度：正在运行 + 仍在排队的任务数；空闲时为 0。 */
  get depth(): number {
    return this.total;
  }
}
