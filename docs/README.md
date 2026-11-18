# 文档索引与阅读指南

> 本目录的文档**正文一律中文**（引用题目原文时可以夹英文）。完整的英文文档只有两处，
> 且都是上游材料、保持原样、不翻译、不改动：根目录的 `README.upstream.md`（题目原文）
> 和 `sim/README.md`（模拟器契约）。
>
> 新增或修改文档前，先读根目录的 [`AGENTS.md`](../AGENTS.md)（工作约定）和本文的
> 「权威顺序」。

## 1. 文档地图

| 文件 | 内容 | 读者 | 什么时候读 |
|---|---|---|---|
| [`ASSIGNMENT.md`](ASSIGNMENT.md) | **题目与交付**：时间盒、交什么、README 必须回答的 9 个问题、核心要求、加分项、评分方式、提交前检查清单 | 候选人 / 评审 | 最先读，确认边界与交付物 |
| [`REQUIREMENTS.md`](REQUIREMENTS.md) | **这个 app 要做什么**（唯一行为规范）：目标优先级、领域模型、邮件流水线、路由算法、幂等与持久化、审计、验证、模糊点取舍 | 实现者 / 评审 | 动手前通读；改行为时先改这里 |
| [`DATA-CONTRACTS.md`](DATA-CONTRACTS.md) | **数据与接口的形状**：事件、config、药房 API、内部类型、LLM schema、落盘格式、审计格式、week A 事实清单 | 实现者 | 写代码时放在手边 |
| [`README.upstream.md`](../README.upstream.md) | 上游英文题目原文（只加了一段说明） | 参考 | 需要核对原始措辞时 |
| [`sim/README.md`](../sim/README.md) | 模拟器与外部契约原文（英文，上游自带） | 参考 | 对接事件/药房 API 时核对细节 |

## 2. 阅读顺序

- **第一次接触项目**：`ASSIGNMENT` → `REQUIREMENTS` → `DATA-CONTRACTS` →
  `sim/README.md`。
- **直接开始实现**：`REQUIREMENTS` §2/§5（目标与路由）→ `DATA-CONTRACTS` §1/§2/§3
  （事件、药房 API、内部类型）→ 回来读 `REQUIREMENTS` §4/§6（邮件、幂等）。
- **写交付 README**：`ASSIGNMENT` §3 的 9 个问题 → `REQUIREMENTS` §10/§11（模糊点、
  非目标）→ 你自己跑出来的证据。

## 3. 权威顺序（冲突时）

按从上到下的顺序取信，越靠上越硬：

1. `sim/week-a.jsonl` 与 `sim/README.md`：外部事实（事件内容、API 语义），我们不能改。
2. `REQUIREMENTS.md`：**行为**以它为准（安全、优先级、路由、校验、时间）。
3. `DATA-CONTRACTS.md`：**形状**以它为准（字段、类型、schema、文件格式）。
4. `ASSIGNMENT.md`：**题目与交付**以它为准（时间盒、9 个问题、加分项）。
5. 根 `README.md`：交付说明；它只能**记录**与规范的偏离，不能反过来改规范。

发现文档之间或文档与事件文件不一致时：

- 先确认是否自己理解错了（打开事件文件核对，不要凭记忆）；
- 确实是文档错了 → 改文档，并在提交信息里说明；
- 是行为需要变 → 先改 `REQUIREMENTS.md`（必要时加进 §10 的取舍表），再改代码。
- 永远不要「代码这样做，文档那样写」而放着不管。

## 4. 术语表

| 术语 | 含义 |
|---|---|
| **事件（event）** | 模拟器发来的一个 JSON，`type` 为 `simulation.started` / `email` / `order`。 |
| **`occurred_at`** | 事件的业务时间，就是系统里的「现在」。禁止用 `Date.now()`。 |
| **ET** | `America/New_York`。自然日、午夜、夏令时都按它算；2026-11 全周偏移为 `-05:00`。 |
| **fact（事实）** | 只追加、带生效区间的一条断言（库存、覆盖州、营业、容量、路由偏好）。 |
| **基础 fact** | `simulation.started` 时由 config 展开的初始断言。 |
| **生效区间 `[from, until)`** | `until` 排他；缺省 `until` 表示一直有效。 |
| **求值（evaluation）** | 在时刻 `t` 找出覆盖它、且最后断言的那条 fact；历史不改写。 |
| **候选（candidate）** | 通过安全资格过滤（营业、州、精确剂量、当日容量）的药房。 |
| **合格过滤（eligibility）** | 上面四条硬条件；任何一条不过就不是候选。 |
| **`MANUAL`** | 交给人工。只在候选集为空时使用。 |
| **`routing_preference`** | ops 的路由偏好 fact；从属于安全，可以因安全被回退并记 override。 |
| **override** | ops 指定了某药房，但它不满足安全条件，实际发给了别家（或被记录下来）。 |
| **Sam 列表（Sam's list）** | 被挂起的邮件队列：不改状态，等人工决定。 |
| **重投（redelivery）** | 同一 `event_id` 的事件再发一次；必须 200 且无副作用。 |
| **自然周** | 从周一起算（周一至周日）。"until Monday" 指下一个周一 00:00 ET 结束；week A 的回放只到周三。 |
| **审计产物** | `out/facts.jsonl`、`out/decisions.jsonl`（本服务写）；`out/run-log.jsonl`、`out/deliveries.jsonl`（模拟器写，评分看前者）。 |

## 5. 维护约定

- **中文**：本目录只写中文。不要再产生 `*.zh-CN.md` 之类的双语副本——需要英文的只有
  上游原文。
- **单一真值**：同一个事实只写在一个地方，其他地方用链接。行为写进
  `REQUIREMENTS.md`，形状写进 `DATA-CONTRACTS.md`。
- **更新索引**：增删文件、改文件名、改章节号时，同步更新本文第 1 节和全仓引用。
- **不要改上游**：`sim/` 与 `README.upstream.md` 保持原样（`out/` 由模拟器生成，也不入库）。
- **证据优先**：文档里的事实性陈述（事件数、时间、取值）应能在 `sim/week-a.jsonl`
  或 config 里核对；核不了就标注「待确认」，不要猜。
- **给 agent 的入口**：根 `AGENTS.md` 只讲工作方式与红线，不重复规范内容；规范变更后
  检查它引用的章节号是否还对。
