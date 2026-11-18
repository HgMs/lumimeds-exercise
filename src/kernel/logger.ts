/**
 * `Logger`：给人看的单行 JSON 日志（`ARCHITECTURE.md` §5.1、§5.10）。
 *
 * 注意两件事：
 * 1. **审计不用日志实现**：审计走 `JsonlAuditSink`（`out/decisions.jsonl` 等）。
 * 2. **不读进程时钟**：kernel 内禁止读进程时钟（INV-1：无参 `new Date`、
 *    `Date.now` 这类 API）。「现在」是业务时间，由调用方在
 *    `logger.child({ event_id, at })` 里显式传入。
 */
import { AppError } from './errors.ts';

/** 允许的日志字段值（`JSON.stringify` 能安全序列化的东西）。 */
export type LogFields = Record<string, unknown>;

/** 结构化日志接口：每次处理事件拿 `logger.child({ event_id, at })`。 */
export interface Logger {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

/** 把任意 thrown 值变成可 JSON 序列化的形状。 */
function serialize(value: unknown): unknown {
  if (value instanceof AppError) return value.toJSON();
  if (value instanceof Error) return { name: value.name, message: value.message };
  return value;
}

/** 单行 JSON；`undefined` 字段被 `JSON.stringify` 天然丢弃。 */
function line(level: 'info' | 'warn' | 'error', base: LogFields, msg: string, fields?: LogFields): string {
  const record: LogFields = { level, ...base, ...fields, msg };
  try {
    return JSON.stringify(record, (_key, value: unknown) => serialize(value));
  } catch {
    // 环形结构等：不能因为日志把自己弄挂。
    return JSON.stringify({ level, msg, log_error: 'unserializable fields' });
  }
}

/** 什么都不做的 logger（测试与「只要接口占位」的场景）。 */
export const noopLogger: Logger = {
  info: (): void => {},
  warn: (): void => {},
  error: (): void => {},
  child: (): Logger => noopLogger,
};

/**
 * 生产 logger：info → stdout，warn/error → stderr，每行一个 JSON 对象。
 * 字段顺序固定为 `level, <base>, <fields>, msg`，便于 `jq` 与 diff。
 */
export function createLogger(base: LogFields = {}): Logger {
  const emit = (level: 'info' | 'warn' | 'error', msg: string, fields?: LogFields): void => {
    const text = line(level, base, msg, fields);
    if (level === 'info') process.stdout.write(`${text}\n`);
    else process.stderr.write(`${text}\n`);
  };
  return {
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (fields) => createLogger({ ...base, ...fields }),
  };
}
