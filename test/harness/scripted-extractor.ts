/**
 * 按 `event_id` 回放抽取结果的测试替身（`ARCHITECTURE.md` §12.3；task-11）。
 *
 * 与生产 `ReplayExtractor`（`src/adapters/llm/replay-extractor.ts`）的差别只在
 * **可观测性**：这里记录每次调用与「fixture 缺失」的 event_id，方便集成测试断言
 * 「整周只调 10 次 LLM」「不存在缺 fixture 的静默失败」。
 *
 * 失败语义与 `ARCHITECTURE` §12.3 一致：
 * - 缺 fixture 条目 → `Err(AppError('extraction_failed'))`（测试断言整周不应出现）；
 * - fixture 文件读不到 / JSON 坏 / 形状不对 → 构造时**立刻抛**（属于测试夹具损坏，
 *   不是业务失败，静默吞掉会让整周测试变成假绿）。
 *
 * fixture 形状：顶层 `{ [event_id]: ExtractionResult }`，条目用生产同一套窄校验器
 * （`narrowExtractionResult`）验证，保证回放的数据与 live 模型输出走同一契约。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { LlmExtractor } from '../../src/application/ports/llm-extractor.ts';
import type { ExtractionInput, ExtractionResult } from '../../src/domain/email/extraction.ts';
import { AppError } from '../../src/kernel/errors.ts';
import { err, ok } from '../../src/kernel/result.ts';
import type { Result } from '../../src/kernel/result.ts';
import { narrowExtractionResult } from '../../src/adapters/llm/anthropic-extractor.ts';
import { EXTRACTIONS_PATH } from './week-a.ts';

/** 一次 `extract` 调用的记录。 */
export interface ExtractionCall {
  readonly eventId: string;
  readonly timeoutMs: number;
  readonly aborted: boolean;
}

export interface ScriptedExtractorOptions {
  /** fixture 文件路径（相对路径按进程 cwd 解析）；缺省 = week A 的 LLM fixture。 */
  readonly fixturePath?: string;
  /** 直接注入的内存 fixture（测试用），优先于 `fixturePath`。 */
  readonly fixture?: Readonly<Record<string, ExtractionResult>>;
}

export class ScriptedExtractor implements LlmExtractor {
  /** fixture 文件路径（内存注入时为 undefined）。 */
  readonly fixturePath: string | undefined;
  /** 每次抽取调用（按顺序）；集成测试用它断言「重投不重复调 LLM」。 */
  readonly calls: ExtractionCall[] = [];
  /** 没有 fixture 条目的 event_id（正常整周回放必须为空）。 */
  readonly missingEventIds: string[] = [];

  private readonly fixture: ReadonlyMap<string, ExtractionResult>;

  constructor(options: ScriptedExtractorOptions = {}) {
    if (options.fixture !== undefined) {
      this.fixturePath = undefined;
      this.fixture = new Map(Object.entries(options.fixture));
      return;
    }
    if (options.fixturePath === undefined) {
      // 集成测试默认回放 week A 的 LLM fixture（与 `LLM_MODE=replay` 同一份文件）。
      this.fixturePath = resolve(EXTRACTIONS_PATH);
      this.fixture = loadFixtureFile(this.fixturePath);
      return;
    }
    this.fixturePath = resolve(options.fixturePath);
    this.fixture = loadFixtureFile(this.fixturePath);
  }

  async extract(
    input: ExtractionInput,
    opts: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<Result<ExtractionResult, AppError>> {
    const aborted = opts.signal?.aborted === true;
    this.calls.push({ eventId: input.eventId, timeoutMs: opts.timeoutMs, aborted });
    if (aborted) {
      return err(new AppError('extraction_failed', 'scripted extraction was aborted', {
        reason: 'aborted',
        eventId: input.eventId,
      }));
    }

    const hit = this.fixture.get(input.eventId);
    if (hit === undefined) {
      this.missingEventIds.push(input.eventId);
      return err(
        new AppError('extraction_failed', `scripted fixture has no entry for event ${input.eventId}`, {
          reason: 'fixture_missing_entry',
          eventId: input.eventId,
          fixture: this.fixturePath ?? '<injected>',
        }),
      );
    }
    // 拷贝一份，避免 validator/factory 的潜在就地修改污染后续断言（重放同一周要可重复）。
    return ok(structuredClone(hit));
  }

  /** 本轮实际调过 LLM 的 event_id 列表（顺序）。 */
  get calledEventIds(): readonly string[] {
    return this.calls.map((call) => call.eventId);
  }
}

/** 读 fixture 文件并逐条窄校验；任何问题都在构造期抛（夹具损坏不是业务失败）。 */
function loadFixtureFile(path: string): ReadonlyMap<string, ExtractionResult> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new Error(
      `ScriptedExtractor: fixture could not be read: ${path}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(
      `ScriptedExtractor: fixture is not valid JSON: ${path}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`ScriptedExtractor: fixture must be a JSON object keyed by event_id: ${path}`);
  }

  const fixture = new Map<string, ExtractionResult>();
  for (const [eventId, raw] of Object.entries(parsed as Record<string, unknown>)) {
    const narrowed = narrowExtractionResult(raw);
    if (!narrowed.ok) {
      throw new Error(
        `ScriptedExtractor: fixture entry ${eventId} does not match the extraction contract: ${narrowed.error}`,
      );
    }
    fixture.set(eventId, narrowed.value);
  }
  return fixture;
}
