/**
 * `CapacityLedger` 单测（`ARCHITECTURE.md` §5.6、`REQUIREMENTS.md` §3.3）。
 *
 * 覆盖：
 * - 键是 `(药房, ET 日)`：同一 ET 日累加、跨 ET 日（本地午夜）重置、跨药房互不影响；
 * - `rebuild` 从 `sent_orders` 派生、**内部跳过 MANUAL**（INV-6）、与手工 `record` 一致；
 * - `snapshot()` 顺序确定、可序列化（D4：ledger 本身不进快照，恢复时重新派生）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EtCalendar } from '../../src/kernel/time/et-calendar.ts';
import type { EtDate } from '../../src/kernel/time/et-date.ts';
import { Instant } from '../../src/kernel/time/instant.ts';
import {
  CapacityLedger,
  type SentOrderCapacityEntry,
} from '../../src/domain/capacity/capacity-ledger.ts';

const calendar = new EtCalendar();

function instant(iso: string): Instant {
  const parsed = Instant.parse(iso);
  if (!parsed.ok) throw new Error(`测试夹具：非法时间 ${iso}`);
  return parsed.value;
}

function dateOf(iso: string): EtDate {
  return calendar.dateOf(instant(iso));
}

const MON_2300 = '2026-11-09T23:00:00-05:00';
const TUE_0000 = '2026-11-10T00:00:00-05:00';
const TUE_0900 = '2026-11-10T09:00:00-05:00';

describe('CapacityLedger：计数', () => {
  it('未记录时 used = 0（不是 undefined）', () => {
    const ledger = new CapacityLedger();
    assert.equal(ledger.used('ALPHA', dateOf(MON_2300)), 0);
    assert.deepEqual(ledger.snapshot(), []);
  });

  it('record 累加；同一 ET 日多单只增当前药房', () => {
    const ledger = new CapacityLedger();
    const monday = dateOf(MON_2300);
    ledger.record('ALPHA', monday);
    ledger.record('ALPHA', monday);
    ledger.record('ALPHA', monday);
    assert.equal(ledger.used('ALPHA', monday), 3);
    assert.equal(ledger.used('BETA', monday), 0);
    assert.deepEqual(ledger.snapshot(), [{ pharmacy: 'ALPHA', date: monday, count: 3 }]);
  });

  it('跨 ET 自然日重置（本地午夜）：23:00 与次日 00:00 是两个桶', () => {
    const ledger = new CapacityLedger();
    const monday = dateOf(MON_2300);
    const tuesday = dateOf(TUE_0000);
    assert.notEqual(monday, tuesday);

    ledger.record('ALPHA', monday);
    ledger.record('ALPHA', tuesday);
    ledger.record('ALPHA', tuesday);
    assert.equal(ledger.used('ALPHA', monday), 1);
    assert.equal(ledger.used('ALPHA', tuesday), 2);
  });

  it('DST 边界日按 ET 日期分桶（11-01 冬令时开始、03-08 春令时开始）', () => {
    const ledger = new CapacityLedger();
    // 2026-11-01：02:00 EDT 回拨到 01:00 EST；当晚 23:30 已是 -05:00。
    assert.equal(dateOf('2026-11-01T23:30:00-05:00'), '2026-11-01');
    // 2026-03-08：02:00 EST 跳到 03:00 EDT；当天 23:30 是 -04:00。
    assert.equal(dateOf('2026-03-08T23:30:00-04:00'), '2026-03-08');

    ledger.record('ALPHA', dateOf('2026-11-01T00:30:00-04:00'));
    ledger.record('ALPHA', dateOf('2026-11-01T23:30:00-05:00'));
    assert.equal(ledger.used('ALPHA', dateOf('2026-11-01T12:00:00-05:00')), 2);
  });

  it('snapshot 按 pharmacy|date 排序，同一份账本两次输出相同', () => {
    const ledger = new CapacityLedger();
    ledger.record('BETA', dateOf(TUE_0900));
    ledger.record('ALPHA', dateOf(TUE_0900));
    ledger.record('ALPHA', dateOf(MON_2300));

    const expected = [
      { pharmacy: 'ALPHA', date: '2026-11-09', count: 1 },
      { pharmacy: 'ALPHA', date: '2026-11-10', count: 1 },
      { pharmacy: 'BETA', date: '2026-11-10', count: 1 },
    ];
    assert.deepEqual(ledger.snapshot(), expected);
    assert.deepEqual(ledger.snapshot(), ledger.snapshot());
    // 可序列化（D4：不落盘，但形状必须干净）。
    assert.deepEqual(JSON.parse(JSON.stringify(ledger.snapshot())), expected);
  });
});

describe('CapacityLedger.rebuild：从 sent_orders 派生', () => {
  const entries: SentOrderCapacityEntry[] = [
    { pharmacy: 'ALPHA', at: instant(MON_2300) },
    { pharmacy: 'ALPHA', at: instant(MON_2300) },
    { pharmacy: 'ALPHA', at: instant(TUE_0900) },
    { pharmacy: 'BETA', at: instant(TUE_0000) },
    { pharmacy: 'ALPHA', at: instant(TUE_0900) },
  ];

  it('rebuild 后的 used 与逐条 record 相同（ET 日由 calendar.dateOf 得出）', () => {
    const rebuilt = CapacityLedger.rebuild(entries, calendar);
    assert.equal(rebuilt.used('ALPHA', dateOf(MON_2300)), 2);
    assert.equal(rebuilt.used('ALPHA', dateOf(TUE_0900)), 2);
    assert.equal(rebuilt.used('BETA', dateOf(TUE_0000)), 1);

    const manual = new CapacityLedger();
    for (const entry of entries) {
      manual.record(entry.pharmacy, calendar.dateOf(entry.at));
    }
    assert.deepEqual(rebuilt.snapshot(), manual.snapshot());
  });

  it('rebuild 内部跳过 MANUAL（INV-6：MANUAL 不占任何药房的容量）', () => {
    const withManual: SentOrderCapacityEntry[] = [
      ...entries,
      { pharmacy: 'MANUAL', at: instant(MON_2300) },
      { pharmacy: 'MANUAL', at: instant(TUE_0900) },
    ];
    const rebuilt = CapacityLedger.rebuild(withManual, calendar);
    const withoutManual = CapacityLedger.rebuild(entries, calendar);
    assert.deepEqual(rebuilt.snapshot(), withoutManual.snapshot());
    assert.equal(
      rebuilt.snapshot().some((entry) => entry.pharmacy === 'MANUAL'),
      false,
    );
    // 也没有把 MANUAL 混进任何真实药房的计数。
    assert.equal(rebuilt.used('ALPHA', dateOf(MON_2300)), 2);
    assert.equal(rebuilt.used('ALPHA', dateOf(TUE_0900)), 2);
  });

  it('空输入 → 空账本；rebuild 后仍可继续 record', () => {
    const rebuilt = CapacityLedger.rebuild([], calendar);
    assert.deepEqual(rebuilt.snapshot(), []);
    rebuilt.record('ALPHA', dateOf(TUE_0900));
    assert.equal(rebuilt.used('ALPHA', dateOf(TUE_0900)), 1);
  });

  it('rebuild 可接受任意 Iterable（不要求是数组）', () => {
    function* generate(): Generator<SentOrderCapacityEntry> {
      yield { pharmacy: 'ALPHA', at: instant(MON_2300) };
      yield { pharmacy: 'BETA', at: instant(MON_2300) };
    }
    const rebuilt = CapacityLedger.rebuild(generate(), calendar);
    assert.deepEqual(rebuilt.snapshot(), [
      { pharmacy: 'ALPHA', date: '2026-11-09', count: 1 },
      { pharmacy: 'BETA', date: '2026-11-09', count: 1 },
    ]);
  });
});
