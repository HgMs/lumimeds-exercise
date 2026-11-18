/**
 * 邮件领域层单测的共享夹具。
 *
 * 这里用真实风格的周数据（药房、联系人、目录、时间）构造 registry/calendar，
 * 让每个用例都跑在与 week A 同形状的世界里；断言仍然是针对规则的，不依赖周数据。
 *
 * 文件名是 `email-fixtures.ts`（不是 `.test.ts`），不会被测试运行器当成用例文件。
 */
import { Catalogue } from '../../src/domain/catalogue.ts';
import type { PharmacyConfig } from '../../src/domain/config.ts';
import { PermissionPolicy } from '../../src/domain/email/permission.ts';
import { PhraseParser } from '../../src/domain/email/phrase-parser.ts';
import { SenderResolver } from '../../src/domain/email/sender.ts';
import type { SenderIdentity } from '../../src/domain/email/sender.ts';
import { FactValidator } from '../../src/domain/email/validator.ts';
import type { FactValidatorDeps } from '../../src/domain/email/validator.ts';
import { PharmacyRegistry } from '../../src/domain/pharmacy.ts';
import { StateNormalizer } from '../../src/domain/normalize/state-normalizer.ts';
import { EtCalendar } from '../../src/kernel/time/et-calendar.ts';
import { etDate } from '../../src/kernel/time/et-date.ts';
import type { EtDate } from '../../src/kernel/time/et-date.ts';
import { Instant } from '../../src/kernel/time/instant.ts';

/** `simulation.started.config.lumimedsOps`（DATA-CONTRACTS §1.2）。 */
export const OPS: readonly string[] = ['sam@lumimeds.example', 'ops-lead@lumimeds.example'];

/** week A 的 catalogue（唯一真值）。 */
export const CATALOGUE_RAW = {
  semaglutide: ['0.25mg', '0.5mg', '1mg', '1.7mg', '2.4mg'],
  tirzepatide: ['2.5mg', '5mg', '7.5mg', '10mg', '12.5mg', '15mg'],
} as const;

export const catalogue = Catalogue.from(CATALOGUE_RAW);
export const calendar = new EtCalendar();
const stateNormalizer = new StateNormalizer();

/** 解析一个 ET 日期字面量；测试夹具里非法就是测试写错了，直接抛。 */
export function et(value: string): EtDate {
  const parsed = etDate(value);
  if (!parsed.ok) throw new Error(`bad test ET date ${value}: ${parsed.error.message}`);
  return parsed.value;
}

/** 解析一个带偏移的瞬时；测试夹具里非法就是测试写错了，直接抛。 */
export function instant(value: string): Instant {
  const parsed = Instant.parse(value);
  if (!parsed.ok) throw new Error(`bad test instant ${value}: ${parsed.error.message}`);
  return parsed.value;
}

/** 校验窗口：闭区间 `[2026-11-09, 2026-11-23]`（第 15 天 00:00 也含）。 */
export const WINDOW_FROM = et('2026-11-09');
export const WINDOW_TO = et('2026-11-23');

/** 5 家药房的 config（形状与 week A 同构，价格/库存可自洽即可）。 */
const PHARMACY_CONFIGS: readonly PharmacyConfig[] = [
  {
    id: 'TANDREL',
    name: 'Tandrel Rx',
    contacts: ['jen@tandrel.example', 'orders@tandrel.example', 'john@tandrel.example'],
    open: true,
    shipsInDays: 1,
    dailyCapacity: 4,
    price: { semaglutide: 140, tirzepatide: 210 },
    blockedStates: ['FL', 'GA', 'NJ', 'AK'],
    stock: {
      semaglutide: ['0.25mg', '0.5mg', '1mg', '1.7mg', '2.4mg'],
      tirzepatide: ['2.5mg', '5mg', '7.5mg', '10mg', '12.5mg', '15mg'],
    },
  },
  {
    id: 'VELMORA',
    name: 'Velmora Pharmacy',
    contacts: ['ops@velmora.example'],
    open: true,
    shipsInDays: 2,
    dailyCapacity: 5,
    price: { semaglutide: 110, tirzepatide: 190 },
    blockedStates: ['CA', 'AZ', 'NJ', 'AK'],
    stock: {
      semaglutide: ['0.25mg', '0.5mg', '1mg'],
      tirzepatide: ['2.5mg', '5mg', '7.5mg', '10mg'],
    },
  },
  {
    id: 'CORVANE',
    name: 'Corvane Compounding',
    contacts: ['mark@corvane.example'],
    open: true,
    shipsInDays: 3,
    dailyCapacity: 6,
    price: { semaglutide: 120, tirzepatide: 175 },
    blockedStates: ['NY', 'AZ', 'NJ', 'AK'],
    stock: {
      semaglutide: ['0.25mg', '0.5mg', '1mg', '1.7mg', '2.4mg'],
      tirzepatide: ['2.5mg', '5mg', '7.5mg', '10mg', '12.5mg', '15mg'],
    },
  },
  {
    id: 'ISHBY',
    name: 'Ishby Rx',
    contacts: ['orders@ishby.example'],
    open: true,
    shipsInDays: 1,
    dailyCapacity: 3,
    price: { semaglutide: 150, tirzepatide: 230 },
    blockedStates: ['Texas', 'FL', 'CA', 'AZ', 'GA'],
    stock: {
      semaglutide: ['0.25mg', '0.5mg', '1mg'],
      tirzepatide: ['5mg', '7.5mg'],
    },
  },
  {
    id: 'WRENFOLD',
    name: 'Wrenfold Pharma',
    contacts: ['hello@wrenfold.example'],
    open: true,
    shipsInDays: 2,
    dailyCapacity: 3,
    price: { semaglutide: 105, tirzepatide: 180 },
    blockedStates: ['FL', 'GA', 'NY', 'NJ', 'AK'],
    stock: {
      semaglutide: ['0.25mg', '0.5mg', '1mg'],
      tirzepatide: ['2.5mg', '10mg'],
    },
  },
];

function buildRegistry(): PharmacyRegistry {
  const built = PharmacyRegistry.from(PHARMACY_CONFIGS, { catalogue, states: stateNormalizer });
  if (!built.ok) throw new Error(`test registry failed: ${built.error.message}`);
  return built.value;
}

export const registry = buildRegistry();
export const resolver = new SenderResolver(OPS, registry);
export const permission = new PermissionPolicy(registry);
export const phrases = new PhraseParser(calendar);

/** 构造一个 validator；默认窗口是 `[2026-11-09, 2026-11-23]`。 */
export function makeValidator(overrides: Partial<FactValidatorDeps> = {}): FactValidator {
  return new FactValidator({
    calendar,
    catalogue,
    registry,
    permission,
    phrases,
    window: { from: WINDOW_FROM, to: WINDOW_TO },
    ...overrides,
  });
}

/** 默认的校验器（窗口 = week A 的 `[周开始, 周开始 + 14 天]`）。 */
export const validator = makeValidator();

/** 解析发件人身份；测试里常用 `senderOf('jen@tandrel.example')`。 */
export function senderOf(from: string): SenderIdentity {
  return resolver.resolve(from);
}
