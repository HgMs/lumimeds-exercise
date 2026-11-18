/**
 * `SessionHolder`：当前会话的可变盒子（`ARCHITECTURE.md` §5.9）。
 *
 * 为什么需要它：会话的生命周期由两个入口改变——`simulation.started`（新建）与
 * 启动恢复（从快照重建），而用例之间不能互相 import，所以把「当前是哪一周的会话」
 * 提成一个共享的、可替换的引用，由 wiring 注入给所有需要它的对象。
 *
 * 语义：
 * - `current()` 可能为 `null`（还没收到过 `started`、或快照不可用）；
 * - `requireSession()` 只在调用方**已经**检查过 `hasSession()` 后使用；没有会话时
 *   抛错是「不变量破坏」，不是业务失败（`no_session` 由 `EventProcessor` 判 500）。
 */
import type { SimulationSession } from './simulation-session.ts';

export class SessionHolder {
  private session: SimulationSession | null = null;

  /** 是否已有会话（`order`/`email` 事件的 `no_session` 判据）。 */
  hasSession(): boolean {
    return this.session !== null;
  }

  /** 当前会话；没有则为 `null`。 */
  current(): SimulationSession | null {
    return this.session;
  }

  /**
   * 当前会话，没有则抛错。只给「已通过 `hasSession()` 检查」的路径用：
   * 在别处抛错说明调用方漏了 `no_session` 分支。
   */
  requireSession(): SimulationSession {
    if (this.session === null) {
      throw new Error('SessionHolder.requireSession: no active session (no_session)');
    }
    return this.session;
  }

  /** 安装新会话（`simulation.started` / 启动恢复）。 */
  replace(session: SimulationSession): void {
    this.session = session;
  }

  /** 丢弃当前会话（`simulation.started` 校验失败时「保持无会话」，`ARCHITECTURE.md` §9）。 */
  clear(): void {
    this.session = null;
  }
}
