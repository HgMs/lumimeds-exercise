/**
 * 药房网关与审计适配器契约测试
 * （`ARCHITECTURE.md` §5.10；`DATA-CONTRACTS.md` §2.1、§3.7）。
 *
 * 网关：请求形状、状态码表、超时/网络错误映射、base URL 未注入时的不变量破坏。
 * 审计：两份 JSONL 追加、`flush()` 覆盖全部 pending、写失败可被 flush 观察到。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { JsonlAuditSink } from '../../src/adapters/audit/jsonl-audit-sink.ts';
import { HttpPharmacyGateway } from '../../src/adapters/pharmacy/http-pharmacy-gateway.ts';
import type { FetchLike } from '../../src/adapters/pharmacy/http-pharmacy-gateway.ts';
import type { FactAuditRecord } from '../../src/application/ports/audit-sink.ts';
import type { SendOutcome } from '../../src/application/ports/pharmacy-gateway.ts';
import type { PersistedRoutingDecision } from '../../src/domain/routing/decision.ts';
import type { Logger } from '../../src/kernel/logger.ts';
import { captureFetch, hangUntilAborted, jsonResponse } from './support.ts';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

describe('HttpPharmacyGateway', () => {
  it('POST {base}/pharmacy-orders，body 三字段，201 → accepted', async () => {
    const captured = captureFetch(async () => jsonResponse(201, { ok: true }));
    const gateway = new HttpPharmacyGateway({ fetch: captured.fetch });
    gateway.setBaseUrl('http://pharmacy.test/');

    const outcome = await gateway.send(
      { orderId: 'ORD-CONTRACT-1', pharmacy: 'ALPHA', reason: 'fastest safe' },
      { timeoutMs: 5000 },
    );

    assert.deepEqual(outcome, { kind: 'accepted', status: 201 });
    assert.equal(captured.calls.length, 1);
    assert.equal(captured.calls[0].url, 'http://pharmacy.test/pharmacy-orders');
    assert.equal(captured.calls[0].init.method, 'POST');
    const headers = captured.calls[0].init.headers as Record<string, string>;
    assert.equal(headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(captured.calls[0].init.body as string), {
      order_id: 'ORD-CONTRACT-1',
      pharmacy: 'ALPHA',
      reason: 'fastest safe',
    });
  });

  it('reason 可选：未给时 body 里没有 reason 字段', async () => {
    const captured = captureFetch(async () => jsonResponse(201, {}));
    const gateway = new HttpPharmacyGateway({
      fetch: captured.fetch,
      baseUrl: 'http://pharmacy.test',
    });

    await gateway.send({ orderId: 'ORD-CONTRACT-1', pharmacy: 'MANUAL' }, { timeoutMs: 5000 });
    const body = JSON.parse(captured.calls[0].init.body as string) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ['order_id', 'pharmacy']);
  });

  const statusTable: Array<{ status: number; expected: (status: number) => SendOutcome }> = [
    { status: 201, expected: (status) => ({ kind: 'accepted', status: 201 }) },
    { status: 409, expected: (status) => ({ kind: 'duplicate', status: 409 }) },
    { status: 400, expected: (status) => ({ kind: 'rejected', status: 400 }) },
    { status: 404, expected: (status) => ({ kind: 'rejected', status: 404 }) },
    { status: 500, expected: (status) => ({ kind: 'retryable', status: 500 }) },
    { status: 503, expected: (status) => ({ kind: 'retryable', status: 503 }) },
    { status: 429, expected: (status) => ({ kind: 'retryable', status: 429 }) },
  ];

  for (const testCase of statusTable) {
    it(`状态码 ${testCase.status} → ${testCase.expected(testCase.status).kind}`, async () => {
      const captured = captureFetch(async () => new Response('', { status: testCase.status }));
      const gateway = new HttpPharmacyGateway({
        fetch: captured.fetch,
        baseUrl: 'http://pharmacy.test',
      });
      const outcome = await gateway.send(
        { orderId: 'ORD-CONTRACT-1', pharmacy: 'ALPHA' },
        { timeoutMs: 5000 },
      );
      assert.deepEqual(outcome, testCase.expected(testCase.status));
    });
  }

  it('400/404 带响应体时 message 保留（给 error 日志/告警用）', async () => {
    const captured = captureFetch(
      async () => new Response('{"error":"bad request"}', { status: 400 }),
    );
    const gateway = new HttpPharmacyGateway({
      fetch: captured.fetch,
      baseUrl: 'http://pharmacy.test',
    });
    const outcome = await gateway.send(
      { orderId: 'ORD-CONTRACT-1', pharmacy: 'ALPHA' },
      { timeoutMs: 5000 },
    );
    assert.deepEqual(outcome, {
      kind: 'rejected',
      status: 400,
      message: '{"error":"bad request"}',
    });
  });

  it('setBaseUrl 未调用 → send 抛错（不变量破坏）', async () => {
    const captured = captureFetch(async () => jsonResponse(201, {}));
    const gateway = new HttpPharmacyGateway({ fetch: captured.fetch });
    await assert.rejects(
      () => gateway.send({ orderId: 'ORD-CONTRACT-1', pharmacy: 'ALPHA' }, { timeoutMs: 5000 }),
      /setBaseUrl/,
    );
    assert.equal(captured.calls.length, 0);
  });

  it('超时（AbortSignal.timeout）→ {kind:timeout}', async () => {
    const hangingFetch: FetchLike = (_input, init) => hangUntilAborted(init);
    const gateway = new HttpPharmacyGateway({
      fetch: hangingFetch,
      baseUrl: 'http://pharmacy.test',
    });

    const started = Date.now();
    const outcome = await gateway.send(
      { orderId: 'ORD-CONTRACT-1', pharmacy: 'ALPHA' },
      { timeoutMs: 20 },
    );
    const elapsed = Date.now() - started;

    assert.deepEqual(outcome, { kind: 'timeout' });
    assert.ok(elapsed < 2000, `timeout took too long: ${elapsed}ms`);
  });

  it('网络错误（TypeError: fetch failed + cause code）→ timeout（结果未知），原因进日志', async () => {
    const warnings: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const logger: Logger = {
      info: () => undefined,
      warn: (msg, fields) => {
        warnings.push({ msg, fields });
      },
      error: () => undefined,
      child: () => logger,
    };
    const captured = captureFetch(async () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4000'), {
          code: 'ECONNREFUSED',
        }),
      });
    });
    const gateway = new HttpPharmacyGateway({
      fetch: captured.fetch,
      baseUrl: 'http://pharmacy.test',
      logger,
    });
    const outcome = await gateway.send(
      { orderId: 'ORD-CONTRACT-1', pharmacy: 'ALPHA' },
      { timeoutMs: 5000 },
    );

    // 超时与「连接被断」同属结果未知（DATA-CONTRACTS §2.1）→ 上层只对同一药房重发。
    assert.deepEqual(outcome, { kind: 'timeout' });
    assert.equal(warnings.length, 1);
    assert.ok(
      String(warnings[0].fields?.['error']).includes('ECONNREFUSED'),
      'node fetch TypeError 的 cause code 必须出现在日志里',
    );
  });

  it('预算已用完（timeoutMs <= 0）→ timeout，且不发请求', async () => {
    const captured = captureFetch(async () => jsonResponse(201, {}));
    const gateway = new HttpPharmacyGateway({
      fetch: captured.fetch,
      baseUrl: 'http://pharmacy.test',
    });
    const outcome = await gateway.send(
      { orderId: 'ORD-CONTRACT-1', pharmacy: 'ALPHA' },
      { timeoutMs: 0 },
    );
    assert.deepEqual(outcome, { kind: 'timeout' });
    assert.equal(captured.calls.length, 0);
  });
});

describe('JsonlAuditSink', () => {
  function sampleDecision(): PersistedRoutingDecision {
    return {
      order_id: 'ORD-CONTRACT-1',
      at: '2026-05-12T10:00:00-04:00',
      order: {
        order_id: 'ORD-CONTRACT-1',
        state: 'OH',
        medication: 'semaglutide',
        dose: '1mg',
      },
      chosen: 'ALPHA',
      basis: 'rank',
      reason: 'fastest safe: 1 day, $100',
      candidates: [
        {
          pharmacy: 'ALPHA',
          eligible: true,
          shipsInDays: 1,
          price: 100,
          capacityLeft: 2,
          failures: [],
        },
      ],
      preference: null,
      override: null,
      sent: { status: 201, at: '2026-05-12T10:00:01-04:00' },
    };
  }

  function sampleFactRecord(): FactAuditRecord {
    return {
      at: '2026-05-12T09:00:00-04:00',
      event_id: 'evt-contract-1',
      from: 'team@alpha.test',
      subject: 'Stock',
      role: 'pharmacy',
      outcome: 'applied',
      facts: [
        {
          id: 'fact_0001',
          type: 'stock_unavailable',
          pharmacy: 'ALPHA',
          medication: 'tirzepatide',
          dose: '5mg',
          interval: { from: '2026-05-12T09:00:00-04:00', until: null },
        },
      ],
      sources: { from: 'model', until: 'parser:until_weekday' },
      assumptions: ['no until → indefinite'],
    };
  }

  it('decision/fact 各写一行，flush 等全部 append 完成', async () => {
    const outDir = join(await makeTempDir('adapters-audit-'), 'nested', 'out');
    const sink = new JsonlAuditSink(outDir);
    const decision = sampleDecision();
    const fact = sampleFactRecord();

    // 故意不 await 单次写入：flush 才是「全部完成」的等待点。
    void sink.decision(decision);
    void sink.fact(fact);
    await sink.flush();

    const decisionsText = await readFile(join(outDir, 'decisions.jsonl'), 'utf8');
    const factsText = await readFile(join(outDir, 'facts.jsonl'), 'utf8');

    assert.ok(decisionsText.endsWith('\n'), 'JSONL line must end with newline');
    assert.ok(factsText.endsWith('\n'));
    assert.deepEqual(JSON.parse(decisionsText.trim()), decision);
    assert.deepEqual(JSON.parse(factsText.trim()), fact);
  });

  it('追加写：多次 decision 累加多行', async () => {
    const outDir = await makeTempDir('adapters-audit-');
    const sink = new JsonlAuditSink(outDir);

    await sink.decision(sampleDecision());
    const second = sampleDecision();
    second.order_id = 'ORD-CONTRACT-2';
    second.order.order_id = 'ORD-CONTRACT-2';
    await sink.decision(second);
    await sink.flush();

    const lines = (await readFile(join(outDir, 'decisions.jsonl'), 'utf8'))
      .split('\n')
      .filter((line) => line !== '');
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[1]).order_id, 'ORD-CONTRACT-2');
    assert.equal((await readFile(join(outDir, 'facts.jsonl'), 'utf8').catch(() => '')), '');
  });

  it('flush 在没有 pending 时直接 resolve', async () => {
    const outDir = await makeTempDir('adapters-audit-');
    const sink = new JsonlAuditSink(outDir);
    await sink.flush();
    assert.deepEqual(sink.paths().decisions, join(outDir, 'decisions.jsonl'));
    assert.deepEqual(sink.paths().facts, join(outDir, 'facts.jsonl'));
  });

  it('目录写不了时写入 promise reject、flush 抛错（由 AuditRecorder 记日志）', async () => {
    const dir = await makeTempDir('adapters-audit-');
    const blocker = join(dir, 'not-a-dir');
    await writeFile(blocker, 'block', 'utf8');
    const sink = new JsonlAuditSink(blocker);

    const write = sink.decision(sampleDecision());
    await assert.rejects(() => write);
    await assert.rejects(() => sink.flush());
  });
});
