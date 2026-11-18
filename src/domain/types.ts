/**
 * 领域内共享的「值类型」别名与归一化结果类型。
 *
 * 这些别名只是给 string 一个可读的名字，不做运行时校验；校验发生在
 * kernel/time 与 domain/normalize。真实约束见 `DATA-CONTRACTS.md` §1。
 */
import type { ErrorCode } from '../kernel/errors.ts';

/** RFC3339 带偏移的时间字符串，例如 "2026-01-05T09:00:00-05:00"。 */
export type Iso = string;

/** 药房 id，config 里给出，例如 "PHARM_A"。 */
export type PharmacyId = string;

/** 两位 USPS 州码，例如 "TX"。 */
export type StateCode = string;

/** 目录里的药品键，例如 "tirzepatide"。 */
export type MedicationId = string;

/** 目录里的精确剂量，例如 "7.5mg"。 */
export type DoseId = string;

/** 订单 id，例如 "example-order"。 */
export type OrderId = string;

/** fact id，例如 "fact_0028"。 */
export type FactId = string;

/** fact 主体键，由 `subjectKeyOf` 生成。 */
export type SubjectKey = string;

/**
 * 归一化结果：预期内的失败不是异常，而是一个值（`REQUIREMENTS` §10、D6）。
 * 失败分支带错误码与原始输入，便于审计与 Sam 列表展示。
 */
export type Normalized<T> =
  | { ok: true; value: T }
  | { ok: false; code: ErrorCode; raw: string };
