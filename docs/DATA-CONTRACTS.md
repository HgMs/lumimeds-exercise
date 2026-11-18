# 数据契约与 API 清单

> 本文件把已经确定的事实整理成可实现的契约：事件长什么样、config 里到底有什么、
> 我们发什么请求、内部用什么数据结构、落盘什么格式、week A 的每封邮件解析成什么。
>
> 业务判断（优先级、模糊点取舍）以 [`REQUIREMENTS.md`](REQUIREMENTS.md) 为准；
> 本文只描述「数据与接口的形状」，两者冲突时以需求文档为准。文档分工见
> [`README.md`](README.md)。文中时间均为 ET（`America/New_York`），`until` 一律排他。

## 0. 数据流一览

```
模拟器 ──POST /webhooks──▶ 我们的服务
                              │
                              ├─ simulation.started ─▶ 重置状态、记下 pharmacyApi
                              ├─ email ─▶ LLM 抽取 ─▶ 代码校验 ─▶ fact / Sam 列表
                              └─ order ─▶ 路由（纯函数）──POST /pharmacy-orders──▶ 模拟器
                                                                  │
                                                          201/409 回写 sent_orders
```

## 1. 外部事件（模拟器 → 我们）

### 1.1 公共信封

所有事件都带这三个字段；同值也出现在 `x-event-id`、`x-sim-time` 请求头。

```ts
type Iso = string;            // RFC3339 带偏移，例如 "2026-11-10T08:00:00-05:00"
type PharmacyId = string;     // "TANDREL"
type StateCode = string;      // "TX"（两位 USPS 码）
type MedicationId = string;   // "tirzepatide"
type DoseId = string;         // "7.5mg"

interface EventEnvelope {
  event_id: string;
  type: "simulation.started" | "email" | "order";
  occurred_at: Iso;
}
```

`occurred_at` 就是「现在」。全周的偏移都是 `-05:00`（2026-11-01 起美国东部已转冬令时）。

### 1.2 `simulation.started`

```ts
interface SimulationStarted extends EventEnvelope {
  type: "simulation.started";
  pharmacyApi: string;        // "http://localhost:4000"
  config: SimConfig;
}

interface SimConfig {
  catalogue: Record<MedicationId, DoseId[]>;   // 合法药品与剂量，唯一真值
  lumimedsOps: string[];                       // 有权下路由指令的地址
  pharmacies: PharmacyConfig[];
}

interface PharmacyConfig {
  id: PharmacyId;
  name: string;
  contacts: string[];         // 能代表这家药房发言的地址
  open: boolean;              // 正常日是否接单
  shipsInDays: number;        // 速度
  dailyCapacity: number;      // 每日接单上限
  price: Record<MedicationId, number>;  // 美元/单，整数
  blockedStates: string[];    // 可能写全名，如 "Texas"
  stock: Record<MedicationId, DoseId[]>;
}
```

week A 的实际取值（已核对）：

| id | shipsInDays | 日容量 | sema 价 | tirz 价 | blockedStates | contacts |
|---|---|---|---|---|---|---|
| TANDREL | 1 | 4 | 140 | 210 | FL, GA, NJ, AK | jen@ / orders@ / john@，均 `@tandrel.example` |
| VELMORA | 2 | 5 | 110 | 190 | CA, AZ, NJ, AK | ops@velmora.example |
| CORVANE | 3 | 6 | 120 | 175 | NY, AZ, NJ, AK | mark@corvane.example |
| ISHBY | 1 | 3 | 150 | 230 | **"Texas"**, FL, CA, AZ, GA | orders@ishby.example |
| WRENFOLD | 2 | 3 | 105 | 180 | FL, GA, NY, NJ, AK | hello@wrenfold.example |

| id | semaglutide 现货 | tirzepatide 现货 |
|---|---|---|
| TANDREL | 0.25 / 0.5 / 1 / 1.7 / 2.4mg | 2.5 / 5 / 7.5 / 10 / 12.5 / 15mg |
| VELMORA | 0.25 / 0.5 / 1mg | 2.5 / 5 / 7.5 / 10mg |
| CORVANE | 0.25 / 0.5 / 1 / 1.7 / 2.4mg | 2.5 / 5 / 7.5 / 10 / 12.5 / 15mg |
| ISHBY | 0.25 / 0.5 / 1mg | 5 / 7.5mg |
| WRENFOLD | 0.25 / 0.5 / 1mg | 2.5 / 10mg |

目录（catalogue）：semaglutide 5 档、tirzepatide 6 档，见上面各药房并集。

**注意**：`blockedStates` 里 `"Texas"` 与 `"TX"` 必须归一；`open` 是基础值，之后由
关闭/重开 fact 覆盖。

### 1.3 `email`

```ts
interface EmailEvent extends EventEnvelope {
  type: "email";
  email: { from: string; subject: string; body: string };
}
```

`from` 可能是 `"Jen <jen@tandrel.example>"` 形式，解析时取 `<...>` 里的地址，
大小写不敏感。

### 1.4 `order`

```ts
interface OrderEvent extends EventEnvelope {
  type: "order";
  order: Order;
}

interface Order {
  order_id: string;      // "ORD-1001"
  state: string;         // 原始写法，可能 "Texas"
  medication: string;    // 原始写法，可能 "tirz"
  dose: string;          // 原始写法，可能 "7.5 mg"
}
```

订单本身是结构化数据，不过 LLM；归一化（`tirz` → `tirzepatide`、`Texas` → `TX`、
`7.5 mg` → `7.5mg`）在代码里做，失败就 `MANUAL`。

### 1.5 入站校验

| 情况 | 响应 | 动作 |
|---|---|---|
| body 不是 JSON | 400 | 不处理 |
| 缺 `event_id` / `type` / `occurred_at` | 400 | 不处理 |
| 未知 `type` | 200 | 记日志，忽略 |
| `occurred_at` 解析失败 | 400 | 不处理 |
| `simulation.started` 缺 `config` 或 `pharmacyApi` | 500 | 记错误（数据有问题，不该发生） |
| 重复 `event_id` | 200 | 直接返回，不产生副作用 |

## 2. 外部 API（我们 → 模拟器的药房 API）

### 2.1 `POST {pharmacyApi}/pharmacy-orders`

请求：

```json
{ "order_id": "ORD-2042", "pharmacy": "VELMORA", "reason": "fastest safe: 2 days, $190" }
```

- `order_id`：本周存在的订单 id。
- `pharmacy`：config 里的药房 id，或 `"MANUAL"`。
- `reason`：可选，给人和审计看。会写进 `out/run-log.jsonl`。

响应：

| 状态 | 含义 | 我们的处理 |
|---|---|---|
| 201 | 已发，终局 | 记 `sent_orders[order_id]`，写决策日志 |
| 409 | 已发过 | 记 warning；视为已发；**不重试**（正常情况下不该出现） |
| 400 | body 不合法（我们的 bug） | 记 error + 告警；**不重试**，重试也不会成功 |
| 404 | 路径错，或订单不在本周 | 记 error + 告警；**不重试** |
| 5xx / 超时 | 服务端问题（可重试） | 退避重试 3 次（250/500/1000ms），仍失败进后台队列 |

发送顺序：**先发单，再回 webhook**，保证订单被算在 `during_event`，且下一步路由
看到的是最新容量。

## 3. 内部数据结构

### 3.1 Fact：只追加的事实

```ts
interface Interval { from: Iso; until: Iso | null; }   // until 排他；null = 一直有效

interface FactBase {
  id: string;              // "fact_0007"，递增
  event_id: string;        // 来源邮件
  asserted_at: Iso;        // 邮件 occurred_at
  pharmacy: PharmacyId;
  interval: Interval;
  note?: string;           // 原邮件里的说法，审计用
}

type Fact =
  | (FactBase & { type: "stock_unavailable"; medication: MedicationId; dose: DoseId })
  | (FactBase & { type: "stock_available";   medication: MedicationId; dose: DoseId })
  | (FactBase & { type: "state_blocked";     state: StateCode })
  | (FactBase & { type: "state_allowed";     state: StateCode })
  | (FactBase & { type: "closed" })
  | (FactBase & { type: "reopened" })
  | (FactBase & { type: "capacity";          perDay: number })
  | (FactBase & { type: "routing_preference"; medication: MedicationId; dose?: DoseId; state?: StateCode })
  ;
```

**基础事实**：`simulation.started` 时把 config 展开成一批 `asserted_at = occurred_at`
的基础 fact（`stock_available`、`state_blocked`、`capacity`）。`open` 是药房的
基础字段；「营业」用「没有覆盖该时刻的 `closed` fact」表示，避免为默认值造 fact。
这样查询时只有一条规则，不用分支。

基础 fact 的 `event_id` 记 `simulation.started` 的 `event_id`，便于审计时区分
「config 初始值」和「邮件改过的值」。

### 3.2 求值：同一主体，最后断言者胜

查询某药房在时刻 `t` 的状态：

1. 取所有 `interval.from <= t < (interval.until ?? ∞)` 的 fact；
2. 取 `(asserted_at, id 序号)` 最大的那条；
3. 没有覆盖 `t` 的 fact → 回落到基础值。

这条规则同时实现了「更正」：更正邮件只是又追加一条 fact，时间更晚，于是覆盖旧的，
**不需要改历史**。`stock_available` 与 `stock_unavailable` 是对立陈述，同一主体上
后者生效；`state_blocked` / `state_allowed`、`closed` / `reopened` 同理。

### 3.3 派生视图

```ts
interface PharmacyView {
  id: PharmacyId;
  name: string;
  openNow: boolean;
  shipsInDays: number;
  capacityToday: number;        // 有效日容量
  capacityUsedToday: number;    // 当天已发单数
  capacityLeft: number;
  price: Record<MedicationId, number>;
  blockedStates: StateCode[];
  stock: Record<MedicationId, DoseId[]>;
}

interface CandidateEvaluation {
  pharmacy: PharmacyId;
  eligible: boolean;
  shipsInDays: number;
  price: number | null;
  capacityLeft: number;
  failures: string[];   // "closed" | "state_blocked:NJ" | "no_stock:tirzepatide:7.5mg" | "capacity_full"
}
```

### 3.4 路由决策

```ts
interface RoutingDecision {
  order_id: string;
  at: Iso;
  order: Order;                     // 归一化后的
  chosen: PharmacyId | "MANUAL";
  basis: "rank" | "ops_preference" | "manual";
  reason: string | null;
  candidates: CandidateEvaluation[];
  preference: { pharmacy: PharmacyId; event_id: string } | null;
  override: string | null;          // ops 指定但不可用时的原因
  sent: { status: number; at: Iso } | null;
}
```

### 3.5 Sam 列表

```ts
interface SamEntry {
  at: Iso;
  event_id: string;
  from: string;
  subject: string;
  role: "pharmacy" | "ops" | "unknown";
  reason: string;              // 具体的校验失败原因
  extracted: unknown;          // LLM 原始输出，便于人工复核
  suggested_action: string;    // "确认 25mg 是否正确剂量" 之类
  draft_reply: string | null;  // 加分项，先留空
}
```

### 3.6 持久化：`data/state.json`

每个事件处理完后原子写（临时文件 + rename）。重启时读回；收到
`simulation.started` 时清空。

```ts
interface PersistedState {
  version: 1;
  week_started_at: Iso;
  pharmacy_api: string;
  config: SimConfig;
  facts: Fact[];
  seen_event_ids: string[];
  sent_orders: Record<string, { pharmacy: PharmacyId | "MANUAL"; at: Iso }>;
  decisions: Record<string, RoutingDecision>;
  sam: SamEntry[];
  seq: { fact: number };
}
```

写盘时机：订单事件在**发单成功之后、回 webhook 之前**；邮件事件在应用 fact 或挂进
Sam 列表之后。这样进程在任意位置崩溃，重启后都不会重复发单、也不会重复应用 fact。

### 3.7 审计文件

`out/decisions.jsonl`（每单一行，含 `MANUAL`）：

```json
{"order_id":"ORD-2004","at":"2026-11-10T10:00:00-05:00","chosen":"MANUAL","basis":"manual",
 "reason":"no eligible pharmacy","candidates":[{"pharmacy":"TANDREL","eligible":false,"failures":["state_blocked:NJ"]}],
 "preference":null,"override":null}
```

`out/facts.jsonl`（每封邮件一行）：

```json
{"at":"2026-11-09T07:05:00-05:00","event_id":"evt_001","from":"jen@tandrel.example",
 "subject":"Stock","role":"pharmacy","outcome":"applied",
 "facts":[{"type":"stock_unavailable","pharmacy":"TANDREL","medication":"tirzepatide","dose":"5mg",
           "interval":{"from":"2026-11-09T07:05:00-05:00","until":"2026-11-11T00:00:00-05:00"}}]}
```

`outcome` 取值：`applied` / `rejected` / `no_change`。

## 4. LLM 抽取契约

### 4.1 输入

一条 system，一条 user。system 固定；user 由代码拼装：

```
EVENT_TIME: 2026-11-10T08:00:00-05:00 (Tuesday, America/New_York)
WEEK_CALENDAR:
  Mon 2026-11-09
  Tue 2026-11-10
  Wed 2026-11-11
  Thu 2026-11-12
  Fri 2026-11-13
  Sat 2026-11-14
  Sun 2026-11-15
PHARMACIES: [{"id":"TANDREL","name":"Tandrel Rx","contacts":["jen@..."]}, ...]
OPS: ["sam@lumimeds.example","ops-lead@lumimeds.example"]
CATALOGUE: {"semaglutide":["0.25mg",...],"tirzepatide":["2.5mg",...]}
EMAIL:
<<<EMAIL
from: jen@tandrel.example
subject: Stock
body: Hi Sam, we're out of tirzepatide 5mg until Wednesday, sorry!
EMAIL>>>
```

把本周日历直接给模型，是为了让 "tomorrow"、"Wednesday" 不用它自己算星期几；
`EVENT_TIME` 里的 `-05:00` 也一并给出，减少时区错误。

### 4.2 输出（强制 tool schema）

```json
{
  "name": "record_email_facts",
  "description": "Extract pharmacy-operations facts from one email. Return null for anything not stated. Never guess.",
  "input_schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["intent", "facts", "confidence"],
    "properties": {
      "intent": { "enum": ["stock", "coverage", "closure", "capacity", "routing", "unrelated", "unclear"] },
      "facts": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": ["type", "pharmacy"],
          "properties": {
            "type": { "enum": ["stock_unavailable", "stock_available", "state_blocked", "state_allowed",
                                "closed", "reopened", "capacity", "routing_preference", "no_change"] },
            "pharmacy": { "type": ["string", "null"] },
            "medication": { "type": ["string", "null"] },
            "dose": { "type": ["string", "null"] },
            "states": { "type": "array", "items": { "type": "string" } },
            "per_day": { "type": ["integer", "null"] },
            "from_date": { "type": ["string", "null"], "description": "YYYY-MM-DD in America/New_York" },
            "until_date": { "type": ["string", "null"], "description": "exclusive; YYYY-MM-DD in America/New_York" },
            "phrase": { "type": ["string", "null"], "description": "the original temporal wording, verbatim" }
          }
        }
      },
      "correction": { "type": "boolean" },
      "confidence": { "enum": ["high", "medium", "low"] },
      "notes": { "type": "string" }
    }
  }
}
```

### 4.3 代码侧的交叉校验

模型给的是日期，代码不信它一家之言：

| 检查 | 失败时 |
|---|---|
| `type` 属于枚举 | 拒绝 |
| `pharmacy` 能解析到 config（id 或 name） | 拒绝 |
| `medication` 在 catalogue 里 | 拒绝 |
| `dose` 精确等于 catalogue 里某档 | 拒绝（`25mg` 在这里被挡） |
| 每个 `states` 能归一化 | 拒绝 |
| `from_date` / `until_date` 是合法日期 | 拒绝 |
| `until > from` | 拒绝 |
| 日期落在 `[week_start, week_start + 14 天]` | 拒绝 |
| `phrase` 能被确定性解析器识别 | 用解析器的结果覆盖模型日期，并记录差异 |
| 发件人对该药房有权限 | 拒绝，进 Sam |
| `routing_preference` 来自 ops | 拒绝，进 Sam |

确定性解析器只认一组封闭短语：`immediately`、`today`、`tomorrow`、`yesterday`、
星期名（`Wednesday`）、`next <weekday>`、`end of week` / `rest of the week`、
`until <…>`、`from <…>`、`back on <…>`。识别不了但模型日期合法且 `confidence=high`
时，采用模型日期并标注 `source: "llm"`；否则进 Sam。

### 4.4 失败处理

- HTTP 超时 12s；schema 不合法或 5xx 重试 1 次。
- 两次都失败 → 该邮件进 Sam 列表（`reason: "extraction_failed"`），状态不变，
  webhook 仍回 200。
- 成本：一周约 10 次调用，可忽略。

## 5. 本服务对外的 API

| 方法 | 路径 | 用途 | 返回 |
|---|---|---|---|
| POST | `/webhooks` | 模拟器入口 | 2xx（body 忽略）；坏请求 400 |
| GET | `/orders/:id` | 解释某个订单的路由决定 | `RoutingDecision` / 404 |
| GET | `/sam` | Sam 列表 | `SamEntry[]` |
| GET | `/health` | 存活与计数 | `{ok, events, orders_sent, sam}` |
| GET | `/state` | 当前派生视图（调试/演示） | `PharmacyView[]` |

`POST /webhooks` 的响应只表达「我收到了」；路由结果在 `out/run-log.jsonl` 和
`/orders/:id` 里查。响应体固定为 `{"ok":true}`，方便排错。

## 6. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口 |
| `ANTHROPIC_API_KEY` | — | 必填；从 `.env` 读，绝不入库 |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-5` | 抽模型；可换成更便宜的做对比 |
| `ANTHROPIC_TIMEOUT_MS` | `12000` | 单次调用超时 |
| `DATA_DIR` | `./data` | `state.json` 位置 |
| `OUT_DIR` | `./out` | 审计日志位置 |
| `TZ` | `America/New_York` | 仅用于日期格式化，不用于取「现在」 |

## 7. week A 事实清单（已核对）

### 7.1 事件统计

| 项 | 值 |
|---|---|
| 总行数 | 52 |
| `simulation.started` | 1（`evt_000`，11-09 06:00） |
| `email` 事件 | 11（**10 封唯一邮件**；`evt_020` 重投一次） |
| `order` 事件 | 40（**38 个唯一订单**；`evt_011`、`evt_032` 各重投一次） |
| 时间范围 | 2026-11-09 06:00 → 2026-11-11 16:00（全周 `-05:00`） |
| 每日事件数 | 11-09：21；11-10：18；11-11：13 |
| 订单号段 | `ORD-1001`…`ORD-1013`、`ORD-2001`…`ORD-2013`、`ORD-3001`…`ORD-3012` |
| 药房 | 5 家：TANDREL、VELMORA、CORVANE、ISHBY、WRENFOLD |

week A 的回放只覆盖周一到周三，周三 16:00 之后没有事件。周的边界按周一起算的自然周
（周一至周日）解析，「the rest of the week」因此到下一个周一 00:00 结束（见
`REQUIREMENTS.md` §10）。**不要**把「事件只到周三」当成业务规则写进代码；隐藏周会
覆盖更长的范围。

### 7.2 邮件解析结果

10 封唯一邮件（`evt_020` 被重投，共 11 个 email 事件）。时间均为 `-05:00`。
「生效区间」是解析后的绝对时间，`until` 排他；`from` 未写明时取 `occurred_at`。

| 事件 | 时间 | 发件人 | 角色 | 解析结果 | 生效区间 |
|---|---|---|---|---|---|
| `evt_001` | 11-09 07:05 | jen@tandrel | 药房 | `stock_unavailable` TANDREL / tirzepatide / 5mg | 07:05 → 11-11 00:00 |
| `evt_002` | 11-09 07:40 | mark@corvane | 药房 | `state_blocked` CORVANE / FL | 11-11 00:00 → 一直 |
| `evt_003` | 11-09 08:15 | orders@ishby | 药房 | 声称要改全站路由 | **拒绝**：药房无路由权限 → Sam |
| `evt_004` | 11-09 08:30 | orders@ishby | 药房 | 声称补货 tirzepatide 25mg | **拒绝**：25mg 不在目录 → Sam |
| `evt_014` | 11-09 13:00 | hello@wrenfold | 药房 | `closed` WRENFOLD（明天） | 11-10 00:00 → 11-11 00:00 |
| `evt_017` | 11-09 16:00 | jen@tandrel | 药房 | 更正：5mg 恢复、7.5mg 缺货 | `stock_available` 5mg：16:00 → 一直；`stock_unavailable` 7.5mg：16:00 → 11-11 00:00 |
| `evt_020` | 11-10 08:00 | mark@corvane | 药房 | `capacity` CORVANE 2 单/天 | 11-10 08:00 → 11-16 00:00 |
| `evt_022` | 11-10 09:02 | john@tandrel | 药房 | `state_blocked` TANDREL / TX | 09:02 → 一直 |
| `evt_027` | 11-10 11:00 | ops-lead@lumimeds | **ops** | `routing_preference` VELMORA / semaglutide | 11-11 00:00 → 11-16 00:00 |
| `evt_040` | 11-11 10:00 | ops@velmora | 药房 | `stock_unavailable` VELMORA / semaglutide / 1mg | 11-11 10:00 → 11-13 00:00 |

其余 40 个订单事件（38 个唯一订单，含 2 次重投）不产生 fact。

### 7.3 由 config 展开的基础事实

`asserted_at = 11-09 06:00`（即 `simulation.started` 的 `occurred_at`）：

- 每家药房的 `stock_available`：按 §1.2 的现货表；
- 每家药房的 `state_blocked`：按 `blockedStates`，全名归一化（ISHBY 的 `"Texas"` → `TX`）；
- 每家药房的 `capacity`：按 `dailyCapacity`；
- 营业状态用基础字段 `open = true` 表示，不造 `closed` fact。

## 8. 错误码与边界

| 情况 | 处理 |
|---|---|
| 订单的 `medication` 不在 catalogue | `MANUAL`，reason `unknown_medication:<x>` |
| 订单的 `dose` 不在 catalogue | `MANUAL`，reason `unknown_dose:<x>` |
| 订单的 `state` 归一化失败 | `MANUAL`，reason `unknown_state:<x>` |
| 合规订单但无任何候选药房 | `MANUAL`，reason 列出每家失败原因 |
| 药房 API 一直失败 | 后台重试，最多到 drain；仍失败则日志告警 |
| 同一订单重复投递且已发 | 200，不重发 |
| 同一邮件重复投递 | 200，不重复应用 fact |
| LLM 两次失败 | 邮件进 Sam，状态不变，200 |
| 处理单条事件超过 25s | 主动中止 LLM 调用，邮件进 Sam，200 |
