# 面试题要求与交付清单

> 来源：Lumimeds 的 GitHub brief（`README.upstream.md`）、可视化引导页
> （pharmacy-desk.buxmann.dev）和面试邮件。英文引用为原文，中文是解读。
>
> **本文只讲「题目本身和怎么交」**。产品要做成什么样，见
> [`REQUIREMENTS.md`](REQUIREMENTS.md)；数据结构和接口形状，见
> [`DATA-CONTRACTS.md`](DATA-CONTRACTS.md)。文档分工见
> [`README.md`](README.md)，agent 工作约定见根目录 [`AGENTS.md`](../AGENTS.md)。

## 1. 时间盒

> **Two hours, then 15 minutes** — Two hours to build, then up to 15 minutes to write your
> README. Both are hard stops. How you split the building time is up to you.

- 构建 **2 小时**，写 README **最多 15 分钟**，两个都是硬停。
- 即使功能做到一半也要停，并在 README 里**说明停在哪**。这是评分点，不是免责声明。
- 时间怎么切由自己决定；题面明确说「质量优于数量」。

## 2. 交付物

> A link to your Git repository, with your code (runnable with `npm install && npm start`, or
> tell us what else it needs) and a `README` covering: …

- 一个可访问的 Git 仓库链接（本仓库：`https://github.com/HgMs/lumimeds-exercise`）。
- 代码能 `npm install && npm start` 跑起来；如果还需要别的东西（API key、端口、Node 版本），
  必须在 README 里写清楚。
- 根目录 `README.md` 必须回答下一节的 9 个问题。
- 题目给的 sim 需要 Node 18+；我们的 app 以 Node 22 为准。

## 3. README 必须回答的 9 个问题

> - what you built and how to run it
> - which stack you chose, and why
> - why you're confident it works
> - how you decide where an order goes, and what you do when the goals conflict
> - what you chose not to do, and why
> - which rules you found ambiguous, and what you decided
> - anything you know is wrong or untested
> - what you'd change before running this in production
> - how you used AI, and one place where you didn't accept what it gave you
>
> We may follow up with some questions about your solution.

| # | 原文 | 中文 | 准备用哪些素材回答 |
|---|---|---|---|
| 1 | what you built and how to run it | 做了什么、怎么跑 | `npm install && npm start`、`.env` 必填项、sim 命令、端口 |
| 2 | which stack you chose, and why | 选了什么技术栈、为什么 | Node 22 + TypeScript 的理由；零/少依赖的取舍 |
| 3 | why you're confident it works | 为什么相信它能工作 | `npm test`、`npm run verify`、全周 exit 0、期望路由 fixture |
| 4 | how you decide where an order goes, and what you do when the goals conflict | 怎么决定订单去哪、目标冲突时怎么办 | REQUIREMENTS §2/§5；ops 偏好 vs 安全的降级 |
| 5 | what you chose not to do, and why | 主动没做什么、为什么 | REQUIREMENTS §11（非目标）、加分项的取舍 |
| 6 | which rules you found ambiguous, and what you decided | 哪些规则模糊、怎么定的 | REQUIREMENTS §10 的 12 条取舍表 |
| 7 | anything you know is wrong or untested | 已知的错误/未测的部分 | 停手时的状态、未覆盖的边界、模型日期解析的风险 |
| 8 | what you'd change before running this in production | 上生产前会改什么 | 持久化、鉴权、幂等补强、可观测性、多实例 |
| 9 | how you used AI, and one place where you didn't accept what it gave you | 怎么用 AI 的、哪一次没采纳 | 具体到「哪个决定、为什么否掉」 |

> 答第 9 题时要写**具体的一次**：AI 给了什么、为什么当时不采纳、最后怎么做的。
> 泛泛说「AI 只是辅助」不算回答。

## 4. 核心要求（core）

> - **It runs the whole week:** every event is handled, and every order is sent to a pharmacy or to
>   `MANUAL`.
> - **An LLM reads the emails.** How you use it is up to you.
> - **No email that's wrong or not allowed changes where orders go.** Anything unclear goes on Sam's
>   list.
> - **Every order follows the goals**, with what's true at the moment it arrives.
> - **You can show it works**, the way you'd ship it at work.
>
> When the core works, **commit with the message `core done`**.

对应到本仓库：

| 要求 | 中文 | 验收方式 |
|---|---|---|
| 跑完整周 | 每个事件都应答，每个订单都发到药房或 `MANUAL` | sim exit 0，`out/run-log.jsonl` 38 单 |
| LLM 读邮件 | 邮件必须经过 LLM 抽取，不能只靠正则硬编码 | 代码路径 + `out/facts.jsonl` |
| 坏邮件不改路由 | 错误/越权/不确定的邮件不改变事实，进 Sam 列表 | 单测：注入、越权、未知剂量 |
| 订单遵守目标 | 按订单到达时刻的真实状态路由 | `npm run verify` 的不变量 |
| 能证明它能跑 | 测试、全周回放、可解释 | `npm test` / `npm run verify` / `/orders/:id` |

`core done` 是一个**提交信息**，核心变绿后再打这个 tag 式提交；不要提前打。

## 5. 加分项（只在核心做好的前提下）

> A bonus only counts if the core works. One done properly beats three half-done.

| 难度 | 加分项 | 完成标准（原文） | 我们是否做 |
|---|---|---|---|
| 🟢 | Cheaper and better | Label a handful of emails, measure how well your app reads them, and compare models (including a cheaper one) and prompts on accuracy, cost and speed. End with a recommendation. | 时间允许再做；不做也要在 README 说明 |
| 🟢 | Draft replies | For everything on Sam's list, draft a reply to the sender for Sam to review and send. | 低成本，可顺手做 |
| 🟡 | Sam's live desk | A page that updates as the week replays: each pharmacy, how many orders it's had today, and Sam's list. Sam can approve a held change, and it applies from that moment. | 不做（吃时间，且要 UI） |
| 🟡 | Explain any decision | Answer, after the fact: "Why did ORD-2011 go where it went?" and "What did we believe about Velmora on Tuesday at 10:00?" | 用 `/orders/:id` + fact 历史做「廉价版」 |
| 🔴 | Ask the desk | Sam asks in plain English… An LLM answers from your app's actual state, says when it doesn't know, and never changes anything itself. | 不做 |
| 🔴 | Survive a restart | Stop your app mid-week and start it again. The week still completes, with nothing lost and nothing done twice. | 用原子落盘做，成本低 |

**策略**：核心 + 重启存活 + 决策解释 + 草拟回复（如果还来得及）；UI 一律不做。

## 6. 评分方式

> - **We replay a week you haven't seen:** the same kinds of emails and orders, different details,
>   three times, because AI answers vary.
> - **Safety first.** One unsafe order outweighs everything else.
> - **Then quality:** following ops instructions, using `MANUAL` only when needed, fast and cheap
>   delivery.
> - **Your judgment:** what you chose to do and not do, and why.

解读：

1. **隐藏周重放 3 次**：不能针对 `week-a` 硬编码；同一输入三次结果要一致（`temperature 0`
   + 确定性平局规则）。
2. **一单不安全压倒一切**：宁可 MANUAL 或绕路，也不能发给接不了的药房。
3. **质量分**：听 ops、少用 MANUAL、快、便宜。
4. **README 的判断题**：冲突怎么解、边界怎么定，比功能数量重要。

## 7. AI 使用规则

> **AI welcome** — Use it as much as you like. You're responsible for what ships.

- 可以大量使用 AI；**出了问题是候选人的责任**，不是 AI 的。
- README 必须写：怎么用的、以及**至少一个没采纳 AI 建议的具体例子**。
- 因此每个 AI 产出的关键决策都要能讲清楚理由，不能只有结论。

## 8. 其他硬规则

| 规则 | 出处 |
|---|---|
| 任意 TypeScript 技术栈，自己搭，并说明为什么选它 | README 表格 |
| 状态放内存即可；不能用 serverless（请求之间会丢状态） | `sim/README.md` |
| 「现在」只能用事件的 `occurred_at`，禁止 `Date.now()` | `sim/README.md` |
| API key 放 `.env`，**绝不提交**，也不要分享 | 面试邮件 |
| 不确定的邮件放 Sam 列表，同时保证订单仍然安全 | 可视化引导页第 3 章 |
| 安全永远第一：发错药房比发不出去更糟 | README / 引导页 |

## 9. 提交前检查清单

- [ ] 仓库可访问（public，或已给评审加权限）。
- [ ] 干净克隆后 `npm install && npm start` 能起服务。
- [ ] `.env` 未入库，`git log -p` 里搜不到 key。
- [ ] 根 `README.md` 覆盖第 3 节的 9 个问题，且第 7 点写了真实停手位置。
- [ ] 存在提交信息为 `core done` 的 commit。
- [ ] README 里贴了全周回放的证据（exit 0、订单数、`npm run verify` 结果）。
- [ ] 说明「2 小时到点时哪些没做」，不要假装做完了。
- [ ] 加分项只列真正做完的，其余在「没做什么」里说明。

## 10. 本仓库与题目要求的映射

| 题目要求 | 本仓库位置 |
|---|---|
| 可运行的 app | `src/`（尚未创建），`npm start` |
| 模拟器 | `sim/`（原样保留，不改） |
| 行为规范 | `docs/REQUIREMENTS.md` |
| 数据与接口契约 | `docs/DATA-CONTRACTS.md` |
| 文档索引与术语 | `docs/README.md` |
| agent 工作约定 | 根 `AGENTS.md` |
| 提交用 README | 根 `README.md`（交付前重写） |
| 本文档 | `docs/ASSIGNMENT.md` |
