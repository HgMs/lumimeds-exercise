/**
 * `PharmacyView`：展示/审计用的只读 DTO（`DATA-CONTRACTS.md` §3.3、
 * `ARCHITECTURE.md` §5.5）。
 *
 * 只给 `GET /state` 与 MANUAL 原因串的可读性使用，**不参与资格判定**——判定只有
 * `PharmacyBelief.failuresFor()` 一个出口（避免「一套表示、两套语义」分叉）。
 *
 * 形状是领域内 camelCase；落盘/HTTP 的 snake_case 由 `application/` 的
 * `SnapshotMapper` / handler 负责转换（§11.1「命名边界」）。
 */
import type { DoseId, MedicationId, PharmacyId, StateCode } from '../types.ts';

export interface PharmacyView {
  id: PharmacyId;
  name: string;
  /** 求值时刻是否营业（只看那一刻，不预检未来停业）。 */
  openNow: boolean;
  shipsInDays: number;
  capacityToday: number;
  capacityUsedToday: number;
  capacityLeft: number;
  price: Readonly<Record<MedicationId, number>>;
  /** 求值时刻仍被封锁的州（见 `PharmacyBelief.toView` 的口径说明）。 */
  blockedStates: readonly StateCode[];
  /** 求值时刻有现货的剂量（见 `PharmacyBelief.toView` 的口径说明）。 */
  stock: Readonly<Record<MedicationId, readonly DoseId[]>>;
}
