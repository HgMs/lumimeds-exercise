# LumiMeds pharmacy desk

一个 TypeScript 服务：接收模拟器回放的一周事件（`POST /webhooks`），用 LLM 读药房/ops 的
邮件、在代码里校验后落成只追加的 fact，然后按订单 `occurred_at` 时刻的信念把订单路由到
某家药房或 `MANUAL`，并把决策写成可解释的审计记录。

行为规范见 [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md)，数据形状见
[`docs/DATA-CONTRACTS.md`](docs/DATA-CONTRACTS.md)，结构与模块见
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

---

## 1. 做了什么、怎么跑

- 单进程 Node 服务，一个 `POST /webhooks` 入口，另有 `GET /orders/:id`、`GET /sam`、
  `GET /health`、`GET /state` 四个只读端点；状态常驻内存，每个事件处理完原子写
  `data/state.json`（tmp + rename），发单前写 `data/inflight.json`（WAL）。
- 邮件流水线：`SenderResolver` → `LlmExtractor`（Anthropic Messages API，强制 tool
  schema、`temperature: 0`）→ `FactValidator`（权限、目录/剂量精确匹配、州归一化、
  时间短语合并、区间与窗口校验）→ 只追加的 `FactStore` / 或挂进 Sam 列表。
- 订单流水线：`OrderNormalizer` → `BeliefResolver`（T 时刻信念）→ `OrderRouter`
  （纯函数：安全资格过滤 → ops 偏好 → 速度/价格/id 排序）→ `OrderDispatcher`
  （201 终局、409 视为已发、5xx/超时只对同一药房重试）。
- 审计：`out/facts.jsonl`（每封邮件一行）、`out/decisions.jsonl`（每单一行）、
  `GET /orders/:id`（解释某一单）与 `GET /sam`（被挂起的邮件）。

### 运行

```bash
npm install            # 只有 devDependencies（typescript + @types/node），无运行时依赖
cp .env.example .env   # 填 ANTHROPIC_API_KEY
npm start              # 默认 http://localhost:3000
```

另开终端：

```bash
node sim/sim.mjs --target http://localhost:3000/webhooks --ping   # 三条 → 200
node sim/sim.mjs --target http://localhost:3000/webhooks          # 整周；exit 0 表示每个事件都应答、每个订单都发出
```

其他命令：

```bash
npm test        # node:test 单测/契约/守卫/集成（不访问网络、不起真端口）
npm run verify  # 独立实现的安全求值器：读 out/*.jsonl 重算「T 时刻能不能发」
npm run typecheck
```

**离线演示（无 API key）**：`LLM_MODE=replay npm start`，抽取结果从
`test/fixtures/llm/week-a.extractions.json` 回放（仅覆盖 week A，用于演示/测试，
不是正式跑法）。

> 环境：Node ≥ 22.9（用到 `--env-file-if-exists` 与原生 TS type 转换）。运行入口是
> `node --experimental-transform-types src/index.ts`，所以不需要 `ts-node`/`tsx`/构建产物；
> `tsc --noEmit` 只做类型检查。`ANTHROPIC_API_KEY` 只从 `.env`/环境读，不入库。

---

## 2. 技术栈选择与理由

| 选择 | 理由 |
|---|---|
| Node 22 + TypeScript，ESM | 题目允许任意 TS 栈；单进程 HTTP 服务用 Node 足够，`fetch`/`Intl`/`node:test`/`node:http` 都是内置能力。 |
| **零运行时依赖** | `node:http` + 40 行 Router 够用；手写 80 行窄校验器比「Anthropic SDK + zod」少一层版本漂移，`npm install` 在评审机上更不可能失败。 |
| 六层分层（kernel/domain/application/adapters/interfaces/wiring） | 为了把「不读进程时钟、可重复、安全判定」变成**可验证**的约束（守卫测试），而不是靠 review。domain 零 IO，路由是纯函数。 |
| 只追加 fact + 求值函数 | 「T 时刻我们相信什么」是评分点；更正 = 再追加一条，历史不改写。 |
| `Result` 而非异常 | 校验失败是数据（进 Sam），不是程序错误；用异常会诱导 `try/catch` 吞掉。 |
| Node 原生 type 转换（不用 tsx） | 运行器零依赖、离线可用；代价是类型导入必须写 `import type`（`tsconfig` 的 `verbatimModuleSyntax` 强制）。 |

---

## 3. 为什么相信它能工作

三道互相独立的检查（`docs/REQUIREMENTS.md` §8）：

1. **`npm test`**：kernel（含 DST 边界）、归一化、fact 求值、信念、容量、路由、短语解析、
   校验器、权限、适配器契约、快照 round-trip、幂等/重启集成，以及依赖方向/无进程时钟/
   无 week A 字面量等守卫。
2. **整周回放**：`node sim/sim.mjs --target …` → exit 0，`out/run-log.jsonl` 38 单、
   `problems` 为空；3 次重投（`evt_011/020/032`）不产生重复副作用。
3. **`npm run verify`**：不复用 `OrderRouter` 的**独立**求值器，按 `out/decisions.jsonl`
   与 `out/run-log.jsonl` 重算每单在其 `sim_time` 时刻的安全资格、每单恰好一次、
   `MANUAL` 只在无候选时使用、ops 偏好未被违反（除非记录了 override）。

另外 `test/fixtures/week-a.expected.json` 是人工核对过的 order → pharmacy 对照表，
集成测试逐单比对 chosen/basis；它抓的是「不变量都对、但信念算错」这一类问题。

（实测证据见本文件末尾「验收记录」。）

---

## 4. 订单去哪、目标冲突怎么解

按 `REQUIREMENTS` §2/§5，优先级固定为：**安全 > ops 偏好 > 速度 > 价格 > 少用 MANUAL**。

- **安全**是硬过滤：营业、能发该州、有该精确剂量、当天（ET 日）还有容量；任何一条不过
  就不是候选。已发单 `201` 是终局，永不改派。
- **ops 偏好**（`routing_preference` fact）只在安全候选里缩窄选择范围：按特异性
  （dose?2 + state?1）→ 后断言 → 序号排序，取**第一个可用的**指定药房；指定药房不安全时
  回落到下一家并记 `override`。它永远不会把订单推给接不了的药房。
- **速度 > 价格**：安全候选按 `(shipsInDays, price, id)` 确定性排序；两只差一天就选快的，
  同样快才比价，最后用 id 破平局（三次重放结果一致）。
- **MANUAL** 只在候选集为空时使用；`reason` 逐家列失败码（`closed` / `state_blocked:NJ` /
  `no_stock:tirzepatide:2.5mg` / `capacity_full`），Sam 不用重读整周。
- 路由过程中出现 bug/异常 → 兜底发 `MANUAL`、`reason: internal_error:<code>`，**绝不留下
  未发订单**；这类兜底与「真的没有候选」都能从 `reason` 前缀区分，verify 按白名单判定。

---

## 5. 主动没做什么

- **UI / 实时看板**：吃时间预算，且不影响路由正确性；解释性用 `GET /orders/:id`、
  `GET /sam`、`GET /state` 与两份 JSONL 覆盖。
- **模型/prompt 基准测试**（「cheaper and better」加分项）：需要额外时间盒与多次真实调用；
  `LlmExtractor` 是端口、`ReplayExtractor` 让「同输入换模型」可复现，但本次没有跑基准。
- **草拟回复**：`ReplyDrafter` 端口与 `SamEntry.draft_reply` 字段已留好，核心实现里恒为
  `null`（`NullDrafter`）。
- **真实数据库 / 多实例 / 鉴权 / 真实收信**：题面明确不需要；状态在内存 + 单文件快照。
- **自适应的 LLM 重试/降级策略**：只有「重试一次 → 进 Sam」，不做多模型 fallback，避免
  不确定性；失败可见比静默猜更安全。

---

## 6. 我认为模糊的规则，以及我的决定

完整清单在 `docs/REQUIREMENTS.md` §10（15 条）。最关键的几条：

| 模糊点 | 决定 | 理由 |
|---|---|---|
| ops 指令是硬规则还是偏好？ | **偏好**，从属于安全；不安全时回落并记 override。 | 安全是第 1 目标；让接不了的药房接单比绕路严重得多。 |
| `until Monday` 含不含周一？ | **不含**：周一 00:00 ET 恢复（区间排他）。 | 常规英语语义；更短的限制更安全。 |
| `phrase` 与模型日期冲突时谁赢？ | **逐字段合并**；粒度不同按 ET 日期比较不算冲突；日期不同整封进 Sam。 | `phrase` 可能被截断（"until Wednesday" 抄成 "Wednesday" 会反转语义），越"自信覆盖"越危险。 |
| 同一药品多条偏好并存？ | 按特异性 → 后断言 → 序号取**第一个可用者**，不是「先取集合再按速度排名」。 | 偏好表达 ops「发给谁」的意图，不能退化成只看速度。 |
| `dose`/`state` 缺省的偏好 | **通配**。 | week A 的 `evt_027` 只写 semaglutide，意图是所有 sema 单。 |
| `closed`/`stock_unavailable` 没写结束时间 | 按无限期生效，审计留 assumption，**不进 Sam**。 | 否定类事实按无限期是安全侧；拒绝反而把「营业/有货」留在原地。 |
| 订单剂量缺单位（`"7.5"`） | 不补 `mg`，直接 `MANUAL('unknown_dose:7.5')`。 | 补单位属于单位推断；`2.5` 补成 `25` 是要命的错法。 |
| 未知发件人的「无关」邮件 | 仍进 Sam（身份门先于 intent 短路）。 | §4.1 的「其他人 → Sam」不能被「看起来无关」绕过。 |
| 未来停业/未来缺货 | **不预检**：只看 `occurred_at` 那一刻的信念。 | 今天能发的单不能因为「明天停业」被误拦；自创预检会让隐藏周不可预测。 |
| 容量下调后当天已超发 | `capacityLeft = max(0, …)`，当天立即停接，**不追回**已发单。 | `201` 终局。 |

---

## 7. 已知错误 / 未测的部分

- **`409` 与重启存活（唯一会 exit 1 的窗口）**：发单前写 WAL、`201`/`409` 后清。若崩溃恰好
  发生在「药房已受理、我们还没提交快照」之间，恢复会按 WAL 药房原样重发一次；药房回
  `409`，模拟器记 `sent more than once` 并让本周 exit 1。**不会**把同一单发给两家药房
  （恢复绝不重新路由，这是刻意的取舍）；README/日志会留痕。窗口 = 一次 HTTP 调用的时间。
- **「已 200 但订单只在重试队列（内存）」**：此时还没有 WAL，若进程崩溃，该订单不会自动
  恢复，可能以 `never sent` 结束。这是「先回 webhook 还是先等发单」的取舍；已用内联重试
  把窗口压到最小。
- **真实 LLM 未在本机实测**：开发环境没有 `ANTHROPIC_API_KEY`，整周回放用的是
  `ReplayExtractor` + 录制的抽取 fixture；`AnthropicExtractor` 的请求形状/响应解析有契约
  测试（假 fetch）覆盖，但没有对真实 API 的端到端验证。这是本次最大的未测点。
- **`phrase` 截断无法用代码完全消除**：若模型把 "until Wednesday" 抄成 "Wednesday"，
  两侧日期可能都对得上而语义反转；缓解是 prompt 强制逐字抄写 + 审计同时保留 phrase 与
  采用区间 + 日期冲突进 Sam，但这不是形式化保证。
- **审计与快照可能短暂不一致**：JSONL 不 fsync，快照才是真值；崩溃可能丢审计行（可用快照
  重放补）。`verify` 不重建审计，所以审计严重缺失时它会失败——这是有意的信号。
- **本机沙箱的特殊性**：本仓库开发环境禁止 `child_process` 子进程管道，因此 `node --test`
  用了 `--experimental-test-isolation=none`（测试文件在同一进程内跑）；评审机没有这个限制。
- week A 回放只覆盖周一到周三 16:00；`evt_002/020/027/040` 的右边界（11-13、11-16）与时区
  DST 边界只能靠单测验证。

---

## 8. 上生产前会改什么

1. **持久化**：单文件快照换成事务数据库（或至少快照双代 `state.json` + `state.prev.json`
   回退），把「恢复失败 = 整周无会话」降为「最多丢一个事件」。
2. **幂等与恢复**：给 `StateStore.save` 加单调 revision 拒绝旧写；`inflight` WAL 加超时与
   人工对账入口；区分「订单值得重发」与「结果未知需查询」——真实药房有查询 API 时优先查。
3. **LLM 层**：真实 API 的超时/限流/重试预算、结构化输出校验、prompt 版本化与回归集；
   对抽取结果做抽样人工复核（本次用 fixture 代替）。
4. **可观测性**：结构化日志 + 指标（事件延迟、LLM 失败率、MANUAL 率、容量超发告警）、
   审计文件轮转与完整性校验。
5. **多实例/鉴权**：会话绑定到单个实例（粘性路由或外部会话存储）；`/webhooks` 签名校验；
   `/sam`、`/orders/:id` 加访问控制。
6. **安全**：prompt 注入已用「权限在代码里 + 模型无发单能力」防护；生产还需要对邮件内容
   做 PII 处理和审计留存策略。

---

## 9. 怎么用 AI、哪一次没采纳

本仓库的文档（需求/契约/架构/推演）先由人主导定稿，实现阶段由多个 AI agent 并行写模块，
每一波都有 lead 审查接口与运行测试。AI 生成的东西不是直接采信：接口由 lead 先写死契约
（`src/application/ports/**`、`src/domain/facts/fact.ts` 等），模块之间靠 tsc 与测试对齐。

**一次没采纳 AI 建议的具体例子**：实现 `EtCalendar` 时，最初的草案用
`epochMs + n * 86_400_000` 做日期加减；这在 week A（整周冬令时）上完全正确，但隐藏周若
跨 3 月/11 月的 DST 切换日，一天不是 24 小时，会算错容量日与 `until` 边界。我否掉了这个
更简单的写法，改为「经 `Intl` 取 ET 墙上时间 + 纯日历字段加减 + `startOfDay` 两轮反推」，
并用 2026-03-08/2026-11-01 的 23h/25h 单测钉住。另一个例子：有建议让「偏好命中集再按速度
排名」，这会让特异性计算变成死代码、ops 的意图退化成速度，被我改成「按偏好顺序取第一个
可用者」。

---

## 目录与文档

```
src/
  kernel/       零依赖基元：Result/AppError、IdSequence、SerialQueue、Deadline、Instant/EtDate/EtCalendar/Interval
  domain/       纯函数/纯类：目录、药房、归一化、fact 只追加求值、信念、容量、路由、邮件校验
  application/  用例编排与端口：EventProcessor、三个用例、会话/快照、发单/重试/恢复、审计
  adapters/     AnthropicExtractor、ReplayExtractor、HttpPharmacyGateway、FileStateStore、JsonlAuditSink
  interfaces/   node:http 封装、Router、handlers
  wiring/       组合根（唯一同时看到 adapters 与 interfaces 的地方）
test/           unit / contract / integration / guards + fixtures
scripts/        verify.ts（独立求值器）
sim/            题目自带模拟器（只读，未修改）
docs/           需求、数据契约、架构设计、逐场景推演
```

## 验收记录

2026-11-18，本机（Windows，Node 22.15，`LLM_MODE=replay`：无 API key，抽取结果由录制 fixture 回放）。

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | exit 0（无输出） |
| `npm test` | **473 tests / 90 suites / 473 pass / 0 fail**（约 5.8s）。含 11 个集成用例：整周回放、重投幂等、3 个崩溃点重启、2 个 WAL 窗口、409/5xx/timeout 注入 |
| 整周回放 `node sim/sim.mjs --target http://localhost:3000/webhooks` | **exit 0**：`delivered 52 of 52 events; 38 of 38 orders sent to a pharmacy or MANUAL; no problems` |
| 与 `test/fixtures/week-a.expected.json` 比对 | **38/38 chosen 一致**；basis：rank 31 / ops_preference 2 / manual 5 |
| `npm run verify` | **exit 0，38/38 单通过**（独立求值；容量表与 `ARCHITECTURE` §14.2 逐格一致） |
| `GET /health` | `{"ok":true,"events":49,"orders_sent":38,"sam":2,"pending_sends":0,"degraded":false}` |
| 周中重启（保留 `data/state.json` 重启进程） | `/health` 恢复为 events=49 / orders_sent=38 / sam=2；`/orders/ORD-1001`、`/state` 正常 |
| `GET /sam` | 2 条：`evt_003`（药房发路由指令 → `routing_requires_ops`）、`evt_004`（25mg → `unknown_dose:25mg`） |

产物：`out/run-log.jsonl` 38 行（评分依据，模拟器写）、`out/decisions.jsonl` 38 行、
`out/facts.jsonl` 10 行（8 applied + 2 rejected）。`events=49` 是 52 个事件里 3 次重投去重后的
唯一 `event_id` 数。

> 真实 Anthropic API 的端到端验证需要 `ANTHROPIC_API_KEY`（本机没有），因此本次验收是
> `ReplayExtractor` 离线回放；`AnthropicExtractor` 的请求形状与响应解析由 `test/contract`
> 的假 fetch 覆盖。见第 7 节「已知错误 / 未测」。
