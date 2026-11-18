/**
 * 审计端口（`ARCHITECTURE.md` §5.9、§5.10；`DATA-CONTRACTS.md` §3.7）。
 *
 * `out/decisions.jsonl` 与 `out/facts.jsonl` 的写入口。审计不是真值
 * （快照才是），写失败只记日志、不回滚状态（D12）。
 */
import type { PersistedRoutingDecision } from '../../domain/routing/decision.ts';

/** `out/facts.jsonl` 一行（每封邮件一条）。 */
export interface FactAuditRecord {
  at: string;
  event_id: string;
  from: string;
  subject: string;
  role: 'pharmacy' | 'ops' | 'unknown';
  outcome: 'applied' | 'rejected' | 'no_change';
  /** rejected 时的原因码/文案。 */
  reason?: string;
  facts?: Array<{
    id: string;
    type: string;
    pharmacy: string;
    medication?: string;
    dose?: string;
    state?: string;
    perDay?: number;
    interval: { from: string; until: string | null };
  }>;
  /** 每个时间字段的采用来源：parser:<rule> / model / default。 */
  sources?: { from?: string; until?: string };
  /** 采取的安全侧假设，例如 "no until → indefinite"。 */
  assumptions?: string[];
  dateOverrides?: Array<{
    field: 'from' | 'until';
    model: string | null;
    used: string;
    source: string;
  }>;
  /** 仅 rejected：模型原始输出，便于人工复核。 */
  extraction?: unknown;
}

export interface AuditSink {
  decision(d: PersistedRoutingDecision): Promise<void>;
  fact(r: FactAuditRecord): Promise<void>;
  flush(): Promise<void>;
}
