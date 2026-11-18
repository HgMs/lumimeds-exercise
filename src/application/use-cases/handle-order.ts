/**
 * `HandleOrderUseCase`：一张订单从原始值到「已发/已推迟/已转 MANUAL」
 * （`ARCHITECTURE.md` §5.9「三个用例」、§6.1、§9 失败矩阵）。
 *
 * 判定顺序（顺序即语义）：
 * 1. 归一化（`OrderNormalizer`，代码做，不过 LLM）；
 *    失败 → 直接 `MANUAL`（`basis: 'manual'`、reason `unknown_<field>:<raw>`），
 *    仍写 decision + 审计（INV-5 的兜底口径）；
 * 2. 预算耗尽（正常路径 < 2ms，不会走到）→ `MANUAL`、reason `budget_exhausted`；
 * 3. `BeliefResolver.belief` × N（按 `registry.all()` 的 id 升序）→ `OrderRouter.route`；
 * 4. `DecisionLog.record`（upsert）+ `AuditRecorder.record`（暂存，不写盘）；
 * 5. `OrderDispatcher.dispatch`；成功（201/409）后 `DecisionLog.attachSend`；
 * 6. 期间任何**未预期异常** → 构造 `basis 'manual'`、`reason "internal_error:<code>"`
 *    的 decision 并**仍尝试发 MANUAL**；发不出去就进 `RetryQueue`。
 *
 * 「绝不留下没发出去的订单」优先于「决策好看」：宁可多一条 MANUAL，也不要丢单。
 */
import { AppError } from '../../kernel/errors.ts';
import type { Deadline } from '../../kernel/deadline.ts';
import type { Logger } from '../../kernel/logger.ts';
import { Instant } from '../../kernel/time/instant.ts';
import type { BeliefResolver } from '../../domain/belief/belief-resolver.ts';
import type { PharmacyBelief } from '../../domain/belief/pharmacy-belief.ts';
import type { OrderEvent, RawOrder } from '../../domain/events.ts';
import {
  DEFAULT_MEDICATION_ALIASES,
  MedicationNormalizer,
} from '../../domain/normalize/medication-normalizer.ts';
import { DoseNormalizer } from '../../domain/normalize/dose-normalizer.ts';
import type { NormalizedOrder } from '../../domain/normalize/order-normalizer.ts';
import { OrderNormalizer } from '../../domain/normalize/order-normalizer.ts';
import { StateNormalizer } from '../../domain/normalize/state-normalizer.ts';
import type { RoutingDecision } from '../../domain/routing/decision.ts';
import type { OrderRouter } from '../../domain/routing/router.ts';
import type { AuditRecorder } from '../audit/audit-recorder.ts';
import type { DispatchResult, OrderDispatcher } from '../dispatch/order-dispatcher.ts';
import type { SessionHolder } from '../session/session-holder.ts';
import type { SimulationSession } from '../session/simulation-session.ts';

/** 用例返回的三种业务结果（`ARCHITECTURE.md` §5.9 的签名）。 */
export type HandleOrderKind = 'order_sent' | 'order_manual' | 'order_deferred';

/** `HandleOrderUseCase` 的构造依赖。 */
export interface HandleOrderDeps {
  holder: SessionHolder;
  /** 与 `EventProcessor` / 其它用例共用的无状态路由组件。 */
  router: OrderRouter;
  beliefs: BeliefResolver;
  recorder: AuditRecorder;
  dispatcher: OrderDispatcher;
  logger: Logger;
}

/** 归一化失败的兜底订单：字段保留原始写法（decision.order 必须可 JSON 序列化）。 */
function rawOrderFallback(raw: RawOrder | undefined): NormalizedOrder {
  const value: Partial<RawOrder> = raw ?? {};
  const text = (input: unknown): string => (typeof input === 'string' ? input : String(input ?? ''));
  return {
    orderId: text(value.order_id),
    state: text(value.state),
    medication: text(value.medication),
    dose: text(value.dose),
  };
}

/** 把任意 thrown 值折成 `internal_error:<code>` 里的 code。 */
function errorCodeOf(cause: unknown): string {
  if (cause instanceof AppError) return cause.code;
  if (cause instanceof Error && cause.name !== '') {
    return cause.name === 'Error' ? 'unexpected_exception' : cause.name;
  }
  return 'unexpected_exception';
}

function describeCause(cause: unknown): unknown {
  if (cause instanceof AppError) return cause.toJSON();
  if (cause instanceof Error) return { name: cause.name, message: cause.message };
  return cause;
}

export class HandleOrderUseCase {
  constructor(private readonly deps: HandleOrderDeps) {}

  async execute(evt: OrderEvent, deadline: Deadline): Promise<{ kind: HandleOrderKind }> {
    const session = this.deps.holder.requireSession();
    const at = this.parseOccurredAt(evt.occurred_at);
    const raw = (evt.order ?? undefined) as RawOrder | undefined;

    // ---- 1) 归一化 + 2) 预算 + 3) 信念/路由；任何异常都折成 MANUAL 兜底 ----
    let order: NormalizedOrder = rawOrderFallback(raw);
    let decision: RoutingDecision | null = null;
    try {
      if (deadline.expired()) {
        decision = this.manualDecision(order, at, 'budget_exhausted');
      } else {
        const normalized = this.normalizerFor(session).normalize(raw as RawOrder);
        if (!normalized.ok) {
          // 归一化失败是**合法结论**（订单数据有问题），不是异常：直接 MANUAL。
          this.deps.logger.warn('handle-order: 归一化失败，转 MANUAL', {
            order_id: order.orderId,
            code: normalized.error.code,
            message: normalized.error.message,
          });
          decision = this.manualDecision(
            order,
            at,
            this.reasonForNormalizationFailure(normalized.error),
          );
        } else {
          order = normalized.value;
          decision = this.route(session, order, at);
        }
      }
    } catch (cause) {
      // 归一化/路由内部 bug：记 error，按兜底口径仍尝试发 MANUAL。
      this.deps.logger.error('handle-order: 路由路径未预期异常，转 MANUAL 兜底', {
        order_id: order.orderId,
        cause: describeCause(cause),
      });
      decision = this.manualDecision(order, at, `internal_error:${errorCodeOf(cause)}`);
    }

    // ---- 4) 先落 decision（快照与审计同源）；dispatch 抛异常时它也已在日志里 ----
    // 记录前先留一份旧值：INV-2 短路（seen 丢失后重投）时不能覆盖已确认的历史药房。
    const priorDecision = session.decisions.get(order.orderId);
    session.decisions.record(decision);

    // ---- 5) 发单；dispatcher 内部不抛异常，但这里仍兜一层 ----
    let result: DispatchResult;
    try {
      result = await this.deps.dispatcher.dispatch(order, decision, at, deadline);
    } catch (cause) {
      this.deps.logger.error('handle-order: dispatcher 未预期异常，最后兜底发 MANUAL', {
        order_id: order.orderId,
        cause: describeCause(cause),
      });
      decision = this.manualDecision(order, at, `internal_error:${errorCodeOf(cause)}`);
      session.decisions.record(decision);
      try {
        result = await this.deps.dispatcher.dispatch(order, decision, at, deadline);
      } catch (secondCause) {
        this.deps.logger.error('handle-order: MANUAL 兜底发单也失败（订单可能未发出）', {
          order_id: order.orderId,
          cause: describeCause(secondCause),
        });
        result = { kind: 'failed', status: 500, detail: 'dispatch_exception' };
      }
    }

    // ---- 6) 成功（201/409）后补 sent；审计用最终 decision ----
    if (result.kind === 'sent') {
      session.decisions.attachSend(order.orderId, { status: result.status ?? 201, at });
    } else if (result.kind === 'already_sent') {
      if (priorDecision !== undefined && priorDecision.sent !== null) {
        // INV-2 短路：这一单此前已经成功发出。重投重跑路由可能得出不同药房，
        // 必须以**已确认的**那条 decision 为准（sent 记录与 chosen 药房不能互相矛盾）。
        session.decisions.record(priorDecision);
      } else {
        const sentRecord = session.sent.get(order.orderId);
        session.decisions.attachSend(order.orderId, {
          status: result.status ?? 201,
          at: sentRecord?.at ?? at,
        });
      }
    } else if (result.kind === 'failed') {
      this.deps.logger.error('handle-order: 发单失败（未重试，事件仍回 200）', {
        order_id: order.orderId,
        chosen: decision.chosen,
        status: result.status ?? null,
        detail: result.detail ?? null,
      });
    }
    const finalDecision = session.decisions.get(order.orderId) ?? decision;
    this.deps.recorder.record(finalDecision);

    // §9 失败矩阵特别点名：**inflight 写失败 → 中止发单且回 500**（「不发比发两次好」，
    // 而且必须让 sim 记一条可见的 problem）。它不能折成 MANUAL 兜底：MANUAL 也得写 WAL。
    // 抛到 `EventProcessor` 由它统一转成 `{status:500, outcome:'internal_error'}`。
    if (result.kind === 'failed' && result.detail === 'inflight_begin_failed') {
      throw new AppError('gateway_failed', 'inflight.begin 失败，发单中止（不写 WAL 就不发）', {
        order_id: order.orderId,
        chosen: decision.chosen,
      });
    }

    if (result.kind === 'deferred') return { kind: 'order_deferred' };
    // 201/409 都意味着「这一单已经发出」；400/404/inflight 失败时用 deferred 表达
    // 「未确认发出」（事件本身仍以 200 返回，失败细节已记日志）。
    if (result.kind === 'sent' || result.kind === 'already_sent') {
      return { kind: decision.chosen === 'MANUAL' ? 'order_manual' : 'order_sent' };
    }
    return { kind: 'order_deferred' };
  }

  // -------------------------------------------------------------------------
  // 归一化 / 路由
  // -------------------------------------------------------------------------

  /** 每周重建一次归一化器（catalogue 来自当前会话，不能跨周复用）。 */
  private normalizerFor(session: SimulationSession): OrderNormalizer {
    const catalogue = session.catalogue;
    return new OrderNormalizer(
      new StateNormalizer(),
      new MedicationNormalizer(catalogue, DEFAULT_MEDICATION_ALIASES),
      new DoseNormalizer(catalogue),
    );
  }

  private route(
    session: SimulationSession,
    order: NormalizedOrder,
    at: Instant,
  ): RoutingDecision {
    const beliefs: PharmacyBelief[] = [];
    for (const base of session.registry.all()) {
      beliefs.push(
        this.deps.beliefs.belief(base, at, {
          facts: session.facts,
          capacity: session.capacity,
        }),
      );
    }
    return this.deps.router.route({
      order,
      at,
      beliefs,
      preferences: session.facts.preferences(),
    });
  }

  // -------------------------------------------------------------------------
  // 兜底 decision
  // -------------------------------------------------------------------------

  /**
   * 归一化失败的 reason：`<code>:<raw>`。`OrderNormalizer` 的失败详情里带
   * `field`/`raw`，取出 raw 拼成 `unknown_dose:25mg` 这类固定格式（INV-5 依赖
   * `unknown_*`/`internal_error:` 前缀区分「数据问题」与「兜底」）。
   */
  private reasonForNormalizationFailure(error: AppError): string {
    const detail = error.detail ?? {};
    const raw = detail['raw'];
    const field = detail['field'];
    if (typeof raw === 'string' && raw !== '') return `${error.code}:${raw}`;
    if (typeof field === 'string' && field !== '') return `${error.code}:${field}`;
    return error.code;
  }

  /** `basis 'manual'` 的兜底 decision：候选集为空（INV-5 的白名单口径）。 */
  private manualDecision(order: NormalizedOrder, at: Instant, reason: string): RoutingDecision {
    return {
      orderId: order.orderId,
      at,
      order,
      chosen: 'MANUAL',
      basis: 'manual',
      reason,
      candidates: [],
      preference: null,
      override: null,
      sent: null,
    };
  }

  private parseOccurredAt(occurredAt: string): Instant {
    const parsed = Instant.parse(occurredAt);
    if (!parsed.ok) {
      // 信封解析层已拦；这里再失败属不变量破坏（用例不与传输层耦合，所以抛）。
      throw parsed.error;
    }
    return parsed.value;
  }
}
