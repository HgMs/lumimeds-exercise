/**
 * `PhraseParser`：封闭短语的确定性时间解析（`ARCHITECTURE.md` §5.8、
 * `REQUIREMENTS.md` §4.4、`DATA-CONTRACTS.md` §4.3）。
 *
 * 为什么需要它：模型给的 `phrase` 是它抄下的原文时间措辞，日期却是它自己算的。
 * 用一个只认封闭词表的解析器独立复核，能把「until Wednesday 被抄成 Wednesday」
 * 这类方向性错误挡在落地之前。
 *
 * 规则（与 §5.8 的表一一对应）：
 *
 * | 短语 | rule | from | until |
 * |---|---|---|---|
 * | `(effective) immediately` | immediately | at（瞬时刻） | — |
 * | `today` | today | 今天 00:00 | 明天 00:00 |
 * | `tomorrow` | tomorrow | 明天 00:00 | 后天 00:00 |
 * | `yesterday` | yesterday | 昨天 00:00 | 今天 00:00 |
 * | `Wednesday` / `on Wednesday` | weekday | 该日 00:00 | — |
 * | `next Wednesday` | next_weekday | 严格晚于 at 的该星期 | — |
 * | `the rest of the week` / `end of week` | end_of_week | at | 下周一 00:00 |
 * | `until Wednesday` | until_weekday | —（验证器补 `at`） | 该日 00:00 |
 * | `from Wednesday` | from_weekday | 该日 00:00 | — |
 * | `back on Wednesday` | back_on_weekday | — | 该日 00:00 |
 *
 * 关键不变量：
 * - **只吃 `at`，不读进程时钟**；相对日期都在 ET 由 `EtCalendar` 算。
 * - **锚定整串**：短语必须被封闭子句完全覆盖，允许 `effective`/`on`/`the`/`for` 等
 *   连接词与标点、大小写差异；有一截认不出就返回 `null`（不猜）。
 * - **组合子句**（W3）：一句话可以同时命中 from 与 until 两个子句，
 *   `"from tomorrow … for the rest of the week"` → from=明天 00:00、
 *   until=下周一 00:00。解析器只报告它**实际解析出**的字段，未解析的字段不碰。
 * - `until` 是排他边界（当天 00:00 结束）。
 * - 与模型日期的一致性检查不在这里（`FactValidator` 第 9 步）。
 */
import { EtCalendar } from '../../kernel/time/et-calendar.ts';
import type { EtDate } from '../../kernel/time/et-date.ts';
import type { Instant } from '../../kernel/time/instant.ts';

/** 命中的子句类型（§5.8 的封闭集合）。 */
export type PhraseRule =
  | 'immediately'
  | 'today'
  | 'tomorrow'
  | 'yesterday'
  | 'weekday'
  | 'next_weekday'
  | 'end_of_week'
  | 'until_weekday'
  | 'from_weekday'
  | 'back_on_weekday';

/**
 * 一个时间字段：既带「粒度」也带 ET 日期。
 *
 * - `kind: 'instant'`：解析器给的是瞬时刻（`immediately` 的 `at`、`the rest of the
 *   week` 的 `at`），`instant` 必有。
 * - `kind: 'day'`：解析器给的是 ET 日边界（`tomorrow` 的 00:00 等）。这里只存日期，
 *   由验证器换算成 `startOfDay`，避免同一个日期在两种表示之间漂移。
 *
 * 两种粒度都带 `date`，供与模型给的 `YYYY-MM-DD` 按 **ET 日期**比对（W1）。
 */
export interface PhraseDate {
  kind: 'instant' | 'day';
  instant?: Instant;
  date: EtDate;
  rule: PhraseRule;
}

/** 一条 `phrase` 的解析结果；from/until 各自独立，可能只命中一个。 */
export interface PhraseTemporal {
  from?: PhraseDate;
  until?: PhraseDate;
  /** 命中的子句（按出现顺序，可能两个）。 */
  rules: PhraseRule[];
}

/** 星期名 → 0=周日 … 6=周六（与 `EtCalendar.weekdayOf` 一致）。 */
const WEEKDAY_NAMES: ReadonlyMap<string, number> = new Map([
  ['sunday', 0],
  ['monday', 1],
  ['tuesday', 2],
  ['wednesday', 3],
  ['thursday', 4],
  ['friday', 5],
  ['saturday', 6],
]);

/** 三个相对日名词 → 相对 `at` 的 ET 日期偏移。 */
const DAY_WORDS: ReadonlyMap<string, number> = new Map([
  ['yesterday', -1],
  ['today', 0],
  ['tomorrow', 1],
]);

/** 归一化后允许被跳过的连接词（不含 `until`/`from`/`back`，它们是子句的一部分）。 */
const CONNECTORS = /^(?:effective|starting|beginning|and|for|on|the|please)\b\s*/;

/** 归一化：小写、引号与标点变空格、压空白。`…` / `...` / 破折号都变成分隔符。 */
function normalize(phrase: string): string {
  return phrase
    .toLowerCase()
    .replace(/[’'`"“”]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

interface ParseContext {
  at: Instant;
  atDate: EtDate;
  calendar: EtCalendar;
}

/** 命中一个子句后：消耗的字符数 + 新增的 from/until + 规则。 */
interface ClauseResult {
  length: number;
  rule: PhraseRule;
  from?: PhraseDate;
  until?: PhraseDate;
}

type ClauseMatcher = (text: string, ctx: ParseContext) => ClauseResult | null;

/** 子句匹配器，顺序即优先级（长/特殊子句在前，避免被短子句吃掉）。 */
const MATCHERS: readonly ClauseMatcher[] = [
  // from tomorrow / from today / from yesterday —— 只定起点，区间开放（不是整天）。
  (text, ctx) => {
    const m = /^from (today|tomorrow|yesterday)\b/.exec(text);
    if (m === null) return null;
    return {
      length: m[0].length,
      rule: m[1] as PhraseRule,
      from: dayDate(ctx, DAY_WORDS.get(m[1]) as number, m[1] as PhraseRule),
    };
  },
  // from next Wednesday —— 只定起点，严格晚于 at。
  (text, ctx) => {
    const m = /^from next (sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.exec(text);
    if (m === null) return null;
    return {
      length: m[0].length,
      rule: 'next_weekday',
      from: weekdayDate(ctx, m[1], 'next_weekday', true),
    };
  },
  // from Wednesday —— 只定起点，取不早于 at 的该星期（收到当天就是当天）。
  (text, ctx) => {
    const m = /^from (sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.exec(text);
    if (m === null) return null;
    return {
      length: m[0].length,
      rule: 'from_weekday',
      from: weekdayDate(ctx, m[1], 'from_weekday', false),
    };
  },
  // immediately —— 瞬时刻。
  (text, ctx) => {
    const m = /^immediately\b/.exec(text);
    if (m === null) return null;
    return {
      length: m[0].length,
      rule: 'immediately',
      from: { kind: 'instant', instant: ctx.at, date: ctx.atDate, rule: 'immediately' },
    };
  },
  // next Wednesday —— 严格晚于 at 的该星期（Q8：更早生效 = 更早停发）。
  (text, ctx) => {
    const m = /^next (sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.exec(text);
    if (m === null) return null;
    return {
      length: m[0].length,
      rule: 'next_weekday',
      from: weekdayDate(ctx, m[1], 'next_weekday', true),
    };
  },
  // back on Wednesday —— 只定终点（恢复营业/有货的时刻）。
  (text, ctx) => {
    const m = /^back on (sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.exec(text);
    if (m === null) return null;
    return {
      length: m[0].length,
      rule: 'back_on_weekday',
      until: weekdayDate(ctx, m[1], 'back_on_weekday', false),
    };
  },
  // until Wednesday —— 只定终点；`from` 由验证器缺省成 `at`（"from 未解析 → 默认 at"）。
  (text, ctx) => {
    const m = /^until (sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.exec(text);
    if (m === null) return null;
    return {
      length: m[0].length,
      rule: 'until_weekday',
      until: weekdayDate(ctx, m[1], 'until_weekday', false),
    };
  },
  // the rest of the week / end of the week —— 到下一个周一 00:00；from 只在没有别的起点时取 at。
  (text, ctx) => {
    const m =
      /^(?:for )?(?:the )?(?:rest of (?:the |this )?week|end of (?:the |this )?week)\b/.exec(text);
    if (m === null) return null;
    const nextMonday = ctx.calendar.nextMonday(ctx.atDate);
    return {
      length: m[0].length,
      rule: 'end_of_week',
      from: { kind: 'instant', instant: ctx.at, date: ctx.atDate, rule: 'end_of_week' },
      until: { kind: 'day', date: nextMonday, rule: 'end_of_week' },
    };
  },
  // today / tomorrow / yesterday —— 整天区间。
  (text, ctx) => {
    const m = /^(today|tomorrow|yesterday)\b/.exec(text);
    if (m === null) return null;
    const word = m[1];
    const offset = DAY_WORDS.get(word) as number;
    return {
      length: m[0].length,
      rule: word as PhraseRule,
      from: dayDate(ctx, offset, word as PhraseRule),
      until: dayDate(ctx, offset + 1, word as PhraseRule),
    };
  },
  // Wednesday / on Wednesday —— 只定起点（该日 00:00）。
  (text, ctx) => {
    const m = /^(?:on )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.exec(text);
    if (m === null) return null;
    return {
      length: m[0].length,
      rule: 'weekday',
      from: weekdayDate(ctx, m[1], 'weekday', false),
    };
  },
];

/** `at` 的 ET 日期 + 偏移天数的 00:00 边界。 */
function dayDate(ctx: ParseContext, offset: number, rule: PhraseRule): PhraseDate {
  return { kind: 'day', date: ctx.calendar.addDays(ctx.atDate, offset), rule };
}

/**
 * 星期几对应的 ET 日边界。
 *
 * @param strict true = 严格晚于 `at`（`next`）；false = 不早于 `at`（`Wednesday`/`from`）。
 */
function weekdayDate(
  ctx: ParseContext,
  name: string,
  rule: PhraseRule,
  strict: boolean,
): PhraseDate {
  const weekday = WEEKDAY_NAMES.get(name);
  if (weekday === undefined) {
    // 正则已限定词表，走到这里意味着实现 bug；抛错而不是静默返回错误日期。
    throw new Error(`PhraseParser: unknown weekday ${JSON.stringify(name)}`);
  }
  const date = strict
    ? ctx.calendar.nextWeekdayAfter(ctx.atDate, weekday)
    : ctx.calendar.nextOrSameWeekday(ctx.atDate, weekday);
  return { kind: 'day', date, rule };
}

/**
 * 封闭短语解析器。构造只注入日历（不读时钟）；`parse` 是纯函数：
 * 同一 `(phrase, at)` 永远同一结论。
 */
export class PhraseParser {
  constructor(private readonly calendar: EtCalendar) {}

  /**
   * 解析一条时间措辞；认不出（或只认出半句）返回 `null`，由验证器按
   * 「短语未命中」处理，绝不做模糊猜测。
   */
  parse(phrase: string | null | undefined, at: Instant): PhraseTemporal | null {
    if (typeof phrase !== 'string') return null;
    let rest = normalize(phrase);
    if (rest === '') return null;

    const ctx: ParseContext = { at, atDate: this.calendar.dateOf(at), calendar: this.calendar };
    let from: PhraseDate | undefined;
    let until: PhraseDate | undefined;
    const rules: PhraseRule[] = [];

    // 反复从当前位置吃掉一个子句或一个连接词；整串必须被完全消费（锚定整串）。
    while (rest !== '') {
      let matched = false;
      for (const matcher of MATCHERS) {
        const hit = matcher(rest, ctx);
        if (hit === null) continue;
        rest = rest.slice(hit.length).trim();
        // 后出现的子句覆盖同字段（"tomorrow until Friday" 的 until 以 Friday 为准）；
        // 已经由显式子句给出的 from 不被 end_of_week 的兜底 from=at 覆盖。
        if (hit.from !== undefined && from === undefined) from = hit.from;
        if (hit.until !== undefined) until = hit.until;
        rules.push(hit.rule);
        matched = true;
        break;
      }
      if (matched) continue;

      const connector = CONNECTORS.exec(rest);
      if (connector !== null) {
        rest = rest.slice(connector[0].length).trim();
        continue;
      }

      // 有一截认不出：整条短语作废（不猜）。
      return null;
    }

    if (from === undefined && until === undefined) return null;
    return {
      ...(from === undefined ? {} : { from }),
      ...(until === undefined ? {} : { until }),
      rules,
    };
  }
}
