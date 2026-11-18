/**
 * `MedicationNormalizer`：把订单/邮件里的药品写法归一化成 catalogue 的药品键
 * （`ARCHITECTURE.md` §5.3）。
 *
 * 允许的规则只有两条：
 * 1. 目录键本身（大小写/空白不敏感）；
 * 2. 显式别名表，默认 `tirz → tirzepatide`、`sema → semaglutide`（C10 允许的
 *    与周无关常量）。
 *
 * 明令禁止：用「前缀相似」猜药名。`tirzep`、`ozempic` 一律失败。
 * 归一化结果必须落在 catalogue 里：别名指向目录外的药品同样失败（目录是唯一真值）。
 */
import type { Catalogue } from '../catalogue.ts';
import type { MedicationId, Normalized } from '../types.ts';

/**
 * 默认别名表（`ARCHITECTURE.md` §5.3）。键是规范形式（小写、无空白）；
 * 构造 `MedicationNormalizer` 时会把传入的别名表再规范化一次。
 */
export const DEFAULT_MEDICATION_ALIASES: ReadonlyMap<string, MedicationId> = new Map([
  ['tirz', 'tirzepatide'],
  ['sema', 'semaglutide'],
]);

/** 只做空白/大小写规范化：去首尾、删除全部空白、转小写。 */
function normalizeKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '');
}

export class MedicationNormalizer {
  /** 规范化后的别名表：规范键 → 目标药品键。 */
  private readonly aliases: ReadonlyMap<string, MedicationId>;
  /** catalogue 药品键 → 药品键的规范化形式，用于大小写/空白不敏感的直接匹配。 */
  private readonly catalogueKeys: ReadonlyMap<string, MedicationId>;

  constructor(
    private readonly catalogue: Catalogue,
    aliases: ReadonlyMap<string, MedicationId>,
  ) {
    const normalizedAliases = new Map<string, MedicationId>();
    for (const [alias, medication] of aliases) {
      const key = normalizeKey(alias);
      if (key !== '' && typeof medication === 'string' && medication !== '') {
        normalizedAliases.set(key, medication);
      }
    }
    this.aliases = normalizedAliases;

    const keys = new Map<string, MedicationId>();
    for (const medication of catalogue.medications()) {
      keys.set(normalizeKey(medication), medication);
    }
    this.catalogueKeys = keys;
  }

  normalize(raw: string): Normalized<MedicationId> {
    const rawText = typeof raw === 'string' ? raw : String(raw ?? '');
    const key = normalizeKey(rawText);

    // 规则 1：目录键本身（返回 catalogue 里的原始拼写）。
    const direct = this.catalogueKeys.get(key);
    if (direct !== undefined) {
      return { ok: true, value: direct };
    }

    // 规则 2：显式别名表；别名目标必须真的在 catalogue 里（目录是唯一真值）。
    const aliased = this.aliases.get(key);
    if (aliased !== undefined) {
      const medication = this.catalogueKeys.get(normalizeKey(aliased));
      if (medication !== undefined) {
        return { ok: true, value: medication };
      }
    }

    // 其余一律失败：不做前缀/子串/相似度匹配。
    return { ok: false, code: 'unknown_medication', raw: rawText };
  }
}
