/**
 * 快照的文件实现（`ARCHITECTURE.md` §5.10、§11.1；`DATA-CONTRACTS.md` §3.6）。
 *
 * 每次事件处理完，`save()` 用**临时文件 + rename** 原子覆盖
 * `${DATA_DIR}/state.json`：
 * - 不先删旧文件：否则「clear 与 save 之间崩溃」会在磁盘上留下没有状态的窗口
 *   （模拟器只对 socket 错误重投 15 秒，丢状态=整周不可恢复）。Windows 上
 *   `fs.rename` 走 `MoveFileExW` + replace，可以直接覆盖已存在文件。
 * - 写失败返回 `Err(AppError('persist_failed'))`，由调用方决定重试/标记
 *   `degraded`；本类不吞异常、也不悄悄降级成「内存成功」。
 *
 * `load()` 的失败语义：文件不存在 → `Ok(null)`（首次启动的正常路径）；
 * JSON 坏、不是对象、`version !== 1` → `Err`（不是抛异常）。
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { StateStore, PersistedState } from '../../application/ports/state-store.ts';
import { AppError } from '../../kernel/errors.ts';
import { err, ok } from '../../kernel/result.ts';
import type { Result } from '../../kernel/result.ts';

/** 快照文件名（`DATA-CONTRACTS` §3.6）。 */
export const STATE_FILE_NAME = 'state.json';

export class FileStateStore implements StateStore {
  private readonly filePath: string;
  private readonly tmpPath: string;

  /** @param dataDir `DATA_DIR`；目录不存在时 `save` 会 `mkdir -p`。 */
  constructor(dataDir: string) {
    this.filePath = join(dataDir, STATE_FILE_NAME);
    this.tmpPath = `${this.filePath}.tmp`;
  }

  /** 落盘文件路径（测试/排错用）。 */
  path(): string {
    return this.filePath;
  }

  async load(): Promise<Result<PersistedState | null, AppError>> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch (cause) {
      if (isErrnoCode(cause, 'ENOENT')) return ok(null);
      return err(
        new AppError('persist_failed', `state snapshot could not be read: ${this.filePath}`, {
          reason: 'read_failed',
          file: this.filePath,
          cause: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      return err(
        new AppError('persist_failed', `state snapshot is not valid JSON: ${this.filePath}`, {
          reason: 'invalid_json',
          file: this.filePath,
          cause: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    }

    if (!isRecord(parsed)) {
      return err(
        new AppError('persist_failed', 'state snapshot must be a JSON object', {
          reason: 'invalid_shape',
          file: this.filePath,
        }),
      );
    }
    if (parsed['version'] !== 1) {
      return err(
        new AppError('persist_failed', 'state snapshot has an unsupported version', {
          reason: 'unsupported_version',
          file: this.filePath,
          version: parsed['version'] ?? null,
        }),
      );
    }

    return ok(parsed as unknown as PersistedState);
  }

  async save(state: PersistedState): Promise<Result<void, AppError>> {
    let payload: string;
    try {
      payload = JSON.stringify(state);
    } catch (cause) {
      return err(
        new AppError('persist_failed', 'state snapshot is not JSON-serializable', {
          reason: 'serialize_failed',
          cause: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    }

    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.tmpPath, payload, 'utf8');
      // 原子替换：tmp 写完整后才出现在目标路径；覆盖已存在文件是合法的。
      await rename(this.tmpPath, this.filePath);
      return ok(undefined);
    } catch (cause) {
      // 清掉半成品 tmp，避免下一次 save 前留下脏文件（目标文件仍保持旧值）。
      await rm(this.tmpPath, { force: true }).catch(() => undefined);
      return err(
        new AppError('persist_failed', `state snapshot could not be written: ${this.filePath}`, {
          reason: 'write_failed',
          file: this.filePath,
          cause: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    }
  }

  async clear(): Promise<Result<void, AppError>> {
    try {
      // `force: true` 让「文件本来就不存在」也成功（幂等）。
      await rm(this.filePath, { force: true });
      await rm(this.tmpPath, { force: true });
      return ok(undefined);
    } catch (cause) {
      return err(
        new AppError('persist_failed', `state snapshot could not be cleared: ${this.filePath}`, {
          reason: 'clear_failed',
          file: this.filePath,
          cause: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    }
  }
}

/** `Error` 上的 errno code（`ENOENT`/`ENOTDIR` …）；跨平台只用来分支，不参与业务。 */
function isErrnoCode(cause: unknown, code: string): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    (cause as { code?: unknown }).code === code
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
