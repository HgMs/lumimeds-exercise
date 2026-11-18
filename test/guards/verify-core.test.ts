/**
 * `scripts/verify.ts` 的**核心行为**测试（`ARCHITECTURE.md` §12.5、`REQUIREMENTS.md` §8）。
 *
 * 整周回放的 `out/` 产物要等集成重放跑完才有；在那之前，用**合成数据**把 verify 的独立
 * 求值器与断言逐条钉住：ET 日/DST、`until` 排他、四硬条件、容量按 (药房, ET 日)、
 * MANUAL ⇔ 无候选（含 `internal_error`/`unknown_` 白名单）、ops 偏好从属于安全、override、
 * 集合一致性、候选差分、缺文件 exit 2。
 *
 * 这些用例不 import `src/`（守卫本身也禁止 verify import src/），数据全部在测试里构造。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  InputError,
  etDateOf,
  etTimeLabel,
  intervalCovers,
  isFallbackReason,
  normalizeDose,
  normalizeMedication,
  normalizeState,
  parseOptions,
  runVerify,
  startOfDayMs,
  verifyFromRows,
} from '../../scripts/verify.ts';
import type { RawVerifyInput, VerifyReport } from '../../scripts/verify.ts';

// ---------------------------------------------------------------------------
// 合成数据构造器
// ---------------------------------------------------------------------------

/** 基础 config：ALPHA 快（1 天）/便宜/容量 2；BETA 慢（2 天）/贵/容量 1/不收 NJ。 */
const ALPHA = {
  id: 'ALPHA',
  name: 'Alpha Rx',
  contacts: [],
  open: true,
  shipsInDays: 1,
  dailyCapacity: 2,
  price: { semaglutide: 100 },
  blockedStates: [] as string[],
  stock: { semaglutide: ['0.5mg', '1mg'] },
};

const BETA = {
  id: 'BETA',
  name: 'Beta Rx',
  contacts: [],
  open: true,
  shipsInDays: 2,
  dailyCapacity: 1,
  price: { semaglutide: 120 },
  blockedStates: ['NJ'],
  stock: { semaglutide: ['0.5mg', '1mg'] },
};

function config(pharmacies: unknown[] = [ALPHA, BETA]): Record<string, unknown> {
  return {
    catalogue: { semaglutide: ['0.5mg', '1mg'] },
    lumimedsOps: ['sam@clinic.example'],
    pharmacies,
  };
}

function started(configValue: Record<string, unknown> = config()): unknown {
  return {
    event_id: 'evt_000',
    type: 'simulation.started',
    occurred_at: '2026-11-09T06:00:00-05:00',
    config: configValue,
  };
}

interface OrderSpec {
  id: string;
  event: string;
  at: string;
  state: string;
  dose?: string;
}

function orderEvent(order: OrderSpec): unknown {
  return {
    event_id: order.event,
    type: 'order',
    occurred_at: order.at,
    order: { order_id: order.id, state: order.state, medication: 'semaglutide', dose: order.dose ?? '1mg' },
  };
}

interface CandidateSpec {
  pharmacy: string;
  eligible: boolean;
  failures: string[];
  shipsInDays: number;
  price: number | null;
  capacityLeft: number;
}

interface DecisionSpec {
  order: OrderSpec;
  chosen: string;
  basis: string;
  reason?: string | null;
  candidates?: CandidateSpec[] | null;
  preference?: { pharmacy: string; event_id: string } | null;
  override?: string | null;
}

function decisionRow(spec: DecisionSpec): unknown {
  return {
    order_id: spec.order.id,
    at: spec.order.at,
    order: {
      order_id: spec.order.id,
      state: spec.order.state,
      medication: 'semaglutide',
      dose: spec.order.dose ?? '1mg',
    },
    chosen: spec.chosen,
    basis: spec.basis,
    reason: spec.reason ?? null,
    candidates: spec.candidates === undefined ? null : spec.candidates,
    preference: spec.preference ?? null,
    override: spec.override ?? null,
    sent: null,
  };
}

function runRow(order: OrderSpec, pharmacy: string): unknown {
  return {
    order_id: order.id,
    pharmacy,
    reason: null,
    sim_time: order.at,
    during_event: order.event,
    late: false,
  };
}

function candidate(
  pharmacy: string,
  eligible: boolean,
  failures: string[],
  shipsInDays: number,
  price: number | null,
  capacityLeft: number,
): CandidateSpec {
  return { pharmacy, eligible, failures, shipsInDays, price, capacityLeft };
}

interface FactSpec {
  id: string;
  type: string;
  pharmacy: string;
  medication?: string;
  dose?: string;
  state?: string;
  perDay?: number;
  interval: { from: string; until: string | null };
}

function factRow(at: string, eventId: string, facts: FactSpec[], outcome = 'applied'): unknown {
  return {
    at,
    event_id: eventId,
    from: `staff@${eventId}.example`,
    subject: 'notice',
    role: 'pharmacy',
    outcome,
    facts,
  };
}

function specFact(
  id: string,
  type: string,
  pharmacy: string,
  interval: { from: string; until: string | null },
  extra: Partial<FactSpec> = {},
): FactSpec {
  return { id, type, pharmacy, interval, ...extra };
}

// 基础场景（3 单）；`out/` 产物的每个字段都可被 use-case 覆盖。
const ORDER_A: OrderSpec = { id: 'ORD-A', event: 'evt_001', at: '2026-11-09T09:00:00-05:00', state: 'CA' };
const ORDER_B: OrderSpec = { id: 'ORD-B', event: 'evt_002', at: '2026-11-09T10:00:00-05:00', state: 'NJ' };
const ORDER_C: OrderSpec = { id: 'ORD-C', event: 'evt_003', at: '2026-11-09T11:00:00-05:00', state: 'NJ' };

/** 一条邮件事实：10:00–10:30（until 排他）ALPHA 的 semaglutide 1mg 缺货。 */
const BASE_FACT = factRow('2026-11-09T07:00:00-05:00', 'evt_010', [
  specFact('fact_0001', 'stock_unavailable', 'ALPHA', {
    from: '2026-11-09T10:00:00-05:00',
    until: '2026-11-09T10:30:00-05:00',
  }, { medication: 'semaglutide', dose: '1mg' }),
]);

/**
 * 与基础场景一致的「正确」决策/发单记录：
 * - ORD-A 09:00 → ALPHA（rank）；
 * - ORD-B 10:00 无候选（ALPHA 缺 1mg、BETA 不收 NJ）→ MANUAL；
 * - ORD-C 11:00 → ALPHA（rank，缺货已过期、容量 1/2）。
 */
function baseInput(): RawVerifyInput {
  const decisions: unknown[] = [
    decisionRow({
      order: ORDER_A,
      chosen: 'ALPHA',
      basis: 'rank',
      reason: 'fastest safe: ALPHA',
      candidates: [
        candidate('ALPHA', true, [], 1, 100, 2),
        candidate('BETA', true, [], 2, 120, 1),
      ],
    }),
    decisionRow({
      order: ORDER_B,
      chosen: 'MANUAL',
      basis: 'manual',
      reason: 'no eligible pharmacy: ALPHA(no_stock:semaglutide:1mg); BETA(state_blocked:NJ)',
      candidates: [
        candidate('ALPHA', false, ['no_stock:semaglutide:1mg'], 1, 100, 1),
        candidate('BETA', false, ['state_blocked:NJ'], 2, 120, 1),
      ],
    }),
    decisionRow({
      order: ORDER_C,
      chosen: 'ALPHA',
      basis: 'rank',
      reason: 'fastest safe: ALPHA',
      candidates: [
        candidate('ALPHA', true, [], 1, 100, 1),
        candidate('BETA', false, ['state_blocked:NJ'], 2, 120, 1),
      ],
    }),
  ];
  return {
    weekRows: [started(), orderEvent(ORDER_A), orderEvent(ORDER_B), orderEvent(ORDER_C)],
    decisionRows: decisions,
    runLogRows: [runRow(ORDER_A, 'ALPHA'), runRow(ORDER_B, 'MANUAL'), runRow(ORDER_C, 'ALPHA')],
    factRows: [BASE_FACT],
  };
}

/** 单药房/单订单的最小场景，便于测某一条断言而不牵动容量账本。 */
function singleOrderInput(options: {
  order?: Partial<OrderSpec>;
  pharmacies?: unknown[];
  decisions?: DecisionSpec[];
  runRows?: Array<[OrderSpec, string]>;
  factRows?: unknown[];
}): RawVerifyInput {
  const order: OrderSpec = {
    id: 'ORD-X',
    event: 'evt_101',
    at: '2026-11-09T09:00:00-05:00',
    state: 'CA',
    ...options.order,
  };
  const decisions = options.decisions ?? [
    {
      order,
      chosen: 'ALPHA',
      basis: 'rank',
      reason: 'fastest safe: ALPHA',
      candidates: [candidate('ALPHA', true, [], 1, 100, 2)],
    },
  ];
  return {
    weekRows: [started(config(options.pharmacies ?? [ALPHA])), orderEvent(order)],
    decisionRows: decisions.map(decisionRow),
    runLogRows: (options.runRows ?? [[order, 'ALPHA']]).map(([spec, pharmacy]) => runRow(spec, pharmacy)),
    factRows: options.factRows ?? [],
  };
}

function expectFailure(report: VerifyReport, category: string, orderId: string): void {
  assert.equal(report.exitCode, 1, `应失败但通过了：\n${report.lines.join('\n')}`);
  const hit = report.failures.some(
    (failure) => failure.includes(`[${category}]`) && failure.includes(orderId),
  );
  assert.ok(
    hit,
    `应出现 [${category}] ${orderId} 的失败，实际：\n${report.failures.join('\n')}`,
  );
}

function expectPass(report: VerifyReport): void {
  assert.equal(
    report.exitCode,
    0,
    `应通过但失败：\n${report.failures.join('\n')}\n\n${report.lines.join('\n')}`,
  );
}

// ---------------------------------------------------------------------------
// 时间模型（ARCHITECTURE §10）
// ---------------------------------------------------------------------------

describe('verify 的 ET 时间模型（ARCHITECTURE §10）', () => {
  it('etDateOf 按 America/New_York 给业务日（不是 UTC 日）', () => {
    assert.equal(etDateOf(Date.parse('2026-11-09T06:00:00-05:00')), '2026-11-09');
    // 23:00 EST 已经是 UTC 的次日 04:00，业务日仍是 11-09。
    assert.equal(etDateOf(Date.parse('2026-11-09T23:00:00-05:00')), '2026-11-09');
    assert.equal(etDateOf(Date.parse('2026-11-10T00:30:00-05:00')), '2026-11-10');
  });

  it('startOfDayMs 跨 DST 正确（春令时 23h、冬令时 25h）', () => {
    assert.equal(startOfDayMs('2026-11-09'), Date.parse('2026-11-09T00:00:00-05:00'));
    assert.equal(startOfDayMs('2026-11-01'), Date.parse('2026-11-01T00:00:00-04:00'));
    assert.equal(startOfDayMs('2026-03-08'), Date.parse('2026-03-08T00:00:00-05:00'));
    assert.equal(
      startOfDayMs('2026-03-09') - startOfDayMs('2026-03-08'),
      23 * 3_600_000,
      '2026-03-08 → 03-09 只有 23 小时',
    );
    assert.equal(
      startOfDayMs('2026-11-02') - startOfDayMs('2026-11-01'),
      25 * 3_600_000,
      '2026-11-01 → 11-02 有 25 小时',
    );
  });

  it('intervalCovers：until 排他（[from, until)）', () => {
    const from = Date.parse('2026-11-09T10:00:00-05:00');
    const until = Date.parse('2026-11-09T10:30:00-05:00');
    assert.equal(intervalCovers(from, until, from), true);
    assert.equal(intervalCovers(from, until, until - 1), true);
    assert.equal(intervalCovers(from, until, until), false, 'until 那一刻必须已恢复');
    assert.equal(intervalCovers(from, null, until), true, 'until=null 表示一直有效');
    assert.equal(intervalCovers(from, until, from - 1), false);
  });

  it('etTimeLabel 输出 ET 墙上时间', () => {
    assert.equal(etTimeLabel(Date.parse('2026-11-10T15:00:00-05:00')), '2026-11-10 15:00 ET');
  });
});

// ---------------------------------------------------------------------------
// 归一化与白名单（REQUIREMENTS §5 末段、§7 INV-5）
// ---------------------------------------------------------------------------

describe('verify 的归一化与 MANUAL 白名单', () => {
  it('州全名/大小写 → USPS 码；非法州返回 null（不猜）', () => {
    assert.equal(normalizeState('Texas'), 'TX');
    assert.equal(normalizeState('  texas '), 'TX');
    assert.equal(normalizeState('NJ'), 'NJ');
    assert.equal(normalizeState('Ontario'), null);
  });

  it('药品只认目录键 + tirz/sema 别名（不做前缀模糊匹配）', () => {
    const keys = ['semaglutide', 'tirzepatide'];
    assert.equal(normalizeMedication('tirz', keys), 'tirzepatide');
    assert.equal(normalizeMedication('SEMA', keys), 'semaglutide');
    assert.equal(normalizeMedication('semaglut', keys), null);
  });

  it('剂量去空白/小写单位，绝不补单位', () => {
    assert.equal(normalizeDose(' 7.5 mg '), '7.5mg');
    assert.equal(normalizeDose('1MG'), '1mg');
    assert.equal(normalizeDose('7.5'), '7.5');
    assert.equal(normalizeDose('  '), null);
  });

  it('MANUAL 兜底前缀白名单只有 internal_error / unknown_', () => {
    assert.equal(isFallbackReason('internal_error:boom'), true);
    assert.equal(isFallbackReason('unknown_state:Ontario'), true);
    assert.equal(isFallbackReason('no eligible pharmacy: ...'), false);
    assert.equal(isFallbackReason(null), false);
  });
});

// ---------------------------------------------------------------------------
// 端到端（合成数据）：正确产物必须全绿
// ---------------------------------------------------------------------------

describe('verify 核心断言（合成数据）', () => {
  it('基础场景（rank ×2 + manual ×1）exit 0，每单一行 + 汇总', () => {
    const report = verifyFromRows(baseInput());
    expectPass(report);
    assert.equal(report.summary.orders, 3);
    assert.equal(report.summary.sentToPharmacy, 2);
    assert.equal(report.summary.manual, 1);
    assert.deepEqual(report.summary.byBasis, { rank: 2, manual: 1 });
    const orderLines = report.lines.filter((line) => /^[✓✗] /.test(line));
    assert.equal(orderLines.length, 3, `每单一行，实际：\n${orderLines.join('\n')}`);
    assert.ok(report.lines.some((line) => line.includes('结论：全部通过')));
    assert.ok(report.lines.some((line) => line.includes('容量')));
  });

  it('rejected / no_change 的 facts.jsonl 行不产生事实（不影响信念）', () => {
    const input = baseInput();
    input.factRows = [
      BASE_FACT,
      factRow('2026-11-09T08:00:00-05:00', 'evt_011', [
        specFact('fact_0002', 'stock_unavailable', 'ALPHA', {
          from: '2026-11-09T08:00:00-05:00',
          until: null,
        }, { medication: 'semaglutide', dose: '1mg' }),
      ], 'rejected'),
    ];
    expectPass(verifyFromRows(input));
  });

  it('已发订单所选药房在 sim_time 不合格 → 安全失败', () => {
    const input = baseInput();
    // ORD-B 在 10:00 时 ALPHA 缺 1mg；把它改成发 ALPHA 就是不安全发单。
    input.decisionRows = (input.decisionRows as Array<Record<string, unknown>>).map((row) =>
      row.order_id === 'ORD-B' ? { ...row, chosen: 'ALPHA', basis: 'rank', reason: 'fastest safe' } : row,
    );
    input.runLogRows = [
      runRow(ORDER_A, 'ALPHA'),
      runRow(ORDER_B, 'ALPHA'),
      runRow(ORDER_C, 'ALPHA'),
    ];
    expectFailure(verifyFromRows(input), 'safety', 'ORD-B');
  });

  it('MANUAL 但独立求值存在安全候选（且非兜底 reason）→ manual 失败', () => {
    const input = baseInput();
    input.decisionRows = (input.decisionRows as Array<Record<string, unknown>>).map((row) =>
      row.order_id === 'ORD-A'
        ? { ...row, chosen: 'MANUAL', basis: 'manual', reason: 'no eligible pharmacy: （假的）' }
        : row,
    );
    input.runLogRows = [
      runRow(ORDER_A, 'MANUAL'),
      runRow(ORDER_B, 'MANUAL'),
      runRow(ORDER_C, 'ALPHA'),
    ];
    expectFailure(verifyFromRows(input), 'manual', 'ORD-A');
  });

  it('兜底（internal_error / unknown_）允许 MANUAL，即使独立求值有候选', () => {
    const input = singleOrderInput({
      decisions: [
        {
          order: { id: 'ORD-X', event: 'evt_101', at: '2026-11-09T09:00:00-05:00', state: 'CA' },
          chosen: 'MANUAL',
          basis: 'manual',
          reason: 'internal_error:order_struct_missing',
          candidates: [candidate('ALPHA', true, [], 1, 100, 2)],
        },
      ],
      runRows: [[{ id: 'ORD-X', event: 'evt_101', at: '2026-11-09T09:00:00-05:00', state: 'CA' }, 'MANUAL']],
    });
    expectPass(verifyFromRows(input));
  });

  it('run-log 缺单 / 重复发单 → 失败（每单恰好一次）', () => {
    const missing = baseInput();
    missing.runLogRows = [runRow(ORDER_A, 'ALPHA'), runRow(ORDER_B, 'MANUAL')];
    expectFailure(verifyFromRows(missing), 'sent', 'ORD-C');

    const duplicated = baseInput();
    duplicated.runLogRows = [
      runRow(ORDER_A, 'ALPHA'),
      runRow(ORDER_A, 'ALPHA'),
      runRow(ORDER_B, 'MANUAL'),
      runRow(ORDER_C, 'ALPHA'),
    ];
    expectFailure(verifyFromRows(duplicated), 'sent', 'ORD-A');
  });

  it('decisions 与 week 订单集合不一致 → 失败', () => {
    const missing = baseInput();
    missing.decisionRows = (missing.decisionRows as unknown[]).filter(
      (row) => (row as Record<string, unknown>).order_id !== 'ORD-C',
    );
    expectFailure(verifyFromRows(missing), 'set', 'ORD-C');

    const extra = baseInput();
    (extra.decisionRows as unknown[]).push(
      decisionRow({
        order: { id: 'ORD-Z', event: 'evt_999', at: '2026-11-09T12:00:00-05:00', state: 'CA' },
        chosen: 'ALPHA',
        basis: 'rank',
        candidates: [candidate('ALPHA', true, [], 1, 100, 1)],
      }),
    );
    expectFailure(verifyFromRows(extra), 'set', 'ORD-Z');
  });

  it('run-log 药房与 decision.chosen 不一致 → 失败', () => {
    const input = baseInput();
    input.runLogRows = [
      runRow(ORDER_A, 'BETA'), // decision 说 ALPHA
      runRow(ORDER_B, 'MANUAL'),
      runRow(ORDER_C, 'ALPHA'),
    ];
    expectFailure(verifyFromRows(input), 'set', 'ORD-A');
  });

  it('决策时刻（at/sim_time）必须等于订单事件的 occurred_at', () => {
    const input = baseInput();
    input.decisionRows = (input.decisionRows as Array<Record<string, unknown>>).map((row) =>
      row.order_id === 'ORD-A' ? { ...row, at: '2026-11-09T09:05:00-05:00' } : row,
    );
    expectFailure(verifyFromRows(input), 'set', 'ORD-A');
  });
});

// ---------------------------------------------------------------------------
// 容量（按 (药房, ET 日) 计真实发单）
// ---------------------------------------------------------------------------

describe('verify 的容量不变量（INV-6、REQUIREMENTS §3.3）', () => {
  it('当日容量用完后再发 → 安全失败（capacity_full）', () => {
    const pharmacy = { ...ALPHA, dailyCapacity: 1 };
    const first: OrderSpec = { id: 'ORD-1', event: 'evt_201', at: '2026-11-09T09:00:00-05:00', state: 'CA' };
    const second: OrderSpec = { id: 'ORD-2', event: 'evt_202', at: '2026-11-09T10:00:00-05:00', state: 'CA' };
    const input = singleOrderInput({
      pharmacies: [pharmacy],
      order: first,
      decisions: [
        {
          order: first,
          chosen: 'ALPHA',
          basis: 'rank',
          candidates: [candidate('ALPHA', true, [], 1, 100, 1)],
        },
        {
          order: second,
          chosen: 'ALPHA',
          basis: 'rank',
          // 决策记录如实写了 capacity_full，但订单仍被发出 → 安全失败
          candidates: [candidate('ALPHA', false, ['capacity_full'], 1, 100, 0)],
        },
      ],
      runRows: [
        [first, 'ALPHA'],
        [second, 'ALPHA'],
      ],
    });
    input.weekRows = [started(config([pharmacy])), orderEvent(first), orderEvent(second)];
    expectFailure(verifyFromRows(input), 'safety', 'ORD-2');
  });

  it('容量按 ET 日重置：23:00 与次日 01:00 各占一单不算超容量', () => {
    const pharmacy = { ...ALPHA, dailyCapacity: 1 };
    const late: OrderSpec = { id: 'ORD-1', event: 'evt_211', at: '2026-11-09T23:00:00-05:00', state: 'CA' };
    const early: OrderSpec = { id: 'ORD-2', event: 'evt_212', at: '2026-11-10T01:00:00-05:00', state: 'CA' };
    const input: RawVerifyInput = {
      weekRows: [started(config([pharmacy])), orderEvent(late), orderEvent(early)],
      decisionRows: [
        decisionRow({
          order: late,
          chosen: 'ALPHA',
          basis: 'rank',
          candidates: [candidate('ALPHA', true, [], 1, 100, 1)],
        }),
        decisionRow({
          order: early,
          chosen: 'ALPHA',
          basis: 'rank',
          candidates: [candidate('ALPHA', true, [], 1, 100, 1)],
        }),
      ],
      runLogRows: [runRow(late, 'ALPHA'), runRow(early, 'ALPHA')],
      factRows: [],
    };
    expectPass(verifyFromRows(input));
  });

  it('MANUAL 不占容量（下一单仍可用同一药房）', () => {
    const pharmacy = { ...ALPHA, dailyCapacity: 1 };
    const manualOrder: OrderSpec = { id: 'ORD-1', event: 'evt_221', at: '2026-11-09T09:00:00-05:00', state: 'CA' };
    const sentOrder: OrderSpec = { id: 'ORD-2', event: 'evt_222', at: '2026-11-09T10:00:00-05:00', state: 'CA' };
    const input: RawVerifyInput = {
      weekRows: [started(config([pharmacy])), orderEvent(manualOrder), orderEvent(sentOrder)],
      decisionRows: [
        decisionRow({
          order: manualOrder,
          chosen: 'MANUAL',
          basis: 'manual',
          reason: 'internal_error:boom',
          candidates: [candidate('ALPHA', true, [], 1, 100, 1)],
        }),
        decisionRow({
          order: sentOrder,
          chosen: 'ALPHA',
          basis: 'rank',
          candidates: [candidate('ALPHA', true, [], 1, 100, 1)],
        }),
      ],
      runLogRows: [runRow(manualOrder, 'MANUAL'), runRow(sentOrder, 'ALPHA')],
      factRows: [],
    };
    expectPass(verifyFromRows(input));
  });
});

// ---------------------------------------------------------------------------
// ops 偏好从属于安全（REQUIREMENTS §5、§7 INV-5）
// ---------------------------------------------------------------------------

const PREFERENCE_FACT = factRow('2026-11-09T07:00:00-05:00', 'evt_301', [
  specFact(
    'fact_0101',
    'routing_preference',
    'ALPHA',
    { from: '2026-11-09T00:00:00-05:00', until: null },
    { medication: 'semaglutide' },
  ),
]);

/** 偏好场景：ALPHA 慢（2 天）/BETA 快（1 天）；偏好让 ALPHA 胜出。 */
const SLOW_ALPHA = { ...ALPHA, shipsInDays: 2, dailyCapacity: 5 };
const FAST_BETA = { ...BETA, shipsInDays: 1, blockedStates: [] as string[], dailyCapacity: 5 };

function preferenceInput(decision: Partial<DecisionSpec>): RawVerifyInput {
  const order: OrderSpec = { id: 'ORD-P', event: 'evt_302', at: '2026-11-09T09:00:00-05:00', state: 'CA' };
  const baseDecision: DecisionSpec = {
    order,
    chosen: 'ALPHA',
    basis: 'ops_preference',
    preference: { pharmacy: 'ALPHA', event_id: 'evt_301' },
    candidates: [
      candidate('ALPHA', true, [], 2, 100, 5),
      candidate('BETA', true, [], 1, 120, 5),
    ],
  };
  return {
    weekRows: [started(config([SLOW_ALPHA, FAST_BETA])), orderEvent(order)],
    decisionRows: [decisionRow({ ...baseDecision, ...decision })],
    runLogRows: [runRow(order, 'ALPHA')],
    factRows: [PREFERENCE_FACT],
  };
}

describe('verify 的 ops 偏好断言（偏好从属于安全）', () => {
  it('偏好药房安全可用时必须命中（basis=ops_preference + preference.event_id 对账）', () => {
    expectPass(verifyFromRows(preferenceInput({})));
  });

  it('偏好药房可用却按 rank 发别家、且无 override → 偏好失败', () => {
    const input = preferenceInput({
      basis: 'rank',
      preference: null,
      chosen: 'BETA',
    });
    input.runLogRows = [runRow({ id: 'ORD-P', event: 'evt_302', at: '2026-11-09T09:00:00-05:00', state: 'CA' }, 'BETA')];
    expectFailure(verifyFromRows(input), 'preference', 'ORD-P');
  });

  it('偏好药房不可用时回落 rank + override → 通过', () => {
    const closedAlpha = factRow('2026-11-09T07:05:00-05:00', 'evt_303', [
      specFact('fact_0102', 'closed', 'ALPHA', {
        from: '2026-11-09T07:05:00-05:00',
        until: '2026-11-10T00:00:00-05:00',
      }),
    ]);
    const order: OrderSpec = { id: 'ORD-P', event: 'evt_302', at: '2026-11-09T09:00:00-05:00', state: 'CA' };
    const input = preferenceInput({
      chosen: 'BETA',
      basis: 'rank',
      preference: null,
      override: 'ops preferred ALPHA but: ALPHA(closed)',
    });
    input.factRows = [PREFERENCE_FACT, closedAlpha];
    input.decisionRows = [
      decisionRow({
        order,
        chosen: 'BETA',
        basis: 'rank',
        preference: null,
        override: 'ops preferred ALPHA but: ALPHA(closed)',
        candidates: [
          candidate('ALPHA', false, ['closed'], 2, 100, 5),
          candidate('BETA', true, [], 1, 120, 5),
        ],
      }),
    ];
    input.runLogRows = [runRow(order, 'BETA')];
    expectPass(verifyFromRows(input));
  });

  it('偏好存在但都不可用、却没记录 override → 偏好失败', () => {
    const closedAlpha = factRow('2026-11-09T07:05:00-05:00', 'evt_303', [
      specFact('fact_0102', 'closed', 'ALPHA', {
        from: '2026-11-09T07:05:00-05:00',
        until: '2026-11-10T00:00:00-05:00',
      }),
    ]);
    const order: OrderSpec = { id: 'ORD-P', event: 'evt_302', at: '2026-11-09T09:00:00-05:00', state: 'CA' };
    const input: RawVerifyInput = {
      weekRows: [started(config([SLOW_ALPHA, FAST_BETA])), orderEvent(order)],
      decisionRows: [
        decisionRow({
          order,
          chosen: 'BETA',
          basis: 'rank',
          preference: null,
          override: null,
          candidates: [
            candidate('ALPHA', false, ['closed'], 2, 100, 5),
            candidate('BETA', true, [], 1, 120, 5),
          ],
        }),
      ],
      runLogRows: [runRow(order, 'BETA')],
      factRows: [PREFERENCE_FACT, closedAlpha],
    };
    expectFailure(verifyFromRows(input), 'preference', 'ORD-P');
  });
});

// ---------------------------------------------------------------------------
// 差分：候选评估必须与独立求值一致
// ---------------------------------------------------------------------------

describe('verify 的候选差分断言（§12.5 的差分测试价值）', () => {
  it('failures 不一致（例如把 until 当闭区间）→ differential 失败', () => {
    const order: OrderSpec = { id: 'ORD-X', event: 'evt_101', at: '2026-11-09T10:00:00-05:00', state: 'CA' };
    const input: RawVerifyInput = {
      weekRows: [started(config([ALPHA])), orderEvent(order)],
      factRows: [
        factRow('2026-11-09T07:00:00-05:00', 'evt_401', [
          specFact('fact_0201', 'stock_unavailable', 'ALPHA', {
            from: '2026-11-09T08:00:00-05:00',
            until: '2026-11-09T10:00:00-05:00',
          }, { medication: 'semaglutide', dose: '1mg' }),
        ]),
      ],
      decisionRows: [
        decisionRow({
          order,
          chosen: 'MANUAL',
          basis: 'manual',
          reason: 'internal_error:believed_still_unavailable',
          // 应用把 until 当闭区间，认为 10:00 仍缺货；verify 独立求值说已恢复（until 排他）
          candidates: [candidate('ALPHA', false, ['no_stock:semaglutide:1mg'], 1, 100, 2)],
        }),
      ],
      // MANUAL 是 internal_error 兜底，manual 断言本身合法；唯一失败应来自差分。
      runLogRows: [runRow(order, 'MANUAL')],
    };
    expectFailure(verifyFromRows(input), 'differential', 'ORD-X');
  });

  it('capacityLeft 不一致 → differential 失败', () => {
    const input = singleOrderInput({});
    (input.decisionRows as Array<Record<string, unknown>>)[0]!.candidates = [
      candidate('ALPHA', true, [], 1, 100, 99),
    ];
    expectFailure(verifyFromRows(input), 'differential', 'ORD-X');
  });

  it('缺失 candidates → input 失败（契约要求逐家记录）', () => {
    const input = singleOrderInput({});
    (input.decisionRows as Array<Record<string, unknown>>)[0]!.candidates = null;
    expectFailure(verifyFromRows(input), 'input', 'ORD-X');
  });
});

// ---------------------------------------------------------------------------
// 缺文件 / CLI 参数（exit 2）
// ---------------------------------------------------------------------------

describe('verify 的输入处理（缺文件 exit 2、环境变量覆盖）', () => {
  it('缺 week 文件 → InputError（exit 2）', () => {
    assert.throws(
      () =>
        runVerify({
          weekFile: '__verify_missing__/week.jsonl',
          decisionsFile: '__verify_missing__/d.jsonl',
          runLogFile: '__verify_missing__/r.jsonl',
          factsFile: '__verify_missing__/f.jsonl',
          help: false,
        }),
      (error: unknown) => error instanceof InputError && /找不到 week 文件/.test(error.message),
    );
  });

  it('缺 out/ 产物 → InputError 并提示先跑整周回放', () => {
    assert.throws(
      () =>
        runVerify({
          weekFile: 'sim/week-a.jsonl',
          decisionsFile: '__verify_missing__/decisions.jsonl',
          runLogFile: '__verify_missing__/run-log.jsonl',
          factsFile: '__verify_missing__/facts.jsonl',
          help: false,
        }),
      (error: unknown) =>
        error instanceof InputError &&
        /sim\/sim\.mjs/.test(error.message) &&
        /清空 out\//.test(error.message),
    );
  });

  it('--week / WEEK_FILE 等可覆盖默认路径，CLI 优先', () => {
    const defaults = parseOptions([], {});
    assert.equal(defaults.weekFile, 'sim/week-a.jsonl');
    assert.equal(defaults.decisionsFile, 'out/decisions.jsonl');
    assert.equal(defaults.runLogFile, 'out/run-log.jsonl');
    assert.equal(defaults.factsFile, 'out/facts.jsonl');

    const fromEnv = parseOptions([], {
      WEEK_FILE: 'w.jsonl',
      DECISIONS_FILE: 'd.jsonl',
      RUN_LOG_FILE: 'r.jsonl',
      FACTS_FILE: 'f.jsonl',
    });
    assert.deepEqual(
      [fromEnv.weekFile, fromEnv.decisionsFile, fromEnv.runLogFile, fromEnv.factsFile],
      ['w.jsonl', 'd.jsonl', 'r.jsonl', 'f.jsonl'],
    );

    const fromCli = parseOptions(
      ['--week', 'cli-week.jsonl', '--decisions', 'cli-d.jsonl'],
      { WEEK_FILE: 'env-wave.jsonl' },
    );
    assert.equal(fromCli.weekFile, 'cli-week.jsonl');
    assert.equal(fromCli.decisionsFile, 'cli-d.jsonl');
  });
});
