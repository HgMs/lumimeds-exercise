/**
 * 进程入口：启动序列 + 优雅停机（`ARCHITECTURE.md` §4、§6.3、§6.4）。
 *
 * 顺序即语义（不要重排）：
 * 1. `loadEnv(process.env)` 失败 → 打印**可执行的修复提示** → `exit(1)`；不降级成
 *    「无 LLM 模式」（core 要求 LLM 读邮件，静默降级比启动失败更糟）；
 * 2. `buildContainer(env)`；
 * 3. **立刻** `calendar.selfTest()`：`Intl` 退化成 UTC 时启动即失败（§17.1）；
 * 4. `RecoveryService.run()`：读快照 → 重建会话 → 注入 `pharmacy_api` → 处理
 *    inflight（§6.3）；恢复失败只记 error、按无会话继续（后续事件 500 `no_session`，
 *    等下一个 `simulation.started` 重建），**绝不自己编一个空壳会话**；
 * 5. `retryQueue.start()`；
 * 6. `server.listen()` → 打印端口；
 * 7. `SIGTERM`/`SIGINT` → `container.shutdown()`（停接收 → drain 5s → 落盘 → 关服务）。
 *
 * 另外支持 `--replay` 参数（等价于 `LLM_MODE=replay`，用于离线整周回放）：
 * 它只影响**还没读到**的 `LLM_MODE`（显式环境变量优先），不改变其他任何行为。
 */
import { pathToFileURL } from 'node:url';

import { loadEnv } from './env.ts';
import type { EnvConfig } from './env.ts';
import { buildContainer } from './wiring/container.ts';
import type { AppContainer } from './wiring/container.ts';

/** 打印环境变量失败提示，并给出可直接照做的修复步骤。 */
function reportEnvFailure(problems: string): void {
  process.stderr.write(`${problems}\n`);
  process.stderr.write(
    [
      '',
      '修复方式（二选一）：',
      '  1) live 模式：在仓库根目录创建 .env（参考 .env.example），至少写入',
      '       ANTHROPIC_API_KEY=sk-ant-...',
      '     然后重新执行 npm start（.env 不入库）。',
      '  2) 离线演示/整周回放：LLM_MODE=replay npm start   （或 npm start -- --replay）',
      '     回放不访问网络；可用 LLM_FIXTURE 指定 fixture 路径。',
      '',
    ].join('\n'),
  );
}

/**
 * 把 `process.argv` 里的 `--replay` 折成环境变量：显式 `LLM_MODE` 优先。
 * 返回**不修改** `process.env` 的副本，避免影响子进程/测试。
 */
export function envSourceFor(
  argv: readonly string[],
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (!argv.includes('--replay')) return source;
  if (source['LLM_MODE'] !== undefined && source['LLM_MODE'].trim() !== '') return source;
  return { ...source, LLM_MODE: 'replay' };
}

/**
 * 启动服务并返回实际端口。
 *
 * 返回 `{ container, port }` 让测试/脚本可以拿到容器（生产入口只用端口）。
 * 环境/自检/端口失败会抛错，由 `main` 打印后 `exit(1)`。
 */
export async function startServer(
  source: NodeJS.ProcessEnv = process.env,
): Promise<{ container: AppContainer; port: number }> {
  const envResult = loadEnv(source);
  if (!envResult.ok) {
    throw new EnvConfigError(envResult.error);
  }
  const env: EnvConfig = envResult.value;

  const container = buildContainer(env);

  // §17.1：Intl 退化（small-icu）会让所有 ET 日期/偏移静默算错，必须启动即失败。
  container.calendar.selfTest();

  // §6.3：恢复上一次快照 + inflight。失败不阻断启动（没有会话总比编一个安全）。
  await runRecovery(container);

  container.retryQueue.start();

  const port = await container.server.listen();
  container.logger.info('service ready', {
    port,
    webhook_url: `http://localhost:${String(port)}/webhooks`,
    llm_mode: env.llmMode,
    data_dir: env.dataDir,
    out_dir: env.outDir,
    tz: env.tz,
  });
  process.stdout.write(
    `LumiMeds pharmacy desk listening on http://localhost:${String(port)} ` +
      `(POST /webhooks, GET /health, /orders/:id, /sam, /state; LLM_MODE=${env.llmMode})\n`,
  );
  return { container, port };
}

/**
 * 启动序列第 3 步：先由 wiring 读快照、重建会话并注入 `pharmacy_api`（§6.3 的顺序
 * 要求：必须在恢复发单之前），再让 `RecoveryService` 处理 `inflight.json`。
 *
 * 失败策略：**不阻断启动**。没有会话时后续 `order`/`email` 会 500 `no_session`，
 * 直到下一个 `simulation.started`；这比「用 config 拼一个空壳会话」安全（§16-Q3）。
 */
async function runRecovery(container: AppContainer): Promise<void> {
  try {
    const session = await container.restoreSession();
    if (session === null) return;
    const report = await container.recovery.run();
    container.logger.info('启动恢复完成', {
      inflight_entries: report.inflightEntries,
      committed: report.committed,
      recovered: report.recovered,
      confirmed: report.confirmed,
      failed: report.failed,
      deferred: report.deferred,
      state_saved: report.stateSaved,
    });
  } catch (cause) {
    container.logger.error(
      '启动恢复失败：按无会话继续（后续 order/email 将回 500 no_session，等待新的 simulation.started）',
      { cause },
    );
  }
}

/** 环境变量不合格的专用错误（`main` 用可执行提示代替 stack）。 */
export class EnvConfigError extends Error {
  constructor(readonly problems: string) {
    super('invalid environment configuration');
    this.name = 'EnvConfigError';
  }
}

/**
 * CLI 入口：成功时长期运行（直到信号），失败时打印原因并 `exit(1)`。
 * 第二次信号强制退出，避免卡在「关不掉」的进程上。
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  source: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  let container: AppContainer;
  try {
    const started = await startServer(envSourceFor(argv, source));
    container = started.container;
  } catch (cause) {
    if (cause instanceof EnvConfigError) {
      reportEnvFailure(cause.problems);
    } else {
      process.stderr.write(
        `启动失败：${cause instanceof Error ? cause.message : String(cause)}\n`,
      );
      if (cause instanceof Error && cause.stack !== undefined) {
        process.stderr.write(`${cause.stack}\n`);
      }
      process.stderr.write(
        '排查：data/ 里的 state.json / inflight.json 是否损坏？端口是否被占用？Intl 是否为 small-icu？\n',
      );
    }
    process.exit(1);
  }

  let shuttingDown = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      process.stderr.write(`收到第二个 ${signal}，强制退出\n`);
      process.exit(1);
    }
    shuttingDown = true;
    container.logger.info('收到停机信号，开始优雅停机', { signal });
    container
      .shutdown()
      .then(() => {
        process.exitCode = 0;
      })
      .catch((cause: unknown) => {
        process.stderr.write(
          `停机过程出错：${cause instanceof Error ? cause.message : String(cause)}\n`,
        );
        process.exitCode = 1;
      });
  };

  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  // 进程存活由 HTTP server 的监听句柄保证：`server.listen()` 之后事件循环不会空，
  // shutdown 里 `server.close()` 掉最后一个句柄后进程自然退出。
}

// 仅在被当作入口脚本执行时启动（测试 import 本文件不会产生副作用）。
// `import.meta.main` 在 Node 22 尚不是标准 API，所以比较「本模块 URL」与 argv[1]。
const entryPath = process.argv[1];
const isMain =
  entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href;

if (isMain) {
  void main();
}
