/**
 * 发单 WAL 的文件实现（`ARCHITECTURE.md` §5.10、§11.3；`DATA-CONTRACTS.md` §3.8）。
 *
 * 语义：`begin` 在发单**之前**记一条，`201`/`409` 之后 `commit` 移除；崩溃恢复时
 * 读到还在的条目 → 按 WAL 里记的药房原样重发，绝不重新路由（同一单不能发两家）。
 *
 * 实现：
 * - 条目数 = 同时在途订单数（通常 ≤ 1），所以每次变更**整文件重写**；
 * - 和 `FileStateStore` 一样用 tmp + rename 原子替换；不先删旧文件；
 * - 写操作串行化（尾部 promise 链），避免两个并发 `begin` 读-改-写丢条目；
 * - `begin` 对同一 `orderId` 做 upsert：重试同一单时不会写成两条（否则恢复会重发两次）；
 * - **落盘形状按 `DATA-CONTRACTS` §3.8 用 snake_case**（`order_id` / `decision_reason` /
 *   `started_at_real_clock`），端口类型 `InflightEntry` 是 camelCase，映射只发生在本适配器。
 *   读取时兼容 camelCase（手工修过的旧文件），写回统一成 snake_case。
 *
 * 失败语义：端口没有 `Result`，所以 `load()` 在文件损坏时**抛出**（诚实的启动失败），
 * 而不是返回空列表把「可能存在的在途单」静默丢掉。
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  InflightEntry,
  InflightJournal,
} from '../../application/ports/inflight-journal.ts';
import type { OrderId, PharmacyId } from '../../domain/types.ts';

/** WAL 文件名（`DATA-CONTRACTS` §3.8）。 */
export const INFLIGHT_FILE_NAME = 'inflight.json';

/** 构造参数：给文件路径，或给 data 目录（等价于 `{dataDir}/inflight.json`）。 */
export type FileInflightJournalOptions =
  | string
  | {
      /** 显式文件路径（优先）；通常传 `env.inflightFile`。 */
      filePath?: string;
      /** 只给目录时用 `{dataDir}/inflight.json`。 */
      dataDir?: string;
    };

export class FileInflightJournal implements InflightJournal {
  private readonly filePath: string;
  private readonly tmpPath: string;
  /** 写操作串行链：保证「读旧值 → 改 → 写新值」不交错。 */
  private tail: Promise<void> = Promise.resolve();

  constructor(options: FileInflightJournalOptions) {
    if (typeof options === 'string') {
      // 裸字符串按**文件路径**解释（`env.inflightFile`）。为了避免把 `env.dataDir`
      // 误当文件写出一个没有扩展名的怪文件，这里要求它像文件（带 `.json`）；
      // 想传目录请用 `{ dataDir }`。
      if (!options.toLowerCase().endsWith('.json')) {
        throw new Error(
          `FileInflightJournal: a bare string is a WAL file path ending in .json; got ${JSON.stringify(
            options,
          )}. Pass { dataDir } for a directory, or { filePath } for an explicit file.`,
        );
      }
      this.filePath = options;
    } else if (typeof options.filePath === 'string' && options.filePath !== '') {
      this.filePath = options.filePath;
    } else if (typeof options.dataDir === 'string' && options.dataDir !== '') {
      this.filePath = join(options.dataDir, INFLIGHT_FILE_NAME);
    } else {
      throw new Error('FileInflightJournal: either filePath or dataDir is required');
    }
    this.tmpPath = `${this.filePath}.tmp`;
  }

  /** 落盘文件路径（测试/排错用）。 */
  path(): string {
    return this.filePath;
  }

  /** 发单之前调用；同一 `orderId` 再次 `begin` 时覆盖旧条目（重试同一单），顺序不变。 */
  async begin(entry: InflightEntry): Promise<void> {
    await this.mutate((entries) => {
      const next = [...entries];
      const index = next.findIndex((existing) => existing.orderId === entry.orderId);
      if (index >= 0) next[index] = cloneEntry(entry);
      else next.push(cloneEntry(entry));
      return next;
    });
  }

  /** `201`/`409` 之后调用：把该单移出 WAL。不存在的 orderId 是幂等 no-op。 */
  async commit(orderId: OrderId): Promise<void> {
    await this.mutate((entries) => entries.filter((entry) => entry.orderId !== orderId));
  }

  /** 读取全部在途条目；文件不存在 → `[]`；损坏 → 抛出。 */
  async load(): Promise<readonly InflightEntry[]> {
    return this.readEntries();
  }

  /** 清空 WAL（`simulation.started` 时用）；写回 `[]`，文件保持原子替换语义。 */
  async clear(): Promise<void> {
    await this.mutate(() => []);
  }

  /** 串行化的读-改-写。上一个写失败不阻塞下一个（错误只在当次调用者可见）。 */
  private mutate(transform: (entries: InflightEntry[]) => InflightEntry[]): Promise<void> {
    const run = this.tail.then(async () => {
      const entries = [...(await this.readEntries())];
      const next = transform(entries);
      await this.writeEntries(next);
    });
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async readEntries(): Promise<readonly InflightEntry[]> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch (cause) {
      if (isErrnoCode(cause, 'ENOENT')) return [];
      throw new Error(
        `inflight journal could not be read: ${this.filePath}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }

    if (text.trim() === '') return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new Error(
        `inflight journal is not valid JSON: ${this.filePath}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`inflight journal must be a JSON array: ${this.filePath}`);
    }
    return parsed.map((raw, index) => parseEntry(raw, index, this.filePath));
  }

  private async writeEntries(entries: readonly InflightEntry[]): Promise<void> {
    // 端口是 camelCase，磁盘契约（DATA-CONTRACTS §3.8）是 snake_case：只在这里映射。
    const payload = JSON.stringify(entries.map(toPersistedEntry));
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.tmpPath, payload, 'utf8');
      await rename(this.tmpPath, this.filePath);
    } catch (cause) {
      await rm(this.tmpPath, { force: true }).catch(() => undefined);
      throw new Error(
        `inflight journal could not be written: ${this.filePath}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
  }
}

/** 磁盘形状（`DATA-CONTRACTS.md` §3.8）。 */
interface PersistedInflightEntry {
  order_id: string;
  pharmacy: string;
  at: string;
  decision_reason: string | null;
  started_at_real_clock: string;
}

/** camelCase（端口）→ snake_case（磁盘契约）。 */
function toPersistedEntry(entry: InflightEntry): PersistedInflightEntry {
  return {
    order_id: entry.orderId,
    pharmacy: entry.pharmacy,
    at: entry.at,
    decision_reason: entry.decisionReason,
    started_at_real_clock: entry.startedAtRealClock,
  };
}

/** 逐字段校验 WAL 条目；不合法即抛（文件是我们自己写的，坏了就不该继续）。 */
function parseEntry(raw: unknown, index: number, filePath: string): InflightEntry {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`inflight journal entry ${index} is not an object: ${filePath}`);
  }
  const record = raw as Record<string, unknown>;
  // 磁盘契约是 snake_case；camelCase 只是读取兼容（写回总是 snake_case）。
  const orderId = record['order_id'] ?? record['orderId'];
  const pharmacy = record['pharmacy'];
  const at = record['at'];
  const startedAtRealClock = record['started_at_real_clock'] ?? record['startedAtRealClock'];
  const decisionReason = record['decision_reason'] ?? record['decisionReason'];
  if (typeof orderId !== 'string' || typeof at !== 'string' || typeof startedAtRealClock !== 'string') {
    throw new Error(`inflight journal entry ${index} has invalid string fields: ${filePath}`);
  }
  if (typeof pharmacy !== 'string') {
    throw new Error(`inflight journal entry ${index} has invalid pharmacy: ${filePath}`);
  }
  if (decisionReason !== null && decisionReason !== undefined && typeof decisionReason !== 'string') {
    throw new Error(`inflight journal entry ${index} has invalid decision_reason: ${filePath}`);
  }
  return {
    orderId,
    pharmacy: pharmacy as PharmacyId | 'MANUAL',
    at,
    decisionReason: typeof decisionReason === 'string' ? decisionReason : null,
    startedAtRealClock,
  };
}

function cloneEntry(entry: InflightEntry): InflightEntry {
  return {
    orderId: entry.orderId,
    pharmacy: entry.pharmacy,
    at: entry.at,
    decisionReason: entry.decisionReason,
    startedAtRealClock: entry.startedAtRealClock,
  };
}

function isErrnoCode(cause: unknown, code: string): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    (cause as { code?: unknown }).code === code
  );
}
