/**
 * `OrderNormalizer`：`RawOrder`（病人侧写法）→ `NormalizedOrder`（领域标准值），
 * 失败时给出原因码（`ARCHITECTURE.md` §5.3、`DATA-CONTRACTS.md` §1.4）。
 *
 * 订单结构化数据不过 LLM；归一化全部在代码里做，且**失败不是异常**：
 * 返回 `Err(AppError(...))`，调用方据此把订单交给 `MANUAL`，不抛异常。
 *
 * 失败原因码（与三个子归一化器对齐）：
 * - `unknown_state`：州既不是两位 USPS 码也不是 50 州 + DC 全名；
 * - `unknown_medication`：药品不在 catalogue、也不是已知别名；
 * - `unknown_dose`：剂量不是该药品在 catalogue 里的精确剂量（`25mg`、`7.5` 都失败）；
 * - `missing_field`：订单缺少 `order_id`（无法定位/回报这单）。
 */
import { AppError } from '../../kernel/errors.ts';
import type { ErrorCode } from '../../kernel/errors.ts';
import { err, ok } from '../../kernel/result.ts';
import type { Result } from '../../kernel/result.ts';
import type { DoseId, MedicationId, OrderId, StateCode } from '../types.ts';
import type { RawOrder } from '../events.ts';
import type { DoseNormalizer } from './dose-normalizer.ts';
import type { MedicationNormalizer } from './medication-normalizer.ts';
import type { StateNormalizer } from './state-normalizer.ts';

/** 归一化后的订单：路由、决策日志、发单都只用这个形状。 */
export interface NormalizedOrder {
  orderId: OrderId;
  state: StateCode;
  medication: MedicationId;
  dose: DoseId;
}

/** 把 `Normalized` 的失败分支折成带字段上下文的 `AppError`。 */
function failure(
  code: ErrorCode,
  orderId: string,
  field: 'state' | 'medication' | 'dose',
  raw: string,
): AppError {
  return new AppError(code, `订单 ${orderId} 的 ${field} 无法归一化：${raw}`, {
    order_id: orderId,
    field,
    raw,
  });
}

export class OrderNormalizer {
  constructor(
    private readonly states: StateNormalizer,
    private readonly medications: MedicationNormalizer,
    private readonly doses: DoseNormalizer,
  ) {}

  normalize(raw: RawOrder): Result<NormalizedOrder, AppError> {
    // order_id 只是标识符，不归一化；缺了就无法定位/回报这单。
    const orderId = (raw as Partial<RawOrder> | null | undefined)?.order_id;
    if (typeof orderId !== 'string' || orderId.trim() === '') {
      return err(
        new AppError('missing_field', '订单缺少 order_id，无法归一化', {
          field: 'order_id',
          order: raw,
        }),
      );
    }

    const state = this.states.normalize(raw.state);
    if (!state.ok) {
      return err(failure(state.code, orderId, 'state', state.raw));
    }

    const medication = this.medications.normalize(raw.medication);
    if (!medication.ok) {
      return err(failure(medication.code, orderId, 'medication', medication.raw));
    }

    const dose = this.doses.normalize(raw.dose, medication.value);
    if (!dose.ok) {
      return err(failure(dose.code, orderId, 'dose', dose.raw));
    }

    return ok({
      orderId,
      state: state.value,
      medication: medication.value,
      dose: dose.value,
    });
  }
}
