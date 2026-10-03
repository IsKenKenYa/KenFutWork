# WebSocket 协议（/api/ws）

> **角色**：参考。契约唯一属主是 `packages/shared/src/ws-protocol.ts`（zod schema），本文只做导读，不复制结构定义；改协议先改契约，再同步本文。

## 端点与鉴权

- 端点：`GET /api/ws`（WebSocket 升级，`@fastify/websocket`），注册于 `apps/server/src/ws/handler.ts`。
- 鉴权：令牌走查询参数 `?token=<bearer>`（浏览器 WebSocket 无法自定义 header）；managed 驱动校验会话/API 令牌，桌面 local-trust 形态凭回环信任免 token。鉴权失败以 close code `4001` 关闭。
- 不入 OpenAPI spec：OpenAPI 3.1 不覆盖 WebSocket，Apifox 侧以独立 WebSocket 接口条目录入（见 `AGENTS.md`「API 文档与 Apifox 同步」）。

## 帧类型

### Client → Server（命令，`type: "command"`，按 `action` 判别）

| action | payload 要点 | 用途 |
| --- | --- | --- |
| `agent.run` | `runCreateRequestSchema`（同 `POST /api/agent/runs`） | 启动一次智能体运行 |
| `agent.cancel` | `{ runId }` | 取消进行中的运行 |
| `canvas.resume` | `{ canvasId, lastSeq }` | 断线续传：从 `lastSeq` 起重放画布事件流 |
| `terminal.start` | `{ canvasId, shell, cols, rows }` 等 | 在工作目录拉起 PTY 终端会话 |
| `terminal.input` | `{ sessionId, data }` | 向终端会话写入输入 |
| `terminal.resize` | `{ sessionId, cols, rows }` | 调整终端尺寸 |
| `terminal.stop` | `{ sessionId }` | 结束终端会话 |

服务端对每条命令回 `command.ack` 帧（同 action，回执 payload）。

### Server → Client

| type | 说明 |
| --- | --- |
| `event` | 运行事件推送（替换 SSE），`event` 字段为 `streamEventSchema` 联合，事件清单见《job-events.md》 |
| `rpc.request` | 服务端反向 RPC 请求（`id`/`method`/`params`），客户端以 `rpc.response` 应答 |
| `rpc.response` | 客户端对 `rpc.request` 的应答帧 |
| `command.ack` | 命令回执 |
| `terminal.output` | 终端输出（base64 数据块） |
| `terminal.exit` | 终端会话退出（含退出码） |

## 相关文件

- 契约：`packages/shared/src/ws-protocol.ts`
- 处理器：`apps/server/src/ws/handler.ts`
- HTTP 侧补充：运行事件亦可按 run 查询转录（见 openapi.json `runs` 域）

## Code 原界面的宿主通道

Code 使用 `packages/shared/src/code-ui-contracts.ts` 导出的原 V4 协议：认证 HTTP RPC `/api/code-ui/rpc` 与 SSE `/api/code-ui/events`，不经旧工作台的 TaskMessage 展示归约。连接先收 hello，以 connectionId 完成 clientHello；原 subscribe 服务参数是 sessionId，RPC 只返回 ACK，snapshot/恢复帧随后经 owned 通知下发。主/子转录与租约独立，UI 复用原 SessionDataLayer。

现阶段已接创建、发送、命令查询、快照/订阅/恢复、历史行读取、Task 索引及文本文件读取。权限/提问、停止/队列、文件回退、终端等尚待接通；既有 `/api/ws` 的 Design/终端通道不因此改变。

供应商 Settings RPC 已接 `getView`、`refresh`、空配置的 `createPersonalProvider`、`savePersonalProviderOverlay` 和 `deletePersonalProvider`。草稿真实持久化无凭证、无模型状态，不能执行。原稀疏 Provider 配置用原 parser/overlay 处理，保留 API 格式、品牌、管理地址和未编辑叶子；省略 Key/headers 保留旧值，显式 null 清除，读面和通知只返回真实 `credentialConfigured` 与非敏感配置。原 Key 控件已接 presence/明确 clear，成功提交后仅清对应且未继续编辑的 Key 草稿。原 Provider/View/Model 配置类型从 shared 直接再导出，定义仍在固定 ZCode 源码。配置与持久 workspace revision 由同一 SQL 快照读取，Settings 保留停用候选，Selection 按供应商/模型开关及完整配置资格过滤。创建/保存/删除提交后，经 owned SSE 广播原两服务的 `onDidChange`；通知与应答来自同一 View。无变化刷新和同值配置保存保持修订；删除后迟到保存返回 404，不重建。模型操作/CAS、模板创建及其他写入口的通知仍待接通，不能将 Provider 保存链路视为设置全部完成。

模型编辑器已接 `resolveModelConfig`、`addPersonalModel` 与 `savePersonalModelDraft`：复用固定原推荐规则及 ModelConfigRules 的精确/手动合成，规则原件由 modelProviders 域持有。精确配置与模式标记保存于同一模型成员，标准运行容量从它推导；新增成员与配置同事务，原添加语义默认启用，新成员保留原模型 ID。草稿保存把改名、原成员位置与配置同事务提交，`basedOnRevision` 对整个 workspace Registry 作 CAS；所有配置写入口先锁工作区修订再锁实例。同修订并发只有一次提交，跨供应商配置变化同样使旧草稿返回 409；重复成员返回 409，已删除供应商/成员返回 404，不部分写入。恢复智能规则复用原结构空判定，删除个人精确配置，刷新沿用原推荐；同值重复保存不增修订，手动空配置仍按原规则拒绝。独立启停/改名/排序/删除与指定模型连通性测试仍待接通。
