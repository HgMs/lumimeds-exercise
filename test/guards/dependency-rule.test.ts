/**
 * 依赖方向守卫（`ARCHITECTURE.md` §2.1 R1–R5、§7 INV-9/INV-10、§12.1「守卫」层）。
 *
 * 规则（`ARCHITECTURE.md` §2.1，原文为准）：
 *
 * - **R1** `kernel/` 不 import 任何内部其他层，也不 import `node:fs`/`node:http`/`node:net`。
 *   （本守卫更严：kernel 零外部依赖——它必须能脱离 Node IO 单独测试；目前实现确实如此。）
 * - **R2** `domain/` 只 import `kernel/` 与 `domain/` 自己；`fetch`/`process`/`require` 等
 *   IO 入口即违规（INV-9「domain 无 IO」）。
 * - **R3** `application/` 可以 import `domain/`/`kernel/`/`application/`，但不得 import
 *   `adapters/`、`interfaces/`、`wiring/`；外部世界只能经 `application/ports/` 的接口触达，
 *   所以它也不 import Node 内置模块或第三方包。
 * - **R4** `adapters/` 与 `interfaces/` 只能 import `application/`（含 ports）、`domain/`、
 *   `kernel/`、自己的层，以及 Node 内置/第三方包（它们就是外部世界的实现）。
 * - **R5** 只有 `wiring/`（含根入口 `src/index.ts`）可以同时看到 `adapters/` 与
 *   `interfaces/`；任何非 wiring 文件同时依赖这两层都是违规。
 *
 * 失败信息格式：`src/domain/x.ts:12: [R2] ...`——可直接点开文件行。所有违规聚合成一条
 * 断言消息，一次跑出全部问题，而不是「改一条、再跑一次」。
 *
 * 另外两条独立守卫（INV-10 / §12.5 的可验证部分）也在本文件：
 * - `OrderRouter` 的构造依赖里没有 `LlmExtractor`（见 `no-llm-in-router.test.ts` 是主守卫，
 *   这里只查 import 图：`domain/routing/` 不依赖 LLM 端口）；
 * - `scripts/verify.ts` 不 import `src/`（§12.5 要求它独立实现，否则就只是「代码等于它自
 *   己」）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { describe, it } from 'node:test';

import {
  REPO_ROOT,
  classifySpecifier,
  findPattern,
  layerOf,
  listSourceFiles,
  scanImports,
} from './source-scan.ts';
import type { ClassifiedSpecifier, Layer, SourceFile } from './source-scan.ts';

const files = listSourceFiles();

/** 分层允许的**内部**目标层；`'*'` = 不限制。 */
const ALLOWED_INTERNAL: Record<Layer, readonly Layer[] | '*'> = {
  kernel: ['kernel'],
  domain: ['kernel', 'domain'],
  application: ['application', 'domain', 'kernel'],
  adapters: ['adapters', 'application', 'domain', 'kernel'],
  interfaces: ['interfaces', 'application', 'domain', 'kernel'],
  wiring: '*',
  env: ['kernel', 'domain'],
  unknown: '*',
};

/** 该层是否允许 import Node 内置模块/第三方包（外部世界）。 */
const ALLOWED_EXTERNAL: Record<Layer, boolean> = {
  kernel: false,
  domain: false,
  application: false,
  adapters: true,
  interfaces: true,
  wiring: true,
  env: true,
  unknown: true,
};

/** 层 → 该层的规则号（用于失败信息）。 */
const RULE_OF_LAYER: Partial<Record<Layer, string>> = {
  kernel: 'R1',
  domain: 'R2',
  application: 'R3',
  adapters: 'R4',
  interfaces: 'R4',
  env: 'R2/§5.1',
};

interface ImportViolation {
  file: string;
  line: number;
  rule: string;
  message: string;
}

/** 检查单个文件的全部 import 是否符合它的分层规则。 */
function checkFileImports(file: SourceFile): ImportViolation[] {
  const layer = layerOf(file.rel);
  const violations: ImportViolation[] = [];
  const allowedInternal = ALLOWED_INTERNAL[layer];
  const externalAllowed = ALLOWED_EXTERNAL[layer];
  const rule = RULE_OF_LAYER[layer] ?? '§2.1';

  for (const ref of scanImports(file)) {
    const target: ClassifiedSpecifier = classifySpecifier(file.rel, ref.specifier);

    if (target.kind === 'internal') {
      if (allowedInternal === '*') continue;
      if (allowedInternal.includes(target.layer)) continue;
      violations.push({
        file: file.rel,
        line: ref.line,
        rule,
        message:
          `[${rule}] ${layer}/ 不得 import ${target.layer}/（'${ref.specifier}' → ${target.rel}）`,
      });
      continue;
    }

    if (externalAllowed) continue;
    const kind = target.kind === 'node' ? `Node 内置模块 '${ref.specifier}'` : `第三方包 '${ref.specifier}'`;
    violations.push({
      file: file.rel,
      line: ref.line,
      rule,
      message:
        `[${rule}] ${layer}/ 不得直接依赖${kind}；` +
        (layer === 'application'
          ? '外部世界只能经 application/ports/ 的接口触达'
          : '纯逻辑层必须无 IO、可离线测试'),
    });
  }
  return violations;
}

function sortViolations(violations: ImportViolation[]): ImportViolation[] {
  return violations.sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1,
  );
}

function render(violations: ImportViolation[]): string {
  return violations.map((v) => `${v.file}:${v.line}: ${v.message}`).join('\n');
}

function checkLayer(layer: Layer): ImportViolation[] {
  return sortViolations(
    files.filter((file) => layerOf(file.rel) === layer).flatMap(checkFileImports),
  );
}

describe('依赖方向守卫（ARCHITECTURE §2.1 R1–R5）', () => {
  it('src/ 至少包含预期分层目录（防止守卫在空目录上静默通过）', () => {
    const layers = new Set(files.map((file) => layerOf(file.rel)));
    assert.ok(layers.has('kernel'), 'src/kernel/ 必须存在');
    assert.ok(layers.has('domain'), 'src/domain/ 必须存在');
    assert.ok(layers.has('application'), 'src/application/ 必须存在');
    assert.ok(layers.has('adapters'), 'src/adapters/ 必须存在');
    assert.ok(files.length > 20, `src/ 只扫到 ${files.length} 个 .ts 文件，守卫可能扫错了目录`);
  });

  it('R1 kernel/ 只 import kernel/ 自身，且不 import Node 内置模块', () => {
    const violations = checkLayer('kernel');
    assert.equal(violations.length, 0, `kernel/ 违反 R1：\n${render(violations)}`);
  });

  it('R2 domain/ 只 import kernel/ 与 domain/，不 import Node 内置模块', () => {
    const violations = checkLayer('domain');
    assert.equal(violations.length, 0, `domain/ 违反 R2：\n${render(violations)}`);
  });

  it('R3 application/ 不 import adapters/ interfaces/ wiring/，也不直接 import Node/第三方包', () => {
    const violations = checkLayer('application');
    assert.equal(violations.length, 0, `application/ 违反 R3：\n${render(violations)}`);
  });

  it('R4 adapters/ 与 interfaces/ 不 import wiring/，两者也不互相 import', () => {
    const violations = sortViolations([...checkLayer('adapters'), ...checkLayer('interfaces')]);
    assert.equal(violations.length, 0, `adapters/interfaces 违反 R4：\n${render(violations)}`);
  });

  it('R5 只有 wiring/（含根入口 src/index.ts）能同时看到 adapters/ 与 interfaces/', () => {
    const violations: ImportViolation[] = [];
    for (const file of files) {
      const layer = layerOf(file.rel);
      if (layer === 'wiring' || layer === 'unknown') continue;
      const importedLayers = new Set(
        scanImports(file)
          .map((ref) => classifySpecifier(file.rel, ref.specifier))
          .map((target) => (target.kind === 'internal' ? target.layer : undefined))
          .filter((target): target is Layer => target !== undefined),
      );
      if (importedLayers.has('adapters') && importedLayers.has('interfaces')) {
        const line =
          scanImports(file).find((ref) => {
            const target = classifySpecifier(file.rel, ref.specifier);
            return target.kind === 'internal' && (target.layer === 'adapters' || target.layer === 'interfaces');
          })?.line ?? 1;
        violations.push({
          file: file.rel,
          line,
          rule: 'R5',
          message: `[R5] ${layer}/ 同时 import 了 adapters/ 与 interfaces/；只有 wiring/ 可以同时看到这两层`,
        });
      }
    }
    assert.equal(violations.length, 0, `违反 R5：\n${render(violations)}`);
  });

  it('INV-9 domain/ 无 IO 入口：不出现 fetch( / require( / process.*', () => {
    const domainFiles = files.filter((file) => layerOf(file.rel) === 'domain');
    const forbidden: Array<{ pattern: RegExp; label: string }> = [
      { pattern: /\bfetch\s*\(/, label: 'fetch(' },
      { pattern: /\brequire\s*\(/, label: 'require(' },
      { pattern: /\bprocess\s*\./, label: 'process.*' },
    ];
    const problems: string[] = [];
    for (const file of domainFiles) {
      for (const { pattern, label } of forbidden) {
        for (const hit of findPattern(file, pattern)) {
          problems.push(`${file.rel}:${hit.line}: [INV-9] domain/ 不得出现 ${label}（${hit.text}）`);
        }
      }
    }
    assert.equal(problems.length, 0, `domain/ 违反 INV-9：\n${problems.join('\n')}`);
  });

  it('INV-10 domain/routing/ 的 import 图里没有 LLM 端口/适配器', () => {
    const problems: string[] = [];
    for (const file of files.filter((item) => item.rel.startsWith('src/domain/routing/'))) {
      for (const ref of scanImports(file)) {
        if (/llm/i.test(ref.specifier) || ref.specifier.includes('adapters')) {
          problems.push(
            `${file.rel}:${ref.line}: [INV-10] routing/ 不得依赖 LLM 或适配器（'${ref.specifier}'）`,
          );
        }
      }
    }
    assert.equal(problems.length, 0, `routing/ 违反 INV-10：\n${problems.join('\n')}`);
  });

  it('scripts/verify.ts 独立实现：不 import src/ 下的任何模块（ARCHITECTURE §12.5）', () => {
    const verifyPath = posix.join(REPO_ROOT, 'scripts', 'verify.ts');
    const raw = readFileSync(verifyPath, 'utf8');
    const file: SourceFile = { rel: 'scripts/verify.ts', abs: verifyPath, raw, code: raw };
    const problems: string[] = [];
    for (const ref of scanImports(file)) {
      if (ref.specifier.startsWith('.') && !ref.specifier.startsWith('node:')) {
        const resolved = posix.normalize(posix.join('scripts', ref.specifier));
        if (resolved === 'src' || resolved.startsWith('src/')) {
          problems.push(
            `scripts/verify.ts:${ref.line}: [§12.5] verify 必须独立实现，不得 import '${ref.specifier}'`,
          );
        }
      }
    }
    assert.equal(problems.length, 0, `verify 独立性被破坏：\n${problems.join('\n')}`);
  });
});
