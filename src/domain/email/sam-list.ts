/**
 * Sam 列表（`DATA-CONTRACTS.md` §3.5、`ARCHITECTURE.md` §5.8）。
 *
 * 被挂起的邮件都记在这里：它既是安全网，也是「草拟回复」加分项的素材。
 * 条目字段严格按契约（snake_case），因为它同时出现在 `GET /sam`、快照与审计里。
 *
 * 主键是 `event_id`：`add` 是幂等 upsert（同一封邮件重投不会变成 500），
 * 唯一性不靠抛异常（W8）。
 */
export interface SamEntry {
  at: string;
  event_id: string;
  from: string;
  subject: string;
  role: 'pharmacy' | 'ops' | 'unknown';
  /** 具体的校验失败原因，例如 `unknown_dose:25mg`。 */
  reason: string;
  /** LLM 原始输出（或失败详情），便于人工复核。 */
  extracted: unknown;
  /** 由拒绝码映射出的固定文案模板（不调 LLM，保证确定性）。 */
  suggested_action: string;
  /** 加分项：草拟回复；核心实现里恒为 null。 */
  draft_reply: string | null;
}

export class SamList {
  private readonly byEventId = new Map<string, SamEntry>();

  /** 幂等 upsert：同 event_id 覆盖旧条目。 */
  add(entry: SamEntry): void {
    this.byEventId.set(entry.event_id, { ...entry });
  }

  /** 按插入顺序返回只读快照（插入顺序 = 事件顺序，确定）。 */
  all(): readonly SamEntry[] {
    return [...this.byEventId.values()];
  }

  snapshot(): readonly SamEntry[] {
    return this.all().map((e) => ({ ...e }));
  }

  static restore(entries: readonly SamEntry[]): SamList {
    const list = new SamList();
    for (const e of entries) list.add(e);
    return list;
  }
}
