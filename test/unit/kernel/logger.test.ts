import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createLogger, noopLogger } from '../../../src/kernel/logger.ts';
import { AppError } from '../../../src/kernel/errors.ts';

test('noopLogger 安静且 child 返回自身', () => {
  assert.equal(noopLogger.child({ a: 1 }), noopLogger);
  // 不抛、不写任何东西
  noopLogger.info('x');
  noopLogger.warn('y');
  noopLogger.error('z');
});

test('createLogger 写单行 JSON；child 字段合并；AppError 带出 code', (t) => {
  const write = t.mock.method(process.stdout, 'write', () => true);
  const logger = createLogger({ service: 'desk' }).child({ event_id: 'evt_001' });
  logger.info('hello', { at: '2026-11-09T06:00:00-05:00' });
  write.mock.restore();
  assert.equal(write.mock.callCount(), 1);
  const line = String(write.mock.calls[0]!.arguments[0]);
  assert.equal(line.endsWith('\n'), true);
  assert.equal(line.includes('\n'), true);
  assert.equal(line.trim().split('\n').length, 1);
  const parsed = JSON.parse(line) as Record<string, unknown>;
  assert.equal(parsed['level'], 'info');
  assert.equal(parsed['msg'], 'hello');
  assert.equal(parsed['service'], 'desk');
  assert.equal(parsed['event_id'], 'evt_001');
  assert.equal(parsed['at'], '2026-11-09T06:00:00-05:00');

  const writeErr = t.mock.method(process.stderr, 'write', () => true);
  logger.error('failed', { error: new AppError('gateway_failed', 'boom') });
  writeErr.mock.restore();
  const parsedErr = JSON.parse(String(writeErr.mock.calls[0]!.arguments[0])) as Record<string, unknown>;
  assert.equal(parsedErr['level'], 'error');
  assert.deepEqual(parsedErr['error'], {
    name: 'AppError',
    code: 'gateway_failed',
    message: 'boom',
  });
});
