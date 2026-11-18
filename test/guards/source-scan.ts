/**
 * 守卫测试共用的源码扫描工具（`ARCHITECTURE.md` §2.1、§7 INV-1/INV-9/INV-10/INV-12、§12.1）。
 *
 * 守卫是**静态**检查：读 `src/**\/*.ts` 的文本与 import 图，不 import `src/` 的运行时模块
 * （否则守卫自己就会把 domain/application 拉进进程，看不到真实的依赖方向）。这里只依赖
 * `node:fs` / `node:path` / `node:url`。
 *
 * 两个约定，四条守卫都用：
 *
 * 1. **注释先剥离**（`stripComments`）：守卫针对的是运行时代码与字符串字面量，注释里的
 *    说明文字不是"硬编码数据"。剥离时用空格替换（换行保留），所以**行号与原文完全一致**；
 *    失败信息里的 `文件:行号` 可以直接点开。这同时让
 *    `src/kernel/time/et-calendar.ts` 的 selfTest 白名单只需要保留两个探针日期
 *    （注释里举例用的其它日期不进入扫描）。
 * 2. **路径一律用仓库相对的 posix 形式**（`src/kernel/time/instant.ts`），
 *    跨平台比较稳定，失败信息也可读。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `test/guards/` 的绝对路径（用于定位仓库根，不依赖 cwd）。 */
export const GUARDS_DIR = posix.dirname(fileURLToPath(import.meta.url).split('\\').join('/'));
/** 仓库根。 */
export const REPO_ROOT = posix.normalize(posix.join(GUARDS_DIR, '..', '..'));

/** 分层：目录即层（`src/env.ts`、`src/index.ts` 单列）。 */
export type Layer =
  | 'kernel'
  | 'domain'
  | 'application'
  | 'adapters'
  | 'interfaces'
  | 'wiring'
  | 'env'
  | 'unknown';

export interface SourceFile {
  /** 仓库相对 posix 路径，例如 `src/kernel/time/et-calendar.ts`。 */
  rel: string;
  abs: string;
  /** 原文。 */
  raw: string;
  /** 去掉注释后的源码；**行号与原文一致**。 */
  code: string;
}

const SRC_RELATIVE = 'src';

function toPosix(value: string): string {
  return value.split('\\').join('/');
}

/** 列出 `src/` 下全部 `.ts` 文件（按路径排序，保证失败信息顺序稳定）。 */
export function listSourceFiles(): SourceFile[] {
  const out: SourceFile[] = [];
  walk(posix.join(REPO_ROOT, SRC_RELATIVE), out);
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

function walk(dirAbs: string, out: SourceFile[]): void {
  for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
    const abs = posix.join(dirAbs, entry.name);
    if (entry.isDirectory()) {
      walk(abs, out);
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    const raw = readFileSync(abs, 'utf8');
    out.push({
      rel: toPosix(posix.relative(REPO_ROOT, abs)),
      abs,
      raw,
      code: stripComments(raw),
    });
  }
}

/**
 * 剥离 `//` 行注释与 `/* ... *\/` 块注释，**保留换行与列位置**（用空格替换）。
 *
 * 字符串（单/双引号/模板）原样保留——"硬编码数据出现在字符串里"正是守卫要抓的东西；
 * 只有注释被抹掉。扫描器不尝试理解 `${...}` 内部的表达式：模板串整体按字符串处理，
 * 对守卫足够（`src/` 没有在模板串内写注释的用法）。
 */
export function stripComments(source: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        out.push(' ');
        i += 1;
      }
      continue;
    }

    if (ch === '/' && next === '*') {
      out.push(' ', ' ');
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out.push(source[i] === '\n' ? '\n' : ' ');
        i += 1;
      }
      if (i < source.length) {
        out.push(' ', ' ');
        i += 2;
      }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      out.push(ch);
      i += 1;
      while (i < source.length) {
        const inString = source[i]!;
        if (inString === '\\') {
          out.push(inString);
          i += 1;
          if (i < source.length) {
            out.push(source[i]!);
            i += 1;
          }
          continue;
        }
        out.push(inString);
        i += 1;
        if (inString === ch) break;
        if (inString === '\n' && ch !== '`') break; // 未闭合的普通字符串：到此为止
      }
      continue;
    }

    out.push(ch);
    i += 1;
  }
  return out.join('');
}

/** 1-based 行号：给定 `text` 中某个偏移，返回它所在行。 */
export function lineOfOffset(text: string, offset: number): number {
  let line = 1;
  const limit = Math.min(offset, text.length);
  for (let i = 0; i < limit; i += 1) if (text[i] === '\n') line += 1;
  return line;
}

/** 某个偏移所在行的原文（去掉首尾空白，用于失败信息展示）。 */
export function lineTextAt(text: string, offset: number): string {
  const start = text.lastIndexOf('\n', offset - 1) + 1;
  const end = text.indexOf('\n', offset);
  return text.slice(start, end === -1 ? text.length : end).trim();
}

export interface PatternHit {
  /** 1-based 行号。 */
  line: number;
  /** 命中处所在行的原文（trim 后）。 */
  text: string;
  /** 命中的字面量。 */
  match: string;
}

/**
 * 在源码里找正则命中。默认扫 `code`（注释已剥离）；`raw: true` 时扫原文。
 * 每次调用都新建正则（避免 `g` 状态泄漏）。
 */
export function findPattern(
  file: SourceFile,
  pattern: RegExp,
  options: { raw?: boolean } = {},
): PatternHit[] {
  const text = options.raw === true ? file.raw : file.code;
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const scanner = new RegExp(pattern.source, flags);
  const hits: PatternHit[] = [];
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(text)) !== null) {
    hits.push({
      line: lineOfOffset(text, match.index),
      text: lineTextAt(text, match.index),
      match: match[0],
    });
    if (match[0].length === 0) scanner.lastIndex += 1; // 防御空匹配死循环
  }
  return hits;
}

/** 命中格式化成失败信息：`src/x.ts:12: ...`。 */
export function describeHit(file: SourceFile, hit: PatternHit, message: string): string {
  return `${file.rel}:${hit.line}: ${message}`;
}

export type ImportKind = 'static' | 'side-effect' | 'dynamic';

export interface ImportRef {
  /** import 说明符原文，例如 `../../kernel/result.ts`、`node:fs`。 */
  specifier: string;
  /** 1-based 行号。 */
  line: number;
  kind: ImportKind;
}

/**
 * 提取一个文件的全部 import/export-from 依赖。
 *
 * - `import ... from 'x'` / `export ... from 'x'` → `static`
 * - `import 'x'` → `side-effect`
 * - `import('x')` → `dynamic`
 *
 * 注释已剥离，所以注释掉的 import 不会误报。
 *
 * 静态 import 只从**行首**的 `import`/`export` 开始匹配，并要求 `from` 后至少一个空白再接
 * 说明符：这样 `field: 'from' | 'until'` 这种联合类型里的字符串 `'from'` 不会被当成
 * import 语句（真实踩过这个坑——`from` 后面紧跟引号的是字符串内容，不是关键字）。
 */
export function scanImports(file: SourceFile): ImportRef[] {
  const text = file.code;
  const found = new Map<number, ImportRef>();

  const add = (index: number, specifier: string, kind: ImportKind): void => {
    found.set(index, { specifier, line: lineOfOffset(text, index), kind });
  };

  const fromPattern = /^[ \t]*(?:import|export)\b[^;]*?\bfrom\s+(['"])([^'"\n]+)\1/gm;
  let match: RegExpExecArray | null;
  while ((match = fromPattern.exec(text)) !== null) {
    add(match.index, match[2]!, 'static');
  }

  const sideEffectPattern = /^[ \t]*import\s+(['"])([^'"\n]+)\1/gm;
  while ((match = sideEffectPattern.exec(text)) !== null) {
    add(match.index, match[2]!, 'side-effect');
  }

  const dynamicPattern = /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;
  while ((match = dynamicPattern.exec(text)) !== null) {
    add(match.index, match[2]!, 'dynamic');
  }

  return [...found.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, ref]) => ref);
}

/** 文件所属层（按 `src/` 下第一段目录；`src/env.ts` → `env`，`src/index.ts` → `wiring`）。 */
export function layerOf(rel: string): Layer {
  const parts = rel.split('/');
  if (parts[0] !== 'src') return 'unknown';
  if (parts.length === 2) {
    if (parts[1] === 'env.ts') return 'env';
    if (parts[1] === 'index.ts') return 'wiring';
    return 'unknown';
  }
  const dir = parts[1]!;
  return (
    ['kernel', 'domain', 'application', 'adapters', 'interfaces', 'wiring'].includes(dir)
      ? dir
      : 'unknown'
  ) as Layer;
}

/** Node 内置模块名（不带 `node:` 前缀）的封闭清单；`node:xxx` 一律算内置。 */
const NODE_BUILTINS = new Set([
  'assert',
  'assert/strict',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'dns/promises',
  'domain',
  'events',
  'fs',
  'fs/promises',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'path/posix',
  'path/win32',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'readline/promises',
  'repl',
  'stream',
  'stream/promises',
  'stream/web',
  'string_decoder',
  'sys',
  'timers',
  'timers/promises',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'util/types',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
]);

export type ClassifiedSpecifier =
  | { kind: 'internal'; rel: string; layer: Layer }
  | { kind: 'node'; name: string }
  | { kind: 'package'; name: string };

/**
 * 判定 import 说明符指向哪里：
 * - 相对路径 → `internal`（解析成仓库相对 posix 路径；`src/` 之外也算 internal，层为 unknown）；
 * - `node:*` 或 Node 内置名 → `node`；
 * - 其余裸说明符 → `package`（第三方依赖）。
 */
export function classifySpecifier(fileRel: string, specifier: string): ClassifiedSpecifier {
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const rel = posix.normalize(posix.join(posix.dirname(fileRel), specifier));
    return { kind: 'internal', rel, layer: layerOf(rel) };
  }
  if (specifier.startsWith('node:')) {
    return { kind: 'node', name: specifier.slice('node:'.length) };
  }
  if (NODE_BUILTINS.has(specifier)) {
    return { kind: 'node', name: specifier };
  }
  return { kind: 'package', name: specifier };
}

/** 扫描器自检用：一个最小 `SourceFile` 形状（不落盘）。 */
export function makeSourceFile(rel: string, raw: string): SourceFile {
  return { rel, abs: rel, raw, code: stripComments(raw) };
}
