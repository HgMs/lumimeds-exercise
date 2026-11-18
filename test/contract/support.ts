/**
 * adapters 契约测试的共享夹具（不直接跑测试，只是 helper）。
 *
 * 这里刻意用**合成数据**（`alpha.test` / `beta.test` 这类保留域名、与任何一周无关的
 * 日期），不从 `sim/week-a.jsonl` 抄值：契约测试验证的是「形状与语义」，
 * 整周行为由 integration 覆盖。
 */
import assert from 'node:assert/strict';
import { Catalogue } from '../../src/domain/catalogue.ts';
import { PharmacyRegistry } from '../../src/domain/pharmacy.ts';
import type { ExtractionInput } from '../../src/domain/email/extraction.ts';
import { StateNormalizer } from '../../src/domain/normalize/state-normalizer.ts';
import { EtCalendar } from '../../src/kernel/time/et-calendar.ts';
import { Instant } from '../../src/kernel/time/instant.ts';
import type { FetchLike } from '../../src/adapters/llm/anthropic-extractor.ts';

/** 一个与 week A 无关的 ET 时间（2026-05-12 是周二，EDT -04:00）。 */
export const TEST_INSTANT_ISO = '2026-05-12T08:00:00-04:00';

/** 合成 ops 地址（保留域名）。 */
export const TEST_OPS: readonly string[] = Object.freeze(['ops@lumimeds.test']);

/** 合成两个药房所需的 config；catalogue 与 registry 必须来自同一份。 */
export const TEST_CATALOGUE_CONFIG = {
  tirzepatide: ['2.5mg', '5mg'],
  semaglutide: ['1mg'],
} as const;

export interface SyntheticEnv {
  calendar: EtCalendar;
  catalogue: Catalogue;
  registry: PharmacyRegistry;
  instant: Instant;
}

/** 构造 EtCalendar（含 selfTest）、Catalogue、PharmacyRegistry 的合成环境。 */
export function makeSyntheticEnv(): SyntheticEnv {
  const calendar = new EtCalendar();
  calendar.selfTest();

  const catalogue = Catalogue.from(TEST_CATALOGUE_CONFIG);
  const registryResult = PharmacyRegistry.from(
    [
      {
        id: 'ALPHA',
        name: 'Alpha Rx',
        contacts: ['team@alpha.test'],
        open: true,
        shipsInDays: 1,
        dailyCapacity: 3,
        price: { tirzepatide: 120, semaglutide: 100 },
        blockedStates: ['FL'],
        stock: { tirzepatide: ['2.5mg', '5mg'], semaglutide: ['1mg'] },
      },
      {
        id: 'BETA',
        name: 'Beta Pharmacy',
        contacts: ['ops@beta.test'],
        open: true,
        shipsInDays: 2,
        dailyCapacity: 2,
        price: { tirzepatide: 110, semaglutide: 90 },
        blockedStates: ['Texas'],
        stock: { tirzepatide: ['2.5mg'], semaglutide: ['1mg'] },
      },
    ],
    { catalogue, states: new StateNormalizer() },
  );
  assert.ok(registryResult.ok, 'synthetic pharmacy registry must build');

  const instant = Instant.parse(TEST_INSTANT_ISO);
  assert.ok(instant.ok, 'synthetic instant must parse');

  return {
    calendar,
    catalogue,
    registry: registryResult.value,
    instant: instant.value,
  };
}

/** 构造一份 `ExtractionInput`（默认发件人是 ALPHA 的联系人）。 */
export function makeExtractionInput(
  env: SyntheticEnv,
  overrides: Partial<ExtractionInput> = {},
): ExtractionInput {
  return {
    eventId: 'evt-contract-1',
    at: env.instant,
    week: env.calendar.calendarWeek(env.instant),
    registry: env.registry,
    catalogue: env.catalogue,
    email: {
      from: 'Jen <team@alpha.test>',
      subject: 'Stock update',
      body: 'We are out of tirzepatide 5mg until Wednesday.',
    },
    correctionHint: false,
    ...overrides,
  };
}

/** 一次被捕获的 fetch 调用。 */
export interface CapturedCall {
  url: string;
  init: RequestInit;
}

/**
 * 假 fetch：记录每次调用的 url/init，由 `respond` 决定返回。
 * 测试用它断言「请求形状」，也用它注入超时/网络失败。
 */
export function captureFetch(
  respond: (url: string, init: RequestInit) => Promise<Response>,
): { fetch: FetchLike; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const requestInit = init ?? {};
    calls.push({ url, init: requestInit });
    return respond(url, requestInit);
  };
  return { fetch: fetchImpl, calls };
}

/** JSON 响应（默认 200）。 */
export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 构造一个 Messages API 的 tool_use 成功响应。 */
export function makeToolUseResponse(input: unknown, status = 200): Response {
  return jsonResponse(status, {
    id: 'msg_contract_1',
    type: 'message',
    role: 'assistant',
    content: [
      { type: 'text', text: 'Here are the facts.' },
      { type: 'tool_use', id: 'toolu_contract_1', name: 'record_email_facts', input },
    ],
    stop_reason: 'tool_use',
  });
}

/**
 * 假 fetch 的「永不返回」实现：直到 `init.signal` abort 才 reject。
 *
 * 注意：`AbortSignal.timeout()` 的定时器在 Node 里是 unref 的——它不阻止进程退出。
 * 如果测试里只有这个 pending promise，事件循环会在超时触发前就空掉，Node 的
 * test runner 会报 `Promise resolution is still pending...`。所以这里额外挂一个
 * **ref 的** keep-alive 定时器，abort 时清掉。生产环境有 socket 句柄保活，不需要这一手。
 */
export function hangUntilAborted(init: RequestInit | undefined): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    assert.ok(signal !== undefined && signal !== null, 'expected an abort signal');
    const abortSignal = signal as AbortSignal;
    const keepAlive = setTimeout(() => undefined, 10_000);
    abortSignal.addEventListener(
      'abort',
      () => {
        clearTimeout(keepAlive);
        reject(abortSignal.reason);
      },
      { once: true },
    );
  });
}

