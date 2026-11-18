/**
 * 环境变量加载（`DATA-CONTRACTS.md` §6；`ARCHITECTURE.md` §3、§13.1）。
 *
 * 启动序列第一件事：`loadEnv(process.env)`；失败 → 打印可执行的修复提示 → `exit(1)`。
 * 不进入「无 LLM 降级模式」：core 要求 LLM 读邮件，静默降级比启动失败更糟。
 *
 * 失败值是**给人读的字符串**（可多行，列出全部问题），不要改成 AppError：
 * 这里还没有 logger，也不属于领域错误。
 */
import { err, ok, type Result } from './kernel/result.ts';

/** 运行配置；字段名对应 DATA-CONTRACTS §6 的环境变量（camelCase）。 */
export interface EnvConfig {
  /** `PORT`，默认 3000；0 表示让内核分配（测试用）。 */
  port: number;
  /** `ANTHROPIC_API_KEY`，必填；绝不入库。 */
  apiKey: string;
  /** `ANTHROPIC_MODEL`，默认 `claude-sonnet-4-5`。 */
  model: string;
  /** `ANTHROPIC_TIMEOUT_MS`，默认 12000（真正生效的是 `Deadline.allocate` 的结果）。 */
  anthropicTimeoutMs: number;
  /** `DATA_DIR`，默认 `./data`。 */
  dataDir: string;
  /** `OUT_DIR`，默认 `./out`。 */
  outDir: string;
  /** `TZ`，默认 `America/New_York`；仅用于日期格式化说明，取「现在」不走它。 */
  tz: string;
  /** `LLM_MODE`，默认 `live`；`replay` 仅测试/离线演示。 */
  llmMode: 'live' | 'replay';
  /** `INFLIGHT_FILE`，默认 `./data/inflight.json`。 */
  inflightFile: string;
  /** `LLM_FIXTURE`，默认 `test/fixtures/llm/week-a.extractions.json`；仅 `replay` 用。 */
  llmFixture: string;
}

const DEFAULT_MODEL = 'claude-sonnet-4-5';
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_TZ = 'America/New_York';
const DEFAULT_DATA_DIR = './data';
const DEFAULT_OUT_DIR = './out';
const DEFAULT_INFLIGHT_FILE = './data/inflight.json';
const DEFAULT_LLM_FIXTURE = 'test/fixtures/llm/week-a.extractions.json';

function readString(
  source: NodeJS.ProcessEnv,
  name: string,
  fallback: string | undefined,
  problems: string[],
): string | undefined {
  const raw = source[name];
  if (raw === undefined || raw === '') {
    if (fallback === undefined) {
      problems.push(`缺少 ${name}：请写入 .env（参考 docs/DATA-CONTRACTS.md §6）`);
      return undefined;
    }
    return fallback;
  }
  if (raw.trim() === '') {
    problems.push(`${name} 不能是空白字符串`);
    return undefined;
  }
  return raw.trim();
}

function readInt(
  source: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
  problems: string[],
): number {
  const raw = source[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^-?\d+$/.test(raw.trim())) {
    problems.push(`${name} 必须是整数，实际是 ${JSON.stringify(raw)}`);
    return fallback;
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    problems.push(`${name} 必须在 [${min}, ${max}] 之间，实际是 ${String(value)}`);
    return fallback;
  }
  return value;
}

function readLlmMode(source: NodeJS.ProcessEnv, problems: string[]): 'live' | 'replay' {
  const raw = source['LLM_MODE'];
  if (raw === undefined || raw.trim() === '') return 'live';
  const value = raw.trim();
  if (value === 'live' || value === 'replay') return value;
  problems.push(`LLM_MODE 只能是 live 或 replay，实际是 ${JSON.stringify(raw)}`);
  return 'live';
}

/**
 * 从环境变量记录读取配置。`source` 一般传 `process.env`；测试可直接传一个对象。
 * 返回 `Err(<可打印的多行提示>)` 时调用方应打印并 `exit(1)`。
 */
export function loadEnv(source: NodeJS.ProcessEnv): Result<EnvConfig, string> {
  const problems: string[] = [];

  const port = readInt(source, 'PORT', 3000, 0, 65_535, problems);
  const llmMode = readLlmMode(source, problems);
  // `live` 模式必须有 key（core 要求 LLM 读邮件，静默降级比启动失败更糟）；
  // `replay` 只用于测试/离线演示，允许不带 key（fixture 回放不访问网络）。
  const apiKey = readString(
    source,
    'ANTHROPIC_API_KEY',
    llmMode === 'replay' ? '' : undefined,
    problems,
  );
  const model = readString(source, 'ANTHROPIC_MODEL', DEFAULT_MODEL, problems);
  const anthropicTimeoutMs = readInt(
    source,
    'ANTHROPIC_TIMEOUT_MS',
    DEFAULT_TIMEOUT_MS,
    1,
    Number.MAX_SAFE_INTEGER,
    problems,
  );
  const dataDir = readString(source, 'DATA_DIR', DEFAULT_DATA_DIR, problems);
  const outDir = readString(source, 'OUT_DIR', DEFAULT_OUT_DIR, problems);
  const tz = readString(source, 'TZ', DEFAULT_TZ, problems);
  const inflightFile = readString(source, 'INFLIGHT_FILE', DEFAULT_INFLIGHT_FILE, problems);
  const llmFixture = readString(source, 'LLM_FIXTURE', DEFAULT_LLM_FIXTURE, problems);

  if (problems.length > 0) {
    return err(`环境变量配置无效：\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }

  // 上面的 readString/readInt 失败时都会往 problems 里记录，因此这里全部有值。
  return ok({
    port,
    apiKey: apiKey as string,
    model: model as string,
    anthropicTimeoutMs,
    dataDir: dataDir as string,
    outDir: outDir as string,
    tz: tz as string,
    llmMode,
    inflightFile: inflightFile as string,
    llmFixture: llmFixture as string,
  });
}
