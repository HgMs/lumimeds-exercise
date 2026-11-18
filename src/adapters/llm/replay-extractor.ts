/**
 * 从录制好的 fixture 回放抽取结果（`ARCHITECTURE.md` §5.10；`LLM_MODE=replay`）。
 *
 * 用途：离线整周回放与集成测试。生产默认 `LLM_MODE=live`，**不装载**这个实现。
 *
 * fixture 格式（由 `test/fixtures/llm/*.json` 提供）：顶层是
 * `{ [event_id]: ExtractionResult }` 的对象；`ExtractionInput.eventId` 是唯一的查找键。
 * 实现补充（登记在交付报告里）：如果 fixture 顶层没有直接命中，则再尝试
 * `{ "extractions": { ... } }` 这种带包装的写法，兼容手工整理的文件。
 *
 * 失败语义：
 * - 文件不存在 / JSON 坏 / 形状不对 → `Err(AppError('extraction_failed'))`；
 * - event_id 不在 fixture 里 → `Err(AppError('extraction_failed'))`；
 * - 成功时**原样返回** fixture 里的 `intent/facts/correction/confidence`，只把来源写进
 *   `notes`（保留已有 notes），便于审计区分「模型抽的」与「回放的」。
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { LlmExtractor } from '../../application/ports/llm-extractor.ts';
import type { ExtractionInput, ExtractionResult } from '../../domain/email/extraction.ts';
import { AppError } from '../../kernel/errors.ts';
import { err, ok } from '../../kernel/result.ts';
import type { Result } from '../../kernel/result.ts';
import type { Logger } from '../../kernel/logger.ts';
import { narrowExtractionResult } from './anthropic-extractor.ts';

/** 回放器构造参数：注入内存 fixture 或指向文件二选一。 */
export interface ReplayExtractorOptions {
  /** fixture 文件路径（相对路径按进程 cwd 解析）；wiring 传 `env.llmFixture`。 */
  fixturePath?: string;
  /** 直接注入的内存 fixture（测试用）；优先于 `fixturePath`。 */
  fixture?: Readonly<Record<string, ExtractionResult>>;
  /** 可选：记录「回放失败」这类事件（默认静默）。 */
  logger?: Logger;
}

/** fixture 顶层形状；解析后只保留「能过窄校验」的条目。 */
type FixtureMap = ReadonlyMap<string, ExtractionResult>;

export class ReplayExtractor implements LlmExtractor {
  private readonly fixturePath: string | undefined;
  private readonly injected: FixtureMap | undefined;
  private readonly logger: Logger | undefined;
  /** 懒加载 + 只加载一次；失败也缓存，避免每封邮件都重读坏文件。 */
  private fixturePromise: Promise<Result<FixtureMap, AppError>> | undefined;

  constructor(options: ReplayExtractorOptions) {
    this.fixturePath =
      options.fixturePath === undefined ? undefined : resolve(options.fixturePath);
    this.injected = options.fixture === undefined ? undefined : new Map(Object.entries(options.fixture));
    this.logger = options.logger;
  }

  async extract(
    input: ExtractionInput,
    opts: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<Result<ExtractionResult, AppError>> {
    if (opts.signal?.aborted === true) {
      return err(
        new AppError('extraction_failed', 'replay extraction was aborted by the caller', {
          reason: 'aborted',
          eventId: input.eventId,
        }),
      );
    }
    const fixture = await this.loadFixture();
    if (!fixture.ok) return err(fixture.error);

    const hit = fixture.value.get(input.eventId);
    if (hit === undefined) {
      this.logger?.warn('replay fixture has no extraction for event', {
        event_id: input.eventId,
        fixture: this.fixturePath ?? '<injected>',
      });
      return err(
        new AppError('extraction_failed', `replay fixture has no entry for event ${input.eventId}`, {
          reason: 'fixture_missing_entry',
          eventId: input.eventId,
          fixture: this.fixturePath ?? null,
        }),
      );
    }

    // 来源写进 notes：既有 notes 保留（`原 notes [replay:evt_x]`）。
    const notes =
      hit.notes === undefined || hit.notes === ''
        ? `replay:${input.eventId}`
        : `${hit.notes} [replay:${input.eventId}]`;
    return ok({ ...hit, notes });
  }

  /** 懒加载 fixture：内存注入 > 文件。同一个 Promise 复用，失败结果也被缓存。 */
  private loadFixture(): Promise<Result<FixtureMap, AppError>> {
    if (this.fixturePromise === undefined) {
      this.fixturePromise = this.injected !== undefined
        ? Promise.resolve(ok(this.injected))
        : this.readFixtureFile();
    }
    return this.fixturePromise;
  }

  private async readFixtureFile(): Promise<Result<FixtureMap, AppError>> {
    const path = this.fixturePath;
    if (path === undefined) {
      return err(
        new AppError('extraction_failed', 'replay extractor has neither fixture nor fixturePath', {
          reason: 'fixture_not_configured',
        }),
      );
    }

    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (cause) {
      return err(
        new AppError('extraction_failed', `replay fixture could not be read: ${path}`, {
          reason: 'fixture_unreadable',
          fixture: path,
          cause: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      return err(
        new AppError('extraction_failed', `replay fixture is not valid JSON: ${path}`, {
          reason: 'fixture_invalid_json',
          fixture: path,
          cause: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return err(
        new AppError('extraction_failed', 'replay fixture must be a JSON object', {
          reason: 'fixture_invalid_shape',
          fixture: path,
        }),
      );
    }

    // 兼容 `{"extractions": {...}}` 包装；否则把顶层当 map。
    const root = parsed as Record<string, unknown>;
    const mapCandidate =
      typeof root['extractions'] === 'object' && root['extractions'] !== null
        ? (root['extractions'] as Record<string, unknown>)
        : root;

    const entries: Array<[string, ExtractionResult]> = [];
    for (const [eventId, rawResult] of Object.entries(mapCandidate)) {
      const validated = narrowExtractionResult(rawResult);
      if (!validated.ok) {
        return err(
          new AppError(
            'extraction_failed',
            `replay fixture entry ${eventId} does not match the extraction contract`,
            {
              reason: 'fixture_invalid_entry',
              fixture: path,
              eventId,
              detail: validated.error,
            },
          ),
        );
      }
      entries.push([eventId, validated.value]);
    }

    return ok(new Map(entries));
  }
}
