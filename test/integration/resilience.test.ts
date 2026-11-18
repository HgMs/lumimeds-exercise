/**
 * 药房网关错误注入的集成测试（task-11；`ARCHITECTURE.md` §12.3「409/timeout 注入」）。
 *
 * 验证 `RecordingGateway` 的顺序注入与 `OrderDispatcher`/`RetryQueue` 在**真实 HTTP 栈**
 * 下的行为契约（`REQUIREMENTS` §6、`DATA-CONTRACTS` §2.1）：
 *
 * - `409`：药房确认「此前已发」→ 视为已发、不重试（同一单只请求 1 次）；
 * - `5xx`：同一药房内联退避重试 → 201 收敛（同一单 2 次请求，但**同一家药房**）；
 * - `timeout`（结果未知）：同样只对同一药房重发，绝不改派。
 *
 * 三种情况下整周仍然 38 单，且 chosen/basis 与 expected fixture 一致——错误注入不能
 * 改变路由决策，只影响发单的传输重试。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';

import { RecordingGateway } from '../harness/recording-gateway.ts';
import { replayWeek } from '../harness/replay.ts';
import type { ReplayRun } from '../harness/replay.ts';
import { ScriptedExtractor } from '../harness/scripted-extractor.ts';
import {
  assertWeekAComplete,
  loadExpectedRouting,
  loadWeekEvents,
} from '../harness/week-a.ts';
import type { ExpectedRouting, WeekEvent } from '../harness/week-a.ts';

interface OrderWeekEvent extends WeekEvent {
  readonly order: { readonly order_id: string };
}

interface Scenario {
  readonly run: ReplayRun;
  readonly gateway: RecordingGateway;
  readonly expected: ExpectedRouting;
  /** 第一个订单事件的 order_id（注入脚本命中的就是它）。 */
  readonly orderId: string;
  readonly expectedPharmacy: string;
}

/** 建一个运行并返回第一个订单（脚本注入的是它的第一次发单）。 */
async function scenario(
  t: TestContext,
  perCall: (gateway: RecordingGateway) => void,
): Promise<Scenario> {
  const gateway = new RecordingGateway();
  const extractor = new ScriptedExtractor();
  const week = loadWeekEvents();
  const expected = loadExpectedRouting();
  const firstOrder = week.find((event) => event.type === 'order') as OrderWeekEvent | undefined;
  assert.ok(firstOrder !== undefined, 'week 文件必须含订单事件');
  const orderId = firstOrder.order.order_id;
  const expectedPharmacy = expected.orders[orderId]?.pharmacy;
  assert.ok(expectedPharmacy !== undefined);
  perCall(gateway);

  const run = await replayWeek({ gateway, extractor });
  t.after(async () => {
    await run.cleanup();
  });
  return { run, gateway, expected, orderId, expectedPharmacy };
}

describe('integration: 药房网关错误注入（409 / 5xx / timeout）', () => {
  it('409 → 视为此前已发，不重试；整周仍 38 单', async (t) => {
    const { run, gateway, expected, orderId, expectedPharmacy } = await scenario(t, (fake) => {
      fake.enqueue({ kind: 'duplicate' });
    });

    const calls = gateway.callsFor(orderId);
    assert.equal(calls.length, 1, '409 是终局确认，不能重试');
    assert.equal(calls[0]?.outcome.kind, 'duplicate');
    assert.equal(calls[0]?.pharmacy, expectedPharmacy);

    const state = await assertWeekAComplete(run, expected);
    assert.equal(state.sent_orders[orderId]?.pharmacy, expectedPharmacy);
    // 409 也计一次容量（药房确认已受理），但整周状态仍与 expected 一致。
    assert.equal(Object.keys(state.sent_orders).length, 38);
  });

  it('一次 5xx 后 201 → 同一药房内联退避重试成功；绝不改派', async (t) => {
    const { run, gateway, expected, orderId, expectedPharmacy } = await scenario(t, (fake) => {
      fake.enqueue({ kind: 'retryable', status: 500 });
    });

    const calls = gateway.callsFor(orderId);
    assert.equal(calls.length, 2, '首次 5xx + 一次内联重试');
    assert.deepEqual(
      calls.map((call) => call.outcome.kind),
      ['retryable', 'accepted'],
    );
    assert.deepEqual(
      new Set(calls.map((call) => call.pharmacy)),
      new Set([expectedPharmacy]),
      '5xx 重试必须发同一家药房',
    );

    await assertWeekAComplete(run, expected, { allowRepeatedOrders: [orderId] });
    assert.equal(gateway.pendingScript, 0);
  });

  it('一次 timeout（结果未知）后 201 → 只对同一药房重发；绝不改派', async (t) => {
    const { run, gateway, expected, orderId, expectedPharmacy } = await scenario(t, (fake) => {
      fake.enqueue({ kind: 'timeout' });
    });

    const calls = gateway.callsFor(orderId);
    assert.equal(calls.length, 2, '首次超时 + 一次同药房重试');
    assert.deepEqual(
      calls.map((call) => call.outcome.kind),
      ['timeout', 'accepted'],
    );
    assert.equal(calls[0]?.pharmacy, expectedPharmacy);
    assert.equal(calls[1]?.pharmacy, expectedPharmacy);

    await assertWeekAComplete(run, expected, { allowRepeatedOrders: [orderId] });
  });
});
