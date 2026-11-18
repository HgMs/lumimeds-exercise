/**
 * 持久化适配器契约测试（`ARCHITECTURE.md` §5.10/§11；`DATA-CONTRACTS.md` §3.6/§3.8）。
 *
 * 覆盖：
 * - `FileStateStore`：原子写往返（tmp + rename、不先删旧文件）、坏 JSON / 版本不符 → Err、
 *   clear 幂等；
 * - `FileInflightJournal`：begin/commit/load/clear、同单 upsert、跨实例持久化、
 *   损坏文件 → 抛（诚实失败）；
 * - `MemoryStateStore` / `MemoryInflightJournal`：与文件版语义一致 + `failNextSave` 注入。
 */
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { FileInflightJournal } from '../../src/adapters/persistence/file-inflight-journal.ts';
import { FileStateStore } from '../../src/adapters/persistence/file-state-store.ts';
import { MemoryInflightJournal } from '../../src/adapters/persistence/memory-inflight-journal.ts';
import { MemoryStateStore } from '../../src/adapters/persistence/memory-state-store.ts';
import type { InflightEntry } from '../../src/application/ports/inflight-journal.ts';
import type { PersistedState } from '../../src/application/ports/state-store.ts';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

/** 一份形状完整的快照（合成数据，与任何一周无关）。 */
function sampleState(): PersistedState {
  return {
    version: 1,
    week_started_at: '2026-05-11T06:00:00-04:00',
    pharmacy_api: 'http://pharmacy.test',
    config: {
      catalogue: { semaglutide: ['1mg'] },
      lumimedsOps: ['ops@lumimeds.test'],
      pharmacies: [],
    },
    facts: [],
    seen_event_ids: ['evt-contract-1'],
    sent_orders: {
      'ORD-CONTRACT-1': { pharmacy: 'ALPHA', at: '2026-05-12T10:00:00-04:00' },
    },
    decisions: {},
    sam: [],
    seq: { fact: 0 },
    last_event_at: '2026-05-12T10:00:00-04:00',
    degraded: false,
  };
}

function sampleEntry(orderId: string, pharmacy: string = 'ALPHA'): InflightEntry {
  return {
    orderId,
    pharmacy,
    at: '2026-05-12T10:00:00-04:00',
    decisionReason: 'fastest safe',
    startedAtRealClock: '2026-05-12T14:00:00.000Z',
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('FileStateStore', () => {
  it('load 在无文件 → Ok(null)；save/load 原子往返；tmp 不残留', async () => {
    const dir = await makeTempDir('adapters-store-');
    const store = new FileStateStore(dir);

    const empty = await store.load();
    assert.equal(empty.ok, true);
    if (empty.ok) assert.equal(empty.value, null);

    const first = sampleState();
    const saved = await store.save(first);
    assert.equal(saved.ok, true, JSON.stringify(saved));

    const loaded = await store.load();
    assert.ok(loaded.ok);
    if (loaded.ok) assert.deepEqual(loaded.value, first);

    assert.equal(await exists(store.path()), true);
    assert.equal(await exists(`${store.path()}.tmp`), false, 'tmp file must be renamed away');
    assert.equal(await exists(join(dir, 'state.json')), true);
  });

  it('save 覆盖旧快照（先写 tmp 再 rename；旧文件只在 rename 时被替换）', async () => {
    const dir = await makeTempDir('adapters-store-');
    const store = new FileStateStore(dir);

    const first = sampleState();
    assert.ok((await store.save(first)).ok);

    const second = sampleState();
    second.facts = [
      {
        id: 'fact_0001',
        type: 'closed',
        event_id: 'evt-contract-2',
        asserted_at: '2026-05-12T10:00:00-04:00',
        pharmacy: 'ALPHA',
        interval: { from: '2026-05-12T10:00:00-04:00', until: null },
      },
    ];
    second.seq = { fact: 1 };
    assert.ok((await store.save(second)).ok);

    const loaded = await store.load();
    assert.ok(loaded.ok);
    if (loaded.ok) {
      assert.deepEqual(loaded.value, second);
      assert.equal(loaded.value?.facts.length, 1);
    }
  });

  it('坏 JSON / 版本不符 / 非对象 → Err(persist_failed)，不抛', async () => {
    const dir = await makeTempDir('adapters-store-');
    const store = new FileStateStore(dir);

    await mkdir(dir, { recursive: true });
    await writeFile(store.path(), '{ not json', 'utf8');
    const badJson = await store.load();
    assert.equal(badJson.ok, false);
    if (!badJson.ok) assert.equal(badJson.error.code, 'persist_failed');

    await writeFile(store.path(), JSON.stringify({ version: 2, week_started_at: 'x' }), 'utf8');
    const badVersion = await store.load();
    assert.equal(badVersion.ok, false);
    if (!badVersion.ok) assert.equal(badVersion.error.code, 'persist_failed');

    await writeFile(store.path(), JSON.stringify(['not', 'an', 'object']), 'utf8');
    const badShape = await store.load();
    assert.equal(badShape.ok, false);
    if (!badShape.ok) assert.equal(badShape.error.code, 'persist_failed');
  });

  it('clear 幂等，之后 load 得到 null', async () => {
    const dir = await makeTempDir('adapters-store-');
    const store = new FileStateStore(dir);
    assert.ok((await store.save(sampleState())).ok);

    assert.equal((await store.clear()).ok, true);
    const cleared = await store.load();
    assert.ok(cleared.ok);
    if (cleared.ok) assert.equal(cleared.value, null);

    assert.equal((await store.clear()).ok, true, 'clear must be idempotent');
  });

  it('目录不可写/路径被占用 → save 返回 Err(persist_failed)', async () => {
    const dir = await makeTempDir('adapters-store-');
    const blocker = join(dir, 'not-a-dir');
    await writeFile(blocker, 'block', 'utf8');

    const store = new FileStateStore(blocker);
    const saved = await store.save(sampleState());
    assert.equal(saved.ok, false);
    if (!saved.ok) assert.equal(saved.error.code, 'persist_failed');
  });
});

describe('FileInflightJournal', () => {
  it('begin 追加 / 同单 upsert / commit 移除 / load 跨实例持久化 / clear', async () => {
    const dir = await makeTempDir('adapters-journal-');
    const filePath = join(dir, 'data', 'inflight.json');
    const journal = new FileInflightJournal(filePath);

    assert.deepEqual(await journal.load(), []);

    const first = sampleEntry('ORD-CONTRACT-1');
    await journal.begin(first);
    await journal.begin(sampleEntry('ORD-CONTRACT-2', 'BETA'));
    assert.deepEqual((await journal.load()).map((entry) => entry.orderId), [
      'ORD-CONTRACT-1',
      'ORD-CONTRACT-2',
    ]);

    // 重试同一单：不能变成两条 WAL 条目，否则恢复会重发两次。
    const firstRetry = { ...first, startedAtRealClock: '2026-05-12T14:05:00.000Z' };
    await journal.begin(firstRetry);
    const afterUpsert = await journal.load();
    assert.equal(afterUpsert.length, 2);
    assert.equal(afterUpsert[0].startedAtRealClock, '2026-05-12T14:05:00.000Z');

    await journal.commit('ORD-CONTRACT-1');
    const afterCommit = await journal.load();
    assert.deepEqual(afterCommit.map((entry) => entry.orderId), ['ORD-CONTRACT-2']);

    // 新实例从磁盘读到同一份 WAL（崩溃恢复路径）。
    const reopened = new FileInflightJournal(filePath);
    assert.deepEqual(await reopened.load(), afterCommit);

    await reopened.clear();
    assert.deepEqual(await journal.load(), []);
    assert.equal(await exists(`${filePath}.tmp`), false, 'tmp file must be renamed away');
  });

  it('commit 不存在的 orderId 是幂等 no-op', async () => {
    const dir = await makeTempDir('adapters-journal-');
    const journal = new FileInflightJournal(join(dir, 'inflight.json'));
    await journal.begin(sampleEntry('ORD-CONTRACT-1'));
    await journal.commit('ORD-CONTRACT-404');
    assert.equal((await journal.load()).length, 1);
  });

  it('接受 {dataDir} 构造：文件落在 dataDir/inflight.json', async () => {
    const dir = await makeTempDir('adapters-journal-');
    const journal = new FileInflightJournal({ dataDir: dir });
    assert.equal(journal.path(), join(dir, 'inflight.json'));
    await journal.begin(sampleEntry('ORD-CONTRACT-1'));
    assert.equal(await exists(join(dir, 'inflight.json')), true);
  });

  it('裸字符串必须是文件路径（.json）；目录用 {dataDir}，防误用', () => {
    // wiring 如果误传 env.dataDir（如 './data'），应在构造时立刻失败，
    // 而不是悄悄在 ./data 这个位置写一个没有扩展名的怪文件。
    assert.throws(() => new FileInflightJournal('./data'), /bare string is a WAL file path/);
  });

  it('损坏的 WAL → load() 抛出（诚实失败，不静默丢在途单）', async () => {
    const dir = await makeTempDir('adapters-journal-');
    const filePath = join(dir, 'inflight.json');
    const journal = new FileInflightJournal(filePath);

    await writeFile(filePath, '{ not json', 'utf8');
    await assert.rejects(() => journal.load(), /not valid JSON/);

    await writeFile(filePath, JSON.stringify({ orderId: 'ORD-CONTRACT-1' }), 'utf8');
    await assert.rejects(() => journal.load(), /must be a JSON array/);

    await writeFile(filePath, JSON.stringify([{ orderId: 'ORD-CONTRACT-1' }]), 'utf8');
    await assert.rejects(() => journal.load(), /invalid string fields/);
  });

  it('并发 begin 不丢条目（写操作串行化）', async () => {
    const dir = await makeTempDir('adapters-journal-');
    const journal = new FileInflightJournal(join(dir, 'inflight.json'));
    await Promise.all([
      journal.begin(sampleEntry('ORD-CONTRACT-1')),
      journal.begin(sampleEntry('ORD-CONTRACT-2')),
      journal.begin(sampleEntry('ORD-CONTRACT-3')),
    ]);
    const entries = await journal.load();
    assert.deepEqual(entries.map((entry) => entry.orderId).sort(), [
      'ORD-CONTRACT-1',
      'ORD-CONTRACT-2',
      'ORD-CONTRACT-3',
    ]);
  });

  it('落盘内容是 DATA-CONTRACTS §3.8 的 snake_case 形状（端口仍是 camelCase）', async () => {
    const dir = await makeTempDir('adapters-journal-');
    const filePath = join(dir, 'inflight.json');
    const journal = new FileInflightJournal(filePath);
    await journal.begin(sampleEntry('ORD-CONTRACT-1'));

    const raw = JSON.parse(await readFile(filePath, 'utf8')) as Array<Record<string, unknown>>;
    assert.deepEqual(raw, [
      {
        order_id: 'ORD-CONTRACT-1',
        pharmacy: 'ALPHA',
        at: '2026-05-12T10:00:00-04:00',
        decision_reason: 'fastest safe',
        started_at_real_clock: '2026-05-12T14:00:00.000Z',
      },
    ]);

    // 端口读回来仍是 camelCase 的 InflightEntry。
    assert.deepEqual(await journal.load(), [sampleEntry('ORD-CONTRACT-1')]);
  });

  it('读取兼容 camelCase 旧文件，写回统一成 snake_case', async () => {
    const dir = await makeTempDir('adapters-journal-');
    const filePath = join(dir, 'inflight.json');
    const journal = new FileInflightJournal(filePath);
    await writeFile(
      filePath,
      JSON.stringify([sampleEntry('ORD-CONTRACT-1')]),
      'utf8',
    );

    assert.deepEqual(await journal.load(), [sampleEntry('ORD-CONTRACT-1')]);
    await journal.begin(sampleEntry('ORD-CONTRACT-2'));
    const raw = JSON.parse(await readFile(filePath, 'utf8')) as Array<Record<string, unknown>>;
    assert.deepEqual(Object.keys(raw[0]).sort(), [
      'at',
      'decision_reason',
      'order_id',
      'pharmacy',
      'started_at_real_clock',
    ]);
  });
});

describe('MemoryStateStore', () => {
  it('save/load/clear 与深拷贝边界', async () => {
    const store = new MemoryStateStore();
    assert.deepEqual(await store.load(), { ok: true, value: null });

    const state = sampleState();
    assert.ok((await store.save(state)).ok);

    // 模拟落盘的序列化边界：改传入对象不影响已保存状态。
    state.seen_event_ids.push('evt-mutated-after-save');

    const loaded = await store.load();
    assert.ok(loaded.ok);
    assert.deepEqual(loaded.value?.seen_event_ids, ['evt-contract-1']);

    assert.ok((await store.clear()).ok);
    const cleared = await store.load();
    assert.ok(cleared.ok);
    if (cleared.ok) assert.equal(cleared.value, null);
  });

  it('failNextSave 注入一次写盘失败，失败不改内存状态', async () => {
    const store = new MemoryStateStore();
    const first = sampleState();
    assert.ok((await store.save(first)).ok);

    store.failNextSave();
    const second = sampleState();
    second.seen_event_ids = ['evt-contract-2'];
    const failed = await store.save(second);
    assert.equal(failed.ok, false);
    if (!failed.ok) assert.equal(failed.error.code, 'persist_failed');

    const afterFailure = await store.load();
    assert.ok(afterFailure.ok);
    assert.deepEqual(afterFailure.value?.seen_event_ids, ['evt-contract-1']);

    // 注入只生效一次：下一次 save 成功。
    assert.ok((await store.save(second)).ok);
    const afterRetry = await store.load();
    assert.ok(afterRetry.ok);
    assert.deepEqual(afterRetry.value?.seen_event_ids, ['evt-contract-2']);
    assert.equal(store.saves, 2);
  });
});

describe('MemoryInflightJournal', () => {
  it('begin upsert / commit / clear / load 深拷贝', async () => {
    const journal = new MemoryInflightJournal();
    assert.deepEqual(await journal.load(), []);

    await journal.begin(sampleEntry('ORD-CONTRACT-1'));
    await journal.begin(sampleEntry('ORD-CONTRACT-1', 'BETA'));
    const entries = await journal.load();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].pharmacy, 'BETA');

    // 返回的是拷贝：改它不影响内部状态。
    (entries[0] as { pharmacy: string }).pharmacy = 'CORRUPTED';
    assert.equal((await journal.load())[0].pharmacy, 'BETA');

    await journal.commit('ORD-CONTRACT-1');
    assert.deepEqual(await journal.load(), []);

    await journal.begin(sampleEntry('ORD-CONTRACT-2'));
    await journal.clear();
    assert.equal(journal.size, 0);
  });
});
