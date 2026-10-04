# CONTEXT.md — 领域词汇表

> 本文件是项目领域语言的单一事实源。代码、测试、文档、对话一律使用这里的词汇；新增概念先入表再使用。格式参考 deepseek-harness 的 glossary 纪律：一词一义，拒绝同义词漂移。

## 核心实体

- **Instance（实例）** — 拥有项目、任务、配置、插件及本地数据的稳定产品主体；无需账户即可存在。_Avoid_: 用户账户、假用户、工作区账户。
- **Project（项目）** — 实例内按 Design、Code 或 Flow 组织任务与产出物的工作容器；Code 项目持有默认工作目录及附加授权目录。
- **Task（任务）** — 用户与 agent 交互的**一等容器**：对话流 + 多次运行 + 产物关联。Code Task 拥有创建时确定的主工作目录。_Avoid_: 独立聊天实体、临时运行目录。
- **Run（运行）** — agent 的单次执行：工具调用、事件流、产物输出。1 Task → N Run。
- **Canvas（画布）** — Project 级可视化编排视图（Excalidraw）。Task 产物可被画布引用，不强制绑定。

## 身份与连接

- **Access Client（接入客户端）** — 已获授权访问某个实例的桌面、浏览器或脚本客户端；与数据归属主体分开。_Avoid_: 本地账户、成员。
- **Local Actor（本地调用者）** — 一次本地操作所属的实例与发起该操作的接入客户端。_Avoid_: 已登录用户、管理员身份。
- **Local Access Credential（本机接入凭据）** — 客户端获得本地实例访问权的凭据，与供应商凭据和官方账户凭据分开。
- **Official Account（官方账户）** — 官方身份签发方认可的主体，只用于获得对应官方服务的授权；不是本地实例的数据所有者。_Avoid_: 本机用户、全局产品身份。
- **Service Entitlement（服务权益）** — 特定身份获得的某项服务使用权；不改变本地实例的所有权或 BYOK 能力。_Avoid_: 本地权限、全产品会员资格。
- **Remote Connection（远端连接）** — 本地客户端与一个独立服务实例建立的连接及授权关系；自部署身份与官方身份独立。
- **Resource Origin（资源来源）** — 资源所属的服务实例；与资源自身标识共同确定其身份。_Avoid_: 无来源的全局资源 ID。
- **Execution Target（执行目标）** — 一个任务实际执行并持有其执行状态的实例；账户切换不会改变既有任务的执行目标。
- **Data Root（数据根目录）** — 一个本地实例全部应用管理数据的共同归属目录；用户授权的外部项目目录不属于它。_Avoid_: 单会话导出、云端同步目录。

## 执行与权限

- **Sandbox（沙箱）** — OS 级执行囚禁。三档：`read-only` / `workspace-write`（默认，可写根 = 项目文件夹）/ `danger-full-access`。只拦「能不能」，不拦「问不问」。主后端为 **srt**（`@anthropic-ai/sandbox-runtime`，三平台 + 网络域名白名单），经自建 Sandbox 缝隔离、可换后端；fail-closed（无 runner 绝不裸奔）+ enforcement 等级报告。
- **Approval Gate（审批门）** — 应用层逐操作同意：文件编辑 / 危险命令 / 未白名单网络的确认弹窗 + 一次性行内提权。
- **Permission Mode（权限模式）** — 四档产品预设（沙箱档 × 审批门的组合，Task 内可切换）：`plan`（计划模式）/ `ask`（变更前确认）/ `auto-edit`（自动编辑）/ `full-access`（完全访问）。
- **Capability Node（能力节点）** — 向服务端注册能力清单的 Worker 进程（云端容器 / 桌面本地 / 移动受限）。任务按能力路由。
- **Job（队列任务）** — 后台队列的执行单元（图/视频生成等）。与 Task（用户工作项）严格区分；与 Run（agent 执行）严格区分。
- **Execution Scope（执行作用域）** — 持久 Task 在当前授权代际下可访问的工作目录与可执行操作的边界；与接入客户端身份分开。
- **Task Work（Task 后台工作）** — 由 Task 持有、可跨越单次 Run 生命周期的命令或子代理工作；停止前台 Run 不等于关闭全部后台工作。

## 供应商与模型

- **Provider Instance（供应商实例）** — 本地实例中由用户配置的 BYOK 供应商，包含协议、服务地址、供应商凭据引用及模型清单。_Avoid_: 官方账户、接入客户端。
- **Protocol（线协议）** — 供应商实例的底层协议适配器类型（openai-compatible / anthropic / gemini / 图视频协议），封闭集合。
- **Model Catalog（模型目录）** — 从供应商实例能力推导的可选模型清单；未来远端模型须保留其来源与授权范围。
- **Provider Credential（供应商凭据）** — 用户向模型供应商证明调用资格的 Key 或其它秘密值；不代表 KenFutWork 账户或本地接入权。
- **CLI Provider（CLI 供应商）** — v2 方向：把外部 AI CLI（Claude Code / Codex / Gemini CLI 等）注册为一等 agent 能力的适配层。v1 仅为命令级黑盒执行（沙箱内跑 CLI、取回输出）。

## 知能与资产

- **Skill（技能）** — 实例内的 agent 能力包（SKILL.md + 资源）。Marketplace 后置。
- **Brand Kit（品牌套件）** — 品牌色/字体/资产库，Prosumer 创作者资产。
- **Harness** — 本产品的 agent 运行时子系统（agent loop / 工具缝 / 子代理 / skills / 沙箱执行），也是团队锻炼的核心资产。

## 架构

- **Kernel（内核）** — 服务端插件组合内核（`kernel/`）：`definePlugin` + `composePlugins`。服务认领靠 apply 返回值，依赖靠 inject 类型注入（无服务定位符）；拓扑/环检测/逆序回卷复用 Fastify avvio 引擎。
- **Plugin（插件）** — 服务型（name 即 ctx key，认领至多一个服务）或挂载型（贡献路由/基础设施，name 用 `<域>:<名>`）。
- **Profile（装配清单）** — 插件组合清单：`server` / `worker` / `desktop` / `test`，引用同一批插件定义。

## 形态

- **Desktop Shell（桌面壳）** — Tauri 2 应用：系统 WebView + Rust 薄层 + 服务端 sidecar。
- **Sidecar** — 随桌面端分发的服务端可执行文件（同一服务端代码的本地部署形态）。
