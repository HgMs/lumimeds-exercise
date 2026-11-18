/**
 * interfaces/http 的单测（task-10；`ARCHITECTURE.md` §5.11、§12.2；
 * `DATA-CONTRACTS.md` §1.5、§5）。
 *
 * 覆盖：
 * - `Router`：字面量匹配、方法不匹配、`/orders/:id` 参数提取与解码、未命中返回 null、
 *   重复注册/非法路径抛错；
 * - `ErrorMapper`：§1.5 的错误码 → 400/404/413/500 映射与响应体形状；
 * - 5 个 handler 的行为（webhook 的 `{ok:true}` / 失败码、/orders/:id 的 200/404、
 *   /sam 与 /state 的无会话 200、/health 的计数形状）；
 * - `HttpServer`：真实 socket 上的 200/404/413/500、未捕获异常 → logger.error、
 *   每请求一行耗时日志、`listen()` 返回实际端口、`close()` 幂等。
 *
 * 数据全部是合成值（与任何一周无关），不出现 week A 字面量。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EtCalendar } from '../../src/kernel/time/et-calendar.ts';
import { Instant } from '../../src/kernel/time/instant.ts';
import { noopLogger } from '../../src/kernel/logger.ts';
import type { Logger } from '../../src/kernel/logger.ts';
import type { BeliefResolver } from '../../src/domain/belief/belief-resolver.ts';
import type { PharmacyView } from '../../src/domain/belief/pharmacy-view.ts';
import type { RoutingDecision } from '../../src/domain/routing/decision.ts';
import type { SessionHolder } from '../../src/application/session/session-holder.ts';
import type { SimulationSession } from '../../src/application/session/simulation-session.ts';
import { ErrorMapper } from '../../src/interfaces/http/error-mapper.ts';
import {
  DEFAULT_BODY_LIMIT_BYTES,
  HttpServer,
} from '../../src/interfaces/http/server.ts';
import { response } from '../../src/interfaces/http/request-context.ts';
import type { RequestContext } from '../../src/interfaces/http/request-context.ts';
import { Router } from '../../src/interfaces/http/router.ts';
import { HealthHandler } from '../../src/interfaces/http/handlers/health-handler.ts';
import { OrderDecisionHandler } from '../../src/interfaces/http/handlers/order-decision-handler.ts';
import { SamHandler } from '../../src/interfaces/http/handlers/sam-handler.ts';
import { StateHandler } from '../../src/interfaces/http/handlers/state-handler.ts';
import {
  WebhookHandler,
  type WebhookProcessor,
} from '../../src/interfaces/http/handlers/webhook-handler.ts';

// ---------------------------------------------------------------------------
// 合成夹具
// ---------------------------------------------------------------------------

/** 2026-05-12（周二，EDT -04:00）——与 week A 无关。 */
const AT_ISO = '2026-05-12T08:00:00-04:00';

const calendar = new EtCalendar();

function instantOf(iso = AT_ISO): Instant {
  const parsed = Instant.parse(iso);
  assert.ok(parsed.ok, `fixture instant must parse: ${iso}`);
  return parsed.value;
}

/** 最小 `RequestContext`（handler 单测用）。 */
function ctxOf(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    method: 'POST',
    path: '/webhooks',
    params: {},
    headers: {},
    body: '{}',
    ...overrides,
  };
}

/** 捕获日志的 logger（断言「每请求一行耗时」「异常必记 error」）。 */
interface CapturedLog {
  readonly level: 'info' | 'warn' | 'error';
  readonly msg: string;
  readonly fields: Record<string, unknown>;
}

function captureLogger(): { logger: Logger; entries: CapturedLog[] } {
  const entries: CapturedLog[] = [];
  const build = (base: Record<string, unknown>): Logger => ({
    info: (msg, fields) => entries.push({ level: 'info', msg, fields: { ...base, ...fields } }),
    warn: (msg, fields) => entries.push({ level: 'warn', msg, fields: { ...base, ...fields } }),
    error: (msg, fields) => entries.push({ level: 'error', msg, fields: { ...base, ...fields } }),
    child: (fields) => build({ ...base, ...fields }),
  });
  return { logger: build({}), entries };
}

/** 用最小假会话伪装 `SessionHolder`（只实现被测 handler 真正读取的字段）。 */
function holderOf(session: SimulationSession | null): SessionHolder {
  return {
    hasSession: () => session !== null,
    current: () => session,
    requireSession: () => {
      if (session === null) throw new Error('no session');
      return session;
    },
    replace: () => undefined,
    clear: () => undefined,
  } as unknown as SessionHolder;
}

/** `/health` 用的假会话：2 个事件、1 条已发单、1 条 Sam、degraded=true。 */
function fakeSession(): SimulationSession {
  return {
    seenEventIds: new Set(['evt-1', 'evt-2']),
    sent: {
      entries: () => [{ orderId: 'ORD-SYNTH-1', pharmacy: 'ALPHA', at: instantOf() }],
    },
    sam: {
      all: () => [{ event_id: 'evt-mail-1' }],
    },
    degraded: true,
    lastEventAt: instantOf(),
    registry: {
      all: () => [
        { id: 'ALPHA', name: 'Alpha Rx' },
        { id: 'BETA', name: 'Beta Pharmacy' },
      ],
    },
    facts: {},
    capacity: {},
  } as unknown as SimulationSession;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

describe('Router', () => {
  it('匹配字面量路径与方法', () => {
    const router = new Router();
    const handler = async (): Promise<ReturnType<typeof response>> => response(200, { ok: true });
    router.post('/webhooks', handler);
    router.get('/health', handler);

    const matched = router.match('POST', '/webhooks');
    assert.ok(matched !== null);
    assert.equal(matched.handler, handler);
    assert.deepEqual(matched.params, {});

    // 方法与路径大小写：方法不敏感，路径敏感。
    assert.ok(router.match('post', '/webhooks') !== null);
    assert.equal(router.match('GET', '/webhooks'), null);
    assert.equal(router.match('POST', '/Webhooks'), null);
  });

  it('/orders/:id 提取并解码参数；容忍末尾斜杠', () => {
    const router = new Router();
    router.get('/orders/:id', async () => response(200, {}));

    const matched = router.match('GET', '/orders/ORD-SYNTH-42');
    assert.ok(matched !== null);
    assert.deepEqual(matched.params, { id: 'ORD-SYNTH-42' });

    const encoded = router.match('GET', '/orders/ORD%2FSYNTH');
    assert.ok(encoded !== null);
    assert.deepEqual(encoded.params, { id: 'ORD/SYNTH' });

    const trailing = router.match('GET', '/orders/ORD-SYNTH-42/');
    assert.ok(trailing !== null);
    assert.deepEqual(trailing.params, { id: 'ORD-SYNTH-42' });
  });

  it('未命中返回 null：段数不符、空参数、多余段、根路径', () => {
    const router = new Router();
    router.get('/orders/:id', async () => response(200, {}));
    router.get('/sam', async () => response(200, {}));

    assert.equal(router.match('GET', '/orders'), null);
    assert.equal(router.match('GET', '/orders/'), null);
    assert.equal(router.match('GET', '/orders/a/b'), null);
    assert.equal(router.match('GET', '/sam/extra'), null);
    assert.equal(router.match('GET', '/'), null);
  });

  it('重复注册与非法路径立即抛错（装配期发现 bug）', () => {
    const router = new Router();
    const handler = async (): Promise<ReturnType<typeof response>> => response(200, {});
    router.get('/health', handler);
    assert.throws(() => router.get('/health', handler), /duplicate route/);
    assert.throws(() => router.post('health', handler), /must start with/);
  });
});

// ---------------------------------------------------------------------------
// ErrorMapper
// ---------------------------------------------------------------------------

describe('ErrorMapper', () => {
  it('按 DATA-CONTRACTS §1.5 映射错误码', () => {
    const mapper = new ErrorMapper();
    assert.equal(mapper.statusForCode('bad_request'), 400);
    assert.equal(mapper.statusForCode('missing_field'), 400);
    assert.equal(mapper.statusForCode('bad_timestamp'), 400);
    assert.equal(mapper.statusForCode('persist_failed'), 500);
    assert.equal(mapper.statusForCode('bad_started_config'), 500);
    assert.equal(mapper.statusForCode('gateway_failed'), 500);
    assert.equal(mapper.statusForCode('not_found'), 404);
    // 未知码按服务端失败处理，不猜成 4xx。
    assert.equal(mapper.statusForCode('something_unregistered'), 500);
  });

  it('IngestOutcome → 状态码：未知 type 与重复事件是 200，no_session/persist_failed 是 500', () => {
    const mapper = new ErrorMapper();
    for (const outcome of [
      'started',
      'email_applied',
      'email_no_change',
      'email_rejected',
      'order_sent',
      'order_manual',
      'order_deferred',
      'duplicate',
      'ignored_type',
    ]) {
      assert.equal(mapper.statusForOutcome(outcome), 200, outcome);
    }
    assert.equal(mapper.statusForOutcome('bad_request'), 400);
    assert.equal(mapper.statusForOutcome('no_session'), 500);
    assert.equal(mapper.statusForOutcome('persist_failed'), 500);
    assert.equal(mapper.statusForOutcome('internal_error'), 500);
  });

  it('fromIngestError 恒 400 且带 code/detail', () => {
    const mapper = new ErrorMapper();
    const spec = mapper.fromIngestError({ code: 'bad_request', detail: 'body 不是合法 JSON' });
    assert.equal(spec.status, 400);
    assert.deepEqual(spec.json, {
      ok: false,
      error: { code: 'bad_request', message: 'body 不是合法 JSON' },
    });
  });

  it('fromCode / fromThrown / notFound / payloadTooLarge 的形状', () => {
    const mapper = new ErrorMapper();

    const noSession = mapper.fromCode('no_session', 'no active session');
    assert.equal(noSession.status, 500);

    const thrown = mapper.fromThrown(new Error('boom'));
    assert.equal(thrown.status, 500);
    assert.equal((thrown.json as { ok: boolean }).ok, false);
    assert.equal(
      ((thrown.json as { error: { code: string } }).error as { code: string }).code,
      'internal_error',
    );

    const notFound = mapper.notFound('GET', '/nope');
    assert.equal(notFound.status, 404);
    assert.equal(
      (notFound.json as { error: { code: string } }).error.code,
      'not_found',
    );

    const tooLarge = mapper.payloadTooLarge(DEFAULT_BODY_LIMIT_BYTES);
    assert.equal(tooLarge.status, 413);
    assert.equal(
      (tooLarge.json as { error: { limit_bytes: number } }).error.limit_bytes,
      DEFAULT_BODY_LIMIT_BYTES,
    );
  });
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

describe('WebhookHandler', () => {
  it('2xx → 固定 {"ok":true}，并把 body/headers 原样交给 processor', async () => {
    const calls: Array<{ body: string; headers: Record<string, string | undefined> }> = [];
    const processor: WebhookProcessor = {
      process: async (input) => {
        calls.push(input);
        return { status: 200, outcome: 'email_applied' };
      },
    };
    const handler = new WebhookHandler({ processor });
    const spec = await handler.handle(
      ctxOf({ headers: { 'x-event-id': 'evt-synth-1' }, body: '{"a":1}' }),
    );

    assert.equal(spec.status, 200);
    assert.deepEqual(spec.json, { ok: true });
    assert.deepEqual(calls, [{ body: '{"a":1}', headers: { 'x-event-id': 'evt-synth-1' } }]);
  });

  it('失败结果走 ErrorMapper：no_session → 500，bad_request → 400', async () => {
    const noSession = new WebhookHandler({
      processor: { process: async () => ({ status: 500, outcome: 'no_session' }) },
    });
    const spec = await noSession.handle(ctxOf());
    assert.equal(spec.status, 500);
    assert.equal((spec.json as { error: { code: string } }).error.code, 'no_session');

    const bad = new WebhookHandler({
      processor: { process: async () => ({ status: 400, outcome: 'bad_request' }) },
    });
    const badSpec = await bad.handle(ctxOf());
    assert.equal(badSpec.status, 400);
    assert.equal((badSpec.json as { error: { code: string } }).error.code, 'bad_request');
  });
});

describe('HealthHandler', () => {
  it('无会话 → 200，计数为 0，pending_sends 取真实队列', async () => {
    const handler = new HealthHandler({
      holder: holderOf(null),
      retryQueue: { pending: () => 3 },
    });
    const spec = await handler.handle(ctxOf({ method: 'GET', path: '/health' }));
    assert.equal(spec.status, 200);
    assert.deepEqual(spec.json, {
      ok: true,
      events: 0,
      orders_sent: 0,
      sam: 0,
      pending_sends: 3,
      degraded: false,
    });
  });

  it('有会话 → 计数来自会话，degraded 透传', async () => {
    const handler = new HealthHandler({
      holder: holderOf(fakeSession()),
      retryQueue: { pending: () => 1 },
    });
    const spec = await handler.handle(ctxOf({ method: 'GET', path: '/health' }));
    assert.deepEqual(spec.json, {
      ok: true,
      events: 2,
      orders_sent: 1,
      sam: 1,
      pending_sends: 1,
      degraded: true,
    });
  });
});

describe('OrderDecisionHandler', () => {
  const decision: RoutingDecision = {
    orderId: 'ORD-SYNTH-7',
    at: instantOf(),
    order: { orderId: 'ORD-SYNTH-7', state: 'NJ', medication: 'tirzepatide', dose: '5mg' },
    chosen: 'MANUAL',
    basis: 'manual',
    reason: 'no safe candidate',
    candidates: [],
    preference: null,
    override: null,
    sent: null,
  };

  it('命中 → 200，返回与快照/审计同款的 snake_case 决策', async () => {
    const session = {
      decisions: { get: (id: string) => (id === 'ORD-SYNTH-7' ? decision : undefined) },
    } as unknown as SimulationSession;
    const handler = new OrderDecisionHandler({ holder: holderOf(session), calendar });
    const spec = await handler.handle(
      ctxOf({ method: 'GET', path: '/orders/ORD-SYNTH-7', params: { id: 'ORD-SYNTH-7' } }),
    );

    assert.equal(spec.status, 200);
    const body = spec.json as Record<string, unknown>;
    assert.equal(body['order_id'], 'ORD-SYNTH-7');
    assert.equal(body['at'], AT_ISO);
    assert.equal(body['basis'], 'manual');
    assert.deepEqual(body['order'], {
      order_id: 'ORD-SYNTH-7',
      state: 'NJ',
      medication: 'tirzepatide',
      dose: '5mg',
    });
  });

  it('查不到 / 无会话 → 404', async () => {
    const handler = new OrderDecisionHandler({ holder: holderOf(null), calendar });
    const noSession = await handler.handle(
      ctxOf({ method: 'GET', path: '/orders/ORD-SYNTH-7', params: { id: 'ORD-SYNTH-7' } }),
    );
    assert.equal(noSession.status, 404);
    assert.equal((noSession.json as { error: { code: string } }).error.code, 'not_found');

    const withSession = new OrderDecisionHandler({
      holder: holderOf({
        decisions: { get: () => undefined },
      } as unknown as SimulationSession),
      calendar,
    });
    const missing = await withSession.handle(
      ctxOf({ method: 'GET', path: '/orders/ORD-SYNTH-7', params: { id: 'ORD-SYNTH-7' } }),
    );
    assert.equal(missing.status, 404);
  });
});

describe('SamHandler', () => {
  it('无会话 → 200 []', async () => {
    const handler = new SamHandler({ holder: holderOf(null) });
    const spec = await handler.handle(ctxOf({ method: 'GET', path: '/sam' }));
    assert.equal(spec.status, 200);
    assert.deepEqual(spec.json, []);
  });

  it('有会话 → 原样返回 sam.all()', async () => {
    const handler = new SamHandler({ holder: holderOf(fakeSession()) });
    const spec = await handler.handle(ctxOf({ method: 'GET', path: '/sam' }));
    assert.deepEqual(spec.json, [{ event_id: 'evt-mail-1' }]);
  });
});

describe('StateHandler', () => {
  const views: PharmacyView[] = [
    {
      id: 'ALPHA',
      name: 'Alpha Rx',
      openNow: true,
      shipsInDays: 1,
      capacityToday: 3,
      capacityUsedToday: 0,
      capacityLeft: 3,
      price: { tirzepatide: 120 },
      blockedStates: [],
      stock: { tirzepatide: ['5mg'] },
    },
  ];

  it('无会话 → 200 []', async () => {
    const resolver = { view: () => views[0] } as unknown as BeliefResolver;
    const handler = new StateHandler({ holder: holderOf(null), resolver });
    const spec = await handler.handle(ctxOf({ method: 'GET', path: '/state' }));
    assert.equal(spec.status, 200);
    assert.deepEqual(spec.json, []);
  });

  it('有会话 → 在 lastEventAt 对每家药房求值', async () => {
    const session = fakeSession();
    const seen: Array<{ id: string; at: Instant }> = [];
    const resolver = {
      view: (base: { id: string }, at: Instant): PharmacyView => {
        seen.push({ id: base.id, at });
        return { ...views[0], id: base.id };
      },
    } as unknown as BeliefResolver;
    const handler = new StateHandler({ holder: holderOf(session), resolver });
    const spec = await handler.handle(ctxOf({ method: 'GET', path: '/state' }));

    assert.equal(spec.status, 200);
    const body = spec.json as PharmacyView[];
    assert.equal(body.length, 2);
    assert.deepEqual(
      body.map((view) => view.id),
      ['ALPHA', 'BETA'],
    );
    // 求值时刻必须是会话的 lastEventAt（事件时间），不是任何进程时钟。
    assert.equal(seen.length, 2);
    assert.ok(seen.every((entry) => entry.at.equals(session.lastEventAt)));
  });
});

// ---------------------------------------------------------------------------
// HttpServer（真实 socket）
// ---------------------------------------------------------------------------

/** 从捕获的日志里按级别过滤（只用于断言，不改变捕获数组）。 */
function logsOf(entries: CapturedLog[], level: 'info' | 'warn' | 'error'): CapturedLog[] {
  return entries.filter((entry) => entry.level === level);
}

async function fetchJson(
  port: number,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

describe('HttpServer', () => {
  it('默认 body 上限是 1 MiB（§1.5）', () => {
    assert.equal(DEFAULT_BODY_LIMIT_BYTES, 1024 * 1024);
  });

  it('GET 路由 200、每请求一行耗时日志', async (t) => {
    const router = new Router();
    const { logger, entries } = captureLogger();
    const server = new HttpServer({ router, port: 0, host: '127.0.0.1', logger });
    t.after(() => server.close());

    router.get('/health', async () => response(200, { ok: true, events: 0 }));
    const port = await server.listen();
    assert.ok(port > 0, 'listen() must return the kernel-assigned port');

    const result = await fetchJson(port, '/health');
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { ok: true, events: 0 });

    // 每请求一行日志：带 method/path/status/duration_ms。
    const requestLogs = logsOf(entries, 'info').filter((entry) => entry.msg === 'http request');
    assert.equal(requestLogs.length, 1);
    assert.equal(requestLogs[0]?.fields['method'], 'GET');
    assert.equal(requestLogs[0]?.fields['path'], '/health');
    assert.equal(requestLogs[0]?.fields['status'], 200);
    assert.equal(typeof requestLogs[0]?.fields['duration_ms'], 'number');
  });

  it('路由未命中 → 404（ErrorMapper 统一处理）', async (t) => {
    const server = new HttpServer({ router: new Router(), port: 0, host: '127.0.0.1', logger: noopLogger });
    t.after(() => server.close());
    const port = await server.listen();

    const result = await fetchJson(port, '/nope');
    assert.equal(result.status, 404);
    assert.equal((result.body as { error: { code: string } }).error.code, 'not_found');
  });

  it('handler 返回 400 原样透传（JSON 解析失败的语义在 parser/ErrorMapper）', async (t) => {
    const router = new Router();
    router.post('/webhooks', async () =>
      response(400, { ok: false, error: { code: 'bad_request', message: 'body 不是合法 JSON' } }),
    );
    const server = new HttpServer({ router, port: 0, host: '127.0.0.1', logger: noopLogger });
    t.after(() => server.close());
    const port = await server.listen();

    const result = await fetchJson(port, '/webhooks', { method: 'POST', body: 'not json' });
    assert.equal(result.status, 400);
    assert.equal((result.body as { error: { code: string } }).error.code, 'bad_request');
  });

  it('未捕获异常 → 500 + logger.error', async (t) => {
    const router = new Router();
    router.get('/boom', async () => {
      throw new Error('kaboom');
    });
    const { logger, entries } = captureLogger();
    const server = new HttpServer({ router, port: 0, host: '127.0.0.1', logger });
    t.after(() => server.close());
    const port = await server.listen();

    const result = await fetchJson(port, '/boom');
    assert.equal(result.status, 500);
    assert.equal((result.body as { error: { code: string } }).error.code, 'internal_error');
    const errors = logsOf(entries, 'error');
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.msg, 'http request handler threw');
  });

  it('body 超限 → 413，不进入 handler', async (t) => {
    const router = new Router();
    let handled = 0;
    router.post('/webhooks', async () => {
      handled += 1;
      return response(200, { ok: true });
    });
    const { logger } = captureLogger();
    const server = new HttpServer({
      router,
      port: 0,
      host: '127.0.0.1',
      logger,
      bodyLimitBytes: 16,
    });
    t.after(() => server.close());
    const port = await server.listen();

    const result = await fetchJson(port, '/webhooks', {
      method: 'POST',
      body: 'x'.repeat(32),
    });
    assert.equal(result.status, 413);
    assert.equal(handled, 0, 'handler must not see an oversized body');
    assert.equal(
      (result.body as { error: { code: string } }).error.code,
      'payload_too_large',
    );
  });

  it('close() 幂等；未监听的实例也能安全 close', async () => {
    const server = new HttpServer({ router: new Router(), port: 0, logger: noopLogger });
    await server.close();
    await server.close();

    const listening = new HttpServer({
      router: new Router(),
      port: 0,
      host: '127.0.0.1',
      logger: noopLogger,
    });
    await listening.listen();
    await listening.close();
    await listening.close();
    assert.equal(listening.port, undefined);
  });
});
