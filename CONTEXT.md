# CONTEXT.md — 领域词汇表

> 本文件是项目领域语言的单一事实源。代码、测试、文档、对话一律使用这里的词汇；新增概念先入表再使用。格式参考 deepseek-harness 的 glossary 纪律：一词一义，拒绝同义词漂移。

## 核心实体

- **Workspace（工作区）** — 用户域容器。v1 单用户本地；概念保留供多端与未来团队扩展。
- **Project（项目）** — 工作容器：绑定的文件夹（桌面端 = 沙箱可写根）+ Task 集合 + 产出物集合。含**默认项目**收口无项目对话。
- **Task（任务）** — 用户与 agent 交互的**一等容器**：对话流 + 多次运行 + 产物关联。吸收了 Thread（不设独立聊天实体）。`kind`: `chat`（纯对话）/ `work`（终端/文件工作）。
- **Run（运行）** — agent 的单次执行：工具调用、事件流、产物输出。1 Task → N Run。
- **Canvas（画布）** — Project 级可视化编排视图（Excalidraw）。Task 产物可被画布引用，不强制绑定。

## 执行与权限

- **Sandbox（沙箱）** — OS 级执行囚禁。三档：`read-only` / `workspace-write`（默认，可写根 = 项目文件夹）/ `danger-full-access`。只拦「能不能」，不拦「问不问」。主后端为 **srt**（`@anthropic-ai/sandbox-runtime`，三平台 + 网络域名白名单），经自建 Sandbox 缝隔离、可换后端；fail-closed（无 runner 绝不裸奔）+ enforcement 等级报告。
- **Approval Gate（审批门）** — 应用层逐操作同意：文件编辑 / 危险命令 / 未白名单网络的确认弹窗 + 一次性行内提权。
- **Permission Mode（权限模式）** — 四档产品预设（沙箱档 × 审批门的组合，Task 内可切换）：`plan`（计划模式）/ `ask`（变更前确认）/ `auto-edit`（自动编辑）/ `full-access`（完全访问）。
- **Capability Node（能力节点）** — 向服务端注册能力清单的 Worker 进程（云端容器 / 桌面本地 / 移动受限）。任务按能力路由。
- **Job（队列任务）** — 后台队列的执行单元（图/视频生成等）。与 Task（用户工作项）严格区分；与 Run（agent 执行）严格区分。

## 供应商与模型

- **Provider Instance（供应商实例）** — 用户 BYOK 配置的供应商：`protocol`（封闭集合）+ `baseUrl` + `apiKeyRef` + 模型清单 + `compat` 开关。用户在前端「供应商设置」管理。
- **Protocol（线协议）** — 供应商实例的底层协议适配器类型（openai-compatible / anthropic / gemini / 图视频协议），封闭集合。
- **Model Catalog（模型目录）** — 从用户供应商实例 + 平台托管模型合并推导的可用模型清单。
- **CLI Provider（CLI 供应商）** — v2 方向：把外部 AI CLI（Claude Code / Codex / Gemini CLI 等）注册为一等 agent 能力的适配层。v1 仅为命令级黑盒执行（沙箱内跑 CLI、取回输出）。

## 知能与资产

- **Skill（技能）** — workspace 级的 agent 能力包（SKILL.md + 资源）。Marketplace 后置。
- **Brand Kit（品牌套件）** — 品牌色/字体/资产库，Prosumer 创作者资产。
- **Harness** — 本产品的 agent 运行时子系统（agent loop / 工具缝 / 子代理 / skills / 沙箱执行），也是团队锻炼的核心资产。

## 架构

- **Kernel（内核）** — 服务端插件组合内核（`kernel/`）：`definePlugin` + `composePlugins`。服务认领靠 apply 返回值，依赖靠 inject 类型注入（无服务定位符）；拓扑/环检测/逆序回卷复用 Fastify avvio 引擎。
- **Plugin（插件）** — 服务型（name 即 ctx key，认领至多一个服务）或挂载型（贡献路由/基础设施，name 用 `<域>:<名>`）。
- **Profile（装配清单）** — 插件组合清单：`server` / `worker` / `desktop` / `test`，引用同一批插件定义。

## 形态

- **Desktop Shell（桌面壳）** — Tauri 2 应用：系统 WebView + Rust 薄层 + 服务端 sidecar。
- **Sidecar** — 随桌面端分发的服务端可执行文件（同一服务端代码的本地部署形态）。
