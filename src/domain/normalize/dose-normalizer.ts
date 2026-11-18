/**
 * `DoseNormalizer`：把订单/邮件里的剂量写法归一化成 catalogue 的**精确**剂量
 * （`ARCHITECTURE.md` §5.3、`REQUIREMENTS.md` §4.3 第 3 条）。
 *
 * 允许的规则只有一条：去首尾空白、压缩内部空白、单位小写，即空白规范化
 * （`" 7.5 mg "` → `"7.5mg"`）。归一化结果必须精确等于 catalogue 里该药品的某个剂量。
 *
 * 明令禁止：**补单位**（`"7.5"` 不得变成 `"7.5mg"`）、四舍五入、模糊匹配
 * （`"25mg"` 若不在目录就失败，即使它看起来像 `"2.5mg"` 的笔误）。
 *
 * 边界说明：这里做的只是「空白也是分隔符」的字符级规范化，**不添加任何字符**，
 * 因此 `"7.5"` 归一化后仍是 `"7.5"`、仍然没有单位、仍然失败——与单位推断无关。
 * `2.5mg` vs `25mg` 是 `REQUIREMENTS.md` §10 点名的最要命错法，单测钉死。
 */
import type { Catalogue } from '../catalogue.ts';
import type { DoseId, MedicationId, Normalized } from '../types.ts';

/** 把剂量写法规范化成比较键：去首尾、删除全部空白、转小写。 */
function normalizeKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '');
}

export class DoseNormalizer {
  /** 药品键的规范化形式 → 该药品的剂量表（比较键 → catalogue 原始剂量）。 */
  private readonly dosesByMedication: ReadonlyMap<string, ReadonlyMap<string, DoseId>>;

  constructor(catalogue: Catalogue) {
    const byMedication = new Map<string, ReadonlyMap<string, DoseId>>();
    for (const medication of catalogue.medications()) {
      const doses = new Map<string, DoseId>();
      for (const dose of catalogue.dosesOf(medication)) {
        // 键比较用的规范形式与输入侧完全一致；值保留 catalogue 的原始拼写。
        const key = normalizeKey(dose);
        if (key !== '' && !doses.has(key)) doses.set(key, dose);
      }
      byMedication.set(normalizeKey(medication), doses);
    }
    this.dosesByMedication = byMedication;
  }

  /**
   * @param raw 原始剂量写法，例如 `" 7.5 mg "`。
   * @param medication 已归一化的药品（通常来自 `MedicationNormalizer`）。
   */
  normalize(raw: string, medication: MedicationId): Normalized<DoseId> {
    const rawText = typeof raw === 'string' ? raw : String(raw ?? '');
    const candidate = normalizeKey(rawText);
    const doses = this.dosesByMedication.get(normalizeKey(medication));
    // candidate === '' 时不可能命中（catalogue 剂量非空），无需特判。
    const dose = doses?.get(candidate);
    if (dose !== undefined) {
      return { ok: true, value: dose };
    }
    return { ok: false, code: 'unknown_dose', raw: rawText };
  }
}
