/**
 * 外部 config 的形状（`DATA-CONTRACTS.md` §1.2）：字段名与 `simulation.started`
 * 里的 JSON **完全一致**（snake_case 之外的命名也照抄），不做任何重命名。
 *
 * 这一层是「契约类型」，不是「领域模型」：`domain/pharmacy.ts` 会把
 * `PharmacyConfig` 归一化成不可变的 `PharmacyBase`。因此这里保留外部原始形状，
 * 包括 `blockedStates: string[]`（可能写全名，如州名全称）。
 */
import type { DoseId, MedicationId, PharmacyId } from './types.ts';

/** `simulation.started.config`（`DATA-CONTRACTS.md` §1.2）。 */
export interface SimConfig {
  /** 本周合法药品与剂量，唯一真值。 */
  catalogue: Record<MedicationId, DoseId[]>;
  /** 有权下路由指令的 LumiMeds ops 地址。 */
  lumimedsOps: string[];
  pharmacies: PharmacyConfig[];
}

/** config 里的一家药房。 */
export interface PharmacyConfig {
  id: PharmacyId;
  name: string;
  /** 能代表这家药房发言的地址（小写化与唯一性在 `PharmacyRegistry.from` 校验）。 */
  contacts: string[];
  /**
   * 正常日子是否接单。`REQUIREMENTS.md` §3.1 的默认值是 `true`：
   * 外部事件通常显式给出，缺省按 `true` 处理（`PharmacyRegistry.from`）。
   */
  open?: boolean;
  /** 从接单到发货的天数（速度），非负整数。 */
  shipsInDays: number;
  /** 每个自然日的接单上限，非负整数。 */
  dailyCapacity: number;
  /** 我们每单付多少美元（整数），必须覆盖 catalogue 的全部药品。 */
  price: Record<MedicationId, number>;
  /** 不能发货的州；可能写全名，加载时归一化成两位 USPS 码。 */
  blockedStates: string[];
  /** 现货的精确剂量，键必须是 catalogue 药品、值 ⊆ catalogue[药品]。 */
  stock: Record<MedicationId, DoseId[]>;
}
