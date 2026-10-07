# Code Task MCP

Code 与 Design 共用工具注册表、ToolSearch、逐调用审批和同一 Harness。`create_mcp_server` 由唯一动态条目按模式分派，Code 不以 Canvas id 或全局 MCP 连接代替 Task 身份。

Code 的 `create_mcp_server` 创建授权目录内的脚本连接，`install_mcp_server` 接受显式 executable、argv、env 和 cwd；`uninstall_mcp_server` 等待真实停止；`list_mcp_servers` 只给当前 Task 的状态、工具名称与 envKeys。创建、安装、卸载和未知 MCP 方法的效果均为 execute，不属于文件编辑自动化白名单。服务端模型供应商环境与管理员的全局 `mcp_servers.env` 都不会隐式复制到 Code 进程。

调用必须带可信 ScopeHandle、Task/工作区、用户、分支、Run 和 tool-call 身份。参数不能签发这些事实。每次执行重新验证 ScopeHandle；旧分支、其它 Task 和 readonly/explore/review 不能借用已发现的定义执行。外部 `readOnlyHint` 不构成本机只读能力证明。

Task map 在同一宿主内跨 Run 保留连接。同 Task 同名配置的并发与重放认领同一次启动；更改启动配置先卸载。同一 Task、服务和原 RPC 方法生成稳定 ASCII wire alias；固定摘要和短标签用于满足函数名协议约束，完整原名保留在 description，实际 RPC 始终调用原方法。宿主重启后的连接视为中断，不自动重放启动副作用；持久脚本可供用户重新安装。

stdio 仅通过 `ProcessSandbox.spawnStdio` 的受控句柄，不使用 SDK 自行 spawn、PTY 或有界 capture 轮询。stdout/stderr 独立完整 UTF8 流由 Provider 消费完成后 ACK；历史 capture 截断不截断协议。单条协议消息复用 `processMaxOutputBytes`，SDK 请求 deadline 复用 `executeTimeoutMs`，进程 capture/grace 等预算来自当前 workspace settings。环境值仅进入运行时配置；公开参数事件幂等投影为 envKeys，审批摘要与执行仍使用原参数，错误隐藏已知 env 值。

pending 连接在第一个 FS/配置等待前登记，`transportReady` 允许关闭器停止仍在 SDK 握手中的进程。Task-before-process-close、目录/权限收紧、宿主租约丢失、Fastify 关闭和 Kernel 异步卸载都 join `stop()` 的 `rangeEmpty` 确认。失联、IPC 断线与 SDK client.close 不等于退出；停止未确认时保留 failed 记录、阻止新调用，允许重新尝试清理。所有进程范围与平台限制沿用 ProcessSandbox 的真实 enforcement 描述，不扩张其保证。

Design 保留现有管理员门、全局配置和 HTTP 管理接口，其全局 MCP 工具限于 Design。没有删除或退休原端点，也没有维护第二 Agent loop。

## 验证

2026-10-03 本域公共窄回归 34/34 GREEN，包含真实 MCP SDK JSON-RPC、真实 ScopeHandle、共同 Kernel 审批和插件装配/异步卸载。运行命令：

```sh
pnpm --filter @kenfutwork/server exec vitest run src/features/mcp/task-mcp-service.test.ts src/features/mcp/scoped-stdio-transport.test.ts src/features/mcp/task-mcp-tools.test.ts src/features/mcp/plugin.test.ts src/features/mcp/mcp-tools.test.ts src/features/mcp/create-mcp-server-tool.test.ts src/features/mcp/mcp-service.test.ts --maxWorkers=1
```

真实 macOS SRT + compiled helper tracer 1/1 GREEN。只使用新的临时 Task/外域目录与既有构建产物，不连接现存数据库、不重编 helper。实际覆盖 stdout/stderr/Unicode、跨 Run 同 PID、显式 env 到达但 ambient `OPENAI_API_KEY` 不继承、外域 write 被 OS 拒绝、Task close 返回范围为空及随后心跳不再写入。默认跳过，显式运行：

```sh
KENFUTWORK_MCP_NATIVE_TEST=1 KENFUTWORK_MCP_TEST_HELPER=/absolute/path/to/published/task-helper.mjs pnpm --filter @kenfutwork/server exec vitest run src/features/mcp/task-mcp-native.integration.test.ts --maxWorkers=1
```

上述证据是本域窄验收；完整 workspace、类型、文档和 OpenAPI 门禁由集成任务验收。Windows stdio live ACK 的可用性以 ProcessSandbox 实现与平台实证为准，依赖未就绪时拒绝，不能退回不受控进程。
