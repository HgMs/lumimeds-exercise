/**
 * `Router`：极小的路径路由表（`ARCHITECTURE.md` §5.11）。
 *
 * 只支持两种形状的段：
 * - 字面量段：`/webhooks`、`/sam`；
 * - 参数段：`/orders/:id`，匹配任意**非空**单段，结果放进 `params`。
 *
 * 不做前缀匹配、不做通配符、不做正则——路径表是固定的 5 条，能力越少越不会出错。
 * 匹配失败返回 `null`，由 `HttpServer` 统一落 404（Router 不知道自己「应该」返回什么
 * 状态码，那是 `ErrorMapper` 的事）。
 *
 * 归一化：
 * - 方法不分大小写（注册与匹配都 `toUpperCase()`）；
 * - 路径的 query 在 `HttpServer` 里已剥掉；这里再容忍末尾斜杠（`/sam/` ≡ `/sam`）；
 * - 参数值做一次 `decodeURIComponent`（失败时用原始段，非法百分号不致命）。
 */
import type { RequestContext, RouteHandler } from './request-context.ts';

/** 一次匹配的结果。 */
export interface RouteMatch {
  readonly handler: RouteHandler;
  readonly params: Record<string, string>;
}

/** 路由表条目（注册时按段预先切好，匹配时不做字符串拼接）。 */
interface RouteEntry {
  readonly method: string;
  readonly segments: readonly string[];
  readonly handler: RouteHandler;
}

/** 把 `/a/b/` 切成 `['a','b']`；根路径切成 `[]`。 */
function splitPath(path: string): string[] {
  const trimmed = path.trim();
  if (trimmed === '' || trimmed === '/') return [];
  return trimmed.replace(/^\/+/, '').replace(/\/+$/, '').split('/');
}

/** 参数段只认单个 `:name`；其余一律当字面量。 */
function paramNameOf(segment: string): string | undefined {
  if (segment.length < 2 || !segment.startsWith(':')) return undefined;
  const name = segment.slice(1);
  return name === '' || name.includes(':') ? undefined : name;
}

function decodeParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    // 非法百分号编码不是路由层该判断的错误；原样交给 handler。
    return raw;
  }
}

/**
 * 用某条路由去匹配已切分的路径：
 * - 段数不同 → `null`；
 * - 参数段要求非空（`/orders/` 不匹配 `/orders/:id`）；
 * - 字面量段按**大小写敏感**比较（路径是我们自己文档里写的，不做宽松匹配）。
 */
function matchSegments(
  routeSegments: readonly string[],
  pathSegments: readonly string[],
): Record<string, string> | null {
  if (routeSegments.length !== pathSegments.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < routeSegments.length; index += 1) {
    const routeSegment = routeSegments[index];
    const pathSegment = pathSegments[index];
    if (pathSegment === undefined || pathSegment === '') return null;
    const name = paramNameOf(routeSegment);
    if (name === undefined) {
      if (routeSegment !== pathSegment) return null;
    } else {
      params[name] = decodeParam(pathSegment);
    }
  }
  return params;
}

export class Router {
  private readonly routes: RouteEntry[] = [];

  /** 注册 `POST` 路由。路径必须以 `/` 开头。 */
  post(path: string, handler: RouteHandler): void {
    this.add('POST', path, handler);
  }

  /** 注册 `GET` 路由；支持 `/orders/:id` 形式的参数段。 */
  get(path: string, handler: RouteHandler): void {
    this.add('GET', path, handler);
  }

  /**
   * 匹配方法 + 路径。命中返回 handler 与参数；未命中返回 `null`（→ 404）。
   * 按注册顺序线性扫描：路由只有个位数，顺序确定比哈希更可预测。
   */
  match(method: string, path: string): RouteMatch | null {
    const wantedMethod = method.trim().toUpperCase();
    const pathSegments = splitPath(path);
    for (const route of this.routes) {
      if (route.method !== wantedMethod) continue;
      const params = matchSegments(route.segments, pathSegments);
      if (params !== null) return { handler: route.handler, params };
    }
    return null;
  }

  /** 已注册路由数（测试/排错用）。 */
  get size(): number {
    return this.routes.length;
  }

  private add(method: string, path: string, handler: RouteHandler): void {
    if (typeof path !== 'string' || path.trim() === '' || !path.trim().startsWith('/')) {
      throw new Error(`Router.${method.toLowerCase()}: path must start with "/", got ${JSON.stringify(path)}`);
    }
    const segments = splitPath(path);
    const normalizedMethod = method.toUpperCase();
    const duplicate = this.routes.some(
      (route) =>
        route.method === normalizedMethod &&
        route.segments.length === segments.length &&
        route.segments.every((segment, index) => segment === segments[index]),
    );
    if (duplicate) {
      throw new Error(`Router: duplicate route ${normalizedMethod} ${path}`);
    }
    this.routes.push({ method: normalizedMethod, segments, handler });
  }
}

/** 从请求上下文里取参数（handler 用；缺失时抛 = 路由表与 handler 不一致的实现 bug）。 */
export function requireParam(ctx: RequestContext, name: string): string {
  const value = ctx.params[name];
  if (value === undefined) {
    throw new Error(`handler expected path param ":${name}" but the route did not provide it`);
  }
  return value;
}
