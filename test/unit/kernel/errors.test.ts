import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { AppError } from '../../../src/kernel/errors.ts';

test('AppError 是 Error 子类，保留 code/message/detail', () => {
  const e = new AppError('unknown_dose', 'bad dose', { value: '25mg' });
  assert.equal(e instanceof Error, true);
  assert.equal(e instanceof AppError, true);
  assert.equal(e.name, 'AppError');
  assert.equal(e.code, 'unknown_dose');
  assert.equal(e.message, 'bad dose');
  assert.deepEqual(e.detail, { value: '25mg' });
});

test('AppError 可 JSON 序列化（日志/Sam 需要 code 与 detail）', () => {
  const e = new AppError('extraction_failed', 'no tool_use');
  assert.deepEqual(JSON.parse(JSON.stringify(e)), {
    name: 'AppError',
    code: 'extraction_failed',
    message: 'no tool_use',
  });
  const withDetail = new AppError('bad_interval', 'from >= until', { from: 2, until: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify({ error: withDetail })).error.detail, {
    from: 2,
    until: 1,
  });
});
