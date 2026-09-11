# DeepSeek Harness（dsh）插件架构调研

> 状态：调研记录（基于 `references/deepseek-harness` 真实源码，commit `cd5ef81`，MIT，developer preview）
> 用途：为 Loomic 插件化改造提供参照。结论已吸收进权威文档（见 `docs/README.md` 地图），本文作为调研记录保留。
> 一句话：dsh 把「一切皆插件」做成了完整闭环——Cordis 内核（服务 + 类型化事件 + 可逆副作用）+ profile/bundle 分层组合 + `dsh plugin` 外部安装分发 + 严格工程门禁。agent 主循环、模型适配器、工具注册表、MCP、skill、子代理、模式、权限，全部是插件。

---

## 1. dsh 是什么

- DeepSeek 官方开源的 **agent harness**（不是 SDK、不是框架库），定位是「运行 agent 的宿主环境」。
- 建立在 **Cordis** 插件框架之上（vendored 进仓库），设计理念见论文《A Programming Paradigm for Spatiotemporal Composability》。
- 核心主张：**没有特权核心（no privileged core）**。产品每一部分都是插件——模型适配器、工具注册表、会话日志、甚至 agent 主循环本身，都能从配置替换。扩展 = 在别的插件旁边挂一个新插件，而不是改核心。
- 形态：一个 monorepo（约 50 个 package 组、数千文件），产物是 `dsh` CLI，按 profile 启动（`dsh web` / `headless` / `sdk` / `sdk-minimal` / `acp`）。

---

## 2. 底座：Cordis 的五个核心概念

来源 `docs/cordis-primer.md`。这五条是理解 dsh 一切扩展机制的钥匙。

1. **插件 = 实现 Service 的对象**：可以是一个带 `inject` / `apply(ctx)` 字段的函数，或一个 `Service` 子类，Cordis 把它的生命周期挂进当前 context。
2. **Context = 服务仓库**：服务认领一个稳定的 `ctx.<key>`（如 `ctx.tools` / `ctx.llm` / `ctx.sessions`）；其他插件按 key 发现服务，**而不是 import 具体实现**。
3. **`inject` 声明依赖**：插件声明它需要哪些服务，就等那些服务就位后再挂载——**加载顺序由「服务需求」拓扑表达，不靠手工 boot 时序**。
4. **类型化事件做通信**：服务通过 TypeScript 声明合并定义事件名，再按 5 种模式派发。
5. **注册即可逆副作用**：提示段、工具 schema、适配器、provider、监听器都通过 `ctx.effect()` / `ctx.on()` 安装并返回 disposer，reload 和 teardown 时按序回卷。

### 2.1 事件派发模式（事件的公开契约）

| 模式 | 是否 await | 派发顺序 | 有返回值 | 典型用途 |
| --- | --- | --- | --- | --- |
| `emit` | 否 | 注册序观察 | 无 | 广播事实 |
| `waterfall` | 否 | 注册序，环绕中间件（必须调 `next()`） | 有 | 拦截/改写请求、策略 |
| `parallel` | 是 | 全部并行 | 无 | 扇出并发 |
| `serial` | 是 | 注册序 | 有 | 有序收集 |
| `bail` | 否 | 注册序，遇到第一个 bail 即停 | 有 | 短路决策 |

派发模式是事件契约的一部分，新事件用 `@mode` 标签声明，生成式 catalog 会校验声明与派发点是否一致。

### 2.2 waterfall 语义（为什么它能做「拦截」）

`ctx.waterfall` 是环绕中间件：监听器收到 `(...args, next)`。调 `next()` 把（可能被包装的）结果委托给下一个服务；不调 `next()` 直接返回即短路。策略型监听器可以在自己拥有决策权时不调 `next()`，而只观察/标注的监听器必须委托。**这就是 dsh 能在不改 agent 主循环的前提下，插入权限审批、请求改写、工具拦截的机制。**

---

## 3. 插件长什么样：以 mcp-client 为例

来源 `packages/mcp/mcp-client/src/index.ts`。MCP 支持在 dsh 里就是一个**普通插件**，没有任何特殊地位——这正是「一切皆插件」的体现。

### 3.1 插件四件套（命名导出）

```ts
// 1) 稳定 id，用于加载诊断
export const name = 'mcp-client'

// 2) 依赖的 ctx 服务，Cordis 据此拓扑排序
export const inject = ['tools']

// 3) 配置 schema（Schemastery，带默认值，加载期校验，fail-loud）
export const Config = z.union([
    z.object({ transport: z.const('stdio'), serverName: ..., command: ..., args: ..., env: ..., /* ... */ }),
    z.object({ transport: z.const('streamable-http'), serverName: ..., url: ..., headers: ..., /* ... */ }),
])

// 4) 挂载逻辑：注册可逆副作用，返回后由 Cordis 管理生命周期
export async function apply(ctx, config) {
    // 占用 serverName 命名空间（重复即拒绝本实例），返回 disposer
    ctx.effect(() => {
        /* 预留命名空间 */
        return () => { /* 释放命名空间 */ }
    }, 'mcp-client.serverName')

    // 连接 stdio 子进程或 streamable-http，发现工具并注册到 ctx.tools
    const connection = startConnection(ctx, config, reconnect)
    ctx.effect(() => () => connection.dispose(), 'mcp-client.connection')

    // 阻塞激活直到首次连接 + 工具发现完成；failOnStartupError 时失败即拒绝 fiber
    await connection.ready
}
```

### 3.2 这个插件做了什么

- 连接一个外部 MCP server（stdio 子进程 或 Streamable HTTP/SSE）。
- 把 server 的工具以命名空间化的公共名注册进 `ctx.tools`：`mcp__<serverName>__<rawName>`。
- **一个插件实例连一个 server**；要连多个就在 `cordis.yml` 写多行配置。

### 3.3 生命周期与热重载（HMR）

- 卸载：断开连接、注销全部工具、释放 `serverName` 命名空间预留——全部经 disposer 回卷。
- HMR 热替换：dispose 旧实例 → 建新实例；相同 `serverName` 复现相同公共工具名，所以对上层稳定。
- fail-loud：`reconnect` 配置错误、`serverName` 重复，都在任何 effect 注册前就拒绝**本实例**，并给出可操作错误信息。
- 作用域：通过 `scopeOf(ctx)` 区分「全局实例」与「某 agent 作用域实例」，命名空间预留按作用域隔离。

---

## 4. 组合：profile / bundle / patch

来源 `docs/architecture.md`。一次运行的 dsh = 启动时按**有序层**组合出来的一棵插件树。

### 4.1 profile（命名的组合物）

- 存放在 Harness home，列出它堆叠的 bundles、持有的 **out-of-tree（外部）插件**、以及用户自己的 `cordis.patch.yml`。
- 内置模板：`web`、`headless`、`sdk`、`sdk-minimal`、`acp`。
- 在 `package.json` 的 `dsh.profile` 字段声明（列出 bundles）。

### 4.2 bundle（分发格式）

- 一批 Cordis 配置行 + 它们挂载的代码，打包成可分发的层，**保证它插入的东西仍可被上层 patch**。
- 在 `package.json` 的 `dsh.bundle` 字段声明（指向 patch 文件）。
- `dsh-base` 是 `web`/`headless`/`sdk`/`acp` 的共享第一层：模型适配器、工具、持久化、**沙箱与审批策略**、设置、凭证、遥测。其上再叠 `dsh-web-app` / `dsh-headless` / `dsh-sdk-app` / `dsh-acp-app`。

### 4.3 分层组合顺序

```text
空 entry 列表
  → 按 profile 列出顺序应用各 bundle
  → 应用 profile 的 cordis.patch.yml
  → 应用 home 级 patch
  → 应用 --patch overlay
```

一个 patch 按 id 定位某一行，替换它的整份配置，或插入新行。

### 4.4 可观测性与热重载

- `dsh --profile web --dump-config` 打印你这台机器实际 boot 出来的插件树；打印出的任意一行都能被你自己的 patch 替换。
- 自定义 profile 默认 **live patch reload**（改配置热生效）；`web` profile 是 live 的；`headless`/`sdk`/`sdk-minimal`/`acp` 只在启动时应用一次（一次性/stdio 应用中途换依赖会破坏其生命周期）。

---

## 5. 外部插件开发与分发（即「插件开发模式」）

来源 `docs/development.md`、`docs/user/develop/basic/publish.md`、`docs/user/guide/python-sdk.md`。这是 Loomic 目前完全没有的一层。

### 5.1 完整生命周期

```text
开发    写一个 bundle 包（package.json 声明 dsh.bundle；src/index.ts 导出 name/inject/Config/apply）
        本地用 --patch overlay 挂载调试
  ↓
打包    构建 lib/；发布到 npm，或 pnpm pack 出 tarball
  ↓
安装    dsh plugin --profile <名> add <来源>
  ↓
组合    profile 目录自动生成/维护：package.json（out-of-tree 依赖 + dsh.profile 有序 bundles）
        + cordis.patch.yml（用户 patch 层）
  ↓
发现    给插件仓库打 GitHub topic：dsh-plugin
```

### 5.2 `dsh plugin` 命令

- `dsh plugin --profile <名> <args...>` **直接转发给 pnpm**（在 profile 目录内），所以所有 pnpm 子命令都能用。
- 安装来源支持：`file:/绝对路径`、`./本地checkout`、`github:you/hello-plugin`、npm 包名、`.tgz` tarball。
- `dsh plugin --profile demo remove dsh-hello-plugin` 同时移除依赖和对应的层。
- profile manifest **从不手写**，由 `dsh plugin` 创建和维护。
- 没有 `dsh.bundle` 声明的包也能安装，但只作为普通依赖（供插件 import 的库），`dsh plugin` 会打印警告且不激活任何层。

### 5.3 SDK 形态

- TypeScript SDK 解析同版本的 `dsh` 依赖并选择 `sdk` profile；Python SDK 的 runtime wheel 直接把 `dsh` CLI 打包进去，客户端以 `dsh --profile sdk` 启动。
- 关键：SDK 暴露的是 **profile 选择 + 有序 patch 文件**，而不是让调用方传一整棵 Cordis 树——外部扩展始终是「profile + patch + `dsh plugin` 安装」，不是内联应用树。

---

## 6. 能力缝三元组（Capability Seam）

来源 `docs/architecture.md` §Capability seams。Loomic 的《改造计划》§4.4 已借鉴此模型。

- 一个**可替换能力** = 三个角色：
    - **Service Definition**：声明接口。
    - **Service Provider**：实现接口。
    - **Consumer**：使用它（常见是模型侧工具）。
- 一个 package 可以兼任多个角色，但**只有一个角色不叫缝**；新增能力必须三个一起设计。
- 威力举例：filesystem 和 subprocess 两个 provider 共享一个执行世界，把它们指向远程沙箱，Bash / PTY / LSP 全部跟着走，无需 provider 分叉。子代理 provider 同样在一个接口后差异极大——从「新开一个子 agent」到「委托给另一个产品的一次 turn」。

---

## 7. 一切皆插件：能力全景

dsh 的 `packages/` 下每个能力都是独立 package（组），下面按职责归类，并标出 ctx key。

### 7.1 内核与组合

| package | 职责 | ctx key |
| --- | --- | --- |
| `core/agent` | Agent 接口 + 活跃注册表 + `agent/*` 事件 | `ctx.agents` |
| `core/agent-loop` | 实现 Agent 接口的**默认驱动**（主循环本身也是插件） | `ctx.agentLoop` |
| `core/session` | append-only 的 `SessionEvent` 日志 + 内存 store | `ctx.sessions` |
| `core/system-prompt` | 提示段 + 工具 schema 装配 | `ctx.systemPrompt` |
| `core/tools` | **作用域化工具注册表 + 受 guard 的执行管线** | `ctx.tools` |
| `core/scope` | 每 agent 作用域注册原语 | 库，无 key |
| `context` / `boot` / `bundle` / `preset` / `hooks` | Cordis context、启动组合、bundle、预设、事件钩子 | — |
| `llm/llm` | 消息与流词汇 + **适配器缝** | `ctx.llm` |

### 7.2 agent 能力（对应你关心的功能清单）

| 能力 | dsh package | 实现形态 |
| --- | --- | --- |
| MCP | `mcp/mcp-client` | 插件，工具注册进 `ctx.tools`，命名 `mcp__<server>__<tool>` |
| skill | `skill/skill`、`skill-filesystem`、`skill-badge` | 插件 |
| 子代理 | `subagent/*`（interface + claude-code / codex / acp / dsh-sdk / fork-in-process / spawn-in-process / in-process-driver + tool-subagent 三件） | **能力缝，多 provider** |
| plan 模式 | `plan/plan-mode` | 产品包插件（见 §7.5） |
| goal（同会话目标） | `goal/goal`、`goal/command-goal` | 插件，`ctx.goals` |
| loop / workflow | `workflow/workflow`、`tool-ralph`、`tool-workflow`、`workflow-worker-thread` | 插件 |
| todo | `todo/*` | 插件 |
| schedule | `schedule/*` | 插件 |
| 权限 / 审批 / guard | `guard/timeout-policy`、`guard/repeat-tool-reminder` + `sandbox` + approval policy（在 dsh-base） | 策略插件，与「模式」分离 |
| 命令（人类指令） | 注册到 `ctx.commands`，无需模型 turn 直接派发 | — |
| 后台任务 | 注册到 `ctx.jobs`，`job_*` 工具收集/停止 | — |

### 7.3 执行与环境

`fs`（文件系统缝，后端可换 host / sandbox-enforcing）、`subprocess`（一切子进程唯一出口）、`shell`、`terminal`、`sandbox`、`e2b`（远程沙箱）、`code-runtime`、`lsp`、`compaction`（上下文压缩）、`spill`。

### 7.4 存储 / 凭证 / 接入

`storage`、`credentials`、`identity`、`settings`、`session-query`、`webhook`（`ctx.webhookRuntime`）、`api`、`acp`、`sdk`、`host`、`client`、`web`、`attachment`、`feedback`、`interaction`、`runtime-diagnostics`、`typert`（类型反射）、`workspace`。

### 7.5 关键克制点：模式不过早抽象

`plan/plan-mode` 的 Dev Note 明确写：**「拒绝做通用 named-mode 注册表，因为产品只落地了 `plan` 一个；未来的第二个协作状态才会从两个具体案例里沉淀出共享缝。」** 并且 plan 模式的实现是「产品包，不是能力缝」——状态 + 引导文本 + `/plan` 命令 + `exit_plan_mode` 工具都放一处，用一个 log-only 的 `plan/mode` 事件做持久状态（resume/fork 时 fold 日志恢复）。它还强调 **「plan 模式是引导不是强制：所有工具仍可用，要强制限制得靠 sandbox 模式 + 审批策略」**——把「模式」和「权限」彻底分开。

---

## 8. 工程纪律（可直接借鉴的护栏）

来源 `docs/cookbook/adding-a-package.md`、`docs/development.md`。dsh 的插件生态能成立，靠的是一整套门禁：

- **包结构不变量由脚本强制**（`scripts/check-workspace-constraints.ts` / `pnpm run constraints`）：`private: true`、version 对齐根、`type: module`、exports/types 路径、Cordis 同时进 peer+dev 依赖等。
- **角色命名表**：Controller / Store / Directory / Presenter / Registry / Runtime / Resolver / Binder / Engine / Policy / Executor / Gateway / Provider / Backend / Handle / Config / Service——每个词「何时用、何时不用」都有明文，ctx key 单复数与角色必须一致。
- **生成式 catalog**：config-catalog、tool-catalog、event-producer-consumer 由源码生成，文档与派发点/声明强校验（`doc-sync` / `verify-type-equiv`）。
- **README 契约**：每个包 README 必含 Model Experience（模型看到什么 / Token effect / KV Cache effect）+ Known Limitations，由 verifier 强制结构。
- **门禁命令**：`pnpm install` → `doc-sync` → `constraints && typecheck && lint` → `build && hygiene`。

---

## 9. 对 Loomic 的启示（摘要；权威版本见《改造计划》/《多端产品设计》）

1. **dsh 的插件 = 服务 + 事件 + 可逆副作用**；Loomic《改造计划》v2 曾只取「服务 DI + 拓扑挂载」、砍掉事件系统，**v3 已修订为松绑最小 agent-run 事件缝**（`pre-step`/`tool-pre-execute`/`turn-stopping`，见《改造计划》§4.3）——因为事件（waterfall 拦截）恰恰是「让 agent 主循环可插拔」的关键，没有它 MCP / 模式 / 权限 / 用量都只能硬编码进 loop。
2. **MCP、skill、子代理、模式、权限在 dsh 里都是插件**，且各自独立 package。Loomic 这些能力要么是硬编码（无 MCP、无模式、无通用权限），要么已实现但没被当插件设计（skill、子代理）。
3. **外部插件开发模式（`dsh plugin` + profile/bundle/patch + topic 发现）是一整套分发闭环**；Loomic《多端产品设计》§12 的插件生态边界提到「独立仓库分发的插件视为独立作品」，但内核明确拒绝 Cordis/YAML/patch/live-reload、`ServiceKey` 封闭——**这处矛盾已在《改造计划》DEC-8 显式定为「本次暂缓第三方插件安装/分发」**。
4. **克制点可借鉴**：模式不要过早抽象（先做单个产品包，出现第二个再抽缝），与 Loomic「不为投机性灵活性堆抽象」一致。
