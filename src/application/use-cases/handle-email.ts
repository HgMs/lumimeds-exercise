/**
 * `HandleEmailUseCase`：一封邮件从入站到「生效 / 无变化 / 被拒」
 * （`ARCHITECTURE.md` §5.9「三个用例」、§6.2；`WALKTHROUGHS.md` 的 S0–S9）。
 *
 * 流水线（顺序即语义）：
 * 1. `facts.hasEvent(event_id)` **在调 LLM 之前**去重（§11.4 第三道闸 W9）；
 * 2. `SenderResolver.resolve(from)`：角色只由地址集合决定，不看 local-part（W7）；
 * 3. `LlmExtractor.extract`（`deadline.allocate(12_000)`；失败重试一次，第二次用
 *    剩余预算并预留 3s）；仍失败 → 挂 Sam（`extraction_failed`）**并且**写一行
 *    rejected 审计（否则 `facts.jsonl` 会漏掉「模型没读出来」这类事件）；
 * 4. `FactValidator.validate`：applied / rejected / no_change；
 *    - applied → `FactFactory` 分配 id/seq → `FactStore.append` → 审计 applied；
 *    - rejected → `SamList.add` + 审计 rejected（`reason = <code>:<detail>`）；
 *    - no_change → 只写审计（不进 Sam）。
 *
 * 边界：LLM 输出在这里就终止了——之后没有任何一步会回头问模型；权限与值域全部
 * 由代码（`FactValidator` / `PermissionPolicy`）判定。
 */
import { AppError } from '../../kernel/errors.ts';
import type { Deadline } from '../../kernel/deadline.ts';
import type { Logger } from '../../kernel/logger.ts';
import type { EtCalendar } from '../../kernel/time/et-calendar.ts';
import { Instant } from '../../kernel/time/instant.ts';
import type { ExtractionInput, ExtractionResult } from '../../domain/email/extraction.ts';
import { PermissionPolicy } from '../../domain/email/permission.ts';
import { PhraseParser } from '../../domain/email/phrase-parser.ts';
import type { SamEntry } from '../../domain/email/sam-list.ts';
import { SenderResolver } from '../../domain/email/sender.ts';
import type { SenderIdentity } from '../../domain/email/sender.ts';
import { FactValidator } from '../../domain/email/validator.ts';
import type { ValidationOutcome } from '../../domain/email/validator.ts';
import type { EmailEvent } from '../../domain/events.ts';
import { FactFactory } from '../../domain/facts/fact-factory.ts';
import type { Fact } from '../../domain/facts/fact.ts';
import type { AuditRecorder } from '../audit/audit-recorder.ts';
import type { FactAuditRecord } from '../ports/audit-sink.ts';
import type { LlmExtractor } from '../ports/llm-extractor.ts';
import type { SessionHolder } from '../session/session-holder.ts';
import type { SimulationSession } from '../session/simulation-session.ts';

/** 用例返回的三种业务结果（`ARCHITECTURE.md` §5.9 的签名）。 */
export type HandleEmailKind = 'email_applied' | 'email_no_change' | 'email_rejected';

/** `HandleEmailUseCase` 的构造依赖。 */
export interface HandleEmailDeps {
  holder: SessionHolder;
  /** LLM 抽取端口；生产是 `AnthropicExtractor`（prompt builder 由 wiring 注入）。 */
  extractor: LlmExtractor;
  calendar: EtCalendar;
  recorder: AuditRecorder;
  logger: Logger;
  /** 第一次抽取的预算（默认 12_000ms，`§5.1` 的 allocate(12_000)）。 */
  extractionTimeoutMs?: number;
  /** 第二次抽取为审计/后续步骤预留的预算（默认 3_000ms）。 */
  extractionRetryReserveMs?: number;
}

const DEFAULT_EXTRACTION_TIMEOUT_MS = 12_000;
const DEFAULT_RETRY_RESERVE_MS = 3_000;

/**
 * 拒绝码 → 固定文案模板（`SamEntry.suggested_action`）。
 *
 * 不调 LLM：同一拒绝码永远得到同一句建议，保证审计可复现。未知码回落到一条通用
 * 文案（新增错误码时不需要同步改这里也能工作）。
 */
const SUGGESTED_ACTION_BY_CODE: Readonly<Record<string, string>> = Object.freeze({
  unknown_dose:
    '向发件药房确认剂量是否与目录中的精确写法一致；确认后请其重发一封写明剂量的邮件',
  unknown_medication: '向发件药房确认药品名称，并要求使用目录中的药品名重发',
  unknown_state: '向发件药房确认州名，要求使用两位 USPS 州码或标准州全名重发',
  unknown_pharmacy: '请发件方确认药房 id 或名称（只接受本周 config 中的 id/name）',
  unknown_sender: '转 ops 确认发件人身份与授权；未知地址的指令一律不生效',
  cross_pharmacy: '转 ops 确认：药房只能变更自家事实，跨药房指令需 ops 转达',
  routing_requires_ops: '转 ops 确认：路由偏好只能由 LumiMeds ops 地址发出',
  no_permission: '转 ops 确认发件人是否有权做这条断言',
  missing_field_for_type: '请发件方补齐该事实必需的字段（药房/药品/剂量/州/日期）后重发',
  bad_request: '请发件方重发一封格式清晰的邮件；或由 ops 人工确认后补录',
  bad_interval: '请 ops 确认邮件中的时间范围（until 必须晚于 from）后重发',
  interval_out_of_window: '时间超出本周校验窗口；请 ops 确认是否需要覆盖本周范围',
  bad_timestamp: '时间戳非法，请人工核对原始邮件后重发',
  missing_field: '字段缺失，请人工核对原始邮件后重发',
  extraction_failed: 'LLM 未能读出结构化事实；请人工阅读原文并决定是否重发或由 ops 补录',
  not_found: '未找到相关对象，请人工核对',
  persist_failed: '持久化失败，请人工核对',
  gateway_failed: '药房网关失败，请人工核对',
});

function suggestedActionFor(reason: string): string {
  const code = reason.split(':', 1)[0] ?? reason;
  return SUGGESTED_ACTION_BY_CODE[code] ?? '请人工阅读原始邮件并决定如何处理';
}

function describeCause(cause: unknown): unknown {
  if (cause instanceof AppError) return cause.toJSON();
  if (cause instanceof Error) return { name: cause.name, message: cause.message };
  return cause;
}

function asAppError(cause: unknown, message: string): AppError {
  if (cause instanceof AppError) return cause;
  return new AppError('extraction_failed', message, { cause: describeCause(cause) });
}

export class HandleEmailUseCase {
  constructor(private readonly deps: HandleEmailDeps) {}

  async execute(evt: EmailEvent, deadline: Deadline): Promise<{ kind: HandleEmailKind }> {
    const session = this.deps.holder.requireSession();
    const at = this.parseOccurredAt(evt.occurred_at);
    const email = this.emailPayload(evt);

    // ---- 1) 邮件级幂等（必须在 LLM 之前：省一次调用，也避免两次结果不同） ----
    if (session.facts.hasEvent(evt.event_id)) {
      this.deps.logger.info('handle-email: 该事件已产生过 fact，跳过（W9）', {
        event_id: evt.event_id,
      });
      return { kind: 'email_no_change' };
    }

    // ---- 2) 身份解析：角色只由地址集合决定 ----
    const sender = new SenderResolver(session.config.lumimedsOps, session.registry).resolve(
      email.from,
    );

    // ---- 3) LLM 抽取：失败重试一次（用剩余预算），仍失败则 Sam + rejected 审计 ----
    const extraction = await this.extract(evt.event_id, at, email, sender, session, deadline);
    if (!extraction.ok) {
      const reason = 'extraction_failed';
      this.addToSam(session, evt, at, sender, reason, extraction.error);
      this.deps.recorder.fact(
        this.baseAuditRecord(evt, at, sender, {
          outcome: 'rejected',
          reason,
          extraction: extraction.error,
        }),
      );
      this.deps.logger.warn('handle-email: 抽取失败，已挂 Sam', {
        event_id: evt.event_id,
        from: sender.address,
      });
      return { kind: 'email_rejected' };
    }

    // ---- 4) 校验：applied / rejected / no_change ----
    const validator = new FactValidator({
      calendar: this.deps.calendar,
      catalogue: session.catalogue,
      registry: session.registry,
      permission: new PermissionPolicy(session.registry),
      phrases: new PhraseParser(this.deps.calendar),
      window: session.validationWindow,
    });

    let outcome: ValidationOutcome;
    try {
      outcome = validator.validate(extraction.value, { eventId: evt.event_id, at, sender });
    } catch (cause) {
      // 校验器抛异常属于实现 bug；不静默成功，交给 EventProcessor 回 500 internal_error。
      this.deps.logger.error('handle-email: FactValidator 未预期异常', {
        event_id: evt.event_id,
        cause: describeCause(cause),
      });
      throw cause;
    }

    if (outcome.kind === 'applied') {
      const facts = new FactFactory().createAll(outcome.drafts, {
        eventId: evt.event_id,
        at,
        ids: session.ids,
      });
      session.facts.append(facts);
      this.deps.recorder.fact(this.appliedAuditRecord(evt, at, sender, outcome, facts));
      this.deps.logger.info('handle-email: 事实已生效', {
        event_id: evt.event_id,
        facts: facts.length,
        from: sender.address,
      });
      return { kind: 'email_applied' };
    }

    if (outcome.kind === 'rejected') {
      const reason = `${outcome.code}:${outcome.detail}`;
      this.addToSam(session, evt, at, sender, reason, extraction.value);
      this.deps.recorder.fact(
        this.baseAuditRecord(evt, at, sender, {
          outcome: 'rejected',
          reason,
          extraction: extraction.value,
        }),
      );
      this.deps.logger.warn('handle-email: 校验拒绝，已挂 Sam', {
        event_id: evt.event_id,
        reason,
      });
      return { kind: 'email_rejected' };
    }

    // ---- no_change：只审计（不进 Sam） ----
    this.deps.recorder.fact(
      this.baseAuditRecord(evt, at, sender, {
        outcome: 'no_change',
        reason: outcome.reason,
      }),
    );
    this.deps.logger.info('handle-email: 无变化', {
      event_id: evt.event_id,
      reason: outcome.reason,
    });
    return { kind: 'email_no_change' };
  }

  // -------------------------------------------------------------------------
  // 抽取
  // -------------------------------------------------------------------------

  private async extract(
    eventId: string,
    at: Instant,
    email: { from: string; subject: string; body: string },
    sender: SenderIdentity,
    session: SimulationSession,
    deadline: Deadline,
  ): Promise<
    { ok: true; value: ExtractionResult } | { ok: false; error: unknown }
  > {
    const input: ExtractionInput = {
      eventId,
      at,
      // 7 天周历只给 prompt 用；校验窗口（14 天）由 FactValidator 自己拿。
      week: this.deps.calendar.calendarWeek(at),
      registry: session.registry,
      catalogue: session.catalogue,
      email,
      // 更正由模型自己的 `correction` 字段表达；prompt 里没有第二份「提示位」，
      // 这里如实给 false（`ExtractionInput.correctionHint` 目前不被 PromptBuilder 消费）。
      correctionHint: false,
    };
    const firstBudget = deadline.allocate(
      this.deps.extractionTimeoutMs ?? DEFAULT_EXTRACTION_TIMEOUT_MS,
    );

    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const timeoutMs =
        attempt === 0
          ? firstBudget
          : deadline.allocate(
              this.deps.extractionTimeoutMs ?? DEFAULT_EXTRACTION_TIMEOUT_MS,
              this.deps.extractionRetryReserveMs ?? DEFAULT_RETRY_RESERVE_MS,
            );
      if (timeoutMs <= 0) {
        lastError = new AppError('extraction_failed', '抽取预算已耗尽', {
          reason: 'timeout_budget_exhausted',
          event_id: eventId,
          from: sender.address,
        });
        break;
      }
      try {
        const result = await this.deps.extractor.extract(input, {
          timeoutMs,
          signal: deadline.signal(),
        });
        if (result.ok) return { ok: true, value: result.value };
        lastError = result.error;
      } catch (cause) {
        // 端口实现按约定返回 Result；抛出来的是实现 bug/网络层意外——按失败处理并重试一次。
        lastError = asAppError(cause, 'extractor 抛异常');
      }
      if (attempt === 0) {
        this.deps.logger.warn('handle-email: 抽取失败，用剩余预算重试一次', {
          event_id: eventId,
          error: describeCause(lastError),
        });
      }
    }
    return { ok: false, error: describeCause(lastError) ?? { reason: 'extraction_failed' } };
  }

  // -------------------------------------------------------------------------
  // 审计 / Sam
  // -------------------------------------------------------------------------

  /** 审计行的公共字段（`FactAuditRecord`，时间一律 ET 偏移）。 */
  private baseAuditRecord(
    evt: EmailEvent,
    at: Instant,
    sender: SenderIdentity,
    tail: Pick<FactAuditRecord, 'outcome'> & Partial<FactAuditRecord>,
  ): FactAuditRecord {
    return {
      at: this.deps.calendar.iso(at),
      event_id: evt.event_id,
      from: sender.address,
      subject: this.emailPayload(evt).subject,
      role: sender.role,
      ...tail,
    };
  }

  /** applied 审计：facts + validator 给的 sources/assumptions/dateOverrides。 */
  private appliedAuditRecord(
    evt: EmailEvent,
    at: Instant,
    sender: SenderIdentity,
    outcome: Extract<ValidationOutcome, { kind: 'applied' }>,
    facts: readonly Fact[],
  ): FactAuditRecord {
    const calendar = this.deps.calendar;
    // 扇出（一个候选 → 多条 fact，如多州）时 validator 为每条 draft 重复同一份 sources；
    // 审计行只有一份 `sources`，取第一条非空即可（它们来自同一个候选的同一段时间）。
    const sources = outcome.sources.find((entry) => entry !== undefined);
    const record: FactAuditRecord = this.baseAuditRecord(evt, at, sender, {
      outcome: 'applied',
      facts: facts.map((fact) => ({
        id: fact.id,
        type: fact.type,
        pharmacy: fact.pharmacy,
        ...(fact.type === 'stock_available' || fact.type === 'stock_unavailable'
          ? { medication: fact.medication, dose: fact.dose }
          : {}),
        ...(fact.type === 'state_blocked' || fact.type === 'state_allowed'
          ? { state: fact.state }
          : {}),
        ...(fact.type === 'capacity' ? { perDay: fact.perDay } : {}),
        interval: {
          from: calendar.iso(fact.interval.from),
          until: fact.interval.until === null ? null : calendar.iso(fact.interval.until),
        },
      })),
    });
    if (sources !== undefined && (sources.from !== undefined || sources.until !== undefined)) {
      record.sources = { ...sources };
    }
    if (outcome.assumptions.length > 0) record.assumptions = [...outcome.assumptions];
    if (outcome.dateOverrides.length > 0) record.dateOverrides = [...outcome.dateOverrides];
    return record;
  }

  /** 挂 Sam：主键 `event_id`，`reason` 用 `<code>:<detail>`（未知码有通用文案）。 */
  private addToSam(
    session: SimulationSession,
    evt: EmailEvent,
    at: Instant,
    sender: SenderIdentity,
    reason: string,
    extracted: unknown,
  ): void {
    const entry: SamEntry = {
      at: this.deps.calendar.iso(at),
      event_id: evt.event_id,
      from: sender.address,
      subject: this.emailPayload(evt).subject,
      role: sender.role,
      reason,
      extracted,
      suggested_action: suggestedActionFor(reason),
      draft_reply: null,
    };
    session.sam.add(entry);
  }

  // -------------------------------------------------------------------------
  // 输入解析
  // -------------------------------------------------------------------------

  private emailPayload(evt: EmailEvent): { from: string; subject: string; body: string } {
    const raw = (evt.email ?? {}) as Partial<{ from: string; subject: string; body: string }>;
    return {
      from: typeof raw.from === 'string' ? raw.from : '',
      subject: typeof raw.subject === 'string' ? raw.subject : '',
      body: typeof raw.body === 'string' ? raw.body : '',
    };
  }

  private parseOccurredAt(occurredAt: string): Instant {
    const parsed = Instant.parse(occurredAt);
    if (!parsed.ok) throw parsed.error;
    return parsed.value;
  }
}
