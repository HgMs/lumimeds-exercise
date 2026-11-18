/**
 * `FactValidator` 单测（`ARCHITECTURE.md` §5.8 第 1–11 步、`REQUIREMENTS.md` §4.3/§4.4、
 * `DATA-CONTRACTS.md` §4.3、`WALKTHROUGHS.md` T1–T20）。
 *
 * 每条用例对应一个真实/推演场景，断言的是「哪一条规则赢」以及最终 interval 的
 * **绝对 ET ISO 值**——这是邮件流水线的安全关键路径，不测「大概能过」。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  CandidateFact,
  CandidateFactType,
  ExtractionResult,
} from '../../src/domain/email/extraction.ts';
import type { FactDraft } from '../../src/domain/facts/fact.ts';
import type { ValidationOutcome } from '../../src/domain/email/validator.ts';
import type { FactValidator } from '../../src/domain/email/validator.ts';

import { calendar, instant, makeValidator, senderOf, validator } from './email-fixtures.ts';

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 构造一条候选；默认 `pharmacy: null`（药房发件人的缺省路径）。 */
function cand(partial: Partial<CandidateFact> & { type: CandidateFactType }): CandidateFact {
  return { pharmacy: null, ...partial };
}

/** 构造抽取结果（默认 high 置信）。 */
function result(
  intent: ExtractionResult['intent'],
  facts: readonly CandidateFact[],
  confidence: ExtractionResult['confidence'] = 'high',
  notes?: string,
): ExtractionResult {
  return {
    intent,
    facts: [...facts],
    confidence,
    ...(notes === undefined ? {} : { notes }),
  };
}

/** 在指定时刻/发件人下校验（默认：周一 07:05、jen@tandrel.example）。 */
function validate(
  extraction: ExtractionResult,
  options: {
    at?: string;
    from?: string;
    instance?: FactValidator;
  } = {},
): ValidationOutcome {
  const at = instant(options.at ?? '2026-11-09T07:05:00-05:00');
  const sender = senderOf(options.from ?? 'jen@tandrel.example');
  return (options.instance ?? validator).validate(extraction, { eventId: 'evt_test', at, sender });
}

function expectApplied(outcome: ValidationOutcome): Extract<ValidationOutcome, { kind: 'applied' }> {
  if (outcome.kind !== 'applied') {
    assert.fail(
      `期望 applied，实际 ${outcome.kind}` +
        (outcome.kind === 'rejected' ? `（${outcome.code}:${outcome.detail}）` : ''),
    );
  }
  return outcome;
}

function expectRejected(
  outcome: ValidationOutcome,
): Extract<ValidationOutcome, { kind: 'rejected' }> {
  if (outcome.kind !== 'rejected') {
    assert.fail(`期望 rejected，实际 ${outcome.kind}`);
  }
  return outcome;
}

/** 一条草稿的 `[from, until]` 绝对 ISO（until null = 开放式）。 */
function intervalIso(draft: FactDraft): [string, string | null] {
  return [
    calendar.iso(draft.interval.from),
    draft.interval.until === null ? null : calendar.iso(draft.interval.until),
  ];
}

// ---------------------------------------------------------------------------
// 正常路径：week A 的 applied 邮件
// ---------------------------------------------------------------------------

describe('FactValidator：正常路径（week A applied 场景）', () => {
  it('T1/evt_001 stock_unavailable "until Wednesday" → [07:05, 11-11 00:00)', () => {
    const outcome = validate(
      result('stock', [
        cand({
          type: 'stock_unavailable',
          medication: 'tirzepatide',
          dose: '5mg',
          from_date: null,
          until_date: '2026-11-11',
          phrase: 'until Wednesday',
        }),
      ]),
    );
    const applied = expectApplied(outcome);
    assert.equal(applied.drafts.length, 1);
    const [draft] = applied.drafts;
    assert.deepEqual(draft, {
      type: 'stock_unavailable',
      pharmacy: 'TANDREL',
      interval: draft.interval,
      medication: 'tirzepatide',
      dose: '5mg',
    });
    assert.deepEqual(intervalIso(draft), ['2026-11-09T07:05:00-05:00', '2026-11-11T00:00:00-05:00']);
    assert.deepEqual(applied.sources, [{ from: 'default:occurred_at', until: 'parser:until_weekday' }]);
    assert.deepEqual(applied.dateOverrides, [
      {
        field: 'until',
        model: '2026-11-11',
        used: '2026-11-11T00:00:00-05:00',
        source: 'parser:until_weekday',
      },
    ]);
    assert.deepEqual(applied.assumptions, []);
  });

  it('T2/evt_017 更正：一封邮件两条 fact，back on Wednesday 只给 until', () => {
    const outcome = validate(
      result(
        'stock',
        [
          cand({
            type: 'stock_available',
            medication: 'tirzepatide',
            dose: '5mg',
            from_date: null,
            until_date: null,
            phrase: null,
          }),
          cand({
            type: 'stock_unavailable',
            medication: 'tirzepatide',
            dose: '7.5mg',
            from_date: null,
            until_date: '2026-11-11',
            phrase: 'back on Wednesday',
          }),
        ],
        'high',
      ),
      { at: '2026-11-09T16:00:00-05:00' },
    );
    const applied = expectApplied(outcome);
    assert.equal(applied.drafts.length, 2);
    assert.deepEqual(intervalIso(applied.drafts[0]), ['2026-11-09T16:00:00-05:00', null]);
    assert.deepEqual(intervalIso(applied.drafts[1]), ['2026-11-09T16:00:00-05:00', '2026-11-11T00:00:00-05:00']);
    assert.deepEqual(applied.sources, [
      { from: 'default:occurred_at', until: 'default:null' },
      { from: 'default:occurred_at', until: 'parser:back_on_weekday' },
    ]);
    assert.deepEqual(applied.assumptions, []);
  });

  it('T5/evt_002 state_blocked "from Wednesday" → from = 11-11 00:00，until 无限期', () => {
    const outcome = validate(
      result('coverage', [
        cand({
          type: 'state_blocked',
          states: ['Florida'],
          from_date: '2026-11-11',
          until_date: null,
          phrase: 'from Wednesday',
        }),
      ]),
      { at: '2026-11-09T07:40:00-05:00', from: 'mark@corvane.example' },
    );
    const applied = expectApplied(outcome);
    assert.deepEqual(applied.drafts, [
      {
        type: 'state_blocked',
        pharmacy: 'CORVANE',
        interval: applied.drafts[0].interval,
        state: 'FL',
      },
    ]);
    assert.deepEqual(intervalIso(applied.drafts[0]), ['2026-11-11T00:00:00-05:00', null]);
    assert.deepEqual(applied.sources, [{ from: 'parser:from_weekday', until: 'default:null' }]);
    assert.deepEqual(applied.dateOverrides, [
      {
        field: 'from',
        model: '2026-11-11',
        used: '2026-11-11T00:00:00-05:00',
        source: 'parser:from_weekday',
      },
    ]);
  });

  it('T6/evt_022 粒度不同不算冲突：模型日期 11-10、immediately 给 09:02', () => {
    const outcome = validate(
      result(
        'coverage',
        [
          cand({
            type: 'state_blocked',
            states: ['Texas'],
            from_date: '2026-11-10',
            until_date: null,
            phrase: 'effective immediately',
          }),
        ],
        'high',
        'Texas spelled out; no end date',
      ),
      { at: '2026-11-10T09:02:00-05:00', from: 'john@tandrel.example' },
    );
    const applied = expectApplied(outcome);
    assert.deepEqual(intervalIso(applied.drafts[0]), ['2026-11-10T09:02:00-05:00', null]);
    assert.deepEqual(applied.sources, [{ from: 'parser:immediately', until: 'default:null' }]);
    assert.deepEqual(applied.dateOverrides, [
      {
        field: 'from',
        model: '2026-11-10',
        used: '2026-11-10T09:02:00-05:00',
        source: 'parser:immediately',
      },
    ]);
    assert.deepEqual(applied.notes, ['Texas spelled out; no end date']);
    assert.deepEqual(applied.assumptions, [], 'state_blocked 缺 until 是普通无结束日期，不是安全侧假设');
  });

  it('T8/evt_014 closed tomorrow → [11-10 00:00, 11-11 00:00)', () => {
    const outcome = validate(
      result('closure', [
        cand({
          type: 'closed',
          from_date: '2026-11-10',
          until_date: '2026-11-11',
          phrase: 'tomorrow',
        }),
      ]),
      { at: '2026-11-09T13:00:00-05:00', from: 'hello@wrenfold.example' },
    );
    const applied = expectApplied(outcome);
    assert.deepEqual(intervalIso(applied.drafts[0]), ['2026-11-10T00:00:00-05:00', '2026-11-11T00:00:00-05:00']);
    assert.deepEqual(applied.sources, [{ from: 'parser:tomorrow', until: 'parser:tomorrow' }]);
    assert.equal(applied.dateOverrides.length, 2);
    assert.deepEqual(applied.assumptions, []);
  });

  it('T11/evt_020 capacity "until Monday"（周二收到）→ until 11-16 00:00', () => {
    const outcome = validate(
      result('capacity', [
        cand({
          type: 'capacity',
          per_day: 2,
          from_date: null,
          until_date: '2026-11-16',
          phrase: 'until Monday',
        }),
      ]),
      { at: '2026-11-10T08:00:00-05:00', from: 'mark@corvane.example' },
    );
    const applied = expectApplied(outcome);
    assert.equal(applied.drafts[0].perDay, 2);
    assert.deepEqual(intervalIso(applied.drafts[0]), ['2026-11-10T08:00:00-05:00', '2026-11-16T00:00:00-05:00']);
    assert.deepEqual(applied.sources, [{ from: 'default:occurred_at', until: 'parser:until_weekday' }]);
  });

  it('T13/evt_027 ops 复合短语 + dose/state 通配 → [11-11 00:00, 11-16 00:00)', () => {
    const outcome = validate(
      result('routing', [
        cand({
          type: 'routing_preference',
          pharmacy: 'Velmora',
          medication: 'semaglutide',
          dose: null,
          states: [],
          from_date: '2026-11-11',
          until_date: '2026-11-16',
          phrase: 'from tomorrow ... for the rest of the week',
        }),
      ]),
      { at: '2026-11-10T11:00:00-05:00', from: 'ops-lead@lumimeds.example' },
    );
    const applied = expectApplied(outcome);
    const draft = applied.drafts[0];
    assert.equal(draft.type, 'routing_preference');
    assert.equal(draft.pharmacy, 'VELMORA');
    assert.equal(draft.medication, 'semaglutide');
    assert.equal(draft.dose, undefined, 'dose 缺省 = 通配，不写进 draft');
    assert.equal(draft.state, undefined, 'states:[] = 通配，不写进 draft');
    assert.deepEqual(intervalIso(draft), ['2026-11-11T00:00:00-05:00', '2026-11-16T00:00:00-05:00']);
    assert.deepEqual(applied.sources, [{ from: 'parser:tomorrow', until: 'parser:end_of_week' }]);
    assert.equal(applied.dateOverrides.length, 2);
  });

  it('T4/evt_040 药房正文不提药房名 → 默认自己那家；until Friday 排他', () => {
    const outcome = validate(
      result('stock', [
        cand({
          type: 'stock_unavailable',
          medication: 'semaglutide',
          dose: '1mg',
          from_date: null,
          until_date: '2026-11-13',
          phrase: 'until Friday',
        }),
      ]),
      { at: '2026-11-11T10:00:00-05:00', from: 'ops@velmora.example' },
    );
    const applied = expectApplied(outcome);
    assert.equal(applied.drafts[0].pharmacy, 'VELMORA', 'role=pharmacy，local-part 叫 ops 也不算 ops');
    assert.deepEqual(intervalIso(applied.drafts[0]), ['2026-11-11T10:00:00-05:00', '2026-11-13T00:00:00-05:00']);
  });

  it('ops 也可以断言别家药房的事实（矩阵第一行）', () => {
    const outcome = validate(
      result('stock', [
        cand({
          type: 'stock_available',
          pharmacy: 'Tandrel Rx',
          medication: 'tirzepatide',
          dose: '2.5mg',
          phrase: null,
        }),
      ]),
      { from: 'sam@lumimeds.example' },
    );
    const applied = expectApplied(outcome);
    assert.equal(applied.drafts[0].pharmacy, 'TANDREL');
  });
});

// ---------------------------------------------------------------------------
// 第 1–4 步：身份门 / unrelated / unclear / no_change
// ---------------------------------------------------------------------------

describe('FactValidator：身份门与 no_change（第 1–4 步）', () => {
  it('未知发件人 + unrelated → 仍然 rejected unknown_sender（T17，身份门先于短路）', () => {
    const outcome = validate(result('unrelated', []), { from: 'someone@example.com' });
    const rejected = expectRejected(outcome);
    assert.equal(rejected.code, 'unknown_sender');
    assert.equal(rejected.detail, 'someone@example.com');
  });

  it('未知发件人 + 合法 fact → unknown_sender', () => {
    const outcome = validate(
      result('stock', [
        cand({ type: 'stock_available', medication: 'tirzepatide', dose: '5mg', phrase: null }),
      ]),
      { from: 'someone@example.com' },
    );
    assert.equal(expectRejected(outcome).code, 'unknown_sender');
  });

  it('已知发件人 + unrelated → no_change（不进 Sam）', () => {
    const outcome = validate(result('unrelated', []));
    assert.deepEqual(outcome, { kind: 'no_change', reason: 'unrelated' });
  });

  it('整封都是 no_change → no_change(no_change_candidates)', () => {
    const outcome = validate(result('stock', [cand({ type: 'no_change' })]));
    assert.deepEqual(outcome, { kind: 'no_change', reason: 'no_change_candidates' });
  });

  it('no_change 与其它候选混排 → 丢弃 no_change，只校验真正的候选', () => {
    const outcome = validate(
      result('stock', [
        cand({ type: 'no_change' }),
        cand({ type: 'stock_available', medication: 'tirzepatide', dose: '5mg', phrase: null }),
      ]),
    );
    const applied = expectApplied(outcome);
    assert.equal(applied.drafts.length, 1);
    assert.equal(applied.drafts[0].type, 'stock_available');
  });

  it('unclear → rejected missing_field_for_type', () => {
    const outcome = validate(result('unclear', []));
    const rejected = expectRejected(outcome);
    assert.equal(rejected.code, 'missing_field_for_type');
    assert.equal(rejected.detail, 'intent:unclear');
  });

  it('facts 为空（intent 不是 unrelated）→ rejected missing_field_for_type', () => {
    const outcome = validate(result('stock', []));
    assert.equal(expectRejected(outcome).detail, 'facts:empty');
  });
});

// ---------------------------------------------------------------------------
// 第 5–8 步：药房缺省、必填/禁止、权限、值域
// ---------------------------------------------------------------------------

describe('FactValidator：药房缺省与解析', () => {
  it('药房发件人可以省略 pharmacy；ops 必须显式写（T15）', () => {
    const stockFact = cand({ type: 'stock_available', medication: 'tirzepatide', dose: '5mg', phrase: null });

    const pharmacySender = expectApplied(validate(result('stock', [stockFact])));
    assert.equal(pharmacySender.drafts[0].pharmacy, 'TANDREL');

    const opsSender = expectRejected(
      validate(result('stock', [stockFact]), { from: 'sam@lumimeds.example' }),
    );
    assert.equal(opsSender.code, 'missing_field_for_type');
    assert.equal(opsSender.detail, 'pharmacy');
    assert.equal(opsSender.offendingIndex, 0);
  });

  it('解析不到的 pharmacy → unknown_pharmacy，offendingIndex 指向原候选', () => {
    // 第 5 步按候选顺序遍历：第 0 条是 ops 缺 pharmacy → 先报 missing，而不是后面那条解析失败。
    const firstMissing = expectRejected(
      validate(
        result('stock', [
          cand({ type: 'stock_available', medication: 'tirzepatide', dose: '5mg', phrase: null }),
          cand({
            type: 'stock_available',
            pharmacy: 'Nowhere Pharmacy',
            medication: 'tirzepatide',
            dose: '5mg',
            phrase: null,
          }),
        ]),
        { from: 'sam@lumimeds.example' },
      ),
    );
    assert.equal(firstMissing.code, 'missing_field_for_type');
    assert.equal(firstMissing.detail, 'pharmacy');
    assert.equal(firstMissing.offendingIndex, 0);

    const unknown = expectRejected(
      validate(
        result('stock', [
          cand({
            type: 'stock_available',
            pharmacy: 'Nowhere Pharmacy',
            medication: 'tirzepatide',
            dose: '5mg',
            phrase: null,
          }),
        ]),
        { from: 'sam@lumimeds.example' },
      ),
    );
    assert.equal(unknown.code, 'unknown_pharmacy');
    assert.equal(unknown.detail, 'Nowhere Pharmacy');
    assert.equal(unknown.offendingIndex, 0);
  });

  it('药房显式写自家 id/name 都允许（解析后与发件人一致）', () => {
    for (const pharmacy of ['TANDREL', 'Tandrel Rx', ' tandrel  rx ']) {
      const applied = expectApplied(
        validate(
          result('stock', [
            cand({ type: 'stock_available', pharmacy, medication: 'tirzepatide', dose: '5mg', phrase: null }),
          ]),
        ),
      );
      assert.equal(applied.drafts[0].pharmacy, 'TANDREL', pharmacy);
    }
  });
});

describe('FactValidator：逐类必填字段与禁止字段（第 6 步）', () => {
  it('stock_unavailable 缺 dose → missing_field_for_type', () => {
    const rejected = expectRejected(
      validate(result('stock', [cand({ type: 'stock_unavailable', medication: 'tirzepatide', phrase: null })])),
    );
    assert.equal(rejected.code, 'missing_field_for_type');
    assert.equal(rejected.detail, 'stock_unavailable.dose');
  });

  it('需要 states 的类型：没给 → missing；给了空数组 → bad_request（R4-4）', () => {
    const missing = expectRejected(
      validate(result('coverage', [cand({ type: 'state_blocked', phrase: null })])),
    );
    assert.equal(missing.code, 'missing_field_for_type');
    assert.equal(missing.detail, 'state_blocked.states');

    const empty = expectRejected(
      validate(result('coverage', [cand({ type: 'state_blocked', states: [], phrase: null })])),
    );
    assert.equal(empty.code, 'bad_request');
    assert.equal(empty.detail, 'state_blocked.states');
  });

  it('capacity 的 per_day：缺 → missing；负数/小数 → bad_request；0 合法（T12）', () => {
    const missing = expectRejected(validate(result('capacity', [cand({ type: 'capacity', phrase: null })])));
    assert.equal(missing.code, 'missing_field_for_type');
    assert.equal(missing.detail, 'capacity.per_day');

    for (const perDay of [-1, 2.5]) {
      const rejected = expectRejected(
        validate(result('capacity', [cand({ type: 'capacity', per_day: perDay, phrase: null })])),
      );
      assert.equal(rejected.code, 'bad_request', String(perDay));
      assert.equal(rejected.detail, 'capacity.per_day');
    }

    const zero = expectApplied(
      validate(result('capacity', [cand({ type: 'capacity', per_day: 0, phrase: null })])),
    );
    assert.equal(zero.drafts[0].perDay, 0);
  });

  it('reopened 必须显式给出 from（缺 → missing_field_for_type）', () => {
    const rejected = expectRejected(
      validate(result('closure', [cand({ type: 'reopened', from_date: null, phrase: null })])),
    );
    assert.equal(rejected.code, 'missing_field_for_type');
    assert.equal(rejected.detail, 'reopened.from');

    // 短语解析器给出的 from 也算「显式」。
    const applied = expectApplied(
      validate(result('closure', [cand({ type: 'reopened', from_date: null, phrase: 'tomorrow' })])),
    );
    assert.deepEqual(intervalIso(applied.drafts[0]), ['2026-11-10T00:00:00-05:00', '2026-11-11T00:00:00-05:00']);
  });

  it('禁止字段：stock + states / stock + per_day / closed + medication / state + dose / routing + per_day', () => {
    const cases: CandidateFact[] = [
      cand({ type: 'stock_available', medication: 'tirzepatide', dose: '5mg', states: ['TX'], phrase: null }),
      cand({ type: 'stock_available', medication: 'tirzepatide', dose: '5mg', per_day: 3, phrase: null }),
      cand({ type: 'closed', medication: 'tirzepatide', phrase: null }),
      cand({ type: 'state_blocked', states: ['TX'], dose: '5mg', phrase: null }),
      cand({ type: 'routing_preference', pharmacy: 'TANDREL', medication: 'semaglutide', per_day: 3, phrase: null }),
    ];
    for (const candidate of cases) {
      const rejected = expectRejected(validate(result('stock', [candidate])));
      assert.equal(rejected.code, 'bad_request', JSON.stringify(candidate));
    }
  });

  it('空数组/空串不算「出现禁止字段」（模型总带 states:[] 不应误伤）', () => {
    const applied = expectApplied(
      validate(
        result('stock', [
          cand({
            type: 'stock_available',
            medication: 'tirzepatide',
            dose: '5mg',
            states: [],
            from_date: null,
            until_date: null,
            phrase: null,
          }),
        ]),
      ),
    );
    assert.equal(applied.drafts.length, 1);
  });

  it('未知 type → bad_request（运行时防御，模型 schema 之外的兜底）', () => {
    const rejected = expectRejected(
      validate(result('stock', [cand({ type: 'weather' as unknown as CandidateFactType, phrase: null })])),
    );
    assert.equal(rejected.code, 'bad_request');
    assert.equal(rejected.detail, 'type:weather');
  });
});

describe('FactValidator：权限在剂量/州校验之前（第 7 步）', () => {
  it('跨药房断言 → cross_pharmacy（T19）', () => {
    const rejected = expectRejected(
      validate(
        result('stock', [
          cand({
            type: 'stock_unavailable',
            pharmacy: 'Velmora',
            medication: 'semaglutide',
            dose: '1mg',
            phrase: null,
          }),
        ]),
      ),
    );
    assert.equal(rejected.code, 'cross_pharmacy');
  });

  it('药房发来的 routing_preference → routing_requires_ops（T14 提示注入的最坏情况）', () => {
    const rejected = expectRejected(
      validate(
        result('routing', [
          cand({
            type: 'routing_preference',
            pharmacy: 'Ishby',
            medication: 'tirzepatide',
            phrase: 'immediately',
          }),
        ]),
        { from: 'orders@ishby.example' },
      ),
    );
    assert.equal(rejected.code, 'routing_requires_ops');
  });

  it('权限先于值域：跨药房 + 25mg → 报 cross_pharmacy，而不是 unknown_dose', () => {
    const rejected = expectRejected(
      validate(
        result('stock', [
          cand({
            type: 'stock_unavailable',
            pharmacy: 'Velmora',
            medication: 'tirzepatide',
            dose: '25mg',
            phrase: null,
          }),
        ]),
      ),
    );
    assert.equal(rejected.code, 'cross_pharmacy');
  });
});

describe('FactValidator：值域（第 8 步）', () => {
  it('不存在的剂量 25mg → unknown_dose（T3）；整封不生效', () => {
    const rejected = expectRejected(
      validate(
        result('stock', [
          cand({ type: 'stock_available', medication: 'tirzepatide', dose: '25mg', phrase: null }),
        ]),
        { from: 'orders@ishby.example' },
      ),
    );
    assert.equal(rejected.code, 'unknown_dose');
    assert.equal(rejected.detail, '25mg');
  });

  it('不补单位：dose "7.5" → unknown_dose', () => {
    const rejected = expectRejected(
      validate(
        result('stock', [
          cand({ type: 'stock_available', medication: 'tirzepatide', dose: '7.5', phrase: null }),
        ]),
      ),
    );
    assert.equal(rejected.code, 'unknown_dose');
  });

  it('剂量必须属于该药品：tirzepatide 给 1mg → unknown_dose', () => {
    const rejected = expectRejected(
      validate(
        result('stock', [
          cand({ type: 'stock_available', medication: 'tirzepatide', dose: '1mg', phrase: null }),
        ]),
      ),
    );
    assert.equal(rejected.code, 'unknown_dose');
  });

  it('未知药品 → unknown_medication；别名 tirz/sema 仍被接受', () => {
    const unknown = expectRejected(
      validate(
        result('stock', [
          cand({ type: 'stock_available', medication: 'ozempic', dose: '1mg', phrase: null }),
        ]),
      ),
    );
    assert.equal(unknown.code, 'unknown_medication');

    const alias = expectApplied(
      validate(
        result('stock', [
          cand({ type: 'stock_available', medication: 'tirz', dose: '5mg', phrase: null }),
          cand({ type: 'stock_available', medication: 'Sema', dose: '1mg', phrase: null }),
        ]),
      ),
    );
    assert.equal(alias.drafts[0].medication, 'tirzepatide');
    assert.equal(alias.drafts[1].medication, 'semaglutide');
  });

  it('无法归一化的州 → unknown_state', () => {
    const rejected = expectRejected(
      validate(result('coverage', [cand({ type: 'state_blocked', states: ['Ontario'], phrase: null })])),
    );
    assert.equal(rejected.code, 'unknown_state');
    assert.equal(rejected.detail, 'Ontario');
  });

  it('多州候选扇出成多条 fact（每州一条）', () => {
    const applied = expectApplied(
      validate(
        result('coverage', [
          cand({ type: 'state_blocked', states: ['Texas', 'Florida'], phrase: null }),
        ]),
      ),
    );
    assert.deepEqual(
      applied.drafts.map((draft) => draft.state),
      ['TX', 'FL'],
    );
    assert.deepEqual(applied.sources, [
      { from: 'default:occurred_at', until: 'default:null' },
      { from: 'default:occurred_at', until: 'default:null' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 第 9 步：时间合并 / 冲突 / 窗口 / 无限期 / W13
// ---------------------------------------------------------------------------

describe('FactValidator：时间（第 9 步）', () => {
  it('解析器与模型日期冲突（from）→ bad_interval', () => {
    const rejected = expectRejected(
      validate(
        result('stock', [
          cand({
            type: 'stock_available',
            medication: 'tirzepatide',
            dose: '5mg',
            from_date: '2026-11-12',
            phrase: 'tomorrow',
          }),
        ]),
      ),
    );
    assert.equal(rejected.code, 'bad_interval');
    assert.match(rejected.detail, /^from:model=2026-11-12,phrase=2026-11-10$/);
  });

  it('解析器与模型日期冲突（until）→ bad_interval（evt_020 变体）', () => {
    const rejected = expectRejected(
      validate(
        result('capacity', [
          cand({
            type: 'capacity',
            per_day: 2,
            until_date: '2026-11-14',
            phrase: 'until Friday',
          }),
        ]),
        { at: '2026-11-11T10:00:00-05:00', from: 'ops@velmora.example' },
      ),
    );
    assert.equal(rejected.code, 'bad_interval');
    assert.match(rejected.detail, /^until:model=2026-11-14,phrase=2026-11-13$/);
  });

  it('窗口是闭区间：until 恰好 = 第 15 天 00:00 接受；晚一天拒绝', () => {
    const boundary = expectApplied(
      validate(
        result('stock', [
          cand({
            type: 'stock_available',
            medication: 'tirzepatide',
            dose: '5mg',
            until_date: '2026-11-23',
            phrase: null,
          }),
        ]),
      ),
    );
    assert.deepEqual(intervalIso(boundary.drafts[0])[1], '2026-11-23T00:00:00-05:00');

    const beyond = expectRejected(
      validate(
        result('stock', [
          cand({
            type: 'stock_available',
            medication: 'tirzepatide',
            dose: '5mg',
            until_date: '2026-11-24',
            phrase: null,
          }),
        ]),
      ),
    );
    assert.equal(beyond.code, 'interval_out_of_window');
    assert.equal(beyond.detail, 'until:2026-11-24');
  });

  it('早于窗口起点的 from → interval_out_of_window', () => {
    const rejected = expectRejected(
      validate(
        result('stock', [
          cand({
            type: 'stock_available',
            medication: 'tirzepatide',
            dose: '5mg',
            from_date: '2026-11-08',
            phrase: null,
          }),
        ]),
      ),
    );
    assert.equal(rejected.code, 'interval_out_of_window');
    assert.equal(rejected.detail, 'from:2026-11-08');
  });

  it('W13：周一收到 "until Monday" → 改取下一个周一，并记 assumption', () => {
    const applied = expectApplied(
      validate(
        result('stock', [
          cand({
            type: 'stock_unavailable',
            medication: 'tirzepatide',
            dose: '5mg',
            from_date: null,
            until_date: '2026-11-09',
            phrase: 'until Monday',
          }),
        ]),
      ),
    );
    assert.deepEqual(intervalIso(applied.drafts[0]), ['2026-11-09T07:05:00-05:00', '2026-11-16T00:00:00-05:00']);
    assert.deepEqual(applied.assumptions, ['until <= from → used next weekday']);
    assert.deepEqual(applied.sources, [{ from: 'default:occurred_at', until: 'default:next_weekday' }]);
    assert.deepEqual(applied.dateOverrides, [
      {
        field: 'until',
        model: '2026-11-09',
        used: '2026-11-16T00:00:00-05:00',
        source: 'default:next_weekday',
      },
    ]);
  });

  it('W13 另一形态：周三收到 "back on Wednesday" → 改取下一个周三', () => {
    const applied = expectApplied(
      validate(
        result('stock', [
          cand({
            type: 'stock_unavailable',
            medication: 'tirzepatide',
            dose: '5mg',
            from_date: null,
            until_date: '2026-11-11',
            phrase: 'back on Wednesday',
          }),
        ]),
        { at: '2026-11-11T09:00:00-05:00' },
      ),
    );
    assert.deepEqual(intervalIso(applied.drafts[0]), ['2026-11-11T09:00:00-05:00', '2026-11-18T00:00:00-05:00']);
    assert.deepEqual(applied.assumptions, ['until <= from → used next weekday']);
    assert.deepEqual(applied.sources, [{ from: 'default:occurred_at', until: 'default:next_weekday' }]);
  });

  it('until <= from 且不是星期类子句 → bad_interval（不做「猜下一个」）', () => {
    const rejected = expectRejected(
      validate(
        result('stock', [
          cand({
            type: 'stock_available',
            medication: 'tirzepatide',
            dose: '5mg',
            from_date: '2026-11-12',
            until_date: '2026-11-11',
            phrase: null,
          }),
        ]),
      ),
    );
    assert.equal(rejected.code, 'bad_interval');
    assert.equal(rejected.detail, 'until<=from');
  });

  it('缺 until 的否定类事实按无限期处理并记 assumptions；肯定类不记', () => {
    const unavailable = expectApplied(
      validate(
        result('stock', [
          cand({ type: 'stock_unavailable', medication: 'tirzepatide', dose: '5mg', phrase: null }),
        ]),
      ),
    );
    assert.equal(unavailable.drafts[0].interval.until, null);
    assert.deepEqual(unavailable.assumptions, ['stock_unavailable without until → indefinite']);

    const closed = expectApplied(
      validate(result('closure', [cand({ type: 'closed', phrase: null })])),
    );
    assert.deepEqual(closed.assumptions, ['closed without until → indefinite']);

    const available = expectApplied(
      validate(
        result('stock', [
          cand({ type: 'stock_available', medication: 'tirzepatide', dose: '5mg', phrase: null }),
        ]),
      ),
    );
    assert.deepEqual(available.assumptions, [], '肯定类事实缺 until 是普通开放式，不是安全侧假设');
  });

  it('模型日期非法 → bad_request（走 etDate 校验，不猜）', () => {
    for (const fromDate of ['2026-02-30', '11/09/2026', 'tomorrow']) {
      const rejected = expectRejected(
        validate(
          result('stock', [
            cand({
              type: 'stock_available',
              medication: 'tirzepatide',
              dose: '5mg',
              from_date: fromDate,
              phrase: null,
            }),
          ]),
        ),
      );
      assert.equal(rejected.code, 'bad_request', fromDate);
      assert.match(rejected.detail, /^from_date:/);
    }
  });

  it('空串日期按缺省处理（from 默认 at）', () => {
    const applied = expectApplied(
      validate(
        result('stock', [
          cand({
            type: 'stock_available',
            medication: 'tirzepatide',
            dose: '5mg',
            from_date: '',
            until_date: '',
            phrase: null,
          }),
        ]),
      ),
    );
    assert.deepEqual(intervalIso(applied.drafts[0]), ['2026-11-09T07:05:00-05:00', null]);
  });

  it('低置信：无短语 → 拒绝；短语命中且与模型日期不冲突 → 允许', () => {
    const lowNoPhrase = expectRejected(
      validate(
        result(
          'stock',
          [cand({ type: 'stock_available', medication: 'tirzepatide', dose: '5mg', phrase: null })],
          'low',
        ),
      ),
    );
    assert.equal(lowNoPhrase.code, 'bad_request');
    assert.equal(lowNoPhrase.detail, 'low_confidence_without_phrase');

    const lowWithPhrase = expectApplied(
      validate(
        result(
          'stock',
          [
            cand({
              type: 'stock_available',
              medication: 'tirzepatide',
              dose: '5mg',
              from_date: '2026-11-10',
              until_date: '2026-11-11',
              phrase: 'tomorrow',
            }),
          ],
          'low',
        ),
      ),
    );
    assert.deepEqual(intervalIso(lowWithPhrase.drafts[0]), [
      '2026-11-10T00:00:00-05:00',
      '2026-11-11T00:00:00-05:00',
    ]);
  });

  it('中置信 + 模型日期且无短语 → bad_request（只有 high 才采信模型日期）', () => {
    const rejected = expectRejected(
      validate(
        result(
          'stock',
          [
            cand({
              type: 'stock_available',
              medication: 'tirzepatide',
              dose: '5mg',
              until_date: '2026-11-13',
              phrase: null,
            }),
          ],
          'medium',
        ),
      ),
    );
    assert.equal(rejected.code, 'bad_request');
    assert.equal(rejected.detail, 'unverified_model_date');
  });
});

// ---------------------------------------------------------------------------
// 第 10 步：原子性
// ---------------------------------------------------------------------------

describe('FactValidator：整封原子（第 10 步）', () => {
  it('T20：一条合法 + 一条 25mg → 整封 rejected，第一条也不生效', () => {
    const outcome = validate(
      result('stock', [
        cand({
          type: 'stock_unavailable',
          pharmacy: null,
          medication: 'semaglutide',
          dose: '1mg',
          from_date: null,
          until_date: '2026-11-13',
          phrase: 'until Friday',
        }),
        cand({
          type: 'stock_unavailable',
          pharmacy: null,
          medication: 'semaglutide',
          dose: '25mg',
          from_date: null,
          until_date: '2026-11-13',
          phrase: 'until Friday',
        }),
      ]),
      { at: '2026-11-11T10:00:00-05:00', from: 'ops@velmora.example' },
    );
    const rejected = expectRejected(outcome);
    assert.equal(rejected.code, 'unknown_dose');
    assert.equal(rejected.detail, '25mg');
    assert.equal(rejected.offendingIndex, 1, 'Sam 要能点名第 2 条候选');
  });

  it('validate 是纯函数：不修改抽取结果，两次调用结论一致', () => {
    const extraction = result('stock', [
      cand({
        type: 'stock_unavailable',
        medication: 'tirzepatide',
        dose: '5mg',
        until_date: '2026-11-11',
        phrase: 'until Wednesday',
      }),
    ]);
    const snapshot = JSON.stringify(extraction);
    const first = validate(extraction);
    const second = validate(extraction);
    assert.equal(JSON.stringify(extraction), snapshot, '不得修改传入的抽取结果');
    assert.deepEqual(first, second);
    // 两次返回的 drafts 不应共享可变状态（A4 会往 FactStore 里 append）。
    assert.notEqual(
      expectApplied(first).drafts[0].interval,
      expectApplied(second).drafts[0].interval,
    );
  });

  it('offendingIndex 指向原始 facts 数组（no_change 占位不导致错位）', () => {
    const rejected = expectRejected(
      validate(
        result('stock', [
          cand({ type: 'no_change' }),
          cand({ type: 'stock_available', medication: 'tirzepatide', dose: '5mg', phrase: null }),
          cand({ type: 'stock_available', medication: 'tirzepatide', dose: '25mg', phrase: null }),
        ]),
      ),
    );
    assert.equal(rejected.code, 'unknown_dose');
    assert.equal(rejected.offendingIndex, 2);
  });
});
