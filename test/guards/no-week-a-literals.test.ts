/**
 * 「src/ 里无 week A 字面量」守卫（`ARCHITECTURE.md` §7 INV-12、§12.1「守卫」层）。
 *
 * week A（`sim/week-a.jsonl`）是**测试输入**，不是实现知识。`src/` 里出现下面任何东西，
 * 都说明实现把某一条 week A 事实写死了，于是换一周就错、或者「重放通过」是假的：
 *
 * | 类别 | 模式 | 例子 |
 * |---|---|---|
 * | 订单号 | `ORD-\\d+` | `ORD-1001` |
 * | 事件号 | `evt_\\d+` | `evt_001` |
 * | week A 日期 | `2026-11-\\d{2}` | `2026-11-09` |
 * | 药房 id/显示名 | `TANDREL`/`VELMORA`/`CORVANE`/`ISHBY`/`WRENFOLD`（大小写不敏感） | `Tandrel Rx` |
 * | week A 邮箱 | `@tandrel.example` 等 5 家 + ops 的 `@lumimeds.example` | `jen@tandrel.example` |
 *
 * **唯一白名单（刻意最小化）**：`src/kernel/time/et-calendar.ts` 的 `selfTest()` 里，
 * `ARCHITECTURE.md` §5.1 要求用两个探针日期验证 Intl/DST：
 * `2026-11-09`（EST 的 `-05:00`）与 `2026-11-01`（DST 结束的 `-04:00`）。
 * 该文件**只**放行这两个完整日期 token；药房名、`ORD-`、`evt_` 仍然不允许。
 * 白名单只对**这一个文件**生效，其它文件出现日期一律违规。
 *
 * 扫描只覆盖**代码与字符串字面量**（注释先剥离，见 `source-scan.ts`）：注释里的举例日期
 * 不是运行时代码，不进入判定——这也正是白名单能一直保持"只有两个探针日期"的原因。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { findPattern, listSourceFiles, makeSourceFile } from './source-scan.ts';
import type { PatternHit } from './source-scan.ts';

const files = listSourceFiles();

interface LiteralRule {
  label: string;
  pattern: RegExp;
}

const RULES: LiteralRule[] = [
  { label: '订单号 ORD-\\d', pattern: /\bORD-\d+/g },
  { label: '事件号 evt_\\d', pattern: /\bevt_\d+/g },
  { label: 'week A 日期 2026-11-\\d{2}', pattern: /2026-11-\d{2}/g },
  {
    label: 'week A 药房 id/显示名（TANDREL/VELMORA/CORVANE/ISHBY/WRENFOLD）',
    pattern: /\b(?:TANDREL|VELMORA|CORVANE|ISHBY|WRENFOLD)\b/gi,
  },
  {
    label: 'week A 邮箱（@tandrel.example 等 / @lumimeds.example）',
    pattern: /@(?:tandrel|velmora|corvane|ishby|wrenfold|lumimeds)\.example\b/gi,
  },
];

/**
 * 白名单：`文件` → 允许出现的完整日期 token 集合。
 * 只放 selfTest 的两个探针日期（§5.1），不放药房名/订单号/事件号。
 */
const DATE_WHITELIST = new Map<string, ReadonlySet<string>>([
  ['src/kernel/time/et-calendar.ts', new Set(['2026-11-09', '2026-11-01'])],
]);

function isWhitelistedDate(fileRel: string, token: string): boolean {
  return DATE_WHITELIST.get(fileRel)?.has(token) === true;
}

interface Violation {
  file: string;
  line: number;
  rule: string;
  text: string;
}

/** 全部违规（日期按 white-list 逐 token 判定，其余规则一律违规）。 */
function findViolations(sourceFiles: typeof files): Violation[] {
  const violations: Violation[] = [];
  for (const file of sourceFiles) {
    for (const rule of RULES) {
      const isDateRule = rule.label.startsWith('week A 日期');
      for (const hit of findPattern(file, rule.pattern)) {
        if (isDateRule && isWhitelistedDate(file.rel, hit.match)) continue;
        violations.push({ file: file.rel, line: hit.line, rule: rule.label, text: hit.text });
      }
    }
  }
  return violations.sort((a, b) =>
    a.file === b.file ? (a.line === b.line ? 0 : a.line - b.line) : a.file < b.file ? -1 : 1,
  );
}

describe('无 week A 字面量守卫（ARCHITECTURE §7 INV-12）', () => {
  it('src/ 不含 week A 硬编码（唯一白名单：et-calendar.ts 两个 selfTest 探针日期）', () => {
    const violations = findViolations(files);
    const rendered = violations.map((v) => `${v.file}:${v.line}: [INV-12] ${v.rule}（${v.text}）`);
    assert.equal(
      violations.length,
      0,
      'src/ 不得硬编码 week A 数据；请把事实来源改成 config/facts，而不是写死：\n' + rendered.join('\n'),
    );
  });

  it('白名单确实只服务 et-calendar.ts 的两个 DST/Intl 探针日期', () => {
    const calendar = files.find((file) => file.rel === 'src/kernel/time/et-calendar.ts');
    assert.ok(calendar !== undefined, 'src/kernel/time/et-calendar.ts 必须存在（§5.1 selfTest）');
    const dateTokens = findPattern(calendar, /2026-11-\d{2}/g).map((hit: PatternHit) => hit.match);
    const distinct = [...new Set(dateTokens)].sort();
    assert.deepEqual(
      distinct,
      ['2026-11-01', '2026-11-09'],
      'et-calendar.ts 的 selfTest 只应包含 §5.1 要求的两个探针日期（2026-11-09 / 2026-11-01）',
    );
    for (const token of dateTokens) {
      assert.ok(
        isWhitelistedDate('src/kernel/time/et-calendar.ts', token),
        `白名单遗漏了 ${token}`,
      );
    }
  });

  it('白名单之外的日期一律违规（例如 2026-11-10 被写进代码就失败）', () => {
    const sample = makeSourceFile('src/domain/sample.ts', "const x = '2026-11-10';\n");
    const violations = findViolations([sample]);
    assert.equal(violations.length, 1, JSON.stringify(violations));
    assert.equal(violations[0]!.file, 'src/domain/sample.ts');
    assert.equal(violations[0]!.line, 1);
  });

  it('药房名/订单号/事件号即使出现在 et-calendar.ts 的白名单文件里也不放行', () => {
    const sample = makeSourceFile(
      'src/kernel/time/et-calendar.ts',
      "const a = '2026-11-09';\nconst b = 'TANDREL';\nconst c = 'ORD-1001';\nconst d = 'evt_001';\n",
    );
    const violations = findViolations([sample]);
    assert.deepEqual(
      violations.map((v) => v.line),
      [2, 3, 4],
    );
  });

  it('注释里的 week A 举例不算违规（注释剥离生效）', () => {
    const stripped = makeSourceFile(
      'src/domain/sample.ts',
      [
        '// 例如 ORD-1001 发到 TANDREL，日期 2026-11-09',
        '/* evt_001 / VELMORA / 2026-11-10 都只出现在注释里 */',
        'export const keep = true;',
      ].join('\n'),
    );
    assert.deepEqual(findViolations([stripped]), []);
  });

  it('每条规则都能抓到东西（扫描器自检）', () => {
    const sample = makeSourceFile(
      'src/domain/sample.ts',
      [
        'const order = "ORD-1001";',
        'const event = "evt_003";',
        'const pharmacy = "CORVANE";',
        'const mail = "sam@lumimeds.example";',
        'const week = "2026-11-09";',
      ].join('\n'),
    );
    const violations = findViolations([sample]);
    assert.equal(violations.length, RULES.length, JSON.stringify(violations));
    assert.deepEqual(
      violations.map((v) => v.line),
      [1, 2, 3, 4, 5],
    );
  });
});
