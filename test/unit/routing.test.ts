/**
 * 纯函数路由层单测：`EligibilityFilter` / `PreferenceResolver` / `CandidateRanker` /
 * `OrderRouter` / `ManualReasonBuilder`（`ARCHITECTURE.md` §5.7、§12.2、
 * `REQUIREMENTS.md` §2/§5/§10、`DATA-CONTRACTS.md` §3.3/§3.4）。
 *
 * 覆盖 §12.2 点名的 D3 场景：
 * - 候选为空 → `manual`，reason 逐家点名失败码；
 * - 偏好命中 → `ops_preference`，`preference` 记录生效的那条；
 * - 偏好药房被 blocked / 容量满 → `rank` + `override`（容量属于安全）；
 * - 两条偏好各指一家且都合格 → 取**偏好顺序**（特异性 → 后断言 → seq）先出现者，
 *   而不是排名最高者；
 * - 三键平局（速度、价格相同）→ pharmacy id 最小；
 * - 同一输入两次调用逐字段相同（确定性）。
 *
 * 额外钉住的边界（任务要求）：
 * - 偏好指向 beliefs 里不存在的药房 → 未命中（rank + override 里的 `unknown_pharmacy`）；
 * - 偏好 `interval` 不覆盖 `at` → 视为不存在（无 override）。
 *
 * test/ 不在 week A 字面量守卫范围内，这里用真实风格的值即可。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { IdSequence } from '../../src/kernel/ids.ts';
import { EtCalendar } from '../../src/kernel/time/et-calendar.ts';
import { Instant } from '../../src/kernel/time/instant.ts';
import { Interval } from '../../src/kernel/time/interval.ts';
import { CapacityLedger } from '../../src/domain/capacity/capacity-ledger.ts';
import { DEFAULT_BELIEF_DEFAULTS } from '../../src/domain/belief/belief-defaults.ts';
import { BeliefResolver } from '../../src/domain/belief/belief-resolver.ts';
import type { PharmacyBelief } from '../../src/domain/belief/pharmacy-belief.ts';
import { FactFactory } from '../../src/domain/facts/fact-factory.ts';
import { FactStore } from '../../src/domain/facts/fact-store.ts';
import type { Fact, FactDraft } from '../../src/domain/facts/fact.ts';
import type { NormalizedOrder } from '../../src/domain/normalize/order-normalizer.ts';
import { PharmacyBase } from '../../src/domain/pharmacy.ts';
import type { PharmacyBaseInit } from '../../src/domain/pharmacy.ts';
import type { CandidateEvaluation, RoutingDecision } from '../../src/domain/routing/decision.ts';
import { EligibilityFilter } from '../../src/domain/routing/eligibility.ts';
import { PreferenceResolver } from '../../src/domain/routing/preferences.ts';
import { CandidateRanker } from '../../src/domain/routing/ranker.ts';
import { ManualReasonBuilder, OrderRouter } from '../../src/domain/routing/router.ts';

// ---------------------------------------------------------------------------
// 共享夹具
// ---------------------------------------------------------------------------

const calendar = new EtCalendar();

/** 决策时刻（周一 ET 上午）。 */
const T0 = '2026-11-09T09:00:00-05:00';
/** 足够早的区间起点，用来构造「一直有效」的否定类 fact。 */
const T_CLOSED_FROM = '2026-11-08T00:00:00-05:00';
const T_EARLY = '2026-11-09T07:00:00-05:00';
const T_LATE = '2026-11-09T08:00:00-05:00';
/** 决策时刻之后：用来证明「区间不覆盖 at 的偏好不生效」。 */
const T_FUTURE = '2026-11-10T00:00:00-05:00';

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
  id: 'AAA',
  name: 'Aaa Rx',
  contacts: ['team@aaa.example'],
  openByDefault: true,
  shipsInDays: 1,
  dailyCapacity: 4,
  price: { semaglutide: 100, tirzepatide: 200 },
  blockedStates: [],
  stock: {
    semaglutide: ['0.25mg', '0.5mg', '1mg'],
    tirzepatide: ['2.5mg', '7.5mg'],
  },
};

/** 一家默认完全合格的药房；id/名字/联系人随 id 变。 */
function makeBase(id: string, overrides: Partial<PharmacyBaseInit> = {}): PharmacyBase {
  return new PharmacyBase({
    ...BASE_INIT,
    id,
    name: `${id} Rx`,
    contacts: [`team@${id.toLowerCase()}.example`],
    ...overrides,
  });
}

/** 一张默认能被默认药房接下的归一化订单。 */
function makeOrder(overrides: Partial<NormalizedOrder> = {}): NormalizedOrder {
  return {
    orderId: 'ORD-TEST-1',
    state: 'CA',
    medication: 'tirzepatide',
    dose: '2.5mg',
    ...overrides,
  };
}

/** 手工构造的候选评估（只给需要断言的字段）。 */
function evalOf(overrides: Partial<CandidateEvaluation> = {}): CandidateEvaluation {
  return {
    pharmacy: 'AAA',
    eligible: true,
    shipsInDays: 1,
    price: 100,
    capacityLeft: 1,
    failures: [],
    ...overrides,
  };
}

interface PreferenceOptions {
  pharmacy: string;
  medication: string;
  dose?: string;
  state?: string;
  from?: string;
  until?: string | null;
  assertedAt?: string;
  eventId?: string;
}

interface Harness {
  facts: FactStore;
  capacity: CapacityLedger;
  add(drafts: readonly FactDraft[], atIso?: string, eventId?: string): void;
  preference(options: PreferenceOptions): Fact;
  belief(base: PharmacyBase, atIso?: string): PharmacyBelief;
  record(pharmacy: string, atIso?: string): void;
}

/** 信念/事实/容量的共享夹具：所有药房同一份 facts + capacity，按 at 求值。 */
function createHarness(): Harness {
  const ids = new IdSequence();
  const factory = new FactFactory();
  const facts = new FactStore();
  const capacity = new CapacityLedger();
  const resolver = new BeliefResolver({ calendar, defaults: DEFAULT_BELIEF_DEFAULTS });
  return {
    facts,
    capacity,
    add(drafts, atIso = T0, eventId = 'evt_state') {
      facts.append(factory.createAll(drafts, { eventId, at: instant(atIso), ids }));
    },
    preference(options) {
      const draft: FactDraft = {
        type: 'routing_preference',
        pharmacy: options.pharmacy,
        medication: options.medication,
        interval: interval(options.from ?? T0, options.until ?? null),
        ...(options.dose === undefined ? {} : { dose: options.dose }),
        ...(options.state === undefined ? {} : { state: options.state }),
      };
      return factory.create(draft, {
        eventId: options.eventId ?? 'evt_pref',
        at: instant(options.assertedAt ?? T0),
        ids,
      });
    },
    belief(base, atIso = T0) {
      return resolver.belief(base, instant(atIso), { facts, capacity });
    },
    record(pharmacy, atIso = T0) {
      capacity.record(pharmacy, calendar.dateOf(instant(atIso)));
    },
  };
}

function newRouter(): OrderRouter {
  return new OrderRouter({
    filter: new EligibilityFilter(),
    prefs: new PreferenceResolver(),
    ranker: new CandidateRanker(),
  });
}

/** 标准调用：beliefs 按传入 bases 的顺序（调用方负责按 id 升序给）。 */
function routeWith(
  h: Harness,
  bases: readonly PharmacyBase[],
  preferences: readonly Fact[] = [],
  orderOverrides: Partial<NormalizedOrder> = {},
  atIso: string = T0,
): RoutingDecision {
  return newRouter().route({
    order: makeOrder(orderOverrides),
    at: instant(atIso),
    beliefs: bases.map((base) => h.belief(base, atIso)),
    preferences,
  });
}

/** 取一条非偏好 fact（用来验证 `PreferenceResolver` 会忽略它）。 */
function firstFactOf(h: Harness, pharmacy: string, type: 'closed'): Fact {
  const fact = h.facts.factsOf(pharmacy, type)[0];
  if (fact === undefined) assert.fail(`夹具缺少 ${pharmacy} 的 ${type} fact`);
  return fact;
}

// ---------------------------------------------------------------------------
// EligibilityFilter（§5.7：资格评估只调 belief.failuresFor，不重复四条判断）
// ---------------------------------------------------------------------------

describe('EligibilityFilter', () => {
  it('eligible = failures 为空；速度/价格/剩余容量来自信念', () => {
    const h = createHarness();
    const evaluation = new EligibilityFilter().evaluate(h.belief(makeBase('AAA')), makeOrder());
    assert.deepEqual(evaluation, {
      pharmacy: 'AAA',
      eligible: true,
      shipsInDays: 1,
      price: 200,
      capacityLeft: 4,
      failures: [],
    });
  });

  it('failures 顺序固定；价格缺失 → null；容量为 0 → capacity_full', () => {
    const h = createHarness();
    const base = makeBase('DDD', {
      openByDefault: false,
      blockedStates: ['CA'],
      dailyCapacity: 0,
      price: { semaglutide: 100 }, // 没有 tirzepatide 价格
      stock: { semaglutide: ['0.25mg'], tirzepatide: [] },
    });
    const evaluation = new EligibilityFilter().evaluate(h.belief(base), makeOrder());
    assert.equal(evaluation.eligible, false);
    assert.deepEqual(evaluation.failures, [
      'closed',
      'state_blocked:CA',
      'no_stock:tirzepatide:2.5mg',
      'capacity_full',
    ]);
    assert.equal(evaluation.price, null);
    assert.equal(evaluation.capacityLeft, 0);
  });
});

// ---------------------------------------------------------------------------
// CandidateRanker（§5.7：shipsInDays → price(null 最后) → id；平局键确定性）
// ---------------------------------------------------------------------------

describe('CandidateRanker', () => {
  it('compare：速度 → 价格（null 排最后）→ pharmacy id', () => {
    const ranker = new CandidateRanker();
    const fastExpensive = evalOf({ pharmacy: 'AAA', shipsInDays: 1, price: 200 });
    const slowCheap = evalOf({ pharmacy: 'BBB', shipsInDays: 2, price: 100 });
    const fastCheap = evalOf({ pharmacy: 'CCC', shipsInDays: 1, price: 100 });
    const fastUnknownPrice = evalOf({ pharmacy: 'DDD', shipsInDays: 1, price: null });

    assert.ok(ranker.compare(fastExpensive, slowCheap) < 0, '速度优先于价格');
    assert.ok(ranker.compare(fastCheap, fastExpensive) < 0, '同速时更便宜者优先');
    assert.ok(ranker.compare(fastUnknownPrice, fastCheap) > 0, 'null 价格排最后');
    assert.ok(ranker.compare(evalOf({ pharmacy: 'BBB' }), evalOf({ pharmacy: 'CCC' })) < 0);
    assert.equal(ranker.compare(evalOf({ pharmacy: 'BBB' }), evalOf({ pharmacy: 'BBB' })), 0);
  });

  it('best：空池 undefined；三键全同时取 id 最小，且与池顺序无关', () => {
    const ranker = new CandidateRanker();
    const bbb = evalOf({ pharmacy: 'BBB' });
    const ccc = evalOf({ pharmacy: 'CCC' });
    assert.equal(ranker.best([]), undefined);
    assert.equal(ranker.best([ccc, bbb])?.pharmacy, 'BBB');
    assert.equal(ranker.best([bbb, ccc])?.pharmacy, 'BBB');
  });
});

// ---------------------------------------------------------------------------
// ManualReasonBuilder（§5.7：固定格式、按 pharmacy id 排序）
// ---------------------------------------------------------------------------

describe('ManualReasonBuilder', () => {
  it('固定格式，按 pharmacy id 升序；空数组有稳定文案', () => {
    const builder = new ManualReasonBuilder();
    const reason = builder.build([
      evalOf({ pharmacy: 'BBB', eligible: false, failures: ['no_stock:tirzepatide:5mg'] }),
      evalOf({ pharmacy: 'AAA', eligible: false, failures: ['closed'] }),
    ]);
    assert.equal(reason, 'no eligible pharmacy: AAA(closed); BBB(no_stock:tirzepatide:5mg)');
    assert.equal(builder.build([]), 'no eligible pharmacy: none');
  });
});

// ---------------------------------------------------------------------------
// PreferenceResolver（§5.7、§16-Q1、REQUIREMENTS §10：通配 + 特异性排序）
// ---------------------------------------------------------------------------

describe('PreferenceResolver', () => {
  it('matches：medication 必须相等；dose/state 缺省 = 通配', () => {
    const h = createHarness();
    const resolver = new PreferenceResolver();
    const wildcard = h.preference({ pharmacy: 'AAA', medication: 'tirzepatide' });
    assert.equal(resolver.matches(wildcard, makeOrder()), true);
    assert.equal(resolver.matches(wildcard, makeOrder({ dose: '7.5mg' })), true, 'dose 通配');
    assert.equal(resolver.matches(wildcard, makeOrder({ state: 'TX' })), true, 'state 通配');
    assert.equal(
      resolver.matches(wildcard, makeOrder({ medication: 'semaglutide' })),
      false,
      'medication 必须相等',
    );

    const doseOnly = h.preference({ pharmacy: 'AAA', medication: 'tirzepatide', dose: '2.5mg' });
    assert.equal(resolver.matches(doseOnly, makeOrder()), true);
    assert.equal(resolver.matches(doseOnly, makeOrder({ dose: '7.5mg' })), false);

    const stateOnly = h.preference({ pharmacy: 'AAA', medication: 'tirzepatide', state: 'CA' });
    assert.equal(resolver.matches(stateOnly, makeOrder()), true);
    assert.equal(resolver.matches(stateOnly, makeOrder({ state: 'TX' })), false);
  });

  it('matches：非 routing_preference 的 fact 一律不匹配', () => {
    const h = createHarness();
    h.add([{ type: 'closed', pharmacy: 'AAA', interval: interval(T_CLOSED_FROM) }]);
    const closed = firstFactOf(h, 'AAA', 'closed');
    assert.equal(new PreferenceResolver().matches(closed, makeOrder()), false);
  });

  it('active：只含 routing_preference、区间覆盖 at、匹配订单；按特异性 → assertedAt → seq 排序', () => {
    const h = createHarness();
    const resolver = new PreferenceResolver();
    h.add([{ type: 'closed', pharmacy: 'AAA', interval: interval(T_CLOSED_FROM) }]);
    const closed = firstFactOf(h, 'AAA', 'closed');

    // 特异性 2（dose），断言较早；另一条通配、断言较晚 → 特异性高者仍排前面。
    const specific = h.preference({
      pharmacy: 'CCC',
      medication: 'tirzepatide',
      dose: '2.5mg',
      assertedAt: T_EARLY,
      from: T_EARLY,
      eventId: 'evt_pref_specific',
    });
    const wildcard = h.preference({
      pharmacy: 'BBB',
      medication: 'tirzepatide',
      assertedAt: T_LATE,
      from: T_LATE,
      eventId: 'evt_pref_wildcard',
    });
    // 未来生效、药品不匹配、非偏好 fact：都不该进 active。
    const future = h.preference({
      pharmacy: 'AAA',
      medication: 'tirzepatide',
      from: T_FUTURE,
      eventId: 'evt_pref_future',
    });
    const otherMedication = h.preference({
      pharmacy: 'AAA',
      medication: 'semaglutide',
      eventId: 'evt_pref_other_medication',
    });

    const active = resolver.active(
      [closed, wildcard, future, specific, otherMedication],
      makeOrder(),
      instant(T0),
    );
    assert.deepEqual(
      active.map((preference) => preference.fact.eventId),
      ['evt_pref_specific', 'evt_pref_wildcard'],
    );
    assert.deepEqual(
      active.map((preference) => preference.specificity),
      [2, 0],
    );
  });

  it('active：同特异性时后断言者优先；同刻断言时 seq 大者优先', () => {
    const h = createHarness();
    const resolver = new PreferenceResolver();
    const early = h.preference({
      pharmacy: 'BBB',
      medication: 'tirzepatide',
      assertedAt: T_EARLY,
      from: T_EARLY,
      eventId: 'evt_pref_early',
    });
    const late = h.preference({
      pharmacy: 'AAA',
      medication: 'tirzepatide',
      assertedAt: T_LATE,
      from: T_LATE,
      eventId: 'evt_pref_late',
    });
    assert.deepEqual(
      resolver.active([early, late], makeOrder(), instant(T0)).map((p) => p.fact.eventId),
      ['evt_pref_late', 'evt_pref_early'],
      'assertedAt 降序',
    );

    // 同一断言时刻：Factory 按创建顺序领 seq，后创建者 seq 更大。
    const firstSeq = h.preference({
      pharmacy: 'BBB',
      medication: 'tirzepatide',
      assertedAt: T_LATE,
      from: T_LATE,
      eventId: 'evt_pref_seq_small',
    });
    const secondSeq = h.preference({
      pharmacy: 'AAA',
      medication: 'tirzepatide',
      assertedAt: T_LATE,
      from: T_LATE,
      eventId: 'evt_pref_seq_large',
    });
    assert.deepEqual(
      resolver.active([firstSeq, secondSeq], makeOrder(), instant(T0)).map((p) => p.fact.eventId),
      ['evt_pref_seq_large', 'evt_pref_seq_small'],
      'seq 降序',
    );
  });
});

// ---------------------------------------------------------------------------
// OrderRouter（§5.7 判定顺序）
// ---------------------------------------------------------------------------

describe('OrderRouter.route：候选为空 → MANUAL', () => {
  it('逐家点名失败码（按 id 排序），有偏好也只记 manual（INV-5 / §16-Q12）', () => {
    const h = createHarness();
    h.add([{ type: 'closed', pharmacy: 'AAA', interval: interval(T_CLOSED_FROM) }]);
    h.record('EEE'); // EEE 容量 1，已发 1 → capacity_full
    const bases = [
      makeBase('AAA'),
      makeBase('DDD', { blockedStates: ['CA'] }),
      makeBase('EEE', { dailyCapacity: 1 }),
    ];
    const preferences = [
      h.preference({ pharmacy: 'AAA', medication: 'tirzepatide', eventId: 'evt_pref_1' }),
    ];

    const decision = routeWith(h, bases, preferences);

    assert.equal(decision.orderId, 'ORD-TEST-1');
    assert.equal(decision.at.epochMs, instant(T0).epochMs);
    assert.deepEqual(decision.order, makeOrder());
    assert.equal(decision.chosen, 'MANUAL');
    assert.equal(decision.basis, 'manual');
    assert.equal(
      decision.reason,
      'no eligible pharmacy: AAA(closed); DDD(state_blocked:CA); EEE(capacity_full)',
    );
    // evals 顺序 = 传入 beliefs 的顺序；候选集为空，所以全部是 ineligible。
    assert.deepEqual(
      decision.candidates.map((evaluation) => evaluation.pharmacy),
      ['AAA', 'DDD', 'EEE'],
    );
    assert.equal(
      decision.candidates.every((evaluation) => !evaluation.eligible),
      true,
    );
    assert.equal(decision.preference, null);
    assert.equal(decision.override, null, '候选为空时不记 override');
    assert.equal(decision.sent, null);
  });
});

describe('OrderRouter.route：偏好命中 → ops_preference', () => {
  it('选偏好药房（即使它不是排名最高者），preference 记录生效的那条', () => {
    const h = createHarness();
    const bases = [
      makeBase('AAA', { shipsInDays: 3, price: { semaglutide: 100, tirzepatide: 300 } }),
      makeBase('BBB', { shipsInDays: 1, price: { semaglutide: 100, tirzepatide: 100 } }),
    ];
    const preferences = [
      h.preference({
        pharmacy: 'AAA',
        medication: 'tirzepatide',
        state: 'CA',
        eventId: 'evt_pref_hit',
      }),
    ];

    const decision = routeWith(h, bases, preferences);

    assert.equal(decision.chosen, 'AAA', '偏好优先于排名');
    assert.equal(decision.basis, 'ops_preference');
    assert.deepEqual(decision.preference, { pharmacy: 'AAA', eventId: 'evt_pref_hit' });
    assert.equal(decision.override, null);
    assert.ok(decision.reason?.includes('AAA'));
    assert.ok(decision.reason?.includes('3 days'), 'reason 含速度');
    assert.ok(decision.reason?.includes('$300'), 'reason 含价格');
  });
});

describe('OrderRouter.route：偏好未命中 → rank + override', () => {
  it('偏好药房被 state_blocked → 回落 + override 点名失败码', () => {
    const h = createHarness();
    const bases = [
      makeBase('AAA', { shipsInDays: 3 }),
      makeBase('BBB', { shipsInDays: 2 }),
      makeBase('DDD', { blockedStates: ['CA'] }),
    ];
    const preferences = [
      h.preference({ pharmacy: 'DDD', medication: 'tirzepatide', eventId: 'evt_pref_blocked' }),
    ];

    const decision = routeWith(h, bases, preferences);

    assert.equal(decision.basis, 'rank');
    assert.equal(decision.chosen, 'BBB', '安全候选中排名最前');
    assert.equal(decision.preference, null, '生效的是回落后的药房');
    assert.ok(decision.override !== null);
    assert.ok(decision.override.startsWith('ops preferred DDD but: '));
    assert.ok(decision.override.includes('DDD'));
    assert.ok(decision.override.includes('state_blocked:CA'));
    assert.ok(decision.reason?.includes('BBB'));
    assert.ok(decision.reason?.includes('2 days'));
  });

  it('偏好药房容量满 → 同样回落（容量属于安全）', () => {
    const h = createHarness();
    h.record('EEE'); // EEE 容量 1、已发 1
    const bases = [
      makeBase('BBB', { shipsInDays: 2 }),
      makeBase('EEE', { dailyCapacity: 1 }),
    ];
    const preferences = [
      h.preference({ pharmacy: 'EEE', medication: 'tirzepatide', eventId: 'evt_pref_full' }),
    ];

    const decision = routeWith(h, bases, preferences);

    assert.equal(decision.basis, 'rank');
    assert.equal(decision.chosen, 'BBB');
    assert.equal(decision.preference, null);
    assert.ok(decision.override !== null);
    assert.ok(decision.override.includes('capacity_full'));
    assert.equal(decision.candidates.find((evaluation) => evaluation.pharmacy === 'EEE')?.capacityLeft, 0);
  });
});

describe('OrderRouter.route：两条偏好都合格 → 取偏好顺序，不是排名最高者', () => {
  it('特异性高者优先（dose+state > 通配），即使它更慢更贵', () => {
    const h = createHarness();
    const bases = [
      makeBase('BBB', { shipsInDays: 1, price: { semaglutide: 100, tirzepatide: 100 } }),
      makeBase('CCC', { shipsInDays: 4, price: { semaglutide: 100, tirzepatide: 400 } }),
    ];
    const wildcard = h.preference({
      pharmacy: 'BBB',
      medication: 'tirzepatide',
      assertedAt: T_LATE,
      from: T_LATE,
      eventId: 'evt_pref_wildcard',
    });
    const specific = h.preference({
      pharmacy: 'CCC',
      medication: 'tirzepatide',
      dose: '2.5mg',
      state: 'CA',
      eventId: 'evt_pref_specific',
    });

    const decision = routeWith(h, bases, [wildcard, specific]);

    assert.equal(decision.chosen, 'CCC');
    assert.equal(decision.basis, 'ops_preference');
    assert.deepEqual(decision.preference, { pharmacy: 'CCC', eventId: 'evt_pref_specific' });
    assert.equal(decision.override, null);
  });

  it('同特异性时后断言者优先', () => {
    const h = createHarness();
    const bases = [
      makeBase('BBB', { shipsInDays: 1 }),
      makeBase('AAA', { shipsInDays: 3 }),
    ];
    const early = h.preference({
      pharmacy: 'BBB',
      medication: 'tirzepatide',
      assertedAt: T_EARLY,
      from: T_EARLY,
      eventId: 'evt_pref_early',
    });
    const late = h.preference({
      pharmacy: 'AAA',
      medication: 'tirzepatide',
      assertedAt: T_LATE,
      from: T_LATE,
      eventId: 'evt_pref_late',
    });

    const decision = routeWith(h, bases, [early, late]);

    assert.equal(decision.chosen, 'AAA');
    assert.equal(decision.basis, 'ops_preference');
    assert.deepEqual(decision.preference, { pharmacy: 'AAA', eventId: 'evt_pref_late' });
  });

  it('同特异性同断言时刻时 seq 大者优先', () => {
    const h = createHarness();
    const bases = [
      makeBase('BBB', { shipsInDays: 1 }),
      makeBase('AAA', { shipsInDays: 3 }),
    ];
    const firstSeq = h.preference({
      pharmacy: 'BBB',
      medication: 'tirzepatide',
      assertedAt: T_LATE,
      from: T_LATE,
      eventId: 'evt_pref_seq_small',
    });
    const secondSeq = h.preference({
      pharmacy: 'AAA',
      medication: 'tirzepatide',
      assertedAt: T_LATE,
      from: T_LATE,
      eventId: 'evt_pref_seq_large',
    });

    const decision = routeWith(h, bases, [firstSeq, secondSeq]);

    assert.equal(decision.chosen, 'AAA');
    assert.deepEqual(decision.preference, { pharmacy: 'AAA', eventId: 'evt_pref_seq_large' });
  });
});

describe('OrderRouter.route：确定性与平局', () => {
  it('三键平局（速度同、价格同）→ pharmacy id 最小，与 beliefs 传入顺序无关', () => {
    const h = createHarness();
    const bbb = makeBase('BBB', { shipsInDays: 2 });
    const ccc = makeBase('CCC', { shipsInDays: 2 });

    const forward = routeWith(h, [bbb, ccc]);
    assert.equal(forward.chosen, 'BBB');
    assert.equal(forward.basis, 'rank');
    assert.deepEqual(
      forward.candidates.map((evaluation) => evaluation.pharmacy),
      ['BBB', 'CCC'],
      'evals 保持传入顺序',
    );

    // 传入顺序反过来，排名结果仍由 id 平局键决定。
    const reversed = routeWith(h, [ccc, bbb]);
    assert.equal(reversed.chosen, 'BBB');
    assert.deepEqual(
      reversed.candidates.map((evaluation) => evaluation.pharmacy),
      ['CCC', 'BBB'],
    );
    assert.ok(forward.reason?.includes('2 days'));
  });

  it('同一输入两次调用 → 决策逐字段相同（纯函数）', () => {
    const h = createHarness();
    h.add([{ type: 'closed', pharmacy: 'AAA', interval: interval(T_CLOSED_FROM) }]);
    const bases = [
      makeBase('AAA', { shipsInDays: 3 }),
      makeBase('BBB', { shipsInDays: 2 }),
      makeBase('DDD', { blockedStates: ['CA'] }),
    ];
    const preferences = [
      h.preference({ pharmacy: 'DDD', medication: 'tirzepatide', eventId: 'evt_pref_blocked' }),
    ];

    const first = routeWith(h, bases, preferences);
    const second = routeWith(h, bases, preferences);

    assert.deepEqual(second, first);
  });
});

describe('OrderRouter.route：偏好指向未知药房 / 区间未覆盖', () => {
  it('偏好药房不在 beliefs 里 → 未命中（rank + override 里的 unknown_pharmacy）', () => {
    const h = createHarness();
    const bases = [makeBase('AAA', { shipsInDays: 3 }), makeBase('BBB', { shipsInDays: 2 })];
    const preferences = [
      h.preference({ pharmacy: 'ZZZ', medication: 'tirzepatide', eventId: 'evt_pref_unknown' }),
    ];

    const decision = routeWith(h, bases, preferences);

    assert.equal(decision.basis, 'rank');
    assert.equal(decision.chosen, 'BBB');
    assert.equal(decision.preference, null);
    assert.ok(decision.override !== null);
    assert.ok(decision.override.includes('ZZZ(unknown_pharmacy)'));
  });

  it('偏好 interval 不覆盖 at → 视为不存在（无 override）', () => {
    const h = createHarness();
    const bases = [makeBase('AAA', { shipsInDays: 3 }), makeBase('BBB', { shipsInDays: 2 })];
    const preferences = [
      h.preference({
        pharmacy: 'AAA',
        medication: 'tirzepatide',
        from: T_FUTURE,
        eventId: 'evt_pref_future',
      }),
    ];

    const decision = routeWith(h, bases, preferences);

    assert.equal(decision.basis, 'rank');
    assert.equal(decision.chosen, 'BBB');
    assert.equal(decision.preference, null);
    assert.equal(decision.override, null, '不生效的偏好不产生 override');
  });
});
