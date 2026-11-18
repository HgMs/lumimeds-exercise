import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { andThen, collect, err, isErr, isOk, map, mapErr, ok, type Result } from '../../../src/kernel/result.ts';

test('ok / err 构造与判别', () => {
  const a = ok(1);
  const b = err('boom');
  assert.equal(isOk(a), true);
  assert.equal(isErr(a), false);
  assert.equal(isOk(b), false);
  assert.equal(isErr(b), true);
  assert.equal(a.value, 1);
  assert.equal(b.error, 'boom');
});

test('map 只作用在成功分支', () => {
  assert.deepEqual(map(ok(2), (n) => n * 3), ok(6));
  assert.deepEqual(map(err('e'), (n: number) => n * 3), err('e'));
});

test('mapErr 只作用在失败分支', () => {
  assert.deepEqual(mapErr(ok(2), (e: string) => e.length), ok(2));
  assert.deepEqual(mapErr(err('boom'), (e) => e.length), err(4));
});

test('andThen 串联，失败短路', () => {
  const half = (n: number): Result<number, string> =>
    n % 2 === 0 ? ok(n / 2) : err(`odd:${n}`);
  assert.deepEqual(andThen(ok(8), half), ok(4));
  assert.deepEqual(andThen(ok(9), half), err('odd:9'));
  assert.deepEqual(andThen(err('first'), half), err('first'));
});

test('collect 全成功给 values，任一失败给第一个失败', () => {
  assert.deepEqual(collect<number, string>([]), ok([]));
  assert.deepEqual(collect<number, string>([ok(1), ok(2), ok(3)]), ok([1, 2, 3]));
  assert.deepEqual(collect<number, string>([ok(1), err('a'), err('b')]), err('a'));
  assert.deepEqual(collect<number, string>([err('a'), ok(1)]), err('a'));
});
