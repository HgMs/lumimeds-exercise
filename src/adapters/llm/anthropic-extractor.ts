/**
 * Anthropic Messages API 抽取适配器（`ARCHITECTURE.md` §5.10；`DATA-CONTRACTS.md` §4）。
 *
 * 职责只有三件：
 * 1. 用原生 `fetch` 打 `POST {base}/v1/messages`，body 按 §4.2 原样携带
 *    `record_email_facts` 的强制 tool schema，并 `tool_choice` 钉死这个工具；
 * 2. 从 `content[]` 里找 `type === 'tool_use'` 的那一块，取出 `input`；
 * 3. 用**手写的窄校验器**验证形状（不引 zod）：`intent` 枚举、`facts` 数组的字段
 *    类型、`confidence` 枚举。任何一处不合法 → `Err(AppError('extraction_failed'))`，
 *    绝不「尽力解析」（`§5.8` 失败即证据）。
 *
 * 超时语义：**实现自己不定超时**。只把 `opts.timeoutMs`（由 `Deadline.allocate`
 * 算出）交给 `AbortSignal.timeout`。测试注入的假 fetch 因此可以通过 abort 精确
 * 观察预算是否被使用。
 *
 * 失败处理（重试）不在这里：`HandleEmailUseCase` 拿 `Err` 后用剩余预算重试一次，
 * 两次都失败才进 Sam 列表（`DATA-CONTRACTS` §4.4）。
 */
import type { LlmExtractor } from '../../application/ports/llm-extractor.ts';
import type {
  CandidateFact,
  CandidateFactType,
  EmailIntent,
  ExtractionInput,
  ExtractionResult,
} from '../../domain/email/extraction.ts';
import { AppError } from '../../kernel/errors.ts';
import { err, ok } from '../../kernel/result.ts';
import type { Result } from '../../kernel/result.ts';
import type { PromptBuilder } from './prompt-builder.ts';

/** 可用于注入的最小 fetch 形状（默认为 `globalThis.fetch`，测试可换成假实现）。 */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** `record_email_facts` 工具名（tool_choice 与 content 匹配都用它）。 */
export const RECORD_EMAIL_FACTS_TOOL_NAME = 'record_email_facts';

/** Anthropic Messages API 版本头（`DATA-CONTRACTS` §4）。 */
export const ANTHROPIC_VERSION = '2023-06-01';

/** 默认 base URL；`constructor` 可覆盖（测试/代理）。 */
export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

/**
 * 强制 tool schema（`DATA-CONTRACTS.md` §4.2 **逐字段复制**）。
 * 改这里之前先改文档；两者不一致的错误码是「LLM 说它抽到了、我们却解析不了」。
 */
export const RECORD_EMAIL_FACTS_TOOL = {
  name: RECORD_EMAIL_FACTS_TOOL_NAME,
  description:
    'Extract pharmacy-operations facts from one email. Return null for anything not stated. Never guess.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['intent', 'facts', 'confidence'],
    properties: {
      intent: {
        enum: ['stock', 'coverage', 'closure', 'capacity', 'routing', 'unrelated', 'unclear'],
      },
      facts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'pharmacy'],
          properties: {
            type: {
              enum: [
                'stock_unavailable',
                'stock_available',
                'state_blocked',
                'state_allowed',
                'closed',
                'reopened',
                'capacity',
                'routing_preference',
                'no_change',
              ],
            },
            pharmacy: { type: ['string', 'null'] },
            medication: { type: ['string', 'null'] },
            dose: { type: ['string', 'null'] },
            states: { type: 'array', items: { type: 'string' } },
            per_day: { type: ['integer', 'null'] },
            from_date: {
              type: ['string', 'null'],
              description: 'YYYY-MM-DD in America/New_York',
            },
            until_date: {
              type: ['string', 'null'],
              description: 'exclusive; YYYY-MM-DD in America/New_York',
            },
            phrase: {
              type: ['string', 'null'],
              description: 'the original temporal wording, verbatim',
            },
          },
        },
      },
      correction: { type: 'boolean' },
      confidence: { enum: ['high', 'medium', 'low'] },
      notes: { type: 'string' },
    },
  },
} as const;

/**
 * `AnthropicExtractor` 的构造参数。
 *
 * `promptBuilder` 允许传 getter：wiring 在 `buildContainer` 时还没有本周的
 * registry/catalogue/ops（它们来自 `simulation.started`），所以通常传
 * `() => container.promptBuilder` 这种延迟解析的闭包；也可以稍后调用
 * `setPromptBuilder()` 注入。没配置就调用 `extract()` 会得到 `extraction_failed`，
 * 而不是抛异常。
 */
export interface AnthropicExtractorOptions {
  /** `ANTHROPIC_API_KEY`；只放进请求头，不写日志。 */
  apiKey: string;
  /** `ANTHROPIC_MODEL`。 */
  model: string;
  /** 固定 system prompt + user 模板的来源。 */
  promptBuilder?: PromptBuilder | (() => PromptBuilder);
  /** 默认 `https://api.anthropic.com`；末尾斜杠会被去掉。 */
  baseUrl?: string;
  /** 默认 `globalThis.fetch`；测试注入假 fetch。 */
  fetch?: FetchLike;
  /** 输出上限；抽取结果很小，默认 1024 足够。 */
  maxTokens?: number;
  /** 默认 `2023-06-01`。 */
  anthropicVersion?: string;
}

/** 捕获到的传输层错误分类（只进错误 detail，不参与业务判断）。 */
type TransportFailure = 'timeout' | 'aborted' | 'network';

/** Anthropic Messages API 成功响应里我们需要的字段。 */
interface MessagesApiResponse {
  content?: unknown;
}

/**
 * Anthropic Messages API 的 `LlmExtractor` 实现。
 *
 * 裸 `fetch`、零 runtime 依赖；所有失败都翻译成 `Result`，不向调用方抛异常。
 */
export class AnthropicExtractor implements LlmExtractor {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly maxTokens: number;
  private readonly anthropicVersion: string;
  private promptBuilderSpec: PromptBuilder | (() => PromptBuilder) | undefined;
  private promptBuilderOverride: PromptBuilder | undefined;

  constructor(options: AnthropicExtractorOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = stripTrailingSlashes(options.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL);
    // 包一层，避免把 fetch 当方法调用时 `this` 绑定错误（浏览器/undici 都要求）。
    const impl = options.fetch ?? globalThis.fetch;
    this.fetchImpl = (input, init) => impl(input, init);
    this.maxTokens = options.maxTokens ?? 1024;
    this.anthropicVersion = options.anthropicVersion ?? ANTHROPIC_VERSION;
    this.promptBuilderSpec = options.promptBuilder;
  }

  /** `simulation.started` 之后由 wiring 注入本周的 prompt 构造器。 */
  setPromptBuilder(promptBuilder: PromptBuilder): void {
    this.promptBuilderOverride = promptBuilder;
    this.promptBuilderSpec = promptBuilder;
  }

  async extract(
    input: ExtractionInput,
    opts: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<Result<ExtractionResult, AppError>> {
    const promptBuilder = this.resolvePromptBuilder();
    if (promptBuilder === undefined) {
      return err(
        new AppError('extraction_failed', 'prompt builder is not configured for this extractor', {
          reason: 'prompt_builder_missing',
        }),
      );
    }

    const timeoutMs = opts.timeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return err(
        new AppError('extraction_failed', 'no time budget left for extraction', {
          reason: 'timeout_budget_exhausted',
          timeoutMs,
        }),
      );
    }

    // 超时只用调用方给的预算；`opts.signal` 是组合信号（用例取消），不是第二个超时。
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal =
      opts.signal === undefined ? timeoutSignal : AbortSignal.any([opts.signal, timeoutSignal]);

    const requestBody = {
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: 0,
      system: promptBuilder.system(),
      messages: [{ role: 'user', content: promptBuilder.user(input) }],
      tools: [RECORD_EMAIL_FACTS_TOOL],
      tool_choice: { type: 'tool', name: RECORD_EMAIL_FACTS_TOOL_NAME },
    };

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': this.anthropicVersion,
        },
        body: JSON.stringify(requestBody),
        signal,
      });
    } catch (cause) {
      const failure = classifyTransportFailure(cause, opts.signal);
      return err(
        new AppError('extraction_failed', `anthropic request failed (${failure})`, {
          reason: failure,
          cause: describeCause(cause),
        }),
      );
    }

    let text: string;
    try {
      text = await response.text();
    } catch (cause) {
      const failure = classifyTransportFailure(cause, opts.signal);
      return err(
        new AppError('extraction_failed', `anthropic response could not be read (${failure})`, {
          reason: failure,
          status: response.status,
          cause: describeCause(cause),
        }),
      );
    }

    if (!response.ok) {
      return err(
        new AppError('extraction_failed', `anthropic returned HTTP ${response.status}`, {
          reason: 'http_error',
          status: response.status,
          body: truncate(text),
        }),
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return err(
        new AppError('extraction_failed', 'anthropic returned a non-JSON response', {
          reason: 'invalid_json',
          status: response.status,
          body: truncate(text),
        }),
      );
    }

    const toolInput = findToolUseInput(payload);
    if (!toolInput.ok) {
      return err(
        new AppError('extraction_failed', toolInput.error, {
          reason: 'missing_tool_use',
          status: response.status,
          body: truncate(text),
        }),
      );
    }

    const validated = narrowExtractionResult(toolInput.value);
    if (!validated.ok) {
      return err(
        new AppError('extraction_failed', `invalid record_email_facts output: ${validated.error}`, {
          reason: 'invalid_tool_input',
          status: response.status,
          body: truncate(text),
        }),
      );
    }

    return ok(validated.value);
  }

  private resolvePromptBuilder(): PromptBuilder | undefined {
    if (this.promptBuilderOverride !== undefined) return this.promptBuilderOverride;
    const spec = this.promptBuilderSpec;
    if (spec === undefined) return undefined;
    return typeof spec === 'function' ? spec() : spec;
  }
}

/** 去掉 base URL 末尾斜杠（`http://x/` + `/v1/messages` 不产生双斜杠）。 */
function stripTrailingSlashes(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/** 响应体只留前 2 KB 进 detail，避免把整个响应塞进 Sam/日志。 */
function truncate(text: string): string {
  return text.length <= 2048 ? text : `${text.slice(0, 2048)}…`;
}

/** `cause` 只保留可 JSON 序列化的字段（错误对象直接进日志会丢信息）。 */
function describeCause(cause: unknown): Record<string, unknown> {
  if (typeof cause === 'object' && cause !== null) {
    const record = cause as Record<string, unknown>;
    const description: Record<string, unknown> = {
      name: typeof record['name'] === 'string' ? record['name'] : null,
      message: typeof record['message'] === 'string' ? record['message'] : null,
    };
    const nested = record['cause'];
    if (typeof nested === 'object' && nested !== null) {
      const nestedRecord = nested as Record<string, unknown>;
      description['cause'] = {
        name: typeof nestedRecord['name'] === 'string' ? nestedRecord['name'] : null,
        message: typeof nestedRecord['message'] === 'string' ? nestedRecord['message'] : null,
        code: typeof nestedRecord['code'] === 'string' ? nestedRecord['code'] : null,
      };
    }
    return description;
  }
  return { value: String(cause) };
}

/**
 * 区分传输层失败。Node 22 的 `fetch` 在超时/外部 abort 时抛 `DOMException`
 * （`TimeoutError` / `AbortError`），连接失败时抛 `TypeError`（cause 里带
 * `ECONNREFUSED` 之类的 code）。三者都算 `extraction_failed`，但 detail 里的
 * `reason` 不同，便于排查是「预算用完了」还是「网络不通」。
 */
function classifyTransportFailure(cause: unknown, callerSignal?: AbortSignal): TransportFailure {
  if (callerSignal?.aborted === true) return 'aborted';
  const name =
    typeof cause === 'object' && cause !== null && typeof (cause as { name?: unknown }).name === 'string'
      ? (cause as { name: string }).name
      : '';
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  return 'network';
}

/**
 * 在 Messages API 响应里找 `content[].type === 'tool_use'` 的 `input`。
 *
 * 取**第一个** tool_use：`tool_choice` 已强制只有一个工具，多个 tool_use 属异常输入，
 * 严格按 §5.8「失败即证据」处理——取第一个仍能安全提取，且后续 narrow 校验兜底。
 */
function findToolUseInput(payload: unknown): Result<unknown, string> {
  if (typeof payload !== 'object' || payload === null) {
    return err('response must be a JSON object');
  }
  const content = (payload as MessagesApiResponse).content;
  if (!Array.isArray(content)) {
    return err('response.content must be an array');
  }
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const record = block as Record<string, unknown>;
    if (record['type'] !== 'tool_use') continue;
    if (!('input' in record)) return err('tool_use block has no input');
    return ok(record['input']);
  }
  return err('response.content has no tool_use block');
}

const EMAIL_INTENTS: ReadonlySet<string> = new Set([
  'stock',
  'coverage',
  'closure',
  'capacity',
  'routing',
  'unrelated',
  'unclear',
]);

const FACT_TYPES: ReadonlySet<string> = new Set([
  'stock_unavailable',
  'stock_available',
  'state_blocked',
  'state_allowed',
  'closed',
  'reopened',
  'capacity',
  'routing_preference',
  'no_change',
]);

const CONFIDENCES: ReadonlySet<string> = new Set(['high', 'medium', 'low']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 手写窄校验器：只检查**形状**（字段存在性与类型），不做业务校验。
 *
 * 业务交叉校验（剂量在目录里、州可归一化、日期合法……）是 `FactValidator` 的事
 * （`DATA-CONTRACTS` §4.3），这里拒绝的是「模型没按 tool schema 输出」。
 * 未知的多余字段忽略（模型加了 `foo` 不影响我们）。
 */
export function narrowExtractionResult(
  raw: unknown,
): Result<ExtractionResult, string> {
  if (!isRecord(raw)) return err('result must be an object');

  const rawIntent = raw['intent'];
  if (typeof rawIntent !== 'string' || !EMAIL_INTENTS.has(rawIntent)) {
    return err(`intent must be one of the 7 documented values, got ${JSON.stringify(rawIntent)}`);
  }

  const rawFacts = raw['facts'];
  if (!Array.isArray(rawFacts)) {
    return err(`facts must be an array, got ${JSON.stringify(rawFacts)}`);
  }

  const rawConfidence = raw['confidence'];
  if (typeof rawConfidence !== 'string' || !CONFIDENCES.has(rawConfidence)) {
    return err(
      `confidence must be one of high|medium|low, got ${JSON.stringify(rawConfidence)}`,
    );
  }

  const rawCorrection = raw['correction'];
  if (rawCorrection !== undefined && typeof rawCorrection !== 'boolean') {
    return err(`correction must be a boolean when present, got ${JSON.stringify(rawCorrection)}`);
  }

  const rawNotes = raw['notes'];
  if (rawNotes !== undefined && typeof rawNotes !== 'string') {
    return err(`notes must be a string when present, got ${JSON.stringify(rawNotes)}`);
  }

  const facts: CandidateFact[] = [];
  for (let index = 0; index < rawFacts.length; index += 1) {
    const narrowed = narrowCandidateFact(rawFacts[index], index);
    if (!narrowed.ok) return narrowed;
    facts.push(narrowed.value);
  }

  const result: ExtractionResult = {
    intent: rawIntent as EmailIntent,
    facts,
    confidence: rawConfidence as ExtractionResult['confidence'],
  };
  if (typeof rawCorrection === 'boolean') result.correction = rawCorrection;
  if (typeof rawNotes === 'string') result.notes = rawNotes;
  return ok(result);
}

/** 单条候选 fact 的窄校验；只保留契约里定义的字段。 */
function narrowCandidateFact(raw: unknown, index: number): Result<CandidateFact, string> {
  const at = `facts[${index}]`;
  if (!isRecord(raw)) return err(`${at} must be an object`);

  const rawType = raw['type'];
  if (typeof rawType !== 'string' || !FACT_TYPES.has(rawType)) {
    return err(`${at}.type must be one of the 9 documented values, got ${JSON.stringify(rawType)}`);
  }

  // schema 里 pharmacy 是 required，但它是 string|null；模型漏字段时按 null 处理
  // （与「药房发件人可省略 pharmacy」的语义一致），不因此整封失败。
  const rawPharmacy = raw['pharmacy'];
  if (rawPharmacy !== undefined && rawPharmacy !== null && typeof rawPharmacy !== 'string') {
    return err(`${at}.pharmacy must be a string or null, got ${JSON.stringify(rawPharmacy)}`);
  }

  const fact: CandidateFact = {
    type: rawType as CandidateFactType,
    pharmacy: typeof rawPharmacy === 'string' ? rawPharmacy : null,
  };

  const optionalString = narrowOptionalField(raw, 'medication', at);
  if (!optionalString.ok) return err(optionalString.reason);
  if (optionalString.present) fact.medication = optionalString.value;

  const optionalDose = narrowOptionalField(raw, 'dose', at);
  if (!optionalDose.ok) return err(optionalDose.reason);
  if (optionalDose.present) fact.dose = optionalDose.value;

  const optionalPhrase = narrowOptionalField(raw, 'phrase', at);
  if (!optionalPhrase.ok) return err(optionalPhrase.reason);
  if (optionalPhrase.present) fact.phrase = optionalPhrase.value;

  const optionalFromDate = narrowOptionalField(raw, 'from_date', at);
  if (!optionalFromDate.ok) return err(optionalFromDate.reason);
  if (optionalFromDate.present) fact.from_date = optionalFromDate.value;

  const optionalUntilDate = narrowOptionalField(raw, 'until_date', at);
  if (!optionalUntilDate.ok) return err(optionalUntilDate.reason);
  if (optionalUntilDate.present) fact.until_date = optionalUntilDate.value;

  const rawStates = raw['states'];
  if (rawStates !== undefined) {
    if (!Array.isArray(rawStates) || rawStates.some((state) => typeof state !== 'string')) {
      return err(`${at}.states must be an array of strings, got ${JSON.stringify(rawStates)}`);
    }
    fact.states = [...rawStates];
  }

  const rawPerDay = raw['per_day'];
  if (rawPerDay !== undefined) {
    if (rawPerDay !== null && (typeof rawPerDay !== 'number' || !Number.isInteger(rawPerDay))) {
      return err(`${at}.per_day must be an integer or null, got ${JSON.stringify(rawPerDay)}`);
    }
    fact.per_day = rawPerDay === null ? null : (rawPerDay as number);
  }

  return ok(fact);
}

/** `string | null` 的可选字段：字段不存在 → present=false；存在但类型错 → 失败。 */
function narrowOptionalField(
  raw: Record<string, unknown>,
  key: string,
  at: string,
): { ok: true; present: boolean; value: string | null } | { ok: false; reason: string } {
  const value = raw[key];
  if (value === undefined) return { ok: true, present: false, value: null };
  if (value === null || typeof value === 'string') {
    return { ok: true, present: true, value: value as string | null };
  }
  return {
    ok: false,
    reason: `${at}.${key} must be a string or null, got ${JSON.stringify(value)}`,
  };
}
