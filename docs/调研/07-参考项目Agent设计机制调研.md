# 参考项目 Agent 设计机制调研：Subagent / Agent 间协作 / 多模态读取 / 工具设计

> **角色**：调研（只作方向参考，不构成决策）。生成日期：2026-09-25。
> **对象**：`references/` 下 9 个项目。深读 4 个：zcode、deepseek-harness（下称 dsh）、codex、nomifun-tauri（下称 nomifun）；浅读 5 个：kimi-code、cherry-studio、jaaz、loomic、langgraph。
> **方法**：全部结论来自源码阅读，带 `文件:行号` 引用，可回源核对。**路径约定**：各章路径相对 `references/<该项目>/`（章首标注项目名）；行号为 2026-09-25 子模块快照值，子模块更新后可能漂移，届时以符号名为准。
> **边界**：仅作方向参考，禁止复制代码/schema/字段名（`AGENTS.md` 既有约定）。文末「参照点」只是候选清单，拍板必须走《改造计划》§6 决策流程。

## 0. 项目速览

| 项目 | 定位 | 技术栈 | agent 主循环 | 多 agent 形态 |
| --- | --- | --- | --- | --- |
| zcode | agent CLI/桌面应用（本仓 UI 借鉴源） | TS monorepo，core 包化 | `AgentRuntime` + turn-loop `while(true)` | Agent 工具树状派生 + TS 脚本动态工作流 |
| dsh | 「一切皆插件」agent harness（Cordis） | TS 全 ESM，~60 包 | `core/agent` + `core/agent-loop` | subagent 是完整能力缝（6 provider 并存） |
| codex | OpenAI Codex CLI | Rust，170+ crate | `core/src/session/turn.rs` `run_turn` | 两代实验性多 agent（子 = 完整 CodexThread） |
| nomifun | 本地优先 Tauri AI 工作站 | Rust(axum) + React SPA | `nomi-agent/src/engine/mod.rs` `AgentEngine` | 委托型 fan-out 工具（1-16 并行子任务） |
| kimi-code | Moonshot coding agent CLI | TS monorepo，DI 服务化 | `agent-core-v2` XState 状态机 loop | Agent 工具树状派生（profile 目录制） |
| cherry-studio | Electron LLM 聊天客户端 | TS，三进程 | 循环不在自研代码（Vercel AI SDK / Claude Code driver） | 无自研子代理；多会话投递层 |
| jaaz | 画布型多模态创作（Canva AI 替代） | Python/FastAPI + React | LangGraph swarm（双 agent） | planner→creator handoff |
| loomic | 画布型 AI 创作工作台 | Next.js + Fastify + LangGraph JS | deepagents `createDeepAgent` | 单主 agent + 1 个视频子代理 |
| langgraph | agent 编排框架 | Python（+JS） | `StateGraph`/Pregel | Send/Command/interrupt 原语 |

---

## 1. Subagent / 子代理设计

### 1.1 zcode（路径相对 `references/zcode/`）

- **入口工具**：`Agent` 工具（`apps/zcode-cli/packages/core/src/tool/handlers/agent.ts:224`），`Task` 是其 Claude Code 兼容别名（复制 entry 改名、`providerVisible: false`，`agent.ts:287-300`）。工具描述动态拼装：职责 + 可用 agent 类型清单（`formatAgentProfilesForPrompt`）+ 使用纪律——「最终消息作为 tool result 返回给你、用户看不到」「新 Agent 上下文全新、prompt 必须自包含」「`run_in_background: true` 异步」「多个独立 agent 在同一条消息里多次 tool use 并发派发」（`agent.ts:102-116`）。**把派生纪律写进工具描述本身**是该设计的特点。
- **Profile 双轨制**：`AgentProfile` 字段含 `name/description/systemPrompt/tools/disallowedTools/skills/modelSelection/permissionMode("auto"|"plan")/maxTurns/memory/mcpServers/background/injectAgentsMd`（`apps/zcode-cli/packages/core/src/subagent/profile.ts:21-38`）。内置 `general-purpose`（`tools:["*"]`）与 `Explore`（只读，工具限定白名单，description 写明「搜索广度 medium/very thorough」，`profile.ts:66-80`）。用户/项目级 agent 是 Markdown 文件：frontmatter 必含 `name/description`，正文即 systemPrompt（`profile.ts:154-227`）；同名 profile 覆盖内置项。**安全细节**：项目级 frontmatter 的 `permissionMode` 直接丢弃，防止仓库输入把子代理提到 bypass（`profile.ts:185`）。
- **模型选择**：frontmatter `model` + `thoughtLevel` 两字段；`model: inherit/main/...` 视为继承父会话（`zcode/packages/shared/src/subagent-markdown-selection.ts:8-32`）。优先级 `override > profile 显式 model > 父会话`，解析失败**抛结构化错误而非静默回退父模型**（`apps/zcode-cli/packages/core/src/runtime/helpers/subagent-selection.ts:27-56`）。
- **上下文隔离**：每个子代理新建 `AgentRuntime` + 独立 child session（`agentId = agent_<uuid>`，`subagent/runner.ts:805-806`）；系统提示词由 `SubagentContextBuilder` 独立拼段（CLI prefix → profile prompt → 环境 → 日期 → skills），每段稳定 block 带 `ephemeral` cache control（`subagent/context-builder.ts:28-163`）；父上下文零进入；工具面用 `filterSubagentChildToolNames` 收窄，MCP 按 profile 白名单借用父侧（`subagent/borrowed-mcp-port.ts`）。
- **并发/后台/resume**：并发靠「单消息多次 tool use」+ 调度器按 `concurrentSafe` 分组并行（`tool/scheduler.ts:99-100`；Agent 元数据 `concurrentSafe: true`，`agent.ts:231`）。后台运行输出落盘 `<tmpdir>/zcode-agents/<sessionId>/<agentId>/{metadata.json,output.txt}`（`runner.ts:808-815`）；前台还有 `autoBackgroundMs` 定时器与执行竞速（`runner.ts:291-334`）。**resume**：对已完成 agent 发消息走 `resumeTerminalAgentInBackground`——从旧 snapshot 重建 lifecycle、`resumeFromStore: true` 从持久化 child session 恢复（`runner.ts:955-1062`）。

### 1.2 dsh（路径相对 `references/deepseek-harness/`）

- **agent 即「Session + Agent 句柄」**：`Agent` 携带 `id: SessionId`、`inbox`、`status` 与**专属 Cordis 子上下文 `ctx`**——per-agent 注册（工具过滤、persona）写进 `agent.ctx`，随 agent 销毁回卷（`docs/subsystems/core.md:61-141`）。创建走 `ctx.agents.create/resume`，返回 `AgentHandle { agent, dispose() }`，只有持有者能销毁。
- **subagent 是一条完整能力缝**（三元组齐备，`docs/subsystems/subagent.md:5-7`）：
  - Definition：`SubagentRuntime` 挂 `ctx.subagents`，是**按名注册的多 provider 注册表**（`packages/subagent/subagent/src/index.ts:188,509`）；
  - Provider：6 个并存——`spawn-in-process`（全新子 agent，零父上下文）、`fork-in-process`（父日志到最后一个 `turn/end` 的平衡前缀做 seed 播种）、`acp/codex/claude-code/dsh-sdk`（跨产品委托）；每个 provider 实现 `SubagentProvider { name, capabilities, inheritsParentContext, start(), prepareContinuable?() }`（`packages/subagent/subagent-spawn-in-process/src/index.ts:41-66`）；
  - Consumer：模型工具 `subagent`（`packages/subagent/tool-subagent/src/index.ts:323`）+ 控制工具 `send_message/interrupt_agent/list_agents`。
- **隔离**：委托前先按 `SubagentCapabilities` 静态门控（缺能力抛 `UNSUPPORTED_CAPABILITY`），子 agent 得到**全新 flat scope 不继承父注册**；深度用持久化 `SessionHeader.delegationDepth` + `AgentOptions.subagentDepth` 双字段控制；`toolFilter` 以 scoped `tools.restrict()` 实现——**可见性即权限**；`persona` 是 scoped prompt section 遮蔽（`docs/subsystems/subagent.md:459`）。
- **Continuable 子代理**（最独特，`docs/subsystems/subagent.md:126-148`）：持久化 child Session + 至多一个进程内 Activation（重建后的驻留 Agent）。`startContinuable()` 预留稳定 childId、快照 `subagent/descriptor` 日志事件（**log-only、过 compaction 保留**），初始 prompt 进 inbox 即返回（`packages/subagent/subagent/src/continuation.ts:102`）；`sendMessage` 只允许**直接父↔直接子**相邻通信：running 则在最近 step 边界 steer、waiting 则唤醒、无 Activation 则冷恢复（`continuation.ts:202`）；子结算时向父投递 `kind:'notice'` 的 `subagent-settled` 消息（与 agent 消息刻意区分）。状态全部在 session log（事件溯源），无第二状态机。

### 1.3 codex（路径相对 `references/codex/`）

- **有正式多 agent 机制（两代）**：每个根 session 持有 `AgentControl`（`codex-rs/core/src/agent/control.rs:130-147`），整棵树共享同一 `AgentRegistry` 与 `RolloutBudget`。子 agent 是**完整的独立 `CodexThread`**（独立上下文/rollout），`SessionSource::SubAgent(ThreadSpawn{parent_thread_id, depth, agent_role...})`（`control.rs:771-777`）。
- **派生参数**：fork 模式 `SpawnAgentForkMode::{FullHistory, LastNTurns}`（`control.rs:92-95`）；深度上限 `exceeds_thread_spawn_depth_limit`（`core/src/agent/registry.rs:91`）；并发上限 `AgentExecutionLimiter`；环境子代理数上限 `MAX_ENVIRONMENT_SUBAGENTS = 8`（`control.rs:88`）。父注入环境上下文时只渲染 `<agent name=... />` 行且限 8 条/1KB（`control.rs:488-555`）。
- **结果回传**：MAv1 子线程结束时 watcher 向父 `inject_fragment_without_turn(SubagentNotification)`（`control.rs:716-721`）；MAv2 子完成后发 `InterAgentCommunication` 完成消息回父（`control.rs:687-711`）。模型侧工具 `spawn_agent/send_input/resume/wait_agent/close`（`core/src/tools/handlers/multi_agents.rs:45-50`）。
- **生命周期**：`AgentStatus::{PendingInit,Running,Interrupted,Completed(Option<String>),Errored,Shutdown,NotFound}`（`codex-rs/protocol/src/protocol.rs:1823-1839`），经 `tokio::sync::watch` 订阅。

### 1.4 nomifun（路径相对 `references/nomifun-tauri/`）

- **委托型 fan-out 工具**，非常驻多 agent：`LocalDelegateTool` 暴露 `nomi_delegate`，输入 `ParallelDelegationRequest { tasks: 1..16, strategy: Parallel }`（`crates/agent/nomi-types/src/agent.rs:253`），子 agent 上限 200 turns（`crates/agent/nomi-agent/src/local_delegate_tool.rs:19`）；`synthesize=true` 追加一个只读合成子 agent 汇总（`local_delegate_tool.rs:86-100`）。
- **隔离**：子 agent 工具集 = `AgentToolPolicy{Full,ReadOnly,ReadShell} ∩ exact_tools`（`local_agent_invocation.rs:173,854`）；**≥2 个可写入 sibling 时，写入者各自拿 detached git worktree**（同基线快照创建，非 Git 仓库显式拒绝；`local_agent_invocation.rs:222-249`）；父 shell hooks 不继承；角色文本注入且声明「不授予工具权限」。
- **会话建模**：引擎态 `Session` 含转录、`owner_token`（防跨会话串数据）、`host_context`、`accepted_turn_root`（turn 前快照，崩溃恢复）、`editable_turn`（消息编辑回卷检查点）（`crates/agent/nomi-agent/src/session.rs:48,65,112`）。

### 1.5 kimi-code（路径相对 `references/kimi-code/`）

- `Agent` 工具（`src/agent/tools/agent/agentTool.ts:98`），schema 含 `prompt/subagent_type/model/run_in_background/resume/fork/description`；`subagent_type` 对应 `AgentProfile` 目录（`src/app/agentProfileCatalog/`），声明 `description/whenToUse/tools/disallowedTools/subagents`；子代理在独立 DI scope 创建（`src/session/subagent/subagent.ts:58-62`），结果经 `mirrorAgentRun` 回流父工具调用。
- **失败即带自愈指引**：`SubagentStopReason` 枚举（completed/max_tokens/max_steps/cancelled...），每种失败附不同的 `next_step` 恢复提示（`NEXT_STEP_BY_REASON`，`agentTool.ts:586`）。
- **resume/fork**：`resume=<agent_id>` 可复活已结束（含重启后）的子 agent 并保留上下文，含所有权校验 `AGENT_NOT_OWNED`；实验性 `fork` 复制父上下文快照另起，注入声明「这不是你的历史，只是参考快照」（`src/session/subagent/spawn.ts:13-14`）。

### 1.6 画布型与框架：jaaz / loomic / langgraph

- **jaaz**（路径相对 `references/jaaz/`）：`langgraph_swarm.create_swarm` 编两个 `create_react_agent`——planner 只挂 `write_plan` 工具 + handoff 工具 `transfer_to_image_video_creator`；creator 挂全部生成工具（`server/services/langgraph_service/configs/planner_config.py:41-55`）。handoff 工具内部返回 `Command(goto=agent_name, graph=Command.PARENT, update={"active_agent":...})`（`configs/base_config.py:20-68`）；恢复中断会话时扫消息历史最后一条带 `name` 的 assistant 消息决定 `default_active_agent`（`agent_manager.py:101-120`）。
- **loomic**（路径相对 `references/loomic/`）：无图编排，单 `createDeepAgent`（deepagents，内置文件系统工具）+ 唯一子代理 `video_generate` 经父 `task` 工具分发（`apps/server/src/agent/sub-agents.ts:5-15`）——生成工具收敛进子代理以隔离上下文。
- **langgraph**（路径相对 `references/langgraph/`）：原语级多 agent——`Send`（条件边返回 `[Send(node, arg),...]` 对同一节点以不同私有 state 并行，`libs/langgraph/langgraph/types.py:704-792`）、`Command{goto,update,resume,graph}`（`Command.PARENT` 指父图，`types.py:799-848`）；supervisor/swarm 在独立 PyPI 包。jaaz 的 handoff 即 `Command(graph=PARENT, goto=...)` 模式的实例。

### 1.7 cherry-studio：无自研子代理的宿主形态

自研 runtime（aiSdk/pi/dsh 三种 driver）工具面里**没有 spawn 类工具**；子代理能力仅间接存在——`claude-code` driver 把 Claude Code CLI（自带子 agent）整体作为 runtime spawn（`src/main/ai/runtime/driver` 侧 `ClaudeCodeProcessManager.ts:175`）。多 agent 语义上移到「Agent 实体 + 会话间投递」层（见 §2.7）。

### 1.8 共性归纳

1. **子代理默认全新上下文**是所有实现的一致选择；共享父历史（fork）一律是显式 opt-in 且注入「这不是你的历史」类声明（kimi/dsh seed/codex fork mode）。
2. **agent 类型 = 声明式 profile**（工具白名单 + 描述 + 模型/权限），三载体：Markdown frontmatter（zcode）、代码目录（kimi）、多 provider 注册表（dsh）。
3. **隔离手段分层**：上下文隔离（新 session）→ 工具面收窄（白名单/restrict，可见性即权限）→ 文件系统隔离（nomifun git worktree 是唯一做到写入隔离的）。
4. **失败通道设计**：失败不是纯 error 文本——kimi 的 stop_reason→next_step 指引、zcode 的结构化选择错误，都把「怎么恢复」编进失败结果。
5. 深度/并发都有显式上限（codex depth+8 个环境子代理、nomifun 16 任务/200 turns、dsh delegationDepth）。

---

## 2. Agent 间通信（A2A）

### 2.1 zcode

- **SendMessage 工具** `{to, summary, message}`（`apps/zcode-cli/packages/core/src/tool/handlers/send-message.ts:25-35`）：描述明确「纯文本输出对其他 agent 不可见，必须调本工具」「resume 已完成 agent 会在后台跑并自动通知」；权限 id `agent.message.send`，10s 超时、4KB 输出上限。
- **动态工作流**（TS 脚本编排多 agent）：脚本在沙箱子进程运行，与 harness 走 stdio NDJSON 协议（`apps/zcode-cli/packages/dynamic-workflow-runtime/src/protocol.ts:5-9`）——`create-actor` 即发即忘、`ask/world-read/publish-artifact` 走 request/response、`log/report/declare-artifact` 走事件通道且 **FIFO 顺序承重**。模型 API 全在内嵌 .d.ts（`dynamic-workflow/src/facade/dts.ts`）：`agent(name)`（命名 actor 是重跑缓存键）、`ask<T>`（持久对话上下文，串行 FIFO）、`report`（journal 化，上限 256 条×32KB）、`artifact.*`、`world.run`（cmd 必须编译期字面量、无 shell，非零退出正常返回供门控分支）。「门控 gate」不是内建原语而是惯用法：跑检查 + 解析输出 + 失败交回 agent 修。
- **escalation 冒泡**：actor 会话注册 `escalate` 工具，**阻塞等待主代理**；描述写明「最后手段、一次一个聚焦问题、每次 ask 最多 3 次」，结局 `answered/refused` 都按普通工具结果返回而非 error（`core/src/tool/handlers/escalate.ts:38-88`）。并发治理用 AIMD 状态机：429 时 `cap×0.75`（下限 1），每 4 次连续成功 +1，空闲 300s 重置（`dynamic-workflow/src/engine/concurrency.ts:20-33`）。
- **后台任务回报**：完成时同步写入父 runtime command queue，下一轮 roundtrip 前作为 `<task-notification>` XML 系统提醒注入（`core/src/runtime-task/notification.ts:91-111`）；`TaskOutput` 可主动拉取（默认投影 32K，`block:true` 100ms 轮询，`handlers/task-output.ts:17-21`）。

### 2.2 dsh

三层机制，**无消息队列中间件**：

1. **Cordis 类型化事件总线**：`DispatchMode = emit|parallel|serial|bail|waterfall`（`vendor/cordis/src/events.ts:32`），waterfall 即 around-middleware（监听者不调 `next()` 即短路）；事件三域：durable session 事件、live agent 事件（waterfall）、capability 事件；`dsh-scope` 支持事件定向到指定 agent（`packages/core/scope/src/index.ts:12-49`）。
2. **Agent inbox 显式投递**：`Agent.send(message, target, wakeup)` 统一入口，`followup`（排下轮）/`steer`（最近 step 边界注入）/`inject`（排队可见不唤醒）是固定别名（`docs/subsystems/core.md:102-140`）；inbox 是 `nextTurn/nextStep` 两条有序列表，持久化为 session 事件。**子代理 sendMessage 与人类 Queue/Steer 复用同一条通道**，无第二队列。
3. **共享服务编排**：`composeFrom` 让子 agent 绑定父的同一 composition 实例；preset 服务藏在 `isolate` realm，宿主用 `serviceFor(agent, name)` 读 per-agent 实例。实验性 **Agent Teams**：durable roster + CAS 任务 DAG（`revision` 递增、`blockedBy` 无环校验）+ mailbox（`docs/subsystems/agent-team.md:30-56`）。

### 2.3 codex

- **进程间协议**（app-server ↔ 客户端）：宽松 JSON-RPC 2.0（`codex-rs/app-server-protocol/src/rpc.rs:1-2`）。方法 `thread/start|resume|fork`、`turn/start|steer|interrupt`（`protocol/common.rs:559-1058`）；事件模型 **thread → turn → item**：`TurnItem` 枚举含 UserMessage/AgentMessage/CommandExecution/FileChange/McpToolCall/CollabAgentToolCall/SubAgentActivity/ImageView 等（`protocol/src/items.rs:46-77`），流式以 `item/started`、`item/completed`、`item/agentMessage/delta` 推送。
- **审批即协议**：server→client 请求 `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`mcpServer/elicitation/request`（`common.rs:1754-1804`）；决策枚举含 `Approved/ApprovedForSession/Denied/TimedOut/Abort` 及策略修正类（`protocol.rs:4143-4174`）。**resume 三方式**：thread_id / 内联 history / rollout path（`protocol/v2/thread.rs:354-436`）。
- **agent 间协作层**独立于进程协议：`Op::InterAgentCommunication{from,to,message,trigger_turn}`（`protocol.rs:666-669`）。

### 2.4 nomifun

- 无模型可见的任务板工具；兄弟进度由宿主维护**私有账本**，经 `ContextContributor` 注入有界 JSON 快照并**标记为不可信数据**（`crates/agent/nomi-agent/src/context_contributor.rs`）；父子间文件效果经 operation-id sidecar 回填父 `RoundLedger.durable_effect_targets`（`crates/agent/nomi-tools/src/lib.rs:238`）。
- **事件流**（Rust→UI）：引擎 → `ProtocolEvent`（`crates/agent/nomi-protocol/src/events.rs:10`）→ backend 转成 `AgentStreamEvent`（TS 类型由 `#[ts(export_to)]` 生成，`backend/nomifun-ai-agent/src/protocol/events/mod.rs:54`）→ tokio broadcast 总线 → WS 单例 → UI。断线靠权威快照重对账；发送带幂等键；桌面壳用每 boot 密钥的 local-trust 鉴权（`apps/desktop/src/main.rs:40-43`）。

### 2.5 kimi-code / cherry-studio / 画布型

- kimi：无平级协议，「单 main + 树状子 agent」；多 agent 状态持久化在 session metadata 的 `agents` 映射（`agentTool.ts:52-59`）。
- cherry：**会话间投递层**——`AcceptSessionDeliveryInput { senderAgentId, senderSessionId, receiverSessionId, content, replyPolicy }`（`src/main/ai/agentSession/AgentSessionDeliveryService.ts:45-52`）；跨会话内容经随机 boundary 包裹并**标注「模型生成内容不可信」**（`runtime/agentUserContent.ts:39-56`，注入对抗设计）；定时任务（heartbeat）每次默认新建会话，持久记忆放工作区 `heartbeat.md` 而非会话历史（`agents/heartbeat.ts:8`）。
- jaaz：Socket.IO 广播 `session_update`；`astream(stream_mode=["messages","custom","values"])` 归一为 delta/tool_call/tool_call_result/all_messages/done/error 事件（`server/services/StreamProcessor.py:40-158`）；人工确认不走 LangGraph interrupt，而是确认名单 + `asyncio.wait_for` 挂起（5 分钟超时，`tool_confirmation_manager.py:17-40`）。
- loomic：WS + **seq 事件缓冲**（断线按 `lastSeq` 回放，`apps/server/src/ws/handler.ts:183-193`）+ 按画布广播（`pushToCanvas`，所有观看者可见）+ 15s keep-alive；子代理嵌套工具的 artifact 事件被抑制、由父工具重发（`agent/stream-adapter.ts:42-44`）。

### 2.6 共性归纳

四种可组合模式：**(a) 树状父子 + 消息工具**（全部实现的基座，父只收摘要）；**(b) 图编排原语**（langgraph Send/Command、dsh Teams 任务 DAG、zcode 脚本工作流）；**(c) 进程间 thread/turn/item 协议**（codex app-server、nomifun WS——同一事件模型同时服务 IDE 前端与 resume）；**(d) 共享事件总线 + inbox**（dsh，人机共用一条 steer 通道）。人类介入统一为三种动作：steer（step 边界注入）、审批（协议级 request/response）、escalation 提问（阻塞问答）。跨 agent 内容普遍做**不可信标记**（nomifun 账本、cherry boundary 包裹）。

---

## 3. 多模态文件读取

### 3.1 zcode

常量集中（`zcode/apps/zcode-cli/packages/contracts/src/tools/read.ts:16-22`）：文本 256KB/2000 行/25k token；图片输入 20MB、**base64 目标 5MB**（原始字节 = 5MB×3/4）、最大边 2000px。

- **图片**：读二进制后交 `imageProcessorPort.prepareForModel`（缩边 + 压到 token 预算，返回 `resized/compressed/compressionStrategy`）（`core/src/tool/handlers/read-image.ts:56-110`）；模型内容是单个 `{type:"image", dataUrl}` block，尺寸提示留在结构化 output 不进 provider 内容（`handlers/read.ts:100-116`）。
- **PDF 两档**（`core/src/tool/handlers/read-pdf.ts`）：不带 `pages` 走原生——≤20MB 且 ≤10 页整体 base64；带 `pages` 走逐页渲染——范围解析（"1-5"/"3"）、单次 ≤20 页、≤100MB，每页渲染后走同一 `prepareForModel`，输出带页码的图片数组（`read-pdf.ts:127-289`）。
- **视频**：不转码只 base64 + 大小校验（30MB 上限，`zcode/packages/shared/src/zcode-media-policy.ts:2`），六种扩展名白名单；OpenAI 系 provider 由投影层把 video block 拆成后置 user part（`handlers/read.ts:119-133`）。
- **粘贴/拖拽附件**：先无 IO 推断元数据展示，再逐个解析（图片同 2000px/5MB 预算、视频 30MB、PDF 20MB、inline 媒体统一 20MB），大内容持久化到 artifact store 后消息里放占位引用（`core/src/runtime/helpers/attachments.ts:43-80`）。

### 3.2 dsh：引用化存储的代表

**核心不变量：session log 和模型上下文只存 content-addressed 引用，永不存 base64/路径/URL**（`docs/subsystems/attachment.md:5-14`）。

- 入库 `ctx.attachments.saveImage`：全量解码校验（magic bytes、EXIF 方向、像素/字节上限）→ 归一化 8-bit sRGB → 落盘，才返回 `ImageAttachmentRef{attachmentId: 'sha256:<digest>', ...}`；**persist-before-event**：`read_image` 在 `tool/result` 事件 append 前必须完成持久化（`packages/fs/tool-fs/src/read-image.ts:271-275`）。
- 上限（`packages/attachment/attachment-local/src/index.ts:34-58`）：单图 20MiB、每消息 20 张/聚合 200MiB、6400 万像素、单边 8192px；归一化长边 2048px、目标 4MiB；编码走 sharp 质量阶梯 `[85,75,60]`，有 alpha 用 WebP 否则 JPEG。
- **能力门控**：`read_image` 执行前 `assertImageCapableRoute` 查当前路由 `inputModalities` 含 image，不含直接拒绝（`read-image.ts:119-131`）。
- **晚编码**：适配器发请求时才 `readImageRequest(ref, target)` 按目标路由解析缓存版本并编码（`llm-deepseek/src/protocols/messages/images.ts:36-66`）；超 inline 预算触发 **image offload**——记 `image/offload` 事件、替换为占位文本、开新 request series 重试。
- **FileBlock 永不原生到达 provider**：投影为确定性 handle 文本（名字、字节数、只读路径）；PDF 无模型侧摄取，只有浏览器预览。

### 3.3 codex

- `view_image` 工具：先查模型 `input_modalities` 含 Image（`codex-rs/core/src/tools/handlers/view_image.rs:102`），读文件 + `image::load_from_memory` 验证，转 data URL，同时发 `TurnItem::ImageView`（`view_image.rs:92-210`）。
- 用户本地图 `UserInput::LocalImage` 注释明确「请求序列化时转 base64 data URL」（`protocol/src/user_input.rs:36`）；历史注入时 `image_preparation.rs:329-400` 负责缩放/detail，可上传为 `File{file_id}`。**PDF 原生进上下文未确认存在**（仅云文件/工件侧出现 pdf 字样）。

### 3.4 nomifun：附件降级 + 工具产物两路

- 聊天附件传**本地绝对路径**（并入消息文本，`ui/src/renderer/hooks/chat/useSendBoxFiles.ts:53,76`）；后端 `load_image_blocks` 只把**图片**转 base64 content block：上限 4 张、源 12MiB、4000 万像素、模型侧缩 1568px/1.5MiB、PNG 超限降级 JPEG 多档质量；**拒绝软链、相对路径、URL**，受限会话强制根目录包含，magic 检测防扩展名伪装（`backend/nomifun-ai-agent/src/manager/nomi/image_attachments.rs:42-212`）。非图片不进上下文，靠路径 + 文件工具读。
- 工具产物走 `ToolImage`：仅图片 MIME 回传模型，其余（webm/audio/pdf）持久化到 ArtifactStore 并在下次请求前剥离（`crates/agent/nomi-types/src/tool.rs:46-63`）；`Read` 工具读图片直接返回 `ToolImage` 而非 "(binary file)" 占位（`nomi-tools/src/read.rs:23-33`）。

### 3.5 kimi-code / cherry-studio / 画布型

- kimi：`Read` 只读文本（100k 字符上限、负偏移尾读、`kimi-file://` 附件引用）；`ReadMediaFile` 处理图片/视频——magic-byte 探测、**按 `ModelCapability.image_in/video_in` 动态决定注册与否及降采样策略**（`src/agent/tools/read-media-file/`）；消息发送前由 media resolver 服务统一解析 media ref。
- cherry：文件系统型 runtime **没有原生多模态通道**——附件降级为「文件名 + 绝对路径」文本清单让 agent 自己读（`agentUserContent.ts:16-32`）；非视觉模型走**可插拔 OCR**（tesseract/paddleocr/mineru 等，结果按内容版本缓存 30 分钟）；知识库 RAG：readers（pdf/docx/epub→markdown）→ 保偏移 splitter → embed + rerank → sqlite-vec + BM25 混合检索（`features/knowledge/README.md`）。
- jaaz：生成图落盘 + 写画布元素，**回传模型的是含 URL 的 markdown 字符串（模型并不直接「看」图）**；仅图像编辑类工具把输入图转 base64（`tools/utils/image_generation_core.py:33-97`）。
- loomic：上传图转 base64 组进 `HumanMessage` 的 `image_url` content block（注释明确选 OpenAI 风格以兼容 Gemini 适配器），同时文本注入 `<input_images><image asset_id=.../></input_images>` + `assetId→data URI` 映射存 configurable 供工具反解（`apps/server/src/agent/runtime.ts:1042-1098`）；生成结果以 signed URL 返回而非 base64；**画布当前状态摘要每轮自动注入**（`runtime.ts:1013-1032`）。
- langgraph：框架不做编码转换，多模态随 `messages` channel 的 content block 透传。

### 3.6 共性归纳

两个阵营：**引用化存储 + 晚编码**（dsh 最纯粹——sha256 引用、发请求时才编码、超预算 offload；zcode 附件大内容 artifact 化同方向）vs **内联 base64 + 入口预算归一**（zcode 直读、codex、nomifun 图片、loomic）。共同点：① 入口处统一归一（尺寸/字节/质量阶梯），预算常量集中一处；② **按路由能力门控**（dsh `assertImageCapableRoute`、codex `input_modalities` 检查、kimi 能力门控注册）——先查模型支不支持再处理，而非处理完才发现发不出；③ PDF 是分水岭：zcode 唯一做了「原生 ≤10 页 vs 逐页渲染 ≤20 页」两档，dsh/nomifun 明确不喂模型（handle 文本/工具读），cherry 靠 RAG/OCR 绕道；④ 非图片二进制普遍「路径 + 让 agent 自己读」。

---

## 4. 工具设计

### 4.1 zcode

- **ToolEntry**：`metadata/description/handler/inputSchema(JSON Schema) + runtimeInputSchema(zod)/outputSchema/permission/resultBudget/timeout/cancellation/trace`（`core/src/tool/types.ts`）；registry 管理 canonical→alias（Task→Agent 型，冲突拒绝）；内置约 40 个工具，按开关裁剪注册（灰度关时 10 个 workflow 工具连 ListModels 一起下架，`core/src/tool/handlers/index.ts:139-156`）。
- **MCP 并入**：名字 `mcp__<server>__<tool>`（非法字符转 `_`，`core/src/mcp/name.ts:3-13`）；风险级由 MCP 注解 `readOnlyHint/destructiveHint` 推导、**默认 `needsApproval: true`**（`core/src/mcp/index.ts:60-160`）。
- **skills**：`SKILL.md` 扫描产出元数据（name/description/whenToUse/`policy.allowImplicitInvocation`），`Skill` 工具按名加载正文注入上下文（上限 100KB，`handlers/skill.ts:12-40`）。
- **权限决策链**（`core/src/permission/service.ts:80-230`）：plan-mode 迁移 → `requiresUserInteraction` → 工具自报 `alwaysAsk`（不可被模式绕过）→ yolo 放行 → 项目 allow/deny 规则 → `allowedTools/disallowedTools` → 行为 `allow/ask/deny`；会话级 allow 存内存。**hooks**：7 个事件，PreToolUse 可给 `permissionDecision: allow|ask|deny` + 改写输入（`contracts/src/hooks/index.ts:215-253`），工作区 hook 另有信任评估链。
- **结果预算**：策略 `"inline"|"truncate"|"artifact"`（Agent 结果 120KB artifact、SendMessage 4KB 截断）；**compact**：自动压缩阈值按 200K 窗口/输出预留 32K/buffer 13K，连续失败 3 次熔断（`core/src/compact/policy.ts:6-14`）；摘要提示词强制九段结构（含「全部用户消息逐条列出、安全约束逐字保留」）+ NO_TOOLS 前后缀禁止压缩期调工具。

### 4.2 dsh：工具即普通插件

工具就是在 `apply(ctx, config)` 里 `ctx.tools.register(defineTool({...}))`（最小样例 `packages/todo/tool-todo/src/index.ts:128-146`）。要点：

- **自有 JSON-Schema DSL**（非 zod 描述参数，`packages/core/tools/src/schema.ts:12-90`）；`defineTool` 强校验 execute 参数、**强制声明 `output.schema`（canonical 返回值）+ 纯函数 `render(args, value): ContentBlock[]`（模型可见内容）**——canonical 值与模型投影分离，UI 回放安全；`isConcurrencySafe` 决定并行分组。
- **执行管线**：参数深冻结 → `tools/pre-execute` waterfall（可 allow/deny/替换）→ 审批 → monotonic guard → `tools/execute` 环绕链 → `tools/post-execute`（`core/tools/src/index.ts:1348`）。
- **审批 fail-closed**：`ask` 决策经 `ctx.get('approval')` 机会式消费，缺服务/无通道一律 deny；会话级 `ApprovalPolicy = ask|never` 由 session log 最后一条 `approval/policy` 事件决定，**`never` 在 waterfall 前确定性拒绝，不可被监听者绕过**（`docs/subsystems/approval.md`）。
- **「Model-visible ⟺ logged」**：结果写成 durable 对（`tool/call` + `tool/result` 带 `sourceEventSeqs:[callSeq]`），下一步模型历史由 `deriveMessages()` 从日志投影（`core/agent-loop/src/tool-calls.ts:262-283`）——模型看到什么由账本唯一决定。
- MCP：公开名超 64 字符或含非法字符时**截断 + 12 位 SHA-256 身份哈希**防碰撞（`mcp/mcp-client/src/tools.ts:71-93`）；同步两阶段（先建全量下一代再原子换装）。

### 4.3 codex

- **纯 serde 定义**：`ToolSpec::{Function, Namespace, ToolSearch, WebSearch, Freeform}`（`codex-rs/tools/src/tool_spec.rs:18-46`）直接序列化为 Responses API 的 Tool JSON，无宏；每回合按 feature gate + allowed tools 构建 `ToolRegistry` → `ToolRouter`（`core/src/tools/spec_plan.rs:152,1052-1305`）。
- **曝光位 bitflags**：`ToolExposures {Direct, Deferred, CodeMode}`（`tools/src/tool_executor.rs:13-24`）——collab 工具组在工具搜索下标为 Deferred；code-mode 指经 JS 运行时调工具。
- **权限/沙箱**：`SandboxMode{ReadOnly, WorkspaceWrite, DangerFullAccess}` × `AskForApproval{UnlessTrusted, OnRequest(默认), Granular, Never}`（`protocol/src/protocol.rs:986-1010`）；沙箱 macOS Seatbelt（.sbpl 策略）/Linux Landlock/Windows（`sandboxing/src/`），`SandboxManager::transform_for_direct_spawn` 包装 exec 请求。
- MCP：rmcp 客户端（stdio/streamable-http/oauth）；`McpHandlerCache::append_mcp_tools` 为每个工具建 handler 并按 `omit_tools_from`/code-mode 策略裁剪曝光（有字节预算，`core/src/mcp_tool_exposure.rs:37-148`）；审批用模板化确认 + elicitation 往返。

### 4.4 nomifun

- **Rust `trait Tool`**（`crates/agent/nomi-tools/src/lib.rs:159`）：`name/description/input_schema()/execute()/category()/category_for(input)`（**按输入细分审批类别**）、`is_deferred`（schema 延迟下发）、`execution_timeout`、`max_result_size`（默认 50000 字符）、`requires_explicit_route`。registry 注册时做 JSON-Schema 校验与体积/深度上限（512KiB/16384 节点/64 层），无效参数直接回「Correct the arguments and retry; the tool was not executed」（`registry.rs:10-15`）。
- **SSH 场景工具接管**：绑定远端会话时远端工具族**覆盖同名本地工具**（`bootstrap.rs:560-567`）。
- MCP：显示名 `mcp__{server}__{tool}__hash`（有界哈希别名），`activation_identity` 保留原始身份；**MCP 工具默认 deferred，经 ToolSearch 激活**（`nomi-mcp/src/tool_proxy.rs:27,447`）。
- 权限：`ToolApprovalManager`（pending/auto_approved/session_mode）+ `ToolCategory{Info,Edit,Exec,Irreversible}` 分流；**批量先 confirm 后执行**；错误结果的图片会被清除防回放（`engine/mod.rs:3228-3239`）。

### 4.5 kimi-code

- **两段式契约**：`resolveExecution(input) → ToolExecution`——先静态产出 `accesses`（**文件读写冲突检测**）、`display`、`approvalRule`，再 `execute(ctx)`；结果支持 `stopTurn/spill`（**超 50k 字符落盘**）/`delivery`（`src/tool/toolContract.ts:90-114`）。
- **权限策略是可组合的策略文件链**：`dangerous-command-ask` 用 bash AST 解析识别 sudo/mkfs 等危险命令、`sensitive-file-access-ask`、`git-cwd-write-approve`、`session-approval-history`、`user-configured-rule`（`src/agent/permissionPolicy/policies/`）；Bash 的 `approvalRule: literalRulePattern('Bash', args.command)` 实现按命令前缀的允许规则；模式切换时向上下文注入 reminder。
- MCP：四 transport + `mcp__{server}__{tool}` 超 64 字符加 FNV 哈希后缀（`mcpCore/tool-naming.ts:5-19`）+ `mcp__*` 元工具与 OAuth 工具。

### 4.6 cherry-studio：内置工具统一伪装成 MCP

会话工具面组装成**一组内存 MCP server**：内置工具 server（kb_*、read_file）、记忆 server、文件工具 server、McpManagerServer（**让 agent 自管理 MCP**）、Skills server（`runtime/agentMcpServers.ts:58`）——宿主只实现一种工具通道。审批中枢 driver 无关：`DispatchDecision { approved, reason, updatedInput }`（**可改写工具入参**，`toolApproval/ToolApprovalRegistry.ts:10`）；另有破坏性命令、SQL 用户数据守卫等静态策略。MCP 市场是外部导航链接 + 14 个预置 `@cherry/*` server，安装外部 server 有信任确认。

### 4.7 jaaz / loomic / langgraph

- jaaz：静态 `TOOL_MAPPING` 注册中心 + **按用户配置的 api_key 动态注册工具** + ComfyUI workflow 动态造工具（`services/tool_service.py:220-290`）；工具用 `@tool` + Pydantic `args_schema`，`RunnableConfig` 注入 canvas_id/session_id。
- loomic：**单一聚合工具 `manipulate_canvas`**——zod 扁平定义 11 种 action + handler 分发表，单条失败返回 `[skip]` 不中断整批（`tools/manipulate-canvas.ts:43-95,709-799`）；生成类工具 schema 由 provider 注册表动态生成 `z.enum`；图片/视频生成为 PGMQ 异步 job（建 job→扣积分→轮询→成功直写画布并推 `canvas.sync`，`runtime.ts:445-637`）；checkpointer 用 PostgresSaver。
- langgraph：`ToolNode` 解析 tool_calls 并行执行，构造 `ToolRuntime{state, tool_call_id, config, store, stream_writer}`；错误处理可配 `handle_tool_errors`（默认只吞 `ToolInvocationError` 写成 `ToolMessage(status="error")` 回流，其余上抛，`libs/prebuilt/langgraph/prebuilt/tool_node.py:383-391,1007-1066`）。

### 4.8 共性归纳

1. **线上都是 JSON Schema**（zod/Pydantic/Rust 结构体只是内部表达）；schema 校验失败统一「报错让模型重试且不执行」。
2. **canonical 结果与模型投影分离**是 dsh 的独有贡献（`output.schema` + `render()`），zcode 的 outputSchema/artifact 策略是同方向弱形式；loomic 的「工具输出里提取 artifact schema」亦然。
3. **超限处理三件套**：截断（各实现都有默认字符上限）、落盘/artifact 化（kimi spill、zcode artifact 策略、nomifun ArtifactStore 剥离）、延迟下发（nomifun/codex 的 deferred + ToolSearch——MCP 工具多时不占 schema 预算）。
4. **MCP 工具名冲突**三家同解：截断 + 哈希后缀（dsh SHA-256、kimi FNV、nomifun hash）；zcode 用字符消毒。MCP 工具默认需审批（zcode）/默认 deferred（nomifun）。
5. **权限收敛于**：模式档位（readonly/workspace/full + approval policy）× 工具自报类别（nomifun category_for 按输入细分）× 可组合策略链（kimi 文件化策略、cherry 静态守卫）× 输入改写（cherry updatedInput、zcode hook 改写）。
6. 执行管线普遍有 pre/post 环绕点（dsh waterfall、zcode hooks、kimi 策略链）——审批、审计、改写都挂在这两处，不进工具体。

---

## 5. 主题 × 项目对比总表

| 维度 | zcode | dsh | codex | nomifun | kimi | cherry | jaaz/loomic |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 子代理形态 | Agent 工具树状派生 + 工作流脚本 | 能力缝（6 provider，spawn/fork/跨产品） | 实验两代，子 = 完整 Thread | fan-out 委托工具（1-16） | Agent 工具 + profile 目录 | 无（委托 Claude Code CLI） | 图编排（swarm / deepagents task） |
| 上下文 | 全新 child session | 全新 flat scope（fork=seed 前缀） | 独立 Thread（fork 两档） | 独立 + worktree 写隔离 | 独立 DI scope（fork 实验态） | — | graph state 隔离 |
| A2A 通道 | SendMessage + 通知注入 + 工作流协议 | inbox（followup/steer/inject）+ 事件总线 | InterAgentCommunication + thread/turn/item 协议 | 私有账本注入 + operation-id sidecar | 树状摘要回流 | 会话间投递（不可信包裹） | Command handoff / 父工具回流 |
| 人审介入 | hooks + 权限模式 + escalate 问答 | approval 服务（fail-closed，never 前置） | 协议级 approval request/response | ToolApprovalManager 批量确认 | 策略链 + 模式 reminder | DispatchDecision（可改写入参） | 确认名单 + 挂起等待 |
| 图片进上下文 | 内联 base64（2000px/5MB 预算） | sha256 引用 + 晚编码 + offload | data URL（能力检查前置） | 附件仅图片（4 张/12MiB）+ 工具产物 ToolImage | 能力门控注册 + 降采样 | 降级为路径文本 / OCR / RAG | URL markdown / base64 image_url |
| PDF | 原生 ≤10 页或逐页渲染 ≤20 页 | 不进模型（handle 文本） | 未确认 | 不进模型（工具产物持久化） | 探测到但不解析（未确认文本化） | RAG readers 转 markdown | 不涉及 |
| 工具 schema | JSON Schema + zod 双层 | 自有 DSL + output.schema/render | 纯 serde → Responses API | Rust trait + JSON Schema | zod 两段式契约 | 统一 MCP（内存 server） | zod/@tool+Pydantic |
| 超限策略 | inline/truncate/artifact + compact | render 投影 + offload | 曝光位/字节预算 | 默认 50k 截断 + spill 型落盘（kimi） | spill 落盘 | — | job 异步化 |

---

## 6. 对本仓库的参照点（候选清单，未拍板）

以下只列机制与出处；是否引入、落在哪条缝（ctx key 见《改造计划》§4.2、扩展点见 §4.10），须走《改造计划》§6 决策流程后另立条目。

1. **subagent 作为完整能力缝的范本**（dsh）：Definition + 多 Provider（spawn/fork/跨产品委托）+ Consumer 工具三元组齐备；provider 带 `capabilities` 静态门控与 `inheritsParentContext` 声明。与 `AGENTS.md`「能力缝三元组完整才算完整」直接同构。
2. **「Model-visible ⟺ 已落账」**（dsh `deriveMessages`）：模型上下文完全由持久化事件投影，无第二状态机——与本仓对话流「轨迹账本」方向（日志五十一）互证；继续做可约束生成/工具事件先落库再可见。
3. **steer/wake/inject 三种注入语义**（dsh inbox）：运行中 turn 的追加输入分「排下轮 / step 边界 / 只可见不唤醒」三档；人机共用一条通道。本仓 workbench 追问链路可对照。
4. **失败即恢复指引**（kimi `stop_reason → next_step`；zcode 结构化选择错误不静默回退）：子任务失败结果里编入下一步动作提示，而非裸 error 文案。与本仓「run 失败必须透出服务端可读原因」不变量同向。
5. **内容寻址附件 + 晚编码 + offload**（dsh；zcode artifact 化附件）：引用进上下文、发请求时才编码、超预算占位降级——若落多端 blob 缝（多端 §5），可直接对照该机制定预算与占位协议。
6. **能力门控在读图入口**（dsh `assertImageCapableRoute`、codex `input_modalities` 前置检查、kimi 能力门控注册）：按模型模态决定处理路径，避免「处理完才发现发不出去」；对本仓生成 provider 与多模态输入缝适用。
7. **PDF 两档读取**（zcode 原生小文件 vs 逐页渲染）：多模态文档输入唯一完整实现，可作本仓文档类附件的参照上限常量（20MB/10 页/20 页/100MB）。
8. **MCP 工具治理**：哈希后缀防撞名（dsh/kimi/nomifun）、默认需审批（zcode）、默认 deferred + ToolSearch 防 schema 膨胀（nomifun/codex）、两阶段原子换装（dsh）。
9. **安全细节清单**：项目级 agent 文件的 `permissionMode` 丢弃（zcode `profile.ts:185`）、附件拒绝软链/相对路径 + 根目录包含 + magic 检测（nomifun）、跨 agent 内容不可信包裹（cherry）、审批 fail-closed 与 `never` 档确定性前置（dsh）、错误结果图片清除防回放（nomifun）。
10. **执行管线环绕点**（dsh pre/post-execute waterfall、zcode 7 事件 hooks、kimi 策略文件链）：审批/审计/输入改写全挂管线两点，工具本体保持纯——本仓工具缝若加权限层应落在管线而非各工具内。

## 7. 阅读指引

- 只关心插件内核对照 → 读 §1.2、§4.2、§6.1/2/10。
- 只关心对话流/轨迹继续对齐 dsh → 读 §2.2、§4.2 的「Model-visible ⟺ logged」。
- 只关心多模态设计 → 读 §3.2、§3.6、§6.5/6/7。
- 需要回源核对 → 按章首路径约定 + `文件:行号` 直接打开 `references/<项目>/` 对应文件。
