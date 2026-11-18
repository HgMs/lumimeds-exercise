/**
 * 集成重放夹具（`ARCHITECTURE.md` §12.3）：
 *
 * ```
 * 逐事件 POST /webhooks ──▶ 真实 HttpServer（listen 0）──▶ 真实 Router/Handler
 *                                                        ──▶ 真实 EventProcessor/用例/领域
 *                                                        ──▶ FileStateStore + FileInflightJournal（临时目录）
 *                                                        ──▶ RecordingGateway（假药房，不发网络）
 *                                                        ──▶ ScriptedExtractor（fixture 回放，不调 LLM）
 * ```
 *
 * 与 `scripts/verify.ts` 的区别：verify 读**产物**做独立求值；这里走**真实 HTTP 栈**，
 * 让 handler、状态码映射、body 解析、快照提交、崩溃恢复都在覆盖范围内
 * （§12.3：「不是直接调用用例」）。
 *
 * crash 语义：在某个 `event_id` 的响应返回之后**不执行 shutdown**（不 drain、不落盘、
 * 不 flush 审计）就丢弃 container，模拟进程被杀；随后用同一 `stateDir` 重新
 * `buildContainer` → `restoreSession()` → `recovery.run()` → `retryQueue.start()` →
 * `listen()`（与 `src/index.ts` 的启动序列一致），再继续投递后续事件。
 *
 * `simulation.started` 的 body 由 harness 补 `pharmacyApi`——`sim/sim.mjs` 也是这么
 * 做的（week 文件里没有这个字段）；这里指向 `FAKE_PHARMACY_API`，实际发单由注入的
 * `RecordingGateway` 处理，不走网络。
 */
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildContainer } from '../../src/wiring/container.ts';
import type { AppContainer } from '../../src/wiring/container.ts';
import { loadEnv } from '../../src/env.ts';
import type { EnvConfig } from '../../src/env.ts';
import { noopLogger } from '../../src/kernel/logger.ts';
import type { Logger } from '../../src/kernel/logger.ts';
import type { RecoveryReport } from '../../src/application/recovery/recovery-service.ts';
import type { InflightJournal } from '../../src/application/ports/inflight-journal.ts';
import type { PersistedState, StateStore } from '../../src/application/ports/state-store.ts';
import type { SimulationSession } from '../../src/application/session/simulation-session.ts';
import type { LlmExtractor } from '../../src/application/ports/llm-extractor.ts';
import type { PersistedRoutingDecision } from '../../src/domain/routing/decision.ts';
import type { FactAuditRecord } from '../../src/application/ports/audit-sink.ts';
import { STATE_FILE_NAME } from '../../src/adapters/persistence/file-state-store.ts';
import {
  DECISIONS_FILE_NAME,
  FACTS_FILE_NAME,
} from '../../src/adapters/audit/jsonl-audit-sink.ts';
import { RecordingGateway } from './recording-gateway.ts';
import { ScriptedExtractor } from './scripted-extractor.ts';
import { EXTRACTIONS_PATH, FAKE_PHARMACY_API, WEEK_A_PATH, loadWeekEvents } from './week-a.ts';
import type { WeekEvent } from './week-a.ts';

/** 一次 HTTP 调用的结果（webhook / GET 共用）。 */
export interface HttpResult {
  readonly status: number;
  /** 解析后的 JSON body；非 JSON 时是原始文本。 */
  readonly body: unknown;
  /** 原始响应文本（断言 `{ok:true}` 用）。 */
  readonly text: string;
}

/** 某个时刻的会话计数（幂等断言的「副作用指纹」）。 */
export interface ReplayCounts {
  /** 网关调用累计数。 */
  readonly sends: number;
  /** 当前会话 fact 数（无会话时 0）。 */
  readonly facts: number;
  /** 当前会话 seen 数（无会话时 0）。 */
  readonly seen: number;
}

/** 一次 webhook 投递记录。 */
export interface ReplayEventDelivery {
  /** 全局投递序号（`run.deliveries` 里的下标）。 */
  readonly index: number;
  readonly eventId: string;
  readonly type: string;
  readonly occurredAt: string;
  /** 这次投递是否是对同一 `event_id` 的重复投递。 */
  readonly redelivery: boolean;
  readonly status: number;
  readonly body: unknown;
  /** 响应返回后的副作用计数（用于断言重投「什么都没变」）。 */
  readonly counts: ReplayCounts;
}

/** 崩溃后重启前的注入上下文：可以直接写磁盘上的 WAL/快照，模拟崩溃窗口。 */
export interface CrashContext {
  readonly stateDir: string;
  readonly outDir: string;
  readonly gateway: RecordingGateway;
  /** 已崩溃 container 的 WAL 适配器（读写同一 `stateDir/inflight.json`）。 */
  readonly inflight: InflightJournal;
  readonly stateStore: StateStore;
}

/** 一次「崩溃点」计划。 */
export interface CrashPlan {
  /** 在这个事件**成功响应之后**立刻崩溃（不执行优雅停机）。 */
  readonly afterEventId: string;
  /**
   * 崩溃后、重启前的注入钩子（§11.3 崩溃窗口）。
   * 例：`inflight.begin(...)` 模拟「WAL 已写、POST 还没发」；
   * `gateway.injectAcceptedButLost(...)` 模拟「药房已 201、我们没提交」。
   */
  readonly beforeRestart?: (ctx: CrashContext) => void | Promise<void>;
}

/** 一次崩溃 + 恢复的记录。 */
export interface ReplayCrashRecord {
  readonly afterEventId: string;
  /** 重启时是否从快照重建出了会话（`state.json` 可用）。 */
  readonly restoredSession: boolean;
  /** 重启恢复报告（`RecoveryService.run()`；快照不可用时为 null）。 */
  readonly recovery: RecoveryReport | null;
  /** 重启后新监听的端口。 */
  readonly newPort: number;
}

/** `out/` 两份审计文件的解析结果。 */
export interface AuditSnapshot {
  readonly decisions: readonly PersistedRoutingDecision[];
  readonly facts: readonly FactAuditRecord[];
}

export interface ReplayWeekOptions {
  /** week 文件；默认 `sim/week-a.jsonl`。 */
  readonly weekPath?: string;
  /** LLM 端口替身；默认 `ScriptedExtractor(EXTRACTIONS_PATH)`。 */
  readonly extractor?: LlmExtractor;
  /** 默认 ScriptedExtractor 的 fixture 路径（仅在没传 `extractor` 时生效）。 */
  readonly extractorFixturePath?: string;
  /** 药房网关替身；默认 `new RecordingGateway()`。 */
  readonly gateway?: RecordingGateway;
  /** 崩溃点（单个或按出现顺序匹配的多个）。 */
  readonly crash?: CrashPlan | readonly CrashPlan[];
  /** `DATA_DIR`；默认在 `os.tmpdir()` 下 `mkdtemp`。 */
  readonly stateDir?: string;
  /** `OUT_DIR`；默认在 `os.tmpdir()` 下 `mkdtemp`。 */
  readonly outDir?: string;
  /** 监听端口；默认 0（内核分配）。 */
  readonly port?: number;
  /** 日志；默认静默（测试失败信息由断言提供）。 */
  readonly logger?: Logger;
  /** 只回放前 N 个事件（调试/定向用例）。 */
  readonly maxEvents?: number;
}

/** 重放运行句柄：结果 + 对「还活着的服务」的查询能力。 */
export interface ReplayRun {
  /** 本轮回放的 week 事件（按文件顺序）。 */
  readonly week: readonly WeekEvent[];
  /** 全部投递（多轮 `replayAgain` 会追加；第一轮通常在 `[0, 52)`）。 */
  readonly deliveries: readonly ReplayEventDelivery[];
  /** 本轮的崩溃+恢复记录（按发生顺序）。 */
  readonly crashes: readonly ReplayCrashRecord[];
  readonly gateway: RecordingGateway;
  readonly extractor: LlmExtractor;
  readonly stateDir: string;
  readonly outDir: string;
  /** 交给 `simulation.started` 的假药房 API base URL。 */
  readonly fakePharmacyApi: string;
  /** 当前监听的端口（崩溃重启后是新的端口）。 */
  readonly port: number;
  /** 冷启动（第一个 container）的恢复报告。 */
  readonly initialRecovery: RecoveryReport | null;

  /** 当前 container（崩溃重启后是新的；优雅停机后仍是最后一个）。 */
  current(): AppContainer;
  /** 当前会话；无会话时 null。 */
  session(): SimulationSession | null;
  /** 当前副作用计数（网关调用 / fact 数 / seen 数）。 */
  counts(): ReplayCounts;
  /** GET 一个只读端点（`/orders/:id`、`/sam`、`/health`、`/state`）。 */
  get(path: string): Promise<HttpResult>;
  /** POST 一个事件到 `/webhooks`（幂等测试重投用；不写入 `run.deliveries`）。 */
  postEvent(event: WeekEvent): Promise<HttpResult>;
  /**
   * 再按文件顺序回放整周（用于 `simulation.started` 重放 = 第二周）。
   * 返回**这一次**的投递记录；累计投递仍追加到 `run.deliveries`。
   */
  replayAgain(options?: { readonly clearPharmacyRecords?: boolean }): Promise<readonly ReplayEventDelivery[]>;
  /** 读当前已提交的快照（`state.json`，走真实 `StateStore.load`）。 */
  persisted(): Promise<PersistedState | null>;
  /** 读原始 `state.json` 文本（「duplicate 不写盘」按字节比较用）；不存在时 null。 */
  readStateText(): Promise<string | null>;
  /** 读 `out/decisions.jsonl` 与 `out/facts.jsonl`（调用前建议先 `stop()` flush）。 */
  readAudit(): Promise<AuditSnapshot>;
  /** 优雅停机（幂等）：停接收 → drain → 落盘 → flush 审计 → 关服务。 */
  stop(): Promise<void>;
  /** `stop()` + 删除 harness 自己创建的临时目录（传入的目录不删）。 */
  cleanup(): Promise<void>;
}

interface BootResult {
  readonly container: AppContainer;
  readonly port: number;
  readonly restored: SimulationSession | null;
  readonly recovery: RecoveryReport | null;
}

class ReplayRunImpl implements ReplayRun {
  readonly deliveries: ReplayEventDelivery[] = [];
  readonly crashes: ReplayCrashRecord[] = [];
  readonly fakePharmacyApi = FAKE_PHARMACY_API;

  private containerRef!: AppContainer;
  private portRef = 0;
  private stopped = false;
  private initialRecoveryRef: RecoveryReport | null = null;

  constructor(
    readonly week: readonly WeekEvent[],
    private readonly env: EnvConfig,
    readonly gateway: RecordingGateway,
    readonly extractor: LlmExtractor,
    readonly stateDir: string,
    readonly outDir: string,
    private readonly logger: Logger,
    private readonly crashPlans: CrashPlan[],
    private readonly ownedStateDir: boolean,
    private readonly ownedOutDir: boolean,
  ) {}

  get port(): number {
    return this.portRef;
  }

  get initialRecovery(): RecoveryReport | null {
    return this.initialRecoveryRef;
  }

  /** 第一个 container 的启动 + 第一轮回放。 */
  async start(): Promise<void> {
    const booted = await this.boot();
    this.containerRef = booted.container;
    this.portRef = booted.port;
    this.initialRecoveryRef = booted.recovery;
    await this.runSequence(this.week);
  }

  current(): AppContainer {
    return this.containerRef;
  }

  session(): SimulationSession | null {
    return this.containerRef.holder.current();
  }

  counts(): ReplayCounts {
    const session = this.session();
    return {
      sends: this.gateway.calls.length,
      facts: session === null ? 0 : session.facts.snapshot().length,
      seen: session === null ? 0 : session.seenEventIds.size,
    };
  }

  async get(path: string): Promise<HttpResult> {
    const response = await fetch(`${this.baseUrl()}${path}`, {
      signal: AbortSignal.timeout(10_000),
    });
    return readHttpResponse(response);
  }

  async postEvent(event: WeekEvent): Promise<HttpResult> {
    const body =
      event.type === 'simulation.started'
        ? { ...event, pharmacyApi: FAKE_PHARMACY_API }
        : event;
    const response = await fetch(`${this.baseUrl()}/webhooks`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-event-id': event.event_id,
        'x-sim-time': event.occurred_at,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    return readHttpResponse(response);
  }

  async replayAgain(
    options: { readonly clearPharmacyRecords?: boolean } = {},
  ): Promise<readonly ReplayEventDelivery[]> {
    if (options.clearPharmacyRecords === true) this.gateway.clearPharmacyRecords();
    return this.runSequence(this.week);
  }

  async persisted(): Promise<PersistedState | null> {
    const loaded = await this.containerRef.stateStore.load();
    if (!loaded.ok) {
      throw new Error(
        `replay harness: state snapshot unreadable: ${loaded.error.code}: ${loaded.error.message}`,
      );
    }
    return loaded.value;
  }

  async readStateText(): Promise<string | null> {
    return readTextOrNull(join(this.stateDir, STATE_FILE_NAME));
  }

  async readAudit(): Promise<AuditSnapshot> {
    return {
      decisions: await readJsonl<PersistedRoutingDecision>(
        join(this.outDir, DECISIONS_FILE_NAME),
      ),
      facts: await readJsonl<FactAuditRecord>(join(this.outDir, FACTS_FILE_NAME)),
    };
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.containerRef.shutdown();
  }

  async cleanup(): Promise<void> {
    await this.stop();
    if (this.ownedStateDir) await rm(this.stateDir, { recursive: true, force: true });
    if (this.ownedOutDir) await rm(this.outDir, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  // 内部：启动 / 投递 / 崩溃重启
  // -------------------------------------------------------------------------

  /**
   * 与 `src/index.ts` 的启动序列一致：
   * `buildContainer` → `selfTest` → `restoreSession` →（有会话才）`recovery.run`
   * → `retryQueue.start` → `server.listen`。
   */
  private async boot(): Promise<BootResult> {
    const container = buildContainer(this.env, {
      extractor: this.extractor,
      gateway: this.gateway,
      logger: this.logger,
    });
    container.calendar.selfTest();
    const restored = await container.restoreSession();
    let recovery: RecoveryReport | null = null;
    if (restored !== null) recovery = await container.recovery.run();
    container.retryQueue.start();
    const port = await container.server.listen();
    return { container, port, restored, recovery };
  }

  private async runSequence(
    events: readonly WeekEvent[],
  ): Promise<readonly ReplayEventDelivery[]> {
    const produced: ReplayEventDelivery[] = [];
    const seen = new Set<string>();
    for (const event of events) {
      const redelivery = seen.has(event.event_id);
      seen.add(event.event_id);
      const response = await this.postEvent(event);
      const delivery: ReplayEventDelivery = {
        index: this.deliveries.length,
        eventId: event.event_id,
        type: event.type,
        occurredAt: event.occurred_at,
        redelivery,
        status: response.status,
        body: response.body,
        counts: this.counts(),
      };
      this.deliveries.push(delivery);
      produced.push(delivery);
      await this.maybeCrash(event.event_id);
    }
    return produced;
  }

  /** 若当前事件是计划中的崩溃点：丢弃 container（不落盘）并立即重启恢复。 */
  private async maybeCrash(eventId: string): Promise<void> {
    const index = this.crashPlans.findIndex((plan) => plan.afterEventId === eventId);
    if (index < 0) return;
    const plan = this.crashPlans.splice(index, 1)[0];
    if (plan === undefined) return;

    const crashed = this.containerRef;
    // 「崩溃」= 只关掉监听 socket 与后台定时器，不 drain、不落盘、不 flush 审计。
    await crashed.server.close();
    crashed.retryQueue.clear();
    await crashed.retryQueue.drain(0);

    const context: CrashContext = {
      stateDir: this.stateDir,
      outDir: this.outDir,
      gateway: this.gateway,
      inflight: crashed.inflight,
      stateStore: crashed.stateStore,
    };
    if (plan.beforeRestart !== undefined) await plan.beforeRestart(context);

    const booted = await this.boot();
    this.containerRef = booted.container;
    this.portRef = booted.port;
    this.crashes.push({
      afterEventId: plan.afterEventId,
      restoredSession: booted.restored !== null,
      recovery: booted.recovery,
      newPort: booted.port,
    });
  }

  private baseUrl(): string {
    return `http://127.0.0.1:${String(this.portRef)}`;
  }
}

/** 读 HTTP 响应（JSON 解析失败时保留原始文本，避免断言时信息丢失）。 */
async function readHttpResponse(response: Response): Promise<HttpResult> {
  const text = await response.text();
  let body: unknown = text;
  if (text !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      // 非 JSON 响应保留原文（例如 404 的纯文本），测试断言会给出可读失败信息。
    }
  }
  return { status: response.status, body, text };
}

/** 读文本文件；不存在返回 null（首次启动 normal path）。 */
async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (cause) {
    if (isErrnoCode(cause, 'ENOENT')) return null;
    throw cause;
  }
}

/** 读 JSONL；文件不存在返回空数组（审计可能一行都没写）。 */
async function readJsonl<T>(path: string): Promise<T[]> {
  const text = await readTextOrNull(path);
  if (text === null) return [];
  const rows: T[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    rows.push(JSON.parse(trimmed) as T);
  }
  return rows;
}

function isErrnoCode(cause: unknown, code: string): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    (cause as { code?: unknown }).code === code
  );
}

/**
 * 建 container（真实 HTTP 栈 + 真实 FileStateStore/FileInflightJournal）并回放整周。
 *
 * 默认用 `os.tmpdir()` 下的临时 `stateDir/outDir`（测试结束调用 `cleanup()` 清理），
 * 不会污染仓库的 `data/`、`out/`。
 */
export async function replayWeek(options: ReplayWeekOptions = {}): Promise<ReplayRun> {
  const fullWeek = loadWeekEvents(options.weekPath ?? WEEK_A_PATH);
  const week =
    options.maxEvents === undefined ? fullWeek : fullWeek.slice(0, options.maxEvents);

  const gateway = options.gateway ?? new RecordingGateway();
  const extractor =
    options.extractor ??
    new ScriptedExtractor({ fixturePath: options.extractorFixturePath ?? EXTRACTIONS_PATH });

  const ownedStateDir = options.stateDir === undefined;
  const stateDir =
    options.stateDir ?? (await mkdtemp(join(tmpdir(), 'lumimeds-it-state-')));
  const ownedOutDir = options.outDir === undefined;
  const outDir = options.outDir ?? (await mkdtemp(join(tmpdir(), 'lumimeds-it-out-')));

  const envResult = loadEnv({
    // 与 `npm start -- --replay` 等价：fixture 回放，不访问网络、不需要 API key。
    LLM_MODE: 'replay',
    DATA_DIR: stateDir,
    OUT_DIR: outDir,
    INFLIGHT_FILE: join(stateDir, 'inflight.json'),
    PORT: String(options.port ?? 0),
    LLM_FIXTURE: options.extractorFixturePath ?? EXTRACTIONS_PATH,
  });
  if (!envResult.ok) {
    await cleanupDirs(stateDir, outDir, ownedStateDir, ownedOutDir);
    throw new Error(`replay harness: environment configuration failed:\n${envResult.error}`);
  }

  const crashPlans: CrashPlan[] = [];
  if (options.crash !== undefined) {
    if (Array.isArray(options.crash)) {
      crashPlans.push(...(options.crash as readonly CrashPlan[]));
    } else {
      crashPlans.push(options.crash as CrashPlan);
    }
  }

  const run = new ReplayRunImpl(
    week,
    envResult.value,
    gateway,
    extractor,
    stateDir,
    outDir,
    options.logger ?? noopLogger,
    crashPlans,
    ownedStateDir,
    ownedOutDir,
  );

  try {
    await run.start();
  } catch (cause) {
    await run.cleanup().catch(() => undefined);
    throw cause;
  }
  return run;
}

async function cleanupDirs(
  stateDir: string,
  outDir: string,
  ownedStateDir: boolean,
  ownedOutDir: boolean,
): Promise<void> {
  if (ownedStateDir) await rm(stateDir, { recursive: true, force: true });
  if (ownedOutDir) await rm(outDir, { recursive: true, force: true });
}
