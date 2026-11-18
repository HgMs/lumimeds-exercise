/**
 * 组合根：`buildContainer(env, overrides?)` 装配整张运行时对象图
 * （`ARCHITECTURE.md` §4「运行时对象图与生命周期」）。
 *
 * 这个文件**不含业务逻辑**：它只决定「谁依赖谁」以及测试接缝。装配顺序是拓扑序，
 * 每一步的理由写在下面对应段落的注释里；不要为了少几行而合并。
 *
 * 两个非显然的装配决定：
 * 1. **会话级对象不进构造函数**：`sent` / `capacity` / `decisions` / `facts` 属于当前
 *    会话，`simulation.started` 会整体换掉。所以 `OrderDispatcher` / `RetryQueue` 只拿
 *    `SessionHolder`，每次操作从当前会话取（见各自文件头）。这是 A4 的签名决定的，
 *    也避免了「新周重试写进旧周日志」。
 * 2. **`AnthropicExtractor` 的 promptBuilder 用 getter**：`PromptBuilder` 需要本周的
 *    registry/catalogue/ops，而它们在 `buildContainer` 时还不存在（来自
 *    `simulation.started`）。getter 在真正需要时从 `SessionHolder` 取当前会话并缓存。
 *
 * `overrides` 是测试接缝（`ARCHITECTURE` §4）：至少支持
 * `{extractor, gateway, stateStore, inflight, audit}`；另外支持 `{logger, calendar}`
 * 方便单测固定时间/日志。
 */
import { JsonlAuditSink } from '../adapters/audit/jsonl-audit-sink.ts';
import { AnthropicExtractor } from '../adapters/llm/anthropic-extractor.ts';
import { PromptBuilder } from '../adapters/llm/prompt-builder.ts';
import { ReplayExtractor } from '../adapters/llm/replay-extractor.ts';
import { FileInflightJournal } from '../adapters/persistence/file-inflight-journal.ts';
import { FileStateStore } from '../adapters/persistence/file-state-store.ts';
import { HttpPharmacyGateway } from '../adapters/pharmacy/http-pharmacy-gateway.ts';
import { AuditRecorder } from '../application/audit/audit-recorder.ts';
import { OrderDispatcher } from '../application/dispatch/order-dispatcher.ts';
import { RetryQueue } from '../application/dispatch/retry-queue.ts';
import { EventProcessor } from '../application/event-processor.ts';
import type { InflightJournal } from '../application/ports/inflight-journal.ts';
import type { LlmExtractor } from '../application/ports/llm-extractor.ts';
import type { PharmacyGateway } from '../application/ports/pharmacy-gateway.ts';
import type { AuditSink } from '../application/ports/audit-sink.ts';
import type { StateStore } from '../application/ports/state-store.ts';
import { RecoveryService } from '../application/recovery/recovery-service.ts';
import type { RecoveryServiceDeps } from '../application/recovery/recovery-service.ts';
import { SessionHolder } from '../application/session/session-holder.ts';
import { SnapshotMapper } from '../application/session/snapshot-mapper.ts';
import type { SimulationSession } from '../application/session/simulation-session.ts';
import { HandleEmailUseCase } from '../application/use-cases/handle-email.ts';
import { HandleOrderUseCase } from '../application/use-cases/handle-order.ts';
import { StartSimulationUseCase } from '../application/use-cases/start-simulation.ts';
import { DEFAULT_BELIEF_DEFAULTS } from '../domain/belief/belief-defaults.ts';
import { BeliefResolver } from '../domain/belief/belief-resolver.ts';
import { EligibilityFilter } from '../domain/routing/eligibility.ts';
import { PreferenceResolver } from '../domain/routing/preferences.ts';
import { CandidateRanker } from '../domain/routing/ranker.ts';
import { OrderRouter } from '../domain/routing/router.ts';
import type { EnvConfig } from '../env.ts';
import { IdSequence } from '../kernel/ids.ts';
import { createLogger } from '../kernel/logger.ts';
import type { Logger } from '../kernel/logger.ts';
import { SerialQueue } from '../kernel/serial-queue.ts';
import { EtCalendar } from '../kernel/time/et-calendar.ts';
import { HealthHandler } from '../interfaces/http/handlers/health-handler.ts';
import { OrderDecisionHandler } from '../interfaces/http/handlers/order-decision-handler.ts';
import { SamHandler } from '../interfaces/http/handlers/sam-handler.ts';
import { StateHandler } from '../interfaces/http/handlers/state-handler.ts';
import { WebhookHandler } from '../interfaces/http/handlers/webhook-handler.ts';
import { ErrorMapper } from '../interfaces/http/error-mapper.ts';
import { Router } from '../interfaces/http/router.ts';
import { HttpServer } from '../interfaces/http/server.ts';

/** 停机时等待重试队列的时间预算（`ARCHITECTURE` §4/§6.4：5s）。 */
export const SHUTDOWN_DRAIN_TIMEOUT_MS = 5_000;

/**
 * 测试接缝：替换生产适配器/日志/日历。
 * 生产不传；集成测试用它避免真实网络与真实 `data/`。
 */
export interface ContainerOverrides {
  readonly extractor?: LlmExtractor;
  readonly gateway?: PharmacyGateway;
  readonly stateStore?: StateStore;
  readonly inflight?: InflightJournal;
  readonly audit?: AuditSink;
  readonly logger?: Logger;
  readonly calendar?: EtCalendar;
}

/**
 * 装配结果。字段全部只读；除 `shutdown()` / `restoreSession()` 外没有行为。
 *
 * 前 5 个字段是 `ARCHITECTURE` §4 规定的接口；`calendar` / `recovery` / `holder` 等
 * 是启动序列（`index.ts`）需要的只读引用（规格里的 AppContainer 没列启动顺序要用到
 * 的对象，这里显式暴露而不是让 index 反射内部结构）。
 */
export interface AppContainer {
  readonly server: HttpServer;
  readonly processor: EventProcessor;
  readonly retryQueue: RetryQueue;
  readonly stateStore: StateStore;
  /** 启动自检（`calendar.selfTest()`）与日志时间格式化用。 */
  readonly calendar: EtCalendar;
  /** 启动恢复：读快照 → 重建会话 → 注入 pharmacy_api → 处理 inflight（§6.3）。 */
  readonly recovery: RecoveryService;
  readonly holder: SessionHolder;
  readonly mapper: SnapshotMapper;
  readonly gateway: PharmacyGateway;
  readonly extractor: LlmExtractor;
  readonly inflight: InflightJournal;
  readonly logger: Logger;
  readonly env: EnvConfig;
  /**
   * 启动序列第 3 步的前半段：读 `state.json` → `mapper.fromPersisted` →
   * `gateway.setBaseUrl(pharmacy_api)` → `holder.replace`。
   * 返回重建出的会话；无快照/快照损坏时返回 `null` 并保持无会话（**不造空壳会话**）。
   * 之后由 `recovery.run()` 用这个会话处理 WAL。
   */
  restoreSession(): Promise<SimulationSession | null>;
  /** 停接收 → `retryQueue.drain(5s)` → 落盘 → 关服务；幂等。 */
  shutdown(): Promise<void>;
}

/**
 * 构建全部运行时对象。纯装配：不读盘、不监听端口、不启动定时器、不读业务时间。
 */
export function buildContainer(env: EnvConfig, overrides: ContainerOverrides = {}): AppContainer {
  const logger = overrides.logger ?? createLogger({ service: 'lumimeds-pharmacy-desk' });
  const calendar = overrides.calendar ?? new EtCalendar();

  // ---- 进程级基础设施 ----
  const queue = new SerialQueue();
  const holder = new SessionHolder();
  const ids = new IdSequence();
  const stateStore = overrides.stateStore ?? new FileStateStore(env.dataDir);
  const inflight = overrides.inflight ?? new FileInflightJournal(env.inflightFile);
  const auditSink = overrides.audit ?? new JsonlAuditSink(env.outDir);

  const recorder = new AuditRecorder({ sink: auditSink, calendar, logger });
  const mapper = new SnapshotMapper({ calendar });

  // ---- 网关：baseUrl 由 started / 恢复路径注入（§5.10） ----
  const gateway: PharmacyGateway = overrides.gateway ?? new HttpPharmacyGateway({ logger });

  // ---- LLM 抽取：live / replay 二选一 ----
  // promptBuilder 延迟到「当前会话存在」时构造：构造时机与周内容都由 simulation.started
  // 决定；同一会话只构造一次（PromptBuilder 是不可变的周视图）。
  let promptCache: { session: SimulationSession; builder: PromptBuilder } | null = null;
  const promptBuilderProvider = (): PromptBuilder => {
    const session = holder.current();
    if (session === null) {
      // 走到这里说明 EventProcessor 的 no_session 门被绕过（实现 bug），不是业务失败。
      throw new Error(
        'PromptBuilder requested before a simulation session exists (no_session invariant broken)',
      );
    }
    if (promptCache === null || promptCache.session !== session) {
      promptCache = {
        session,
        builder: new PromptBuilder({
          calendar,
          catalogue: session.catalogue,
          registry: session.registry,
          ops: session.config.lumimedsOps,
        }),
      };
    }
    return promptCache.builder;
  };

  const extractor: LlmExtractor =
    overrides.extractor ??
    (env.llmMode === 'replay'
      ? new ReplayExtractor({ fixturePath: env.llmFixture, logger })
      : new AnthropicExtractor({
          apiKey: env.apiKey,
          model: env.model,
          promptBuilder: promptBuilderProvider,
        }));

  // ---- 路由：纯函数组件，进程级复用（INV-10：路由不碰 LLM） ----
  const orderRouter = new OrderRouter({
    filter: new EligibilityFilter(),
    prefs: new PreferenceResolver(),
    ranker: new CandidateRanker(),
  });
  const beliefs = new BeliefResolver({ calendar, defaults: DEFAULT_BELIEF_DEFAULTS });

  // ---- 发单与重试（会话对象一律经 holder 取） ----
  const retryQueue = new RetryQueue({
    queue,
    holder,
    gateway,
    calendar,
    recorder,
    stateStore,
    mapper,
    logger,
  });
  const dispatcher = new OrderDispatcher({
    gateway,
    inflight,
    retry: retryQueue,
    holder,
    calendar,
    logger,
  });

  // ---- 三个用例 ----
  const handleOrder = new HandleOrderUseCase({
    holder,
    router: orderRouter,
    beliefs,
    recorder,
    dispatcher,
    logger,
  });
  const handleEmail = new HandleEmailUseCase({
    holder,
    extractor,
    calendar,
    recorder,
    logger,
    // `ANTHROPIC_TIMEOUT_MS` 是单次调用预算的上限；真正生效值由 Deadline.allocate 再压。
    extractionTimeoutMs: env.anthropicTimeoutMs,
  });
  const started = new StartSimulationUseCase({
    calendar,
    ids,
    stateStore,
    inflight,
    holder,
    mapper,
    gateway,
    // RetryQueue 在 started 时清空旧周的推迟单（§5.9）。
    clearRetryQueue: () => retryQueue.clear(),
    logger,
  });

  // ---- 启动恢复（§6.3）：read snapshot → rebuild session → setBaseUrl → WAL ----
  // `session` 在 `restoreSession()` 里填进这个 deps 对象：恢复服务自己读盘也能工作，
  // 但「先 setBaseUrl 再重发」的顺序要求 wiring 先拿到快照里的 pharmacy_api。
  const recoveryDeps: RecoveryServiceDeps = {
    holder,
    inflight,
    gateway,
    calendar,
    logger,
    stateStore,
    mapper,
  };
  const recovery = new RecoveryService(recoveryDeps);

  // ---- 主干 ----
  const processor = new EventProcessor({
    queue,
    holder,
    started,
    order: handleOrder,
    email: handleEmail,
    stateStore,
    mapper,
    recorder,
    logger,
    recovery,
  });

  // ---- HTTP：5 条路由（DATA-CONTRACTS §5） ----
  const errorMapper = new ErrorMapper();
  const router = new Router();
  const webhookHandler = new WebhookHandler({ processor, errorMapper });
  const orderDecisionHandler = new OrderDecisionHandler({ holder, calendar });
  const samHandler = new SamHandler({ holder });
  const healthHandler = new HealthHandler({ holder, retryQueue });
  const stateHandler = new StateHandler({ holder, resolver: beliefs });

  router.post('/webhooks', (ctx) => webhookHandler.handle(ctx));
  router.get('/orders/:id', (ctx) => orderDecisionHandler.handle(ctx));
  router.get('/sam', (ctx) => samHandler.handle(ctx));
  router.get('/health', (ctx) => healthHandler.handle(ctx));
  router.get('/state', (ctx) => stateHandler.handle(ctx));

  const server = new HttpServer({ router, port: env.port, logger, errorMapper });

  // ---- 启动恢复第 1–3 步（快照 → 会话 → pharmacy_api） ----
  const restoreSession = async (): Promise<SimulationSession | null> => {
    const loaded = await stateStore.load();
    if (!loaded.ok) {
      logger.error('恢复：快照不可用，保持无会话（后续事件会 500 no_session）', {
        code: loaded.error.code,
        message: loaded.error.message,
      });
      return null;
    }
    if (loaded.value === null) {
      logger.info('恢复：没有快照（冷启动），保持无会话');
      return null;
    }
    const rebuilt = mapper.fromPersisted(loaded.value);
    if (!rebuilt.ok) {
      logger.error('恢复：快照无法重建会话，保持无会话', {
        code: rebuilt.error.code,
        message: rebuilt.error.message,
      });
      return null;
    }
    const session = rebuilt.value;
    try {
      gateway.setBaseUrl?.(session.pharmacyApi);
    } catch (cause) {
      // pharmacy_api 不可用：不能安全重发，保持无会话（宁可丢一个事件，不发错地址）。
      holder.clear();
      logger.error('恢复：快照的 pharmacy_api 无法注入发单网关，保持无会话', {
        pharmacy_api: session.pharmacyApi,
        cause,
      });
      return null;
    }
    holder.replace(session);
    recoveryDeps.session = session;
    logger.info('恢复：会话已从快照重建', {
      week_started_at: calendar.iso(session.startedAt),
      facts: session.facts.snapshot().length,
      sent_orders: [...session.sent.entries()].length,
      seen_event_ids: session.seenEventIds.size,
      degraded: session.degraded,
    });
    return session;
  };

  // ---- 优雅停机（§4/§6.4）：停接收 → drain → 落盘 → 关服务 ----
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async (): Promise<void> => {
      logger.info('shutdown: 停止接收新请求');
      // 先开始关闭监听 socket（不再接受新连接）；已接受的请求继续处理完。
      const serverClosing = server.close();

      try {
        await retryQueue.drain(SHUTDOWN_DRAIN_TIMEOUT_MS);
      } catch (cause) {
        logger.error('shutdown: retryQueue.drain 失败（推迟单可能丢失）', { cause });
      }

      // 与事件处理共用 SerialQueue：避免在别人写盘中间读到半更新状态。
      try {
        await queue.run(async () => {
          const session = holder.current();
          if (session === null) {
            logger.info('shutdown: 无会话，跳过快照落盘');
            return;
          }
          const saved = await stateStore.save(mapper.toPersisted(session));
          if (saved.ok) {
            logger.info('shutdown: 快照已落盘', {
              week_started_at: calendar.iso(session.startedAt),
            });
          } else {
            logger.error('shutdown: 快照落盘失败（磁盘状态可能落后于内存）', {
              code: saved.error.code,
              message: saved.error.message,
            });
          }
        });
      } catch (cause) {
        logger.error('shutdown: 快照落盘抛异常', { cause });
      }

      // 审计不是真值；flush 失败只记日志（D12）。
      try {
        await recorder.flush();
      } catch (cause) {
        logger.error('shutdown: 审计 flush 失败（不影响状态正确性）', { cause });
      }

      try {
        await serverClosing;
      } catch (cause) {
        logger.error('shutdown: 关闭 HTTP 服务失败', { cause });
      }
      logger.info('shutdown: 完成');
    })();
    return shutdownPromise;
  };

  return {
    server,
    processor,
    retryQueue,
    stateStore,
    calendar,
    recovery,
    holder,
    mapper,
    gateway,
    extractor,
    inflight,
    logger,
    env,
    restoreSession,
    shutdown,
  };
}
