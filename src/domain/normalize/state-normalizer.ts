/**
 * `StateNormalizer`：把订单/邮件里出现的州写法归一化成两位 USPS 码
 * （`ARCHITECTURE.md` §5.3、`REQUIREMENTS.md` §3.1/§4.3）。
 *
 * 允许的规则只有两条：
 * 1. 两位 USPS 码，大小写不敏感，并去掉首尾空白（`TX`、`tx`、`" TX "` 都接受——
 *    `ARCHITECTURE.md` §5.3 明确允许 `"TX "`）；
 * 2. 50 州 + DC 的全名，大小写/内部空白不敏感（`Texas` → `TX`）。
 *
 * 明令禁止（§5.3 表格）：猜拼写、模糊匹配、接受上面两条以外的变体。
 * 因此 `Ontario`、`ZZ`、`Txs`、`Tex as` 一律失败，返回 `Normalized` 的失败分支。
 *
 * 州表是 C10 允许的「与周无关的知识」：把它写成显式常量不是硬编码——它是 USPS
 * 的固定事实，与本服务处理的是哪一周无关。
 */
import type { StateCode } from '../types.ts';
import type { Normalized } from '../types.ts';

/**
 * 全名 → 州码。键是「小写、首尾空白已去、内部连续空白压成一个空格」的规范形式。
 * 值只出现 50 州 + DC（下表恰有 51 项，单测钉住）。
 */
export const US_STATE_BY_NAME: Readonly<Record<string, StateCode>> = Object.freeze({
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
});

/** 合法州码集合（由全名表导出，保证两张表不会漂移）。 */
const USPS_STATE_CODES: ReadonlySet<StateCode> = new Set(Object.values(US_STATE_BY_NAME));

/** 只做空白/大小写规范化：去首尾、内部连续空白压成一个空格、转小写。 */
function normalizeKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

export class StateNormalizer {
  /**
   * @param raw 原始州写法；不是字符串时按空串处理（失败分支的 `raw` 用 `String(raw)`）。
   */
  normalize(raw: string): Normalized<StateCode> {
    const rawText = typeof raw === 'string' ? raw : String(raw ?? '');
    const key = rawText.trim();

    // 规则 1：两位 USPS 码（大小写不敏感、允许首尾空白）。
    const upper = key.toUpperCase();
    if (USPS_STATE_CODES.has(upper)) {
      return { ok: true, value: upper };
    }

    // 规则 2：50 州 + DC 的全名（大小写、内部空白不敏感）。
    const byName = US_STATE_BY_NAME[normalizeKey(rawText)];
    if (byName !== undefined) {
      return { ok: true, value: byName };
    }

    // 其余一律失败：不猜拼写、不做模糊/前缀匹配。
    return { ok: false, code: 'unknown_state', raw: rawText };
  }
}
