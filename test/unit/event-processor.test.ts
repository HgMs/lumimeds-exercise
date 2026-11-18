/**
 * application 主流水线单测（task-9 / `ARCHITECTURE.md` §5.9、§6、§9、§11.3）。
 *
 * 覆盖：
 * - `EventProcessor`：`simulation.started` 先于幂等门（同 event_id 重放仍重置）、
 *   重复 event_id 200 duplicate、无会话 500 no_session、未知 type 200 ignored_type、
 *   坏信封 400、写盘 3 次失败 500 persist_failed + degraded；
 * - `HandleOrderUseCase`：正常 201 路径（sent/capacity/decision/audit）、归一化失败 →
 *   MANUAL（reason `unknown_dose:25mg`）、`sent.has` 短路；
 * - `HandleEmailUseCase`：applied（fact + 审计 + sources）、抽取两次失败 →
 *   Sam `extraction_failed` + rejected 审计、`facts.hasEvent` 在 LLM 之前去重（W9）；
 * - `OrderDispatcher`：201 / 409 / 400 / 5xx 内联重试耗尽→deferred+enqueue /
 *   timeout→deferred / inflight.begin 失败不发单；
 * - `RetryQueue`：clear、drain 成功重发（sent + 容量 + decision + 快照）、只发同一药房。
 *
 * 数据全部是合成值（保留域名 / 与任何一周无关的日期），不需要 week A 字面量。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppError } from '../../src/kernel/errors.ts';
import { Deadline } from '../../src/kernel/deadline.ts';
import { IdSequence } from '../../src/kernel/ids.ts';
import { noopLogger } from '../../src/kernel/logger.ts';
import type { Logger } from '../../src/kernel/logger.ts';
import { err, ok } from '../../src/kernel/result.ts';
import type { Result } from '../../src/kernel/result.ts';
import { SerialQueue } from '../../src/kernel/serial-queue.ts';
import { EtCalendar } from '../../src/kernel/time/et-calendar.ts';
import { Instant } from '../../src/kernel/time/instant.ts';
import { MemoryInflightJournal } from '../../src/adapters/persistence/memory-inflight-journal.ts';
import { MemoryStateStore } from '../../src/adapters/persistence/memory-state-store.ts';
import { AuditRecorder } from '../../src/application/audit/audit-recorder.ts';
import { EventProcessor } from '../../src/application/event-processor.ts';
import { OrderDispatcher } from '../../src/application/dispatch/order-dispatcher.ts';
import { RetryQueue } from '../../src/application/dispatch/retry-queue.ts';
import { RecoveryService } from '../../src/application/recovery/recovery-service.ts';
import type { InflightJournal } from '../../src/application/ports/inflight-journal.ts';
import type { AuditSink, FactAuditRecord } from '../../src/application/ports/audit-sink.ts';
import type {
  PharmacyGateway,
  SendOutcome,
} from '../../src/application/ports/pharmacy-gateway.ts';
import type { LlmExtractor } from '../../src/application/ports/llm-extractor.ts';
import type { PersistedState } from '../../src/application/ports/state-store.ts';
import { SessionHolder } from '../../src/application/session/session-holder.ts';
import { SnapshotMapper } from '../../src/application/session/snapshot-mapper.ts';
import { StartSimulationUseCase } from '../../src/application/use-cases/start-simulation.ts';
import { HandleOrderUseCase } from '../../src/application/use-cases/handle-order.ts';
import { HandleEmailUseCase } from '../../src/application/use-cases/handle-email.ts';
import { BeliefResolver } from '../../src/domain/belief/belief-resolver.ts';
import { DEFAULT_BELIEF_DEFAULTS } from '../../src/domain/belief/belief-defaults.ts';
import type { SimConfig } from '../../src/domain/config.ts';
import type { ExtractionResult } from '../../src/domain/email/extraction.ts';
import { EligibilityFilter } from '../../src/domain/routing/eligibility.ts';
import { PreferenceResolver } from '../../src/domain/routing/preferences.ts';
import { CandidateRanker } from '../../src/domain/routing/ranker.ts';
import { OrderRouter } from '../../src/domain/routing/router.ts';
import type { RoutingDecision } from '../../src/domain/routing/decision.ts';
import type { NormalizedOrder } from '../../src/domain/normalize/order-normalizer.ts';
import type { PersistedRoutingDecision } from '../../src/domain/routing/decision.ts';

// ---------------------------------------------------------------------------
// 合成夹具（与 week A 无关）
// ---------------------------------------------------------------------------

/** 2026-05-11 是周一 ET（EDT，-04:00）。 */
const STARTED_ISO = '2026-05-11T06:00:00-04:00';
const STARTED_EVENT_ID = 'evt-start-1';
const PHARMACY_API = 'http://pharmacy.test';
const OPS: readonly string[] = ['ops@lumimeds.test'];

/** 合成两家药房：ALPHA 快且覆盖 5mg；BETA 被 Texas 封锁且无 5mg。 */
function syntheticConfig(): SimConfig {
  return {
    catalogue: { tirzepatide: ['2.5mg', '5mg'], semaglutide: ['1mg'] },
    lumimedsOps: [...OPS],
    pharmacies: [
      {
        id: 'ALPHA',
        name: 'Alpha Rx',
        contacts: ['team@alpha.test'],
        open: true,
        shipsInDays: 1,
        dailyCapacity: 3,
        price: { tirzepatide: 120, semaglutide: 100 },
        blockedStates: ['FL'],
        stock: { tirzepatide: ['2.5mg', '5mg'], semaglutide: ['1mg'] },
      },
      {
        id: 'BETA',
        name: 'Beta Pharmacy',
        contacts: ['ops@beta.test'],
        open: true,
        shipsInDays: 2,
        dailyCapacity: 2,
        price: { tirzepatide: 110, semaglutide: 90 },
        blockedStates: ['Texas'],
        stock: { tirzepatide: ['2.5mg'], semaglutide: ['1mg'] },
      },
    ],
  };
}

/** 基础 fact 数：ALPHA 5（3 现货 + 1 封锁 + 1 容量）+ BETA 4 = 9。 */
const BASE_FACT_COUNT = 9;

function instant(iso: string): Instant {
  const parsed = Instant.parse(iso);
  if (!parsed.ok) throw new Error(`test fixture instant invalid: ${iso}`);
  return parsed.value;
}

function startedBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event_id: STARTED_EVENT_ID,
    type: 'simulation.started',
    occurred_at: STARTED_ISO,
    pharmacyApi: PHARMACY_API,
    config: syntheticConfig(),
    ...overrides,
  });
}

function orderBody(
  eventId: string,
  occurredAt: string,
  order: { order_id: string; state: string; medication: string; dose: string },
): string {
  return JSON.stringify({ event_id: eventId, type: 'order', occurred_at: occurredAt, order });
}

function emailBody(
  eventId: string,
  occurredAt: string,
  email: { from: string; subject: string; body: string },
): string {
  return JSON.stringify({ event_id: eventId, type: 'email', occurred_at: occurredAt, email });
}

function makeDecision(
  order: NormalizedOrder,
  at: Instant,
  chosen: RoutingDecision['chosen'],
  reason: string,
): RoutingDecision {
  return {
    orderId: order.orderId,
    at,
    order,
    chosen,
    basis: 'rank',
    reason,
    candidates: [],
    preference: null,
    override: null,
    sent: null,
  };
}

// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

/** 记录调用并按队列返回 outcome 的网关（默认 201）。 */
class FakeGateway implements PharmacyGateway {
  readonly calls: Array<{ orderId: string; pharmacy: string; reason?: string; timeoutMs: number }> =
    [];
  private readonly outcomes: SendOutcome[] = [];
  baseUrl: string | undefined;

  setBaseUrl(url: string): void {
    this.baseUrl = url;
  }

  enqueue(...outcomes: SendOutcome[]): void {
    this.outcomes.push(...outcomes);
  }

  get sendCount(): number {
    return this.calls.length;
  }

  async send(
    req: { orderId: string; pharmacy: string; reason?: string },
    opts: { timeoutMs: number },
  ): Promise<SendOutcome> {
    this.calls.push({
      orderId: req.orderId,
      pharmacy: req.pharmacy,
      ...(req.reason === undefined ? {} : { reason: req.reason }),
      timeoutMs: opts.timeoutMs,
    });
    return this.outcomes.shift() ?? { kind: 'accepted', status: 201 };
  }
}

/** 按队列返回抽取结果的 LLM 替身。 */
class FakeExtractor implements LlmExtractor {
  calls = 0;
  private readonly results: Array<Result<ExtractionResult, AppError>> = [];

  enqueueOk(...results: ExtractionResult[]): void {
    for (const result of results) this.results.push(ok(result));
  }

  enqueueErr(...errors: AppError[]): void {
    for (const error of errors) this.results.push(err(error));
  }

  async extract(): Promise<Result<ExtractionResult, AppError>> {
    this.calls += 1;
    const next = this.results.shift();
    if (next === undefined) {
      return err(new AppError('extraction_failed', 'FakeExtractor: no scripted result'));
    }
    return next;
  }
}

/** 记录 decisions/facts/flush 的审计替身。 */
class RecordingAuditSink implements AuditSink {
  readonly decisions: PersistedRoutingDecision[] = [];
  readonly facts: FactAuditRecord[] = [];
  flushes = 0;

  async decision(record: PersistedRoutingDecision): Promise<void> {
    this.decisions.push(record);
  }

  async fact(record: FactAuditRecord): Promise<void> {
    this.facts.push(record);
  }

  async flush(): Promise<void> {
    this.flushes += 1;
  }
}

/** 立即抛错的 inflight 替身：验证「不写 WAL 就不发」。 */
class BrokenInflightJournal implements InflightJournal {
  async begin(): Promise<void> {
    throw new Error('wal disk down');
  }
  async commit(): Promise<void> {
    throw new Error('wal disk down');
  }
  async load(): Promise<readonly never[]> {
    return [];
  }
  async clear(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------

interface Harness {
  calendar: EtCalendar;
  logger: Logger;
  gateway: FakeGateway;
  extractor: FakeExtractor;
  sink: RecordingAuditSink;
  stateStore: MemoryStateStore;
  inflight: MemoryInflightJournal;
  holder: SessionHolder;
  mapper: SnapshotMapper;
  queue: SerialQueue;
  recorder: AuditRecorder;
  retry: RetryQueue;
  dispatcher: OrderDispatcher;
  processor: EventProcessor;
}

function makeHarness(overrides: { inflight?: InflightJournal } = {}): Harness {
  const calendar = new EtCalendar();
  calendar.selfTest();
  const logger = noopLogger;
  const gateway = new FakeGateway();
  const extractor = new FakeExtractor();
  const sink = new RecordingAuditSink();
  const stateStore = new MemoryStateStore();
  const inflight = new MemoryInflightJournal();
  const holder = new SessionHolder();
  const mapper = new SnapshotMapper({ calendar });
  const queue = new SerialQueue();
  const recorder = new AuditRecorder({ sink, calendar, logger });
  const retry = new RetryQueue({
    queue,
    holder,
    gateway,
    calendar,
    recorder,
    stateStore,
    mapper,
    logger,
    sendTimeoutMs: 500,
  });
  const dispatcher = new OrderDispatcher({
    gateway,
    inflight: overrides.inflight ?? inflight,
    retry,
    holder,
    calendar,
    logger,
    sendTimeoutMs: 500,
    // 内联退避在单测里不需要真的等 250/500/1000ms。
    sleep: async () => {},
  });
  const router = new OrderRouter({
    filter: new EligibilityFilter(),
    prefs: new PreferenceResolver(),
    ranker: new CandidateRanker(),
  });
  const beliefs = new BeliefResolver({ calendar, defaults: DEFAULT_BELIEF_DEFAULTS });
  const order = new HandleOrderUseCase({ holder, router, beliefs, recorder, dispatcher, logger });
  const email = new HandleEmailUseCase({ holder, extractor, calendar, recorder, logger });
  const started = new StartSimulationUseCase({
    calendar,
    ids: new IdSequence(),
    stateStore,
    inflight,
    holder,
    mapper,
    gateway,
    clearRetryQueue: () => retry.clear(),
    logger,
  });
  const processor = new EventProcessor({
    queue,
    holder,
    started,
    order,
    email,
    stateStore,
    mapper,
    recorder,
    logger,
    // 写盘失败注入的测试不需要真的等 50/200ms。
    persistRetryDelaysMs: [0, 0],
  });
  return {
    calendar,
    logger,
    gateway,
    extractor,
    sink,
    stateStore,
    inflight,
    holder,
    mapper,
    queue,
    recorder,
    retry,
    dispatcher,
    processor,
  };
}

/** 通过真实 `EventProcessor` 处理 `simulation.started`，建立一个可用的周会话。 */
async function startWeek(h: Harness): Promise<void> {
  const result = await h.processor.process({ body: startedBody() });
  assert.equal(result.status, 200);
  assert.equal(result.outcome, 'started');
  if (!h.holder.hasSession()) throw new Error('harness: session must exist after started');
}

function sessionOf(h: Harness) {
  return h.holder.requireSession();
}

const ORDER_AT = '2026-05-12T09:15:00-04:00';

function txOrder(orderId = 'ORD-TEST-1'): {
  order_id: string;
  state: string;
  medication: string;
  dose: string;
} {
  return { order_id: orderId, state: 'TX', medication: 'tirz', dose: '5 mg' };
}

// ---------------------------------------------------------------------------
// EventProcessor
// ---------------------------------------------------------------------------

describe('EventProcessor：主干与幂等', () => {
  it('simulation.started 在幂等门之前：同一 event_id 重放仍重置会话（不是 duplicate）', async () => {
    const h = makeHarness();
    await startWeek(h);

    const firstSession = sessionOf(h);
    assert.equal(firstSession.facts.snapshot().length, BASE_FACT_COUNT);
    firstSession.seenEventIds.add('evt-marker-1');
    firstSession.degraded = true;

    // 同一份 started 再投一次（隐藏周会重放同一 week 文件）→ 必须无条件重置。
    const again = await h.processor.process({ body: startedBody() });
    assert.equal(again.status, 200);
    assert.equal(again.outcome, 'started');

    const secondSession = sessionOf(h);
    assert.notEqual(secondSession, firstSession, 'started 必须换一个新会话');
    assert.deepEqual([...secondSession.seenEventIds], [STARTED_EVENT_ID]);
    assert.equal(secondSession.facts.snapshot().length, BASE_FACT_COUNT);
    assert.equal(secondSession.degraded, false);

    const persisted: PersistedState | null = h.stateStore.snapshot();
    assert.ok(persisted !== null);
    assert.deepEqual(persisted.seen_event_ids, [STARTED_EVENT_ID]);
  });

  it('无会话时 order → 500 no_session，不写盘', async () => {
    const h = makeHarness();
    const result = await h.processor.process({
      body: orderBody('evt-order-1', ORDER_AT, txOrder()),
    });
    assert.deepEqual(result, { status: 500, outcome: 'no_session' });
    assert.equal(h.stateStore.saves, 0);
    assert.equal(h.gateway.sendCount, 0);
  });

  it('重复 event_id → 200 duplicate，且不重复发单、不再写盘', async () => {
    const h = makeHarness();
    await startWeek(h);
    const body = orderBody('evt-order-1', ORDER_AT, txOrder());

    const first = await h.processor.process({ body });
    assert.equal(first.status, 200);
    assert.equal(first.outcome, 'order_sent');
    assert.equal(h.gateway.sendCount, 1);
    const savesAfterFirst = h.stateStore.saves;

    const second = await h.processor.process({ body });
    assert.deepEqual(second, { status: 200, outcome: 'duplicate' });
    assert.equal(h.gateway.sendCount, 1, 'duplicate 不能再次发单');
    assert.equal(h.stateStore.saves, savesAfterFirst, 'duplicate 不写盘');
    // 重投不更新 lastEventAt：仍是首个订单事件的 occurred_at。
    assert.equal(h.calendar.iso(sessionOf(h).lastEventAt), ORDER_AT);
  });

  it('未知 type → 200 ignored_type，不写 seen、不写盘', async () => {
    const h = makeHarness();
    await startWeek(h);
    const savesAfterStart = h.stateStore.saves;
    const seenBefore = [...sessionOf(h).seenEventIds];

    const result = await h.processor.process({
      body: JSON.stringify({
        event_id: 'evt-unknown-1',
        type: 'telemetry.ping',
        occurred_at: ORDER_AT,
      }),
    });
    assert.deepEqual(result, { status: 200, outcome: 'ignored_type' });
    assert.deepEqual([...sessionOf(h).seenEventIds], seenBefore);
    assert.equal(h.stateStore.saves, savesAfterStart);
  });

  it('坏 JSON → 400 bad_request，不建会话、不写盘', async () => {
    const h = makeHarness();
    const result = await h.processor.process({ body: '{not json' });
    assert.deepEqual(result, { status: 400, outcome: 'bad_request' });
    assert.equal(h.holder.hasSession(), false);
    assert.equal(h.stateStore.saves, 0);
  });

  it('订单事件 201：sent/capacity/decision/审计一次写全', async () => {
    const h = makeHarness();
    await startWeek(h);

    const result = await h.processor.process({
      body: orderBody('evt-order-1', ORDER_AT, txOrder()),
    });
    assert.equal(result.outcome, 'order_sent');

    const session = sessionOf(h);
    const at = instant(ORDER_AT);
    assert.ok(session.sent.has('ORD-TEST-1'));
    const sent = session.sent.get('ORD-TEST-1');
    assert.equal(sent?.pharmacy, 'ALPHA');
    assert.ok(sent?.at.equals(at), 'sent.at 必须是订单事件的 occurred_at');
    assert.equal(session.capacity.used('ALPHA', h.calendar.dateOf(at)), 1);

    const decision = session.decisions.get('ORD-TEST-1');
    assert.ok(decision !== undefined);
    assert.equal(decision.chosen, 'ALPHA');
    assert.equal(decision.sent?.status, 201);
    assert.ok(decision.sent?.at.equals(at));

    // 审计走 AuditRecorder → sink（EventProcessor 统一 flush）。
    assert.equal(h.sink.decisions.length, 1);
    assert.equal(h.sink.decisions[0]?.order_id, 'ORD-TEST-1');
    assert.equal(h.sink.decisions[0]?.sent?.status, 201);
    assert.ok(h.sink.flushes >= 1);

    // 发单请求形状：同一批次/同药房，reason 来自路由。
    assert.equal(h.gateway.calls[0]?.pharmacy, 'ALPHA');
    assert.match(h.gateway.calls[0]?.reason ?? '', /fastest safe/);
  });

  it('归一化失败 → MANUAL（reason unknown_dose:25mg），仍写 decision + 审计', async () => {
    const h = makeHarness();
    await startWeek(h);

    const result = await h.processor.process({
      body: orderBody('evt-order-bad', ORDER_AT, {
        order_id: 'ORD-BAD-1',
        state: 'TX',
        medication: 'tirzepatide',
        dose: '25mg',
      }),
    });
    assert.equal(result.outcome, 'order_manual');

    const session = sessionOf(h);
    const decision = session.decisions.get('ORD-BAD-1');
    assert.ok(decision !== undefined);
    assert.equal(decision.chosen, 'MANUAL');
    assert.equal(decision.basis, 'manual');
    assert.equal(decision.reason, 'unknown_dose:25mg');
    assert.deepEqual(decision.candidates, []);

    assert.equal(h.gateway.calls[0]?.pharmacy, 'MANUAL');
    assert.equal(session.sent.get('ORD-BAD-1')?.pharmacy, 'MANUAL');
    // MANUAL 不占任何药房的容量。
    assert.equal(session.capacity.used('ALPHA', h.calendar.dateOf(instant(ORDER_AT))), 0);
    assert.equal(h.sink.decisions.length, 1);
  });

  it('写盘 3 次仍失败 → 500 persist_failed + degraded（不静默 ACK）', async () => {
    const h = makeHarness();
    await startWeek(h);
    h.stateStore.failNextSave(3);

    const result = await h.processor.process({
      body: orderBody('evt-order-savefail', ORDER_AT, txOrder()),
    });
    assert.deepEqual(result, { status: 500, outcome: 'persist_failed' });
    assert.equal(sessionOf(h).degraded, true);
    // 副作用已经发生（发单成功），只是没落盘——设计上必须让失败可见。
    assert.equal(h.gateway.sendCount, 1);
  });

  it('inflight 写失败 → 500 internal_error，且绝不发送（§9：不发比发两次好）', async () => {
    const h = makeHarness({ inflight: new BrokenInflightJournal() });
    await startWeek(h);

    const result = await h.processor.process({
      body: orderBody('evt-order-walfail', ORDER_AT, txOrder()),
    });
    assert.deepEqual(result, { status: 500, outcome: 'internal_error' });
    assert.equal(h.gateway.sendCount, 0);
    assert.equal(sessionOf(h).seenEventIds.has('evt-order-walfail'), false);
  });
});

// ---------------------------------------------------------------------------
// HandleEmailUseCase（经 EventProcessor）
// ---------------------------------------------------------------------------

const EMAIL_AT = '2026-05-12T09:00:00-04:00';

function stockUnavailableExtraction(): ExtractionResult {
  return {
    intent: 'stock',
    facts: [
      {
        type: 'stock_unavailable',
        pharmacy: null,
        medication: 'tirzepatide',
        dose: '5mg',
        phrase: 'until Wednesday',
      },
    ],
    confidence: 'high',
  };
}

describe('HandleEmailUseCase：经 EventProcessor 的邮件主链', () => {
  it('applied：fact 落库 + 审计（sources/assumptions/dateOverrides）', async () => {
    const h = makeHarness();
    await startWeek(h);
    h.extractor.enqueueOk(stockUnavailableExtraction());

    const result = await h.processor.process({
      body: emailBody('evt-email-1', EMAIL_AT, {
        from: 'Jen <team@alpha.test>',
        subject: 'Stock',
        body: "we're out of tirzepatide 5mg until Wednesday",
      }),
    });
    assert.equal(result.outcome, 'email_applied');
    assert.equal(h.extractor.calls, 1);

    const session = sessionOf(h);
    const facts = session.facts.snapshot();
    assert.equal(facts.length, BASE_FACT_COUNT + 1);
    const fact = facts[facts.length - 1];
    assert.ok(fact !== undefined);
    assert.equal(fact.type, 'stock_unavailable');
    assert.equal(fact.event_id, 'evt-email-1');
    assert.equal(fact.pharmacy, 'ALPHA');
    assert.equal(fact.medication, 'tirzepatide');
    assert.equal(fact.dose, '5mg');
    // FactStore.snapshot 用 UTC ISO（Z）表示时间；语义比较用 Instant。
    assert.equal(fact.interval.until, instant('2026-05-13T00:00:00-04:00').toISOString());
    assert.equal(fact.interval.from, instant(EMAIL_AT).toISOString());

    const audit = h.sink.facts[0];
    assert.ok(audit !== undefined);
    assert.equal(audit.outcome, 'applied');
    assert.equal(audit.event_id, 'evt-email-1');
    assert.equal(audit.role, 'pharmacy');
    assert.equal(audit.facts?.length, 1);
    assert.equal(audit.facts?.[0]?.dose, '5mg');
    assert.equal(audit.sources?.from, 'default:occurred_at');
    assert.equal(audit.sources?.until, 'parser:until_weekday');
  });

  it('抽取两次都失败 → Sam(extraction_failed) + rejected 审计 + email_rejected', async () => {
    const h = makeHarness();
    await startWeek(h);
    h.extractor.enqueueErr(
      new AppError('extraction_failed', 'first attempt failed'),
      new AppError('extraction_failed', 'second attempt failed'),
    );

    const result = await h.processor.process({
      body: emailBody('evt-email-fail', EMAIL_AT, {
        from: 'team@alpha.test',
        subject: '?',
        body: 'unreadable',
      }),
    });
    assert.equal(result.outcome, 'email_rejected');
    assert.equal(h.extractor.calls, 2, '抽取失败必须重试一次');

    const session = sessionOf(h);
    const sam = session.sam.all();
    assert.equal(sam.length, 1);
    assert.equal(sam[0]?.reason, 'extraction_failed');
    assert.ok((sam[0]?.suggested_action ?? '').length > 0);
    assert.equal(sam[0]?.draft_reply, null);

    assert.equal(h.sink.facts.length, 1);
    assert.equal(h.sink.facts[0]?.outcome, 'rejected');
    assert.equal(h.sink.facts[0]?.reason, 'extraction_failed');
  });

  it('facts.hasEvent 在 LLM 之前去重：seen 丢失后重投也只 no_change，不再调模型', async () => {
    const h = makeHarness();
    await startWeek(h);
    h.extractor.enqueueOk(stockUnavailableExtraction());

    const body = emailBody('evt-email-1', EMAIL_AT, {
      from: 'team@alpha.test',
      subject: 'Stock',
      body: 'out of 5mg until Wednesday',
    });
    const first = await h.processor.process({ body });
    assert.equal(first.outcome, 'email_applied');
    assert.equal(h.extractor.calls, 1);
    const factsAfterFirst = sessionOf(h).facts.snapshot().length;

    // 模拟「fact 已落盘、seen 没落盘」的崩溃窗口：只回滚 seen，再重投同一事件。
    sessionOf(h).seenEventIds.delete('evt-email-1');
    const second = await h.processor.process({ body });
    assert.equal(second.outcome, 'email_no_change');
    assert.equal(h.extractor.calls, 1, 'hasEvent 命中时不能再调 LLM（W9）');
    assert.equal(sessionOf(h).facts.snapshot().length, factsAfterFirst);
  });
});

// ---------------------------------------------------------------------------
// OrderDispatcher（直接调用，注入状态码）
// ---------------------------------------------------------------------------

const DISPATCH_AT = '2026-05-12T10:00:00-04:00';

function dispatchFixture(): {
  h: Harness;
  order: NormalizedOrder;
  decision: RoutingDecision;
  at: Instant;
  deadline: Deadline;
} {
  const order: NormalizedOrder = {
    orderId: 'ORD-DISPATCH-1',
    state: 'TX',
    medication: 'tirzepatide',
    dose: '5mg',
  };
  const at = instant(DISPATCH_AT);
  return {
    h: makeHarness(),
    order,
    decision: makeDecision(order, at, 'ALPHA', 'fastest safe: ALPHA (1 day, $120)'),
    at,
    deadline: Deadline.after(at, 25_000),
  };
}

async function withStartedSession(
  fixture: ReturnType<typeof dispatchFixture>,
): Promise<void> {
  await startWeek(fixture.h);
}

describe('OrderDispatcher：状态码表', () => {
  it('201 → sent + sent.mark + capacity.record + inflight.commit', async () => {
    const fixture = dispatchFixture();
    await withStartedSession(fixture);
    fixture.h.gateway.enqueue({ kind: 'accepted', status: 201 });

    const result = await fixture.h.dispatcher.dispatch(
      fixture.order,
      fixture.decision,
      fixture.at,
      fixture.deadline,
    );
    assert.deepEqual(result, { kind: 'sent', status: 201 });
    const session = sessionOf(fixture.h);
    assert.equal(session.sent.get(fixture.order.orderId)?.pharmacy, 'ALPHA');
    assert.equal(session.capacity.used('ALPHA', fixture.h.calendar.dateOf(fixture.at)), 1);
    assert.equal(fixture.h.inflight.size, 0, '201 后 WAL 必须清理');
  });

  it('409 → 视为已发（记容量 + warn），不重试', async () => {
    const fixture = dispatchFixture();
    await withStartedSession(fixture);
    fixture.h.gateway.enqueue({ kind: 'duplicate', status: 409 });

    const result = await fixture.h.dispatcher.dispatch(
      fixture.order,
      fixture.decision,
      fixture.at,
      fixture.deadline,
    );
    assert.deepEqual(result, { kind: 'already_sent', status: 409 });
    const session = sessionOf(fixture.h);
    assert.ok(session.sent.has(fixture.order.orderId));
    assert.equal(session.capacity.used('ALPHA', fixture.h.calendar.dateOf(fixture.at)), 1);
    assert.equal(fixture.h.gateway.sendCount, 1, '409 不重试');
  });

  it('400 → failed，不重试、不记 sent/容量', async () => {
    const fixture = dispatchFixture();
    await withStartedSession(fixture);
    fixture.h.gateway.enqueue({ kind: 'rejected', status: 400, message: 'bad body' });

    const result = await fixture.h.dispatcher.dispatch(
      fixture.order,
      fixture.decision,
      fixture.at,
      fixture.deadline,
    );
    assert.equal(result.kind, 'failed');
    assert.equal(result.status, 400);
    const session = sessionOf(fixture.h);
    assert.equal(session.sent.has(fixture.order.orderId), false);
    assert.equal(session.capacity.used('ALPHA', fixture.h.calendar.dateOf(fixture.at)), 0);
    assert.equal(fixture.h.gateway.sendCount, 1);
    assert.equal(fixture.h.inflight.size, 0);
  });

  it('5xx 内联退避耗尽（250/500/1000）→ deferred + 同药房入重试队列', async () => {
    const fixture = dispatchFixture();
    await withStartedSession(fixture);
    fixture.h.gateway.enqueue(
      { kind: 'retryable', status: 500 },
      { kind: 'retryable', status: 500 },
      { kind: 'retryable', status: 500 },
      { kind: 'retryable', status: 500 },
    );

    const result = await fixture.h.dispatcher.dispatch(
      fixture.order,
      fixture.decision,
      fixture.at,
      fixture.deadline,
    );
    assert.equal(result.kind, 'deferred');
    assert.equal(fixture.h.gateway.sendCount, 4, '首次 + 3 次内联重试');
    assert.deepEqual(
      fixture.h.gateway.calls.map((call) => call.pharmacy),
      ['ALPHA', 'ALPHA', 'ALPHA', 'ALPHA'],
      '只能对同一药房重发，绝不改派',
    );
    assert.equal(fixture.h.retry.pending(), 1);
    assert.equal(sessionOf(fixture.h).sent.has(fixture.order.orderId), false);
  });

  it('timeout（结果未知）→ deferred + 同药房入队', async () => {
    const fixture = dispatchFixture();
    await withStartedSession(fixture);
    fixture.h.gateway.enqueue(
      { kind: 'timeout' },
      { kind: 'timeout' },
      { kind: 'timeout' },
      { kind: 'timeout' },
    );

    const result = await fixture.h.dispatcher.dispatch(
      fixture.order,
      fixture.decision,
      fixture.at,
      fixture.deadline,
    );
    assert.equal(result.kind, 'deferred');
    assert.equal(fixture.h.retry.pending(), 1);
    assert.deepEqual(
      fixture.h.gateway.calls.map((call) => call.pharmacy),
      ['ALPHA', 'ALPHA', 'ALPHA', 'ALPHA'],
    );
  });

  it('inflight.begin 失败 → 不发送（不写 WAL 就不发）', async () => {
    const fixture = dispatchFixture();
    const broken = makeHarness({ inflight: new BrokenInflightJournal() });
    await startWeek(broken);
    const result = await broken.dispatcher.dispatch(
      fixture.order,
      fixture.decision,
      fixture.at,
      Deadline.after(fixture.at, 25_000),
    );
    assert.equal(result.kind, 'failed');
    assert.equal(result.status, 500);
    assert.equal(broken.gateway.sendCount, 0);
  });

  it('sent.has → already_sent 且不发任何请求（INV-2）', async () => {
    const fixture = dispatchFixture();
    await withStartedSession(fixture);
    sessionOf(fixture.h).sent.mark(fixture.order.orderId, 'ALPHA', fixture.at);

    const result = await fixture.h.dispatcher.dispatch(
      fixture.order,
      fixture.decision,
      fixture.at,
      fixture.deadline,
    );
    assert.equal(result.kind, 'already_sent');
    assert.equal(fixture.h.gateway.sendCount, 0);
  });
});

// ---------------------------------------------------------------------------
// RetryQueue
// ---------------------------------------------------------------------------

describe('RetryQueue：调度/清理/drain', () => {
  it('clear 清空队列（定时器保留给新周），空队列不会发任何请求', async () => {
    const h = makeHarness();
    await startWeek(h);
    h.retry.enqueue({
      order: { orderId: 'ORD-RETRY-1', state: 'TX', medication: 'tirzepatide', dose: '5mg' },
      pharmacy: 'ALPHA',
      at: instant(DISPATCH_AT),
      reason: 'fastest safe: ALPHA',
    });
    assert.equal(h.retry.pending(), 1);
    h.retry.start(10);
    h.retry.clear();
    assert.equal(h.retry.pending(), 0);
    // 定时器还在（新周继续用），但没有条目时不会发出任何请求。
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(h.gateway.sendCount, 0);
  });

  it('drain：只重发同一药房，成功后 sent/容量/decision/快照齐备', async () => {
    const h = makeHarness();
    await startWeek(h);
    const at = instant(DISPATCH_AT);
    const order: NormalizedOrder = {
      orderId: 'ORD-RETRY-2',
      state: 'TX',
      medication: 'tirzepatide',
      dose: '5mg',
    };
    h.retry.enqueue({ order, pharmacy: 'BETA', at, reason: 'fastest safe: BETA' });
    assert.equal(h.retry.pending(), 1);

    await h.retry.drain(1_000);

    assert.equal(h.retry.pending(), 0);
    assert.equal(h.gateway.sendCount, 1);
    assert.equal(h.gateway.calls[0]?.pharmacy, 'BETA', '绝不重新路由（即使 ALPHA 更快）');

    const session = sessionOf(h);
    assert.equal(session.sent.get('ORD-RETRY-2')?.pharmacy, 'BETA');
    assert.equal(session.capacity.used('BETA', h.calendar.dateOf(at)), 1);
    const decision = session.decisions.get('ORD-RETRY-2');
    assert.ok(decision !== undefined);
    assert.equal(decision.chosen, 'BETA');
    assert.equal(decision.sent?.status, 201);
    assert.equal(h.sink.decisions.length, 1);
    assert.ok(h.sink.flushes >= 1);
    const persisted = h.stateStore.snapshot();
    assert.equal(persisted?.sent_orders['ORD-RETRY-2']?.pharmacy, 'BETA');
  });

  it('drain：终局拒绝（400）后不再保留该项', async () => {
    const h = makeHarness();
    await startWeek(h);
    h.gateway.enqueue({ kind: 'rejected', status: 400, message: 'nope' });
    h.retry.enqueue({
      order: { orderId: 'ORD-RETRY-3', state: 'TX', medication: 'tirzepatide', dose: '5mg' },
      pharmacy: 'ALPHA',
      at: instant(DISPATCH_AT),
      reason: null,
    });

    await h.retry.drain(1_000);
    assert.equal(h.retry.pending(), 0);
    assert.equal(sessionOf(h).sent.has('ORD-RETRY-3'), false);
  });
});

// ---------------------------------------------------------------------------
// RecoveryService（§6.3 / §11.3）
// ---------------------------------------------------------------------------

describe('RecoveryService：按 WAL 原样恢复，不重新路由', () => {
  it('无快照：不造空壳会话，run() 不抛且报告 sessionLoaded=false', async () => {
    const calendar = new EtCalendar();
    const holder = new SessionHolder();
    const recovery = new RecoveryService({
      holder,
      inflight: new MemoryInflightJournal(),
      gateway: new FakeGateway(),
      calendar,
      logger: noopLogger,
      stateStore: new MemoryStateStore(),
      mapper: new SnapshotMapper({ calendar }),
    });
    const report = await recovery.run();
    assert.equal(report.sessionLoaded, false);
    assert.equal(holder.hasSession(), false);
  });

  it('已发（sent.has）→ 只 commit WAL，不发请求', async () => {
    const h = makeHarness();
    await startWeek(h);
    // 先真实发一单，让快照里存在 sent_orders。
    const sentResult = await h.processor.process({
      body: orderBody('evt-order-1', ORDER_AT, txOrder()),
    });
    assert.equal(sentResult.outcome, 'order_sent');
    // WAL 里残留同一条（模拟 201 之后、commit 之前崩溃）。
    await h.inflight.begin({
      orderId: 'ORD-TEST-1',
      pharmacy: 'ALPHA',
      at: ORDER_AT,
      decisionReason: 'fastest safe: ALPHA',
      startedAtRealClock: 'ignored',
    });

    const freshHolder = new SessionHolder();
    const recovery = new RecoveryService({
      holder: freshHolder,
      inflight: h.inflight,
      gateway: h.gateway,
      calendar: h.calendar,
      logger: noopLogger,
      stateStore: h.stateStore,
      mapper: h.mapper,
    });
    const sendsBefore = h.gateway.sendCount;
    const report = await recovery.run();

    assert.equal(report.sessionLoaded, true);
    assert.equal(report.inflightEntries, 1);
    assert.equal(report.committed, 1);
    assert.equal(report.recovered, 0);
    assert.equal(h.gateway.sendCount, sendsBefore, '已发单不能重发');
    assert.equal((await h.inflight.load()).length, 0, 'WAL 必须清掉');
    assert.ok(freshHolder.hasSession());
  });

  it('未确认（结果未知窗口）→ 按 WAL 药房重发 201，容量用 WAL 的 at，绝不重新路由', async () => {
    const h = makeHarness();
    await startWeek(h);
    const walAt = '2026-05-12T11:00:00-04:00';
    await h.inflight.begin({
      orderId: 'ORD-RECOVER-1',
      // BETA 在正常路由里会输给 ALPHA（慢、且被 TX 封锁）；恢复必须照 WAL 发 BETA。
      pharmacy: 'BETA',
      at: walAt,
      decisionReason: 'fastest safe: BETA',
      startedAtRealClock: 'ignored',
    });

    const freshHolder = new SessionHolder();
    const recovery = new RecoveryService({
      holder: freshHolder,
      inflight: h.inflight,
      gateway: h.gateway,
      calendar: h.calendar,
      logger: noopLogger,
      stateStore: h.stateStore,
      mapper: h.mapper,
    });
    const report = await recovery.run();

    assert.equal(report.sessionLoaded, true);
    assert.equal(report.recovered, 1);
    assert.equal(report.deferred, 0);
    assert.equal(report.stateSaved, true);
    assert.equal(h.gateway.calls[0]?.pharmacy, 'BETA', '只发 WAL 里记的那家药房');
    assert.equal(h.gateway.calls[0]?.orderId, 'ORD-RECOVER-1');

    const session = freshHolder.requireSession();
    assert.equal(session.sent.get('ORD-RECOVER-1')?.pharmacy, 'BETA');
    assert.ok(
      session.sent.get('ORD-RECOVER-1')?.at.equals(instant(walAt)),
      'sent.at 必须是 WAL 的原始决策时刻',
    );
    assert.equal(session.capacity.used('BETA', h.calendar.dateOf(instant(walAt))), 1);
    assert.equal((await h.inflight.load()).length, 0);

    // 恢复结果必须落盘，否则下次重启会再发一次。
    const persisted = h.stateStore.snapshot();
    assert.equal(persisted?.sent_orders['ORD-RECOVER-1']?.pharmacy, 'BETA');
  });

  it('未确认 → 409 视为已发：同样记容量（WAL 的 at）并清 WAL', async () => {
    const h = makeHarness();
    await startWeek(h);
    h.gateway.enqueue({ kind: 'duplicate', status: 409 });
    const walAt = '2026-05-12T12:30:00-04:00';
    await h.inflight.begin({
      orderId: 'ORD-RECOVER-2',
      pharmacy: 'ALPHA',
      at: walAt,
      decisionReason: null,
      startedAtRealClock: 'ignored',
    });

    const freshHolder = new SessionHolder();
    const recovery = new RecoveryService({
      holder: freshHolder,
      inflight: h.inflight,
      gateway: h.gateway,
      calendar: h.calendar,
      logger: noopLogger,
      stateStore: h.stateStore,
      mapper: h.mapper,
    });
    const report = await recovery.run();

    assert.equal(report.confirmed, 1);
    assert.equal(report.recovered, 0);
    const session = freshHolder.requireSession();
    assert.equal(session.sent.get('ORD-RECOVER-2')?.pharmacy, 'ALPHA');
    assert.equal(session.capacity.used('ALPHA', h.calendar.dateOf(instant(walAt))), 1);
    assert.equal((await h.inflight.load()).length, 0);
  });
});
