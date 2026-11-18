/**
 * 周中崩溃重启集成测试（task-11；`ARCHITECTURE.md` §6.3、§11.3；`REQUIREMENTS` §6）。
 *
 * 用 harness 的 `crash` 选项在三个位置模拟「进程被杀」（不执行优雅停机：不 drain、
 * 不落盘、不 flush 审计），随后用同一 `stateDir` 走真实启动序列
 * （`buildContainer` → `restoreSession` → `recovery.run` → `retryQueue.start` → `listen`），
 * 再继续投递后续事件：
 *
 * 1. `simulation.started` 之后；
 * 2. 一封邮件（事实已生效）之后；
 * 3. 一个订单事件（订单已发出、快照已提交）之后。
 *
 * 另外显式覆盖 §11.3 的两个发单 WAL 窗口（这是唯一可能出现「同一单两次请求」的地方）：
 * - **`inflight.begin` 之后、POST 之前**：重启恢复按 WAL 药房原样重发一次 → 201；
 *   后续该订单事件看到 `sent_orders` 已含它 → 不再发单。同一单只有 1 次请求。
 * - **POST 收到 201、快照提交之前**：药房侧已受理但我们的快照没有它。重启恢复按 WAL
 *   重发 → 药房回 **409**（`confirmed`），同一单共 2 次请求但**同一家药房**。
 *   这正是 §11.3 声明的已知代价（模拟器会记一条 problem），这里断言不变量仍然成立：
 *   绝不发到第二家药房，整周仍是 38 单。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';

import type { CrashPlan } from '../harness/replay.ts';
import { replayWeek } from '../harness/replay.ts';
import type { ReplayRun } from '../harness/replay.ts';
import { RecordingGateway } from '../harness/recording-gateway.ts';
import { ScriptedExtractor } from '../harness/scripted-extractor.ts';
import {
  WEEK_A_STATS,
  assertWeekAComplete,
  loadExpectedRouting,
  loadWeekEvents,
} from '../harness/week-a.ts';
import type { ExpectedRouting, WeekEvent } from '../harness/week-a.ts';

interface OrderWeekEvent extends WeekEvent {
  readonly order: { readonly order_id: string; readonly state: string; readonly medication: string; readonly dose: string };
}

/** 某个事件之后、按文件顺序出现的第一个订单事件（用于注入 WAL 窗口）。 */
function firstOrderEventAfter(week: readonly WeekEvent[], afterEventId: string): OrderWeekEvent {
  const index = week.findIndex((event) => event.event_id === afterEventId);
  assert.ok(index >= 0, `week 文件缺少 ${afterEventId}`);
  const found = week.slice(index + 1).find((event) => event.type === 'order');
  assert.ok(found !== undefined, `${afterEventId} 之后没有订单事件`);
  return found as OrderWeekEvent;
}

interface CrashRun {
  readonly run: ReplayRun;
  readonly gateway: RecordingGateway;
  readonly extractor: ScriptedExtractor;
  readonly expected: ExpectedRouting;
  readonly week: readonly WeekEvent[];
}

/** 建一个带崩溃点的重放运行（测试结束自动清理临时目录/停机）。 */
async function startCrashRun(t: TestContext, crash: CrashPlan): Promise<CrashRun> {
  const gateway = new RecordingGateway();
  const extractor = new ScriptedExtractor();
  const week = loadWeekEvents();
  const expected = loadExpectedRouting();
  const run = await replayWeek({ gateway, extractor, crash });
  t.after(async () => {
    await run.cleanup();
  });
  return { run, gateway, extractor, expected, week };
}

/** 崩溃后重启的公共断言：52 次投递 2xx、恰好 1 次崩溃、会话从快照恢复。 */
function assertCrashRestarted(run: ReplayRun, extractor: ScriptedExtractor): void {
  assert.equal(run.deliveries.length, WEEK_A_STATS.events, '整周必须投递 52 个事件');
  for (const delivery of run.deliveries) {
    assert.ok(
      delivery.status >= 200 && delivery.status < 300,
      `${delivery.eventId} 应返回 2xx，实际 ${delivery.status}`,
    );
  }
  assert.equal(run.crashes.length, 1, '必须恰好触发 1 次崩溃重启');
  const crash = run.crashes[0]!;
  assert.equal(crash.restoredSession, true, '重启必须能从 state.json 重建会话');
  assert.ok(crash.recovery !== null, '有快照时启动必须执行 recovery.run()');
  // LLM 回放全程只覆盖 10 封唯一邮件（崩溃不导致邮件被重复抽取）。
  assert.equal(extractor.calls.length, WEEK_A_STATS.extractionCalls);
  assert.deepEqual(extractor.missingEventIds, []);
}

describe('integration: 周中崩溃重启（§6.3 / §11.3）', () => {
  it('started 之后崩溃：重启恢复会话，整周仍 38 单且与 expected fixture 一致', async (t) => {
    const { run, extractor, expected } = await startCrashRun(t, { afterEventId: 'evt_000' });

    assertCrashRestarted(run, extractor);
    const crash = run.crashes[0]!;
    assert.equal(crash.recovery?.inflightEntries, 0, 'started 之后没有在途发单');
    assert.equal(crash.recovery?.sessionLoaded, true);
    assert.equal(run.initialRecovery, null, '冷启动没有快照，不应执行恢复');

    const state = await assertWeekAComplete(run, expected);
    assert.equal(state.seen_event_ids.length, 49);
  });

  it('一封邮件之后崩溃：事实已落盘，重启后不重复应用，整周仍 38 单', async (t) => {
    // evt_001 是周一第一封邮件（evt_001 → TANDREL 缺货事实）。
    const { run, extractor, expected } = await startCrashRun(t, { afterEventId: 'evt_001' });

    assertCrashRestarted(run, extractor);
    const crash = run.crashes[0]!;
    assert.equal(crash.recovery?.inflightEntries, 0, '邮件事件不写发单 WAL');
    assert.equal(extractor.calls.length, WEEK_A_STATS.extractionCalls, '重启不重抽已生效的邮件');

    const state = await assertWeekAComplete(run, expected);
    // evt_001 的 fact 还在（快照恢复），且没有被重投重复应用。
    assert.equal(state.facts.length, WEEK_A_STATS.facts);
  });

  it('一个订单事件之后崩溃：已发单在快照里，重启后 INV-2 短路，整周仍 38 单', async (t) => {
    // evt_005 = ORD-1001（第一单；状态码 201 已发，快照已提交后崩溃）。
    const { run, gateway, extractor, expected } = await startCrashRun(t, { afterEventId: 'evt_005' });

    assertCrashRestarted(run, extractor);
    const crash = run.crashes[0]!;
    assert.equal(crash.recovery?.inflightEntries, 0, '201 后 inflight 已 commit，WAL 应为空');
    assert.equal(crash.recovery?.committed, 0);

    const state = await assertWeekAComplete(run, expected);
    assert.equal(Object.keys(state.sent_orders).length, 38);
    assert.equal(gateway.calls.length, 38, '整周共 38 次发单请求');
  });

  it('WAL 窗口（begin 后、POST 前崩溃）：恢复按 WAL 药房补发一次，后续事件不再发第二次', async (t) => {
    const week = loadWeekEvents();
    const expected = loadExpectedRouting();
    const target = firstOrderEventAfter(week, 'evt_005');
    const orderId = target.order.order_id;
    const expectedPharmacy = expected.orders[orderId]?.pharmacy;
    assert.ok(expectedPharmacy !== undefined);

    const { run, gateway, extractor } = await startCrashRun(t, {
      afterEventId: 'evt_005',
      beforeRestart: async ({ inflight }) => {
        // 模拟：这个订单事件的处理已经 `inflight.begin`（WAL 落盘），但 POST 之前进程被杀。
        await inflight.begin({
          orderId,
          pharmacy: expectedPharmacy,
          at: target.occurred_at,
          decisionReason: 'integration: crash between inflight.begin and POST',
          startedAtRealClock: '1970-01-01T00:00:00.000Z',
        });
      },
    });

    assertCrashRestarted(run, extractor);
    const crash = run.crashes[0]!;
    assert.equal(crash.recovery?.inflightEntries, 1, '重启必须看到 1 条在途 WAL');
    assert.equal(crash.recovery?.recovered, 1, '恢复应重发成功（201）');
    assert.equal(crash.recovery?.confirmed, 0);
    assert.equal(crash.recovery?.stateSaved, true, '恢复结果必须落盘');

    // 该订单全程只有恢复路径的那 1 次请求，且药房就是 WAL 里记的那家；
    // 随后该订单事件到达时 `sent_orders` 已有它 → INV-2 短路，不再发单。
    const calls = gateway.callsFor(orderId);
    assert.equal(calls.length, 1, '同一单只应被请求一次（恢复补发）');
    assert.equal(calls[0]?.pharmacy, expectedPharmacy, '恢复只能发 WAL 里记的药房，绝不重新路由');
    assert.equal(calls[0]?.outcome.kind, 'accepted');

    const state = await assertWeekAComplete(run, expected);
    assert.equal(state.sent_orders[orderId]?.pharmacy, expectedPharmacy);
  });

  it('WAL 窗口（药房已 201、快照未提交）：恢复撞 409，同一单 2 次请求但同一药房，整周仍 38 单', async (t) => {
    const week = loadWeekEvents();
    const expected = loadExpectedRouting();
    const target = firstOrderEventAfter(week, 'evt_005');
    const orderId = target.order.order_id;
    const expectedPharmacy = expected.orders[orderId]?.pharmacy;
    assert.ok(expectedPharmacy !== undefined);

    const { run, gateway, extractor } = await startCrashRun(t, {
      afterEventId: 'evt_005',
      beforeRestart: async ({ inflight, gateway: crashedGateway }) => {
        // 模拟 §11.3「POST 收到 201、sent.mark/快照提交之前崩溃」：
        // 药房侧已受理（注入一条 accepted-lost 调用记录），我们的 WAL 还留着这条在途单。
        crashedGateway.injectAcceptedButLost({
          orderId,
          pharmacy: expectedPharmacy,
          reason: 'integration: pharmacy accepted, snapshot not committed',
        });
        await inflight.begin({
          orderId,
          pharmacy: expectedPharmacy,
          at: target.occurred_at,
          decisionReason: 'integration: crash after pharmacy accepted',
          startedAtRealClock: '1970-01-01T00:00:00.000Z',
        });
      },
    });

    assertCrashRestarted(run, extractor);
    const crash = run.crashes[0]!;
    assert.equal(crash.recovery?.inflightEntries, 1);
    assert.equal(crash.recovery?.confirmed, 1, '恢复重发必须被药房以 409 确认为「此前已发」');
    assert.equal(crash.recovery?.recovered, 0);

    // 允许同一单出现两次请求，但两次都必须指向同一家药房（409 语义）。
    const calls = gateway.callsFor(orderId);
    assert.equal(calls.length, 2, '崩溃窗口允许「丢失的 201 + 恢复重发」两次请求');
    assert.deepEqual(
      new Set(calls.map((call) => call.pharmacy)),
      new Set([expectedPharmacy]),
      '同一单绝不能发到两家药房',
    );
    assert.equal(calls[0]?.injected, 'accepted-lost');
    const recoveryOutcome = calls[1]?.outcome;
    assert.equal(recoveryOutcome?.kind, 'duplicate');
    if (recoveryOutcome?.kind === 'duplicate') assert.equal(recoveryOutcome.status, 409);

    const state = await assertWeekAComplete(run, expected, {
      allowRepeatedOrders: [orderId],
    });
    assert.equal(state.sent_orders[orderId]?.pharmacy, expectedPharmacy, '最终 sent 药房必须是 WAL/药房确认的那家');
    assert.equal(Object.keys(state.sent_orders).length, 38);
    assert.equal(Object.keys(state.decisions).length, 38);
  });
});
