/**
 * `StateStore` 的内存测试替身（`ARCHITECTURE.md` §5.10）。
 *
 * 供 integration/unit 测试装配，避免碰真实 `data/`；同时提供写盘失败注入：
 * `failNextSave()` 让下一次 `save()` 返回 `Err(AppError('persist_failed'))`，
 * 用来验证调用方的重试 / `degraded` 标记路径（§9、§11）。
 *
 * 读出来的对象是**深拷贝**：调用方改它不会影响「磁盘上的」状态，模拟真实落盘的
 * 序列化边界（快照是提交点，不是共享引用）。
 */
import type { PersistedState, StateStore } from '../../application/ports/state-store.ts';
import { AppError } from '../../kernel/errors.ts';
import { err, ok } from '../../kernel/result.ts';
import type { Result } from '../../kernel/result.ts';

export class MemoryStateStore implements StateStore {
  private state: PersistedState | null = null;
  /** 还需注入失败的 save 次数。 */
  private failuresRemaining = 0;
  private saveCount = 0;
  private loadCount = 0;

  /** 注入 `times` 次写盘失败（默认 1 次）；失败不改变内存状态。 */
  failNextSave(times = 1): void {
    const count = Math.max(1, Math.trunc(times));
    this.failuresRemaining += count;
  }

  /** 成功写入的次数（测试断言用）。 */
  get saves(): number {
    return this.saveCount;
  }

  /** `load()` 调用的次数（测试断言用）。 */
  get loads(): number {
    return this.loadCount;
  }

  /** 当前内存快照的深拷贝（只读用途；测试断言用）。 */
  snapshot(): PersistedState | null {
    return this.state === null ? null : cloneState(this.state);
  }

  async load(): Promise<Result<PersistedState | null, AppError>> {
    this.loadCount += 1;
    return ok(this.state === null ? null : cloneState(this.state));
  }

  async save(state: PersistedState): Promise<Result<void, AppError>> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      return err(
        new AppError('persist_failed', 'injected state-store save failure (MemoryStateStore)', {
          reason: 'injected_failure',
        }),
      );
    }
    this.state = cloneState(state);
    this.saveCount += 1;
    return ok(undefined);
  }

  async clear(): Promise<Result<void, AppError>> {
    this.state = null;
    return ok(undefined);
  }
}

/** 模拟落盘的序列化边界；`PersistedState` 是纯 JSON 数据，JSON 往返足够。 */
function cloneState(state: PersistedState): PersistedState {
  return JSON.parse(JSON.stringify(state)) as PersistedState;
}
