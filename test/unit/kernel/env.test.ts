import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { loadEnv } from '../../../src/env.ts';

const KEY = { ANTHROPIC_API_KEY: 'sk-test-not-a-real-key' };

function mustOk<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(`expected Ok, got: ${r.error}`);
  return r.value;
}

function mustErr(r: { ok: true; value: unknown } | { ok: false; error: string }): string {
  if (r.ok) throw new Error('expected Err');
  return r.error;
}

test('只有 ANTHROPIC_API_KEY 时全部取默认值', () => {
  const env = mustOk(loadEnv({ ...KEY }));
  assert.equal(env.port, 3000);
  assert.equal(env.apiKey, 'sk-test-not-a-real-key');
  assert.equal(env.model, 'claude-sonnet-4-5');
  assert.equal(env.anthropicTimeoutMs, 12_000);
  assert.equal(env.dataDir, './data');
  assert.equal(env.outDir, './out');
  assert.equal(env.tz, 'America/New_York');
  assert.equal(env.llmMode, 'live');
  assert.equal(env.inflightFile, './data/inflight.json');
  assert.equal(env.llmFixture, 'test/fixtures/llm/week-a.extractions.json');
});

test('显式值覆盖默认值', () => {
  const env = mustOk(
    loadEnv({
      ...KEY,
      PORT: '4100',
      ANTHROPIC_MODEL: 'claude-haiku-4-5',
      ANTHROPIC_TIMEOUT_MS: '5000',
      DATA_DIR: '/tmp/data',
      OUT_DIR: '/tmp/out',
      TZ: 'America/New_York',
      LLM_MODE: 'replay',
      INFLIGHT_FILE: '/tmp/inflight.json',
      LLM_FIXTURE: '/tmp/fixture.json',
    }),
  );
  assert.equal(env.port, 4100);
  assert.equal(env.model, 'claude-haiku-4-5');
  assert.equal(env.anthropicTimeoutMs, 5000);
  assert.equal(env.dataDir, '/tmp/data');
  assert.equal(env.outDir, '/tmp/out');
  assert.equal(env.llmMode, 'replay');
  assert.equal(env.inflightFile, '/tmp/inflight.json');
  assert.equal(env.llmFixture, '/tmp/fixture.json');
});

test('PORT=0 合法（测试让内核分配端口）', () => {
  const env = mustOk(loadEnv({ ...KEY, PORT: '0' }));
  assert.equal(env.port, 0);
});

test('缺 ANTHROPIC_API_KEY → 可打印的失败提示', () => {
  const msg = mustErr(loadEnv({}));
  assert.match(msg, /ANTHROPIC_API_KEY/);
  assert.match(msg, /环境变量配置无效/);
});

test('非法的 PORT / ANTHROPIC_TIMEOUT_MS / LLM_MODE 都报错', () => {
  assert.match(mustErr(loadEnv({ ...KEY, PORT: 'abc' })), /PORT/);
  assert.match(mustErr(loadEnv({ ...KEY, PORT: '-1' })), /PORT/);
  assert.match(mustErr(loadEnv({ ...KEY, PORT: '70000' })), /PORT/);
  assert.match(mustErr(loadEnv({ ...KEY, ANTHROPIC_TIMEOUT_MS: '0' })), /ANTHROPIC_TIMEOUT_MS/);
  assert.match(mustErr(loadEnv({ ...KEY, ANTHROPIC_TIMEOUT_MS: 'x' })), /ANTHROPIC_TIMEOUT_MS/);
  assert.match(mustErr(loadEnv({ ...KEY, LLM_MODE: 'fixture' })), /LLM_MODE/);
});

test('多个问题一次列全（便于一次修完）', () => {
  const msg = mustErr(loadEnv({ PORT: 'abc', LLM_MODE: 'nope' }));
  assert.match(msg, /ANTHROPIC_API_KEY/);
  assert.match(msg, /PORT/);
  assert.match(msg, /LLM_MODE/);
  assert.equal(msg.split('\n').length >= 4, true);
});
