/**
 * LLM 抽取端口（`ARCHITECTURE.md` §5.9）。
 *
 * 实现由 `adapters/llm/*` 提供；domain 与它的实现都看不到彼此。
 * 超时不由实现自己拍：`opts.timeoutMs` 由 `Deadline.allocate` 计算。
 */
import type { AppError } from '../../kernel/errors.ts';
import type { Result } from '../../kernel/result.ts';
import type { ExtractionInput, ExtractionResult } from '../../domain/email/extraction.ts';

export interface LlmExtractor {
  extract(
    input: ExtractionInput,
    opts: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<Result<ExtractionResult, AppError>>;
}
