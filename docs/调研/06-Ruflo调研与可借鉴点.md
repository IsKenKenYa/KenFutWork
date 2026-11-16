# Ruflo（原 claude-flow）调研与可借鉴点

> 状态：调研记录（2026-09-19）。资料来自仓库与 npm registry 实测（`github.com/ruvnet/ruflo`，2026-09-19 读取）。
> 角色：本文件**只是调研与取舍记录**，不是规格——可借鉴项的落点/契约以权威文档为准（ctx key 表见《改造计划》§4.2，扩展点机制见《改造计划》§4.10，多端落点见《多端产品设计》§5）；采纳与否则在《日志》台账与 §6 决策里记。
> 起因：用户问「能否把 Ruflo 的多 agent 协作架构加入本项目」。结论是**不引入依赖、不照搬形态**；四个能力方向里有两个值得借鉴，但都落进我们自己的缝。

## 1. 它实际是什么（宣传语与实现核对）

对外宣传是「多 AI Agent 协作框架」，实测形态是**给 Claude Code / Codex 套的外壳**（官方自称 meta-harness，即「模型 + 外壳 = Agent」里的那个外壳）：

| 项 | 实测 |
| --- | --- |
| 主包 | `ruflo` 无程序化 API（`main` 是薄包装）、无 `dist/`，转发到 `@claude-flow/cli`（1601 文件 12.5 MB） |
| 编排方式 | `hive-mind spawn` **spawn 一个真正的 Claude Code 进程**（提示词落 `.hive-mind/sessions/*.txt`）；找不到 `claude` 只打印指令 |
| 任务拆解 | `queen-coordinator` 的 `decomposeTask()` 是**按 type 分支的硬编码模板**（coding 固定 `_design → _implement → _test`，`estimatedDurationMs` 写死），复杂度是启发式加权——**该模块零 LLM 调用** |
| 记忆 | SQLite（sql.js / better-sqlite3）+ `agentdb`，自实现 HNSW 向量检索 + FTS5 关键词，RRF 融合；状态落本机文件（`.swarm/memory.db`） |
| 工作流 | 自研状态机（`WorkflowStep.type ∈ {task, condition, parallel, loop, wait}`），状态落 `.claude-flow/workflows/store.json`；**全包无 LangGraph/LangChain**（lock 与已发布 dist 零命中） |
| 模块包 | `@claude-flow/swarm`（零 LLM、零网络，纯协调）、`@claude-flow/memory`（有 standalone 用法）可独立 `npm install`；但**全部停在 `3.0.0-alpha.x`**（swarm 最后发布 2026-05-17、mcp 2026-05-09，落后主包约四个月） |
| 许可与活跃度 | 仓库 MIT（Copyright 2024-2026 ruvnet）；star 约 7.3 万、最近 push 2026-09-18；**975 open issues**；四天发 6 个补丁版，其中三个自承「npm 发布无对应 version-bump commit」 |
| 未能核实 | 文档四处宣称的 agent 数（100+/98/60+/45）与 MCP 工具数（314/323/333/313/210）互相矛盾；README 基准（快 150x–12500x、成本降 75%）无复现记录。**未独立复现** |

## 2. 为什么整体引入不成立（四条冲突）

1. **宿主不对**：核心编排路径要求宿主 CLI 可用（Claude Code），我们是 BYOK 工作台——用户自带供应商与 Key，不能要求装别家的 CLI。
2. **存储不对**：它的状态全在本机 SQLite / JSON 文件（`.swarm/memory.db`、`.claude-flow/workflows/store.json`）。我们硬约束是自管 Postgres 单源 + 工作区隔离（`FORM-9`），本地文件方案在自托管/Web 形态语义对不上。
3. **定位不对**：它是宿主外壳，我们是平台（画布 / 工作台 / 权限档 / 执行模式 / 多端）。整包引入等于引一个与内核竞争的第二装配器，违反「禁止第二套真相」。
4. **成熟度与合规**：能内嵌的模块包全是 alpha、无 `license` 字段、无 LICENSE 文件（仅 README badge 写 MIT）；975 open issues。放进核心链路就是长期维护负担。

## 3. 对照：四个能力在我们这边的现状

| Ruflo 宣传能力 | 我们现状 | 缺口 |
| --- | --- | --- |
| ① 多角色分工（swarm / hive-mind） | `ctx.capabilities` 的**子代理 provider** 承接（《改造计划》§4.10）；deepagents `SubAgent` 已接线，目前仅 1 个业务子代理；六档执行模式 + 四档权限 + 工具门 | 多角色本身不缺机制，缺的是角色供给与**并行 fan-out**（现在并行与否取决于模型同轮发几个 `task` 调用） |
| ② 共享记忆 | LangGraph `PostgresStore`，作用域 `["projects", canvasId, "memories"]`，天然在工作区隔离内；另有「规则与记忆」（工作区设置拼进系统提示词） | **无语义检索**：Store 未配 index/embedding，全仓无 embedding 实现 |
| ③ 工作流编排 | job 队列缝（pgmq / 进程内）+ `registerExecutor()`；`features/jobs` 两个 executor 均为**单步**（`image_generation` / `video_generation`） | **无多步骤编排**：无依赖图、无分支/汇合、无重跑流程、executor 之间不投递任务 |
| ④ 插件扩展 | 内核已成：`ServiceMap` + compose 成环 fail loud + §4.10 的 14 类扩展点；skills / MCP / 插件市场齐备 | 无缺口 |

## 4. 可借鉴的（借机制，不借依赖）

| 编号 | 借什么 | 落点（按现有缝） | 先决条件 |
| --- | --- | --- | --- |
| BRW-1 | **编排原语与 DAG 语义**：`task / condition / parallel / loop / wait` 五类步骤 + 依赖阻塞判定（`isBlocked` / `getPriorityQueue`）+ 加边前环检测 | 从 `features/jobs` 长出编排 executor（《改造计划》§4.10「新增后台任务」那条）；**状态进 Postgres**（`persistence` 缝，工作区隔离内），不学它的 JSON 文件 | 需先拍板「任务依赖图的持久化形状」——独立决策，进 §6 |
| BRW-2 | **记忆的检索模式**：命名空间分区 + 混合检索（向量 + 关键词 RRF 融合 + 多样性重排） | LangGraph `PostgresStore` 的 index 配置 + pgvector，仍走 `persistence` 缝；作用域沿用现成 namespace（`projects/<canvasId>/memories`） | 需先拍板「记忆提取时机与写入策略」（谁写、何时写、写什么），防记忆污染 |
| BRW-3 | **角色定义的声明式清单** | 已有机制（`SubAgent` 声明 + `ctx.capabilities` 注册）；补角色供给时**由模型驱动拆解**（deepagents `task` 工具），不抄它的硬编码模板 | 与执行模式、权限档的组合矩阵需先定（角色 × 模式 × 工具集） |
| 不采纳 | 宿主外壳状态、本地文件存储、任务拆解硬编码模板、联邦/共识协议（raft / byzantine / gossip） | — | 联邦协作与本项目「多端连同一服务端」形态不符（跨机器见《多端产品设计》§6 能力节点，是另一种设计） |

原则照旧：**借方向可以，复制代码/schema/字段名不允许**（仓库硬约束）。

## 5. 开工前要的三条口径（待拍板）

1. 编排持久化：任务依赖图落哪张表、怎么与现有 job 生命周期（重试/死信/退款）对齐；
2. 记忆写入与提取策略：run 结束提取？显式工具写入？两者并存时的去重与遗忘规则；
3. 角色矩阵：哪些角色默认提供、与六档执行模式/四档权限如何组合。

三条拍板后按「一步一提交一步一测试」落地，并在《日志》台账记账。
