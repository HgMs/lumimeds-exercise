/**
 * 药房的领域视图与注册表（`ARCHITECTURE.md` §5.2）。
 *
 * `PharmacyBase` 是 config 的归一化、不可变视图：州码已归一化、联系人已小写、
 * 价格/现货按 catalogue 形状补齐。`PharmacyRegistry` 负责一次性做完 config 的
 * 形状校验（ARCHITECTURE §5.2 的 5 条），之后所有模块只与不可变对象打交道。
 *
 * 失败语义：config 数据有问题 → `Err(AppError('bad_started_config'))` →
 * `simulation.started` 回 500（`DATA-CONTRACTS.md` §1.5）。**不抛异常**。
 */
import { AppError } from '../kernel/errors.ts';
import { err, ok } from '../kernel/result.ts';
import type { Result } from '../kernel/result.ts';
import type { Catalogue } from './catalogue.ts';
import type { PharmacyConfig } from './config.ts';
import type { StateNormalizer } from './normalize/state-normalizer.ts';
import type { DoseId, MedicationId, PharmacyId, StateCode } from './types.ts';

/**
 * `PharmacyRegistry.from` 的依赖：目录（价格的覆盖范围、stock 的合法剂量）与
 * 州归一化器（`blockedStates` 里可能出现 `"Texas"` 这类全名）。
 */
export interface PharmacyRegistryDeps {
  readonly catalogue: Catalogue;
  readonly states: StateNormalizer;
}

/** `PharmacyBase` 的构造入参（只由 `PharmacyRegistry.from` 在完整校验后构造）。 */
export interface PharmacyBaseInit {
  id: PharmacyId;
  name: string;
  contacts: readonly string[];
  openByDefault: boolean;
  shipsInDays: number;
  dailyCapacity: number;
  price: Readonly<Record<MedicationId, number>>;
  blockedStates: readonly StateCode[];
  stock: Readonly<Record<MedicationId, readonly DoseId[]>>;
}

/**
 * 一家药房的不可变归一化视图。`id` 是全局唯一键（排序、发单、审计都用它）。
 * 注意 `contacts` 是**小写**地址：发件人身份只按地址集合判断，不看 local-part。
 */
export class PharmacyBase {
  readonly id: PharmacyId;
  readonly name: string;
  readonly contacts: readonly string[];
  /** config.open 的归一化：缺省 `true`（`REQUIREMENTS.md` §3.1）。 */
  readonly openByDefault: boolean;
  readonly shipsInDays: number;
  readonly dailyCapacity: number;
  /** 覆盖 catalogue 全部药品的价格（归一化后一定完整）。 */
  readonly price: Readonly<Record<MedicationId, number>>;
  /** 已归一化成两位 USPS 码，顺序 = config 顺序去重后。 */
  readonly blockedStates: readonly StateCode[];
  /** 每个 catalogue 药品都有键（无现货 = 空数组），顺序 = catalogue 剂量顺序。 */
  readonly stock: Readonly<Record<MedicationId, readonly DoseId[]>>;

  constructor(init: PharmacyBaseInit) {
    this.id = init.id;
    this.name = init.name;
    this.contacts = init.contacts;
    this.openByDefault = init.openByDefault;
    this.shipsInDays = init.shipsInDays;
    this.dailyCapacity = init.dailyCapacity;
    this.price = init.price;
    this.blockedStates = init.blockedStates;
    this.stock = init.stock;
    Object.freeze(this);
  }
}

/** `from` 的失败详情里固定的规则名，便于测试与日志定位「哪家药房哪一条」。 */
export const REGISTRY_RULES = {
  pharmaciesArray: 'pharmacies_array',
  identity: 'identity',
  priceCoversCatalogue: 'price_covers_catalogue',
  stockKeys: 'stock_keys',
  stockDoses: 'stock_doses',
  blockedStatesNormalizable: 'blocked_states_normalizable',
  uniqueId: 'unique_id',
  uniqueName: 'unique_name',
  uniqueContacts: 'unique_contacts',
  shipsInDays: 'ships_in_days',
  dailyCapacity: 'daily_capacity',
} as const;

function badConfig(message: string, detail: Record<string, unknown>): AppError {
  return new AppError('bad_started_config', message, detail);
}

/** 名称/州全名的规范化键：去首尾、转小写、内部连续空白压成一个空格。 */
function nameKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** 联系人地址的规范化键：去首尾、转小写。 */
function contactKey(raw: string): string {
  return raw.trim().toLowerCase();
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * 药房注册表：config 的归一化视图集合 + 解析入口。
 *
 * 不变量：
 * - `all()` 顺序稳定（**按 id 升序**，用码点比较，不受机器 locale 影响）；
 * - `resolve` 只认 id 或 name（大小写/空白不敏感），**不做**前缀/子串/相似匹配；
 * - `byContact` 是大小写不敏感的**精确**地址匹配，contacts 全局唯一。
 */
export class PharmacyRegistry {
  /** 按 id 升序的稳定顺序。 */
  private readonly ordered: readonly PharmacyBase[];
  /** 精确 id → 药房（`byId` 用）。 */
  private readonly byExactId: ReadonlyMap<string, PharmacyBase>;
  /** 规范化 id → 药房（`resolve` 第一步）。 */
  private readonly byIdKey: ReadonlyMap<string, PharmacyBase>;
  /** 规范化 name → 药房（`resolve` 第二步）。 */
  private readonly byNameKey: ReadonlyMap<string, PharmacyBase>;
  /** 小写地址 → 药房（`byContact`）。 */
  private readonly byContactKey: ReadonlyMap<string, PharmacyBase>;

  private constructor(ordered: readonly PharmacyBase[]) {
    this.ordered = ordered;
    const byExactId = new Map<string, PharmacyBase>();
    const byIdKey = new Map<string, PharmacyBase>();
    const byNameKey = new Map<string, PharmacyBase>();
    const byContactKey = new Map<string, PharmacyBase>();
    for (const pharmacy of ordered) {
      byExactId.set(pharmacy.id, pharmacy);
      // 唯一性已在 from 里校验过，这里的 overwrite 不可能发生。
      byIdKey.set(nameKey(pharmacy.id), pharmacy);
      byNameKey.set(nameKey(pharmacy.name), pharmacy);
      for (const contact of pharmacy.contacts) {
        byContactKey.set(contact, pharmacy);
      }
    }
    this.byExactId = byExactId;
    this.byIdKey = byIdKey;
    this.byNameKey = byNameKey;
    this.byContactKey = byContactKey;
  }

  /**
   * 从外部 config 构建注册表，并一次性做完 `ARCHITECTURE.md` §5.2 的 5 条形状校验：
   *
   * 1. 每家药房的 `price` 覆盖 catalogue 的全部药品（缺一个会让排序比较器拿到
   *    `undefined`，变成 `NaN` 排序）；
   * 2. `stock` 的键必须是 catalogue 药品，剂量必须 ⊆ `catalogue[medication]`；
   * 3. `blockedStates` 全部可归一化成两位州码；
   * 4. `id` 全局唯一、`name` 全局唯一、`contacts` 全局唯一（一封邮件不能代表两家药房）；
   * 5. `shipsInDays >= 0`、`dailyCapacity >= 0` 的整数。
   *
   * 任何一条不过 → `Err(AppError('bad_started_config', ..., { rule, pharmacy, ... }))`，
   * detail 里写明是哪家药房的哪一条规则。
   */
  static from(
    configs: readonly PharmacyConfig[],
    deps: PharmacyRegistryDeps,
  ): Result<PharmacyRegistry, AppError> {
    if (!Array.isArray(configs)) {
      return err(
        badConfig('config.pharmacies 必须是数组', { rule: REGISTRY_RULES.pharmaciesArray }),
      );
    }

    const { catalogue, states } = deps;
    const medications = catalogue.medications();
    const medicationSet = new Set<MedicationId>(medications);

    const built: PharmacyBase[] = [];
    const seenIds = new Map<string, PharmacyId>();
    const seenNames = new Map<string, PharmacyId>();
    const contactOwner = new Map<string, PharmacyId>();

    for (const config of configs) {
      // ---- 身份（id 是后续所有 detail 的定位键，先取出来） ----
      const rawId: unknown = (config as Partial<PharmacyConfig> | null | undefined)?.id;
      const id = typeof rawId === 'string' ? rawId : '';
      if (id.trim() === '') {
        return err(
          badConfig('药房 config 缺少非空 id', { rule: REGISTRY_RULES.identity, field: 'id' }),
        );
      }

      const rawName: unknown = (config as Partial<PharmacyConfig>).name;
      const name = typeof rawName === 'string' ? rawName : '';
      if (name.trim() === '') {
        return err(
          badConfig(`药房 ${id} 缺少非空 name`, {
            rule: REGISTRY_RULES.identity,
            pharmacy: id,
            field: 'name',
          }),
        );
      }

      // ---- 规则 1：price 覆盖 catalogue 全部药品 ----
      const priceConfig: Record<string, unknown> = isRecord(config?.price) ? config.price : {};
      const price: Record<MedicationId, number> = {};
      for (const medication of medications) {
        const value = priceConfig[medication];
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          return err(
            badConfig(`药房 ${id} 的 price 缺少 catalogue 药品 ${medication}`, {
              rule: REGISTRY_RULES.priceCoversCatalogue,
              pharmacy: id,
              medication,
              value: value ?? null,
            }),
          );
        }
        price[medication] = value;
      }
      Object.freeze(price);

      // ---- 规则 2：stock 的键必须是 catalogue 药品，剂量必须 ⊆ catalogue[medication] ----
      const stockConfig: Record<string, unknown> = isRecord(config?.stock) ? config.stock : {};
      for (const medication of Object.keys(stockConfig)) {
        if (!medicationSet.has(medication)) {
          return err(
            badConfig(`药房 ${id} 的 stock 含 catalogue 外的药品 ${medication}`, {
              rule: REGISTRY_RULES.stockKeys,
              pharmacy: id,
              medication,
            }),
          );
        }
      }
      const stock: Record<MedicationId, readonly DoseId[]> = {};
      for (const medication of medications) {
        const rawDoses: unknown = stockConfig[medication];
        const doses: DoseId[] = [];
        if (Array.isArray(rawDoses)) {
          const seen = new Set<DoseId>();
          for (const dose of rawDoses) {
            if (typeof dose !== 'string' || !catalogue.hasDose(medication, dose)) {
              return err(
                badConfig(`药房 ${id} 的 stock[${medication}] 含 catalogue 外的剂量 ${String(dose)}`, {
                  rule: REGISTRY_RULES.stockDoses,
                  pharmacy: id,
                  medication,
                  dose: typeof dose === 'string' ? dose : null,
                }),
              );
            }
            if (!seen.has(dose)) {
              seen.add(dose);
              doses.push(dose);
            }
          }
        } else if (rawDoses !== undefined) {
          return err(
            badConfig(`药房 ${id} 的 stock[${medication}] 必须是剂量数组`, {
              rule: REGISTRY_RULES.stockDoses,
              pharmacy: id,
              medication,
            }),
          );
        }
        stock[medication] = Object.freeze(doses);
      }
      Object.freeze(stock);

      // ---- 规则 3：blockedStates 全部可归一化（"Texas" → TX） ----
      const rawBlocked: unknown = config?.blockedStates;
      if (rawBlocked !== undefined && !Array.isArray(rawBlocked)) {
        return err(
          badConfig(`药房 ${id} 的 blockedStates 必须是数组`, {
            rule: REGISTRY_RULES.blockedStatesNormalizable,
            pharmacy: id,
          }),
        );
      }
      const blockedStates: StateCode[] = [];
      const seenStates = new Set<StateCode>();
      for (const rawState of Array.isArray(rawBlocked) ? rawBlocked : []) {
        if (typeof rawState !== 'string') {
          return err(
            badConfig(`药房 ${id} 的 blockedStates 含非字符串项`, {
              rule: REGISTRY_RULES.blockedStatesNormalizable,
              pharmacy: id,
              value: null,
            }),
          );
        }
        const normalized = states.normalize(rawState);
        if (!normalized.ok) {
          return err(
            badConfig(`药房 ${id} 的 blockedStates 含无法归一化的州 ${rawState}`, {
              rule: REGISTRY_RULES.blockedStatesNormalizable,
              pharmacy: id,
              raw: rawState,
              code: normalized.code,
            }),
          );
        }
        if (!seenStates.has(normalized.value)) {
          seenStates.add(normalized.value);
          blockedStates.push(normalized.value);
        }
      }
      Object.freeze(blockedStates);

      // ---- 规则 4：id / name / contacts 全局唯一 ----
      const idKey = nameKey(id);
      const duplicateId = seenIds.get(idKey);
      if (duplicateId !== undefined) {
        return err(
          badConfig(`药房 id 重复：${id}`, {
            rule: REGISTRY_RULES.uniqueId,
            pharmacy: id,
            duplicateOf: duplicateId,
          }),
        );
      }
      seenIds.set(idKey, id);

      const key = nameKey(name);
      const duplicateName = seenNames.get(key);
      if (duplicateName !== undefined) {
        return err(
          badConfig(`药房 name 重复：${name}（已属于 ${duplicateName}）`, {
            rule: REGISTRY_RULES.uniqueName,
            pharmacy: id,
            name,
            duplicateOf: duplicateName,
          }),
        );
      }
      seenNames.set(key, id);

      const rawContacts: unknown = config?.contacts;
      if (!Array.isArray(rawContacts)) {
        return err(
          badConfig(`药房 ${id} 的 contacts 必须是地址数组`, {
            rule: REGISTRY_RULES.uniqueContacts,
            pharmacy: id,
          }),
        );
      }
      const contacts: string[] = [];
      const seenContacts = new Set<string>();
      for (const rawContact of rawContacts) {
        if (typeof rawContact !== 'string' || rawContact.trim() === '') {
          return err(
            badConfig(`药房 ${id} 的 contacts 含空地址`, {
              rule: REGISTRY_RULES.uniqueContacts,
              pharmacy: id,
            }),
          );
        }
        const contact = contactKey(rawContact);
        if (seenContacts.has(contact)) continue; // 同一家重复列出不致命
        const owner = contactOwner.get(contact);
        if (owner !== undefined && owner !== id) {
          return err(
            badConfig(`联系人 ${contact} 同时属于药房 ${owner} 与 ${id}`, {
              rule: REGISTRY_RULES.uniqueContacts,
              pharmacy: id,
              contact,
              duplicateOf: owner,
            }),
          );
        }
        seenContacts.add(contact);
        contactOwner.set(contact, id);
        contacts.push(contact);
      }
      Object.freeze(contacts);

      // ---- 规则 5：shipsInDays / dailyCapacity 是非负整数 ----
      if (!isNonNegativeInteger(config?.shipsInDays)) {
        return err(
          badConfig(`药房 ${id} 的 shipsInDays 必须是非负整数`, {
            rule: REGISTRY_RULES.shipsInDays,
            pharmacy: id,
            value: config?.shipsInDays ?? null,
          }),
        );
      }
      if (!isNonNegativeInteger(config?.dailyCapacity)) {
        return err(
          badConfig(`药房 ${id} 的 dailyCapacity 必须是非负整数`, {
            rule: REGISTRY_RULES.dailyCapacity,
            pharmacy: id,
            value: config?.dailyCapacity ?? null,
          }),
        );
      }

      // `open` 缺省按 true（REQUIREMENTS §3.1）；非布尔值不猜，按缺省处理。
      const openByDefault = typeof config?.open === 'boolean' ? config.open : true;

      built.push(
        new PharmacyBase({
          id,
          name,
          contacts: Object.freeze(contacts),
          openByDefault,
          shipsInDays: config.shipsInDays,
          dailyCapacity: config.dailyCapacity,
          price,
          blockedStates: Object.freeze(blockedStates),
          stock,
        }),
      );
    }

    // 顺序确定：按 id 升序（码点比较，不用 localeCompare，避免机器 locale 影响）。
    const ordered = Object.freeze(
      [...built].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    );
    return ok(new PharmacyRegistry(ordered));
  }

  /** 全部药房，按 id 升序（稳定顺序；候选列表与 MANUAL 原因串都依赖它）。 */
  all(): readonly PharmacyBase[] {
    return this.ordered;
  }

  /** 按精确 id 查（内部已知 id 用；外部原始写法请用 `resolve`）。 */
  byId(id: string): PharmacyBase | undefined {
    return this.byExactId.get(id);
  }

  /**
   * 把模型/邮件给出的原始药房写法解析成药房：先按 id、再按 name，
   * 大小写/空白不敏感；**不做**前缀、子串或相似度匹配。解析不到 → `undefined`
   * （调用方按 `unknown_pharmacy` 处理，进 Sam 列表）。
   */
  resolve(raw: string): PharmacyBase | undefined {
    if (typeof raw !== 'string') return undefined;
    const key = nameKey(raw);
    if (key === '') return undefined;
    // id 优先：id 唯一、name 唯一，两者若撞键则 id 胜（规则明确「先 id 再 name」）。
    return this.byIdKey.get(key) ?? this.byNameKey.get(key);
  }

  /**
   * 按发件人地址查药房：小写后**精确**匹配（去首尾空白）。一封邮件只能代表
   * 一家药房（contacts 全局唯一）。找不到 → `undefined`。
   */
  byContact(address: string): PharmacyBase | undefined {
    if (typeof address !== 'string') return undefined;
    const key = contactKey(address);
    if (key === '') return undefined;
    return this.byContactKey.get(key);
  }
}

/** 运行时 `isRecord`：config 的 price/stock 可能是任意 JSON 值。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
