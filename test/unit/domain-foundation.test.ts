/**
 * 领域基础层单测：Catalogue、四个 normalizer、PharmacyBase/PharmacyRegistry。
 *
 * 覆盖 `ARCHITECTURE.md` §5.2/§5.3 的规则与 §12.2 点名的 D1 用例：
 * - `"Texas"` → `TX`、`"texas "` → `TX`、`"Ontario"` → Err；
 * - `" 7.5 mg "` → `7.5mg`、`"7.5"` → Err、`"25mg"` → Err；
 * - 药房 config 的 5 条形状校验，每条成功与失败路径；
 * - 订单归一化失败给出正确原因码。
 *
 * test/ 不在 week A 字面量守卫范围内，这里可以用真实风格的样例值。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AppError } from '../../src/kernel/errors.ts';
import type { Result } from '../../src/kernel/result.ts';

import { Catalogue } from '../../src/domain/catalogue.ts';
import type { PharmacyConfig } from '../../src/domain/config.ts';
import type { RawOrder } from '../../src/domain/events.ts';
import { PharmacyRegistry, REGISTRY_RULES } from '../../src/domain/pharmacy.ts';
import { DoseNormalizer } from '../../src/domain/normalize/dose-normalizer.ts';
import {
  DEFAULT_MEDICATION_ALIASES,
  MedicationNormalizer,
} from '../../src/domain/normalize/medication-normalizer.ts';
import { OrderNormalizer } from '../../src/domain/normalize/order-normalizer.ts';
import {
  StateNormalizer,
  US_STATE_BY_NAME,
} from '../../src/domain/normalize/state-normalizer.ts';

// ---------------------------------------------------------------------------
// 共享夹具
// ---------------------------------------------------------------------------

const CATALOGUE_RAW = {
  semaglutide: ['0.25mg', '0.5mg', '1mg'],
  tirzepatide: ['2.5mg', '7.5mg'],
} as const;

const catalogue = Catalogue.from(CATALOGUE_RAW);
const states = new StateNormalizer();
const medications = new MedicationNormalizer(catalogue, DEFAULT_MEDICATION_ALIASES);
const doses = new DoseNormalizer(catalogue);
const orderNormalizer = new OrderNormalizer(states, medications, doses);

const REGISTRY_DEPS = { catalogue, states };

/** 构造一份合法的药房 config；overrides 是浅覆盖。 */
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

/** 从 config 列表构建注册表，断言成功并返回注册表。 */
function expectRegistry(configs: readonly PharmacyConfig[]): PharmacyRegistry {
  const result = PharmacyRegistry.from(configs, REGISTRY_DEPS);
  if (!result.ok) {
    assert.fail(`期望注册表构建成功，实际失败：${result.error.code} ${result.error.message}`);
  }
  return result.value;
}

function expectBadConfig(result: unknown, rule: string): AppError {
  const typed = result as Result<unknown, AppError>;
  if (typed.ok) assert.fail('期望 Err，实际 Ok');
  assert.equal(typed.error.code, 'bad_started_config');
  assert.equal(typed.error.detail?.rule, rule, '失败 detail.rule 应为 ' + rule);
  return typed.error;
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

describe('Catalogue', () => {
  it('medications() 按 config 键顺序返回且稳定', () => {
    assert.deepEqual(catalogue.medications(), ['semaglutide', 'tirzepatide']);
  });

  it('dosesOf 保留 config 顺序，hasDose 精确匹配', () => {
    assert.deepEqual(catalogue.dosesOf('tirzepatide'), ['2.5mg', '7.5mg']);
    assert.equal(catalogue.hasMedication('tirzepatide'), true);
    assert.equal(catalogue.hasMedication('Tirzepatide'), false, 'hasMedication 是精确匹配');
    assert.equal(catalogue.hasDose('tirzepatide', '7.5mg'), true);
    assert.equal(catalogue.hasDose('tirzepatide', '7.5 mg'), false, 'hasDose 是精确匹配');
    assert.equal(catalogue.hasDose('tirzepatide', '25mg'), false);
  });

  it('未知药品的 dosesOf 返回空数组而不是抛异常', () => {
    assert.deepEqual(catalogue.dosesOf('ozempic'), []);
  });

  it('重复剂量按首次出现去重', () => {
    const c = Catalogue.from({ semaglutide: ['1mg', '1mg', '2mg', '1mg'] });
    assert.deepEqual(c.dosesOf('semaglutide'), ['1mg', '2mg']);
  });

  it('不可变：返回的数组被冻结', () => {
    const list = catalogue.dosesOf('semaglutide') as string[];
    assert.equal(Object.isFrozen(list), true);
    assert.throws(() => list.push('9mg'));
    assert.deepEqual(catalogue.dosesOf('semaglutide'), ['0.25mg', '0.5mg', '1mg']);
  });

  it('对形状不对的输入容错：非数组按空剂量表处理', () => {
    const c = Catalogue.from({ semaglutide: null as unknown as string[], tirzepatide: ['5mg'] });
    assert.deepEqual(c.medications(), ['semaglutide', 'tirzepatide']);
    assert.deepEqual(c.dosesOf('semaglutide'), []);
  });
});

// ---------------------------------------------------------------------------
// StateNormalizer
// ---------------------------------------------------------------------------

describe('StateNormalizer', () => {
  const cases: Array<[string, string]> = [
    ['Texas', 'TX'],
    ['texas ', 'TX'],
    ['TEXAS', 'TX'],
    ['TX', 'TX'],
    ['tx', 'TX'],
    [' TX ', 'TX'],
    ['New York', 'NY'],
    ['new york', 'NY'],
    ['District of Columbia', 'DC'],
    ['California', 'CA'],
  ];
  for (const [input, expected] of cases) {
    it(`"${input}" → ${expected}`, () => {
      assert.deepEqual(states.normalize(input), { ok: true, value: expected });
    });
  }

  it('州表恰好是 50 州 + DC，且每个全名都能归一化', () => {
    const entries = Object.entries(US_STATE_BY_NAME);
    assert.equal(entries.length, 51);
    const codes = new Set(entries.map(([, code]) => code));
    assert.equal(codes.size, 51, '州码不应重复');
    for (const [name, code] of entries) {
      assert.deepEqual(states.normalize(name), { ok: true, value: code }, name);
      assert.deepEqual(states.normalize(name.toUpperCase()), { ok: true, value: code }, name);
    }
  });

  it('接受全部 51 个两位码', () => {
    for (const code of new Set(Object.values(US_STATE_BY_NAME))) {
      assert.deepEqual(states.normalize(code.toLowerCase()), { ok: true, value: code });
    }
  });

  it('不做模糊/前缀匹配：非法写法一律 unknown_state', () => {
    for (const bad of ['Ontario', 'ZZ', 'Txs', 'TXS', 'Tex as', '', 'Florida!', ' Ontario ']) {
      assert.deepEqual(
        states.normalize(bad),
        { ok: false, code: 'unknown_state', raw: bad },
        `"${bad}" 应失败`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// MedicationNormalizer
// ---------------------------------------------------------------------------

describe('MedicationNormalizer', () => {
  const cases: Array<[string, string]> = [
    ['tirzepatide', 'tirzepatide'],
    ['Tirzepatide ', 'tirzepatide'],
    ['tirz', 'tirzepatide'],
    ['TIRZ', 'tirzepatide'],
    [' tirz ', 'tirzepatide'],
    ['semaglutide', 'semaglutide'],
    ['sema', 'semaglutide'],
    ['Sema ', 'semaglutide'],
  ];
  for (const [input, expected] of cases) {
    it(`"${input}" → ${expected}`, () => {
      assert.deepEqual(medications.normalize(input), { ok: true, value: expected });
    });
  }

  it('不做前缀/相似匹配：tirzep / ozempic 失败且保留原始输入', () => {
    for (const bad of ['tirzep', 'tirzepati', 'ozempic', 'sema glutide extra', '']) {
      assert.deepEqual(
        medications.normalize(bad),
        { ok: false, code: 'unknown_medication', raw: bad },
        `"${bad}" 应失败`,
      );
    }
  });

  it('自定义别名表可用；别名指向目录外的药品同样失败', () => {
    const custom = new MedicationNormalizer(
      catalogue,
      new Map([
        ['wgovy', 'semaglutide'],
        ['ghost', 'not-a-medication'],
      ]),
    );
    assert.deepEqual(custom.normalize('WGOVY'), { ok: true, value: 'semaglutide' });
    assert.equal(custom.normalize('ghost').ok, false);
  });
});

// ---------------------------------------------------------------------------
// DoseNormalizer
// ---------------------------------------------------------------------------

describe('DoseNormalizer', () => {
  it('空白规范化：" 7.5 mg " → "7.5mg"（只删空白，不补单位）', () => {
    assert.deepEqual(doses.normalize(' 7.5 mg ', 'tirzepatide'), { ok: true, value: '7.5mg' });
    assert.deepEqual(doses.normalize('7.5MG', 'tirzepatide'), { ok: true, value: '7.5mg' });
    assert.deepEqual(doses.normalize('7.5   mg', 'tirzepatide'), { ok: true, value: '7.5mg' });
    assert.deepEqual(doses.normalize(' 2.5mg ', 'tirzepatide'), { ok: true, value: '2.5mg' });
    assert.deepEqual(doses.normalize(' 1mg', 'semaglutide'), { ok: true, value: '1mg' });
  });

  it('绝不补单位："7.5" 必须失败', () => {
    assert.deepEqual(
      doses.normalize('7.5', 'tirzepatide'),
      { ok: false, code: 'unknown_dose', raw: '7.5' },
    );
    assert.deepEqual(
      doses.normalize(' 7.5 ', 'tirzepatide'),
      { ok: false, code: 'unknown_dose', raw: ' 7.5 ' },
    );
  });

  it('目录外剂量失败：25mg / 7.50mg 不被猜测成 2.5mg / 7.5mg', () => {
    assert.deepEqual(
      doses.normalize('25mg', 'tirzepatide'),
      { ok: false, code: 'unknown_dose', raw: '25mg' },
    );
    assert.deepEqual(
      doses.normalize('7.50mg', 'tirzepatide'),
      { ok: false, code: 'unknown_dose', raw: '7.50mg' },
    );
  });

  it('剂量必须属于该药品：7.5mg 对 semaglutide 失败', () => {
    assert.equal(doses.normalize('7.5mg', 'semaglutide').ok, false);
    assert.equal(doses.normalize('1mg', 'tirzepatide').ok, false);
  });

  it('未知药品 → unknown_dose（不抛异常）', () => {
    assert.deepEqual(
      doses.normalize('1mg', 'ozempic'),
      { ok: false, code: 'unknown_dose', raw: '1mg' },
    );
  });
});

// ---------------------------------------------------------------------------
// OrderNormalizer
// ---------------------------------------------------------------------------

describe('OrderNormalizer', () => {
  it('正常路径：原始写法全部归一化', () => {
    const raw: RawOrder = {
      order_id: 'ORD-1001',
      state: 'Texas',
      medication: 'tirz',
      dose: ' 7.5 mg ',
    };
    const result = orderNormalizer.normalize(raw);
    if (!result.ok) assert.fail(`期望成功，实际 ${result.error.code}`);
    assert.deepEqual(result.value, {
      orderId: 'ORD-1001',
      state: 'TX',
      medication: 'tirzepatide',
      dose: '7.5mg',
    });
  });

  it('已经规范的写法同样通过（tx / semaglutide / 1mg）', () => {
    const result = orderNormalizer.normalize({
      order_id: 'ORD-1002',
      state: 'tx',
      medication: 'semaglutide',
      dose: '1mg',
    });
    if (!result.ok) assert.fail(`期望成功，实际 ${result.error.code}`);
    assert.deepEqual(result.value, {
      orderId: 'ORD-1002',
      state: 'TX',
      medication: 'semaglutide',
      dose: '1mg',
    });
  });

  it('州失败 → unknown_state，detail 带字段与原始值', () => {
    const result = orderNormalizer.normalize({
      order_id: 'ORD-1003',
      state: 'Ontario',
      medication: 'tirz',
      dose: '7.5mg',
    });
    if (result.ok) assert.fail('期望失败');
    assert.equal(result.error.code, 'unknown_state');
    assert.equal(result.error.detail?.field, 'state');
    assert.equal(result.error.detail?.raw, 'Ontario');
  });

  it('药品失败 → unknown_medication', () => {
    const result = orderNormalizer.normalize({
      order_id: 'ORD-1004',
      state: 'TX',
      medication: 'tirzep',
      dose: '7.5mg',
    });
    if (result.ok) assert.fail('期望失败');
    assert.equal(result.error.code, 'unknown_medication');
    assert.equal(result.error.detail?.field, 'medication');
  });

  it('剂量失败 → unknown_dose（25mg 与 7.5 都是）', () => {
    for (const dose of ['25mg', '7.5']) {
      const result = orderNormalizer.normalize({
        order_id: 'ORD-1005',
        state: 'TX',
        medication: 'tirzepatide',
        dose,
      });
      if (result.ok) assert.fail(`剂量 "${dose}" 期望失败`);
      assert.equal(result.error.code, 'unknown_dose');
      assert.equal(result.error.detail?.field, 'dose');
      assert.equal(result.error.detail?.raw, dose);
    }
  });

  it('缺 order_id → missing_field', () => {
    const result = orderNormalizer.normalize({
      order_id: '',
      state: 'TX',
      medication: 'tirz',
      dose: '7.5mg',
    });
    if (result.ok) assert.fail('期望失败');
    assert.equal(result.error.code, 'missing_field');
    assert.equal(result.error.detail?.field, 'order_id');
  });

  it('字段类型不对时不抛异常，走失败分支', () => {
    const raw = {
      order_id: 'ORD-1006',
      state: undefined,
      medication: null,
      dose: 7.5,
    } as unknown as RawOrder;
    assert.doesNotThrow(() => orderNormalizer.normalize(raw));
    const result = orderNormalizer.normalize(raw);
    if (result.ok) assert.fail('期望失败');
    assert.equal(result.error.code, 'unknown_state');
  });
});

// ---------------------------------------------------------------------------
// PharmacyRegistry：成功路径
// ---------------------------------------------------------------------------

describe('PharmacyRegistry（成功路径）', () => {
  it('config 顺序无关：all() 按 id 升序', () => {
    const registry = expectRegistry([
      pharmacyConfig({ id: 'BETA', name: 'Beta Rx', contacts: ['orders@beta.example'] }),
      pharmacyConfig(),
    ]);
    assert.deepEqual(
      registry.all().map((p) => p.id),
      ['ALPHA', 'BETA'],
    );
    assert.equal(Object.isFrozen(registry.all()), true);
  });

  it('blockedStates 全名归一化 + 去重，顺序按 config', () => {
    const registry = expectRegistry([
      pharmacyConfig({ blockedStates: ['Texas', 'FL', 'fl', 'New York'] }),
    ]);
    assert.deepEqual(registry.byId('ALPHA')?.blockedStates, ['TX', 'FL', 'NY']);
  });

  it('contacts 小写化；open 缺省为 true、false 保留；price/stock 覆盖整个 catalogue', () => {
    const registry = expectRegistry([
      pharmacyConfig({
        contacts: ['Ops@Alpha.Example', 'JEN@ALPHA.EXAMPLE'],
        open: undefined,
        stock: { semaglutide: ['1mg'] },
      }),
    ]);
    const alpha = registry.byId('ALPHA');
    assert.ok(alpha);
    assert.deepEqual(alpha.contacts, ['ops@alpha.example', 'jen@alpha.example']);
    assert.equal(alpha.openByDefault, true);
    assert.deepEqual(alpha.price, { semaglutide: 100, tirzepatide: 200 });
    assert.deepEqual(alpha.stock.semaglutide, ['1mg']);
    assert.deepEqual(alpha.stock.tirzepatide, [], 'config 没给的药品现货为空数组');
    assert.equal(Object.isFrozen(alpha), true);
    assert.equal(Object.isFrozen(alpha.stock), true);

    const closed = expectRegistry([pharmacyConfig({ open: false })]);
    assert.equal(closed.byId('ALPHA')?.openByDefault, false);
  });

  it('byId 精确匹配；resolve 只认 id/name（大小写空白不敏感，不做子串）', () => {
    const registry = expectRegistry([
      pharmacyConfig(),
      pharmacyConfig({ id: 'BETA', name: 'Beta Rx', contacts: ['orders@beta.example'] }),
    ]);

    assert.equal(registry.byId('ALPHA')?.id, 'ALPHA');
    assert.equal(registry.byId('alpha'), undefined, 'byId 是精确匹配');

    assert.equal(registry.resolve('ALPHA')?.id, 'ALPHA');
    assert.equal(registry.resolve(' alpha ')?.id, 'ALPHA');
    assert.equal(registry.resolve('Alpha Rx')?.id, 'ALPHA');
    assert.equal(registry.resolve(' alpha   rx ')?.id, 'ALPHA');
    assert.equal(registry.resolve('alp')?.id, undefined);
    assert.equal(registry.resolve('AlphaRx')?.id, undefined);
    assert.equal(registry.resolve('Ontario'), undefined);
  });

  it('byContact 小写精确匹配，不做 local-part 启发式', () => {
    const registry = expectRegistry([
      pharmacyConfig(),
      pharmacyConfig({ id: 'BETA', name: 'Beta Rx', contacts: ['orders@beta.example'] }),
    ]);
    assert.equal(registry.byContact('ops@alpha.example')?.id, 'ALPHA');
    assert.equal(registry.byContact(' OPS@Alpha.Example ')?.id, 'ALPHA');
    assert.equal(registry.byContact('ops@alpha'), undefined);
    assert.equal(registry.byContact('someone@alpha.example'), undefined);
    assert.equal(registry.byContact('orders@beta.example')?.id, 'BETA');
  });
});

// ---------------------------------------------------------------------------
// PharmacyRegistry：5 条形状校验的失败路径
// ---------------------------------------------------------------------------

describe('PharmacyRegistry（形状校验失败）', () => {
  it('规则 1：price 必须覆盖 catalogue 全部药品', () => {
    const error = expectBadConfig(
      PharmacyRegistry.from(
        [pharmacyConfig({ price: { semaglutide: 100 } as PharmacyConfig['price'] })],
        REGISTRY_DEPS,
      ),
      REGISTRY_RULES.priceCoversCatalogue,
    );
    assert.equal(error.detail?.pharmacy, 'ALPHA');
    assert.equal(error.detail?.medication, 'tirzepatide');
    assert.match(error.message, /tirzepatide/);
  });

  it('规则 2a：stock 的键必须是 catalogue 药品', () => {
    const error = expectBadConfig(
      PharmacyRegistry.from(
        [
          pharmacyConfig({
            stock: {
              semaglutide: ['1mg'],
              tirzepatide: ['2.5mg'],
              ozempic: ['1mg'],
            } as PharmacyConfig['stock'],
          }),
        ],
        REGISTRY_DEPS,
      ),
      REGISTRY_RULES.stockKeys,
    );
    assert.equal(error.detail?.pharmacy, 'ALPHA');
    assert.equal(error.detail?.medication, 'ozempic');
  });

  it('规则 2b：stock 剂量必须 ⊆ catalogue[药品]（25mg 拒绝）', () => {
    const error = expectBadConfig(
      PharmacyRegistry.from(
        [pharmacyConfig({ stock: { semaglutide: ['1mg'], tirzepatide: ['25mg'] } })],
        REGISTRY_DEPS,
      ),
      REGISTRY_RULES.stockDoses,
    );
    assert.equal(error.detail?.pharmacy, 'ALPHA');
    assert.equal(error.detail?.dose, '25mg');
  });

  it('规则 3：blockedStates 必须可归一化（Ontario 拒绝）', () => {
    const error = expectBadConfig(
      PharmacyRegistry.from(
        [pharmacyConfig({ blockedStates: ['FL', 'Ontario'] })],
        REGISTRY_DEPS,
      ),
      REGISTRY_RULES.blockedStatesNormalizable,
    );
    assert.equal(error.detail?.pharmacy, 'ALPHA');
    assert.equal(error.detail?.raw, 'Ontario');
  });

  it('规则 4a：id 唯一（大小写不敏感）', () => {
    const error = expectBadConfig(
      PharmacyRegistry.from(
        [
          pharmacyConfig(),
          pharmacyConfig({ id: 'alpha', name: 'Other Rx', contacts: ['other@alpha.example'] }),
        ],
        REGISTRY_DEPS,
      ),
      REGISTRY_RULES.uniqueId,
    );
    assert.equal(error.detail?.pharmacy, 'alpha');
  });

  it('规则 4b：name 唯一（大小写/空白不敏感）', () => {
    const error = expectBadConfig(
      PharmacyRegistry.from(
        [
          pharmacyConfig(),
          pharmacyConfig({ id: 'BETA', name: ' alpha   rx ', contacts: ['beta@alpha.example'] }),
        ],
        REGISTRY_DEPS,
      ),
      REGISTRY_RULES.uniqueName,
    );
    assert.equal(error.detail?.duplicateOf, 'ALPHA');
  });

  it('规则 4c：contacts 全局唯一（一封邮件不能代表两家药房）', () => {
    const error = expectBadConfig(
      PharmacyRegistry.from(
        [
          pharmacyConfig(),
          pharmacyConfig({ id: 'BETA', name: 'Beta Rx', contacts: ['OPS@ALPHA.EXAMPLE'] }),
        ],
        REGISTRY_DEPS,
      ),
      REGISTRY_RULES.uniqueContacts,
    );
    assert.equal(error.detail?.pharmacy, 'BETA');
    assert.equal(error.detail?.duplicateOf, 'ALPHA');
  });

  it('规则 5a：shipsInDays 必须是非负整数', () => {
    for (const shipsInDays of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectBadConfig(
        PharmacyRegistry.from([pharmacyConfig({ shipsInDays })], REGISTRY_DEPS),
        REGISTRY_RULES.shipsInDays,
      );
    }
  });

  it('规则 5b：dailyCapacity 必须是非负整数', () => {
    for (const dailyCapacity of [-2, 2.5, Number.NaN]) {
      expectBadConfig(
        PharmacyRegistry.from([pharmacyConfig({ dailyCapacity })], REGISTRY_DEPS),
        REGISTRY_RULES.dailyCapacity,
      );
    }
  });

  it('身份缺失：空 id / 空 name / contacts 非数组', () => {
    expectBadConfig(
      PharmacyRegistry.from([pharmacyConfig({ id: ' ' })], REGISTRY_DEPS),
      REGISTRY_RULES.identity,
    );
    expectBadConfig(
      PharmacyRegistry.from([pharmacyConfig({ name: '' })], REGISTRY_DEPS),
      REGISTRY_RULES.identity,
    );
    expectBadConfig(
      PharmacyRegistry.from(
        [pharmacyConfig({ contacts: 'ops@alpha.example' as unknown as string[] })],
        REGISTRY_DEPS,
      ),
      REGISTRY_RULES.uniqueContacts,
    );
  });

  it('失败一律走 Err，不抛异常；空 config 列表是合法空注册表', () => {
    assert.doesNotThrow(() =>
      PharmacyRegistry.from(
        [pharmacyConfig({ price: {} as PharmacyConfig['price'] })],
        REGISTRY_DEPS,
      ),
    );
    const empty = PharmacyRegistry.from([], REGISTRY_DEPS);
    if (!empty.ok) assert.fail('空药房列表应成功');
    assert.deepEqual(empty.value.all(), []);
    assert.equal(empty.value.resolve('ALPHA'), undefined);
  });
});
