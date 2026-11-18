/**
 * `Result`：把「合法的失败」建模成返回值，而不是异常（`ARCHITECTURE.md` §5.1）。
 *
 * 为什么不用异常做校验：`unknown_dose` 不是「程序错了」，它是一条合法的邮件结论
 * （进 Sam 列表）。用异常会诱导 `try/catch` 把它吞掉；用 `Result` 强制调用方处理。
 *
 * 约定：
 * - 只 import 类型（`AppError`），本文件不依赖任何运行时模块，避免 kernel 内部环。
 * - `E` 默认是 `AppError`；`env.ts` 用 `Result<EnvConfig, string>` 给人类读的错误。
 */
import type { AppError } from './errors.ts';

/** 成功分支。 */
export type Ok<T> = { readonly ok: true; readonly value: T };

/** 失败分支。 */
export type Err<E> = { readonly ok: false; readonly error: E };

/** 二者之一；判别字段是 `ok`。 */
export type Result<T, E = AppError> = Ok<T> | Err<E>;

/** 构造成功分支。 */
export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

/** 构造失败分支。 */
export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

/** 类型守卫：是否成功。 */
export function isOk<T, E>(r: Result<T, E>): r is Ok<T> {
  return r.ok;
}

/** 类型守卫：是否失败。 */
export function isErr<T, E>(r: Result<T, E>): r is Err<E> {
  return !r.ok;
}

/** 映射成功值；失败原样透传（错误类型不变）。 */
export function map<T, U, E>(r: Result<T, E>, f: (value: T) => U): Result<U, E> {
  return r.ok ? ok(f(r.value)) : r;
}

/** 映射错误值；成功原样透传。 */
export function mapErr<T, E, F>(r: Result<T, E>, f: (error: E) => F): Result<T, F> {
  return r.ok ? r : err(f(r.error));
}

/** 串联：成功值再算出一个 `Result`；失败短路。 */
export function andThen<T, U, E>(r: Result<T, E>, f: (value: T) => Result<U, E>): Result<U, E> {
  return r.ok ? f(r.value) : r;
}

/**
 * 收集一组 `Result`：全部成功 → `Ok(values)`；任一失败 → **第一个**失败（短路语义）。
 * 校验场景用它表达「整封原子」（一条坏 → 全拒）。
 */
export function collect<T, E>(results: readonly Result<T, E>[]): Result<T[], E> {
  const values: T[] = [];
  for (const r of results) {
    if (!r.ok) return r;
    values.push(r.value);
  }
  return ok(values);
}
