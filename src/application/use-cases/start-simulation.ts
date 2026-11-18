/**
 * `StartSimulationUseCase`：处理 `simulation.started`（`ARCHITECTURE.md` §5.9、
 * §11.2；`DATA-CONTRACTS.md` §1.2/§1.5）。
 *
 * 顺序（每一步的理由都写在这里，不要重排）：
 * 1. `ids.reset()`：新周 fact 编号从 `fact_0001` 重新开始（INV-11 要求两次重放逐条
 *    可比）。它必须在 `SessionFactory.create` **之前**，因为基础 fact 在 create 里
 *    领序号；
 * 2. `SessionFactory.create(evt)`：config 形状校验 + registry/catalogue + 基础 fact。
 *    失败 → `holder.clear()`（保持无会话，后续事件 500 `no_session`，§9）并返回
 *    `Err(AppError('bad_started_config'))`；
 * 3. `gateway.setBaseUrl(evt.pharmacyApi)`：发单网关的 base URL 只在这里注入
 *    （§5.10；恢复路径的注入由 wiring/index 用快照的 `pharmacy_api` 负责）；
 * 4. `inflight.clear()` + `clearRetryQueue()`：旧周的在途/推迟单作废（§5.9）；
 *    这两步是清道夫操作，失败只记日志、不阻断新周（见下）；
 * 5. `stateStore.save(...)`：**一次原子写覆盖旧文件，绝不 clear-then-save**
 *    （review B4：clear 与 save 之间崩溃会让磁盘上没有状态，而模拟器只对 socket
 *    错误重投）；
 * 6. `holder.replace(session)`。
 *
 * 关于第 5 步失败：本用例只做**一次** save（按 §11.2「一次原子 save」）。失败时
 * 把会话标记为 `degraded=true` 并**仍然安装会话**，返回 `Ok`：紧随其后的
 * `EventProcessor` 步骤 8–12 还会用 3 次重试再写一次快照（§5.9），若磁盘只是瞬时
 * 抖动，这一周仍能正常跑完；若持续失败，`EventProcessor` 会按 §9 回 500
 * `persist_failed` 且 `degraded` 已在 `/health` 可见。若在这里直接返回 Err 并丢掉
 * 会话，则整周每个事件都会 500 `no_session`（模拟器不重投 `started`），代价更大。
 */
import { AppError } from '../../kernel/errors.ts';
import type { Result } from '../../kernel/result.ts';
import { ok } from '../../kernel/result.ts';
import type { IdSequence } from '../../kernel/ids.ts';
import type { Logger } from '../../kernel/logger.ts';
import type { EtCalendar } from '../../kernel/time/et-calendar.ts';
import type { StateNormalizer } from '../../domain/normalize/state-normalizer.ts';
import type { SimulationStartedEvent } from '../../domain/events.ts';
import type { InflightJournal } from '../ports/inflight-journal.ts';
import type { PharmacyGateway } from '../ports/pharmacy-gateway.ts';
import type { StateStore } from '../ports/state-store.ts';
import { SessionFactory } from '../session/session-factory.ts';
import type { SessionHolder } from '../session/session-holder.ts';
import type { SnapshotMapper } from '../session/snapshot-mapper.ts';

/**
 * `PharmacyGateway` 加强版：带**必填** `setBaseUrl`。只作为给 wiring / 测试的类型便利
 * （`HttpPharmacyGateway` 天然满足）；`StartSimulationDeps.gateway` 仍按端口声明为
 * `PharmacyGateway`（`setBaseUrl` 在端口里是可选的），执行时存在才调用——生产实现
 * 一定有，测试替身可以没有（它们不发真实请求）。
 */
export type SimulationGateway = PharmacyGateway & { setBaseUrl(url: string): void };

/** `StartSimulationUseCase` 的构造依赖（测试可逐项替换）。 */
export interface StartSimulationDeps {
  calendar: EtCalendar;
  /** 进程级 fact id 序号；新周开始时 reset。 */
  ids: IdSequence;
  stateStore: StateStore;
  inflight: InflightJournal;
  holder: SessionHolder;
  /** 会话 → 快照（与 `EventProcessor` 共用同一个实例）。 */
  mapper: SnapshotMapper;
  /** 药房网关：`started` 时注入 `evt.pharmacyApi`（`HttpPharmacyGateway.setBaseUrl`）。 */
  gateway: PharmacyGateway;
  /** `RetryQueue.clear()` 的注入形式（wiring 传 `() => retryQueue.clear()`）。 */
  clearRetryQueue: () => void;
  logger: Logger;
  /** 州归一化器（测试可注入；默认 `new StateNormalizer()`）。 */
  states?: StateNormalizer;
}

export class StartSimulationUseCase {
  constructor(private readonly deps: StartSimulationDeps) {}

  async execute(evt: SimulationStartedEvent): Promise<Result<void, AppError>> {
    const logger = this.deps.logger;

    // ---- 1. 新周编号从 0001 重来（必须在展开基础 fact 之前） ----
    this.deps.ids.reset();

    // ---- 2. 新建会话（config 形状校验 + registry/catalogue + 基础 fact） ----
    const factory = new SessionFactory({
      calendar: this.deps.calendar,
      ids: this.deps.ids,
      states: this.deps.states,
    });
    const created = factory.create(evt);
    if (!created.ok) {
      // 「保持无会话」：旧周的会话不能继续给新周的事件用（§9）。
      this.deps.holder.clear();
      logger.error('simulation.started 被拒绝：config 不可用，保持无会话', {
        event_id: evt.event_id,
        code: created.error.code,
        message: created.error.message,
        detail: created.error.detail,
      });
      return created;
    }
    const session = created.value;

    // ---- 3. 注入药房 API base URL（§5.10） ----
    const setBaseUrl = this.deps.gateway.setBaseUrl;
    if (setBaseUrl === undefined) {
      // 端口里 setBaseUrl 是可选的（测试替身不发真实请求）；生产网关一定有。
      logger.warn('simulation.started: gateway 未实现 setBaseUrl，跳过 pharmacyApi 注入', {
        event_id: evt.event_id,
        pharmacy_api: evt.pharmacyApi,
      });
    } else {
      try {
        setBaseUrl.call(this.deps.gateway, evt.pharmacyApi);
      } catch (cause) {
        this.deps.holder.clear();
        logger.error('simulation.started 的 pharmacyApi 不可用，保持无会话', {
          event_id: evt.event_id,
          pharmacy_api: evt.pharmacyApi,
          cause,
        });
        return {
          ok: false,
          error: new AppError('bad_started_config', 'pharmacyApi 无法注入发单网关', {
            pharmacy_api: evt.pharmacyApi,
          }),
        };
      }
    }

    // ---- 4. 清旧周的在途/推迟单：清道夫操作，失败只记日志、不阻断新周 ----
    try {
      await this.deps.inflight.clear();
    } catch (cause) {
      logger.error('simulation.started: inflight.clear() 失败（继续开新周）', {
        event_id: evt.event_id,
        cause,
      });
    }
    try {
      this.deps.clearRetryQueue();
    } catch (cause) {
      logger.error('simulation.started: retryQueue.clear() 失败（继续开新周）', {
        event_id: evt.event_id,
        cause,
      });
    }

    // ---- 5. 一次原子 save 覆盖旧快照（不要 clear-then-save） ----
    const snapshot = this.deps.mapper.toPersisted(session);
    const saved = await this.deps.stateStore.save(snapshot);
    if (!saved.ok) {
      session.degraded = true;
      logger.error('simulation.started: 快照写盘失败（会话已装内存，degraded=true）', {
        event_id: evt.event_id,
        code: saved.error.code,
        message: saved.error.message,
      });
    }

    // ---- 6. 安装新会话 ----
    this.deps.holder.replace(session);
    logger.info('simulation.started: 新会话已建立', {
      event_id: evt.event_id,
      started_at: this.deps.calendar.iso(session.startedAt),
      pharmacies: session.registry.all().length,
      facts: session.facts.snapshot().length,
      degraded: session.degraded,
    });
    return ok(undefined);
  }
}
