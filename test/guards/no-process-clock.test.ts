/**
 * 无进程时钟守卫（`ARCHITECTURE.md` §7 INV-1、§10「时间模型细则」、§12.1「守卫」层）。
 *
 * 业务「现在」只有一个来源：事件信封里的 `occurred_at`（`sim/README.md` 的 Time 一节：
 * "Now is the event's occurred_at. Never use the computer's clock"）。因此
 * `src/kernel/` 与 `src/domain/` 里**不许**出现：
 *
 * - `Date.now(...)` —— 进程墙钟；
 * - **无参** `new Date()` —— 进程墙钟（`new Date(epochMs)` / `new Date(iso)` 是显式传值，
 *   允许；`EtCalendar` 内部正是靠它把毫秒换成 Intl 可解析的 Date）。
 *
 * 明确允许（写在这里，避免以后被"顺手"删掉）：
 *
 * - `Date.UTC(...)`：纯算术，不是时钟；
 * - `new Date(x)`：用显式传入的时间值构造；
 * - **`performance.now()`**：`kernel/deadline.ts` 的唯一职责是「单事件时间预算」，
 *   它量的是**真实流逝时间**（LLM/发单的墙钟预算），不参与任何业务判定。
 *   预算不是「业务现在」，所以这里白名单放行——它也不会出现在 `domain/`。
 *
 * 扫描前剥离注释（`source-scan.ts` 的 `stripComments`）：注释里写 `Date.now()` 是在解释
 * 规则，不是违规。文件末尾的「模式自检」用例同时钉住「该抓的抓、不该抓的不抓」。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { findPattern, layerOf, listSourceFiles, makeSourceFile, stripComments } from './source-scan.ts';

const files = listSourceFiles();

/** 只守 `kernel/` 与 `domain/`（INV-1 的落点）。 */
const CLOCK_FREE_LAYERS = new Set(['kernel', 'domain']);

/** 违规模式：返回 `[label, pattern]`。 */
const FORBIDDEN: Array<[string, RegExp]> = [
  ['Date.now(', /Date\.now\s*\(/g],
  ['无参 new Date()', /new\s+Date\s*\(\s*\)/g],
];

interface ClockViolation {
  file: string;
  line: number;
  label: string;
  text: string;
}

function scanClockViolations(sourceFile: Parameters<typeof findPattern>[0]): ClockViolation[] {
  const violations: ClockViolation[] = [];
  for (const [label, pattern] of FORBIDDEN) {
    for (const hit of findPattern(sourceFile, pattern)) {
      violations.push({ file: sourceFile.rel, line: hit.line, label, text: hit.text });
    }
  }
  return violations;
}

describe('无进程时钟守卫（ARCHITECTURE §7 INV-1）', () => {
  it('src/kernel/ 与 src/domain/ 不出现 Date.now( 与无参 new Date()', () => {
    const violations = files
      .filter((file) => CLOCK_FREE_LAYERS.has(layerOf(file.rel)))
      .flatMap(scanClockViolations)
      .sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));

    const rendered = violations.map(
      (v) => `${v.file}:${v.line}: [INV-1] 出现 ${v.label}（${v.text}）`,
    );
    assert.equal(
      violations.length,
      0,
      'kernel/domain 必须用显式传入的 Instant，不得读进程时钟：\n' + rendered.join('\n'),
    );
  });

  it('守卫扫到的是真实的 kernel/domain 源码（防止空集静默通过）', () => {
    const scanned = files.filter((file) => CLOCK_FREE_LAYERS.has(layerOf(file.rel)));
    assert.ok(
      scanned.some((file) => file.rel.endsWith('src/kernel/time/instant.ts')),
      '守卫应覆盖 src/kernel/time/instant.ts',
    );
    assert.ok(
      scanned.some((file) => file.rel.endsWith('src/domain/routing/router.ts')),
      '守卫应覆盖 src/domain/routing/router.ts',
    );
  });

  it('允许项不被误报：Date.UTC / new Date(x) / performance.now()', () => {
    const sample = makeSourceFile(
      'src/kernel/time/sample.ts',
      [
        'const a = new Date(epochMs);',
        'const b = new Date("2026-11-10T08:00:00-05:00");',
        'const c = Date.UTC(2026, 10, 10);',
        'const d = performance.now();',
        'const e = Math.floor(performance.now() - t0);',
      ].join('\n'),
    );
    assert.deepEqual(scanClockViolations(sample), []);
  });

  it('违规项确实被识别（扫描器自检）', () => {
    const sample = makeSourceFile(
      'src/domain/sample.ts',
      ['const a = Date.now();', 'const b = new Date();', 'const c = new Date(  ) ;'].join('\n'),
    );
    const violations = scanClockViolations(sample);
    assert.equal(violations.length, 3, JSON.stringify(violations));
    assert.deepEqual(
      violations.map((v) => v.line),
      [1, 2, 3],
    );
  });

  it('注释里的 Date.now()/new Date() 不算违规（注释剥离生效）', () => {
    const stripped = stripComments(
      [
        '// 不要用 Date.now()，也不要用 new Date()',
        '/* 块注释：Date.now() / new Date() */',
        'const ok = new Date(instant.epochMs);',
      ].join('\n'),
    );
    const sample = makeSourceFile('src/domain/sample.ts', stripped);
    assert.deepEqual(scanClockViolations(sample), []);
  });

  it('performance.now() 只允许出现在 kernel/deadline.ts（预算用途，不参与业务判定）', () => {
    /** deadline.ts 是唯一被允许量真实流逝时间的地方（§5.1：C1/INV-1 的唯一例外）。 */
    const ALLOWED_REAL_CLOCK_FILE = 'src/kernel/deadline.ts';
    const violations: string[] = [];
    for (const file of files) {
      if (!CLOCK_FREE_LAYERS.has(layerOf(file.rel))) continue;
      if (file.rel === ALLOWED_REAL_CLOCK_FILE) continue;
      for (const hit of findPattern(file, /performance\s*\.\s*now\s*\(/g)) {
        violations.push(`${file.rel}:${hit.line}: [INV-1] 只有 kernel/deadline.ts 可以读真实时钟（${hit.text}）`);
      }
    }
    assert.equal(
      violations.length,
      0,
      'performance.now() 是 Deadline 的预算专用例外，不得用于业务时间：\n' + violations.join('\n'),
    );
  });
});
