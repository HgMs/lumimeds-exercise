/**
 * 整周回放验收（task-11；`ARCHITECTURE.md` §12.3/§12.4；`REQUIREMENTS` §8）。
 *
 * 用**真实** `HttpServer`（端口 0）+ 真实 `EventProcessor` 逐事件 `POST /webhooks`，
 * 药房与 LLM 用 harness 替身（`RecordingGateway` / `ScriptedExtractor`）：
 *
 * 1. 52 个事件全部 2xx；
 * 2. 38 个唯一订单各发一次（`order_id` 去重），网关收到的订单集合与 expected fixture
 *    完全一致；
 * 3. 每单 `chosen` / `basis` 与 `test/fixtures/week-a.expected.json` 逐条一致
 *    （`ARCHITECTURE` §12.4 唯一真值），MANUAL 5 单；
 * 4. 3 次重投（evt_011/evt_020/evt_032）不改变发单数 / fact 数 / seen；
 * 5. `GET /orders/:id`、`/sam`、`/health`、`/state` 形状正确且与快照一致
 *    （事件数用 seen 唯一数 = 49）；
 * 6. `out/decisions.jsonl` 38 行、`out/facts.jsonl` 10 行（8 applied + 2 rejected）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PersistedState } from '../../src/application/ports/state-store.ts';
import type { PersistedRoutingDecision } from '../../src/domain/routing/decision.ts';
import { RecordingGateway } from '../harness/recording-gateway.ts';
import { replayWeek } from '../harness/replay.ts';
import type { ReplayEventDelivery } from '../harness/replay.ts';
import { ScriptedExtractor } from '../harness/scripted-extractor.ts';
import {
  FAKE_PHARMACY_API,
  WEEK_A_STATS,
  assertWeekAComplete,
  loadExpectedRouting,
  loadWeekEvents,
} from '../harness/week-a.ts';

/** 从投递序列里找重复投递（同一 event_id 的第二次及以后）。 */
function redeliveryIndices(deliveries: readonly ReplayEventDelivery[]): number[] {
  const seen = new Set<string>();
  const duplicates: number[] = [];
  for (const delivery of deliveries) {
    if (seen.has(delivery.eventId)) duplicates.push(delivery.index);
    seen.add(delivery.eventId);
  }
  return duplicates;
}

describe('integration: week A 整周回放（真实 HTTP 栈）', () => {
  it('52 事件全部 2xx、38 单各一次、chosen/basis 与 expected fixture 一致、只读端点形状正确', async (t) => {
    const gateway = new RecordingGateway();
    const extractor = new ScriptedExtractor();
    const week = loadWeekEvents();
    const expected = loadExpectedRouting();
    const run = await replayWeek({ gateway, extractor });
    t.after(async () => {
      await run.cleanup();
    });

    // ---- 1. 52 个事件全部 2xx（真实 HTTP 状态码） ----
    assert.equal(run.deliveries.length, WEEK_A_STATS.events, '必须投递 52 个事件');
    for (const delivery of run.deliveries) {
      assert.equal(
        delivery.status,
        200,
        `${delivery.eventId}(${delivery.type}) 应返回 200，实际 ${delivery.status}`,
      );
      assert.deepEqual(delivery.body, { ok: true }, `${delivery.eventId} 的响应体必须是 {ok:true}`);
    }

    // ---- 2. 3 次重投被识别，且不改变任何副作用 ----
    const duplicates = redeliveryIndices(run.deliveries);
    assert.equal(duplicates.length, WEEK_A_STATS.redeliveries.length, '整周必须恰好 3 次重投');
    assert.deepEqual(
      duplicates.map((index) => run.deliveries[index]?.eventId),
      [...WEEK_A_STATS.redeliveries],
      '重投的 event_id / 出现位置必须与 week 文件一致',
    );
    for (const index of duplicates) {
      const duplicate = run.deliveries[index];
      const previous = run.deliveries[index - 1];
      assert.ok(duplicate !== undefined && previous !== undefined);
      assert.equal(duplicate.redelivery, true);
      assert.equal(duplicate.status, 200);
      assert.deepEqual(
        duplicate.counts,
        previous.counts,
        `${duplicate.eventId}（重投）不得改变发单数/fact 数/seen`,
      );
    }

    // ---- 3. 整周硬不变量 + expected fixture 逐单对照 ----
    const persisted = await assertWeekAComplete(run, expected);
    const state = persisted as PersistedState;

    // 事件数用 seen 唯一数 = 49（不是 52）。
    assert.equal(state.seen_event_ids.length, 49);
    assert.equal(new Set(state.seen_event_ids).size, 49);

    // ---- 4. 发单数 / 次数 / 药房 ----
    assert.equal(gateway.baseUrl, FAKE_PHARMACY_API, 'started 必须把 pharmacyApi 注入网关');
    assert.equal(gateway.calls.length, WEEK_A_STATS.orders, '网关必须恰好收到 38 次发单');
    assert.equal(gateway.orderIds.length, WEEK_A_STATS.orders, '38 个唯一订单');
    assert.equal(gateway.pendingScript, 0, '整周默认路径不应消费任何错误注入脚本');

    // ---- 5. LLM 回放：10 封唯一邮件各一次，且 fixture 没有缺项 ----
    assert.equal(extractor.calls.length, WEEK_A_STATS.extractionCalls, '10 封唯一邮件各调一次 LLM');
    assert.deepEqual(extractor.missingEventIds, [], '整周不得出现缺 fixture 的抽取失败');
    assert.equal(extractor.calls.filter((call) => call.aborted).length, 0);

    // ---- 6. 只读端点形状（事件数 = seen 唯一数 49） ----
    const health = await run.get('/health');
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, {
      ok: true,
      events: 49,
      orders_sent: 38,
      sam: 2,
      pending_sends: 0,
      degraded: false,
    });

    const sam = await run.get('/sam');
    assert.equal(sam.status, 200);
    assert.ok(Array.isArray(sam.body));
    const samEntries = sam.body as Array<Record<string, unknown>>;
    assert.equal(samEntries.length, WEEK_A_STATS.sam);
    assert.deepEqual(
      samEntries.map((entry) => entry['event_id']),
      ['evt_003', 'evt_004'],
      'Sam 里必须是被拒绝的两封邮件',
    );
    for (const entry of samEntries) {
      for (const field of [
        'at',
        'event_id',
        'from',
        'subject',
        'role',
        'reason',
        'extracted',
        'suggested_action',
        'draft_reply',
      ]) {
        assert.ok(field in entry, `Sam 条目缺少字段 ${field}`);
      }
      assert.equal(entry['draft_reply'], null);
      assert.equal(typeof entry['suggested_action'], 'string');
      assert.equal((entry['extracted'] as Record<string, unknown> | null)?.['intent'] !== undefined, true);
    }

    // GET /orders/:id 与 expected fixture + 快照一致（取一单 rank、一单 MANUAL）。
    for (const orderId of ['ORD-1001', 'ORD-1009']) {
      const response = await run.get(`/orders/${orderId}`);
      assert.equal(response.status, 200, `${orderId} 必须有决策记录`);
      const body = response.body as Record<string, unknown>;
      const expectedRoute = expected.orders[orderId];
      assert.ok(expectedRoute !== undefined);
      assert.equal(body['order_id'], orderId);
      assert.equal(body['chosen'], expectedRoute.pharmacy);
      assert.equal(body['basis'], expectedRoute.basis);
      assert.ok(Array.isArray(body['candidates']));
      assert.equal(body['preference'], null);
      assert.equal(body['override'], null);
      const sent = body['sent'] as Record<string, unknown> | null;
      assert.ok(sent !== null, `${orderId} 的 sent 必须已确认`);
      assert.equal(sent['status'], 201);
      // 与快照里的 decision 是同一份转换（逐字段一致）。
      assert.deepEqual(body, state.decisions[orderId] as PersistedRoutingDecision);
    }
    assert.equal((await run.get('/orders/ORD-NOT-EXIST')).status, 404);

    const stateRes = await run.get('/state');
    assert.equal(stateRes.status, 200);
    const views = stateRes.body as Array<Record<string, unknown>>;
    assert.equal(views.length, 5, '5 家药房的派生视图');
    for (const view of views) {
      for (const field of [
        'id',
        'name',
        'openNow',
        'shipsInDays',
        'capacityToday',
        'capacityUsedToday',
        'capacityLeft',
        'price',
        'blockedStates',
        'stock',
      ]) {
        assert.ok(field in view, `/state 的 PharmacyView 缺少字段 ${field}`);
      }
      assert.equal(typeof view['openNow'], 'boolean');
      assert.equal(typeof view['capacityLeft'], 'number');
    }
    assert.deepEqual(
      views.map((view) => view['id']).sort(),
      ['CORVANE', 'ISHBY', 'TANDREL', 'VELMORA', 'WRENFOLD'],
    );

    // ---- 7. 优雅停机后审计文件：decisions 38 行、facts 10 行 ----
    await run.stop();
    const audit = await run.readAudit();
    assert.equal(audit.decisions.length, WEEK_A_STATS.orders, 'decisions.jsonl 必须每单一行（38）');
    assert.deepEqual(
      audit.decisions.map((row) => row.order_id).sort(),
      Object.keys(expected.orders).sort(),
    );
    assert.equal(audit.facts.length, WEEK_A_STATS.emailAuditRows, 'facts.jsonl 必须 10 行');
    const applied = audit.facts.filter((row) => row.outcome === 'applied');
    const rejected = audit.facts.filter((row) => row.outcome === 'rejected');
    const noChange = audit.facts.filter((row) => row.outcome === 'no_change');
    assert.equal(applied.length, 8, '8 封生效邮件');
    assert.equal(rejected.length, 2, '2 封被拒邮件');
    assert.equal(noChange.length, 0);
    assert.deepEqual(
      rejected.map((row) => row.event_id).sort(),
      ['evt_003', 'evt_004'],
    );
    // 每封唯一邮件一行（重投不写）。
    const emailEventIds = [
      ...new Set(
        week.filter((event) => event.type === 'email').map((event) => event.event_id),
      ),
    ];
    assert.equal(emailEventIds.length, 10);
    assert.deepEqual(audit.facts.map((row) => row.event_id).sort(), [...emailEventIds].sort());
  });
});
