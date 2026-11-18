/**
 * `PharmacyBelief` / `BeliefResolver` / `BeliefDefaults` 单测
 * （`ARCHITECTURE.md` §5.5、`DATA-CONTRACTS.md` §3.3）。
 *
 * 覆盖 D2 的信念侧：
 * - 无 fact 时 INV-5 的安全侧 fallback（config 值）；
 * - 未来生效 / 过期 / 只看向 `occurred_at` 那一刻（不预检未来停业）；
 * - `failuresFor` 是唯一判定出口，固定顺序 closed → state_blocked → no_stock → capacity_full；
 * - `capacityToday` 按决策时刻求值、`capacityLeft` 不得为负、容量按 ET 日重置；
 * - `toView` 的动态字段与信念一致（不另写一份判断）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { IdSequence } from '../../src/kernel/ids.ts';
import { EtCalendar } from '../../src/kernel/time/et-calendar.ts';
import { Instant } from '../../src/kernel/time/instant.ts';
import { Interval } from '../../src/kernel/time/interval.ts';
import { CapacityLedger } from '../../src/domain/capacity/capacity-ledger.ts';
import {
  ConfigBeliefDefaults,
  DEFAULT_BELIEF_DEFAULTS,
  type BeliefDefaults,
} from '../../src/domain/belief/belief-defaults.ts';
import { BeliefResolver } from '../../src/domain/belief/belief-resolver.ts';
import { FactFactory } from '../../src/domain/facts/fact-factory.ts';
import { FactStore } from '../../src/domain/facts/fact-store.ts';
import type { FactDraft, FactType } from '../../src/domain/facts/fact.ts';
import type { NormalizedOrder } from '../../src/domain/normalize/order-normalizer.ts';
import { PharmacyBase, type PharmacyBaseInit } from '../../src/domain/pharmacy.ts';

// ---------------------------------------------------------------------------
// 共享夹具
// ---------------------------------------------------------------------------

const calendar = new EtCalendar();

const T0 = '2026-11-09T07:05:00-05:00'; // 周一
const T1 = '2026-11-09T08:00:00-05:00';
const T2 = '2026-11-09T16:00:00-05:00';
const T3 = '2026-11-10T00:00:00-05:00';
const T4 = '2026-11-10T09:00:00-05:00';

function instant(iso: string): Instant {
  const parsed = Instant.parse(iso);
  if (!parsed.ok) throw new Error(`测试夹具：非法时间 ${iso}`);
  return parsed.value;
}

function interval(fromIso: string, untilIso: string | null = null): Interval {
  const built = Interval.of(instant(fromIso), untilIso === null ? null : instant(untilIso));
  if (!built.ok) throw new Error(`测试夹具：非法区间 ${fromIso}..${untilIso}`);
  return built.value;
}

const BASE_INIT: PharmacyBaseInit = {
  id: 'ALPHA',
  name: 'Alpha Rx',
  contacts: ['ops@alpha.example'],
  openByDefault: true,
  shipsInDays: 1,
  dailyCapacity: 4,
  price: { semaglutide: 100, tirzepatide: 200 },
  blockedStates: ['FL', 'TX'],
  stock: { semaglutide: ['0.25mg'], tirzepatide: ['2.5mg', '7.5mg'] },
};

function makeBase(overrides: Partial<PharmacyBaseInit> = {}): PharmacyBase {
  return new PharmacyBase({ ...BASE_INIT, ...overrides });
}

/** 构造一条 draft（默认 ALPHA、一直有效）。 */
function draft(
  type: FactType,
  window: { from: string; until?: string | null } = { from: T0 },
  extra: Partial<FactDraft> = {},
): FactDraft {
  return {
    type,
    pharmacy: 'ALPHA',
    interval: interval(window.from, window.until ?? null),
    ...extra,
  };
}

/** 一条归一化订单（默认 CA / 2.5mg，即 ALPHA 合格的那组）。 */
function order(overrides: Partial<NormalizedOrder> = {}): NormalizedOrder {
  return {
    orderId: 'ORD-TEST-1',
    state: 'CA',
    medication: 'tirzepatide',
    dose: '2.5mg',
    ...overrides,
  };
}

interface Scenario {
  ids: IdSequence;
  facts: FactStore;
  capacity: CapacityLedger;
  resolver: BeliefResolver;
  add(drafts: readonly FactDraft[], atIso: string, eventId?: string): void;
  belief(atIso: string): ReturnType<BeliefResolver['belief']>;
  view(atIso: string): ReturnType<BeliefResolver['view']>;
  record(pharmacy: string, atIso: string): void;
}

function scenario(
  base: PharmacyBase = makeBase(),
  defaults: BeliefDefaults = DEFAULT_BELIEF_DEFAULTS,
): Scenario {
  const ids = new IdSequence();
  const factory = new FactFactory();
  const facts = new FactStore();
  const capacity = new CapacityLedger();
  const resolver = new BeliefResolver({ calendar, defaults });
  return {
    ids,
    facts,
    capacity,
    resolver,
    add(drafts, atIso, eventId = 'evt_test') {
      facts.append(factory.createAll(drafts, { eventId, at: instant(atIso), ids }));
    },
    belief(atIso) {
      return resolver.belief(base, instant(atIso), { facts, capacity });
    },
    view(atIso) {
      return resolver.view(base, instant(atIso), { facts, capacity });
    },
    record(pharmacy, atIso) {
      capacity.record(pharmacy, calendar.dateOf(instant(atIso)));
    },
  };
}

// ---------------------------------------------------------------------------
// INV-5：无 fact 时的安全侧 fallback
// ---------------------------------------------------------------------------

describe('PharmacyBelief：无 fact 时用 config fallback（INV-5）', () => {
  it('四条硬条件全部回落到 config 值', () => {
    const belief = scenario().belief(T0);
    assert.equal(belief.isOpen(), true, 'openByDefault = true');
    assert.equal(belief.shipsTo('CA'), true, 'config 没封 CA');
    assert.equal(belief.shipsTo('FL'), false, 'config 封 FL');
    assert.equal(belief.hasStock('tirzepatide', '2.5mg'), true);
    assert.equal(belief.hasStock('tirzepatide', '5mg'), false, 'config 没这个剂量');
    assert.equal(belief.hasStock('semaglutide', '1mg'), false, 'config 没这个剂量');
    assert.equal(belief.capacityToday(), 4);
    assert.equal(belief.capacityUsedToday(), 0);
    assert.equal(belief.capacityLeft(), 4);
    assert.deepEqual(belief.failuresFor(order()), []);
  });

  it('config.open = false 时无 fact 也按停业处理（安全侧）', () => {
    const belief = scenario(makeBase({ openByDefault: false })).belief(T0);
    assert.equal(belief.isOpen(), false);
    assert.deepEqual(belief.failuresFor(order()), ['closed']);
  });

  it('BeliefDefaults 可注入：自定义实现完全接管 fallback', () => {
    const custom: BeliefDefaults = {
      closure: () => false,
      coverage: () => false,
      stock: () => false,
      capacity: () => 1,
    };
    const belief = scenario(makeBase(), custom).belief(T0);
    assert.equal(belief.isOpen(), false);
    assert.equal(belief.shipsTo('CA'), false);
    assert.equal(belief.hasStock('tirzepatide', '2.5mg'), false);
    assert.equal(belief.capacityToday(), 1);
  });

  it('默认实现 ConfigBeliefDefaults 直接读 PharmacyBase', () => {
    const defaults = new ConfigBeliefDefaults();
    const base = makeBase();
    assert.equal(defaults.closure(base), true);
    assert.equal(defaults.coverage(base, 'FL'), false);
    assert.equal(defaults.coverage(base, 'CA'), true);
    assert.equal(defaults.stock(base, 'tirzepatide', '7.5mg'), true);
    assert.equal(defaults.stock(base, 'tirzepatide', '5mg'), false);
    assert.equal(defaults.capacity(base), 4);
  });
});

// ---------------------------------------------------------------------------
// 营业状态
// ---------------------------------------------------------------------------

describe('PharmacyBelief.isOpen：只看 occurred_at 那一刻', () => {
  it('closed fact 从 from 起生效，until 排他结束', () => {
    const s = scenario();
    s.add([draft('closed', { from: T1, until: T3 })], T0);
    assert.equal(s.belief(T0).isOpen(), true, 'T0 还没生效');
    assert.equal(s.belief(T1).isOpen(), false);
    assert.equal(s.belief(T2).isOpen(), false);
    assert.equal(s.belief(T3).isOpen(), true, 'until 排他，T3 已恢复');
  });

  it('reopened 覆盖先前的 closed（同 cell 最后断言者胜）', () => {
    const s = scenario();
    s.add([draft('closed', { from: T0 })], T0);
    assert.equal(s.belief(T1).isOpen(), false);
    s.add([draft('reopened', { from: T2 })], T2);
    assert.equal(s.belief(T1).isOpen(), false, 'T1 仍在 reopened 生效之前');
    assert.equal(s.belief(T2).isOpen(), true);
  });

  it('明天停业不影响今天的单（不预检未来，§16-Q13）', () => {
    const s = scenario();
    s.add([draft('closed', { from: T3 })], T0);
    assert.equal(s.belief(T0).isOpen(), true);
    assert.equal(s.belief(T2).isOpen(), true, '11-09 当天仍营业');
    assert.equal(s.belief(T3).isOpen(), false, '11-10 00:00 起停业');
  });
});

// ---------------------------------------------------------------------------
// 州覆盖 / 库存
// ---------------------------------------------------------------------------

describe('PharmacyBelief：州覆盖与库存的 fact 覆盖', () => {
  it('state_blocked 立即生效、state_allowed 解除封锁', () => {
    const s = scenario();
    s.add([draft('state_blocked', { from: T0 }, { state: 'CA' })], T0);
    assert.equal(s.belief(T0).shipsTo('CA'), false);
    s.add([draft('state_allowed', { from: T1 }, { state: 'CA' })], T1);
    assert.equal(s.belief(T0).shipsTo('CA'), false, 'T0 仍在封锁期');
    assert.equal(s.belief(T1).shipsTo('CA'), true, 'T1 起解除');
  });

  it('state_blocked 的 until 到期后回落到 config', () => {
    const s = scenario();
    s.add([draft('state_blocked', { from: T0, until: T3 }, { state: 'CA' })], T0);
    assert.equal(s.belief(T2).shipsTo('CA'), false);
    assert.equal(s.belief(T3).shipsTo('CA'), true, 'until 排他 → 恢复 config 的「可发」');
  });

  it('stock_unavailable 精确到剂量；其他剂量不受影响', () => {
    const s = scenario();
    s.add([draft('stock_unavailable', { from: T0 }, { medication: 'tirzepatide', dose: '2.5mg' })], T0);
    const belief = s.belief(T0);
    assert.equal(belief.hasStock('tirzepatide', '2.5mg'), false);
    assert.equal(belief.hasStock('tirzepatide', '7.5mg'), true);
    assert.deepEqual(belief.failuresFor(order()), ['no_stock:tirzepatide:2.5mg']);
  });

  it('stock_unavailable 过期后回落到 config 的现货（不是「永久缺货」）', () => {
    const s = scenario();
    s.add(
      [draft('stock_unavailable', { from: T0, until: T3 }, { medication: 'tirzepatide', dose: '2.5mg' })],
      T0,
    );
    assert.equal(s.belief(T2).hasStock('tirzepatide', '2.5mg'), false);
    assert.equal(s.belief(T3).hasStock('tirzepatide', '2.5mg'), true);
  });
});

// ---------------------------------------------------------------------------
// 容量
// ---------------------------------------------------------------------------

describe('PharmacyBelief：容量按决策时刻求值', () => {
  it('capacity fact 从 from 起覆盖 config，until 到期后回落', () => {
    const s = scenario();
    s.add([draft('capacity', { from: T1, until: T3 }, { perDay: 2 })], T0);
    assert.equal(s.belief(T0).capacityToday(), 4, 'T0 在 capacity 生效之前');
    assert.equal(s.belief(T1).capacityToday(), 2);
    assert.equal(s.belief(T2).capacityToday(), 2);
    assert.equal(s.belief(T3).capacityToday(), 4, 'until 排他 → 回落 config');
  });

  it('capacityUsedToday 只算同一 ET 日、同一药房', () => {
    const s = scenario();
    s.record('ALPHA', T1);
    s.record('ALPHA', T2);
    s.record('BETA', T1); // 别家药房的单不算到 ALPHA
    s.record('ALPHA', T4); // 次日不算到 11-09

    const today = s.belief(T2);
    assert.equal(today.capacityUsedToday(), 2);
    assert.equal(today.capacityLeft(), 2);
    // 同一 ET 日内的更早时刻看到的是同一个桶（计数按日期，不按事件时刻）。
    assert.equal(s.belief(T0).capacityUsedToday(), 2);
    assert.equal(s.belief(T4).capacityUsedToday(), 1);
  });

  it('capacityLeft 不得为负（容量下调到低于已发数 → 当天立即停接，不追回）', () => {
    const s = scenario();
    for (let i = 0; i < 4; i += 1) s.record('ALPHA', T1);
    s.add([draft('capacity', { from: T1 }, { perDay: 2 })], T1, 'evt_capacity');
    const belief = s.belief(T2);
    assert.equal(belief.capacityToday(), 2);
    assert.equal(belief.capacityUsedToday(), 4);
    assert.equal(belief.capacityLeft(), 0, 'max(0, 2 - 4) = 0，不是 -2');
    assert.deepEqual(belief.failuresFor(order()), ['capacity_full']);
  });

  it('容量用完后 capacity_full；dailyCapacity = 0 时始终 capacity_full', () => {
    const s = scenario();
    s.record('ALPHA', T1);
    s.record('ALPHA', T1);
    s.record('ALPHA', T1);
    s.record('ALPHA', T1);
    assert.deepEqual(s.belief(T1).failuresFor(order()), ['capacity_full']);

    const zeroCapacity = scenario(makeBase({ dailyCapacity: 0 })).belief(T0);
    assert.equal(zeroCapacity.capacityLeft(), 0);
    assert.deepEqual(zeroCapacity.failuresFor(order()), ['capacity_full']);
  });
});

// ---------------------------------------------------------------------------
// failuresFor：唯一判定出口
// ---------------------------------------------------------------------------

describe('PharmacyBelief.failuresFor：固定顺序的失败码', () => {
  it('四条同时不过时顺序固定：closed → state_blocked → no_stock → capacity_full', () => {
    const s = scenario(makeBase({ openByDefault: false, dailyCapacity: 1 }));
    // 让 11-10 变成「停业 + 封 FL + 缺 5mg + 容量已满」的同一时刻。
    s.add([draft('closed', { from: T3 })], T0);
    s.add([draft('state_blocked', { from: T3 }, { state: 'FL' })], T0);
    s.add([draft('stock_unavailable', { from: T3 }, { medication: 'tirzepatide', dose: '7.5mg' })], T0);
    s.record('ALPHA', T3);

    const failures = s.belief(T4).failuresFor(
      order({ state: 'FL', medication: 'tirzepatide', dose: '7.5mg' }),
    );
    assert.deepEqual(failures, [
      'closed',
      'state_blocked:FL',
      'no_stock:tirzepatide:7.5mg',
      'capacity_full',
    ]);
  });

  it('只返回实际不过的项，顺序仍固定', () => {
    const s = scenario();
    s.add([draft('state_blocked', { from: T0 }, { state: 'FL' })], T0);
    s.add([draft('stock_unavailable', { from: T0 }, { medication: 'tirzepatide', dose: '7.5mg' })], T0);
    assert.deepEqual(
      s.belief(T0).failuresFor(order({ state: 'FL', medication: 'tirzepatide', dose: '7.5mg' })),
      ['state_blocked:FL', 'no_stock:tirzepatide:7.5mg'],
    );
    assert.deepEqual(s.belief(T0).failuresFor(order()), []);
    assert.deepEqual(
      s.belief(T0).failuresFor(order({ state: 'FL', medication: 'tirzepatide', dose: '2.5mg' })),
      ['state_blocked:FL'],
    );
    assert.deepEqual(
      s.belief(T0).failuresFor(order({ medication: 'tirzepatide', dose: '7.5mg' })),
      ['no_stock:tirzepatide:7.5mg'],
    );
  });
});

// ---------------------------------------------------------------------------
// toView
// ---------------------------------------------------------------------------

describe('PharmacyBelief.toView：展示 DTO 与信念一致', () => {
  it('无 fact 时是 config + 当前 open/容量', () => {
    const s = scenario();
    s.record('ALPHA', T1);
    assert.deepEqual(s.view(T2), {
      id: 'ALPHA',
      name: 'Alpha Rx',
      openNow: true,
      shipsInDays: 1,
      capacityToday: 4,
      capacityUsedToday: 1,
      capacityLeft: 3,
      price: { semaglutide: 100, tirzepatide: 200 },
      blockedStates: ['FL', 'TX'],
      stock: { semaglutide: ['0.25mg'], tirzepatide: ['2.5mg', '7.5mg'] },
    });
  });

  it('动态字段跟随信念：closed / capacity / 库存缺货 / 州封锁解除', () => {
    const s = scenario();
    s.add(
      [
        draft('closed', { from: T1 }),
        draft('capacity', { from: T1 }, { perDay: 2 }),
        draft('stock_unavailable', { from: T1 }, { medication: 'tirzepatide', dose: '2.5mg' }),
        draft('state_allowed', { from: T1 }, { state: 'FL' }),
      ],
      T0,
    );
    const view = s.view(T2);
    assert.equal(view.openNow, false);
    assert.equal(view.capacityToday, 2);
    assert.deepEqual(view.blockedStates, ['TX'], 'FL 被 state_allowed 解除');
    assert.deepEqual(view.stock, {
      semaglutide: ['0.25mg'],
      tirzepatide: ['7.5mg'],
    });
    // 求值时刻之前的视图仍按当时信念。
    assert.equal(s.view(T0).openNow, true);
  });

  it('fact 新封锁 config 之外的州、新断言 config 之外的现货，也出现在视图里', () => {
    const s = scenario();
    s.add(
      [
        draft('state_blocked', { from: T0 }, { state: 'NY' }),
        draft('stock_available', { from: T0 }, { medication: 'tirzepatide', dose: '5mg' }),
      ],
      T0,
    );
    const view = s.view(T0);
    assert.deepEqual(view.blockedStates, ['FL', 'TX', 'NY']);
    assert.deepEqual(view.stock, {
      semaglutide: ['0.25mg'],
      tirzepatide: ['2.5mg', '7.5mg', '5mg'],
    });
  });

  it('view() 就是 belief().toView()，不另写判断', () => {
    const s = scenario();
    s.add([draft('closed', { from: T1 })], T0);
    s.record('ALPHA', T1);
    assert.deepEqual(s.view(T2), s.belief(T2).toView());
  });
});
