/**
 * 「路由不经 LLM」守卫（`ARCHITECTURE.md` §7 INV-10、§5.7、§2.1 R2、§12.1「守卫」层）。
 *
 * INV-10：**邮件必经 LLM；路由不经 LLM。** 订单是结构化数据（`REQUIREMENTS.md` §5 末段），
 * `OrderRouter` 的输入只有归一化订单、信念与偏好；它不持有 `LlmExtractor`、不 import
 * `application/`（LLM 端口在 application/ports/llm-extractor.ts）、更不碰 `adapters/llm/`。
 *
 * 这条守卫有三层，从宽到窄：
 * 1. `src/domain/` 整体不 import `LlmExtractor`/`llm-extractor`/`adapters/`，不出现该标识符；
 * 2. `src/domain/routing/` 同样（它是路由的落点）；
 * 3. `OrderRouter` 的构造依赖 `OrderRouterDeps` 里没有 LLM/抽取相关成员——即使有人绕开
 *    import 图、用字符串注入，这条也会抓到「构造依赖形状变了」。
 *
 * 失败信息：`文件:行号: [INV-10] ...`。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { findPattern, listSourceFiles, makeSourceFile, scanImports } from './source-scan.ts';
import type { SourceFile } from './source-scan.ts';

const files = listSourceFiles();

/** 依赖/标识符里出现这些就算 LLM 渗入 domain。 */
const LLM_SPECIFIER_PATTERN = /llm|LlmExtractor/i;
const LLM_IDENTIFIER_PATTERN = /\bLlmExtractor\b/g;

function checkNoLlmImports(sourceFiles: SourceFile[], scope: string): string[] {
  const problems: string[] = [];
  for (const file of sourceFiles) {
    for (const ref of scanImports(file)) {
      const isLlmPort = LLM_SPECIFIER_PATTERN.test(ref.specifier);
      const isAdapter = ref.specifier.includes('adapters');
      const isApplication = /(^|\/)application\//.test(ref.specifier);
      if (isLlmPort || isAdapter || isApplication) {
        problems.push(
          `${file.rel}:${ref.line}: [INV-10] ${scope} 不得 import '${ref.specifier}'` +
            `（${isLlmPort ? 'LLM 抽取' : isAdapter ? '适配器' : 'application 层'}）`,
        );
      }
    }
  }
  return problems;
}

function checkNoLlmIdentifier(sourceFiles: SourceFile[], scope: string): string[] {
  const problems: string[] = [];
  for (const file of sourceFiles) {
    for (const hit of findPattern(file, LLM_IDENTIFIER_PATTERN)) {
      problems.push(
        `${file.rel}:${hit.line}: [INV-10] ${scope} 不得引用 LlmExtractor（${hit.text}）`,
      );
    }
    for (const hit of findPattern(file, /llm-extractor[^'"\s]*/gi)) {
      problems.push(`${file.rel}:${hit.line}: [INV-10] ${scope} 不得出现 llm-extractor 路径（${hit.text}）`);
    }
  }
  return problems;
}

const domainFiles = files.filter((file) => file.rel.startsWith('src/domain/'));
const routingFiles = files.filter((file) => file.rel.startsWith('src/domain/routing/'));

describe('路由不经 LLM 守卫（ARCHITECTURE §7 INV-10）', () => {
  it('src/domain/ 整体不 import LlmExtractor / llm-extractor / adapters / application', () => {
    const problems = [
      ...checkNoLlmImports(domainFiles, 'domain/'),
      ...checkNoLlmIdentifier(domainFiles, 'domain/'),
    ];
    assert.equal(problems.length, 0, 'domain/ 违反 INV-10（路由必须纯函数、不经 LLM）：\n' + problems.join('\n'));
  });

  it('src/domain/routing/ 不 import LLM 端口/适配器，也不引用 LlmExtractor', () => {
    assert.ok(routingFiles.length > 0, '守卫必须扫到 src/domain/routing/ 的文件');
    const problems = [
      ...checkNoLlmImports(routingFiles, 'routing/'),
      ...checkNoLlmIdentifier(routingFiles, 'routing/'),
    ];
    assert.equal(problems.length, 0, 'routing/ 违反 INV-10：\n' + problems.join('\n'));
  });

  it('OrderRouter 的构造依赖 OrderRouterDeps 里没有 LLM/抽取相关成员', () => {
    const routerFile = files.find((file) => file.rel === 'src/domain/routing/router.ts');
    assert.ok(routerFile !== undefined, 'src/domain/routing/router.ts 必须存在');

    const code = routerFile.code;
    const start = code.indexOf('interface OrderRouterDeps');
    assert.notEqual(start, -1, 'router.ts 必须声明 interface OrderRouterDeps（§5.7 的构造依赖）');
    const end = code.indexOf('}', start);
    assert.notEqual(end, -1, '无法解析 OrderRouterDeps 的结尾');
    const depsSource = code.slice(start, end);

    const forbidden = /LlmExtractor|\bextract(?:or)?\b|llm/i;
    const matches = [...depsSource.matchAll(/[A-Za-z_$][\w$]*/g)].map((match) => match[0]);
    const bad = matches.filter((token) => forbidden.test(token));
    assert.deepEqual(
      bad,
      [],
      `OrderRouterDeps 不得包含 LLM/抽取依赖（INV-10）：发现 ${bad.join(', ')}`,
    );
  });

  it('OrderRouter 文件本身不含对 extract / LlmExtractor 的调用', () => {
    const routerFile = files.find((file) => file.rel === 'src/domain/routing/router.ts');
    assert.ok(routerFile !== undefined);
    const problems: string[] = [];
    for (const hit of findPattern(routerFile, /\b\w*extract\w*\s*(?:\(|\.|:)/gi)) {
      problems.push(
        `${routerFile.rel}:${hit.line}: [INV-10] OrderRouter 不得调用/依赖抽取逻辑（${hit.text}）`,
      );
    }
    assert.equal(problems.length, 0, problems.join('\n'));
  });

  it('扫描器自检：伪造的 LLM import / 标识符会被抓到', () => {
    const sample = makeSourceFile(
      'src/domain/routing/fake-router.ts',
      [
        "import type { LlmExtractor } from '../../application/ports/llm-extractor.ts';",
        'export type Bad = LlmExtractor;',
      ].join('\n'),
    );
    const problems = [
      ...checkNoLlmImports([sample], 'routing/'),
      ...checkNoLlmIdentifier([sample], 'routing/'),
    ];
    assert.ok(problems.length >= 2, `应至少抓到 import 与标识符两类问题：${JSON.stringify(problems)}`);
    assert.ok(
      problems.every((problem) => problem.includes('[INV-10]')),
      `失败信息应带 INV-10 标签：${JSON.stringify(problems)}`,
    );
  });
});
