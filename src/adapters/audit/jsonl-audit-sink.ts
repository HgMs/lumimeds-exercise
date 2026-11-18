/**
 * 审计 JSONL 的文件实现（`ARCHITECTURE.md` §5.10；`DATA-CONTRACTS.md` §3.7）。
 *
 * 写 `out/decisions.jsonl`（每单一行，含 MANUAL）与 `out/facts.jsonl`（每封邮件一行）：
 * - `fs.appendFile` 追加，一行一个 `JSON.stringify(record) + "\n"`；
 * - 内存里维护 pending 集合，`flush()` 等**全部** append 完成（对应
 *   `AuditRecorder.flush()`：审计不是真值，失败只记日志、不回滚状态，D12）；
 * - **不 `fsync`**：证据文件丢一行不影响状态正确性（状态在快照里）。
 *
 * 失败语义：`decision()`/`fact()` 返回的 promise 会 reject（写失败），由
 * `AuditRecorder` 接住记日志；为避免「没人 await 时变成 unhandledRejection」，
 * 内部对每个被跟踪的 promise 都挂了空 catch，`flush()` 用 `Promise.allSettled`
 * 观察真实结果并把第一个错误抛出去。
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuditSink, FactAuditRecord } from '../../application/ports/audit-sink.ts';
import type { PersistedRoutingDecision } from '../../domain/routing/decision.ts';

/** 两份审计文件名（`DATA-CONTRACTS` §3.7）。 */
export const DECISIONS_FILE_NAME = 'decisions.jsonl';
export const FACTS_FILE_NAME = 'facts.jsonl';

export class JsonlAuditSink implements AuditSink {
  private readonly outDir: string;
  private readonly decisionsPath: string;
  private readonly factsPath: string;
  /** 目录创建只做一次（失败也会被缓存，后续写入按失败处理）。 */
  private dirReady: Promise<void> | undefined;
  /** 还在写盘中的 append。 */
  private readonly pending = new Set<Promise<void>>();
  /** 自上次 flush 以来第一个写失败（flush 时报告一次，然后清空）。 */
  private firstFailure: unknown = undefined;

  /** @param outDir `OUT_DIR`；目录不存在时首次写入会 `mkdir -p`。 */
  constructor(outDir: string) {
    this.outDir = outDir;
    this.decisionsPath = join(outDir, DECISIONS_FILE_NAME);
    this.factsPath = join(outDir, FACTS_FILE_NAME);
  }

  /** 两份审计文件路径（测试/排错用）。 */
  paths(): { decisions: string; facts: string } {
    return { decisions: this.decisionsPath, facts: this.factsPath };
  }

  decision(decision: PersistedRoutingDecision): Promise<void> {
    return this.track(this.append(this.decisionsPath, decision));
  }

  fact(record: FactAuditRecord): Promise<void> {
    return this.track(this.append(this.factsPath, record));
  }

  /** 等所有已排队的 append 完成；有失败则抛出第一个错误。 */
  async flush(): Promise<void> {
    // 循环处理「flush 期间又有新写入」的情况；正常情况下一次就清空。
    while (this.pending.size > 0) {
      const batch = [...this.pending];
      const results = await Promise.allSettled(batch);
      const failed = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (failed !== undefined && this.firstFailure === undefined) {
        this.firstFailure = failed.reason;
      }
    }
    // 已经 settle 的失败也要在 flush 时报告（调用方可能 fire-and-forget）。
    if (this.firstFailure !== undefined) {
      const failure = this.firstFailure;
      this.firstFailure = undefined;
      throw failure;
    }
  }

  /** 跟踪一个 append：完成后从 pending 移除；同时挂空 catch 防 unhandledRejection。 */
  private track(write: Promise<void>): Promise<void> {
    const tracked = write.finally(() => {
      this.pending.delete(tracked);
    });
    tracked.catch((cause: unknown) => {
      // 记下失败给 flush() 报告；同时标记已处理，避免 unhandledRejection。
      if (this.firstFailure === undefined) this.firstFailure = cause;
    });
    this.pending.add(tracked);
    return tracked;
  }

  private async append(path: string, record: unknown): Promise<void> {
    await this.ensureDir();
    const line = `${JSON.stringify(record)}\n`;
    await appendFile(path, line, 'utf8');
  }

  private ensureDir(): Promise<void> {
    if (this.dirReady === undefined) {
      this.dirReady = mkdir(this.outDir, { recursive: true }).then(
        () => undefined,
        (cause: unknown) => {
          throw new Error(
            `audit sink could not create out dir: ${this.outDir}: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          );
        },
      );
    }
    return this.dirReady;
  }
}
