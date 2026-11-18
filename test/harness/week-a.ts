/**
 * week A 夹具路径、已核对事实与整周不变量断言（`ARCHITECTURE.md` §12.3/§12.4）。
 *
 * 这里是集成测试共享的「唯一真值入口」：
 * - `WEEK_A_PATH` → `sim/week-a.jsonl`（**只读**，事件来源）；
 * - `EXPECTED_ROUTING_PATH` → `test/fixtures/week-a.expected.json`
 *   （`ARCHITECTURE` §12.4：38 单对照表以它为准，不与文档抄两遍）；
 * - `EXTRACTIONS_PATH` → `test/fixtures/llm/week-a.extractions.json`（LLM 回放）。
 *
 * 整周不变量（`REQUIREMENTS` §9、`DATA-CONTRACTS` §7.1、`WALKTHROUGHS` §4.2）：
 * 52 个事件 / 49 个唯一事件（3 次重投：evt_011/evt_020/evt_032）、38 个唯一订单、
 * 5 单 MANUAL、快照 75 条 fact（66 基础 + 9 邮件）、2 条 Sam。
 *
 * 断言函数接受「本轮 deliveries / 网关调用起点」，这样同一份不变量也能用在
 * `started` 重放后的第二周（网关调用总量翻倍，但本轮的发送数仍是 38）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PersistedState } from '../../src/application/ports/state-store.ts';
import type { PersistedRoutingDecision } from '../../src/domain/routing/decision.ts';
import type { SendCall } from './recording-gateway.ts';
import type { ReplayEventDelivery, ReplayRun } from './replay.ts';

/** `test/harness/` 的绝对路径。 */
const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
/** 仓库根（`test/harness/../..`）。 */
export const REPO_ROOT = resolve(HARNESS_DIR, '..', '..');

export const WEEK_A_PATH = resolve(REPO_ROOT, 'sim', 'week-a.jsonl');
export const EXPECTED_ROUTING_PATH = resolve(REPO_ROOT, 'test', 'fixtures', 'week-a.expected.json');
export const EXTRACTIONS_PATH = resolve(
  REPO_ROOT,
  'test',
  'fixtures',
  'llm',
  'week-a.extractions.json',
);

/**
 * 交给 `simulation.started` 的假药房 API base URL。
 *
 * `sim/sim.mjs` 在投递 `simulation.started` 时把本地药房服务的 URL 塞进 body 的
 * `pharmacyApi`（week 文件里没有这个字段）。集成测试直接注入 `RecordingGateway`，
 * 所以这里只需要一个「非空、不会被真正请求」的地址，用来验证
 * `StartSimulationUseCase` / 恢复路径的 `setBaseUrl` 注入。
 */
export const FAKE_PHARMACY_API = 'http://pharmacy.invalid';

/** 一个入站事件（week 文件的原始形状；`simulation.started` 的 `pharmacyApi` 由 harness 补）。 */
export interface WeekEvent {
  readonly event_id: string;
  readonly type: string;
  readonly occurred_at: string;
  readonly [field: string]: unknown;
}

/** `test/fixtures/week-a.expected.json` 的形状。 */
export interface ExpectedOrderRoute {
  readonly pharmacy: string;
  readonly basis: string;
}

export interface ExpectedRouting {
  readonly orders: Record<string, ExpectedOrderRoute>;
}

/** week A 的已核对计数（`DATA-CONTRACTS` §7.1、`WALKTHROUGHS` §4.2）。 */
export const WEEK_A_STATS = Object.freeze({
  /** 文件行数 / 投递次数（含 3 次重投）。 */
  events: 52,
  /** 唯一 event_id 数（幂等门之后的 `seen` 大小）。 */
  uniqueEvents: 49,
  /** 唯一订单数。 */
  orders: 38,
  /** MANUAL 订单数。 */
  manualOrders: 5,
  /** 快照里的 fact 总数（66 基础 + 9 邮件）。 */
  facts: 75,
  /** Sam 条目数（evt_003 权限、evt_004 未知剂量）。 */
  sam: 2,
  /** `out/facts.jsonl` 行数（8 applied + 2 rejected；重投不写）。 */
  emailAuditRows: 10,
  /** 10 封唯一邮件各调一次 LLM。 */
  extractionCalls: 10,
  /** 3 次重投的 event_id（按文件出现顺序）。 */
  redeliveries: ['evt_011', 'evt_020', 'evt_032'] as const,
  /** 最后一个事件 `evt_048` 的 occurred_at（ET 偏移）。 */
  lastEventAt: '2026-11-11T16:00:00-05:00',
} as const);

/** 读 week 文件（空行忽略；坏 JSON 立刻抛，夹具损坏不该静默）。 */
export function loadWeekEvents(weekPath: string = WEEK_A_PATH): WeekEvent[] {
  const text = readFileSync(weekPath, 'utf8');
  const events: WeekEvent[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (cause) {
      throw new Error(
        `week file ${weekPath} line ${index + 1} is not valid JSON: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
    events.push(parsed as WeekEvent);
  }
  return events;
}

/** 读人工核对过的 order → pharmacy/basis 对照表。 */
export function loadExpectedRouting(
  expectedPath: string = EXPECTED_ROUTING_PATH,
): ExpectedRouting {
  const parsed = JSON.parse(readFileSync(expectedPath, 'utf8')) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`expected routing fixture must be a JSON object: ${expectedPath}`);
  }
  const orders = (parsed as Record<string, unknown>)['orders'];
  if (typeof orders !== 'object' || orders === null || Array.isArray(orders)) {
    throw new Error(`expected routing fixture must have an "orders" object: ${expectedPath}`);
  }
  return { orders: orders as Record<string, ExpectedOrderRoute> };
}

/** 按 order_id 分组网关调用（保持插入顺序）。 */
export function groupCallsByOrder(
  calls: readonly SendCall[],
): ReadonlyMap<string, readonly SendCall[]> {
  const grouped = new Map<string, SendCall[]>();
  for (const call of calls) {
    const list = grouped.get(call.orderId);
    if (list === undefined) grouped.set(call.orderId, [call]);
    else list.push(call);
  }
  return grouped;
}

export interface WeekACompleteOptions {
  /** 本轮投递记录；默认 `run.deliveries`。第二周重放时传入第二次回放的子集。 */
  readonly deliveries?: readonly ReplayEventDelivery[];
  /** 本轮网关调用的起点下标（第二周重放时排除第一周的调用）；默认 0。 */
  readonly sendsBaseline?: number;
  /**
   * 允许「同一单出现多次网关请求」的订单（WAL 恢复窗口：按 WAL 药房原样重发，
   * 409 收敛）。默认每个订单恰好一次请求。
   */
  readonly allowRepeatedOrders?: readonly string[];
}

/**
 * 断言「整周回放完成」的全部硬不变量（§12.3/§12.4）：
 *
 * 1. 52 次投递全部 2xx；
 * 2. 快照：49 seen / 75 facts / 38 sent_orders / 38 decisions / last_event_at；
 * 3. 逐单对照 expected fixture：`chosen`、`basis` 完全一致；`sent` 已确认（201/409）；
 * 4. 5 单 MANUAL；每个订单的网关请求只指向一家药房；默认每单恰好一次请求；
 * 5. 订单集合与期望表完全一致（不多不少）。
 */
export async function assertWeekAComplete(
  run: ReplayRun,
  expected: ExpectedRouting,
  options: WeekACompleteOptions = {},
): Promise<PersistedState> {
  const deliveries = options.deliveries ?? run.deliveries;
  assert.equal(deliveries.length, WEEK_A_STATS.events, '整周必须投递 52 个事件');
  for (const delivery of deliveries) {
    assert.ok(
      delivery.status >= 200 && delivery.status < 300,
      `${delivery.eventId} 应返回 2xx，实际 ${delivery.status}（${JSON.stringify(delivery.body)}）`,
    );
  }

  const persisted = await run.persisted();
  assert.ok(persisted !== null, '整周结束后必须存在已提交的快照（state.json）');
  const state = persisted as PersistedState;

  assert.equal(
    state.seen_event_ids.length,
    WEEK_A_STATS.uniqueEvents,
    'seen_event_ids 必须等于 49（52 次投递去掉 3 次重投）',
  );
  assert.equal(state.facts.length, WEEK_A_STATS.facts, '快照 fact 总数必须是 75');
  assert.equal(state.sam.length, WEEK_A_STATS.sam, 'Sam 条目必须是 2（evt_003/evt_004）');
  assert.equal(state.last_event_at, WEEK_A_STATS.lastEventAt, 'last_event_at 必须是最后一个唯一事件时刻');

  const expectedIds = Object.keys(expected.orders);
  assert.equal(expectedIds.length, WEEK_A_STATS.orders, 'expected fixture 必须有 38 个订单');

  const sentIds = Object.keys(state.sent_orders).sort();
  assert.deepEqual(sentIds, [...expectedIds].sort(), '已发订单集合必须与 expected fixture 完全一致');
  assert.equal(sentIds.length, WEEK_A_STATS.orders);
  assert.equal(Object.keys(state.decisions).length, WEEK_A_STATS.orders, '每单恰好一条 decision');

  const manualIds: string[] = [];
  for (const orderId of expectedIds) {
    const expectedRoute = expected.orders[orderId];
    assert.ok(expectedRoute !== undefined, `expected fixture 缺少 ${orderId}`);

    const sent = state.sent_orders[orderId];
    assert.ok(sent !== undefined, `${orderId} 必须已发单（201 或 409）；实际未发`);
    assert.equal(sent.pharmacy, expectedRoute.pharmacy, `${orderId} 发住的药房必须与 fixture 一致`);
    if (expectedRoute.pharmacy === 'MANUAL') manualIds.push(orderId);

    const decision = state.decisions[orderId] as PersistedRoutingDecision | undefined;
    assert.ok(decision !== undefined, `${orderId} 必须有路由决策`);
    assert.equal(decision.chosen, expectedRoute.pharmacy, `${orderId} 的 chosen 必须与 fixture 一致`);
    assert.equal(decision.basis, expectedRoute.basis, `${orderId} 的 basis 必须与 fixture 一致`);
    assert.ok(decision.sent !== null, `${orderId} 的 decision.sent 必须已确认（201/409）`);
    assert.ok(
      decision.sent.status === 201 || decision.sent.status === 409,
      `${orderId} 的 decision.sent.status 必须是 201/409，实际 ${decision.sent.status}`,
    );
  }

  assert.equal(manualIds.length, WEEK_A_STATS.manualOrders, 'MANUAL 必须是 5 单');
  const sentManualCount = Object.values(state.sent_orders).filter(
    (entry) => entry.pharmacy === 'MANUAL',
  ).length;
  assert.equal(sentManualCount, WEEK_A_STATS.manualOrders, '发送给 MANUAL 的必须是 5 单');

  // ---- 网关侧：每个订单恰好一次（WAL 恢复窗口除外），且只发一家药房 ----
  const calls = run.gateway.calls.slice(options.sendsBaseline ?? 0);
  const grouped = groupCallsByOrder(calls);
  const allowedRepeats = new Set(options.allowRepeatedOrders ?? []);
  assert.deepEqual(
    [...grouped.keys()].sort(),
    [...expectedIds].sort(),
    '网关收到的订单集合必须与 expected fixture 完全一致（不多不少）',
  );

  for (const orderId of expectedIds) {
    const orderCalls = grouped.get(orderId);
    assert.ok(orderCalls !== undefined && orderCalls.length > 0, `${orderId} 必须向药房发过请求`);
    const pharmacies = new Set(orderCalls.map((call) => call.pharmacy));
    assert.equal(
      pharmacies.size,
      1,
      `${orderId} 绝不能发到两家药房：${[...pharmacies].join(', ')}`,
    );
    assert.equal(
      [...pharmacies][0],
      expected.orders[orderId]!.pharmacy,
      `${orderId} 的网关请求药房必须与 fixture 一致`,
    );
    const confirmed = orderCalls.some(
      (call) => call.outcome.kind === 'accepted' || call.outcome.kind === 'duplicate',
    );
    assert.ok(confirmed, `${orderId} 必须至少有一次已确认的发送（201/409）`);
    if (!allowedRepeats.has(orderId)) {
      assert.equal(orderCalls.length, 1, `${orderId} 必须恰好发一次（实际 ${orderCalls.length} 次）`);
    }
  }

  return state;
}
