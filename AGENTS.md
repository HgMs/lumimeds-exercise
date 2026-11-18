# AGENTS.md

> 本文件只说明三件事：仓库现在是什么状态、需求与已知事实在哪些文档里、以及必须
> 遵守的约束。「要做什么」一律以 `docs/` 为准，本文件不重复规范内容。

## 1. 仓库现状

- 当前处于**实现阶段**：`src/`（kernel/domain/application/adapters/interfaces/wiring 六层）、
  `test/`（unit / contract / integration / guards）、`scripts/verify.ts`、`package.json`
  都已就位；`npm start` 起 `POST /webhooks` 单进程服务。交付说明见根 [`README.md`](README.md)。
- 验证命令：`npm test`（473 项：单元 + 契约 + 整周回放 + 重启 + 守卫）、`npm run typecheck`、
  `npm run verify`（独立安全求值器，需先跑整周回放产出 `out/`）；离线演示用
  `LLM_MODE=replay npm start`（不需要 API key，抽取结果从 `test/fixtures/llm/` 回放）。
- 已有**架构设计**（[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)）：分层、模块、
  类签名、不变量、失败矩阵、实现切片都与实现对齐（§13.1 的运行器选择、§20 的实现记录已更新）。
- 已有**推演文档**（[`docs/WALKTHROUGHS.md`](docs/WALKTHROUGHS.md)）：按邮件类型逐个
  走「入站 → 抽取 → 校验 → 落地 → 审计 → 影响订单」的每一步；改邮件流水线前先对照它。
- 默认工作是维护实现与文档一致：**行为**先改 `REQUIREMENTS.md`、**形状**先改
  `DATA-CONTRACTS.md`、**结构**先改 `ARCHITECTURE.md`；改完实现后跑上面三条验证命令，
  并保持 `README.md` 的「已知错误 / 未测」两节诚实。

## 2. 文档入口

| 文件 | 作用 |
|---|---|
| [`README.md`](README.md) | **交付说明**：做了什么、怎么跑、9 个问题的回答、验收记录 |
| [`docs/README.md`](docs/README.md) | 文档索引、阅读顺序、权威顺序、术语表 |
| [`docs/ASSIGNMENT.md`](docs/ASSIGNMENT.md) | 面试题本身：时间盒、交付物、README 的 9 个问题、评分方式 |
| [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) | 需求与路由策略（唯一行为规范） |
| [`docs/DATA-CONTRACTS.md`](docs/DATA-CONTRACTS.md) | 数据契约、接口形状、week A 已核对事实 |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 架构设计：分层、模块与类、时序、不变量、失败矩阵、实现切片 |
| [`docs/WALKTHROUGHS.md`](docs/WALKTHROUGHS.md) | 逐类型数据流推演：一封邮件从入站到响应、再到影响订单的每一步（22 条场景 + 20 条断言） |
| [`README.upstream.md`](README.upstream.md) | 上游英文题目原文，只读 |
| [`sim/README.md`](sim/README.md) | 模拟器与外部契约原文，只读 |

文档之间的取信顺序以 `docs/README.md` 的「权威顺序」为准。核对事实（事件数、时间、
药房配置、邮件内容）一律打开 `sim/week-a.jsonl`，不要凭记忆或只凭文档描述。

## 3. 必须遵守的约束

- **文档用中文写**：`docs/` 与本文件正文一律中文；引用英文原文时可以保留英文。
  `README.upstream.md`、`sim/README.md` 是上游材料，不翻译。
- **不改 `sim/`**：`sim/` 下的模拟器、周数据和说明都是题目固定输入，任何文件都
  不能修改。需要临时脚本时就放在 `sim/` 之外，用完删掉。
- **不改 `README.upstream.md`**：上游原文，保持原样。
- **不提交密钥**：`.env` 与 API key 不入库、不进文档、不进示例。
- **单一来源**：不要新增 `*.zh-CN.md` 之类的双语副本；增删或改名后同步
  `docs/README.md` 的索引；行为写进 `REQUIREMENTS.md`，数据与接口形状写进
  `DATA-CONTRACTS.md`，结构与模块划分写进 `ARCHITECTURE.md`。
- **设计不越权**：`ARCHITECTURE.md` 只能细化结构，不能悄悄改行为；设计中被迫新增的
  判断先写进它的 §16「行为差量登记」，定案后再补进 `REQUIREMENTS.md`。
- **推演先行**：邮件流水线的改动要能对上 `WALKTHROUGHS.md` 的对应场景；推演发现的
  新规则先改推演文档与 `ARCHITECTURE.md` §16，再谈实现。
- **以事实为准**：文档里的事实性陈述要能在 `sim/week-a.jsonl` 或 config 里核对；
  文档与事件数据矛盾时先改文档，不要动事件数据。
