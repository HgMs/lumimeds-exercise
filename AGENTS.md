# AGENTS.md — 给编码 agent 的工作指引

> 本文件面向在本仓库工作的 AI agent（以及人来复核 agent 产出）。它只讲
> **怎么干、别干什么**；**要做什么**以 `docs/` 为准。文档与代码冲突时，先停下核对
> `sim/week-a.jsonl` 与 `docs/REQUIREMENTS.md`，修文档或修代码，不要让两者长期打架。
>
> 本仓库自有文档（`docs/`、本文件）一律中文；代码标识符用英文，注释用中文，
> 提交信息沿用现有风格（英文前缀 + 中英文描述皆可）。

## 1. 项目速览

- 这是 LumiMeds 的 take-home：写一个 TypeScript 服务，代替 Sam 值守一周的药房调度台。
- 模拟器把一周的事件（邮件 + 订单）按时间顺序 POST 到一个 webhook；我们用 LLM 读邮件、
  用确定性规则路由订单，再通过药房 API 把订单发给药房或 `MANUAL`。
- 当前状态：**只有文档和模拟器**。`src/`、测试、`package.json` 都还没建；
  动手前先读第 2 节。
- 硬约束一句话：**安全第一，宁可少发、晚发、进 `MANUAL`，也不能发错。**

## 2. 开始任何工作前

1. 按这个顺序读：
   - `docs/ASSIGNMENT.md`：时间盒、交付物、评分口径（先知道自己被怎么评）。
   - `docs/REQUIREMENTS.md`：行为规范，重点 §2（目标优先级）、§5（路由）、§4（邮件）、§6（幂等）。
   - `docs/DATA-CONTRACTS.md`：字段、类型、schema、文件格式，写代码时随手查。
   - `sim/README.md`：外部契约（英文原文，不可改）。
2. 打开 `sim/week-a.jsonl` 核对事实，不要凭记忆或凭文档描述写死数据。推荐先跑一段
   摘要脚本（统计事件数、唯一订单、重投、邮件正文），再开始设计。
3. 记住：week A 只是**一个**可见样例。隐藏周会换细节。**任何针对 `week-a` 具体取值、
   药房 id、订单号、邮件措辞的分支都是 bug。**
4. 仓库里没有 `package.json` 时，先搭最小可运行工程，再写业务代码；不要先写一大堆
   没有入口的文件。

## 3. 红线（违反即视为失败）

| # | 规则 | 说明 / 出处 |
|---|---|---|
| 1 | **「现在」只能用事件的 `occurred_at`** | 禁止 `Date.now()`、`new Date()` 取当前时间；测试也不许。`sim/README.md` / `REQUIREMENTS` §3.3 |
| 2 | **不改 `sim/`、不改 `README.upstream.md`** | 上游材料，原样保留；`out/` 是模拟器产物，不入库。 |
| 3 | **`.env` 与 API key 不入库、不进日志、不进示例** | 用 `.env.example` 占位；提交前搜一遍 `git log -p`。 |
| 4 | **30 秒内回 webhook** | LLM 调用与发单都要在回复之前完成；宁可降级进 Sam 列表，也不要挂住事件。 |
| 5 | **一个订单最多发一次** | 不依赖药房 API 的 `409`（模拟器会记 problem）；`sent_orders` 自己记。 |
| 6 | **`201` 是终局** | 已发订单永不回改，不重算、不重发。 |
| 7 | **状态原子落盘（临时文件 + rename）** | 时机：发单成功之后、回 webhook 之前；`simulation.started` 清空。 |
| 8 | **重投必须无副作用** | 同一 `event_id` 直接 200，不改状态、不重复发单。 |
| 9 | **不确定的邮件不改状态** | 进 Sam 列表并说明原因；订单继续按已知状态安全路由。 |
| 10 | **不把订单发给接不了它的药房** | 营业、州、精确剂量、当日容量，四条缺一不可；容量属于安全。 |
| 11 | **有安全候选就不许用 `MANUAL`** | `MANUAL` 只在候选集为空时使用；否则是质量缺陷。 |
| 12 | **路由必须确定性** | 同一周重放三次结果一致：`temperature 0`、固定 prompt、平局按 `(shipsInDays, price, id)`。 |
| 13 | **LLM 只做抽取，不做路由** | 模型不得决定订单去哪；权限与合法性一律在代码里校验。 |

## 4. 目标目录结构（建议）

```text
package.json / tsconfig.json
src/
  server.ts          # HTTP 入口：POST /webhooks、GET /health、/orders/:id、/sam、/state
  state.ts           # PersistedState、原子读写、启动恢复
  facts.ts           # 追加 fact、按时刻求值
  normalize.ts       # 州名/州码、药品别名、剂量格式归一化
  llm/extract.ts     # Anthropic Messages 调用 + tool schema 校验 + 重试
  email/pipeline.ts  # 权限判定 → 校验 → 应用 fact 或进 Sam 列表
  routing.ts         # 纯函数：快照 + 订单 → RoutingDecision
  send.ts            # 药房 API 调用、退避重试、后台队列
  audit.ts           # facts / decisions 的 JSONL 追加写
test/                # node:test 单测
  fixtures/week-a.expected.json
scripts/verify.ts    # npm run verify
data/state.json      # 运行期生成，gitignore
out/*.jsonl          # 运行期生成，gitignore
```

结构可以按实现调整，但**入口、纯函数路由、追加式 fact、原子落盘**这四点不要动。

## 5. 命令（实现时补齐 npm scripts）

```bash
npm install
npm start                                             # 监听 :3000，POST /webhooks
npm test                                              # node:test 单测
npm run verify                                        # 安全不变量 + 期望路由 fixture

node sim/sim.mjs --target http://localhost:3000/webhooks --ping   # 3 个事件，验证接线
node sim/sim.mjs --target http://localhost:3000/webhooks          # 全周，退出码 0

curl http://localhost:3000/health
curl http://localhost:3000/orders/ORD-2011            # 解释某单
curl http://localhost:3000/sam                        # Sam 列表
```

模拟器自己会在 `:4000` 起药房 API；端口冲突用 `--pharmacy-port 4100`。

## 6. 实现顺序（按投入产出比）

1. **骨架**：`package.json` + `tsconfig.json` + `src/server.ts`，`POST /webhooks` 回 200；
   `--ping` 三条 2xx。
2. **状态与契约**：解析 `simulation.started`，建药房模型；基础 fact；`data/state.json`
   原子读写；`seen_event_ids` 幂等。
3. **路由纯函数**：归一化 + 资格过滤 + `MANUAL` 原因 + 平局规则；先用手工构造的快照写单测。
4. **发单**：`POST /pharmacy-orders`，处理 201/409/4xx/5xx；发单成功再落盘、再回 2xx。
5. **LLM 抽取 + 校验**：强制 tool schema、`temperature 0`、封闭短语解析器、权限校验、
   失败进 Sam。没有 key 时要有明确的降级路径（邮件进 Sam，不崩）。
6. **审计**：`run-log` / `deliveries` 由模拟器写；补 `facts.jsonl`、`decisions.jsonl`、
   `GET /orders/:id`、`GET /sam`。
7. **验证**：单测 → `npm run verify` → 全周回放 → 周中重启。
8. **收尾**：按 `docs/ASSIGNMENT.md` §9 重写根 `README.md`，回答 9 个问题。

时间不够时的优先级：安全路由 > 幂等/持久化 > 审计与解释 > 草拟回复 > 其它加分项。
UI 属于非目标，除非用户明确要求，否则不做。

## 7. 质量门（Definition of Done）

每一条都要真的跑过，并把输出留作证据（最终写进根 README）：

- [ ] `npm test` 全绿。
- [ ] `npm run verify` 通过：每个已发订单在其时刻营业、覆盖州、有精确剂量、未超容量；
      每个订单恰好一次；`MANUAL` 只在无候选时出现。
- [ ] `--ping` 三条 2xx，模拟器输出 "no problems"。
- [ ] 全周回放退出码 0，38 个订单各发一次，无 409。
- [ ] 周中 `kill` 进程再启动，整周仍能完成，不丢单、不重发。
- [ ] `out/run-log.jsonl`、`out/facts.jsonl`、`out/decisions.jsonl` 内容自洽，能回答
      「ORD-2011 为什么去那家」「周二 10:00 我们相信 Velmora 什么」。
- [ ] 文档更新：行为有变 → `docs/REQUIREMENTS.md`；形状有变 → `docs/DATA-CONTRACTS.md`；
      新增文件 → `docs/README.md` 索引。
- [ ] 没有 `Date.now()`、没有硬编码 week-a 取值、没有提交 `.env`。

跑不了的检查（例如没有 API key）要**写明没跑**，不要假装通过。

## 8. 代码约定

- **技术栈**：Node 22 + TypeScript；框架不设限但保持轻量（`node:http` 或轻量框架），
  新增依赖要在 README 里给理由。
- **时间**：只从事件拿时间；ET 自然日用
  `Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })` 之类的标准库换算，
  **不要手写夏令时**。区间语义：`from <= t < until`。
- **归一化**：州名/州码、药品别名（`tirz`）、剂量写法（`7.5 mg`）做成表驱动；
  归一化失败 → `MANUAL` / Sam，并写明原始值。
- **路由**：输入是「某一时刻的派生快照 + 归一化后的订单」，输出 `RoutingDecision`；
  **纯函数、无 I/O、无随机、无时钟**，这样单测和重放才可信。
- **发单**：幂等键是 `order_id`；退避 250/500/1000ms；失败进后台队列，由 drain 兜底。
- **LLM**：一封邮件一次调用，`temperature: 0`，强制 tool schema，超时 12s，schema/传输
  失败重试一次；两次失败 → Sam，状态不变，webhook 仍回 200。
- **日志**：JSONL 追加写；每条审计记录带来源 `event_id` 和时间；先落盘再回 webhook。
- **测试**：`node:test`；优先测纯函数与边界（区间、时区、归一化、权限、容量、平局、
  重投），期望路由 fixture 必须人工核对过再提交。

## 9. 文档与提交约定

- 中文文档，**不要新建 `*.zh-CN.md` 之类的双语副本**；同一事实只写一处，其余用链接。
- 改行为先改 `docs/REQUIREMENTS.md`（必要时补进 §10 的模糊点表），再改代码；
  不要「代码这么做、文档那么写」。
- 提交保持小而完整：`docs: …` / `feat: …` / `fix: …`，前缀英文，描述中英文皆可，
  与现有历史保持一致。
- `core done` 是一个特殊提交：**只在核心五项都绿了之后**打一次，不要提前，也不要重复。
- 根 `README.md` 是交给评审的交付物（当前不存在，交付前重写）：内容必须与 `docs/` 一致。
  它不适用「文档一律中文」的约定——语言按交付对象定（评审是英文语境，通常用英文），
  `docs/` 仍是内部真值。
- 任何「我知道它不对/没测」的东西，写进 README 的「已知问题」，不要藏。

## 10. week A 的坑（速查，细节见 `DATA-CONTRACTS.md` §7）

| 坑 | 触发 | 正确反应 |
|---|---|---|
| 重投 | `evt_011`、`evt_020`、`evt_032` | 200 且无副作用 |
| 提示注入 | `evt_003` | 药房无路由权限 → 拒绝 + Sam |
| 不存在的剂量 | `evt_004`（25mg） | 精确匹配失败 → 拒绝 + Sam |
| 更正 | `evt_017` | 追加新 fact 覆盖旧信念，不改历史 |
| 未来生效 | `evt_002`（from Wednesday） | 按 ET 解析，从周三 00:00 生效 |
| 相对停业 | `evt_014`（closed tomorrow） | 只关下一个 ET 自然日 |
| 临时容量 | `evt_020`（2 单/天 until Monday） | 有效容量取覆盖当日的最新 fact |
| ops 偏好 | `evt_027` | 仅 ops 可下；从属于安全 |
| 偏好被安全挡下 | `evt_040` + semaglutide 订单 | 回落安全候选并记 override |
| 州全名 | config 里 `"Texas"` | 归一化为 `TX` |
| 每日容量 | 不是总量 | 按 `(药房, ET 日期)` 计数 |
| 无候选 | NJ 的 tirzepatide 2.5mg | `MANUAL`，逐家写原因 |

## 11. 交付前自查

以 `docs/ASSIGNMENT.md` §9 的清单为准，至少确认：仓库可干净克隆并 `npm install && npm start`；
`.env` 未入库；根 README 回答 9 个问题并写明停手位置；有 `core done` 提交；贴出全周回放
和 `npm run verify` 的证据；没做的加分项在「没做什么」里说清楚。
