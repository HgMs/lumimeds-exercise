/**
 * `FactStore` / `FactFactory` / `BaseFactExpander` 单测（`ARCHITECTURE.md` §5.4、§12.2）。
 *
 * 覆盖 D2 的关键点：
 * - 未来生效、过期、同刻两条、同封两条（W4 后者胜）；
 * - 对立陈述共用同一 `SubjectKey`（写错会让缺货被 fallback 成有货）；
 * - 过期 fact 不遮蔽更早仍有效的 fact（从后往前找 covers）；
 * - `restore` 往返后 `resolve` 结果不变、顺序被破坏时抛错；
 * - `BaseFactExpander` 的产物形状与 week A 的 66 条基础事实（§WALKTHROUGHS §4.2）。
 *
 * test/ 不在 week A 字面量守卫范围内，这里用真实风格的样例值。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { IdSequence } from '../../src/kernel/ids.ts';
import { EtCalendar } from '../../src/kernel/time/et-calendar.ts';
import { Instant } from '../../src/kernel/time/instant.ts';
import { Interval } from '../../src/kernel/time/interval.ts';
import { Catalogue } from '../../src/domain/catalogue.ts';
import type { SimConfig } from '../../src/domain/config.ts';
import { BaseFactExpander } from '../../src/domain/facts/base-facts.ts';
import { FactFactory } from '../../src/domain/facts/fact-factory.ts';
import { FactStore } from '../../src/domain/facts/fact-store.ts';
import type { Fact, FactDraft, FactType } from '../../src/domain/facts/fact.ts';
import { subjectKeyOf } from '../../src/domain/facts/fact.ts';
import type { PersistedFact as PortPersistedFact } from '../../src/application/ports/state-store.ts';
import { PharmacyRegistry } from '../../src/domain/pharmacy.ts';
import type { PharmacyConfig } from '../../src/domain/config.ts';
import { StateNormalizer } from '../../src/domain/normalize/state-normalizer.ts';

// ---------------------------------------------------------------------------
// 共享夹具
// ---------------------------------------------------------------------------

const calendar = new EtCalendar();

const T0 = '2026-11-09T07:05:00-05:00';
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

/** 构造一个 `FactDraft`；`window.from` 缺省 T0，`window.until` 缺省 null（一直有效）。 */
function draft(
  type: FactType,
  window: { from?: string; until?: string | null } = {},
  extra: Partial<FactDraft> = {},
): FactDraft {
  return {
    type,
    pharmacy: 'ALPHA',
    interval: interval(window.from ?? T0, window.until ?? null),
    ...extra,
  };
}

interface Harness {
  ids: IdSequence;
  factory: FactFactory;
  store: FactStore;
  /** 追加一批 draft（按数组顺序领 seq），返回产生的 fact。 */
  add(drafts: readonly FactDraft[], atIso: string, eventId?: string): Fact[];
}

function harness(): Harness {
  const ids = new IdSequence();
  const factory = new FactFactory();
  const store = new FactStore();
  return {
    ids,
    factory,
    store,
    add(drafts, atIso, eventId = 'evt_test') {
      const facts = factory.createAll(drafts, { eventId, at: instant(atIso), ids });
      store.append(facts);
      return facts;
    },
  };
}

// ---------------------------------------------------------------------------
// FactStore.resolve：最后断言者胜
// ---------------------------------------------------------------------------

describe('FactStore.resolve：覆盖 t 的最后断言者胜', () => {
  it('未来生效的 fact 在 from 之前不被看见', () => {
    const h = harness();
    h.add(
      [
        draft(
          'stock_unavailable',
          { from: T3 },
          { medication: 'tirzepatide', dose: '5mg' },
        ),
      ],
      T0,
    );
    const key = subjectKeyOf(draft('stock_unavailable', { from: T3 }, {
      medication: 'tirzepatide',
      dose: '5mg',
    }));
    assert.equal(h.store.resolve(key, instant(T2)), undefined);
    assert.equal(h.store.resolve(key, instant(T3))?.type, 'stock_unavailable');
  });

  it('过期的 fact 在 until 之后不被看见', () => {
    const h = harness();
    h.add(
      [draft('stock_unavailable', { from: T0, until: T3 }, { medication: 'tirzepatide', dose: '5mg' })],
      T0,
    );
    const key = subjectKeyOf(draft('stock_unavailable', {}, { medication: 'tirzepatide', dose: '5mg' }));
    assert.equal(h.store.resolve(key, instant(T0))?.type, 'stock_unavailable');
    assert.equal(h.store.resolve(key, instant(T3)), undefined, 'until 排他');
  });

  it('同一 assertedAt 的两条：seq 大者（数组后者）胜', () => {
    const h = harness();
    h.add(
      [
        draft('stock_unavailable', { from: T0 }, { medication: 'tirzepatide', dose: '5mg' }),
        draft('stock_available', { from: T0 }, { medication: 'tirzepatide', dose: '5mg' }),
      ],
      T0,
    );
    const key = subjectKeyOf(draft('stock_unavailable', {}, { medication: 'tirzepatide', dose: '5mg' }));
    assert.equal(h.store.resolve(key, instant(T0))?.type, 'stock_available');
  });

  it('更晚断言的一条过期后，回退到仍覆盖 t 的旧 fact（从后往前找）', () => {
    const h = harness();
    const [first] = h.add(
      [draft('stock_unavailable', { from: T0 }, { medication: 'tirzepatide', dose: '5mg' })],
      T0,
    );
    // 第二条更晚断言，但区间是 [T1, T2)：T2 之后已经过期。
    h.add(
      [
        draft(
          'stock_available',
          { from: T1, until: T2 },
          { medication: 'tirzepatide', dose: '5mg' },
        ),
      ],
      T2,
    );
    const key = subjectKeyOf(first);
    assert.equal(h.store.resolve(key, instant(T1))?.type, 'stock_available');
    assert.equal(h.store.resolve(key, instant(T2))?.id, first.id, 'T2 起回退到仍有效的旧 fact');
  });

  it('对立陈述共用同一个 SubjectKey（stock_available / stock_unavailable）', () => {
    const available = draft(
      'stock_available',
      { from: T0 },
      { medication: 'semaglutide', dose: '1mg' },
    );
    const unavailable = draft(
      'stock_unavailable',
      { from: T0 },
      { medication: 'semaglutide', dose: '1mg' },
    );
    assert.equal(subjectKeyOf(available), subjectKeyOf(unavailable));
    assert.equal(subjectKeyOf(available), 'stock:ALPHA:semaglutide:1mg');

    const closed = draft('closed', { from: T0 });
    const reopened = draft('reopened', { from: T0 });
    assert.equal(subjectKeyOf(closed), subjectKeyOf(reopened));
    assert.equal(subjectKeyOf(closed), 'closure:ALPHA');

    const blocked = draft('state_blocked', { from: T0 }, { state: 'TX' });
    const allowed = draft('state_allowed', { from: T0 }, { state: 'TX' });
    assert.equal(subjectKeyOf(blocked), subjectKeyOf(allowed));
    assert.equal(subjectKeyOf(blocked), 'coverage:ALPHA:TX');
  });

  it('同一封邮件两条落在同一 cell：按数组顺序领 seq，后者胜（W4）', () => {
    const h = harness();
    h.add(
      [
        draft('state_blocked', { from: T0 }, { state: 'TX' }),
        draft('state_allowed', { from: T0 }, { state: 'TX' }),
      ],
      T0,
    );
    const key = subjectKeyOf(draft('state_blocked', {}, { state: 'TX' }));
    assert.equal(h.store.history(key).length, 2);
    assert.equal(h.store.resolve(key, instant(T0))?.type, 'state_allowed');
    assert.equal(h.store.history(key)[0].seq, 1);
    assert.equal(h.store.history(key)[1].seq, 2);
  });
});

// ---------------------------------------------------------------------------
// FactStore：只增、history、factsOf、preferences、hasEvent
// ---------------------------------------------------------------------------

describe('FactStore：只追加与查询', () => {
  it('history 按 (assertedAt, seq) 升序，即使 append 顺序不同（seq 仍单调）', () => {
    const h = harness();
    // 先 append 断言时刻较晚的一条，再 append 断言时刻较早的一条：seq 递增，合法。
    h.add([draft('stock_unavailable', { from: T1 }, { medication: 'tirzepatide', dose: '5mg' })], T1);
    h.add([draft('stock_available', { from: T0 }, { medication: 'tirzepatide', dose: '5mg' })], T0);
    const key = subjectKeyOf(draft('stock_unavailable', {}, { medication: 'tirzepatide', dose: '5mg' }));
    const history = h.store.history(key);
    assert.deepEqual(
      history.map((fact) => fact.assertedAt.toISOString()),
      [instant(T0).toISOString(), instant(T1).toISOString()],
    );
    // 最后断言者 = assertedAt 最大者（T1 的 stock_unavailable）。
    assert.equal(h.store.resolve(key, instant(T2))?.type, 'stock_unavailable');
  });

  it('append 拒绝重复/倒序 seq（INV-3 的运行时校验）', () => {
    const h = harness();
    const [first] = h.add([draft('closed', { from: T0 })], T0);
    assert.throws(() => h.store.append([first]), /seq 必须单调递增/);
    const second = h.factory.create(draft('reopened', { from: T0 }), {
      eventId: 'evt_other',
      at: instant(T1),
      ids: h.ids,
    });
    assert.throws(() => h.store.append([second, first]), /seq 必须单调递增|seq 必须单调/);
  });

  it('factsOf 按药房/类型过滤；preferences 只含 routing_preference', () => {
    const h = harness();
    h.add(
      [
        draft('stock_unavailable', { from: T0 }, { medication: 'tirzepatide', dose: '5mg' }),
        draft(
          'routing_preference',
          { from: T0 },
          { medication: 'semaglutide', note: 'prefer this one' },
        ),
      ],
      T0,
      'evt_a',
    );
    h.add(
      [draft('closed', { from: T1 }, { pharmacy: 'BETA' })],
      T1,
      'evt_b',
    );

    assert.equal(h.store.factsOf('ALPHA').length, 2);
    assert.equal(h.store.factsOf('ALPHA', 'stock_unavailable').length, 1);
    assert.equal(h.store.factsOf('ALPHA', 'closed').length, 0);
    assert.equal(h.store.factsOf('BETA').length, 1);

    const preferences = h.store.preferences();
    assert.equal(preferences.length, 1);
    assert.equal(preferences[0].type, 'routing_preference');
    // 偏好不进 cells（§5.4）：按它的主体键查 history 是空的。
    assert.deepEqual(h.store.history(subjectKeyOf(preferences[0])), []);

    assert.equal(h.store.hasEvent('evt_a'), true);
    assert.equal(h.store.hasEvent('evt_b'), true);
    assert.equal(h.store.hasEvent('evt_missing'), false);
  });

  it('append 只增不改：后追加不修改已有 fact 对象', () => {
    const h = harness();
    const [first] = h.add([draft('closed', { from: T0 })], T0);
    const before = { ...first, interval: first.interval };
    h.add([draft('reopened', { from: T1 })], T1);
    assert.deepEqual({ ...first, interval: first.interval }, before);
    assert.equal(h.store.history(subjectKeyOf(first)).length, 2);
  });
});

// ---------------------------------------------------------------------------
// FactStore.snapshot / restore
// ---------------------------------------------------------------------------

describe('FactStore.snapshot / restore', () => {
  function fullStore(): FactStore {
    const h = harness();
    h.add(
      [
        draft('stock_unavailable', { from: T0, until: T3 }, { medication: 'tirzepatide', dose: '5mg' }),
        draft('state_blocked', { from: T0 }, { state: 'TX' }),
        draft('routing_preference', { from: T0 }, { medication: 'semaglutide', dose: '1mg' }),
        draft('closed', { from: T1 }, { pharmacy: 'BETA' }),
      ],
      T0,
      'evt_1',
    );
    h.add(
      [
        draft('capacity', { from: T1 }, { perDay: 2 }),
        draft('reopened', { from: T1 }, { pharmacy: 'BETA' }),
      ],
      T1,
      'evt_2',
    );
    return h.store;
  }

  it('snapshot 是契约的 snake_case 形状，seq 不落盘', () => {
    const store = fullStore();
    const persisted = store.snapshot();
    assert.equal(persisted.length, 6);

    const stock = persisted[0];
    assert.equal(stock.id, 'fact_0001');
    assert.equal(stock.type, 'stock_unavailable');
    assert.equal(stock.event_id, 'evt_1');
    assert.equal(stock.asserted_at, instant(T0).toISOString());
    assert.equal(stock.pharmacy, 'ALPHA');
    assert.deepEqual(stock.interval, {
      from: instant(T0).toISOString(),
      until: instant(T3).toISOString(),
    });
    assert.equal(stock.medication, 'tirzepatide');
    assert.equal(stock.dose, '5mg');
    assert.equal('seq' in stock, false, 'seq 从 id 后缀解析，不落盘');

    const capacity = persisted[4];
    assert.equal(capacity.type, 'capacity');
    assert.equal(capacity.per_day, 2);

    const preference = persisted[2];
    assert.equal(preference.type, 'routing_preference');
    assert.equal(preference.medication, 'semaglutide');
    assert.equal(preference.dose, '1mg');
  });

  it('restore 后 resolve/history 结果不变（往返稳定）', () => {
    const store = fullStore();
    const restored = FactStore.restore(store.snapshot());

    for (const atIso of [T0, T1, T2, T3, T4]) {
      const at = instant(atIso);
      for (const key of [
        'stock:ALPHA:tirzepatide:5mg',
        'coverage:ALPHA:TX',
        'capacity:ALPHA',
        'closure:BETA',
      ]) {
        assert.deepEqual(
          restored.resolve(key, at)?.id,
          store.resolve(key, at)?.id,
          `resolve(${key}, ${atIso}) 应一致`,
        );
        assert.deepEqual(
          restored.history(key).map((fact) => fact.id),
          store.history(key).map((fact) => fact.id),
        );
      }
    }
    assert.deepEqual(restored.snapshot(), store.snapshot(), 'restore→snapshot 是恒等变换');
    assert.deepEqual(
      restored.preferences().map((fact) => fact.id),
      store.preferences().map((fact) => fact.id),
    );
    assert.equal(restored.hasEvent('evt_1'), true);
  });

  it('restore 后可以继续追加（lastSeq 从快照恢复）', () => {
    const store = fullStore();
    const restored = FactStore.restore(store.snapshot());
    const ids = new IdSequence({ fact: 6 });
    const next = new FactFactory().create(draft('state_allowed', { from: T4 }, { state: 'TX' }), {
      eventId: 'evt_3',
      at: instant(T4),
      ids,
    });
    assert.equal(next.id, 'fact_0007');
    restored.append([next]);
    assert.equal(restored.snapshot().length, 7);
    assert.equal(restored.resolve('coverage:ALPHA:TX', instant(T4))?.type, 'state_allowed');
  });

  it('restore 校验 seq 单调与 id 格式：被改坏的快照抛错', () => {
    const snapshot = fullStore().snapshot();
    assert.throws(() => FactStore.restore([...snapshot].reverse()), /序号必须严格单调/);

    const malformed = [{ ...snapshot[0], id: 'not-a-fact-id' }];
    assert.throws(() => FactStore.restore(malformed), /非法 fact id/);

    const badTime = [{ ...snapshot[0], asserted_at: 'not-a-time' }];
    assert.throws(() => FactStore.restore(badTime), /时间不可解析/);
  });

  it('snapshot 形状与 application 端口的 PersistedFact 结构兼容（domain 不 import application）', () => {
    // 分层（§2.1 R2）不允许 domain import application，所以两边各自声明结构等价的形状。
    // 这个用例在编译期钉住「两个方向都能直接赋值」，SnapshotMapper 不需要二次转换。
    const store = fullStore();
    const asPortShape: readonly PortPersistedFact[] = store.snapshot();
    const backToDomain = FactStore.restore(asPortShape);
    assert.deepEqual(backToDomain.snapshot(), store.snapshot());
  });
});

// ---------------------------------------------------------------------------
// FactFactory
// ---------------------------------------------------------------------------

describe('FactFactory', () => {
  it('分配 fact_NNNN id 与 seq，记录来源事件/断言时刻/note', () => {
    const ids = new IdSequence();
    const factory = new FactFactory();
    const facts = factory.createAll(
      [
        draft('closed', { from: T0 }, { note: '原文措辞' }),
        draft('capacity', { from: T0 }, { perDay: 3 }),
      ],
      { eventId: 'evt_x', at: instant(T0), ids },
    );
    assert.equal(facts.length, 2);
    assert.deepEqual(
      facts.map((fact) => fact.id),
      ['fact_0001', 'fact_0002'],
    );
    assert.deepEqual(
      facts.map((fact) => fact.seq),
      [1, 2],
    );
    for (const fact of facts) {
      assert.equal(fact.eventId, 'evt_x');
      assert.equal(fact.assertedAt.toISOString(), instant(T0).toISOString());
    }
    assert.equal(facts[0].note, '原文措辞');
    assert.equal(facts[1].note, undefined);
  });

  it('draft 没有 note 时用 ctx.note 兜底', () => {
    const factory = new FactFactory();
    const [fact] = factory.createAll([draft('closed', { from: T0 })], {
      eventId: 'evt_x',
      at: instant(T0),
      ids: new IdSequence(),
      note: '来自邮件',
    });
    assert.equal(fact.note, '来自邮件');
  });

  it('createAll 严格按数组顺序领 seq（同 cell 后者胜的前提）', () => {
    const ids = new IdSequence();
    const factory = new FactFactory();
    const [first, second] = factory.createAll(
      [
        draft('reopened', { from: T0 }),
        draft('closed', { from: T0 }),
      ],
      { eventId: 'evt_x', at: instant(T0), ids },
    );
    assert.ok(second.seq > first.seq);
  });

  it('必填字段缺失（validator 上游 bug）→ 抛不变量错误，不是业务失败', () => {
    const factory = new FactFactory();
    const ctx = { eventId: 'evt_x', at: instant(T0), ids: new IdSequence() };
    assert.throws(
      () => factory.create(draft('stock_available', { from: T0 }), ctx),
      /缺少必填字段 medication/,
    );
    assert.throws(
      () => factory.create(draft('capacity', { from: T0 }), ctx),
      /缺少必填字段 perDay/,
    );
  });
});

// ---------------------------------------------------------------------------
// BaseFactExpander
// ---------------------------------------------------------------------------

const CATALOGUE_RAW = {
  semaglutide: ['0.25mg', '1mg'],
  tirzepatide: ['2.5mg', '7.5mg'],
} as const;

const catalogue = Catalogue.from(CATALOGUE_RAW);
const states = new StateNormalizer();

function pharmacyConfig(overrides: Partial<PharmacyConfig> = {}): PharmacyConfig {
  return {
    id: 'ALPHA',
    name: 'Alpha Rx',
    contacts: ['ops@alpha.example'],
    open: true,
    shipsInDays: 1,
    dailyCapacity: 4,
    price: { semaglutide: 100, tirzepatide: 200 },
    blockedStates: ['FL'],
    stock: {
      semaglutide: ['0.25mg', '1mg'],
      tirzepatide: ['2.5mg', '7.5mg'],
    },
    ...overrides,
  };
}

function registry(configs: readonly PharmacyConfig[]): PharmacyRegistry {
  const built = PharmacyRegistry.from(configs, { catalogue, states });
  if (!built.ok) {
    throw new Error(`测试夹具：registry 构建失败 ${built.error.code} ${built.error.message}`);
  }
  return built.value;
}

const STARTED_AT = '2026-11-09T06:00:00-05:00';

describe('BaseFactExpander', () => {
  const twoPharmacyRegistry = registry([
    pharmacyConfig({ id: 'ALPHA', name: 'Alpha Rx', contacts: ['ops@alpha.example'] }),
    pharmacyConfig({
      id: 'BETA',
      name: 'Beta Rx',
      contacts: ['ops@beta.example'],
      dailyCapacity: 2,
      blockedStates: ['NY', 'CA'],
      stock: { semaglutide: ['1mg'], tirzepatide: ['7.5mg'] },
    }),
  ]);

  function expand(reg: PharmacyRegistry, ids = new IdSequence()): Fact[] {
    const expander = new BaseFactExpander({
      ids,
      registry: reg,
      catalogue,
      calendar,
    });
    return expander.expand({ eventId: 'evt_started', at: instant(STARTED_AT) });
  }

  it('展开 stock_available（每现货剂量）+ state_blocked（每封锁州）+ 一条 capacity', () => {
    const facts = expand(twoPharmacyRegistry);
    // ALPHA: 现货 4 + 封锁 1 + capacity 1；BETA: 现货 2 + 封锁 2 + capacity 1。
    assert.equal(facts.length, 11);

    const byType = (type: FactType) => facts.filter((fact) => fact.type === type);
    assert.equal(byType('stock_available').length, 6);
    assert.equal(byType('state_blocked').length, 3);
    assert.equal(byType('capacity').length, 2);
    // open 是基础字段，不造 fact（§3.1）。
    assert.deepEqual(byType('closed'), []);
    assert.deepEqual(byType('reopened'), []);
    assert.deepEqual(byType('state_allowed'), []);

    for (const fact of facts) {
      assert.equal(fact.eventId, 'evt_started');
      assert.equal(fact.assertedAt.toISOString(), instant(STARTED_AT).toISOString());
      assert.equal(fact.interval.from.toISOString(), instant(STARTED_AT).toISOString());
      assert.equal(fact.interval.until, null);
    }

    const capacities = byType('capacity');
    assert.deepEqual(
      capacities.map((fact) => [fact.pharmacy, (fact as Fact & { type: 'capacity' }).perDay]),
      [
        ['ALPHA', 4],
        ['BETA', 2],
      ],
    );
    const blocked = byType('state_blocked').map((fact) => [
      fact.pharmacy,
      (fact as Fact & { type: 'state_blocked' }).state,
    ]);
    assert.deepEqual(blocked, [
      ['ALPHA', 'FL'],
      ['BETA', 'NY'],
      ['BETA', 'CA'],
    ]);
  });

  it('顺序确定：registry 按 id、药品按 catalogue、剂量/州按 config', () => {
    const facts = expand(twoPharmacyRegistry);
    const firstStock = facts[0] as Fact & { type: 'stock_available' };
    assert.equal(firstStock.type, 'stock_available');
    assert.equal(firstStock.pharmacy, 'ALPHA');
    assert.equal(firstStock.medication, 'semaglutide');
    assert.equal(firstStock.dose, '0.25mg');

    const alphaCapacities = facts
      .filter((fact) => fact.type === 'capacity')
      .map((fact) => fact.pharmacy);
    assert.deepEqual(alphaCapacities, ['ALPHA', 'BETA']);
  });

  it('同一 started 事件两次展开逐字段相同（C7）', () => {
    const first = expand(twoPharmacyRegistry, new IdSequence());
    const second = expand(twoPharmacyRegistry, new IdSequence());
    assert.deepEqual(
      first.map((fact) => ({ ...fact, assertedAt: fact.assertedAt.toISOString() })),
      second.map((fact) => ({ ...fact, assertedAt: fact.assertedAt.toISOString() })),
    );
  });

  it('week A 的 config 展开出 66 条基础事实（WALKTHROUGHS §4.2）', () => {
    const jsonl = readFileSync(new URL('../../sim/week-a.jsonl', import.meta.url), 'utf8');
    const firstLine = jsonl.split(/\r?\n/, 1)[0];
    const started = JSON.parse(firstLine) as {
      event_id: string;
      occurred_at: string;
      config: SimConfig;
    };

    const weekCatalogue = Catalogue.from(started.config.catalogue);
    const weekStates = new StateNormalizer();
    const weekRegistry = PharmacyRegistry.from(started.config.pharmacies, {
      catalogue: weekCatalogue,
      states: weekStates,
    });
    if (!weekRegistry.ok) {
      throw new Error(`测试夹具：week A registry 构建失败 ${weekRegistry.error.message}`);
    }

    const facts = new BaseFactExpander({
      ids: new IdSequence(),
      registry: weekRegistry.value,
      catalogue: weekCatalogue,
      calendar,
    }).expand({ eventId: started.event_id, at: instant(started.occurred_at) });

    assert.equal(facts.length, 66, '基础事实 66 条：现货 39 + 封锁 22 + 容量 5');
    assert.equal(facts.filter((fact) => fact.type === 'stock_available').length, 39);
    assert.equal(facts.filter((fact) => fact.type === 'state_blocked').length, 22);
    assert.equal(facts.filter((fact) => fact.type === 'capacity').length, 5);
    assert.equal(facts[0].id, 'fact_0001');
    assert.equal(facts[65].id, 'fact_0066');
    assert.equal(facts[0].eventId, started.event_id);
    for (const fact of facts) {
      assert.equal(fact.assertedAt.toISOString(), instant(started.occurred_at).toISOString());
    }
  });
});
