# WebSocket 协议（/api/ws）

> **角色**：参考。契约唯一属主是 `packages/shared/src/ws-protocol.ts`（zod schema），本文只做导读，不复制结构定义；改协议先改契约，再同步本文。

## 端点与鉴权

- 端点：`GET /api/ws`（WebSocket 升级，`@fastify/websocket`），注册于 `apps/server/src/ws/handler.ts`。
- 鉴权：与HTTP/SSE/RPC共用真实本机接入。浏览器升级请求携带HttpOnly cookie，明确授权脚本可使用Bearer头；不通过URL查询参数携带长令牌。回环IP与精确Origin共同校验，撤销对应客户端会关闭已建立连接，逐消息再次确认授权。
- 不入 OpenAPI spec：OpenAPI 3.1 不覆盖 WebSocket，Apifox 侧以独立 WebSocket 接口条目录入（见 `AGENTS.md`「API 文档与 Apifox 同步」）。

## 帧类型

### Client → Server（命令，`type: "command"`，按 `action` 判别）

| action | payload 要点 | 用途 |
| --- | --- | --- |
| `agent.run` | `runCreateRequestSchema`（同 `POST /api/agent/runs`） | 启动一次智能体运行 |
| `agent.cancel` | `{ runId }` | 取消进行中的运行 |
| `canvas.resume` | `{ canvasId, lastSeq }` | 断线续传：从 `lastSeq` 起重放画布事件流 |
| `terminal.start` | `{ taskId, sessionId, cols, rows, cwd?, shell? }` | 显式Task目录与授权中的真实PTY终端，断线等待管理范围退出 |
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

模型计量事件仍由 shared `streamEventSchema` 持有，调用身份与 Run 总量口径见《job-events.md》的 `run.usage` 约定。Code 宿主把权威 Run 总量归入原 V4 的持久 Task `usage.cumulative`，主/子会话分别累计；刷新与重复通知不能将同一调用重复相加。原 V4 帧与 schema 未因计量新增字段而改写。

Code 使用 `packages/shared/src/code-ui-contracts.ts` 导出的原 V4 协议：认证 HTTP RPC `/api/code-ui/rpc` 与 SSE `/api/code-ui/events`，不经旧工作台的 TaskMessage 展示归约。连接先收原 hello 和宿主 reconnectDelayMs（与 hello 分开，原协议不改），以 connectionId 完成 clientHello；原 subscribe 服务参数是 sessionId，RPC 只返回 ACK，snapshot/恢复帧随后经 owned 通知下发。主/子转录与租约独立，UI 复用原 SessionDataLayer。

现阶段已接创建、发送、根会话停止、命令查询、快照/订阅/恢复、历史行读取、Task 索引、文本文件与原 readdir 目录读取。权限/提问、队列、子代理独立停止、文件回退、终端等尚待接通；既有 `/api/ws` 的 Design/终端通道不因此改变。

根 stop 沿原命令契约：expectedForegroundExecutionId 对不上当前执行或对应执行已结束时，返回 noop/guard.stopTargetChanged；未指定目标的空闲停止 accepted 且不修改快照。取消状态与 ACK 同事务持久化，重复命令只回放，真实引擎及后台任务沿既有 cancelRun 中止。启动句柄登记与 Stop 共用根锁，登记延迟期间已停止或项目已归档时不执行模型；命令裁决在根锁后持有有效项目共享锁，归档先完成则迟到请求 404，不写 accepted 回执。旧事件使用权威当前 runId，不覆盖下一轮身份。此处未接子代理独立停止，也不代表队列/权限等完整运行面已完成。

Window Controller 读面已接原 `listTaskList`、`subscribeControllerV4`、`resyncControllerV4`、`unsubscribeControllerV4`。每条 owned SSE 连接持有一个原 Runtime，源连接提供真实 Task 与 sessions-index；集合、标题 overlay、membership、delta 和游标由固定原 `windowHostControllerService` / Projection / Observer 装配，未另造展示投影。原初始帧可早于 HTTP ACK，客户端原装配先监听并缓冲；会话 transport 的 ACK 后 publish 规则保持不变。resync 拒绝跨连接及已释放租约，查询拒绝工作区外目录，关闭连接释放 Runtime 和内部源订阅；在途目录/源读取恢复后再次核实连接，迟到订阅拒绝且清理期间创建的租约。首条输入提交后发布 `task_created`，后续输入仍为 `user_message_saved`；重复命令不重复广播。空 thoughtLevel 按原可选字段语义省略，不放宽原 schema。Controller mutate/search、重连租约恢复与全局分组视图仍待完整接通。

供应商 Settings RPC 的保存装配收口到 `model-providers`，仍沿原 `providerSettingsService`／`modelSelectionService` 消费，不新增服务 key。设置 view 保留所有真实供应商及模型定义；聊天选择仅投影可执行聊天候选，生成／Flow 不进入聊天选择。原 `createPersonalProvider`／稀疏 `savePersonalProviderOverlay`、删除和供应商排序仍可用；共同字段保存不能将生成／Flow 的协议切成聊天缺省协议。实例创建是 unsafe 操作，宿主不自动重发，响应未知时先刷新列表核对。

宿主扩展 `saveManagedModel({ providerId, expectedRevision, originalModelId?, model })`：缺省 originalModelId 表示新增，重复 ID 拒绝；显式 originalModelId 表示编辑，原模型已删除返回 404，修订过期返回 409。`saveManagedProvider({ providerId, patch })` 强制 patch.expectedRevision，其余字段沿共享供应商更新契约保存；原启停、删除和排序操作也消费同一原生模型集合。`getModelDefaults`／`saveModelDefaults` 读取、校验并持久化实例 chat／image／video 策略，无需 Project 或 Task。

授权设置的 `getView` 可读取本机 Key，用于查看和复制；普通 native 定义、REST 目录、通知与运行读面仅携带 hasCredential／credentialConfigured，不携带秘密值。省略 Key／headers 保留，显式 null 清除 Key，headers={} 清空。保存成功返回权威 view 并广播非敏感 view；原 Hook 同时提交应答 view，通知丢失也可更新列表。草稿修订与供应商 CAS 保留；旧开发数据不转换。默认执行策略、统一设置文档及 Design 消费迁移仍在后续切片，当前管理接口不表示完整统一目标已完成。

模型编辑器已接 `resolveModelConfig`、`addPersonalModel` 与 `savePersonalModelDraft`：复用固定原推荐规则及 ModelConfigRules 的精确/手动合成，规则原件由 modelProviders 域持有。精确配置与模式标记保存于同一模型成员，标准运行容量从它推导；新增成员与配置同事务，原添加语义默认启用，新成员保留原模型 ID。草稿保存把改名、原成员位置与配置同事务提交，`basedOnRevision` 对整个 workspace Registry 作 CAS；所有配置写入口先锁工作区修订再锁实例。同修订并发只有一次提交，跨供应商配置变化同样使旧草稿返回 409；重复成员返回 409，已删除供应商/成员返回 404，不部分写入。恢复智能规则复用原结构空判定，删除个人精确配置，刷新沿用原推荐；同值重复保存不增修订，手动空配置仍按原规则拒绝。原 setPersonalModelEnabled 在事务内只修改最新 enabled，保留精确配置与手动/智能模式；Settings 保留停用成员，Selection 移除执行候选，同值保存不增修订。deletePersonalModel 同事务移除成员及精确规则，未知成员 404；删除后迟到的保存/启用请求拒绝，不能重新创建成员。独立改名/排序与指定模型连通性测试仍待接通。

重连间隔由 shared/governance.ts 持有默认值与护栏，按 workspace_settings 的 code_ui_reconnect_delay_ms ?? env ?? DEFAULTS 解析。现有 PUT /api/workspace/settings 接 codeUiReconnectDelayMs；读取持久真值，非法范围拒绝。新增列仅由前向迁移 20261003035733_code_ui_reconnect_setting.sql 引入，缺省 NULL 不覆盖 env。OpenAPI 将 /api/code-ui/events 正确标为 text/event-stream；逐条事件定义仍见共享原协议。HTTP 快照按原 conversationSnapshotSchema / conversationRowSchema / toolCallRowSchema 的实例引用生成复用组件，不裁剪字段、不改语义。

Code HTTP 宿主已自动恢复通知连接。断线先令原 runtime lifecycle unavailable；新连接就绪后以同一 clientHello/clientId 初始化，补齐原 Settings/Selection view，再发布原 restarted/available。原 transport 清 ownership/barrier/assembler，原 SessionDataLayer 按水位重订阅，不重新拼接消息，不自动重发有副作用的命令。离线 RPC 等新连接；关闭立即取消等待/计时器/请求，认证 401/403 立即拒绝。长时间运行、实际 Agent 断线与全部命令对账仍须后续真实验收。

Controller 与 Task 成员缓存随 HTTP 连接恢复：握手与 Settings/Selection view 追平成功后，宿主换代真实 Controller proxy 与服务快照，更新原 base workspace services 和 ServiceProvider。原 registry 据代理身份取得新连接的两类租约；其他服务代理（含 Agent）保持稳定，原 SessionDataLayer 与 sessions-index 继续按生命周期恢复。宿主沿原 membership 版本链重读持久 Task 左表，补齐断线期间丢失的成员事件，不伪造 task_created、不重新投影列表。恢复握手或 view 读取返回 401/403 时保留状态码，立即拒绝等待调用并终止重连，不发布新快照。此处不自动重发已提交的副作用命令。

原目录选择器 readdir 沿用 Project 工作目录的服务器本机路径校验，返回原 FileEntry（文件/目录、完整路径、符号链接标志），默认隐藏 dot 项、includeHidden 显式展示；目录优先并按原名称比较排序。空目录返回真实空数组，损坏 symlink 按原文件条目语义处理，缺失/非目录/相对路径给可读错误。正文读取仍校验 Project 归属及 symlink 边界。

file.resolvePath 规范化真实路径，workspace.open 绑定或创建实际 Code Project 与固定主画布；目录别名和并发打开复用同一身份，不同位置的同名目录各自独立。归档后迟到打开返回 409 与可读原因，不重新创建。setting.get/update 的 recentProjects 保存工作区顺序，写入前校验所有项目归属；不存在或已归档路径返回 404 且不污染已保存顺序。原选择器等待宿主绑定，失败沿原错误区显示并保持可重试，成功才关闭。根会话已验证共用该主画布，实际 Agent/child 的运行工作目录仍需运行验收。

原平台与设置类型/schema 由 packages/shared 直接再导出。当前 Code 宿主未接通自动化、嵌入浏览器、CUA 与远程工作区，原 UI 沿平台支持态隐藏相关操作并停止后台查询；不是 RPC 返回空成功。实际服务适配可用后再启用对应能力，未声明支持态的原宿主行为保持不变；本轮未改变 HTTP/WS 数据结构。


原 Root 的 setting.get/update 已按原 AppSettings/稀疏 patch 契约接真实工作区设置。语言、消息/工具显示、快捷键和本次运行产生的 tab/焦点等非敏感 UI 偏好存于前向 code_ui_app_preferences JSONB；recentProjects 仍由既有列持有，不复制第二份。读面同一 MVCC 行读取两者，写面按原子 JSON merge 保留未送叶子；未知字段/凭据字段拒绝。引用目录必须是当前工作区活跃 Code 项目，写入持有 FOR SHARE，归档先完成则整条拒绝。读取移除归档 tab 后按原激活条目重映射索引并清理关联焦点，最近项目按原 UI 固定规则去重保留前10项。该前置服务不转换历史调试数据，不代表原 Root 及运行偏好消费者已完成挂载。

Code 宿主已直接挂原 Root。file.ensureConversationWorkspace 沿原 IFileService 返回真实 `{path, created, workspacePurpose: "conversation"}`，共享 cwd 按当前 Workspace 身份隔离，并经 Project 服务绑定固定主画布；冷并发复用身份，重开保留文件，已归档默认项目的迟到 ensure 返回 409。目录选择先 resolvePath，再 workspace.open，绑定失败交回原选择器保持重试。原 Root 只消费真实 hello.clientMode；同源父工作台与独立 Code 文档的刷新资格沿原 navigation 判定恢复，不伪造 desktop-continuous。此轮不新增 HTTP/WS schema，原 contract 继续由 shared 导出。

Code主标题的轻量元信息由宿主明确选择原Task.getTaskMeta读面，返回来自真实原V4快照的Task元信息；主/子消息流继续走原SessionDataLayer，不增加session/read旧消息展示链。未声明宿主策略的原平台仍消费原session snapshot/converter。此选择仅涉及宿主接口，HTTP/SSE帧结构未变化，原契约与Schema仍从shared再导出。

Code 的原 `plugin-management` 通道现已将 `listPlugins` 与 `getPluginsOverview` 接到本机真实包库存。返回结构直接使用固定原 ZCode schema，由 `packages/shared/src/code-ui-contracts.ts` 再导出；原 store、市场卡片与详情负责展示。内核 feature 不属于可卸载包，已停用包仍属于 installed；自带 bundle 与本机包各有真实来源。读取先验证活跃 Code Project 归属，损坏库存明确失败而不返回假空清单。当前只有读取，安装、卸载、启停、describe、市场源写入和项目覆盖尚待消费真实服务；其它方法保持 501，不能以目录可见认定市场完成。

原 `plugin-management` 写面已接 `installPlugin`（真实自带包）、`setPluginEnabled` 与 `uninstallPlugin`。原扁平 service 寻址仅转换为原 schema 的 workspace 引用；结果沿原 schema（启停同时包含 plugin 与 enabled）。变更消费既有管理员门：managed 普通用户403，local-trust 本机主人沿既有策略。项目层写入、外部来源、更新/describe及带operationId的取消恢复仍待接通，不以本机自带包链路代替完整市场。库存变更与旧HTTP/工具入口共享同一宿主写队列，文件原子替换；卸载后迟到启用404，不重装已删包。

自带包的原安装重放保留用户已有启停选择；显式removeCache=false卸载只移除安装与贡献，保留缓存/数据，返回removedPlugin.enabled=false。Host ready/close消费原服务恢复与写队列，关闭不提前报告资源释放完成。


原插件市场宿主接线（2026-10-09）：发行目录使用固定 kenfutwork-bundled 身份并归公开，本机来源归 kenfutwork-local；官方安装包同时核 trusted发行目录与record.source=builtin，不按同名猜归属。随发行包使用bundled__命名空间，与local__本机包区分，不维护旧调试ID别名。原overview／installed listing提供已声明包图标引用，仍由原组件及认证平台读取；停用只保留清单声明的图片元信息可读，运行面板和贡献继续收回。实例层原installPlugin/setPluginEnabled/uninstallPlugin无需Project或Task；若带项目引用仍须真实验证，workspace安装态尚未接入，不伪造工作目录。页面端无项目操作在共用管理文档切片完成。

公共GET /api/plugins独立返回installed与enabled，未安装／停用不返回运行面板入口；POST /api/plugins/:id/toggle保留installed=true并返回实际enabled。它们消费同一registry，不增加配置或安装服务。完整侧栏、MCP／技能、子定义双模式消费与共用管理页进度见《现有能力接线与入口统一》，当前目录／图标切片不表示完整目标完成。
