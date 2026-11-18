/**
 * Catalogue：本周合法的「药品 → 精确剂量」目录（`ARCHITECTURE.md` §5.2）。
 *
 * 唯一真值来自 `simulation.started` 的 `config.catalogue`（`DATA-CONTRACTS.md` §1.2）：
 * 路由的资格检查、归一化器的 dose 校验都只认这里出现的精确字符串。
 *
 * 不可变 + 顺序确定：
 * - 药品顺序 = `config.catalogue` 对象的键顺序（JSON 解析保留插入顺序）；
 * - 每个药品的剂量顺序 = config 数组顺序，重复项按首次出现去重。
 * 顺序显式固定，`MANUAL` 原因串与任何依赖遍历顺序的输出才可复现。
 */
import type { DoseId, MedicationId } from './types.ts';

/** 冻结的空剂量表：所有未知药品共享同一份，避免每次新建数组。 */
const NO_DOSES: readonly DoseId[] = Object.freeze([]);

export class Catalogue {
  /** 目录里的全部药品，顺序 = config 键顺序。 */
  private readonly medicationOrder: readonly MedicationId[];
  /** 药品 → 剂量（已去重、已冻结）。 */
  private readonly dosesByMedication: ReadonlyMap<MedicationId, readonly DoseId[]>;

  private constructor(
    medicationOrder: readonly MedicationId[],
    dosesByMedication: ReadonlyMap<MedicationId, readonly DoseId[]>,
  ) {
    this.medicationOrder = medicationOrder;
    this.dosesByMedication = dosesByMedication;
  }

  /**
   * 从外部 config 构建不可变目录。
   *
   * 这里的容错只针对「形状不对的输入」，不做值域判断：非数组的剂量表按空处理、
   * 重复剂量去重。catalogue 本身的错误（例如某家药房的 price 缺一个药）由
   * `PharmacyRegistry.from` 在启动时统一拒掉（`ARCHITECTURE.md` §5.2）。
   */
  static from(raw: Readonly<Record<string, readonly string[]>>): Catalogue {
    const medicationOrder: MedicationId[] = [];
    const dosesByMedication = new Map<MedicationId, readonly DoseId[]>();

    for (const medication of Object.keys(raw)) {
      if (medication === '') continue;
      const doses = raw[medication];
      const deduped: DoseId[] = [];
      const seen = new Set<DoseId>();
      if (Array.isArray(doses)) {
        for (const dose of doses) {
          if (typeof dose !== 'string' || dose === '') continue;
          if (seen.has(dose)) continue;
          seen.add(dose);
          deduped.push(dose);
        }
      }
      medicationOrder.push(medication);
      dosesByMedication.set(medication, Object.freeze(deduped));
    }

    return new Catalogue(Object.freeze(medicationOrder), dosesByMedication);
  }

  /** 目录里的药品，顺序稳定（config 键顺序）。 */
  medications(): readonly MedicationId[] {
    return this.medicationOrder;
  }

  /** 药品键是否在目录里（精确匹配；大小写/空白归一化由 `MedicationNormalizer` 负责）。 */
  hasMedication(medication: string): boolean {
    return this.dosesByMedication.has(medication);
  }

  /** 剂量是否是该药品在目录里的精确剂量（精确匹配；归一化由 `DoseNormalizer` 负责）。 */
  hasDose(medication: MedicationId, dose: string): boolean {
    const doses = this.dosesByMedication.get(medication);
    return doses !== undefined && doses.includes(dose);
  }

  /** 某药品的全部合法剂量；未知药品返回空表（不抛异常）。 */
  dosesOf(medication: MedicationId): readonly DoseId[] {
    return this.dosesByMedication.get(medication) ?? NO_DOSES;
  }
}
