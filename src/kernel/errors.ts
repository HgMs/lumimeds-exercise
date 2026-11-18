/**
 * `AppError` 与封闭的 `ErrorCode` 集合（`ARCHITECTURE.md` §5.1、§9；`DATA-CONTRACTS.md` §8）。
 *
 * 不变量：
 * - `ErrorCode` 是**封闭**字符串联合：新增码必须先登记进 `ARCHITECTURE.md` §9 失败矩阵，
 *   否则 §9 的「每个码都有一行」这条自检就不成立。
 * - 错误是值：调用方用 `Result` 接住并决定对外行为（进 Sam / MANUAL / 500），
 *   不要 `try/catch` 后静默继续。
 */

/** 封闭错误码集合；与 `ARCHITECTURE.md` §9 失败矩阵一一对应。 */
export type ErrorCode =
  // 入站/形状
  | 'bad_request'
  | 'missing_field'
  | 'bad_timestamp'
  | 'bad_started_config'
  // 目录/归一化
  | 'unknown_pharmacy'
  | 'unknown_medication'
  | 'unknown_dose'
  | 'unknown_state'
  // 时间区间与校验
  | 'bad_interval'
  | 'interval_out_of_window'
  | 'missing_field_for_type'
  // 权限
  | 'no_permission'
  | 'cross_pharmacy'
  | 'routing_requires_ops'
  | 'unknown_sender'
  // 抽取/持久化/网关/查找
  | 'extraction_failed'
  | 'not_found'
  | 'persist_failed'
  | 'gateway_failed';

/**
 * 领域错误：`code` 决定调用方行为，`message` 给人看（会进 Sam / 日志 / audit），
 * `detail` 放结构化上下文（原始值、药房、字段名……），不参与判断。
 */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }

  /**
   * 让 `JSON.stringify(error)` 不丢 code/detail（日志与 Sam 需要可读的原始错误）。
   * `Error.message`/`name` 是不可枚举属性，默认序列化成 `{}`，所以显式给一份。
   */
  toJSON(): { name: 'AppError'; code: ErrorCode; message: string; detail?: Record<string, unknown> } {
    const base = { name: 'AppError' as const, code: this.code, message: this.message };
    return this.detail === undefined ? base : { ...base, detail: this.detail };
  }
}
