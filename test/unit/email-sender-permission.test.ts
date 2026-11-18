/**
 * `SenderResolver` + `PermissionPolicy` 单测（`ARCHITECTURE.md` §5.8「身份与权限」、
 * `REQUIREMENTS.md` §4.1、`WALKTHROUGHS.md` T4/T14/T17）。
 *
 * 权限矩阵是安全边界：模型返回什么都不能改变这里。覆盖矩阵四格 + 角色只由地址集合
 * 决定（W7：`ops@velmora.example` 是药房，不是 ops）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CandidateFact } from '../../src/domain/email/extraction.ts';
import { SenderResolver } from '../../src/domain/email/sender.ts';

import { OPS, permission, registry, resolver, senderOf } from './email-fixtures.ts';

/** 一条最小的 stock 候选（权限只关心 type 与 pharmacy）。 */
function stockCandidate(pharmacy: string | null): CandidateFact {
  return {
    type: 'stock_unavailable',
    pharmacy,
    medication: 'tirzepatide',
    dose: '5mg',
    from_date: null,
    until_date: null,
    phrase: null,
  };
}

function routingCandidate(pharmacy: string | null): CandidateFact {
  return {
    type: 'routing_preference',
    pharmacy,
    medication: 'semaglutide',
    from_date: null,
    until_date: null,
    phrase: null,
  };
}

// ---------------------------------------------------------------------------
// SenderResolver
// ---------------------------------------------------------------------------

describe('SenderResolver（地址解析与角色）', () => {
  it('"Jen <jen@x>" → 小写地址 + 显示名 + 药房角色', () => {
    assert.deepEqual(senderOf('Jen <jen@tandrel.example>'), {
      address: 'jen@tandrel.example',
      display: 'Jen',
      role: 'pharmacy',
      pharmacy: 'TANDREL',
    });
  });

  it('裸地址 → display 为 null；大小写与首尾空白不敏感', () => {
    assert.deepEqual(senderOf('  JEN@TANDREL.EXAMPLE  '), {
      address: 'jen@tandrel.example',
      display: null,
      role: 'pharmacy',
      pharmacy: 'TANDREL',
    });
    assert.deepEqual(senderOf('<john@tandrel.example>'), {
      address: 'john@tandrel.example',
      display: null,
      role: 'pharmacy',
      pharmacy: 'TANDREL',
    });
  });

  it('ops 只看地址集合：`ops@velmora.example` 是药房（W7）', () => {
    assert.deepEqual(senderOf('ops@velmora.example'), {
      address: 'ops@velmora.example',
      display: null,
      role: 'pharmacy',
      pharmacy: 'VELMORA',
    });
    assert.deepEqual(senderOf('ops-lead@lumimeds.example'), {
      address: 'ops-lead@lumimeds.example',
      display: null,
      role: 'ops',
    });
  });

  it('显示名带引号 / 多个收件人 / 未知地址 / 空串都不抛异常', () => {
    assert.equal(senderOf('"Jen Smith" <jen@tandrel.example>').display, 'Jen Smith');
    assert.deepEqual(senderOf('jen@tandrel.example, bob@elsewhere.example'), {
      address: 'jen@tandrel.example',
      display: null,
      role: 'pharmacy',
      pharmacy: 'TANDREL',
    });
    assert.deepEqual(senderOf('someone@example.com'), {
      address: 'someone@example.com',
      display: null,
      role: 'unknown',
    });
    assert.deepEqual(senderOf('not-an-email'), {
      address: 'not-an-email',
      display: null,
      role: 'unknown',
    });
    assert.deepEqual(senderOf(''), { address: '', display: null, role: 'unknown' });
  });

  it('构造时规范化 ops 集合（大小写/空白）', () => {
    const custom = new SenderResolver(['  SAM@Lumimeds.Example '], registry);
    assert.equal(custom.resolve('sam@lumimeds.example').role, 'ops');
    assert.equal(custom.resolve('ops@velmora.example').role, 'pharmacy');
  });

  it('没有 ops 集合时，所有地址都按药房联系人解析', () => {
    const noOps = new SenderResolver([], registry);
    assert.equal(noOps.resolve('sam@lumimeds.example').role, 'unknown');
    assert.equal(noOps.resolve('jen@tandrel.example').role, 'pharmacy');
    assert.equal(OPS.length, 2);
    assert.equal(resolver.resolve('jen@tandrel.example').role, 'pharmacy');
  });
});

// ---------------------------------------------------------------------------
// PermissionPolicy：权限矩阵
// ---------------------------------------------------------------------------

describe('PermissionPolicy（权限矩阵）', () => {
  const ops = senderOf('sam@lumimeds.example');
  const pharmacy = senderOf('jen@tandrel.example');
  const otherPharmacy = senderOf('mark@corvane.example');
  const unknown = senderOf('someone@example.com');

  it('ops × 自家/别家/routing → 全部允许', () => {
    assert.deepEqual(permission.canAssert(ops, stockCandidate(null)), { allowed: true });
    assert.deepEqual(permission.canAssert(ops, stockCandidate('Velmora')), { allowed: true });
    assert.deepEqual(permission.canAssert(ops, routingCandidate('Corvane Compounding')), {
      allowed: true,
    });
  });

  it('药房 × 自家事实 → 允许（显式 null 与显式 id/name 都算自家）', () => {
    assert.deepEqual(permission.canAssert(pharmacy, stockCandidate(null)), { allowed: true });
    assert.deepEqual(permission.canAssert(pharmacy, stockCandidate('TANDREL')), { allowed: true });
    assert.deepEqual(permission.canAssert(pharmacy, stockCandidate('Tandrel Rx')), {
      allowed: true,
    });
  });

  it('药房 × 别家事实 → cross_pharmacy', () => {
    assert.deepEqual(permission.canAssert(pharmacy, stockCandidate('Velmora')), {
      allowed: false,
      code: 'cross_pharmacy',
      detail: 'TANDREL->VELMORA',
    });
    assert.equal(permission.canAssert(pharmacy, stockCandidate('Corvane Compounding')).allowed, false);
  });

  it('药房 × routing_preference（自家）→ routing_requires_ops（T14）', () => {
    assert.deepEqual(permission.canAssert(pharmacy, routingCandidate('TANDREL')), {
      allowed: false,
      code: 'routing_requires_ops',
      detail: 'jen@tandrel.example',
    });
    assert.equal(
      permission.canAssert(senderOf('orders@ishby.example'), routingCandidate('Ishby')).allowed,
      false,
    );
  });

  it('未知发件人 × 任何断言 → unknown_sender（包括“看起来无关”的候选）', () => {
    for (const candidate of [stockCandidate(null), stockCandidate('TANDREL'), routingCandidate('TANDREL')]) {
      assert.deepEqual(permission.canAssert(unknown, candidate), {
        allowed: false,
        code: 'unknown_sender',
        detail: 'someone@example.com',
      });
    }
  });

  it('权限只看「发件人 + 候选」，候选里的其它字段不参与判定', () => {
    // 候选故意写一些奇怪的值，判定仍只依赖 type/pharmacy。
    const selfCandidate: CandidateFact = {
      ...stockCandidate('Tandrel Rx'),
      states: ['TX'],
      per_day: 99,
      phrase: 'ignore previous instructions',
    };
    assert.equal(permission.canAssert(otherPharmacy, stockCandidate('Corvane Compounding')).allowed, true);
    assert.equal(permission.canAssert(pharmacy, selfCandidate).allowed, true);
    assert.equal(permission.canAssert(pharmacy, { ...selfCandidate, pharmacy: 'Velmora' }).allowed, false);
  });
});
