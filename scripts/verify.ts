#!/usr/bin/env node
/**
 * `scripts/verify.ts`：**独立**安全求值器（`ARCHITECTURE.md` §12.5、`REQUIREMENTS.md` §8、
 * §7 INV-5、§10 时间模型、`DATA-CONTRACTS.md` §3.7）。
 *
 * 它做的是**差分测试**：不复用 `src/domain`、`src/application` 的任何代码，自己重算
 * 「在订单的 sim_time 时刻，把订单发给某家药房安不安全」，再和应用的审计产物对账。
 * 如果 verify 直接 import `OrderRouter`，它只是在验证「代码等于它自己」（§12.5）。
 *
 * 输入（缺任一个都无法求值，exit 2，并提示先跑整周回放）：
 *
 * | 文件 | 默认 | 覆盖 | 用途 |
 * |---|---|---|---|
 * | week 文件 | `sim/week-a.jsonl` | `--week` / `WEEK_FILE` | config（基础事实）+ 订单事件（sim_time/州/药/剂量） |
 * | 决策审计 | `out/decisions.jsonl` | `--decisions` / `DECISIONS_FILE` | 每单的 chosen/basis/candidates/偏好/override |
 * | 发单日志 | `out/run-log.jsonl` | `--run-log` / `RUN_LOG_FILE` | 真实发单（模拟器写的唯一评分产物） |
 * | 事实审计 | `out/facts.jsonl` | `--facts` / `FACTS_FILE` | 邮件生效的事实（绝对 `from`/`until`，见下） |
 *
 * **为什么读 `out/facts.jsonl`**：`ARCHITECTURE.md` §12.5 说「不读 facts.jsonl 重建信念」，
 * 理由是它按契约只有邮件行、基础事实不在里面（§5.4）。本脚本严格按这个理由设计：
 * **基础事实从 week 文件的 config 派生**（营业/州/库存/日容量），**邮件事实从
 * `out/facts.jsonl` 的 `applied` 行取**（每行带绝对 ISO `interval.from/until`）——两者合起来
 * 才是完整的 T 时刻信念。verify 不做任何时间短语解析（§12.5：「只认 from/until 的绝对 ISO
 * 值」），也不校验「邮件解析得对不对」（那是集成测试与 §14.1 抽样的事）。这样它和使用
 * `index`/`reason` 前缀区分兜底的方式一样，只依赖**契约字段**，不依赖实现。
 *
 * 断言（`REQUIREMENTS.md` §8.2）：
 * 1. 每个已发订单在其 sim_time 时刻，所选药房**合格**（营业 ∧ 能发该州 ∧ 有精确剂量 ∧
 *    当日容量未满；容量按 (药房, ET 日) 只计真实发单，MANUAL 不占）。
 * 2. 每单**恰好一次**：run-log 一单一行；decisions 一单一行；两者与 week 的订单集合一致。
 * 3. `basis=manual` ⇔ 独立求值无安全候选；白名单：`reason` 以 `internal_error`/`unknown_`
 *    开头的兜底也允许是 manual（§7 INV-5、§5.9 B6）。
 * 4. ops 偏好未被违反：存在可用偏好药房时不得静默走 rank（除非 `decision.override` 非空，
 *    且 override 记录时偏好药房确实都不可用）。
 * 5. 差分：decision 里每个候选的 `failures`/`capacityLeft`/`price`/`shipsInDays` 必须与
 *    verify 独立求值一致——这是抓「信念算错但内部自洽」（例如 `until` 当闭区间）的关键。
 *
 * 输出：每单一行 + 汇总 + 失败明细；exit 0 = 全部通过，1 = 有不安全/不一致，2 = 无法运行。
 *
 * 用法：
 *   npm run verify
 *   node --experimental-transform-types --disable-warning=ExperimentalWarning scripts/verify.ts
 *   node ... scripts/verify.ts --week sim/week-a.jsonl --decisions out/decisions.jsonl
 */
import { existsSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// 常量与通用工具
// ---------------------------------------------------------------------------

/** 业务时区（`ARCHITECTURE.md` §10：ET 日期是业务日期）。 */
export const ET_ZONE = 'America/New_York';

/** MANUAL 的兜底 reason 前缀白名单（§7 INV-5）。 */
const FALLBACK_REASON_PREFIXES = ['internal_error', 'unknown_'] as const;

/** ET 墙上时间（用于把「业务日」换成毫秒；不假设固定偏移，DST 两轮求解）。 */
const ET_WALL_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: ET_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function wallClock(epochMs: number): WallClock {
  const parts = ET_WALL_FORMAT.formatToParts(new Date(epochMs));
  const pick = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((item) => item.type === type);
    if (part === undefined) throw new Error(`Intl 缺少 ${type} 字段（small-icu？）`);
    return Number(part.value);
  };
  return {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    hour: pick('hour') % 24, // 防御 ICU 的 24 时表示（h23 下不应出现，但不值得为此失败）
    minute: pick('minute'),
    second: pick('second'),
  };
}

/** ET 时刻的偏移（毫秒；EST = -05:00 → -18_000_000）。 */
function etOffsetMs(epochMs: number): number {
  const wall = wallClock(epochMs);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/** 某一 ET 业务日（`YYYY-MM-DD`）的 00:00 毫秒。两轮求解，DST 两端都正确。 */
export function startOfDayMs(etDate: string): number {
  const [year, month, day] = etDate.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(year, month - 1, day);
  const first = guess - etOffsetMs(guess);
  return guess - etOffsetMs(first);
}

/** 毫秒所在的 ET 业务日（`YYYY-MM-DD`）。 */
export function etDateOf(epochMs: number): string {
  const wall = wallClock(epochMs);
  return `${wall.year}-${pad2(wall.month)}-${pad2(wall.day)}`;
}

/** 报告用的 ET 时间标签：`2026-11-09 09:00 ET`。 */
export function etTimeLabel(epochMs: number): string {
  const wall = wallClock(epochMs);
  return `${wall.year}-${pad2(wall.month)}-${pad2(wall.day)} ${pad2(wall.hour)}:${pad2(wall.minute)} ET`;
}

/** 区间 `[from, until)`：until 排他；until = null 表示一直有效。 */
export function intervalCovers(fromMs: number, untilMs: number | null, atMs: number): boolean {
  return fromMs <= atMs && (untilMs === null || atMs < untilMs);
}

/** reason 是否是 INV-5 允许的兜底（`internal_error`/`unknown_` 前缀）。 */
export function isFallbackReason(reason: string | null | undefined): boolean {
  if (typeof reason !== 'string') return false;
  return FALLBACK_REASON_PREFIXES.some((prefix) => reason.startsWith(prefix));
}

/** 解析带偏移的 ISO 时间；非法返回 null（verify 自己判断是否算失败）。 */
function parseIso(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

// ---------------------------------------------------------------------------
// 归一化（与 REQUIREMENTS §5 末段同口径：订单是结构化数据，在代码里归一化）
// ---------------------------------------------------------------------------

const STATE_NAMES: Readonly<Record<string, string>> = {
  alabama: 'AL',
  alaska: 'AK',
  arizona: 'AZ',
  arkansas: 'AR',
  california: 'CA',
  colorado: 'CO',
  connecticut: 'CT',
  delaware: 'DE',
  'district of columbia': 'DC',
  florida: 'FL',
  georgia: 'GA',
  hawaii: 'HI',
  idaho: 'ID',
  illinois: 'IL',
  indiana: 'IN',
  iowa: 'IA',
  kansas: 'KS',
  kentucky: 'KY',
  louisiana: 'LA',
  maine: 'ME',
  maryland: 'MD',
  massachusetts: 'MA',
  michigan: 'MI',
  minnesota: 'MN',
  mississippi: 'MS',
  missouri: 'MO',
  montana: 'MT',
  nebraska: 'NE',
  nevada: 'NV',
  'new hampshire': 'NH',
  'new jersey': 'NJ',
  'new mexico': 'NM',
  'new york': 'NY',
  'north carolina': 'NC',
  'north dakota': 'ND',
  ohio: 'OH',
  oklahoma: 'OK',
  oregon: 'OR',
  pennsylvania: 'PA',
  'rhode island': 'RI',
  'south carolina': 'SC',
  'south dakota': 'SD',
  tennessee: 'TN',
  texas: 'TX',
  utah: 'UT',
  vermont: 'VT',
  virginia: 'VA',
  washington: 'WA',
  'west virginia': 'WV',
  wisconsin: 'WI',
  wyoming: 'WY',
};

const STATE_CODES = new Set(Object.values(STATE_NAMES));

/** 州归一化：两位 USPS 码（大小写不敏感）或州全名（大小写/空白不敏感）→ 两位码。 */
export function normalizeState(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const upper = trimmed.toUpperCase();
  if (STATE_CODES.has(upper)) return upper;
  return STATE_NAMES[trimmed.toLowerCase().replace(/\s+/g, ' ')] ?? null;
}

/** 药品归一化：目录键 + `tirz`/`sema` 别名（大小写/空白不敏感）。不做前缀匹配。 */
export function normalizeMedication(raw: unknown, catalogueKeys: Iterable<string>): string | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase();
  if (key === '') return null;
  const aliases: Record<string, string> = { tirz: 'tirzepatide', sema: 'semaglutide' };
  const normalized = aliases[key] ?? key;
  for (const catalogueKey of catalogueKeys) {
    if (catalogueKey === normalized) return catalogueKey;
  }
  return null;
}

/** 剂量归一化：去空白、单位小写（`" 7.5 mg "` → `7.5mg`）；**绝不补单位**。 */
export function normalizeDose(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toLowerCase().replace(/\s+/g, '');
  return normalized === '' ? null : normalized;
}

// ---------------------------------------------------------------------------
// 输入模型（全部由原始 JSONL 行解析；不 import src/）
// ---------------------------------------------------------------------------

export interface NormalizedOrder {
  orderId: string;
  state: string;
  medication: string;
  dose: string;
}

export interface NormalizedPharmacy {
  id: string;
  name: string;
  open: boolean;
  shipsInDays: number;
  dailyCapacity: number;
  price: Readonly<Record<string, number>>;
  /** 归一化后的封锁州。 */
  blockedStates: ReadonlySet<string>;
  /** 归一化后的现货：药品 → 剂量集合。 */
  stock: Readonly<Record<string, readonly string[]>>;
}

export interface WeekModel {
  startedAtMs: number;
  eventCount: number;
  emailEventCount: number;
  pharmacies: NormalizedPharmacy[];
  catalogue: Readonly<Record<string, readonly string[]>>;
  /** order_id → 第一个订单事件的业务时刻与归一化订单（重复投递不算新订单）。 */
  orderEvents: Map<string, { eventId: string; occurredAtMs: number; order: NormalizedOrder }>;
  /** 订单首次出现的先后顺序（报告按此排列）。 */
  orderSequence: string[];
}

export interface CandidateRecord {
  pharmacy: string;
  eligible: boolean;
  shipsInDays: number;
  price: number | null;
  capacityLeft: number;
  failures: string[];
}

export interface DecisionRecord {
  rowIndex: number;
  orderId: string;
  atMs: number | null;
  atRaw: unknown;
  order: NormalizedOrder | null;
  chosen: string;
  basis: string;
  reason: string | null;
  candidates: CandidateRecord[] | null;
  preference: { pharmacy: string; eventId: string } | null;
  override: string | null;
}

export interface RunLogRecord {
  rowIndex: number;
  orderId: string;
  pharmacy: string;
  simTimeMs: number | null;
  simTimeRaw: unknown;
  late: boolean;
}

export type FactType =
  | 'stock_available'
  | 'stock_unavailable'
  | 'state_blocked'
  | 'state_allowed'
  | 'closed'
  | 'reopened'
  | 'capacity'
  | 'routing_preference';

const FACT_TYPES = new Set<string>([
  'stock_available',
  'stock_unavailable',
  'state_blocked',
  'state_allowed',
  'closed',
  'reopened',
  'capacity',
  'routing_preference',
]);

export interface Fact {
  id: string;
  /** 全局单调序号（从 `fact_0028` 解析；同 `assertedAt` 时的最终平局键）。 */
  seq: number;
  eventId: string;
  assertedAtMs: number;
  type: FactType;
  pharmacy: string;
  medication?: string;
  dose?: string;
  state?: string;
  perDay?: number;
  fromMs: number;
  untilMs: number | null;
}

export interface RawVerifyInput {
  weekRows: unknown[];
  decisionRows: unknown[];
  runLogRows: unknown[];
  factRows: unknown[];
}

export interface VerifyModel {
  week: WeekModel;
  decisions: DecisionRecord[];
  runLog: RunLogRecord[];
  facts: Fact[];
  /** 解析阶段就发现的问题（形状不符等），也算 verify 失败。 */
  inputFailures: string[];
}

export interface VerifySummary {
  orders: number;
  sentToPharmacy: number;
  manual: number;
  byBasis: Record<string, number>;
  passedOrders: number;
  failedOrders: number;
  failureCount: number;
  appliedFactCount: number;
  appliedEmailCount: number;
}

export interface VerifyReport {
  exitCode: 0 | 1;
  lines: string[];
  failures: string[];
  summary: VerifySummary;
}

/** 无法运行（缺文件/文件坏了/配置无法解析）→ exit 2。 */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}

// ---------------------------------------------------------------------------
// 解析：week 文件
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    out.push(item);
  }
  return out;
}

/** 解析 week 文件：config（基础事实来源）+ 唯一的订单事件。 */
export function parseWeek(rows: readonly unknown[]): WeekModel {
  if (rows.length === 0) throw new InputError('week 文件是空的');
  const started = rows[0];
  if (!isRecord(started) || started.type !== 'simulation.started') {
    throw new InputError('week 文件必须以 simulation.started 事件开头（sim/README.md）');
  }
  const startedAtMs = parseIso(started.occurred_at);
  if (startedAtMs === null) throw new InputError('simulation.started 的 occurred_at 不是合法 ISO 时间');
  if (!isRecord(started.config)) {
    throw new InputError('simulation.started 缺少 config（verify 无法派生基础事实）');
  }

  const rawConfig = started.config;
  const rawCatalogue = isRecord(rawConfig.catalogue) ? rawConfig.catalogue : null;
  if (rawCatalogue === null) throw new InputError('config.catalogue 缺失或不是对象');
  const catalogue: Record<string, string[]> = {};
  for (const [rawMedication, rawDoses] of Object.entries(rawCatalogue)) {
    const medication = normalizeMedication(rawMedication, Object.keys(rawCatalogue));
    const doses = asStringArray(rawDoses);
    if (medication === null || doses === null) throw new InputError(`config.catalogue.${rawMedication} 形状不符`);
    const normalizedDoses: string[] = [];
    for (const rawDose of doses) {
      const dose = normalizeDose(rawDose);
      if (dose === null) throw new InputError(`config.catalogue.${rawMedication} 含非法剂量 '${rawDose}'`);
      normalizedDoses.push(dose);
    }
    catalogue[medication] = normalizedDoses;
  }

  if (!Array.isArray(rawConfig.pharmacies) || rawConfig.pharmacies.length === 0) {
    throw new InputError('config.pharmacies 缺失或为空');
  }

  const pharmacies: NormalizedPharmacy[] = [];
  const seenIds = new Set<string>();
  for (const rawPharmacy of rawConfig.pharmacies) {
    if (!isRecord(rawPharmacy)) throw new InputError('config.pharmacies 里有非对象项');
    const id = typeof rawPharmacy.id === 'string' ? rawPharmacy.id : null;
    if (id === null || id.trim() === '') throw new InputError('config.pharmacies 有药房缺少 id');
    if (seenIds.has(id)) throw new InputError(`config.pharmacies 里 id '${id}' 重复`);
    seenIds.add(id);

    const rawBlocked = asStringArray(rawPharmacy.blockedStates) ?? [];
    const blockedStates = new Set<string>();
    for (const rawState of rawBlocked) {
      const state = normalizeState(rawState);
      if (state === null) throw new InputError(`config.pharmacies.${id}.blockedStates 含非法州 '${rawState}'`);
      blockedStates.add(state);
    }

    const rawStock = isRecord(rawPharmacy.stock) ? rawPharmacy.stock : null;
    if (rawStock === null) throw new InputError(`config.pharmacies.${id}.stock 缺失`);
    const stock: Record<string, string[]> = {};
    for (const [rawMedication, rawDoses] of Object.entries(rawStock)) {
      const medication = normalizeMedication(rawMedication, Object.keys(catalogue));
      const doses = asStringArray(rawDoses);
      if (medication === null || doses === null) {
        throw new InputError(`config.pharmacies.${id}.stock.${rawMedication} 形状不符`);
      }
      stock[medication] = doses.map((rawDose) => {
        const dose = normalizeDose(rawDose);
        if (dose === null) throw new InputError(`config.pharmacies.${id}.stock 含非法剂量 '${rawDose}'`);
        return dose;
      });
    }

    const rawPrice = isRecord(rawPharmacy.price) ? rawPharmacy.price : null;
    if (rawPrice === null) throw new InputError(`config.pharmacies.${id}.price 缺失`);
    const price: Record<string, number> = {};
    for (const [rawMedication, rawValue] of Object.entries(rawPrice)) {
      const medication = normalizeMedication(rawMedication, Object.keys(catalogue));
      if (medication === null || typeof rawValue !== 'number' || !Number.isFinite(rawValue)) {
        throw new InputError(`config.pharmacies.${id}.price.${rawMedication} 形状不符`);
      }
      price[medication] = rawValue;
    }

    const open = rawPharmacy.open;
    const shipsInDays = rawPharmacy.shipsInDays;
    const dailyCapacity = rawPharmacy.dailyCapacity;
    if (typeof open !== 'boolean') throw new InputError(`config.pharmacies.${id}.open 不是布尔`);
    if (typeof shipsInDays !== 'number' || !Number.isInteger(shipsInDays) || shipsInDays < 0) {
      throw new InputError(`config.pharmacies.${id}.shipsInDays 不是非负整数`);
    }
    if (typeof dailyCapacity !== 'number' || !Number.isInteger(dailyCapacity) || dailyCapacity < 0) {
      throw new InputError(`config.pharmacies.${id}.dailyCapacity 不是非负整数`);
    }

    pharmacies.push({
      id,
      name: typeof rawPharmacy.name === 'string' ? rawPharmacy.name : id,
      open,
      shipsInDays,
      dailyCapacity,
      price,
      blockedStates,
      stock,
    });
  }
  // 应用侧 `registry.all()` 是 id 升序；verify 用同一顺序，candidates 才能逐项对账。
  pharmacies.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const catalogueKeys = Object.keys(catalogue);
  const orderEvents = new Map<string, { eventId: string; occurredAtMs: number; order: NormalizedOrder }>();
  const orderSequence: string[] = [];
  let eventCount = 0;
  let emailEventCount = 0;

  rows.forEach((row, index) => {
    if (!isRecord(row) || typeof row.type !== 'string') return;
    eventCount += 1;
    if (row.type === 'email') {
      emailEventCount += 1;
      return;
    }
    if (row.type !== 'order') return;
    const occurredAtMs = parseIso(row.occurred_at);
    if (occurredAtMs === null) {
      throw new InputError(`week 文件第 ${index + 1} 行：订单事件 occurred_at 不是合法 ISO 时间`);
    }
    if (!isRecord(row.order)) {
      throw new InputError(`week 文件第 ${index + 1} 行：订单事件缺少 order 对象`);
    }
    const rawOrder = row.order;
    if (typeof rawOrder.order_id !== 'string') {
      throw new InputError(`week 文件第 ${index + 1} 行：order.order_id 不是字符串`);
    }
    const state = normalizeState(rawOrder.state);
    const medication = normalizeMedication(rawOrder.medication, catalogueKeys);
    const dose = normalizeDose(rawOrder.dose);
    if (state === null || medication === null || dose === null) {
      throw new InputError(
        `week 文件第 ${index + 1} 行：order 无法归一化（state=${String(rawOrder.state)}, ` +
          `medication=${String(rawOrder.medication)}, dose=${String(rawOrder.dose)}）`,
      );
    }
    const order: NormalizedOrder = { orderId: rawOrder.order_id, state, medication, dose };
    // 重复投递（同一 order_id 再来一次）不是新订单；保留第一次的 sim_time。
    if (!orderEvents.has(order.orderId)) {
      orderEvents.set(order.orderId, {
        eventId: typeof row.event_id === 'string' ? row.event_id : `row_${index + 1}`,
        occurredAtMs,
        order,
      });
      orderSequence.push(order.orderId);
    }
  });

  return {
    startedAtMs,
    eventCount,
    emailEventCount,
    pharmacies,
    catalogue,
    orderEvents,
    orderSequence,
  };
}

// ---------------------------------------------------------------------------
// 解析：decisions / run-log / facts
// ---------------------------------------------------------------------------

function parseNormalizedOrder(raw: unknown, catalogueKeys: readonly string[]): NormalizedOrder | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.order_id !== 'string') return null;
  const state = normalizeState(raw.state);
  const medication = normalizeMedication(raw.medication, catalogueKeys);
  const dose = normalizeDose(raw.dose);
  if (state === null || medication === null || dose === null) return null;
  return { orderId: raw.order_id, state, medication, dose };
}

function parseFailureList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const failures: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    failures.push(item);
  }
  return failures;
}

/** 解析 `out/decisions.jsonl`（`PersistedRoutingDecision`，`DATA-CONTRACTS.md` §3.4）。 */
export function parseDecisions(
  rows: readonly unknown[],
  catalogueKeys: readonly string[],
  inputFailures: string[],
): DecisionRecord[] {
  const out: DecisionRecord[] = [];
  rows.forEach((row, index) => {
    const where = `out/decisions.jsonl 第 ${index + 1} 行`;
    if (!isRecord(row)) {
      inputFailures.push(`[input] ${where}：不是 JSON 对象`);
      return;
    }
    const orderId = typeof row.order_id === 'string' ? row.order_id : null;
    const chosen = typeof row.chosen === 'string' ? row.chosen : null;
    const basis = typeof row.basis === 'string' ? row.basis : null;
    if (orderId === null || chosen === null || basis === null) {
      inputFailures.push(`[input] ${where}：缺 order_id/chosen/basis（DATA-CONTRACTS §3.4）`);
      return;
    }

    let candidates: CandidateRecord[] | null = null;
    if (Array.isArray(row.candidates)) {
      candidates = [];
      for (const rawCandidate of row.candidates) {
        if (!isRecord(rawCandidate)) {
          inputFailures.push(`[input] ${where}：candidates 里有非对象项`);
          candidates = null;
          break;
        }
        const failures = parseFailureList(rawCandidate.failures);
        if (
          typeof rawCandidate.pharmacy !== 'string' ||
          typeof rawCandidate.eligible !== 'boolean' ||
          typeof rawCandidate.shipsInDays !== 'number' ||
          typeof rawCandidate.capacityLeft !== 'number' ||
          failures === null
        ) {
          inputFailures.push(`[input] ${where}：candidate 形状不符（DATA-CONTRACTS §3.3）`);
          candidates = null;
          break;
        }
        candidates.push({
          pharmacy: rawCandidate.pharmacy,
          eligible: rawCandidate.eligible,
          shipsInDays: rawCandidate.shipsInDays,
          price: typeof rawCandidate.price === 'number' ? rawCandidate.price : null,
          capacityLeft: rawCandidate.capacityLeft,
          failures,
        });
      }
    }

    let preference: DecisionRecord['preference'] = null;
    if (row.preference !== null && row.preference !== undefined) {
      if (
        isRecord(row.preference) &&
        typeof row.preference.pharmacy === 'string' &&
        typeof row.preference.event_id === 'string'
      ) {
        preference = { pharmacy: row.preference.pharmacy, eventId: row.preference.event_id };
      } else {
        inputFailures.push(`[input] ${where}：preference 形状不符`);
      }
    }

    const order = parseNormalizedOrder(row.order, catalogueKeys);
    out.push({
      rowIndex: index,
      orderId,
      atMs: parseIso(row.at),
      atRaw: row.at,
      order: order ?? null,
      chosen,
      basis,
      reason: typeof row.reason === 'string' ? row.reason : null,
      candidates,
      preference,
      override: typeof row.override === 'string' ? row.override : null,
    });
  });
  return out;
}

/** 解析 `out/run-log.jsonl`（模拟器写：`{order_id, pharmacy, reason?, sim_time, during_event, late}`）。 */
export function parseRunLog(rows: readonly unknown[], inputFailures: string[]): RunLogRecord[] {
  const out: RunLogRecord[] = [];
  rows.forEach((row, index) => {
    const where = `out/run-log.jsonl 第 ${index + 1} 行`;
    if (!isRecord(row)) {
      inputFailures.push(`[input] ${where}：不是 JSON 对象`);
      return;
    }
    if (typeof row.order_id !== 'string' || typeof row.pharmacy !== 'string') {
      inputFailures.push(`[input] ${where}：缺 order_id/pharmacy（sim 的发单日志形状）`);
      return;
    }
    out.push({
      rowIndex: index,
      orderId: row.order_id,
      pharmacy: row.pharmacy,
      simTimeMs: parseIso(row.sim_time),
      simTimeRaw: row.sim_time,
      late: row.late === true,
    });
  });
  return out;
}

/** 解析 `out/facts.jsonl`（每封邮件一行；只取 `applied` 行里的 fact，绝对 `from`/`until`）。 */
export function parseFacts(rows: readonly unknown[], inputFailures: string[]): Fact[] {
  const out: Fact[] = [];
  rows.forEach((row, index) => {
    const where = `out/facts.jsonl 第 ${index + 1} 行`;
    if (!isRecord(row)) {
      inputFailures.push(`[input] ${where}：不是 JSON 对象`);
      return;
    }
    if (row.outcome !== 'applied') return; // rejected / no_change 不产生 fact
    const eventId = typeof row.event_id === 'string' ? row.event_id : null;
    const assertedAtMs = parseIso(row.at);
    if (eventId === null || assertedAtMs === null) {
      inputFailures.push(`[input] ${where}：applied 行缺 event_id/at（DATA-CONTRACTS §3.7）`);
      return;
    }
    if (!Array.isArray(row.facts)) {
      inputFailures.push(`[input] ${where}：applied 行缺 facts 数组`);
      return;
    }
    row.facts.forEach((rawFact, factIndex) => {
      const factWhere = `${where} 的 facts[${factIndex}]`;
      if (!isRecord(rawFact)) {
        inputFailures.push(`[input] ${factWhere}：不是 JSON 对象`);
        return;
      }
      const id = typeof rawFact.id === 'string' ? rawFact.id : null;
      const type = typeof rawFact.type === 'string' ? rawFact.type : null;
      const pharmacy = typeof rawFact.pharmacy === 'string' ? rawFact.pharmacy : null;
      if (id === null || type === null || pharmacy === null) {
        inputFailures.push(`[input] ${factWhere}：缺 id/type/pharmacy`);
        return;
      }
      const seqMatch = /^fact_(\d+)$/.exec(id);
      if (seqMatch === null) {
        inputFailures.push(`[input] ${factWhere}：fact id '${id}' 不是 fact_NNNN 形式（DATA-CONTRACTS §3.1）`);
        return;
      }
      if (!FACT_TYPES.has(type)) {
        inputFailures.push(`[input] ${factWhere}：未知 fact 类型 '${type}'`);
        return;
      }
      if (!isRecord(rawFact.interval)) {
        inputFailures.push(`[input] ${factWhere}：缺 interval`);
        return;
      }
      const fromMs = parseIso(rawFact.interval.from);
      const untilRaw = rawFact.interval.until;
      const untilMs = untilRaw === null || untilRaw === undefined ? null : parseIso(untilRaw);
      if (fromMs === null || (untilRaw !== null && untilRaw !== undefined && untilMs === null)) {
        inputFailures.push(`[input] ${factWhere}：interval.from/until 不是合法 ISO 时间`);
        return;
      }
      if (untilMs !== null && untilMs <= fromMs) {
        inputFailures.push(`[input] ${factWhere}：interval.until(${String(untilRaw)}) 不晚于 from`);
        return;
      }
      const fact: Fact = {
        id,
        seq: Number(seqMatch[1]),
        eventId,
        assertedAtMs,
        type: type as FactType,
        pharmacy,
        fromMs,
        untilMs,
      };
      if (rawFact.medication !== undefined && rawFact.medication !== null) {
        if (typeof rawFact.medication !== 'string') {
          inputFailures.push(`[input] ${factWhere}：medication 不是字符串`);
          return;
        }
        fact.medication = rawFact.medication;
      }
      if (rawFact.dose !== undefined && rawFact.dose !== null) {
        if (typeof rawFact.dose !== 'string') {
          inputFailures.push(`[input] ${factWhere}：dose 不是字符串`);
          return;
        }
        fact.dose = rawFact.dose;
      }
      if (rawFact.state !== undefined && rawFact.state !== null) {
        if (typeof rawFact.state !== 'string') {
          inputFailures.push(`[input] ${factWhere}：state 不是字符串`);
          return;
        }
        fact.state = rawFact.state;
      }
      if (rawFact.perDay !== undefined && rawFact.perDay !== null) {
        if (typeof rawFact.perDay !== 'number' || !Number.isFinite(rawFact.perDay)) {
          inputFailures.push(`[input] ${factWhere}：perDay 不是数字`);
          return;
        }
        fact.perDay = rawFact.perDay;
      }
      out.push(fact);
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// 独立求值：T 时刻的信念 + 四硬条件
// ---------------------------------------------------------------------------

/** 同 cell 最后断言者：先 `assertedAt`，再全局 `seq`（DATA-CONTRACTS §3.2、ARCHITECTURE §5.4）。 */
function compareFactOrder(a: Fact, b: Fact): number {
  return a.assertedAtMs === b.assertedAtMs ? a.seq - b.seq : a.assertedAtMs - b.assertedAtMs;
}

function resolveFact(
  facts: readonly Fact[],
  atMs: number,
  predicate: (fact: Fact) => boolean,
): Fact | undefined {
  let best: Fact | undefined;
  for (const fact of facts) {
    if (!predicate(fact)) continue;
    if (!intervalCovers(fact.fromMs, fact.untilMs, atMs)) continue;
    if (best === undefined || compareFactOrder(fact, best) > 0) best = fact;
  }
  return best;
}

export interface PharmacyEvaluation {
  pharmacy: NormalizedPharmacy;
  /** 固定顺序：closed → state_blocked → no_stock → capacity_full（ARCHITECTURE §5.5）。 */
  failures: string[];
  eligible: boolean;
  shipsInDays: number;
  price: number | null;
  capacityToday: number;
  capacityUsed: number;
  capacityLeft: number;
}

interface BeliefContext {
  facts: readonly Fact[];
  /** `${pharmacy}|${ET 日}` → 该日真实发单的业务时刻（升序）。 */
  sendsByPharmacyDay: ReadonlyMap<string, readonly number[]>;
}

function sendKey(pharmacy: string, etDate: string): string {
  return `${pharmacy}|${etDate}`;
}

/** `atMs` 所在 ET 日、该药房**此前**真实发出的单数（MANUAL 不计；当前这一单不算）。 */
function usedBefore(context: BeliefContext, pharmacyId: string, atMs: number): number {
  const times = context.sendsByPharmacyDay.get(sendKey(pharmacyId, etDateOf(atMs)));
  if (times === undefined) return 0;
  let count = 0;
  for (const time of times) {
    if (time < atMs) count += 1;
    else break; // 数组已升序
  }
  return count;
}

/** 求 T 时刻某药房对某订单的资格（四硬条件 + 可解释的失败码）。 */
export function evaluatePharmacy(
  pharmacy: NormalizedPharmacy,
  order: NormalizedOrder,
  atMs: number,
  context: BeliefContext,
): PharmacyEvaluation {
  const { facts } = context;

  // 1) 营业：最新覆盖 T 的 closed/reopened，否则 config 的 open。
  const closure = resolveFact(
    facts,
    atMs,
    (fact) => fact.pharmacy === pharmacy.id && (fact.type === 'closed' || fact.type === 'reopened'),
  );
  const openNow = closure === undefined ? pharmacy.open : closure.type === 'reopened';

  // 2) 州：最新覆盖 T 的 state_blocked/state_allowed，否则 config 的 blockedStates。
  const coverage = resolveFact(
    facts,
    atMs,
    (fact) =>
      fact.pharmacy === pharmacy.id &&
      fact.state === order.state &&
      (fact.type === 'state_blocked' || fact.type === 'state_allowed'),
  );
  const shipsTo =
    coverage === undefined ? !pharmacy.blockedStates.has(order.state) : coverage.type === 'state_allowed';

  // 3) 精确剂量库存：最新覆盖 T 的 stock_*，否则 config 的 stock（不做单位推断/模糊匹配）。
  const stockFact = resolveFact(
    facts,
    atMs,
    (fact) =>
      fact.pharmacy === pharmacy.id &&
      fact.medication === order.medication &&
      fact.dose === order.dose &&
      (fact.type === 'stock_available' || fact.type === 'stock_unavailable'),
  );
  const hasStock =
    stockFact === undefined
      ? (pharmacy.stock[order.medication] ?? []).includes(order.dose)
      : stockFact.type === 'stock_available';

  // 4) 当日容量：最新覆盖 T 的 capacity fact，否则 config 的 dailyCapacity；按 (药房, ET 日) 计。
  const capacityFact = resolveFact(
    facts,
    atMs,
    (fact) => fact.pharmacy === pharmacy.id && fact.type === 'capacity',
  );
  const capacityToday =
    capacityFact !== undefined && capacityFact.perDay !== undefined
      ? capacityFact.perDay
      : pharmacy.dailyCapacity;
  const capacityUsed = usedBefore(context, pharmacy.id, atMs);
  const capacityLeft = Math.max(0, capacityToday - capacityUsed);

  const failures: string[] = [];
  if (!openNow) failures.push('closed');
  if (!shipsTo) failures.push(`state_blocked:${order.state}`);
  if (!hasStock) failures.push(`no_stock:${order.medication}:${order.dose}`);
  if (capacityLeft <= 0) failures.push('capacity_full');

  return {
    pharmacy,
    failures,
    eligible: failures.length === 0,
    shipsInDays: pharmacy.shipsInDays,
    price: pharmacy.price[order.medication] ?? null,
    capacityToday,
    capacityUsed,
    capacityLeft,
  };
}

/** 排名：`(shipsInDays, price, id)` 升序；价格缺失排最后（REQUIREMENTS §5）。 */
function compareRank(a: PharmacyEvaluation, b: PharmacyEvaluation): number {
  if (a.shipsInDays !== b.shipsInDays) return a.shipsInDays - b.shipsInDays;
  const priceA = a.price ?? Number.POSITIVE_INFINITY;
  const priceB = b.price ?? Number.POSITIVE_INFINITY;
  if (priceA !== priceB) return priceA - priceB;
  return a.pharmacy.id < b.pharmacy.id ? -1 : a.pharmacy.id > b.pharmacy.id ? 1 : 0;
}

interface ActivePreference {
  fact: Fact;
  specificity: number;
}

/** 生效偏好：覆盖 T、匹配药/剂量/州（缺省=通配），按 特异性→后断言→seq 排序。 */
export function activePreferences(facts: readonly Fact[], order: NormalizedOrder, atMs: number): Fact[] {
  const active: ActivePreference[] = [];
  for (const fact of facts) {
    if (fact.type !== 'routing_preference') continue;
    if (fact.medication !== order.medication) continue;
    if (fact.dose !== undefined && fact.dose !== order.dose) continue;
    if (fact.state !== undefined && fact.state !== order.state) continue;
    if (!intervalCovers(fact.fromMs, fact.untilMs, atMs)) continue;
    const specificity = (fact.dose !== undefined ? 2 : 0) + (fact.state !== undefined ? 1 : 0);
    active.push({ fact, specificity });
  }
  active.sort((a, b) => {
    if (a.specificity !== b.specificity) return b.specificity - a.specificity;
    if (a.fact.assertedAtMs !== b.fact.assertedAtMs) return b.fact.assertedAtMs - a.fact.assertedAtMs;
    return b.fact.seq - a.fact.seq;
  });
  return active.map((entry) => entry.fact);
}

interface ExpectedDecision {
  kind: 'manual' | 'ops_preference' | 'rank';
  chosen: string | null;
  /** 期望的偏好命中（ops_preference 时非空）。 */
  preferenceEventId: string | null;
  activePreferences: Fact[];
  candidates: PharmacyEvaluation[];
  evaluations: PharmacyEvaluation[];
}

function expectedDecision(
  evaluations: readonly PharmacyEvaluation[],
  facts: readonly Fact[],
  order: NormalizedOrder,
  atMs: number,
  candidates: readonly PharmacyEvaluation[],
): ExpectedDecision {
  const active = activePreferences(facts, order, atMs);
  if (candidates.length === 0) {
    return {
      kind: 'manual',
      chosen: null,
      preferenceEventId: null,
      activePreferences: active,
      candidates: [],
      evaluations: [...evaluations],
    };
  }
  const byId = new Map(candidates.map((evaluation) => [evaluation.pharmacy.id, evaluation]));
  for (const preference of active) {
    if (byId.has(preference.pharmacy)) {
      return {
        kind: 'ops_preference',
        chosen: preference.pharmacy,
        preferenceEventId: preference.eventId,
        activePreferences: active,
        candidates: [...candidates],
        evaluations: [...evaluations],
      };
    }
  }
  const best = [...candidates].sort(compareRank)[0];
  return {
    kind: 'rank',
    chosen: best === undefined ? null : best.pharmacy.id,
    preferenceEventId: null,
    activePreferences: active,
    candidates: [...candidates],
    evaluations: [...evaluations],
  };
}

// ---------------------------------------------------------------------------
// 核心校验
// ---------------------------------------------------------------------------

function describeFailures(evaluation: PharmacyEvaluation): string {
  return evaluation.failures.length > 0 ? evaluation.failures.join(', ') : '无失败码';
}

function describeReason(reason: string | null): string {
  return reason === null ? 'null' : reason.length > 80 ? `${reason.slice(0, 77)}...` : reason;
}

/** 把 run-log 转成「(药房, ET 日) → 业务时刻列表」的容量账本。 */
function buildSendLedger(runLog: readonly RunLogRecord[]): Map<string, number[]> {
  const ledger = new Map<string, number[]>();
  for (const entry of runLog) {
    if (entry.pharmacy === 'MANUAL') continue; // MANUAL 不占容量（INV-6）
    if (entry.simTimeMs === null) continue; // 时间坏掉的行会单独报失败
    const key = sendKey(entry.pharmacy, etDateOf(entry.simTimeMs));
    const times = ledger.get(key);
    if (times === undefined) ledger.set(key, [entry.simTimeMs]);
    else times.push(entry.simTimeMs);
  }
  for (const times of ledger.values()) times.sort((a, b) => a - b);
  return ledger;
}

function groupByOrderId<T extends { orderId: string }>(records: readonly T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const record of records) {
    const list = map.get(record.orderId);
    if (list === undefined) map.set(record.orderId, [record]);
    else list.push(record);
  }
  return map;
}

/** 纯函数核心：给定已解析的输入，产出报告（测试可直接调它，不必落盘）。 */
export function verifyModel(model: VerifyModel): VerifyReport {
  const { week } = model;
  const failures: string[] = [...model.inputFailures];
  const lines: string[] = [];
  const decisionsByOrder = groupByOrderId(model.decisions);
  const runLogByOrder = groupByOrderId(model.runLog);

  for (const entry of model.runLog) {
    if (entry.simTimeMs === null) {
      failures.push(`[input] ${entry.orderId}: run-log 的 sim_time 不是合法 ISO 时间（${String(entry.simTimeRaw)}）`);
    }
  }

  const context: BeliefContext = { facts: model.facts, sendsByPharmacyDay: buildSendLedger(model.runLog) };

  // ---- 集合一致性：week 的订单 ↔ decisions ↔ run-log ----
  const weekOrders = new Set(week.orderSequence);
  for (const orderId of week.orderSequence) {
    const decisionRows = decisionsByOrder.get(orderId) ?? [];
    if (decisionRows.length === 0) {
      failures.push(`[set] ${orderId}: decisions.jsonl 缺少该订单的决策行（每单恰有一条，INV-4）`);
    } else if (decisionRows.length > 1) {
      failures.push(
        `[set] ${orderId}: decisions.jsonl 有 ${decisionRows.length} 行（每单恰有一条；` +
          `若这是重试改派产生的第二条，请先确认 out/ 是否混入了多次回放）`,
      );
    }
    const runRows = runLogByOrder.get(orderId) ?? [];
    if (runRows.length === 0) {
      failures.push(
        `[sent] ${orderId}: run-log.jsonl 缺少该订单的发单记录（订单从未发到药房或 MANUAL）`,
      );
    } else if (runRows.length > 1) {
      failures.push(
        `[sent] ${orderId}: run-log.jsonl 出现 ${runRows.length} 次发单记录（每单恰好一次，INV-2）；` +
          `若 out/ 是多次回放叠加的，请清空 out/ 后重跑`,
      );
    }
  }
  for (const orderId of decisionsByOrder.keys()) {
    if (!weekOrders.has(orderId)) {
      failures.push(`[set] ${orderId}: decisions.jsonl 里有本周不存在的订单（out/ 可能有上次回放残留）`);
    }
  }
  for (const orderId of runLogByOrder.keys()) {
    if (!weekOrders.has(orderId)) {
      failures.push(`[set] ${orderId}: run-log.jsonl 里有本周不存在的订单（out/ 可能有上次回放残留）`);
    }
  }

  // ---- 逐单校验 ----
  interface OrderResult {
    orderId: string;
    failures: string[];
    line: string;
  }
  const results: OrderResult[] = [];

  for (const orderId of week.orderSequence) {
    const event = week.orderEvents.get(orderId);
    if (event === undefined) continue; // 理论上不会发生
    const orderFailures: string[] = [];
    const fail = (category: string, message: string): void => {
      orderFailures.push(`[${category}] ${orderId}: ${message}`);
    };
    const t = event.occurredAtMs;
    const order = event.order;

    const evaluations = week.pharmacies.map((pharmacy) => evaluatePharmacy(pharmacy, order, t, context));
    const candidates = evaluations.filter((evaluation) => evaluation.eligible);
    const expected = expectedDecision(evaluations, model.facts, order, t, candidates);

    const decisionRows = decisionsByOrder.get(orderId) ?? [];
    const decision = decisionRows[0];
    const runRows = runLogByOrder.get(orderId) ?? [];
    const runRow = runRows[0];

    if (runRow !== undefined) {
      if (runRow.simTimeMs !== null && runRow.simTimeMs !== t) {
        fail(
          'set',
          `run-log.sim_time=${String(runRow.simTimeRaw)} 与订单事件 occurred_at 不一致（业务时刻必须是事件时间）`,
        );
      }
      if (decision !== undefined && runRow.pharmacy !== decision.chosen) {
        fail('set', `run-log 发给 ${runRow.pharmacy}，但 decision.chosen=${decision.chosen}（审计与真实发单不一致）`);
      }
    }

    let verdict = '';
    if (decision !== undefined) {
      if (decision.atMs === null) {
        fail('set', `decision.at 不是合法 ISO 时间（${String(decision.atRaw)}）`);
      } else if (decision.atMs !== t) {
        fail('set', `decision.at=${String(decision.atRaw)} 与订单事件 occurred_at 不一致`);
      }

      if (decision.order === null) {
        fail('input', 'decision.order 无法归一化（DATA-CONTRACTS §3.4 要求记录归一化订单）');
      } else if (
        decision.order.state !== order.state ||
        decision.order.medication !== order.medication ||
        decision.order.dose !== order.dose
      ) {
        fail(
          'set',
          `decision.order 与 week 订单不一致（决策记录 ${decision.order.state}/${decision.order.medication}/${decision.order.dose}，` +
            `week 归一化后 ${order.state}/${order.medication}/${order.dose}）`,
        );
      }

      const chosen = decision.chosen;
      const isManual = chosen === 'MANUAL';

      // 1) 已发订单在 sim_time 时刻必须合格（安全第一）。
      if (!isManual) {
        const chosenEvaluation = evaluations.find((evaluation) => evaluation.pharmacy.id === chosen);
        if (chosenEvaluation === undefined) {
          fail('safety', `发往未知药房 '${chosen}'（不在本周 config 的 pharmacies 里）`);
        } else if (!chosenEvaluation.eligible) {
          fail(
            'safety',
            `已发订单在 sim_time 时刻所选药房不合格：${chosen}（${describeFailures(chosenEvaluation)}）`,
          );
        }
      }

      // 2) basis / MANUAL 一致性（INV-5）。
      if (isManual !== (decision.basis === 'manual')) {
        fail('manual', `chosen=${chosen} 与 basis=${decision.basis} 不一致`);
      }
      if (isManual) {
        if (expected.kind !== 'manual' && !isFallbackReason(decision.reason)) {
          fail(
            'manual',
            `MANUAL 但独立求值存在安全候选 [${expected.candidates.map((item) => item.pharmacy.id).join(', ')}]，` +
              `且 reason 不是 internal_error/unknown_ 兜底前缀：${describeReason(decision.reason)}`,
          );
        }
        if (decision.preference !== null) {
          fail('manual', 'MANUAL 决策不应记录 preference（没有候选，偏好不参与）');
        }
        verdict =
          expected.kind === 'manual'
            ? '无安全候选（独立求值一致）'
            : `兜底：${describeReason(decision.reason)}`;
      } else {
        // 3) ops 偏好从属于安全：可用偏好不得被静默忽略；override 必须成立。
        const active = expected.activePreferences;
        const expectedOps = expected.kind === 'ops_preference' ? expected : null;
        if (decision.preference !== null) {
          if (decision.preference.pharmacy !== chosen) {
            fail(
              'preference',
              `preference.pharmacy=${decision.preference.pharmacy} 与 chosen=${chosen} 不一致`,
            );
          }
          if (expectedOps === null) {
            fail(
              'preference',
              `记录了偏好命中 ${decision.preference.pharmacy}，但独立求值认为偏好药房都不可用`,
            );
          } else {
            if (decision.preference.pharmacy !== expectedOps.chosen) {
              fail(
                'preference',
                `偏好命中应为偏好顺序里第一个可用者 ${String(expectedOps.chosen)}，实际 ${decision.preference.pharmacy}`,
              );
            }
            if (decision.preference.eventId !== expectedOps.preferenceEventId) {
              fail(
                'preference',
                `preference.event_id=${decision.preference.eventId}，应为 ${String(expectedOps.preferenceEventId)}`,
              );
            }
          }
          if (decision.override !== null) {
            fail('preference', '命中偏好时不应同时记录 override');
          }
        } else if (expectedOps !== null && decision.override === null) {
          fail(
            'preference',
            `ops 偏好未被违反地采用：${String(expectedOps.chosen)} 当时安全可用，但 chosen=${chosen} 且未记录 override`,
          );
        } else if (expectedOps === null && active.length > 0 && decision.override === null) {
          // 偏好存在但都不可用：必须记录 override（§5.7「ops 指定 X，但 X 因 … 不可用」）。
          fail(
            'preference',
            `存在生效的 ops 偏好 [${active.map((item) => item.pharmacy).join(', ')}]，但决策既未命中偏好也未记录 override`,
          );
        }

        if (decision.override !== null) {
          if (active.length === 0) {
            fail('preference', `记录 override 但独立求值下没有生效的 ops 偏好：${describeReason(decision.override)}`);
          }
          for (const preference of active) {
            const evaluation = evaluations.find((item) => item.pharmacy.id === preference.pharmacy);
            if (evaluation !== undefined && evaluation.eligible) {
              fail(
                'preference',
                `override 称偏好药房不可用，但 ${preference.pharmacy} 在 sim_time 时刻合格（${describeFailures(evaluation)}）`,
              );
            }
          }
          if (decision.basis !== 'rank') {
            fail('preference', `override 场景的 basis 应为 rank，实际 ${decision.basis}`);
          }
        }

        // 4) 差分在 isManual 分支之外统一做（MANUAL 的 candidates 也要对账）。
        const chosenEvaluation = evaluations.find((evaluation) => evaluation.pharmacy.id === chosen);
        verdict =
          expected.kind === 'ops_preference' && expected.chosen === chosen
            ? `ops 偏好命中，合格（${chosenEvaluation?.shipsInDays ?? '?'} 天，` +
              `$${chosenEvaluation?.price ?? '?'}，当日容量已用 ${chosenEvaluation?.capacityUsed ?? '?'}/` +
              `${chosenEvaluation?.capacityToday ?? '?'}）`
            : carried(chosenEvaluation, decision.override);
      }

      // 4) 差分：候选评估逐家对账（抓「信念算错但内部自洽」：例如 until 当闭区间、
      //    容量按错日/算进 MANUAL、固定偏移等）。
      compareCandidateDifferential(decision, evaluations, fail);
    } else if (runRow !== undefined) {
      verdict = `发往 ${runRow.pharmacy}（缺少 decision，无法对账）`;
    }

    results.push({
      orderId,
      failures: orderFailures,
      line: renderOrderLine(orderId, t, order, decision, runRow, verdict, orderFailures.length > 0),
    });
    failures.push(...orderFailures);
  }

  // ---- 汇总 ----
  const summary = summarize(model, results, failures, week);
  lines.push(...renderHeader(model, summary));
  lines.push('');
  for (const result of results) lines.push(result.line);
  lines.push('');
  lines.push(...renderSummary(summary));
  lines.push('');
  if (failures.length === 0) {
    lines.push('结论：全部通过（exit 0）');
  } else {
    lines.push(`失败明细（${failures.length} 条）：`);
    for (const failure of failures) lines.push(`  ✗ ${failure}`);
    lines.push('');
    lines.push('结论：发现不安全或前后不一致（exit 1）');
  }

  return {
    exitCode: failures.length === 0 ? 0 : 1,
    lines,
    failures,
    summary,
  };
}

function carried(
  chosenEvaluation: PharmacyEvaluation | undefined,
  override: string | null,
): string {
  if (chosenEvaluation === undefined) return '合格（独立求值）';
  const base =
    `合格（${chosenEvaluation.shipsInDays} 天，$${chosenEvaluation.price ?? '?'}，` +
    `当日容量已用 ${chosenEvaluation.capacityUsed}/${chosenEvaluation.capacityToday}）`;
  return override === null ? base : `${base}；按 rank 回落，override 已记录`;
}

/**
 * 差分：把 `decision.candidates` 与 verify 的独立求值逐家对账。
 *
 * 这是 §12.5 说的「能抓到信念算错但内部自洽」的关键。只在 decision 记录了 candidates
 * 时做；缺 candidates 的契约问题由解析阶段报。
 */
function compareCandidateDifferential(
  decision: DecisionRecord,
  evaluations: readonly PharmacyEvaluation[],
  fail: (category: string, message: string) => void,
): void {
  if (decision.candidates === null) {
    fail('input', 'decision.candidates 缺失或形状不符（DATA-CONTRACTS §3.4 要求逐家记录）');
    return;
  }
  const recorded = new Map(decision.candidates.map((candidate) => [candidate.pharmacy, candidate]));
  for (const ours of evaluations) {
    const theirs = recorded.get(ours.pharmacy.id);
    if (theirs === undefined) {
      fail('differential', `决策 candidates 缺少药房 ${ours.pharmacy.id}`);
      continue;
    }
    if (theirs.eligible !== ours.eligible) {
      fail(
        'differential',
        `${ours.pharmacy.id} 的 eligible 不一致：decision=${theirs.eligible}，verify=${ours.eligible}`,
      );
    }
    if (theirs.failures.join('|') !== ours.failures.join('|')) {
      fail(
        'differential',
        `${ours.pharmacy.id} 的 failures 不一致：decision=[${theirs.failures.join(', ')}]，` +
          `verify=[${ours.failures.join(', ')}]（常见根因：until 当闭区间、容量算错日/算进 MANUAL、DST 偏移写死）`,
      );
    }
    if (theirs.shipsInDays !== ours.shipsInDays) {
      fail('differential', `${ours.pharmacy.id} 的 shipsInDays 不一致`);
    }
    if (theirs.price !== ours.price) {
      fail(
        'differential',
        `${ours.pharmacy.id} 的 price 不一致：decision=${String(theirs.price)}，verify=${String(ours.price)}`,
      );
    }
    if (theirs.capacityLeft !== ours.capacityLeft) {
      fail(
        'differential',
        `${ours.pharmacy.id} 的 capacityLeft 不一致：decision=${theirs.capacityLeft}，verify=${ours.capacityLeft}`,
      );
    }
  }
  for (const candidate of decision.candidates) {
    if (!evaluations.some((evaluation) => evaluation.pharmacy.id === candidate.pharmacy)) {
      fail('differential', `决策 candidates 里有本周 config 不存在的药房 ${candidate.pharmacy}`);
    }
  }
}

function renderOrderLine(
  orderId: string,
  atMs: number,
  order: NormalizedOrder,
  decision: DecisionRecord | undefined,
  runRow: RunLogRecord | undefined,
  verdict: string,
  failed: boolean,
): string {
  const chosen = decision?.chosen ?? runRow?.pharmacy ?? '?';
  const basis = decision?.basis ?? '?';
  const mark = failed ? '✗' : '✓';
  return (
    `${mark} ${orderId.padEnd(9)} ${etTimeLabel(atMs)}  ${order.state} ` +
    `${order.medication} ${order.dose} → ${chosen} (${basis})  ${verdict}`
  );
}

interface Summary extends VerifySummary {
  capacityLines: string[];
}

function summarize(
  model: VerifyModel,
  results: readonly { orderId: string; failures: string[] }[],
  failures: readonly string[],
  week: WeekModel,
): Summary {
  const byBasis: Record<string, number> = {};
  let sentToPharmacy = 0;
  let manual = 0;
  for (const decision of model.decisions) {
    byBasis[decision.basis] = (byBasis[decision.basis] ?? 0) + 1;
    if (decision.chosen === 'MANUAL') manual += 1;
    else sentToPharmacy += 1;
  }
  const failedOrders = results.filter((result) => result.failures.length > 0).length;
  const appliedEmails = new Set(model.facts.map((fact) => fact.eventId)).size;
  return {
    orders: week.orderSequence.length,
    sentToPharmacy,
    manual,
    byBasis,
    passedOrders: results.length - failedOrders,
    failedOrders,
    failureCount: failures.length,
    appliedFactCount: model.facts.length,
    appliedEmailCount: appliedEmails,
    capacityLines: renderCapacity(model, week),
  };
}

function renderCapacity(model: VerifyModel, week: WeekModel): string[] {
  const usage = buildSendLedger(model.runLog);
  const lines: string[] = [];
  for (const pharmacy of week.pharmacies) {
    const days = [...usage.keys()]
      .filter((key) => key.startsWith(`${pharmacy.id}|`))
      .map((key) => key.slice(pharmacy.id.length + 1))
      .sort();
    for (const day of days) {
      const times = usage.get(sendKey(pharmacy.id, day)) ?? [];
      // 有效容量取当天最后一单时刻的值（当天容量可能被邮件下调）。
      const atMs = times[times.length - 1] ?? startOfDayMs(day);
      const fact = resolveFact(
        model.facts,
        atMs,
        (item) => item.pharmacy === pharmacy.id && item.type === 'capacity',
      );
      const capacity = fact?.perDay ?? pharmacy.dailyCapacity;
      lines.push(
        `  ${pharmacy.id.padEnd(8)} ${day}: ${times.length}/${capacity}` +
          (times.length > capacity ? '（当天容量后来被下调，属安全侧行为）' : ''),
      );
    }
  }
  return lines;
}

function renderHeader(model: VerifyModel, summary: Summary): string[] {
  const { week } = model;
  const first = week.orderSequence[0];
  const firstAt = first === undefined ? week.startedAtMs : (week.orderEvents.get(first)?.occurredAtMs ?? week.startedAtMs);
  const last = week.orderSequence[week.orderSequence.length - 1];
  const lastAt = last === undefined ? week.startedAtMs : (week.orderEvents.get(last)?.occurredAtMs ?? week.startedAtMs);
  return [
    `verify: 独立安全求值（不 import src/；ET=${ET_ZONE}）`,
    `  输入：week 事件 ${week.eventCount} 条（email ${week.emailEventCount}）；` +
      `applied 邮件事实 ${summary.appliedFactCount} 条 / ${summary.appliedEmailCount} 封邮件（out/facts.jsonl）`,
    `  订单：${summary.orders} 单，事件时间范围 ${etTimeLabel(firstAt)} ~ ${etTimeLabel(lastAt)}；` +
      `药房 ${week.pharmacies.length} 家`,
  ];
}

function renderSummary(summary: Summary): string[] {
  const basis = Object.entries(summary.byBasis)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([name, count]) => `${name} ${count}`)
    .join(' / ');
  return [
    '汇总：',
    `  已发药房 ${summary.sentToPharmacy} 单；MANUAL ${summary.manual} 单；basis：${basis || '（无）'}`,
    `  通过 ${summary.passedOrders}/${summary.orders} 单；失败 ${summary.failedOrders} 单；失败明细 ${summary.failureCount} 条`,
    '',
    '容量（真实发单 / 有效日容量，按 ET 日；MANUAL 不占容量）：',
    ...(summary.capacityLines.length > 0 ? summary.capacityLines : ['  （无发单）']),
  ];
}

// ---------------------------------------------------------------------------
// 文件加载 + CLI
// ---------------------------------------------------------------------------

export interface CliOptions {
  weekFile: string;
  decisionsFile: string;
  runLogFile: string;
  factsFile: string;
  help: boolean;
}

const USAGE = `独立安全求值器（ARCHITECTURE §12.5）

用法：
  npm run verify
  node --experimental-transform-types --disable-warning=ExperimentalWarning scripts/verify.ts

输入路径（CLI 优先，其次环境变量，最后默认）：
  --week <path>        / WEEK_FILE        默认 sim/week-a.jsonl
  --decisions <path>   / DECISIONS_FILE   默认 out/decisions.jsonl
  --run-log <path>     / RUN_LOG_FILE     默认 out/run-log.jsonl
  --facts <path>       / FACTS_FILE       默认 out/facts.jsonl
  -h, --help

退出码：0 = 全部通过；1 = 有不安全/不一致；2 = 无法运行（缺文件或 week 配置坏）。
先跑完整周回放再 verify：
  LLM_MODE=replay npm start
  node sim/sim.mjs --target http://localhost:3000/webhooks
多次回放会让 out/*.jsonl 行叠加，重跑前先清空 out/。`;

function readOption(
  argv: readonly string[],
  flag: string,
  env: Record<string, string | undefined>,
  envName: string,
  fallback: string,
): string {
  const index = argv.indexOf(flag);
  if (index >= 0) {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new InputError(`${flag} 缺少路径参数`);
    }
    return value;
  }
  const fromEnv = env[envName];
  return fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : fallback;
}

/** 解析 CLI 参数与环境变量（导出以便测试）。 */
export function parseOptions(argv: readonly string[], env: Record<string, string | undefined>): CliOptions {
  return {
    weekFile: readOption(argv, '--week', env, 'WEEK_FILE', 'sim/week-a.jsonl'),
    decisionsFile: readOption(argv, '--decisions', env, 'DECISIONS_FILE', 'out/decisions.jsonl'),
    runLogFile: readOption(argv, '--run-log', env, 'RUN_LOG_FILE', 'out/run-log.jsonl'),
    factsFile: readOption(argv, '--facts', env, 'FACTS_FILE', 'out/facts.jsonl'),
    help: argv.includes('--help') || argv.includes('-h'),
  };
}

interface ResolvedPath {
  absolute: string;
  display: string;
}

function resolvePath(path: string): ResolvedPath {
  const absolute = posix.isAbsolute(path) ? path : posix.normalize(posix.join(process.cwd().split('\\').join('/'), path));
  return { absolute, display: path };
}

/** 读 JSONL；文件不存在或 JSON 坏了 → InputError（exit 2）。 */
export function loadJsonlRows(resolved: ResolvedPath, kind: string): unknown[] {
  if (!existsSync(resolved.absolute)) {
    if (kind === 'week') {
      throw new InputError(
        `找不到 week 文件：${resolved.display}\n` +
          `  verify 需要 week 文件里的 config 与订单事件。用 --week <path> 指定。`,
      );
    }
    throw new InputError(
      `找不到 ${resolved.display}（${kind}）。verify 需要整周回放的产物；请先跑完整周回放：\n` +
        `  1) LLM_MODE=replay npm start\n` +
        `  2) node sim/sim.mjs --target http://localhost:3000/webhooks\n` +
        `  然后重跑 npm run verify。若之前跑过多次，先清空 out/，避免旧行被追加进来。`,
    );
  }
  const text = readFileSync(resolved.absolute, 'utf8');
  const rows: unknown[] = [];
  text.split('\n').forEach((line, index) => {
    if (line.trim() === '') return;
    try {
      rows.push(JSON.parse(line));
    } catch {
      throw new InputError(`${resolved.display}:${index + 1} 不是合法 JSON`);
    }
  });
  return rows;
}

/** 主流程（同步）；返回退出码。导出以便测试。 */
export function runVerify(options: CliOptions): VerifyReport {
  const weekRows = loadJsonlRows(resolvePath(options.weekFile), 'week');
  const decisionRows = loadJsonlRows(resolvePath(options.decisionsFile), '决策审计');
  const runLogRows = loadJsonlRows(resolvePath(options.runLogFile), '发单日志');
  const factRows = loadJsonlRows(resolvePath(options.factsFile), '事实审计');
  return verifyFromRows({ weekRows, decisionRows, runLogRows, factRows });
}

/** 从原始 JSONL 行验证（导出给 `test/guards/verify-core.test.ts` 用合成数据测试）。 */
export function verifyFromRows(input: RawVerifyInput): VerifyReport {
  const inputFailures: string[] = [];
  const week = parseWeek(input.weekRows);
  const decisions = parseDecisions(input.decisionRows, Object.keys(week.catalogue), inputFailures);
  const runLog = parseRunLog(input.runLogRows, inputFailures);
  const facts = parseFacts(input.factRows, inputFailures);
  return verifyModel({ week, decisions, runLog, facts, inputFailures });
}

/** CLI 入口；返回 process.exitCode 的设置值。 */
export function main(argv: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): number {
  let options: CliOptions;
  try {
    options = parseOptions(argv, env);
  } catch (error) {
    console.error(`verify: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  let report: VerifyReport;
  try {
    report = runVerify(options);
  } catch (error) {
    if (error instanceof InputError) {
      console.error(`verify: ${error.message}`);
      return 2;
    }
    console.error(`verify: 内部错误：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    return 2;
  }
  console.log(report.lines.join('\n'));
  return report.exitCode;
}

const IS_MAIN = ((): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return pathToFileURL(entry).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (IS_MAIN) {
  process.exitCode = main();
}
