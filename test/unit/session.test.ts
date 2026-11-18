/**
 * application 层会话子系统的单测（task-8 / `ARCHITECTURE.md` §5.9、§11.1、§12.2）。
 *
 * 覆盖：
 * - `SnapshotMapper` 往返（facts / decisions / sam / sent / seq / last_event_at /
 *   degraded / validationWindow / capacity 派生）与快照损坏的失败分支；
 * - `DecisionLog` upsert + `attachSend`；`SentOrderLog.mark` 幂等；
 * - `EnvelopeParser` 的正常/回退/错误分支（未知 type 不报错）；
 * - `AuditRecorder` 只暂存、flush 交给 sink、失败只日志；
 * - `SessionFactory` / `StartSimulationUseCase`（config 校验、基础 fact、gateway
 *   注入、inflight/retry 清理、ids.reset、一次原子 save、degraded 语义）。
 *
 * 数据全部是合成值（与任何一周无关），所以不需要 week A 字面量。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { IdSequence } from '../../src/kernel/ids.ts';
import { noopLogger } from '../../src/kernel/logger.ts';
import type { Logger } from '../../src/kernel/logger.ts';
import type { Result } from '../../src/kernel/result.ts';
import { EtCalendar } from '../../src/kernel/time/et-calendar.ts';
import { Instant } from '../../src/kernel/time/instant.ts';
import { Interval } from '../../src/kernel/time/interval.ts';
import type { SimConfig } from '../../src/domain/config.ts';
import type { SamEntry } from '../../src/domain/email/sam-list.ts';
import type { SimulationStartedEvent } from '../../src/domain/events.ts';
import type {
  PersistedRoutingDecision,
  RoutingDecision,
} from '../../src/domain/routing/decision.ts';
import type { OrderId, PharmacyId } from '../../src/domain/types.ts';
import { MemoryInflightJournal } from '../../src/adapters/persistence/memory-inflight-journal.ts';
import { MemoryStateStore } from '../../src/adapters/persistence/memory-state-store.ts';
import type { AuditSink, FactAuditRecord } from '../../src/application/ports/audit-sink.ts';
import type { InflightJournal } from '../../src/application/ports/inflight-journal.ts';
import type { SendOutcome } from '../../src/application/ports/pharmacy-gateway.ts';
import type { PharmacyGateway } from '../../src/application/ports/pharmacy-gateway.ts';
import type { PersistedState, StateStore } from '../../src/application/ports/state-store.ts';
import { AuditRecorder } from '../../src/application/audit/audit-recorder.ts';
import { EnvelopeParser } from '../../src/application/ingest/envelope-parser.ts';
import { DecisionLog } from '../../src/application/session/decision-log.ts';
import { SentOrderLog } from '../../src/application/session/sent-order-log.ts';
import { SessionFactory } from '../../src/application/session/session-factory.ts';
import { SessionHolder } from '../../src/application/session/session-holder.ts';
import {
  SimulationSession,
  validationWindowOf,
} from '../../src/application/session/simulation-session.ts';
import { SnapshotMapper } from '../../src/application/session/snapshot-mapper.ts';
import {
  StartSimulationUseCase,
  type SimulationGateway,
} from '../../src/application/use-cases/start-simulation.ts';

// ---------------------------------------------------------------------------
// 合成夹具（与 week A 无关）
// ---------------------------------------------------------------------------

/** 2026-01-05 是周一 ET（冬令时，-05:00）。 */
const STARTED_ISO = '2026-01-05T06:00:00-05:00';
/** 周二 09:30 ET。 */
const EMAIL_AT_ISO = '2026-01-06T09:30:00-05:00';
/** 周三 10:00 ET。 */
const SECOND_AT_ISO = '2026-01-07T10:00:00-05:00';
/** 周四 00:00 ET（interval 的排他上界）。 */
const UNTIL_ISO = '2026-01-08T00:00:00-05:00';

const STARTED_EVENT_ID = 'evt-start-1';
const PHARMACY_API = 'http://pharmacy.test';

/** 两家药房的合成 config：基础 fact 数 = 9（ALPHA 5 + BETA 4）。 */
function syntheticConfig(): SimConfig {
  return {
    catalogue: { tirzepatide: ['2.5mg', '5mg'], semaglutide: ['1mg'] },
    lumimedsOps: ['ops@lumimeds.test'],
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

function makeStartedEvent(
  overrides: Partial<SimulationStartedEvent> = {},
): SimulationStartedEvent {
  return {
    event_id: STARTED_EVENT_ID,
    type: 'simulation.started',
    occurred_at: STARTED_ISO,
    pharmacyApi: PHARMACY_API,
    config: syntheticConfig(),
    ...overrides,
  };
}

function parseInstant(iso: string): Instant {
  const parsed = Instant.parse(iso);
  if (!parsed.ok) throw new Error(`test fixture instant invalid: ${iso}`);
  return parsed.value;
}

function expectOk<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(`expected Ok, got Err: ${JSON.stringify(result.error)}`);
  return result.value;
}

function expectErr<T, E>(result: Result<T, E>): E {
  if (result.ok) throw new Error('expected Err, got Ok');
  return result.error;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function makeMapper(calendar: EtCalendar): SnapshotMapper {
  return new SnapshotMapper({ calendar });
}

interface SessionFixture {
  calendar: EtCalendar;
  ids: IdSequence;
  session: SimulationSession;
}

/** 通过 `SessionFactory` 建一个真实的新周会话（ids 先 reset）。 */
function buildSession(): SessionFixture {
  const calendar = new EtCalendar();
  calendar.selfTest();
  const ids = new IdSequence();
  ids.reset();
  const factory = new SessionFactory({ calendar, ids });
  const session = expectOk(factory.create(makeStartedEvent()));
  return { calendar, ids, session };
}

function makeDecision(
  orderId: string,
  at: Instant,
  overrides: Partial<RoutingDecision> = {},
): RoutingDecision {
  return {
    orderId,
    at,
    order: { orderId, state: 'TX', medication: 'tirzepatide', dose: '5mg' },
    chosen: 'ALPHA',
    basis: 'rank',
    reason: 'fastest safe: 1 day, $120',
    candidates: [
      {
        pharmacy: 'ALPHA',
        eligible: true,
        shipsInDays: 1,
        price: 120,
        capacityLeft: 3,
        failures: [],
      },
      {
        pharmacy: 'BETA',
        eligible: false,
        shipsInDays: 2,
        price: 110,
        capacityLeft: 2,
        failures: ['state_blocked:TX'],
      },
    ],
    preference: null,
    override: null,
    sent: null,
    ...overrides,
  };
}

/** 给会话加上「一周中段」的状态：邮件 fact、决策、已发单、Sam、seen、degraded。 */
function decorateSession(session: SimulationSession): void {
  const at = parseInstant(EMAIL_AT_ISO);
  const secondAt = parseInstant(SECOND_AT_ISO);
  const until = parseInstant(UNTIL_ISO);

  const interval = Interval.of(at, until);
  if (!interval.ok) throw new Error('test fixture interval invalid');
  const factId = session.ids.next('fact');
  const seq = Number(factId.slice('fact_'.length));
  session.facts.append([
    {
      id: factId,
      seq,
      eventId: 'evt-email-1',
      assertedAt: at,
      pharmacy: 'ALPHA',
      interval: interval.value,
      type: 'stock_unavailable',
      medication: 'tirzepatide',
      dose: '5mg',
      note: 'out of tirzepatide 5mg until Wednesday',
    },
  ]);

  const ranked = makeDecision('ORD-TEST-1', at);
  session.decisions.record(ranked);
  session.decisions.attachSend('ORD-TEST-1', { status: 201, at });

  session.decisions.record(
    makeDecision('ORD-TEST-2', secondAt, {
      chosen: 'MANUAL',
      basis: 'manual',
      reason: 'no eligible pharmacy',
      preference: { pharmacy: 'ALPHA', eventId: 'evt-ops-1' },
      override: 'preferred ALPHA is capacity_full',
    }),
  );

  session.sent.mark('ORD-TEST-1', 'ALPHA', at);
  session.sent.mark('ORD-TEST-MANUAL', 'MANUAL', secondAt);

  const samEntry: SamEntry = {
    at: EMAIL_AT_ISO,
    event_id: 'evt-email-2',
    from: 'Jen <team@alpha.test>',
    subject: 'Tirzepatide 25mg?',
    role: 'pharmacy',
    reason: 'unknown_dose:25mg',
    extracted: { intent: 'stock', facts: [] },
    suggested_action: '确认 25mg 是否为正确剂量',
    draft_reply: null,
  };
  session.sam.add(samEntry);

  session.seenEventIds.add('evt-email-1');
  session.seenEventIds.add('evt-email-2');
  session.lastEventAt = secondAt;
  session.degraded = true;
}

// ---------------------------------------------------------------------------
// SnapshotMapper
// ---------------------------------------------------------------------------

describe('SnapshotMapper.toPersisted', () => {
  it('输出 snake_case 快照：时间带 ET 偏移、seq/sent/decisions/sam/last_event_at/degraded 齐全', () => {
    const { calendar, session } = buildSession();
    decorateSession(session);
    const mapper = makeMapper(calendar);

    const persisted = mapper.toPersisted(session);

    assert.equal(persisted.version, 1);
    assert.equal(persisted.week_started_at, STARTED_ISO);
    assert.equal(persisted.pharmacy_api, PHARMACY_API);
    assert.deepEqual(persisted.config, session.config);
    assert.equal(persisted.last_event_at, SECOND_AT_ISO);
    assert.equal(persisted.degraded, true);
    assert.deepEqual(persisted.seen_event_ids, ['evt-email-1', 'evt-email-2']);
    assert.deepEqual(persisted.sam, [session.sam.all()[0]]);

    // 基础 fact 9 条 + 邮件 fact 1 条。
    assert.equal(persisted.facts.length, 10);
    const emailFact = persisted.facts.find((fact) => fact.event_id === 'evt-email-1');
    assert.ok(emailFact, 'email fact must be persisted');
    assert.equal(emailFact.interval.from, EMAIL_AT_ISO);
    assert.equal(emailFact.interval.until, UNTIL_ISO);
    assert.equal(emailFact.asserted_at, EMAIL_AT_ISO);
    // 必须是 ET 偏移（-05:00），不是 UTC 的 Z。
    assert.ok(!emailFact.interval.from.endsWith('Z'));
    assert.ok(emailFact.asserted_at.endsWith('-05:00'));

    // sent_orders：at 用订单事件的 occurred_at，MANUAL 也写。
    assert.deepEqual(persisted.sent_orders['ORD-TEST-1'], {
      pharmacy: 'ALPHA',
      at: EMAIL_AT_ISO,
    });
    assert.deepEqual(persisted.sent_orders['ORD-TEST-MANUAL'], {
      pharmacy: 'MANUAL',
      at: SECOND_AT_ISO,
    });

    // decisions：snake_case，order 已转 snake，sent/preference 都保留。
    const decision: PersistedRoutingDecision = persisted.decisions['ORD-TEST-1']!;
    assert.equal(decision.at, EMAIL_AT_ISO);
    assert.equal(decision.order.order_id, 'ORD-TEST-1');
    assert.equal(decision.order.medication, 'tirzepatide');
    assert.equal(decision.order.dose, '5mg');
    assert.equal(decision.sent?.status, 201);
    assert.equal(decision.sent?.at, EMAIL_AT_ISO);
    assert.equal(persisted.decisions['ORD-TEST-2']!.preference?.event_id, 'evt-ops-1');
    assert.equal(
      persisted.decisions['ORD-TEST-2']!.override,
      'preferred ALPHA is capacity_full',
    );

    assert.deepEqual(persisted.seq, { fact: 10 });
  });
});

describe('SnapshotMapper.fromPersisted', () => {
  it('往返：toPersisted(fromPersisted(p)) 与 p 等价，且语义字段全部重建', () => {
    const { calendar, session } = buildSession();
    decorateSession(session);
    const mapper = makeMapper(calendar);

    const persisted = mapper.toPersisted(session);
    const restored = expectOk(mapper.fromPersisted(persisted));

    // 逐字段往返（这是 canonical form 的定义）。
    assert.deepEqual(mapper.toPersisted(restored), persisted);

    // 关键语义字段。
    assert.ok(restored.startedAt.equals(session.startedAt));
    assert.ok(restored.lastEventAt.equals(session.lastEventAt));
    assert.equal(restored.pharmacyApi, PHARMACY_API);
    assert.equal(restored.degraded, true);
    assert.deepEqual(restored.seenEventIds, new Set(['evt-email-1', 'evt-email-2']));
    assert.deepEqual(restored.validationWindow, { from: '2026-01-05', to: '2026-01-19' });

    assert.equal(restored.registry.all().length, 2);
    assert.equal(restored.catalogue.medications().length, 2);

    // facts：内容与求值行为都一致。
    assert.equal(restored.facts.snapshot().length, 10);
    const resolved = restored.facts.resolve(
      'stock:ALPHA:tirzepatide:5mg',
      parseInstant(EMAIL_AT_ISO),
    );
    assert.equal(resolved?.type, 'stock_unavailable');
    assert.ok(restored.facts.hasEvent('evt-email-1'));

    // sent / decisions / sam。
    assert.equal(restored.sent.has('ORD-TEST-1'), true);
    assert.equal(restored.sent.get('ORD-TEST-1')?.pharmacy, 'ALPHA');
    assert.ok(restored.sent.get('ORD-TEST-1')?.at.equals(parseInstant(EMAIL_AT_ISO)));
    assert.equal(restored.sent.get('ORD-TEST-MANUAL')?.pharmacy, 'MANUAL');
    assert.equal(restored.decisions.all().length, 2);
    assert.equal(restored.decisions.get('ORD-TEST-1')?.sent?.status, 201);
    assert.equal(restored.decisions.get('ORD-TEST-2')?.basis, 'manual');
    assert.equal(restored.decisions.get('ORD-TEST-2')?.sent, null);
    assert.equal(restored.sam.all().length, 1);

    // capacity 不进快照，由 sent_orders 派生（MANUAL 不计数）。
    assert.deepEqual(restored.capacity.snapshot(), [
      { pharmacy: 'ALPHA', date: '2026-01-06', count: 1 },
    ]);

    // ids 从 seq.fact 与 facts id 恢复：下一个 fact 是 0011。
    assert.equal(restored.ids.next('fact'), 'fact_0011');
  });

  it('version !== 1 / 时间不可解析 / config 坏 / fact 序号坏 → Err(persist_failed)', () => {
    const { calendar, session } = buildSession();
    decorateSession(session);
    const mapper = makeMapper(calendar);
    const persisted = mapper.toPersisted(session);

    const badVersion = clone(persisted) as unknown as Record<string, unknown>;
    badVersion.version = 2;
    assert.equal(
      expectErr(mapper.fromPersisted(badVersion as unknown as PersistedState)).code,
      'persist_failed',
    );

    const badTime = clone(persisted);
    badTime.week_started_at = '2026-01-05T06:00:00';
    assert.equal(expectErr(mapper.fromPersisted(badTime)).code, 'persist_failed');

    const badConfig = clone(persisted);
    badConfig.config.pharmacies[0]!.price = { tirzepatide: 120 };
    assert.equal(expectErr(mapper.fromPersisted(badConfig)).code, 'persist_failed');

    const badFactInterval = clone(persisted);
    badFactInterval.facts[0]!.interval = {
      from: '2026-01-10T00:00:00-05:00',
      until: '2026-01-09T00:00:00-05:00',
    };
    assert.equal(expectErr(mapper.fromPersisted(badFactInterval)).code, 'persist_failed');

    const badFactId = clone(persisted);
    badFactId.facts[0]!.id = 'not-a-fact-id';
    assert.equal(expectErr(mapper.fromPersisted(badFactId)).code, 'persist_failed');

    const badOrderId = clone(persisted);
    badOrderId.decisions['ORD-TEST-1'] = {
      ...badOrderId.decisions['ORD-TEST-1']!,
      order_id: 'ORD-MISMATCH',
    };
    assert.equal(expectErr(mapper.fromPersisted(badOrderId)).code, 'persist_failed');
  });

  it('validationWindowOf：周一起 14 天闭区间（周日仍回到本周一）', () => {
    const calendar = new EtCalendar();
    const monday = validationWindowOf(calendar, parseInstant(STARTED_ISO));
    assert.deepEqual(monday, { from: '2026-01-05', to: '2026-01-19' });
    // 周日 2026-01-11 → 仍是 01-05 的窗口。
    const sunday = validationWindowOf(calendar, parseInstant('2026-01-11T23:00:00-05:00'));
    assert.deepEqual(sunday, { from: '2026-01-05', to: '2026-01-19' });
  });
});

// ---------------------------------------------------------------------------
// DecisionLog / SentOrderLog
// ---------------------------------------------------------------------------

describe('DecisionLog', () => {
  it('record 是同 order_id 的 upsert；attachSend 补 sent；snapshot/restore 往返', () => {
    const log = new DecisionLog();
    const at = parseInstant(EMAIL_AT_ISO);

    assert.equal(log.get('ORD-TEST-1'), undefined);
    log.record(makeDecision('ORD-TEST-1', at));
    // 同一单重复记录（重投/恢复）：覆盖，不抛、不新增。
    log.record(
      makeDecision('ORD-TEST-1', at, {
        chosen: 'BETA',
        basis: 'ops_preference',
        reason: 'ops preference wins',
      }),
    );
    assert.equal(log.all().length, 1);
    assert.equal(log.get('ORD-TEST-1')?.chosen, 'BETA');
    assert.equal(log.get('ORD-TEST-1')?.basis, 'ops_preference');
    assert.equal(log.get('ORD-TEST-1')?.sent, null);

    log.attachSend('ORD-TEST-1', { status: 201, at });
    assert.equal(log.get('ORD-TEST-1')?.sent?.status, 201);
    assert.ok(log.get('ORD-TEST-1')?.sent?.at.equals(at));

    // 未知 order 的 attachSend 是无害 no-op。
    log.attachSend('ORD-MISSING', { status: 201, at });
    assert.equal(log.all().length, 1);

    const restored = DecisionLog.restore(log.snapshot());
    assert.equal(restored.all().length, 1);
    assert.equal(restored.get('ORD-TEST-1')?.chosen, 'BETA');
    assert.equal(restored.get('ORD-TEST-1')?.sent?.status, 201);
  });
});

describe('SentOrderLog', () => {
  it('mark 幂等（保留第一次记录）；get/entries/snapshot/restore', () => {
    const sent = new SentOrderLog();
    const at = parseInstant(EMAIL_AT_ISO);

    assert.equal(sent.has('ORD-TEST-1'), false);
    sent.mark('ORD-TEST-1', 'ALPHA', at);
    // INV-2：第二次 mark 不覆盖第一次（恢复时 409 也要保留原始药房/时刻）。
    sent.mark('ORD-TEST-1', 'BETA', parseInstant(SECOND_AT_ISO));
    assert.equal(sent.has('ORD-TEST-1'), true);
    assert.equal(sent.get('ORD-TEST-1')?.pharmacy, 'ALPHA');
    assert.ok(sent.get('ORD-TEST-1')!.at.equals(at));
    assert.deepEqual([...sent.entries()].map((entry) => entry.orderId), ['ORD-TEST-1']);

    const restored = SentOrderLog.restore(sent.snapshot());
    assert.equal(restored.get('ORD-TEST-1')?.pharmacy, 'ALPHA');
    assert.ok(restored.get('ORD-TEST-1')!.at.equals(at));

    assert.throws(
      () => SentOrderLog.restore({ 'ORD-BAD': { pharmacy: 'ALPHA', at: 'not-a-time' } }),
      /不可解析/,
    );
  });
});

// ---------------------------------------------------------------------------
// EnvelopeParser
// ---------------------------------------------------------------------------

describe('EnvelopeParser', () => {
  const parser = new EnvelopeParser();

  it('合法 body：信封字段原样返回，headers 一致时无警告', () => {
    const envelope = expectOk(
      parser.parse(
        JSON.stringify({
          event_id: 'evt-order-1',
          type: 'order',
          occurred_at: EMAIL_AT_ISO,
          order: { order_id: 'ORD-1', state: 'TX', medication: 'tirzepatide', dose: '5mg' },
        }),
        { 'x-event-id': 'evt-order-1', 'x-sim-time': EMAIL_AT_ISO },
      ),
    );
    assert.equal(envelope.event_id, 'evt-order-1');
    assert.equal(envelope.type, 'order');
    assert.equal(envelope.occurred_at, EMAIL_AT_ISO);
    assert.deepEqual(envelope.headerWarnings, []);
    // body 保留完整 JSON，`EventProcessor` 可直接当 OrderEvent 用。
    assert.equal((envelope.body['order'] as Record<string, unknown>)['order_id'], 'ORD-1');
  });

  it('未知 type 不是错误（原样保留，交给 EventProcessor 判 ignored_type）', () => {
    const envelope = expectOk(
      parser.parse(
        JSON.stringify({ event_id: 'evt-x', type: 'mystery.event', occurred_at: STARTED_ISO }),
      ),
    );
    assert.equal(envelope.type, 'mystery.event');
  });

  it('body 缺 event_id/occurred_at 时回退 headers，并留下警告', () => {
    const envelope = expectOk(
      parser.parse(
        JSON.stringify({ type: 'email', email: { from: 'a@b.test', subject: 's', body: 'b' } }),
        { 'x-event-id': 'evt-header-1', 'x-sim-time': EMAIL_AT_ISO },
      ),
    );
    assert.equal(envelope.event_id, 'evt-header-1');
    assert.equal(envelope.occurred_at, EMAIL_AT_ISO);
    assert.equal(envelope.headerWarnings.length >= 1, true);
  });

  it('body 与 headers 不一致时以 body 为准（仅记警告）', () => {
    const envelope = expectOk(
      parser.parse(
        JSON.stringify({ event_id: 'evt-body', type: 'email', occurred_at: EMAIL_AT_ISO }),
        { 'x-event-id': 'evt-header', 'x-sim-time': STARTED_ISO },
      ),
    );
    assert.equal(envelope.event_id, 'evt-body');
    assert.equal(envelope.occurred_at, EMAIL_AT_ISO);
    assert.ok(envelope.headerWarnings.some((warning) => warning.includes('x-event-id')));
    assert.ok(envelope.headerWarnings.some((warning) => warning.includes('x-sim-time')));
  });

  it('坏 JSON / 顶层非对象 → bad_request', () => {
    assert.equal(expectErr(parser.parse('{nope')).code, 'bad_request');
    assert.equal(expectErr(parser.parse('[]')).code, 'bad_request');
    assert.equal(expectErr(parser.parse('null')).code, 'bad_request');
  });

  it('缺 event_id / type / occurred_at → missing_field', () => {
    const noId = expectErr(
      parser.parse(JSON.stringify({ type: 'email', occurred_at: EMAIL_AT_ISO })),
    );
    assert.equal(noId.code, 'missing_field');
    assert.match(noId.detail, /event_id/);

    const noType = expectErr(
      parser.parse(JSON.stringify({ event_id: 'e', occurred_at: EMAIL_AT_ISO })),
    );
    assert.equal(noType.code, 'missing_field');
    assert.match(noType.detail, /type/);

    const noTime = expectErr(parser.parse(JSON.stringify({ event_id: 'e', type: 'email' })));
    assert.equal(noTime.code, 'missing_field');
    assert.match(noTime.detail, /occurred_at/);
  });

  it('occurred_at 无偏移 / 不可解析 → bad_timestamp', () => {
    const noOffset = expectErr(
      parser.parse(
        JSON.stringify({ event_id: 'e', type: 'email', occurred_at: '2026-01-05T06:00:00' }),
      ),
    );
    assert.equal(noOffset.code, 'bad_timestamp');

    const garbage = expectErr(
      parser.parse(JSON.stringify({ event_id: 'e', type: 'email', occurred_at: 'yesterday' })),
    );
    assert.equal(garbage.code, 'bad_timestamp');

    const badHeaderTime = expectErr(
      parser.parse(JSON.stringify({ event_id: 'e', type: 'email' }), {
        'x-sim-time': '2026-01-05',
      }),
    );
    assert.equal(badHeaderTime.code, 'bad_timestamp');
  });
});

// ---------------------------------------------------------------------------
// AuditRecorder
// ---------------------------------------------------------------------------

class CapturingSink implements AuditSink {
  readonly decisions: PersistedRoutingDecision[] = [];
  readonly facts: FactAuditRecord[] = [];
  flushes = 0;
  failFlush = false;

  async decision(record: PersistedRoutingDecision): Promise<void> {
    this.decisions.push(record);
  }

  async fact(record: FactAuditRecord): Promise<void> {
    this.facts.push(record);
  }

  async flush(): Promise<void> {
    this.flushes += 1;
    if (this.failFlush) throw new Error('simulated audit disk failure');
  }
}

function makeCapturingLogger(): { logger: Logger; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const logger: Logger = {
    info: () => {},
    warn: (msg) => {
      warnings.push(msg);
    },
    error: (msg) => {
      errors.push(msg);
    },
    child: () => logger,
  };
  return { logger, errors, warnings };
}

describe('AuditRecorder', () => {
  it('只暂存；flush 才交给 sink；决策转成 snake_case 审计 DTO', async () => {
    const calendar = new EtCalendar();
    const sink = new CapturingSink();
    const { logger } = makeCapturingLogger();
    const recorder = new AuditRecorder({ sink, calendar, logger });

    recorder.record(makeDecision('ORD-TEST-1', parseInstant(EMAIL_AT_ISO)));
    recorder.fact({
      at: EMAIL_AT_ISO,
      event_id: 'evt-email-1',
      from: 'team@alpha.test',
      subject: 'Stock',
      role: 'pharmacy',
      outcome: 'applied',
      facts: [],
    });
    assert.deepEqual(recorder.pending(), { decisions: 1, facts: 1 });
    assert.equal(sink.decisions.length, 0, 'record 不直接写 sink');
    assert.equal(sink.facts.length, 0);

    await recorder.flush();
    assert.equal(sink.decisions.length, 1);
    assert.equal(sink.facts.length, 1);
    assert.equal(sink.flushes, 1);
    assert.deepEqual(recorder.pending(), { decisions: 0, facts: 0 });

    const written = sink.decisions[0]!;
    assert.equal(written.order_id, 'ORD-TEST-1');
    assert.equal(written.at, EMAIL_AT_ISO);
    assert.equal(written.order.order_id, 'ORD-TEST-1');
    assert.equal(written.sent, null);
  });

  it('flush 失败只 logger.error，不抛、不回滚状态', async () => {
    const calendar = new EtCalendar();
    const sink = new CapturingSink();
    sink.failFlush = true;
    const { logger, errors } = makeCapturingLogger();
    const recorder = new AuditRecorder({ sink, calendar, logger });

    recorder.record(makeDecision('ORD-TEST-1', parseInstant(EMAIL_AT_ISO)));
    await recorder.flush(); // 不应抛
    assert.equal(sink.flushes, 1);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /audit flush/);
    // 已交出去的记录不再重试（审计不是真值）。
    assert.deepEqual(recorder.pending(), { decisions: 0, facts: 0 });
  });
});

// ---------------------------------------------------------------------------
// SessionFactory / StartSimulationUseCase
// ---------------------------------------------------------------------------

describe('SessionFactory', () => {
  it('从 started 建会话：基础 fact、窗口、lastEventAt 初值', () => {
    const { calendar, session } = buildSession();
    assert.equal(session.pharmacyApi, PHARMACY_API);
    assert.ok(session.startedAt.equals(parseInstant(STARTED_ISO)));
    assert.ok(session.lastEventAt.equals(session.startedAt));
    assert.equal(session.degraded, false);
    assert.deepEqual(session.validationWindow, { from: '2026-01-05', to: '2026-01-19' });
    assert.equal(session.registry.all().length, 2);
    // ALPHA 5 + BETA 4 = 9 条基础 fact。
    assert.equal(session.facts.snapshot().length, 9);
    assert.equal(session.ids.snapshot().fact, 9);
    assert.equal(session.capacity.snapshot().length, 0);
    assert.equal(session.sam.all().length, 0);
    assert.equal(session.seenEventIds.size, 0);
    assert.equal(calendar.dateOf(session.startedAt), '2026-01-05');
  });

  it('config 形状非法 / 缺 pharmacyApi → bad_started_config，不抛', () => {
    const calendar = new EtCalendar();
    const ids = new IdSequence();
    const factory = new SessionFactory({ calendar, ids });

    const missingApi = expectErr(factory.create(makeStartedEvent({ pharmacyApi: '' })));
    assert.equal(missingApi.code, 'bad_started_config');

    const brokenConfig = syntheticConfig();
    brokenConfig.pharmacies[0]!.price = { tirzepatide: 120 };
    const badConfig = expectErr(factory.create(makeStartedEvent({ config: brokenConfig })));
    assert.equal(badConfig.code, 'bad_started_config');
  });
});

class FakeGateway implements SimulationGateway {
  baseUrl: string | undefined;

  setBaseUrl(url: string): void {
    this.baseUrl = url;
  }

  async send(
    _req: { orderId: OrderId; pharmacy: PharmacyId | 'MANUAL'; reason?: string },
    _opts: { timeoutMs: number },
  ): Promise<SendOutcome> {
    return { kind: 'timeout' };
  }
}

interface StartFixture {
  calendar: EtCalendar;
  ids: IdSequence;
  stateStore: MemoryStateStore;
  inflight: MemoryInflightJournal;
  holder: SessionHolder;
  gateway: FakeGateway;
  mapper: SnapshotMapper;
  useCase: StartSimulationUseCase;
  retryCleared: () => number;
}

function makeStartFixture(overrides: { clearRetryQueue?: () => void } = {}): StartFixture {
  const calendar = new EtCalendar();
  calendar.selfTest();
  const ids = new IdSequence();
  const stateStore = new MemoryStateStore();
  const inflight = new MemoryInflightJournal();
  const holder = new SessionHolder();
  const gateway = new FakeGateway();
  const mapper = makeMapper(calendar);
  let clears = 0;
  const retryCleared = (): number => clears;
  const clearRetryQueue =
    overrides.clearRetryQueue ??
    (() => {
      clears += 1;
    });
  const useCase = new StartSimulationUseCase({
    calendar,
    ids,
    stateStore,
    inflight,
    holder,
    mapper,
    gateway,
    clearRetryQueue,
    logger: noopLogger,
  });
  return { calendar, ids, stateStore, inflight, holder, gateway, mapper, useCase, retryCleared };
}

describe('StartSimulationUseCase', () => {
  it('建会话 + 注入 pharmacyApi + 清 inflight/retry + ids.reset + 一次原子 save', async () => {
    const fixture = makeStartFixture();
    // 模拟「上一周残留」：ids 已推进、WAL 里有旧单。
    fixture.ids.next('fact');
    fixture.ids.next('fact');
    await fixture.inflight.begin({
      orderId: 'ORD-OLD-1',
      pharmacy: 'ALPHA',
      at: STARTED_ISO,
      decisionReason: null,
      startedAtRealClock: '2026-01-05T11:00:00.000Z',
    });

    const result = await fixture.useCase.execute(makeStartedEvent());
    expectOk(result);

    assert.equal(fixture.gateway.baseUrl, PHARMACY_API, 'started 必须把 pharmacyApi 注入网关');
    assert.equal(fixture.inflight.size, 0, 'inflight 必须清空');
    assert.equal(fixture.retryCleared(), 1, 'retryQueue.clear 必须被调用');
    assert.equal(fixture.holder.hasSession(), true);

    const session = fixture.holder.requireSession();
    assert.equal(session.facts.snapshot().length, 9);
    assert.equal(session.ids.snapshot().fact, 9, 'ids 必须先 reset 再展开基础 fact');
    assert.ok(session.lastEventAt.equals(session.startedAt));
    assert.deepEqual(session.validationWindow, { from: '2026-01-05', to: '2026-01-19' });
    assert.equal(session.degraded, false);

    const saved = fixture.stateStore.snapshot();
    assert.ok(saved !== null, 'started 必须写一份快照');
    assert.equal(saved.version, 1);
    assert.equal(saved.week_started_at, STARTED_ISO);
    assert.equal(saved.pharmacy_api, PHARMACY_API);
    assert.equal(saved.facts.length, 9);
    assert.deepEqual(saved.seq, { fact: 9 });
    assert.equal(saved.last_event_at, STARTED_ISO);
    assert.equal(saved.degraded, false);
    assert.equal(fixture.stateStore.saves, 1, '只 save 一次，不能 clear-then-save');
  });

  it('config 不可用 → Err(bad_started_config)、无会话、不写盘、不注入网关', async () => {
    const fixture = makeStartFixture();
    // 先装一个「旧周」会话，失败时必须被清掉（不能继续用旧周的路由状态）。
    const oldFactory = new SessionFactory({ calendar: fixture.calendar, ids: fixture.ids });
    fixture.holder.replace(expectOk(oldFactory.create(makeStartedEvent())));

    const brokenConfig = syntheticConfig();
    brokenConfig.pharmacies[0]!.price = { tirzepatide: 120 };

    const result = await fixture.useCase.execute(makeStartedEvent({ config: brokenConfig }));
    const error = expectErr(result);
    assert.equal(error.code, 'bad_started_config');
    assert.equal(fixture.holder.hasSession(), false);
    assert.equal(fixture.stateStore.snapshot(), null);
    assert.equal(fixture.gateway.baseUrl, undefined);
  });

  it('快照写盘失败 → degraded=true，但会话仍安装（EventProcessor 随后会重试写盘）', async () => {
    const fixture = makeStartFixture();
    fixture.stateStore.failNextSave();

    const result = await fixture.useCase.execute(makeStartedEvent());
    expectOk(result);
    assert.equal(fixture.holder.hasSession(), true);
    assert.equal(fixture.holder.requireSession().degraded, true);
    assert.equal(fixture.stateStore.snapshot(), null);
    assert.equal(fixture.stateStore.saves, 0);
  });

  it('inflight.clear / retryQueue.clear 抛错不阻断新周（清道夫失败只记日志）', async () => {
    const fixture = makeStartFixture();
    const brokenInflight: InflightJournal = {
      begin: async () => {},
      commit: async () => {},
      load: async () => [],
      clear: async () => {
        throw new Error('WAL clear broke');
      },
    };
    const { logger, errors } = makeCapturingLogger();
    const useCase = new StartSimulationUseCase({
      calendar: fixture.calendar,
      ids: fixture.ids,
      stateStore: fixture.stateStore,
      inflight: brokenInflight,
      holder: fixture.holder,
      mapper: fixture.mapper,
      gateway: fixture.gateway,
      clearRetryQueue: () => {
        throw new Error('retry queue broke');
      },
      logger,
    });

    const result = await useCase.execute(makeStartedEvent());
    expectOk(result);
    assert.equal(fixture.holder.hasSession(), true);
    assert.equal(errors.length >= 2, true);
  });

  it('gateway 没有 setBaseUrl（测试替身）时只 warn，不影响建会话', async () => {
    const fixture = makeStartFixture();
    const sendOnlyGateway: PharmacyGateway = {
      send: async () => ({ kind: 'timeout' }) as SendOutcome,
    };
    const { logger, warnings } = makeCapturingLogger();
    const useCase = new StartSimulationUseCase({
      calendar: fixture.calendar,
      ids: fixture.ids,
      stateStore: fixture.stateStore,
      inflight: fixture.inflight,
      holder: fixture.holder,
      mapper: fixture.mapper,
      gateway: sendOnlyGateway,
      clearRetryQueue: () => {},
      logger,
    });

    const result = await useCase.execute(makeStartedEvent());
    expectOk(result);
    assert.equal(fixture.holder.hasSession(), true);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /setBaseUrl/);
  });
});

// ---------------------------------------------------------------------------
// SessionHolder
// ---------------------------------------------------------------------------

describe('SessionHolder', () => {
  it('current/hasSession/requireSession/replace/clear', () => {
    const { session } = buildSession();
    const holder = new SessionHolder();
    assert.equal(holder.current(), null);
    assert.equal(holder.hasSession(), false);
    assert.throws(() => holder.requireSession(), /no_session/);

    holder.replace(session);
    assert.equal(holder.hasSession(), true);
    assert.equal(holder.requireSession(), session);

    holder.clear();
    assert.equal(holder.hasSession(), false);
    assert.equal(holder.current(), null);
  });
});
