import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { SerialQueue } from '../../../src/kernel/serial-queue.ts';

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test('严格 FIFO + 单飞：前一个任务结束前，后一个不会开始', async () => {
  const queue = new SerialQueue();
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const first = queue.run(async () => {
    events.push('start#1');
    await gate;
    events.push('end#1');
    return 1;
  });
  const second = queue.run(async () => {
    events.push('start#2');
    return 2;
  });
  const third = queue.run(async () => {
    events.push('start#3');
    return 3;
  });

  assert.equal(queue.depth, 3);
  await tick();
  assert.deepEqual(events, ['start#1'], '第二个任务必须等第一个结束');

  release();
  assert.deepEqual(await Promise.all([first, second, third]), [1, 2, 3]);
  assert.deepEqual(events, ['start#1', 'end#1', 'start#2', 'start#3']);
  assert.equal(queue.depth, 0);
});

test('任务失败只抛给它的调用方，队列继续跑', async () => {
  const queue = new SerialQueue();
  const order: string[] = [];
  const failing = queue.run(async () => {
    order.push('a');
    throw new Error('boom');
  });
  const after = queue.run(async () => {
    order.push('b');
    return 'ok';
  });
  await assert.rejects(failing, /boom/);
  assert.equal(await after, 'ok');
  assert.deepEqual(order, ['a', 'b']);
  assert.equal(queue.depth, 0);
});

test('空闲队列 depth 为 0，空任务也串行', async () => {
  const queue = new SerialQueue();
  assert.equal(queue.depth, 0);
  const results = await Promise.all([queue.run(async () => 1), queue.run(async () => 2)]);
  assert.deepEqual(results, [1, 2]);
  assert.equal(queue.depth, 0);
});
