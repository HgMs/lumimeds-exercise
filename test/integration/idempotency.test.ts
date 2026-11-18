/**
 * 幂等与重置集成测试（task-11；`REQUIREMENTS` §6、`ARCHITECTURE.md` §11.4）。
 *
 * 覆盖两道闸：
 * 1. **事件级 `seenEventIds`**：同一 `event_id` 重投 → 200（处理器结果是 duplicate），
 *    不发单、不重复 fact、不写盘、不更新 `lastEventAt`；
 * 2. **`simulation.started` 例外**：它在幂等门**之前**无条件重置会话，所以同一周文件
 *    可以重放第二遍（隐藏周/演示重放）：seen 清空、facts/sent/decisions 重建，
 *    第二遍仍是 38 单（而不是把整周判成 duplicate 后 0 单）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PersistedState } from '../../src/application/ports/state-store.ts';
import { RecordingGateway } from '../harness/recording-gateway.ts';
import { replayWeek } from '../harness/replay.ts';
import { ScriptedExtractor } from '../harness/scripted-extractor.ts';
import {
  WEEK_A_STATS,
  assertWeekAComplete,
  loadExpectedRouting,
  loadWeekEvents,
} from '../harness/week-a.ts';

/** week A 的 base fact 数：39 条 stock + 22 条 state_blocked + 5 条 capacity。 */
const BASE_FACT_COUNT = 66;

describe('integration: 幂等与 started 重置', () => {
  it('同一 event_id 重投 → 200 duplicate，不发单、不重复 fact、不写盘、lastEventAt 不回退', async (t) => {
    const gateway = new RecordingGateway();
    const extractor = new ScriptedExtractor();
    const week = loadWeekEvents();
    const run = await replayWeek({ gateway, extractor });
    t.after(async () => {
      await run.cleanup();
    });

    // 先跑完第一遍整周，得到一个完整会话。
    assert.equal(run.deliveries.length, WEEK_A_STATS.events);
    const eventOf = (eventId: string) => {
      const event = week.find((candidate) => candidate.event_id === eventId);
      assert.ok(event !== undefined, `week 文件缺少 ${eventId}`);
      return event;
    };

    const before = {
      counts: run.counts(),
      stateText: await run.readStateText(),
      audit: await run.readAudit(),
      extractorCalls: extractor.calls.length,
      sessionSam: run.session()?.sam.all().length,
      lastEventAt: run.session()?.lastEventAt.toISOString(),
    };
    assert.ok(before.stateText !== null);
    assert.equal(before.counts.sends, 38);
    assert.equal(before.counts.facts, WEEK_A_STATS.facts);
    assert.equal(before.counts.seen, WEEK_A_STATS.uniqueEvents);

    // ---- 订单事件重投：duplicate → 不新增发单 ----
    const duplicateOrder = await run.postEvent(eventOf('evt_005'));
    assert.equal(duplicateOrder.status, 200);
    assert.deepEqual(duplicateOrder.body, { ok: true });
    assert.deepEqual(run.counts(), before.counts, '重投订单不得改变发送/fact/seen 计数');

    // ---- 邮件事件重投：duplicate → 不重复 fact、不再调 LLM ----
    const duplicateEmail = await run.postEvent(eventOf('evt_001'));
    assert.equal(duplicateEmail.status, 200);
    assert.deepEqual(duplicateEmail.body, { ok: true });
    assert.deepEqual(run.counts(), before.counts, '重投邮件不得改变发送/fact/seen 计数');
    assert.equal(extractor.calls.length, before.extractorCalls, '重投邮件不得再调 LLM');

    // 曾被拒绝的邮件重投同样走 seen 幂等门（不会多一条 Sam）。
    const duplicateRejected = await run.postEvent(eventOf('evt_004'));
    assert.equal(duplicateRejected.status, 200);
    assert.deepEqual(duplicateRejected.body, { ok: true });
    assert.deepEqual(run.counts(), before.counts);
    assert.equal(run.session()?.sam.all().length, before.sessionSam);

    // 不写盘：state.json 字节级不变（duplicate 在 seen 门就返回了）。
    assert.equal(await run.readStateText(), before.stateText, 'duplicate 不得写 state.json');

    // 不更新 lastEventAt（不把「现在」拨回过去）。
    assert.equal(run.session()?.lastEventAt.toISOString(), before.lastEventAt);

    // 审计不新增行。
    const afterAudit = await run.readAudit();
    assert.equal(afterAudit.decisions.length, before.audit.decisions.length);
    assert.equal(afterAudit.facts.length, before.audit.facts.length);

    // 整周不变量仍然成立（幂等没有破坏状态）。
    await assertWeekAComplete(run, loadExpectedRouting());
  });

  it('started 重放 → 会话重置；第二次整周仍是 38 单（不是整周 duplicate）', async (t) => {
    const gateway = new RecordingGateway();
    const extractor = new ScriptedExtractor();
    const week = loadWeekEvents();
    const run = await replayWeek({ gateway, extractor });
    t.after(async () => {
      await run.cleanup();
    });

    assert.equal(run.deliveries.length, WEEK_A_STATS.events);
    const sendsAfterFirstWeek = gateway.calls.length;
    assert.equal(sendsAfterFirstWeek, WEEK_A_STATS.orders);

    // ---- started 重投（同一 event_id）必须无条件重置，而不是被幂等门判 duplicate ----
    const startedEvent = week.find((event) => event.type === 'simulation.started');
    assert.ok(startedEvent !== undefined);
    const replayStarted = await run.postEvent(startedEvent);
    assert.equal(replayStarted.status, 200);

    const resetState = (await run.persisted()) as PersistedState;
    assert.deepEqual(resetState.seen_event_ids, ['evt_000'], 'started 重置后 seen 只有它自己');
    assert.equal(resetState.facts.length, BASE_FACT_COUNT, 'fact 回到 66 条基础事实');
    assert.deepEqual(resetState.sent_orders, {}, 'sent_orders 清空');
    assert.deepEqual(resetState.decisions, {}, 'decisions 清空');
    assert.deepEqual(resetState.sam, [], 'Sam 清空');
    assert.equal(gateway.calls.length, sendsAfterFirstWeek, '仅重投 started 不会发单');

    // ---- 第二遍整周：网关侧清空「已受理」记录（模拟新的一周），状态必须重建 ----
    const beforeSecondPass = gateway.calls.length;
    const secondPass = await run.replayAgain({ clearPharmacyRecords: true });
    assert.equal(secondPass.length, WEEK_A_STATS.events, '第二周仍投递 52 个事件');
    for (const delivery of secondPass) {
      assert.ok(delivery.status >= 200 && delivery.status < 300, `${delivery.eventId} 应 2xx`);
    }

    // 第二周仍是 38 单（新增 38 次网关请求），而不是 0 单。
    const secondPassCalls = gateway.calls.slice(beforeSecondPass);
    assert.equal(secondPassCalls.length, WEEK_A_STATS.orders, '第二周仍必须发 38 单');
    assert.equal(new Set(secondPassCalls.map((call) => call.orderId)).size, 38);
    assert.ok(
      secondPassCalls.every((call) => call.outcome.kind === 'accepted'),
      '第二周（清空药房记录后）每次发单都应 201',
    );

    // 状态按新周重建，而不是在旧周上累加。
    const finalState = await assertWeekAComplete(run, loadExpectedRouting(), {
      deliveries: secondPass,
      sendsBaseline: beforeSecondPass,
    });
    assert.equal(finalState.seen_event_ids.length, 49, 'seen 是 49，不是 98');
    assert.equal(finalState.facts.length, WEEK_A_STATS.facts, 'fact 是 75，不是 150');
    assert.equal(Object.keys(finalState.sent_orders).length, 38, 'sent_orders 是 38，不是 76');
    assert.equal(Object.keys(finalState.decisions).length, 38, 'decisions 是 38，不是 76');

    // 两遍共用同一个 extractor：第二遍又调了 10 次 LLM。
    assert.equal(extractor.calls.length, WEEK_A_STATS.extractionCalls * 2);
    assert.deepEqual(extractor.missingEventIds, []);

    // 审计是 append-only（不是真值）：两周各 38 条 decision / 10 条邮件行叠加。
    await run.stop();
    const audit = await run.readAudit();
    assert.equal(audit.decisions.length, WEEK_A_STATS.orders * 2);
    assert.equal(audit.facts.length, WEEK_A_STATS.emailAuditRows * 2);
  });
});
