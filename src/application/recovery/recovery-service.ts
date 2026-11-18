/**
 * `RecoveryService`：进程重启后的发单恢复（`ARCHITECTURE.md` §6.3、§11.3；
 * `DATA_CONTRACTS.md` §3.8）。
 *
 * 启动序列（wiring 负责第 1–3 步的顺序）：
 * 1. `StateStore.load` → `SnapshotMapper.fromPersisted` → `SessionHolder.replace`；
 * 2. `gateway.setBaseUrl(快照里的 pharmacy_api)`（**不在这里重复**：本服务只发单）；
 * 3. `RecoveryService.run()`：处理 `data/inflight.json` 的每条 WAL 记录；
 * 4. `retryQueue.start()` → `server.listen()`。
 *
 * 每条 WAL 记录二分（§11.3）：
 * - `sent.has(order_id)` → 只 `inflight.commit` 清掉（已发，无需动作）；
 * - 否则按 **WAL 里记的药房原样重发一次**（绝不重新路由）：
 *   `201` → `sent.mark` + 容量（用 WAL 的 `at`，不是重启时刻）；
 *   `409` → 视为此前已发，**同样**记容量 + `warn`（sim 会因此记一条 problem，
 *          这是 §16-Q4 已声明的已知代价）；
 *   `400/404` → 终局失败，记 error 后 commit（重试不会成功）；
 *   `5xx/超时` → **保留 WAL**（下次重启再试；不在启动时反复轰炸药房）。
 *
 * 恢复成功后（有新的 sent 记录）会写一次快照——否则「恢复了但没落盘」下次重启还会
 * 按 WAL 再发一次（409 收敛，但会多一条 problem）。
 *
 * 关于 `run()` 的两种装配方式：wiring 可以直接把已从快照重建好的 `session` 传进来
 * （推荐，启动序列里本来就要 load），也可以只传 `stateStore` + `mapper` 让本服务
 * 自己读快照。两者都不做时 `run()` 直接返回「无会话」，不抛异常。
 */
import { AppError } from '../../kernel/errors.ts';
import type { Logger } from '../../kernel/logger.ts';
import type { EtCalendar } from '../../kernel/time/et-calendar.ts';
import { Instant } from '../../kernel/time/instant.ts';
import type { InflightEntry, InflightJournal } from '../ports/inflight-journal.ts';
import type { PharmacyGateway, SendOutcome } from '../ports/pharmacy-gateway.ts';
import type { StateStore } from '../ports/state-store.ts';
import type { SessionHolder } from '../session/session-holder.ts';
import type { SimulationSession } from '../session/simulation-session.ts';
import type { SnapshotMapper } from '../session/snapshot-mapper.ts';

/** `RecoveryService` 的构造依赖。 */
export interface RecoveryServiceDeps {
  holder: SessionHolder;
  inflight: InflightJournal;
  gateway: PharmacyGateway;
  calendar: EtCalendar;
  logger: Logger;
  /** 已从快照重建好的会话（wiring 传了它就不读 `stateStore`）。 */
  session?: SimulationSession;
  /** 自行读快照时需要；与 `mapper` 一起提供。 */
  stateStore?: StateStore;
  mapper?: SnapshotMapper;
  /** 恢复重发的超时（默认 8_000ms，与首次发单一致）。 */
  sendTimeoutMs?: number;
}

/** `run()` 的可观测结果（日志 + `/health` / 测试用）。 */
export interface RecoveryReport {
  /** 是否拿到了会话（反之则什么都没法恢复）。 */
  sessionLoaded: boolean;
  /** WAL 里发现的总条目数。 */
  inflightEntries: number;
  /** `sent.has` 为真、只清了 WAL 的条数。 */
  committed: number;
  /** 重发返回 201 的条数。 */
  recovered: number;
  /** 重发返回 409（此前已发）的条数。 */
  confirmed: number;
  /** 重发被 400/404 终局拒绝的条数。 */
  failed: number;
  /** 结果未知、WAL 保留待下次启动的条数。 */
  deferred: number;
  /** 恢复动作是否成功写进快照（没有变化时为 true）。 */
  stateSaved: boolean;
}

const DEFAULT_SEND_TIMEOUT_MS = 8_000;

function emptyReport(): RecoveryReport {
  return {
    sessionLoaded: false,
    inflightEntries: 0,
    committed: 0,
    recovered: 0,
    confirmed: 0,
    failed: 0,
    deferred: 0,
    stateSaved: true,
  };
}

function describeCause(cause: unknown): unknown {
  if (cause instanceof AppError) return cause.toJSON();
  if (cause instanceof Error) return { name: cause.name, message: cause.message };
  return cause;
}

export class RecoveryService {
  constructor(private readonly deps: RecoveryServiceDeps) {}

  /**
   * 执行恢复。不抛异常：任何失败都只记日志并体现在 `RecoveryReport` 里——
   * 恢复失败不应阻止服务启动（后续事件会按 `no_session` / 重试路径处理）。
   */
  async run(): Promise<RecoveryReport> {
    const report = emptyReport();

    const session = await this.loadSession();
    if (session === null) {
      report.sessionLoaded = false;
      return report;
    }
    report.sessionLoaded = true;
    this.deps.holder.replace(session);

    let entries: readonly InflightEntry[];
    try {
      entries = await this.deps.inflight.load();
    } catch (cause) {
      this.deps.logger.error('recovery: 读取 inflight WAL 失败（无法恢复在途发单）', {
        cause: describeCause(cause),
      });
      return report;
    }
    report.inflightEntries = entries.length;
    if (entries.length === 0) {
      this.deps.logger.info('recovery: 没有在途发单需要恢复', {
        session_loaded: true,
        week_started_at: this.deps.calendar.iso(session.startedAt),
      });
      return report;
    }

    let changed = false;
    for (const entry of entries) {
      const result = await this.recoverOne(session, entry, report);
      if (result) changed = true;
    }

    if (changed) {
      report.stateSaved = await this.saveState(session);
    }

    this.deps.logger.info('recovery: 完成', {
      inflight_entries: report.inflightEntries,
      committed: report.committed,
      recovered: report.recovered,
      confirmed: report.confirmed,
      failed: report.failed,
      deferred: report.deferred,
      state_saved: report.stateSaved,
    });
    return report;
  }

  // -------------------------------------------------------------------------
  // 会话来源
  // -------------------------------------------------------------------------

  /** 优先用 wiring 传入的会话；否则自行 load + fromPersisted。失败一律返回 null。 */
  private async loadSession(): Promise<SimulationSession | null> {
    if (this.deps.session !== undefined) return this.deps.session;

    const stateStore = this.deps.stateStore;
    const mapper = this.deps.mapper;
    if (stateStore === undefined || mapper === undefined) {
      this.deps.logger.warn('recovery: 既没有传入 session 也没有 stateStore/mapper，跳过恢复');
      return null;
    }
    const loaded = await stateStore.load();
    if (!loaded.ok) {
      this.deps.logger.error('recovery: 快照不可用，跳过恢复（后续事件会 500 no_session）', {
        code: loaded.error.code,
        message: loaded.error.message,
      });
      return null;
    }
    if (loaded.value === null) {
      this.deps.logger.info('recovery: 没有快照（冷启动），跳过恢复');
      return null;
    }
    const rebuilt = mapper.fromPersisted(loaded.value);
    if (!rebuilt.ok) {
      this.deps.logger.error('recovery: 快照无法重建会话，跳过恢复', {
        code: rebuilt.error.code,
        message: rebuilt.error.message,
      });
      return null;
    }
    return rebuilt.value;
  }

  // -------------------------------------------------------------------------
  // 单条 WAL
  // -------------------------------------------------------------------------

  /** 返回 true 表示产生了需要落盘的新状态（sent 标记）。不抛异常。 */
  private async recoverOne(
    session: SimulationSession,
    entry: InflightEntry,
    report: RecoveryReport,
  ): Promise<boolean> {
    const orderId = entry.orderId;

    // 已发：只清 WAL。
    if (session.sent.has(orderId)) {
      await this.commitQuietly(orderId);
      report.committed += 1;
      this.deps.logger.info('recovery: 该单已发，只清理 WAL', { order_id: orderId });
      return false;
    }

    // WAL 的 at 是原始决策时刻（业务时间）：容量与 ET 日都按它算，绝不用重启时刻。
    const at = this.parseWalAt(entry, session);
    const outcome = await this.send(orderId, entry);

    if (outcome.kind === 'accepted' || outcome.kind === 'duplicate') {
      const status = outcome.kind === 'accepted' ? 201 : 409;
      session.sent.mark(orderId, entry.pharmacy, at);
      if (entry.pharmacy !== 'MANUAL') {
        session.capacity.record(entry.pharmacy, this.deps.calendar.dateOf(at));
      }
      await this.commitQuietly(orderId);
      if (status === 201) {
        report.recovered += 1;
        this.deps.logger.info('recovery: 在途订单重发成功', {
          order_id: orderId,
          pharmacy: entry.pharmacy,
          at: this.deps.calendar.iso(at),
        });
      } else {
        report.confirmed += 1;
        // 409 说明我们的 WAL 覆盖了一次「药房已受理但响应丢了」的窗口：诚实告警。
        this.deps.logger.warn('recovery: 重发返回 409，视为此前已发出（sim 会记 problem）', {
          order_id: orderId,
          pharmacy: entry.pharmacy,
          at: this.deps.calendar.iso(at),
        });
      }
      return true;
    }

    if (outcome.kind === 'rejected') {
      await this.commitQuietly(orderId);
      report.failed += 1;
      this.deps.logger.error('recovery: 重发被终局拒绝，不再重试', {
        order_id: orderId,
        pharmacy: entry.pharmacy,
        status: outcome.status,
        message: outcome.message ?? null,
      });
      return false;
    }

    // 结果未知：保留 WAL，下次启动再试（不在启动时反复轰炸药房）。
    report.deferred += 1;
    this.deps.logger.warn('recovery: 重发结果未知，保留 WAL 待下次启动', {
      order_id: orderId,
      pharmacy: entry.pharmacy,
      kind: outcome.kind,
    });
    return false;
  }

  /** 一次网关调用；异常按「结果未知」处理（保留 WAL）。 */
  private async send(orderId: string, entry: InflightEntry): Promise<SendOutcome> {
    try {
      return await this.deps.gateway.send(
        {
          orderId,
          pharmacy: entry.pharmacy,
          ...(entry.decisionReason === null ? {} : { reason: entry.decisionReason }),
        },
        { timeoutMs: this.deps.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS },
      );
    } catch (cause) {
      this.deps.logger.error('recovery: gateway.send 抛异常，按结果未知处理（保留 WAL）', {
        order_id: orderId,
        pharmacy: entry.pharmacy,
        cause: describeCause(cause),
      });
      return { kind: 'retryable' };
    }
  }

  /** WAL 的 `at` 是业务时间；解析失败属 WAL 损坏，用会话起点兜底并记 error。 */
  private parseWalAt(entry: InflightEntry, session: SimulationSession): Instant {
    const parsed = Instant.parse(entry.at);
    if (parsed.ok) return parsed.value;
    this.deps.logger.error('recovery: WAL 的 at 不可解析（WAL 损坏），用周起点兜底', {
      order_id: entry.orderId,
      at: entry.at,
      parse_error: parsed.error.message,
    });
    return session.startedAt;
  }

  private async commitQuietly(orderId: string): Promise<void> {
    try {
      await this.deps.inflight.commit(orderId);
    } catch (cause) {
      this.deps.logger.error('recovery: inflight.commit 失败（WAL 残留，下次启动会重发）', {
        order_id: orderId,
        cause: describeCause(cause),
      });
    }
  }

  /** 恢复出的 sent 必须落盘，否则下次重启会重发。失败只置 degraded + 记日志。 */
  private async saveState(session: SimulationSession): Promise<boolean> {
    const stateStore = this.deps.stateStore;
    const mapper = this.deps.mapper;
    if (stateStore === undefined || mapper === undefined) {
      this.deps.logger.warn('recovery: 没有 stateStore/mapper，恢复结果不落盘（degraded=true）');
      session.degraded = true;
      return false;
    }
    try {
      const saved = await stateStore.save(mapper.toPersisted(session));
      if (!saved.ok) {
        session.degraded = true;
        this.deps.logger.error('recovery: 恢复后的快照写盘失败（degraded=true）', {
          code: saved.error.code,
          message: saved.error.message,
        });
        return false;
      }
      return true;
    } catch (cause) {
      session.degraded = true;
      this.deps.logger.error('recovery: 恢复后的快照序列化/写盘抛异常（degraded=true）', {
        cause: describeCause(cause),
      });
      return false;
    }
  }
}
