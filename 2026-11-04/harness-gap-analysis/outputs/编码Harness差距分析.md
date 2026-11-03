# 编码 Harness 差距分析与提升方案

日期：2026-11-04
范围：`references/` 下全部参考项目（只读分析，本轮未改动任何源码）
证据规则：文中 `path:line` 均为本机真实文件位置；标注「推测（未验证）」的内容表示尚未运行验证。

---

## 一、最值得做的三件事

1. **补上上下文预修剪与大输出外置**（对应 deepseek-harness 的 spill 与 compaction-tool-result-pruner）。
   我们现在只在接近窗口时整体摘要，长会话里一条几万 token 的命令输出会一直占着上下文。先修剪工具结果、把超限文本存到本机文件并返回定位符，再做摘要，能明显减少压缩次数与费用。

2. **建立 Run 时间线与导出**（对应 deepseek-harness 的 session-query 与 codex 的 rollout）。
   现在事件、工具调用、审批、压缩、子代理分散在数据库与前端，用户无法回看一轮到底发生了什么，也无法带证据导出。时间线同时解决排障、复盘与分享，是使用体验差距最大的一处。

3. **把钩子事件从 2 个补到 7 个，并统一两套设置面**（对应 codex 的 hooks 事件模型）。
   服务端只支持 `turn-start`、`turn-end`，而随 ZCode UI 带入的设置页列出 7 个事件。用户从 Claude Code、Codex 迁移时，现有的 `PreToolUse`、`PostToolUse`、`Stop` 等配置没有运行位置。该改动与正在进行的设置域工作有文件重叠，排在设置域完成之后。

---

## 二、参照清单

| 项目 | 定位 | 版本 / 最近提交 | 许可 | 可参考部分 | 明确不可照搬 |
| --- | --- | --- | --- | --- | --- |
| deepseek-harness | Cordis 全插件式 agent harness（会话、压缩、子代理、技能、沙箱、溢出、计划） | 0.2.2-alpha.3 / 2026-11-03 | MIT | 能力缝三元组、compaction 家族、spill、session 事件日志、subagent 家族 | Cordis 内核与插件配置格式；云端 profile/凭据体系 |
| kimi-code | Moonshot 编码 agent monorepo（CLI、VS Code、agent-core-v2） | monorepo 0.1.1，agent-core-v2 0.5.1 / 2026-11-03 | MIT | 循环重试参数（`KIMI_LOOP_MAX_ATTEMPTS_PER_STEP`）、状态机与转录 | 账户与云端额度；其品牌与提示词原文 |
| codex | OpenAI 编码 agent（Rust 内核 + CLI） | Rust workspace / 2026-11-03 | Apache-2.0 | apply_patch 协议思路、14 个钩子事件与 matcher、审批与沙箱、rollout 恢复 | 云端 tasks、ChatGPT 账户打通、专有协议文本 |
| nomifun-tauri | Tauri 桌面 agent（Rust 多 crate + React） | 0.8.19 / 2026-11-03 | Apache-2.0 | 桌面进程运行时、PTY（Unix 与 ConPTY）、本地后端分层 | 其业务模型与账户体系 |
| zcode | 本仓 Code UI 的上游（CLI + 桌面 UI） | 3.17.2 / 2026-11-03 | Apache-2.0 | 工具卡片、计划审批、子代理卡片、设置页组件 | 其云端服务与账号能力；已按移植方案引入的部分另算 |
| cherry-studio | Electron 多供应商 AI 客户端 | 2.1.10 / 2026-11-03 | AGPL-3.0 | 供应商目录与模型注册、MCP 管理、对话渲染 | Electron 主进程/渲染层分工；AGPL 代码不得进入商业版 |
| jaaz | Electron + Python 的本地设计 agent | 1.0.30 / 2026-03-02 | 双许可（Community / Commercial） | 画布与图像生成工具接入方式 | 商业许可限制；Electron 形态 |
| jellyfish | AI 短剧工作流编排 | 0.1.0 / 2026-04-20 | Apache-2.0 | 任务队列、失败重试、脚本处理 agent | 短剧领域模型 |
| octop | 自托管多用户多 agent 平台（FastAPI + React） | 1.0.3b2 / 2026-11-02 | MIT | 插件清单与 UI 卡片、斜杠命令分发、后端 i18n | 多用户/角色/账户体系；控制面数据库结构 |
| langgraph | 有状态图运行时 | 1.2.19 / 2026-11-02 | MIT | checkpoint 持久化、interrupt 审批、恢复语义 | 图编排作为产品主模型 |
| loomic | 本仓前身上游 | 0.0.0 / 2026-09-30 | MIT | 早期业务代码来源（按 `COPYRIGHT.md` 保留声明） | 新功能不再向其回写 |
| mcp-servers | MCP 官方参考 server 合集 | 0.6.2 / 2026-10-28 | MIT 转 Apache-2.0 过渡 | filesystem/git/fetch/memory 等工具定义方式 | 直接复制 server 实现 |
| mcp-typescript-sdk | MCP 官方 TypeScript SDK | 2.0.0-alpha.0 / 2026-10-31 | MIT 转 Apache-2.0 过渡 | 客户端/服务端 API、传输方式、schema 校验 | 直接替换现有 SDK 用法 |
| seedance-2.0-skill | 视频生成 skill 规范样例 | 未标版本 / 2026-09-27 | MIT | SKILL.md、schemas、scripts、evals 的组织方式 | 其视频模型调用细节 |
| system-prompts-and-models-of-ai-tools | 各家 agent 系统提示词合集 | 未标版本 / 2026-10-12 | GPL-3.0 | 提示词结构研究（分段、工具描述、边界声明） | 提示词原文不得复制进本仓 |
| new-api、toonflow-app | 子模块未初始化 | 空目录 | — | 本轮无法盘点 | — |

补充说明：

- `references/loomic` 是 MIT 上游副本，本仓早期代码在其基础上开发，按 `COPYRIGHT.md` 保留声明；它不是新功能的参照对象。
- `references/zcode` 的 `README.md:32-36` 说明 Agent CLI 与运行时在 `apps/zcode-cli/`；本仓已按移植方案复制其 UI，UI 证据可直接对照 `apps/web/src/components/workbench/zcode/`。
- `system-prompts-and-models-of-ai-tools` 是 GPL-3.0 汇编。研究其结构可以，直接复制提示词文本会引入来源与版权问题，也违反「禁止复制专有结构」的既有约束。

---

## 三、能力矩阵

判定口径：

- **等同**：核心能力具备，差异在实现细节。
- **更好**：我们在该维度有明确超出参照项目的可用能力。
- **更差**：能力存在，但覆盖或体验明显不足。
- **缺失**：没有可用实现。

| 维度 | 参照项目做法（证据） | 我们现状（证据） | 判定 |
| --- | --- | --- | --- |
| 1. 会话与任务模型 | deepseek 以 append-only 事件日志持久化会话（`packages/session/README.md`，`packages/session-query/`）；codex 用 rollout 记录并支持恢复（`codex-rs/rollout/`）；langgraph 以 thread + checkpoint 组织（`libs/checkpoint/`） | Task 工作域固定主目录与执行作用域（`apps/server/src/features/task-work/`、`features/execution/scope-service.ts`）；会话与运行记录在数据库（`features/agent-runs/`、`features/persistence/`，含 `session-lock.integration.test.ts`） | 等同（任务身份与作用域更严格；缺少可回放的事件溯源日志） |
| 2. 上下文压缩与摘要 | deepseek 提供自动压缩、`/compact`、工具结果修剪、图片卸载、溢出外置五件套（`packages/compaction/README.md:29-33`） | 输出预留线触发、0.85 与 170k 退化阈值（`apps/server/src/agent/auto-compact.ts:14-15`、`:32-33`）；手动压缩（`agent/native-manual-compaction.ts`）；全量转录保留在归档 | 更差（缺工具结果预修剪与图片卸载；压缩条可见可解释，是现有优势） |
| 3. 工具调用内核与审批 | codex 用 execpolicy + 审批模式 + 沙箱；deepseek 用工具注册表 + guard | `ToolDefinition` 带 `exposure`、`access`、`approvalReviewKind`（`apps/server/src/kernel/types.ts:457-471`）；审批评审与许可（`features/permissions/approval-review-service.ts`、`code-approval.ts`） | 等同（审批带「本项目/本会话」许可与拒绝反馈） |
| 4. 子智能体编排与并发 | deepseek 有 fork/spawn/ACP/Codex/Claude Code 多种子代理后端与控制工具（`packages/subagent/`） | explore/review/worker 三类子代理；深度、并发、续轮受治理约束（`features/code-subagents/plugin.ts:30`、`task-tool.ts:72-104`）；前端有子代理卡片（`zcode/ToolCallBlocks/renderers/agent.tsx`） | 更差（缺外部 CLI 子代理与团队协同；基础编排可用） |
| 5. 命令与斜杠命令 | deepseek 有 `/compact` 等命令插件（`packages/compaction/command-compact/`）；octop 有分发器、处理器与文案目录（`octop/src/octop/infra/gateway/slash/`） | 自定义命令在提交前展开为提示词（`packages/shared/src/contracts.ts:261-270`）；ZCode 壳有斜杠菜单（`zcode/prompt-editor/ChatPromptActionMenu.tsx`），内置命令与宿主接线未证实 | 更差（只有用户自定义命令，缺内置 `/compact`、`/plan`、`/memory`） |
| 6. 钩子 | codex 定义 14 个事件与 matcher、插件声明、输出外置（`codex-rs/hooks/src/lib.rs:29-44`） | 服务端只有 `turn-start`、`turn-end`（`apps/server/src/features/settings/hooks.ts:26`、`packages/shared/src/contracts.ts:246-255`）；随 UI 带入的设置页列出 7 个事件（`zcode/settings/HookForm.tsx:35-43`） | 更差（事件覆盖不足；存在两套设置面） |
| 7. 技能与插件 | deepseek 有 skill、skill-filesystem、tool-skill；codex 有 skills crate；octop 有 `plugin.yaml` 与 UI 卡片插件（`octop/plugins/demo-toolkit/plugin.yaml:1-7`） | 技能导入、市场、沙箱包与创建工具（`features/skills/`）；插件内核扩展点（`apps/server/src/kernel/types.ts`、`features/plugins/`） | 等同（插件内核与技能市场更完整；缺插件声明式 UI 卡片贡献） |
| 8. MCP | deepseek 有客户端与管理器（重启、探测、超时、重连）；官方参考 server 定义工具方式 | stdio、HTTP/SSE、自定义请求头、精选目录、注册表客户端、Task 作用域安装/卸载与上下文工具（`features/mcp/`，含 `task-mcp-service.ts`、`mcp-service.ts:3-4`） | 更好（Task 作用域 MCP 是明确超出；管理器级自动重启策略需补齐） |
| 9. 记忆 | octop 有捕获、召回、排序、存储（`octop-memory`）；codex 有 memories crate；cherry 有知识库 | `MEMORY.md` 索引与记忆目录注入提示段（`features/memory/project-memory.ts`、`consumer.ts`，段序 290）；设置页有规则与记忆区（`rules-memory-section.tsx`） | 更差（手工写入与索引，缺自动提炼、召回排序、遗忘策略） |
| 10. 计划模式与待办 | deepseek 有 plan-mode 与 todo 工具（`packages/plan/plan-mode/`、`packages/todo/tool-todo/src/index.ts:28-38`） | 进入/退出计划工具（`features/code-ui/enter-plan.ts`、`exit-plan.ts`）；待办中间件；计划审批弹窗与待办卡片（`zcode/ElicitationDialog.tsx`、`zcode/ToolCallBlocks/renderers/`） | 等同 |
| 11. 会话恢复与续跑 | langgraph 用 checkpointer 与 interrupt 支持恢复和时间旅行；codex 用 rollout 恢复；deepseek 用 session checkpoint | 回合边界文件快照、预览、恢复与屏障（`features/checkpoints/checkpoint-service.ts:23-79`）；上下文分支（`agent/native-context-branch.ts`）；目标续跑（`features/code-ui/service.ts:1400`、`:2967`） | 等同（文件回滚更强；缺对话级时间旅行界面） |
| 12. 模型与供应商接入 | cherry 有集中供应商与模型注册（`cherry-studio/packages/provider-registry/src/`）；codex 有 `model_providers` | BYOK 供应商实例与协议适配、模型目录、凭据边界（`apps/server/src/features/model-providers/`、`docs/方案设计/改造计划.md` §4.8） | 更好（零账户 BYOK 更贴合本仓边界；协议与目录覆盖需逐项核对） |
| 13. 错误重试与超时治理 | kimi 用 `KIMI_LOOP_MAX_ATTEMPTS_PER_STEP` 与无限重试开关（`packages/agent-core-v2/src/agent/loop/configSection.ts:10-52`、`machine/engine.ts:22-78`）；deepseek 有 guard | 统一治理默认值与区间（`packages/shared/src/governance.ts:14-102`）；请求级重试中间件（`apps/server/src/agent/llm-retry-middleware.ts:1-30`）；环境变量兜底 | 更好（参数集中、可设置、可测试） |
| 14. 用量与成本统计 | deepseek 有 telemetry；octop 有 `usage_log`；cherry 有用量统计 | 追加写 `usage_records`；条目含 token 与成本字段（`features/usage/usage-service.ts:21-35`）；统计页有热力图与趋势（`apps/web/src/components/workbench/usage-stats-section.tsx:8-25`） | 等同（计量齐全；界面只显示 token，缺价格表与金额） |
| 15. 文件编辑与 diff 呈现 | codex 有 `apply_patch` 解析与 unified diff（`codex-rs/apply-patch/src/parser.rs:1-7`、`:145-159`） | Read/Write/Edit/ApplyPatch 工具与审批类型（`features/code-tools/tool-definitions.ts:39-64`）；diff 与展示（`features/code-tools/diff.ts`、`file-display.ts`）；前端内联 diff（`zcode/ToolCallBlocks/renderers/EditInlineDiffContent.tsx`） | 等同 |
| 16. 终端与 PTY | nomifun 有 Unix PTY 与 Windows ConPTY（`crates/shared/nomi-process-runtime/src/platform/unix.rs:104-116`、`platform/windows/conpty.rs:543-816`） | 进程沙箱内 PTY 运行时（`features/process-sandbox/pty-runtime.ts:11-51`）；交互终端服务（`features/code-terminal/service.ts:63-149`）；终端并发上限 4（`governance.ts`） | 等同（macOS/Linux 有实现；Windows 覆盖「推测（未验证）」） |
| 17. 搜索 | codex 有文件搜索；deepseek 有网页搜索；cherry 有 `packages/web-search` | ripgrep 搜索、项目搜索、可选代码索引、网页搜索与抓取（`features/code-tools/file-ripgrep.ts`、`file-search.ts`、`project-search.ts`；`features/code-index/index-store.ts`；`features/search/web-search.ts`） | 等同 |
| 18. 权限与沙箱 | codex 有 execpolicy、seatbelt/landlock；deepseek 有 sandbox；nomifun 有桌面进程隔离 | 权限档位、审批评审、执行作用域、路径授权（`features/permissions/tier-store.ts`、`features/execution/scoped-filesystem.ts:52-59`）；沙箱启动与后端（`features/process-sandbox/linux-launch.ts`、`task-helper.ts`） | 等同（执行身份更强；策略可读性可继续提升） |
| 19. 日志与可观测性 | deepseek 有 telemetry、session-query 浏览与导出；codex 有 rollout；octop 有进程内计数 | 运行记录持久化、WebSocket 事件、WS 日志（`features/agent-runs/`、`apps/server/src/ws/logger.ts`）；缺 run 时间线视图、导出与调用链统计 | 更差 |
| 20. UI 信息密度与可操作性 | zcode 工具卡片渲染器覆盖多种工具；octop 插件可贡献 UI 卡片；cherry 有对话渲染层 | ZCode 卡片已移植（`zcode/ToolCallBlocks/renderers/` 约 40 个，含子代理、MCP、命令、待办、内联 diff）；审批与计划弹窗（`PermissionDialog.tsx`、`ElicitationDialog.tsx`）；两套设置面并存 | 更好（卡片密度与可操作性）；设置面一致性 **更差** |

矩阵截图式结论：

- 我们已经不落后于参照项目的维度：任务身份与执行作用域、BYOK 供应商接入、治理参数、Task 作用域 MCP、审批交互、工具卡片。
- 明显落后的维度：钩子事件、内置命令、记忆自动提炼、上下文预修剪、可观测性、子代理多后端。

---

## 四、精华与糟粕判定

### 4.1 值得吸收（按本仓边界改写）

| 参照做法 | 证据 | 吸收方式（按 Tauri 桌面、本地免账户、BYOK、一切皆插件） |
| --- | --- | --- |
| 工具结果修剪 | deepseek `packages/compaction/compaction-tool-result-pruner/` | 在工具结果进入上下文前按 token 预算修剪，保留头尾与定位信息；预算进治理表，不做固定字面量 |
| 大输出外置与定位符 | deepseek `packages/spill/README.md:12`（`maxInlineTokens` 可选开启，失败保留原结果） | 本机私有目录存全文，返回可读定位符与取回工具；路径随 Task 生命周期清理；不存云 |
| 钩子事件与 matcher | codex `hooks/src/lib.rs:29-44` | 只吸收事件集合与 matcher 概念，事件名与本仓设置字段重新定义；补齐 7 个用户可配置事件 |
| 插件声明式 UI 卡片 | octop `plugins/demo-toolkit/plugin.yaml:1-7`、`demo-ui-card` | 插件可声明工具卡片的数据形状，由本仓前端统一渲染；不引入其 YAML 与目录约定 |
| 记忆捕获与召回 | octop-memory 的捕获、召回、排序分层 | 吸收「捕获 → 待确认 → 写入索引 → 按需召回」流程；存储与字段按本仓记忆目录设计 |
| 会话浏览与导出 | deepseek `packages/session-query/` | 提供 Run 时间线、按工具/审批/压缩过滤、导出 Markdown 与 JSON |
| 命令插件化 | deepseek `command-compact` | 内置命令也走插件注册，不写死在运行时；先补 `/compact`、`/plan`、`/memory` |
| 子代理多后端 | deepseek `subagent-codex`、`subagent-claude-code`、`subagent-acp` | P2 再评估：仅作为可选外部 CLI 适配，默认不启用；不得引入云端账户依赖 |

### 4.2 明确不做

| 参照做法 | 证据 | 不做的理由 |
| --- | --- | --- |
| Electron 主进程/渲染层架构 | cherry `src/main/services/`、jaaz 的 Electron + Python | 本仓桌面形态是 Tauri；照搬会推翻现有进程与权限边界 |
| 多用户、角色、控制面账户 | octop `infra/users/`、`infra/control/` | `DEC-20` 本期免账户、回环本机；接入会制造假账户与身份别名 |
| 云端任务与订阅额度 | codex `codex-rs/backend-client/`、cherry 的 Coding Plan 入口 | BYOK 与本地实例边界冲突；不展示未接通入口 |
| 团队共享任务与协调层 | deepseek `packages/team/` | 当前没有多用户协作需求，先做单实例 Task；避免过早引入协调状态 |
| PTC 运行时与运行时自我修改 | deepseek `packages/ptc-runtime/`、`packages/extensions/` | 权限与可观测性成本高，收益不明确 |
| 插件 YAML 与目录格式 | octop `plugin.yaml` | 本仓已有插件内核；引入第二套清单会造成双源 |
| AGPL 代码与提示词原文 | cherry 源码、system-prompts 汇编 | 许可与版权边界；只学结构，不复制文本或代码 |
| apply_patch 专有语法 | codex `apply-patch/src/parser.rs` | 我们已有补丁工具与 diff 展示；复制语法会制造第二套编辑协议 |

---

## 五、提升清单

排序规则：先做不与设置域重叠、能独立验证的项；与设置域重叠的项排在后面。

### P0-1 上下文预修剪与大输出外置

- 用户问题：长命令输出、整文件读取占用上下文，导致压缩提前发生、费用上升、模型丢失近期细节。
- 改动位置：
  - 新 feature：`apps/server/src/features/tool-output-spill/`（服务定义 + 本机存储实现 + 消费方）
  - 工具结果管线：`apps/server/src/features/code-tools/plugin.ts`、`apps/server/src/agent/kernel-tools-bridge.ts`
  - 压缩前置：`apps/server/src/agent/auto-compact.ts`
  - 治理默认值：`packages/shared/src/governance.ts`（新增 `toolResultInlineMaxTokens`、`toolOutputSpillMaxBytes`）
- 共享接口：是（治理默认值与区间）；不改 HTTP 接口，不改设置页。
- 验证：
  - `pnpm --filter @kenfutwork/shared test`
  - `pnpm --filter @kenfutwork/server exec vitest run src/features/tool-output-spill`
  - `pnpm --filter @kenfutwork/server exec vitest run src/agent/auto-compact.test.ts`
  - `pnpm typecheck`
- 预计触碰的既有文件：`auto-compact.ts`、`kernel-tools-bridge.ts`、`governance.ts`。
- 设置域重叠：低（不改 `contracts.ts` 与设置页；若需要 UI 开关则升级为高，排到后面）。

### P0-2 Run 时间线与导出

- 用户问题：一轮里发生了什么只能翻聊天记录；审批、压缩、子代理、工具失败缺少统一视图；排障与复盘成本高。
- 改动位置：
  - 服务：`apps/server/src/features/agent-runs/`（汇总事件与投影）
  - 路由：`apps/server/src/http/`（新增 `run-timeline.ts`）与 `apps/server/src/openapi/registry.ts`
  - 接口定义：`packages/shared/src/`（新增时间线与导出响应）
  - 前端：`apps/web/src/components/workbench/zcode/`（Run 详情侧栏或标签）
- 共享接口：是（新增 HTTP 接口，必须同步 `registry.ts` 与 `pnpm api:spec`）。
- 验证：
  - `pnpm --filter @kenfutwork/server test`
  - `pnpm --filter @kenfutwork/shared test`
  - `node --test tests/api-spec-consistency.test.mjs`
  - `pnpm typecheck`
- 预计触碰的既有文件：`features/agent-runs/repository.ts`、`openapi/registry.ts`、`features/code-ui/service.ts`（事件投影）。
- 设置域重叠：无。

### P0-3 子代理结果摘要与用量可视化

- 用户问题：子代理卡片只显示过程，看不到结论、耗时与 token；用户难以判断是否值得继续派生。
- 改动位置：
  - 服务：`apps/server/src/features/code-subagents/`（结果摘要与用量汇总）
  - 前端：`zcode/ToolCallBlocks/renderers/agent.tsx` 与 `explore.tsx`
  - 事件：复用现有 run 事件与 `usage_records`
- 共享接口：否（复用现有工具事件字段；若新增字段则改 shared）。
- 验证：
  - `pnpm --filter @kenfutwork/server exec vitest run src/features/code-subagents`
  - `pnpm --filter @kenfutwork/web test`
  - `pnpm typecheck`
- 设置域重叠：无。

### P1-1 钩子事件补齐与设置面统一（排到设置域工作之后）

- 用户问题：7 个事件只在界面上存在，服务端只运行 2 个；迁移用户的钩子配置没有运行位置。
- 改动位置：
  - 接口定义：`packages/shared/src/contracts.ts:246-255`（事件枚举扩到 7）
  - 服务端：`apps/server/src/features/settings/hooks.ts:26`、`apps/server/src/agent/runtime.ts`（调用点）
  - 前端：`apps/web/src/components/workbench/hooks-section.tsx` 与 `zcode/settings/HooksSection.tsx` 收敛为一个入口
- 共享接口：是。
- 验证：`pnpm --filter @kenfutwork/web test`（含 `settings-copy-guard` 与结构测试）、`pnpm --filter @kenfutwork/server test`、`pnpm typecheck`。
- 设置域重叠：高（`contracts.ts`、`settings-service.ts`、设置页）。
- 备注：事件名不照搬 codex 常量，按本仓命名重新定义，避免形成第二套协议。

### P1-2 内置斜杠命令

- 用户问题：只有自定义命令；压缩、计划、记忆写入必须点按钮或输入自然语言。
- 改动位置：新 feature `apps/server/src/features/commands/`（命令注册与解析）、`packages/shared/src/contracts.ts`（命令目录响应）、前端命令菜单接线。
- 共享接口：是。
- 验证：`pnpm --filter @kenfutwork/server test`、`pnpm --filter @kenfutwork/web test`、`pnpm api:spec`、`node --test tests/api-spec-consistency.test.mjs`。
- 设置域重叠：高（命令目录与设置页「命令」区）。
- 先做 `/compact`、`/plan`、`/memory` 三条，其余按使用频率增加。

### P1-3 记忆自动提炼与召回

- 用户问题：长期记忆靠手工维护，跨会话重复说明项目背景。
- 改动位置：`apps/server/src/features/memory/`（捕获与待确认队列、召回段）、设置页记忆区。
- 共享接口：是（新增记忆条目接口与设置字段）。
- 验证：`pnpm --filter @kenfutwork/server test`、`pnpm --filter @kenfutwork/web test`、`pnpm typecheck`。
- 设置域重叠：高（`rules-memory-section.tsx`、`contracts.ts`）。

### P2-1 MCP 管理器健康与自动重启

- 用户问题：MCP server 崩溃后需要手动重连；长会话里工具突然不可用。
- 改动位置：`apps/server/src/features/mcp/mcp-service.ts`、`server-store.ts`。
- 共享接口：否。
- 验证：`pnpm --filter @kenfutwork/server exec vitest run src/features/mcp`。
- 设置域重叠：低。

### P2-2 用量成本展示与本地价格表

- 用户问题：设置页只显示 token，用户无法知道一轮花了多少钱。
- 改动位置：`features/usage/`、`apps/web/src/components/workbench/usage-stats-section.tsx`、模型目录中的价格字段。
- 共享接口：是（价格字段与统计响应）。
- 验证：`pnpm --filter @kenfutwork/server test`、`pnpm --filter @kenfutwork/web test`、`pnpm typecheck`。
- 设置域重叠：中（用量设置与模型目录）。

### P2-3 插件声明式 UI 卡片

- 用户问题：插件只能加工具与提示段，无法决定结果如何呈现。
- 改动位置：`features/plugins/`（插件贡献声明）、`packages/shared/src/`（卡片数据形状）、前端渲染注册表。
- 共享接口：是。
- 验证：`pnpm --filter @kenfutwork/server test`、`pnpm --filter @kenfutwork/web test`、`pnpm typecheck`。
- 设置域重叠：中（插件设置页）。

---

## 六、我们做得更好的具体设计

### 6.1 上下文档位可见、可操作

参照项目把压缩阈值与保留策略放在配置文件里，用户看不见。我们已有「输出预留线」与实际压缩点同口径的实现（`agent/auto-compact.ts:14-15`）。在此基础上：

- 上下文条分三段显示：已用、为回复预留、可压缩。
- 用户可直接点击「压到 60%」，服务端按同一预算函数执行，不产生第二套阈值。
- 压缩前先展示将修剪的工具结果条数与可回收 token，用户确认后再执行。
- 用户能感知的改善：压缩时机可预测，长会话不会在用户以为还早时突然丢历史。

### 6.2 子代理结果卡带结论、用量与下一步

参照项目的子代理卡片以过程为主。我们的卡片改为「结论优先」：

- 顶部一行摘要：完成了什么、改动了哪些文件、是否失败。
- 中部过程可折叠；底部显示耗时、token、派生深度与剩余并发额度。
- 提供两个动作：把结论写入待办、把结论写入项目记忆（经用户确认后落盘）。
- 用户能感知的改善：派生一次就能判断是否继续，不必读完整个过程。

### 6.3 审批卡带影响预览

参照项目的审批以命令或参数为主。我们的审批卡增加影响预览：

- 显示本次写入涉及的文件与 diff 统计（复用 `features/code-tools/diff.ts`）。
- 显示该命令在沙箱策略下可触达的路径范围（复用 `features/process-sandbox/` 的策略结果）。
- 「本项目允许」写入项目级许可，仍受执行作用域约束，不放大权限。
- 用户能感知的改善：批准前知道会影响哪些文件，减少「先批准再回滚」。

### 6.4 Task 作用域 MCP 的可读状态

参照项目多为全局 server 列表。我们已有 Task 作用域安装与卸载（`features/mcp/task-mcp-service.ts`）。补充：

- 每个 Task 显示已安装 server、工具数量、最近一次连接结果。
- 安装失败时给出可读原因与修改位置，例如缺命令、缺环境变量、请求头未配置。
- 用户能感知的改善：多项目并行时不会把 A 项目的 MCP 工具带进 B 项目。

---

## 七、建议实施顺序

每批独立提交，提交前运行对应范围测试与类型检查；跨端接口改动跑全量门禁。

| 批次 | 内容 | 依赖 | 验证命令 |
| --- | --- | --- | --- |
| A | Run 时间线与导出（P0-2） | 无 | `pnpm --filter @kenfutwork/server test`、`pnpm --filter @kenfutwork/shared test`、`node --test tests/api-spec-consistency.test.mjs`、`pnpm typecheck` |
| B | 上下文预修剪与大输出外置（P0-1） | 可独立于 A | `pnpm --filter @kenfutwork/server exec vitest run src/features/tool-output-spill`、`pnpm --filter @kenfutwork/server exec vitest run src/agent/auto-compact.test.ts`、`pnpm typecheck` |
| C | 子代理结果摘要与用量（P0-3） | 依赖 A 的事件投影 | `pnpm --filter @kenfutwork/server exec vitest run src/features/code-subagents`、`pnpm --filter @kenfutwork/web test` |
| D | 钩子事件补齐与两个设置面统一（P1-1） | 设置域本轮工作完成 | `pnpm --filter @kenfutwork/web test`、`pnpm --filter @kenfutwork/server test`、`pnpm typecheck` |
| E | 内置斜杠命令（P1-2） | 依赖 D 的设置面 | `pnpm --filter @kenfutwork/server test`、`pnpm --filter @kenfutwork/web test`、`pnpm api:spec`、`node --test tests/api-spec-consistency.test.mjs` |
| F | 记忆自动提炼与召回（P1-3） | 依赖 D、E | `pnpm --filter @kenfutwork/server test`、`pnpm --filter @kenfutwork/web test`、`pnpm typecheck` |
| G | MCP 管理器健康与成本展示（P2-1、P2-2） | 无强依赖 | `pnpm --filter @kenfutwork/server test`、`pnpm --filter @kenfutwork/web test` |
| H | 插件声明式 UI 卡片（P2-3） | 依赖 C 的卡片渲染基础 | `pnpm --filter @kenfutwork/server test`、`pnpm --filter @kenfutwork/web test`、`pnpm typecheck` |

批次 A、B、C 与正在进行的设置域工作没有文件重叠，可以立即开始。批次 D、E、F 会触碰 `packages/shared/src/contracts.ts`、`settings-service.ts`、`hooks-section.tsx`、`commands-section.tsx`、`rules-memory-section.tsx`，必须等设置域改动合入后再做，避免同时修改同一文件。

---

## 八、证据索引与待验证事项

已确认事实：

- 服务端钩子事件只有两个：`apps/server/src/features/settings/hooks.ts:26`、`packages/shared/src/contracts.ts:246-255`。
- ZCode 设置页列出 7 个钩子事件：`apps/web/src/components/workbench/zcode/settings/HookForm.tsx:35-43`。
- 压缩阈值与退化值：`apps/server/src/agent/auto-compact.ts:14-15`、`:32-33`。
- 治理参数集中在 `packages/shared/src/governance.ts:14-102`。
- 工具定义字段：`apps/server/src/kernel/types.ts:457-471`。
- 用量条目含成本字段：`apps/server/src/features/usage/usage-service.ts:21-35`。
- Task 作用域 MCP：`apps/server/src/features/mcp/task-mcp-service.ts`、`task-mcp-tools.ts`。
- 执行作用域与路径授权：`apps/server/src/features/execution/scoped-filesystem.ts:52-59`。
- 终端 PTY：`apps/server/src/features/process-sandbox/pty-runtime.ts:11-51`。
- 检查点快照与恢复：`apps/server/src/features/checkpoints/checkpoint-service.ts:23-79`。

待验证事项：

- ZCode 壳的斜杠命令菜单是否已接到本仓服务端（推测：当前只展示静态或未接线的命令）。验证方式：在 Code 壳输入 `/`，观察菜单项与提交后的请求。
- 两套钩子设置面是否都落盘到同一存储（推测：ZCode 设置页走工作区服务，本仓设置页走实例设置）。验证方式：分别保存后检查数据目录与重启后的保留情况。
- Windows 终端与 PTY 覆盖情况（推测：当前主要覆盖 macOS 与 Linux）。验证方式：Windows 真机运行终端工具。
- 子代理与主代理的 token 计量是否合并到同一 `usage_records`（推测：可能分开统计）。验证方式：派生一次子代理后核对用量记录条数与归属。
- 用量页面的价格来源是否存在本地价格表（推测：只有成本字段，没有价格目录）。验证方式：检查模型目录与 `usage_records` 写入路径。

---

## 九、结论

参照项目的价值集中在六处：事件日志、压缩前置修剪、钩子事件模型、记忆捕获流程、会话浏览导出、插件声明式呈现。其余部分（Electron 形态、多用户账户、云端任务、团队协调、运行时自我修改）与本仓边界冲突，明确不做。

我们已有的优势不需要重建：Task 身份与执行作用域、BYOK 零账户接入、治理参数集中、Task 作用域 MCP、审批交互、工具卡片密度。当前最该补的是上下文治理与可观测性，其次是钩子与命令的完整性；记忆与成本展示排在最后。

本轮最初为只读分析；随后的实施授权按本文件批次落地了其中与设置域不重叠的部分，结果见第十节。

---

## 十、实施结果（2026-11-04）

### 10.1 批次时间线

分支固定「啃啃在开发」，每批独立提交，`docs/日志.md` 同批记账。工作区中其他会话的 `package.json`、`node-forge` 补丁、`plugins/mihome`、`references/` 改动未纳入提交。

| 批次 | 解决的问题 | 主要文件 | 验证 | 提交 |
| --- | --- | --- | --- | --- |
| B | 模型请求前把超长工具结果修剪为头尾保留，避免单次 `ls` 或日志把上下文撑爆，同时不改持久事件与界面显示 | `agent/tool-result-prune.ts`（新建）、`agent/tool-result-prune.test.ts`、`agent/deep-agent.ts`、`agent/runtime.ts` | 14 项单测；server typecheck | `87b234c6` |
| A | 单轮运行可回看、可导出：把 `code_ui_events` 投影成时间线条目，附用量汇总，提供 JSON 与 Markdown 下载 | `features/run-timeline/*`（新建）、`http/run-timeline.ts`、`packages/shared/src/http.ts`、`openapi/registry.ts`、`docs/api/openapi.json` | 25 项单测；`pnpm api:spec`；契约一致性 3 项；server typecheck | `116faef9` |
| C | 子代理用量按子 Run 归因：前台 `Task` 用 `childRunId` 精确查，后台 `TaskOutput` 用 `childSessionId` 取最近一轮 | `features/usage/*`、`features/code-subagents/*`、`features/task-work/*` | 定向 90 项中 81 过、2 项 integration 跳过、7 项沙箱既有失败 | `f4dcc38a` |
| D | 时间线补齐子代理内部事件：按派发键定位子会话，读取 `child-event:` 前缀并过滤子 Run 生命周期 | `features/run-timeline/*` | 3 文件 / 37 项；server typecheck | `f528aa34` |
| E | 时间线查询层排除增量帧，长对话不再整批读回再丢弃 | `features/run-timeline/repository.ts`、`repository.test.ts` | 3 文件 / 37 项；server typecheck | `d3f55299` |
| F | 404 错误码与共享枚举对齐；补授权、404、Markdown 导出响应头回归 | `http/run-timeline.ts`、`http/run-timeline.test.ts`（新建） | 4 文件 / 43 项；契约一致性 3 项；server typecheck | `2d563afa` |
| P1-1 | 钩子只有「轮次开始/结束」两个事件，工具调用的开始、成功、失败无法挂钩；事件名散落在服务端与网页两处字符串 | `packages/shared/src/contracts.ts`、`packages/shared/src/events.ts`、`features/settings/hooks.ts`、`features/settings/settings-service.ts`、`agent/runtime.ts`、`features/run-timeline/timeline.ts`、`apps/web/src/components/workbench/hooks-section.tsx` | 4 个测试文件；server + web typecheck | `b9744f9e` |
| P1-2 | 斜杠命令只能用户自建，常用动作要手写提示词；内置命令与自建命令需要去重与统一入口 | `features/commands/builtin.ts`（新建）、`builtin.test.ts`（新建）、`features/settings/command-input.ts`、`command-input.test.ts`、`features/code-ui/service.ts` | 7 项内置命令单测；5 项命令输入单测；配置回归 | `a848290f` |
| P1-3 | 记忆只有保存与整文件读取，无法按关键词找回；模型不知道该先查索引还是直接用文件 | `features/memory/project-memory.ts`、`project-memory.test.ts`、`features/memory/consumer.ts`、`features/code-ui/plugin.ts` | 记忆测试 20 项；server typecheck | `fec1904f` |
| P2-1 | MCP 进程掉线后连接悄悄消失，工具消失且没有原因；重启没有上限会形成崩溃循环 | `features/mcp/mcp-service.ts`、`mcp-service.test.ts`、`fixtures/mcp-restart-server.mjs`（新建） | 3 项真实子进程测试（恢复 / 连续掉线 / 手动重连）；server typecheck | `625fb505` |
| P2-2 | 用量汇总没有成本读数，全部未回传时界面会把「未统计」显示成 0 | `packages/shared/src/capability-contracts.ts`、`features/usage/usage-service.ts`、`usage.test.ts`、`apps/web/src/components/workbench/usage-stats-section.tsx`、`apps/web/test/usage-stats-section.test.tsx`、`openapi/registry.ts`、`docs/api/openapi.json` | 9 项服务端用量测试；2 项界面测试；`pnpm api:spec`；契约一致性 3 项 | `a8cdb114` |
| 收尾 A | 任务自动归档扫描间隔写死为一小时，用户无法调整，违反运行时可调数值规则 | `packages/shared/src/governance.ts`、`packages/shared/src/contracts.ts`、`task-archive-governance.test.ts`（新建）、`features/code-ui/task-auto-archive.ts`、`features/code-ui/plugin.ts`、`apps/web/src/lib/agent-governance-settings.ts`、`.env.example` | 6 项治理测试（默认 / 库值优先 / 区间护栏 / 非法 env 忽略）；server + shared + web typecheck | `44c735d7` |
| 收尾 B | 非法 HTTP 代理与非法证书路径被服务端拒绝后，界面没有说明哪里错、怎么改 | `apps/web/src/lib/network-settings-save.ts`（新建）、`apps/web/test/network-settings-save.test.ts`（新建）、`zcode/SettingsPage.tsx`、`zcode/i18n/locales/zh-CN.ts`、`en-US.ts` | 4 项保存包装测试；文案门禁 12 项；web 全量 1251 过 / 103 跳过 | `14419028` |
| P2-3 | 插件能注册工具，但结果只能落在通用工具卡；插件没有可声明的展示结构 | `packages/shared/src/plugin-contracts.ts`、`governance.ts`、`contracts.ts`、`features/plugins/bundle-manifest.ts`、`plugin-cards.ts`（新建）、`plugin-registry-service.ts`、`http/plugins.ts`、`features/plugins/plugin.ts`、`apps/web/src/components/workbench/zcode/host/pluginCards.ts`（新建）、`pluginCardRenderer.tsx`（新建）、`host/main.tsx`、`apps/web/src/lib/agent-governance-settings.ts`、`.env.example` | shared 治理 8 项；server 卡片 10 项；web 5 项；插件注册表 66 项；文案与结构 28 项；`pnpm api:spec` 与契约一致性 3 项 | `73604843` |

全量服务端测试：4955 项中 4179 过、58 失败、718 跳过；失败集中在沙箱与 PTY 族（本机 macOS 27.2 SDK 的 `libproc.tbd` / `libSystem.tbd` 报 `unknown architecture`，编译 PTY 检查器失败并连带超时），与上述批次改动无文件交集，属既有环境基线。

### 10.2 能力矩阵最终状态变更

只列本轮发生变化的维度；未列维度维持原判定。

| 维度 | 实施前 | 实施后 | 说明 |
| --- | --- | --- | --- |
| 上下文压缩与摘要 | 更差 | 接近等同 | 有请求前工具结果修剪；仍缺超大输出外置与旧图片卸载 |
| 子智能体编排与并发 | 更差 | 接近等同 | 子代理结果带按子 Run 归因的用量；时间线可看子代理内部工具 |
| 用量与成本统计 | 缺失 | 接近等同 | 服务端按 Run / 子 Run 汇总，设置页显示预估花费，未回传时显示「未上报」；仍缺价格目录 |
| 日志与可观测性 | 更差 | 等同 | 单轮时间线、子代理合并、Markdown 导出完成；界面入口未接 |
| 钩子 | 更差 | 接近等同 | 事件从 2 个补到 5 个（轮次开始/结束、工具开始/结束/失败），服务端与网页共用同一事件清单 |
| 命令与斜杠命令 | 更差 | 接近等同 | 增加内置 `init`、`review`，与自建命令合并去重；仍缺压缩、计划等状态类命令 |
| 记忆 | 更差 | 部分补齐 | 增加 `memory_search` 关键词召回与提示段引导；仍缺自动提炼与遗忘策略 |
| MCP | 更好 | 更好 | 掉线后自动重启一次，连续掉线停止并给出可读原因，手动重连恢复机会 |
| 插件与技能 | 更差 | 接近等同 | 插件可声明纯数据工具卡片（工具名、标题、键值行、状态），命中则用声明渲染、未命中回退既有工具卡；仍缺插件自带面板的统一入口与卡片值引用工具输出 |

### 10.3 三处比参照更好用的具体改动

1. **时间线直接把父子事件排成一条线，不要求用户展开原始日志。**
   参照项目把子代理事件写在各自的会话文件里，排查时要按派发关系手工拼接。我们的 `mergeChildEvents` 按 `parent_tool_call_id` 的 `<runId>/<toolCallId>` 前缀自动找出本轮全部子会话，只并入工具与重试/压缩/钩子事件，子 Run 的起止不重复出条目；子代理工具事件补上 `subagent_type` 名称与子会话分组键，父子工具同号也不会互相覆盖。用户看到的是交错排序的一条时间线，能直接回答「子代理读了哪些文件、在哪一步重试」。

2. **用量按子 Run 精确归因，而不是只按会话汇总。**
   参照实现多处把子代理 token 记到宿主会话。我们前台 `Task` 返回时用 `childRunId` 汇总 `usage_records`，后台任务用 `childSessionId` 取该子会话最近一轮 Run；没有落账时返回 `null` 而不是 0，避免把「未统计」显示成「零消耗」。用户能区分每个子代理的真实开销，再决定是否继续并行派生。

3. **工具结果修剪发生在模型请求前，不改持久事件与界面显示。**
   参照实现常在工具返回处改写或截断内容，导致回看时看不到原文。我们的修剪只作用于发给模型的消息副本，事件日志与界面仍保留完整输出；保留头尾并插入省略提示，JSON 结果跳过修剪，UTF-16 代理对不拆半。用户既省上下文，又不丢排查证据。

补充一项工程差异：时间线查询在 SQL 层排除 `message.delta` / `thinking.delta` / `canvas.sync` / `flowRun.event` / `task.work`，长对话回看不随增量帧数量线性变慢。

### 10.4 未做项与理由

| 项 | 状态 | 理由 |
| --- | --- | --- |
| P1-1 钩子事件补齐 | 已做 `b9744f9e` | 事件清单收敛到 `packages/shared` 一处；设置页两套入口都读同一字段，未拆两个存储 |
| P1-2 内置斜杠命令 | 已做 `a848290f` | 先做无状态的两个命令（写 AGENTS.md、检查未提交改动）；压缩与计划命令要改 Run 状态，未纳入 |
| P1-3 记忆召回 | 已做 `fec1904f` | 增加关键词召回工具与提示段引导；自动提炼需要确认队列与写入时机，未做 |
| P2-1 MCP 健康与自动重启 | 已做 `625fb505` | 自动重启只做一次防崩溃循环；间隔沿用现有重连逻辑，未新增治理字段 |
| P2-2 用量成本展示 | 已做 `a8cdb114` | 只在第一方设置页统计区显示；ZCode 用量面板属源码保真范围，未改 |
| P2-3 插件声明式 UI 卡片 | 已做 `73604843` | 卡片只允许纯数据（工具名、标题、键值行、状态），走既有 `ToolCallRendererProvider` 贡献点，未命中回退既有工具卡；正文、Markdown、HTML 与自定义样式不开放 |
| 超大工具输出外置 | 未做 | 需要确定落盘位置、读取工具与清理策略；落到任务目录会污染用户工程，落到数据目录模型读不到，属于产品取舍 |
| Web 侧时间线入口 | 未做 | ZCode 源码要求字节保真，入口应走宿主适配层；本轮先完成服务端能力 |
| 真实 Postgres 集成测试 | 未做 | 本机无可用数据库；已写仓储单测锁定 SQL 前缀、参数顺序与实例谓词，集成测试需连接环境后补 |

### 10.5 需要真机确认的清单

1. 真实 Postgres 上跑一次时间线：确认 `<runId>/` 与 `child-event:` 前缀能命中真实 `event_key`，跨实例查询返回 404 而不是别人的数据。
2. 真实一轮含子代理的 Run：确认 `parent_tool_call_id` 确为 `<runId>/<toolCallId>`，并核对子代理工具条目的 `agentName` 是否等于派发时的 `subagent_type`。
3. 长对话（数百条增量帧）下打开时间线：确认查询耗时不再随增量帧线性增长，可用 `EXPLAIN ANALYZE` 对照。
4. 前台 `Task` 与后台 `TaskOutput` 各跑一次子代理：核对返回的 `usage` 与 `usage_records` 中对应子 Run 的汇总一致，未上报成本显示为「未上报」。
5. ZCode 界面接入时间线入口后：确认 Markdown 下载文件名、404 提示与未授权提示都是用户能读懂的短语。
6. macOS 27.2 与 Windows 各自跑一次全量服务端测试，确认沙箱/PTY 失败族与本次时间线批次无关的结论可复现。
7. 真实一轮 Run 里让工具报错（例如执行不存在的命令）：确认 `tool-failed` 钩子触发，时间线条目显示「工具失败」而不是「工具结束」。
8. 真实 MCP server（非夹具）：杀掉子进程，确认只会自动重启一次、状态显示「自动重启未恢复」后可手动重连恢复。
9. 真实项目记忆目录：写入多条记忆后按关键词召回，确认越界大小与超长文件按 `codeReadMaxBytes` / `codeReadPageCharacters` 截断并标记。
10. 设置页把归档扫描间隔改成非默认值并重启：确认生效值来自库值，删除库值后回落到环境变量，环境变量非法时回落到默认 1 小时。
11. 在设置页填非法代理地址与非法证书路径：确认出现「请填写 http 或 https 开头的代理地址」「请填写本机可读的证书绝对路径」，且控件保留旧值。
