/**
 * 权限矩阵（`ARCHITECTURE.md` §5.8「身份与权限」、`REQUIREMENTS.md` §4.1）。
 *
 * INV（C6）：`canAssert` 的输入只有「发件人 + 候选事实」——**没有**模型声称的权限，
 * 模型说什么都不影响这里。邮件正文里的 `SYSTEM NOTICE` 之类只是数据。
 *
 * | 发件人 \ 断言 | 自家事实 | 别家事实 | routing_preference |
 * |---|---|---|---|
 * | ops | 允许 | 允许 | 允许 |
 * | 药房 | 允许 | cross_pharmacy | routing_requires_ops |
 * | 未知 | unknown_sender | unknown_sender | unknown_sender |
 *
 * 权限排在药房解析之后（依赖已解析的药房）、剂量/州校验之前：先报「谁在说话」。
 */
import type { PharmacyRegistry } from '../pharmacy.ts';
import type { PharmacyId } from '../types.ts';
import type { CandidateFact } from './extraction.ts';
import type { SenderIdentity } from './sender.ts';

/** 权限拒绝码（`ARCHITECTURE.md` §5.8；全部是 `ErrorCode` 的子集）。 */
export type PermissionDenyCode =
  | 'unknown_sender'
  | 'no_permission'
  | 'cross_pharmacy'
  | 'routing_requires_ops';

/** 权限判定结果：允许，或拒绝 + 拒绝码 + 可读原因。 */
export type PermissionVerdict =
  | { allowed: true }
  | { allowed: false; code: PermissionDenyCode; detail: string };

/** 候选里「有效写出的药房」：空白视为缺省（药房发件人才有缺省，见验证器第 5 步）。 */
function explicitPharmacy(candidate: CandidateFact): string | null {
  const raw = candidate.pharmacy;
  return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
}

/**
 * 权限策略。构造时注入注册表：`cross_pharmacy` 需要把候选里的原始药房写法解析成 id
 * （与验证器第 5 步同一份解析，纯函数、可重复调用）。
 */
export class PermissionPolicy {
  constructor(private readonly registry: PharmacyRegistry) {}

  /**
   * 判定 `sender` 是否可以断言 `candidate`。
   *
   * 调用约定：验证器在「药房解析」之后调用（第 7 步）；候选的药房此时一定能解析。
   * 单独调用时如果解析不到药房，按 `no_permission` 拒绝（防御，流水线里不可达）。
   */
  canAssert(sender: SenderIdentity, candidate: CandidateFact): PermissionVerdict {
    // 1. 未知发件人：任何断言都拒绝（身份门，先于一切内容校验）。
    if (sender.role === 'unknown') {
      return {
        allowed: false,
        code: 'unknown_sender',
        detail: sender.address,
      };
    }

    const target = this.targetPharmacy(sender, candidate);

    // 2. 路由指令只属于 ops（不看候选药房是不是发件人自己的）。
    if (candidate.type === 'routing_preference' && sender.role !== 'ops') {
      return {
        allowed: false,
        code: 'routing_requires_ops',
        detail: sender.address,
      };
    }

    // 3. ops 可以断言任何药房的事实。
    if (sender.role === 'ops') {
      return { allowed: true };
    }

    // 4. 药房只能断言关于自己那家的事实。
    if (target === null) {
      return {
        allowed: false,
        code: 'no_permission',
        detail: `unresolved pharmacy for ${sender.address}`,
      };
    }
    if (target !== sender.pharmacy) {
      return {
        allowed: false,
        code: 'cross_pharmacy',
        detail: `${sender.pharmacy ?? '?'}->${target}`,
      };
    }
    return { allowed: true };
  }

  /**
   * 判定针对的药房：候选显式写了就用解析结果，否则用药房发件人自己那家
   * （ops 没有缺省可言；这里返回 null，权限层不负责报 `missing_field_for_type`）。
   */
  private targetPharmacy(sender: SenderIdentity, candidate: CandidateFact): PharmacyId | null {
    const explicit = explicitPharmacy(candidate);
    if (explicit !== null) {
      return this.registry.resolve(explicit)?.id ?? null;
    }
    return sender.role === 'pharmacy' ? (sender.pharmacy ?? null) : null;
  }
}
