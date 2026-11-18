# 需求与路由策略

> 本文件是这个 app 的**唯一行为规范**。实现按它写；实现中任何有意偏离，都要记录到
> 根 `README.md` 的「模糊规则」与「已知缺口」两节。
>
> 来源：`README.upstream.md`（题目原文）、`sim/README.md`（模拟器契约）、可视化引导页，
> 以及 `sim/week-a.jsonl`（本周实际事件）。两份英文材料属于上游题目，原样保留、不翻译、
> 不改动；本仓库自己的文档一律中文。
>
> 文档分工与冲突处理见 [`README.md`](README.md)。一句话：
> **行为以本文为准，数据与接口的形状以 [`DATA-CONTRACTS.md`](DATA-CONTRACTS.md) 为准，
> 题目与交付以 [`ASSIGNMENT.md`](ASSIGNMENT.md) 为准。**

## 0. 范围

构建一个 TypeScript 服务，它要：

1. 在单个 webhook 端点上接收模拟器回放的一周事件；
2. 维护每家药房的模型（覆盖州、库存、营业日、容量、价格），初始值来自 config，
   之后由药房和 ops 的邮件更新，邮件由 LLM 阅读；
3. 把每个病人订单路由到某家药房，或路由到 `MANUAL`，判断依据是该订单
   `occurred_at` 时刻为真的状态；
4. 绝不把订单发给接不了它的药房；
5. 留下审计线索，能解释每一个路由决定，以及每一封被拒绝或被挂起的邮件。

核心范围之外：UI、鉴权、真实数据库、多实例部署、真实收信，以及任何针对样例周
具体取值的硬编码。

## 1. 固定契约（不是我们能改的）

### 1.1 事件

所有事件都以 `POST` 发到同一个 URL，JSON body，带 `event_id`、`type`、
`occurred_at`（同时镜像在 `x-event-id` 和 `x-sim-time` 请求头里）。

| `type` | 载荷 | 含义 |
|---|---|---|
| `simulation.started` | `config`、`pharmacyApi` | 第一个事件。重置全部状态。`config` 含目录、ops 地址、药房初始快照；`pharmacyApi` 是发单的基地址。 |
| `email` | `email: { from, subject, body }` | 药房或 ops 团队写给 Sam 的邮件。 |
| `order` | `order: { order_id, state, medication, dose }` | 病人订单已获批，等待分配药房。 |

字段级定义见 [`DATA-CONTRACTS.md`](DATA-CONTRACTS.md) §1。

### 1.2 投递语义

- 一次一个、按时间顺序。我们回 2xx 后才发下一个，否则 30 秒后硬发下一个。
- at-least-once：同一事件可能以完全相同的副本重投，`event_id` 相同。
- 如果我们不可达，模拟器会对同一事件重试 15 秒。
- 最后一个事件之后，最多等 60 秒，等还没发出去的订单。
- 我们必须在 30 秒内回复。因此每次 LLM 调用和药房调用都要在回复之前完成。

### 1.3 药房 API

```
POST {pharmacyApi}/pharmacy-orders
{ "order_id": "ORD-2042", "pharmacy": "VELMORA", "reason": "optional, for humans" }
```

- `pharmacy` 是 config 里的药房 id，或 `"MANUAL"`。
- `201` 已发出，**终局**：订单不能再改，也不能再发一次。
- `409` 已发过——模拟器会记成 problem，所以必须由我们自己避免。
- `400` body 不合法，`404` 订单不存在或路径错。

### 1.4 可观测性

- `out/run-log.jsonl` —— 每条已发订单一行，这是评分依据。
- `out/deliveries.jsonl` —— 每个事件一行，含我们的状态码和耗时。
- exit code 0 只代表每个事件都应答了、每个订单都发出去了，**不**代表路由是对的。

## 2. 目标与优先级

| # | 目标 | 在代码里的形式 | 可以被谁覆盖 |
|---|---|---|---|
| 1 | **安全** | 硬性资格过滤：当天营业、能发该州、有该精确剂量、当天还有容量。 | 任何东西都不能。 |
| 2 | **服从 ops 指令** | 带有效期区间的 `routing_preference` fact；在安全候选中选它指定的药房。 | 仅安全。若指定药房不安全，回落到下一个安全药房，并记录原因。 |
| 3 | **送得最快** | `shipsInDays` 最小。 | 安全、ops。 |
| 4 | **其次最便宜** | 同样快时 `price[medication]` 最小。 | 安全、ops、速度。 |
| 5 | **尽量不用 `MANUAL`** | 只有候选集为空时才发 `MANUAL`。 | 无——它本身就是最后兜底。 |

接不了的药房永远不进候选，即使 ops 点了名。**有安全备选却用了 `MANUAL` 是质量
问题，不是安全问题**，按质量问题的标准处理。

目标冲突时的读法：

- 安全永远赢。ops 指定了接不了的药房，就回落到安全的下一家，并记一条 override。
- 有安全候选时不许用 `MANUAL`，哪怕候选都要绕路（多等几天/贵一些）。
- 速度优先于价格；只有「同样快」时才比价。
- 平局用 `(shipsInDays, price, id)` 确定性打破。

## 3. 领域模型

### 3.1 药房状态（由 `config.pharmacies` 初始化）

| 属性 | 含义 | 默认 |
|---|---|---|
| `id`、`name`、`contacts` | 身份；contacts 决定谁能代表它发言。 | — |
| `open` | 正常日子是否接单。 | `true` |
| `shipsInDays` | 从接单到发货的天数，即「速度」。 | — |
| `dailyCapacity` | 每个自然日能接的单量。 | — |
| `price[medication]` | 我们每单付多少。 | — |
| `blockedStates` | 不能发货的州。 | `[]` |
| `stock[medication]` | 现货的精确剂量。 | `[]` |

`blockedStates` 和 `stock` 里可能出现州全名（如 `"Texas"`），加载时统一归一化。
州码以 USPS 两位字母为准。

### 3.2 Fact（事实）

邮件告诉我们的一切都落成**只追加的 fact**，每个 fact 带有效期区间。当前状态由
查询 fact 推导；历史永不改写。这样才回答得了「T 时刻我们相信什么」。

| Fact | 字段 | 谁能断言 |
|---|---|---|
| `stock_unavailable` | pharmacy、medication、dose、from、until? | 该药房、ops |
| `stock_available` | pharmacy、medication、dose、from、until? | 该药房、ops |
| `state_blocked` | pharmacy、state、from、until? | 该药房、ops |
| `state_allowed` | pharmacy、state、from | 该药房、ops |
| `closed` | pharmacy、from、until? | 该药房、ops |
| `reopened` | pharmacy、from | 该药房、ops |
| `capacity` | pharmacy、perDay、from、until? | 该药房、ops |
| `routing_preference` | pharmacy、medication、dose?、state?、from、until? | **仅 ops** |
| `no_change` | — | 任何人 |

`from` 缺省时取邮件的 `occurred_at`（即「立即生效」）。`until` 缺省表示一直有效。
"until X" 在 X 日 00:00 ET 排他结束，所以「until Wednesday 缺货」的意思是周三
恢复。

**`until` 缺省不等于必须拒绝**：`closed`、`stock_unavailable`、`routing_preference`
没写结束时间时按「无限期」生效（`closed`/`stock_unavailable` 属否定类事实，按无限期
处理是安全侧；拒绝它们反而会把「营业/有货」的旧信念留在原地）。这类判定要在审计里
留一条「假设」，不进 Sam 列表——Sam 的语义是「未生效、等人决定」。
（见 §10 的取舍表与 `ARCHITECTURE` §16-Q18）

fact 只有通过校验（第 4.3 节）才会生效。校验不通过、或抽取结果映射不到已知
药房/剂量/州的 fact，一律不碰状态。

求值规则（同时实现「更正」）：查询某药房在时刻 `t` 的状态时，取所有满足
`from <= t < (until ?? +∞)` 的 fact，按 `(asserted_at, 序号)` 取最后断言的
那条；没有覆盖 `t` 的 fact 则回落到基础值。`stock_available` 与
`stock_unavailable`、`state_blocked` 与 `state_allowed`、`closed` 与
`reopened` 都是同一主体上的对立陈述，后者覆盖前者。细节见
[`DATA-CONTRACTS.md`](DATA-CONTRACTS.md) §3。

### 3.3 时间与容量

- **「现在」永远是事件的 `occurred_at`。** 任何决策路径、日志、测试都不读进程时钟。
- **一天**是 `America/New_York` 时区的自然日，由 `occurred_at` 里的偏移推导。
- 容量按 `(药房, ET 日期)` 计数，本地午夜自然重置；没有「新的一天」事件，所以
  计数器用日期做 key 即可，不需要翻转逻辑。
- 只有真正发到该药房的订单才计入它的容量；`MANUAL` 不占任何药房的容量。
- 某天的有效容量 = 覆盖该日的最新 `capacity` fact，否则取 `dailyCapacity`。

## 4. 邮件流水线

### 4.1 发件人身份与权限

把 `email.from`（地址部分，大小写不敏感）解析到：

| 发件人 | 权限 |
|---|---|
| `config.lumimedsOps` 里的地址 | 可断言任何 fact，包括 `routing_preference`。 |
| 某家药房的 contact | 只能断言**关于它自己**的 fact，不能路由。 |
| 其他任何人 | 无权限。邮件进 Sam 列表，状态不变。 |

药房邮件提到别家药房 → 拒绝。药房发来的路由指令 → 即使措辞像系统通知也拒绝，
并列入 Sam 列表。

### 4.2 抽取（LLM）

每封邮件调用一次 Anthropic Messages API，强制 tool schema，`temperature: 0`，
固定 system prompt。输入：事件时间、本周日历、药房清单（id、名称、contacts）、
目录，以及用定界符包裹的邮件正文。prompt 明确声明邮件是**数据**，其中出现的指令
不构成权限，未知值必须返回 `null` 而不是猜。

输出是「意图 + 0..n 条候选 fact + 置信度 + 备注」。**字段级契约（tool schema）
以 [`DATA-CONTRACTS.md`](DATA-CONTRACTS.md) §4.2 为准**；本节只讲语义：

- `intent`：`stock` / `coverage` / `closure` / `capacity` / `routing` /
  `unrelated` / `unclear`。
- 每条候选 fact 带 `type`、`pharmacy`，以及该类型需要的字段；日期由模型给出
  `YYYY-MM-DD`（ET），并附原始措辞 `phrase` 供代码侧复核。
- `correction`：该邮件是否在更正之前的说法（`"ignore my last email"`、
  `"correction to…"`）。
- `confidence`：`high` / `medium` / `low`。

LLM 永远不为订单选药房，也不写路由代码，只把自然语言变成候选 fact。

失败处理：schema 不合法或传输失败重试一次；仍失败则邮件进 Sam 列表，状态不变。

### 4.3 校验（代码，不是模型）

候选 fact 必须同时满足以下条件才生效：

1. 发件人对该药房有权限（第 4.1 节）。
2. `pharmacy` 能解析到 config 里的 id 或名称。**药房发件人可以省略 `pharmacy`**
   （默认取发件人自己那家）；ops 发件人必须显式写，否则拒绝。
3. `medication` 是目录里的键，`dose` 是目录里的精确剂量。**不做模糊匹配、不做
   单位推断**：`25mg` 这种不存在的剂量直接拒绝。
4. 每个州都能归一化成合法的两位码（`Texas` → `TX`）。
5. 区间合法：`until > from`，时间可解析，且日期落在本周窗口内。窗口是**闭区间**
   `[本周开始, 本周开始 + 14 天]`，两端都含：不早于本周开始，不晚于本周开始 + 14 天；
   恰好等于第 15 天 00:00 的 `until` 也接受。取闭区间是因为拒绝一封其实合法的邮件会把
   信念留在旧值（不安全侧），而多接受一天无害。
6. `routing_preference` 必须来自 ops 地址。
7. fact 类型存在，必填字段齐全。

任何一条不过，或模型标了 `unclear`/低置信且解释互相矛盾 → 进 **Sam 列表**：
事件、发件人、主题、抽取出的 fact、具体校验错误、建议动作。**一律不生效**。

### 4.4 时间短语解析

| 短语（例子） | 解析结果 |
|---|---|
| "effective immediately" | `occurred_at` |
| 未提时间 | `occurred_at`，开放式 |
| "tomorrow"（`evt_014`） | 下一个 ET 自然日 00:00–24:00 |
| "from Wednesday"（`evt_002`） | 周三 00:00 ET 起，开放式 |
| "until Wednesday"（`evt_001`） | 周三 00:00 ET 结束 |
| "until Friday"（`evt_040`） | 周五 00:00 ET 结束 |
| "until Monday"（`evt_020`） | 周一 00:00 ET 结束 |
| "the rest of the week"（`evt_027`） | 下周一 00:00 ET 结束 |
| "back on Wednesday"（`evt_017`） | 区间在周三 00:00 ET 结束 |

相对日期一律基于 `occurred_at` 在 ET 解析，绝不用机器时钟。解析不了的按
「不清楚」进 Sam 列表。

代码侧另有一个**封闭短语的确定性解析器**（只认 `immediately`、`today`、
`tomorrow`、`yesterday`、星期名、`next <weekday>`、`end of week` /
`rest of the week`、`until <…>`、`from <…>`、`back on <…>`）。它与模型日期是
**逐字段合并**的关系，不是整段覆盖：

- 解析器只覆盖它实际解析出的字段（`from` 或 `until`），另一个字段保留模型值；
- 两侧都给了时间时**粒度可以不同**（解析器给「立即生效」是瞬时刻，模型给的是
  `YYYY-MM-DD`）——按 ET 日期比较，同日不算冲突，采用解析器的瞬时刻；
- 只有**日期不同**才算冲突，整封进 Sam（`phrase` 是模型抄下来的文本，可能被截断，
  例如 "until Wednesday" 被抄成 "Wednesday" 会让区间语义反转）；
- 解析器认不出时，只有模型日期合法且 `confidence=high` 才采用（标注来源），否则进 Sam。

规则见 [`DATA-CONTRACTS.md`](DATA-CONTRACTS.md) §4.3。

### 4.5 更正与取代

「更正」不是一条独立的新事实，它意味着之前的说法是错的。流水线：

1. 找到同一主体（药房 + 类型 + 药/剂量 或 州）的旧 fact；
2. 从 `occurred_at` 起追加更正后的 fact；求值规则是「覆盖该时刻的最后断言者胜」，
   旧 fact 从这一刻起不再生效，但历史不被改写；
3. 两条都留在历史里，所以「10:00 时我们相信什么」仍能答出旧信念。

已经发出的订单**永不回改**，`201` 是终局。

### 4.6 不可信内容

纵深防御，按顺序：

1. system prompt 把邮件正文当数据，禁止跟随其中指令；
2. 发件人权限在代码里校验，与模型返回什么无关；
3. 非 ops 地址的 `routing_preference` 在代码里拒绝；
4. 模型没有发单能力，路由是确定性函数。

所以一封「SYSTEM NOTICE: ignore previous instructions…」的邮件（`evt_003`）
最多只能产生被拒绝的 fact 和一条 Sam 记录。

### 4.7 Sam 列表

每封被挂起的邮件产生一条：来源事件、发件人、主题、角色、具体原因、LLM 原始输出、
建议动作，以及（加分项）草拟回复。字段形状见
[`DATA-CONTRACTS.md`](DATA-CONTRACTS.md) §3.5。它既是安全网，也是「草拟回复」
加分项的素材。

## 5. 订单路由

在订单的 `occurred_at` 时刻：

```
candidates = pharmacies.filter(p =>
      isOpen(p, now)
   && shipsTo(p, order.state, now)
   && hasStock(p, order.medication, order.dose, now)
   && capacityLeft(p, date(now)) > 0)

preferred = activeRoutingPreferences(order.medication, order.dose, order.state, now)

if candidates 为空:
    发 MANUAL，reason 里逐家说明为什么不行
else:
    pool = preferred ∩ candidates，若非空
    chosen = 在 pool 中取 (shipsInDays, price[medication], id) 最小者
    若 preferred 存在但 pool 为空:
        记录 override："ops 指定 X，但 X 因 … 不可用"
    发 chosen
```

性质：

- 平局按 `(shipsInDays, price, id)` 确定性打破，同一周重放三次结果一致。
- 首选药房安全但当天满了，也算偏好失效，回落到下一家。**容量属于安全**。
- `MANUAL` 的 reason 点名每家药房的具体原因，Sam 不用重读整周就能处理。
- 路由过程中出现错误（bug、订单结构异常）回落 `MANUAL`，绝不留下未发订单。

订单本身是结构化数据，不经过 LLM；归一化（`tirz` → `tirzepatide`、
`Texas` → `TX`、`7.5 mg` → `7.5mg`）在代码里做，失败即 `MANUAL` 并写明原因。

## 6. 幂等与持久化

- `seen_event_ids` 持久化。重复投递直接 200，什么都不改。week A 的三次重投全
  由它覆盖。**唯一例外是 `simulation.started`**：它永远是一周的第一个事件，按
  「收到就重置」处理（不受幂等门约束），否则第二次重放同一个周文件会整周被判成重复。
- `sent_orders` 记录 `order_id → pharmacy`。正常路径每个订单只发一次，**不靠**
  药房 API 的 `409` 去重；唯一的例外是崩溃恢复窗口（见下）。
- 每个事件处理完，把状态原子写入（临时文件 + rename）`data/state.json`。写盘时机：
  订单事件在**发单成功之后、回 webhook 之前**，邮件事件在应用 fact 或挂进 Sam 列表
  之后。这样进程在任意位置崩溃都不会重复应用 fact；发单的歧义由 WAL 与恢复处理。
  启动时恢复；`simulation.started` 用**一次原子写覆盖**（不先删除旧文件——`clear` 与
  `save` 之间崩溃会让磁盘上没有状态，而模拟器只对 socket 错误重投 15s）。
- **发单 WAL 与崩溃恢复（Q4 定案）**：发单前先把 `{order_id, pharmacy, at}` 写进
  `data/inflight.json`，`201`/`409` 之后移除。启动时若 `inflight` 里还有条目、而快照
  的 `sent_orders` 没有它，就按 WAL 里的药房**原样重发一次**，绝不重新路由：
  - `201`：补发成功，按已发记录；
  - `409`：药房确认此前已接受，按已发记录、不重试；但这仍是第二次发单，模拟器会
    记 `sent more than once` 并让 exit code 变 1（README「已知错误」必须点名）。
  - 对 webhook 调用方仍回 200（模拟器忽略回复 body、只认状态码）。这个系统没有终端
    用户的提交界面，「告知」= `logger.warn` + `sent_orders` 记录 + README 的「已知错误」；
    `GET /orders/:id` 只在该订单事件被重投、正常写下 decision 之后才有内容。
  为什么不能「先查再发」：药房 API 只有 `POST /pharmacy-orders`，没有查询接口
  （`sim.mjs:68` 对其他方法一律 404），所以 `409` 是唯一的「此前已发」信号。
- 发送失败（网络/5xx）先在回复 webhook 之前退避重试，仍失败则进后台重试队列，
  由最后 60 秒的 drain 兜住。
- **没有会话时收到 `order`/`email`（Q3 定案）**：回 **500 `no_session`**，不建会话、不写
  盘。会话的输入只有两个来源——`simulation.started` 与 `state.json`，环境变量里没有药房
  配置，所以凭空重建只能是编造；而且空壳会话没有 `sent_orders`，重发会撞上模拟器唯一
  不可挽回的违规（`sim.mjs:74-77` 第二次发单 → `409` + problem），比丢一个事件更糟。
  代价：该事件会丢——模拟器只对 socket 错误重投，5xx 一律记 problem 后继续。

## 7. 审计与可解释性

- `out/decisions.jsonl`：每个订单一行，含该时刻的 fact 快照、每个候选及其淘汰原因、
  最终选择、依据（`rank` / `ops_preference` / `manual`）。
- `out/facts.jsonl`：每条生效的 fact 和每封被拒绝的邮件，附来源 `event_id` 与结果
  （`applied` / `rejected` / `no_change`）。
- `GET /orders/:id` 返回该订单的决策记录（「解释任何决定」的廉价版）。
- `GET /sam` 返回 Sam 列表。

这些是实施证据；评分产物仍然是 `out/run-log.jsonl`。格式见
[`DATA-CONTRACTS.md`](DATA-CONTRACTS.md) §3.7。

## 8. 验证

三道互相独立的检查：

1. **单元测试**（`npm test`，`node:test`）：区间解析、时间短语、州名归一化、
   权限拒绝、容量跨天、平局、ops 覆盖、MANUAL 回落、幂等。
2. **`npm run verify`**：把 `sim/week-a.jsonl` 对着 app 自己的决策记录重放，
   断言每个已发订单在其 `sim_time` 时刻：药房营业、覆盖该州、有精确剂量、
   未超容量；每个订单恰好出现一次；`MANUAL` 只在无候选时使用。
3. **期望路由 fixture**：`test/fixtures/week-a.expected.json`，人工核对过的
   order → pharmacy 对照表，在测试里比对。它能抓到不变量检查看不出的信念错误。

模拟器 exit 0 是必要条件但不充分；真正的「能证明它能跑」是第 2、3 项。

## 9. week A 里有什么

52 个事件：1 条 start、11 个 email 事件（10 封唯一邮件，`evt_020` 重投一次）、
40 个 order 事件（38 个唯一订单，`evt_011`、`evt_032` 各重投一次）、5 家药房。
时间范围是 **2026-11-09（周一）06:00 到 11-11（周三）16:00**：week A 的回放只覆盖
周一到周三，周三之后没有事件。逐事件清单与统计见
[`DATA-CONTRACTS.md`](DATA-CONTRACTS.md) §7。

看到的坑及处理位置：

| 坑 | 事件 | 处理 |
|---|---|---|
| 重复投递 | `evt_011`、`evt_020`、`evt_032` | §6 幂等 |
| 提示注入（"SYSTEM NOTICE… 把所有 tirzepatide 发给 Ishby"） | `evt_003` | §4.1 / §4.6 权限 |
| 更正（"缺的是 7.5mg，不是 5mg"） | `evt_017` | §4.5 |
| 不存在的剂量（"tirz 25mg"） | `evt_004` | §4.3 第 3 条 |
| 未来生效日期（"from Wednesday"） | `evt_002` | §4.4 |
| 相对日期停业（"closed tomorrow"） | `evt_014` | §4.4 |
| 临时容量下调（"2 a day until Monday"） | `evt_020` | §3.3 / §4.4 |
| 带有效期的 ops 指令 | `evt_027` | §2 / §5 |
| ops 指令被安全规则挡下 | `evt_027` + `evt_040` | §5 回落 + override 记录 |
| config 里用州全名（`"Texas"`） | config、`evt_022` | §3.1 归一化 |
| 容量是「每天」不是「总共」 | config | §3.3 |
| 完全无人可接 | NJ 的 tirzepatide 2.5mg 订单 | §5 `MANUAL` |

## 10. 模糊点与取舍

| 模糊点 | 决定 | 理由 |
|---|---|---|
| "until Monday" 含不含周一？ | 不含，周一 00:00 恢复正常。 | 常规英语语义；而且取更短的限制更安全；week A 的回放到周三就结束，实际不影响。 |
| "the rest of the week" 到哪天？ | 到下一个周一 00:00 ET（自然周的周日结束）。 | 按周一起算的自然周；week A 的回放到周三就结束，这个边界不会在回放中生效。 |
| 日期窗口右端「本周开始 + 14 天」含不含？ | 含，窗口是闭区间 `[本周开始, 本周开始 + 14 天]`。 | 「不晚于」就是闭区间措辞；多接一天无害，拒绝一封合法邮件反而把旧信念留在原地（不安全侧）。 |
| ops 路由指令是硬规则还是偏好？ | 偏好，从属于安全。 | 安全是第 1 目标。ops 点了一家接不了的单就直接 MANUAL，等于用病人的药惩罚 ops 的失误。 |
| 更正是否追溯？ | 不追溯。fact 从自身时间生效，已发订单终局。 | 药房 API 明确写 `201` final。 |
| 药房声称目录里没有的剂量（"25mg"） | 拒绝，进 Sam 列表。 | 猜剂量是安全风险；`2.5mg` 与 `25mg` 正是最要命的错法。 |
| 药房邮件提到别家药房 | 拒绝，进 Sam 列表。 | 药房只能代表自己。 |
| 邮件不清楚/有歧义 | 不改状态，进 Sam 列表，按已知状态继续路由。 | 题面："keep every order safe in the meantime"。 |
| 未知发件人 | 无权限、不改状态、进 Sam 列表。 | |
| 容量按什么算？ | 当天实际发给该药房的订单，含 ops 指定过去的。 | 那才是药房的工作量。 |
| 歇业是整天还是半天？ | 整个 ET 自然日；没有营业时间模型。 | 数据不支持更细粒度。 |
| 两家一样快、一样便宜 | 取 id 最小。 | 三次重放要确定性。 |
| 一封邮件含多条 fact | 全部校验通过才原子应用。 | 避免半封邮件生效。 |
| `routing_preference` 的 `dose`/`state` 缺省是什么意思？ | **通配**：没写 `dose` 就约束该药品的所有剂量，没写 `state` 就约束所有州。 | `evt_027` 只写了 semaglutide，意图是「所有 sema 单」；读成「只匹配未指定」会让真实偏好永不命中。 |
| 同一药品有多条并存偏好，谁优先？ | 按**特异性**（同时限定了 dose 和 state 的最具体）→ 再按 `asserted_at` 后断言者 → 再按序号；**按这个顺序取第一条其药房合格的**，不是「取一个集合再按速度排名」。 | 偏好表达的是 ops「发给谁」的意图，不能退化成只看速度。 |
| 药房邮件没点名药房 | 默认取**发件人自己那家**（发件人身份由 contacts 决定，不是猜）。ops 必须显式写药房。 | week A 10 封里 8 封正文不提药房名；要求显式会把一半邮件推给 Sam。 |
| `closed`/`stock_unavailable` 没写结束时间 | 按无限期生效，审计留「假设」，不进 Sam。 | 否定类事实按无限期是安全侧；拒绝会把「营业/有货」留在原地。 |
| 未知发件人的邮件「看起来无关」 | 仍然进 Sam（身份检查先于「无关」判断）。 | §4.1 的「其他人 → 进 Sam」不能被意图分类绕过。 |
| 模型给的 `phrase` 与模型日期冲突 | 逐字段合并；粒度不同按 ET 日期比；**日期不同才整封进 Sam**。 | `phrase` 可能被截断，越「自信覆盖」越可能把缺货读成有货。 |
| `no_change` 类型的候选 | 不产生 fact、不改状态；整封只有它时记一条 `no_change` 审计；与其它候选混在一起时丢弃它。 | 它的语义是「没变化」，不该被当成一条断言。 |
| 一封「谢谢」这类无关邮件要不要进 Sam？ | 发件人已知且模型判为 `unrelated` → 记 `no_change` 审计，**不进 Sam**。发件人未知则进 Sam。 | Sam 的语义是「等人决定」；把客套话塞进去会淹没真正需要人看的两封。 |
| 订单剂量缺单位（`"7.5"`） | 不补 `mg`，直接 `MANUAL('unknown_dose:7.5')`。 | 补单位属于「单位推断」，与 §4.3 的禁止项冲突；`2.5` 补成 `25` 是要命的错法。 |

## 11. 非目标（有意不做）

- UI / 实时看板（会吃掉全部时间预算）。
- 单进程重启之外的持久化。
- 模型/prompt 基准测试（可做的简单加分项，但不是核心）。
- 草拟回复（廉价加分项；核心和 README 完成后有余力再说）。
- 药房整周停摆 vs 单日停摆的特殊交互（fact 模型能表达，但不做专门 UX）。

## 12. 产品验收标准

这里只列行为。交付层面的清单（README、仓库、`core done`）在
[`ASSIGNMENT.md`](ASSIGNMENT.md) 第 9 节。

- [ ] `npm install && npm start` 在 :3000 提供 `POST /webhooks`。
- [ ] `node sim/sim.mjs --target http://localhost:3000/webhooks --ping` → 三条
      2xx，"no problems"。
- [ ] `node sim/sim.mjs --target http://localhost:3000/webhooks` → exit 0，每个
      订单恰好发一次。
- [ ] `npm test` 通过。
- [ ] `npm run verify` 通过全部安全不变量，且与期望 fixture 一致。
- [ ] 周中重启：杀掉进程再启动，整周仍能完成。
