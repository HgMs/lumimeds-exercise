/**
 * 发件人身份解析（`ARCHITECTURE.md` §5.8「身份与权限」、`REQUIREMENTS.md` §4.1）。
 *
 * 角色只由**地址集合**决定，不看 local-part（W7）：本地部分写着 ops 的地址仍是药房，
 * 判断依据只有「是否在 ops 地址集合里」与「是否某家药房的联系人」。
 * 顺序固定：先查 ops，再查药房联系人，都不是 → `unknown`。
 *
 * 只做地址解析，不做权限判断（权限在 `permission.ts`）：模型输出与身份无关，
 * 这里也绝不读模型给的任何字段。
 */
import type { PharmacyRegistry } from '../pharmacy.ts';
import type { PharmacyId } from '../types.ts';

/** 发件人角色；`unknown` 一律进 Sam（见 `FactValidator` 第 1 步）。 */
export type SenderRole = 'ops' | 'pharmacy' | 'unknown';

/** 解析后的发件人身份（`ARCHITECTURE.md` §5.8）。 */
export interface SenderIdentity {
  /** 小写地址部分（已去掉显示名与 `< >`）。 */
  address: string;
  /** `"Jen <...>"` 里的显示名；裸地址时为 `null`。 */
  display: string | null;
  role: SenderRole;
  /** `role === 'pharmacy'` 时是发件人所属药房的 id。 */
  pharmacy?: PharmacyId;
}

/** 从 `from` 里拆出地址与显示名：优先取 `<...>` 内的地址，否则按逗号取第一段。 */
function parseFrom(from: string): { address: string; display: string | null } {
  const raw = typeof from === 'string' ? from : String(from ?? '');
  const angle = /<([^<>]*)>/.exec(raw);
  if (angle !== null) {
    const head = raw.slice(0, angle.index).trim().replace(/^["']+|["']+$/g, '').trim();
    return {
      address: angle[1].trim().toLowerCase(),
      display: head === '' ? null : head,
    };
  }
  // 没有 <>：可能是裸地址，也可能是一串地址；只取第一段，不做猜测。
  const first = raw.split(',')[0];
  return { address: first.trim().replace(/^["']+|["']+$/g, '').toLowerCase(), display: null };
}

/**
 * `SenderResolver`：把 `email.from` 解析成 `SenderIdentity`（`ARCHITECTURE.md` §5.8）。
 *
 * 构造时把 ops 地址规范化一次（去首尾、小写）；之后 `resolve` 是纯函数。
 */
export class SenderResolver {
  private readonly ops: ReadonlySet<string>;

  constructor(ops: Iterable<string>, private readonly registry: PharmacyRegistry) {
    const normalized = new Set<string>();
    for (const raw of ops) {
      const address = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
      if (address !== '') normalized.add(address);
    }
    this.ops = normalized;
  }

  /**
   * 解析发件人身份。永不抛异常：解析不了的地址就是 `role: 'unknown'`
   * （由校验器决定进 Sam，而不是在这里拒绝事件）。
   */
  resolve(from: string): SenderIdentity {
    const { address, display } = parseFrom(from);

    // W7：ops 只看地址集合；不在集合里的地址（哪怕 local-part 叫 ops）就是药房。
    if (this.ops.has(address)) {
      return { address, display, role: 'ops' };
    }

    const pharmacy = this.registry.byContact(address);
    if (pharmacy !== undefined) {
      return { address, display, role: 'pharmacy', pharmacy: pharmacy.id };
    }

    return { address, display, role: 'unknown' };
  }
}
