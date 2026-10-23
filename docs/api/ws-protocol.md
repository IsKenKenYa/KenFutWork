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
| `agent.cancel` | `{ runId, taskId? }`（Design 必填 Task） | 取消进行中的运行 |
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

终态事件的 `stopReason` 随 `event` 帧透传，语义见《job-events.md》；WebSocket断线重放保留原原因，不触发新的模型或工具执行。

## 相关文件

- 契约：`packages/shared/src/ws-protocol.ts`
- 处理器：`apps/server/src/ws/handler.ts`
- HTTP 侧补充：运行事件亦可按 run 查询转录（见 openapi.json `runs` 域）

## Code 原界面的宿主通道

模型计量事件仍由 shared `streamEventSchema` 持有，调用身份与 Run 总量口径见《job-events.md》的 `run.usage` 约定。Code 宿主把权威 Run 总量归入原 V4 的持久 Task `usage.cumulative`，主/子会话分别累计；刷新与重复通知不能将同一调用重复相加。原 V4 帧与 schema 未因计量新增字段而改写。

Code 使用 `packages/shared/src/code-ui-contracts.ts` 导出的原 V4 协议：认证 HTTP RPC `/api/code-ui/rpc` 与 SSE `/api/code-ui/events`，不经旧工作台的 TaskMessage 展示归约。连接先收原 hello 和宿主 reconnectDelayMs（与 hello 分开，原协议不改），以 connectionId 完成 clientHello；原 subscribe 服务参数是 sessionId，RPC 只返回 ACK，snapshot/恢复帧随后经 owned 通知下发。主/子转录与租约独立，UI 复用原 SessionDataLayer。

工作台的文档活动桥由 `packages/shared/src/code-ui-host-bridge.ts` 导出 `workspaceActivitySchema`：`{ type: "kenfutwork:workspace-activity", active: boolean }` 是同源父窗口的postMessage，不是HTTP／SSE／WS运行事件。Code／Design子页校验origin及source，非活动时收束焦点和键盘，保留运行、订阅、转录与原iframe。父文档同步隐藏自身portal；首次消息早于监听时，子页读取父iframe的inert属性。Flow握手同时校验当前iframe窗口与配置origin，地址更换后的迟到身份票据不再注入。

顶部模式能力使用同一宿主桥的`workbenchModesSchema`／`workbenchNavigationSchema`。父窗口按现有Flow安装、启用及宿主配置，发送有序Code／Design与可选Flow；子页只接受同源父窗口。原导航发`kenfutwork:code-navigate`，父窗口再次核当前iframe、活动态及真实可用模式，停用后迟到请求无效。Code内部仍为coding，模式变化不终止或重发运行。

共用管理导航同样使用该文件的`managementTargetSchema`。当前Code文档发送`kenfutwork:open-management`，目标仅含原页面、分区和插件／供应商ID，不含凭据或执行身份；父窗口核当前iframe及origin后打开`/code-ui/index.html?document=management`，通过原bootstrap的`management`字段传目标。管理文档只装配原管理providers／页面，不初始化工作区Root；实例操作无需Project／Task。`kenfutwork:management-close`仅从当前管理窗口接受，关闭恢复原文档输入；宿主关闭按钮在子页加载及失败时仍可用。库存通知沿原插件事件同步，两模式消费同一既有服务。此桥不新增HTTP／WS端点。

现阶段已接创建、发送、根会话停止、命令查询、快照/订阅/恢复、历史行读取、Task 索引、文本文件与原 readdir 目录读取。权限/提问、队列、子代理独立停止、文件回退、终端等尚待接通；既有 `/api/ws` 的 Design/终端通道不因此改变。

根 stop 沿原命令契约：expectedForegroundExecutionId 对不上当前执行或对应执行已结束时，返回 noop/guard.stopTargetChanged；未指定目标的空闲停止 accepted 且不修改快照。取消状态与 ACK 同事务持久化，重复命令只回放，真实引擎及后台任务沿既有 cancelRun 中止。启动句柄登记与 Stop 共用根锁，登记延迟期间已停止或项目已归档时不执行模型；命令裁决在根锁后持有有效项目共享锁，归档先完成则迟到请求 404，不写 accepted 回执。旧事件使用权威当前 runId，不覆盖下一轮身份。此处未接子代理独立停止，也不代表队列/权限等完整运行面已完成。

Window Controller 读面已接原 `listTaskList`、`subscribeControllerV4`、`resyncControllerV4`、`unsubscribeControllerV4`。每条 owned SSE 连接持有一个原 Runtime，源连接提供真实 Task 与 sessions-index；集合、标题 overlay、membership、delta 和游标由固定原 `windowHostControllerService` / Projection / Observer 装配，未另造展示投影。原初始帧可早于 HTTP ACK，客户端原装配先监听并缓冲；会话 transport 的 ACK 后 publish 规则保持不变。resync 拒绝跨连接及已释放租约，查询拒绝工作区外目录，关闭连接释放 Runtime 和内部源订阅；在途目录/源读取恢复后再次核实连接，迟到订阅拒绝且清理期间创建的租约。首条输入提交后发布 `task_created`，后续输入仍为 `user_message_saved`；重复命令不重复广播。空 thoughtLevel 按原可选字段语义省略，不放宽原 schema。Controller mutate/search、重连租约恢复与全局分组视图仍待完整接通。

供应商 Settings RPC 的保存装配收口到 `model-providers`，仍沿原 `providerSettingsService`／`modelSelectionService` 消费，不新增服务 key。设置 view 保留所有真实供应商及模型定义；聊天选择仅投影可执行聊天候选，生成／Flow 不进入聊天选择。原 `createPersonalProvider`／稀疏 `savePersonalProviderOverlay`、删除和供应商排序仍可用；共同字段保存不能将生成／Flow 的协议切成聊天缺省协议。实例创建是 unsafe 操作，宿主不自动重发，响应未知时先刷新列表核对。

宿主扩展 `saveManagedModel({ providerId, expectedRevision, originalModelId?, model })`：缺省 originalModelId 表示新增，重复 ID 拒绝；显式 originalModelId 表示编辑，原模型已删除返回 404，修订过期返回 409。`saveManagedProvider({ providerId, patch })` 强制 patch.expectedRevision，其余字段沿共享供应商更新定义保存；原启停、删除和排序操作也消费同一原生模型集合。`getModelDefaults`／`saveModelDefaults` 读取、校验并持久化实例 chat／approval／image／video 默认模型，审批与对话选择分别保存，无需 Project 或 Task。

授权设置的 `getView` 可读取本机 Key，用于查看和复制；普通 native 定义、REST 目录、通知与运行读面仅携带 hasCredential／credentialConfigured，不携带秘密值。省略 Key／headers 保留，显式 null 清除 Key，headers={} 清空。保存成功返回权威 view 并广播非敏感 view；原 Hook 同时提交应答 view，通知丢失也可更新列表。草稿修订与供应商 CAS 保留，当前对话模型与审批模型分别由同一供应商服务解析。

原供应商的 `access.apiKeyManagementUrl` 由同一实例的 `compat.codeUi.apiKeyManagementUrl` 持久保存，聊天与生成／Flow 设置共同读取。原创建接口接受初始链接；稀疏保存时省略保留、字符串更新、明确 `null` 只清除链接，`access:null` 同时清除链接与 Key。清除 Key 不影响链接。链接属于公开元数据，凭据仍经原私有接口持有；同值保存保持修订，过期修订继续返回 409。

模型编辑器已接 `resolveModelConfig`、`addPersonalModel` 与 `savePersonalModelDraft`：复用固定原推荐规则及 ModelConfigRules 的精确/手动合成，规则原件由 modelProviders 域持有。精确配置与模式标记保存于同一模型成员，标准运行容量从它推导；新增成员与配置同事务，原添加语义默认启用，新成员保留原模型 ID。草稿保存把改名、原成员位置与配置同事务提交，`basedOnRevision` 对整个 workspace Registry 作 CAS；所有配置写入口先锁工作区修订再锁实例。同修订并发只有一次提交，跨供应商配置变化同样使旧草稿返回 409；重复成员返回 409，已删除供应商/成员返回 404，不部分写入。恢复智能规则复用原结构空判定，删除个人精确配置，刷新沿用原推荐；同值重复保存不增修订，手动空配置仍按原规则拒绝。原 setPersonalModelEnabled 在事务内只修改最新 enabled，保留精确配置与手动/智能模式；Settings 保留停用成员，Selection 移除执行候选，同值保存不增修订。deletePersonalModel 同事务移除成员及精确规则，未知成员 404；删除后迟到的保存/启用请求拒绝，不能重新创建成员。独立改名/排序与指定模型连通性测试仍待接通。

模型输入接纳时将有效容量保存到私有 `modelInvocation.contextWindow`，与选项正文、输入能力及供应商修订共同固定；旧输入缺少该字段时沿原目录解析。初始运行、指导切换、压缩和独立模型请求消费同一容量。实际调用的可信用量归属经已有 `run.usage.contextWindowTokens/maxOutputTokens` 字段发布，输出上限取实际原生请求；新输入不使用展示层的旧模型缓存补写容量。容量未知时保持未知，恢复推荐只改变后续新输入。

重连间隔由 shared/governance.ts 持有默认值与护栏，按 workspace_settings 的 code_ui_reconnect_delay_ms ?? env ?? DEFAULTS 解析。现有 PUT /api/workspace/settings 接 codeUiReconnectDelayMs；读取持久真值，非法范围拒绝。新增列仅由前向迁移 20261003035733_code_ui_reconnect_setting.sql 引入，缺省 NULL 不覆盖 env。OpenAPI 将 /api/code-ui/events 正确标为 text/event-stream；逐条事件定义仍见共享原协议。HTTP 快照按原 conversationSnapshotSchema / conversationRowSchema / toolCallRowSchema 的实例引用生成复用组件，不裁剪字段、不改语义。

Code HTTP 宿主已自动恢复通知连接。断线先令原 runtime lifecycle unavailable；新连接就绪后以同一 clientHello/clientId 初始化，补齐原 Settings/Selection view，再发布原 restarted/available。原 transport 清 ownership/barrier/assembler，原 SessionDataLayer 按水位重订阅，不重新拼接消息，不自动重发有副作用的命令。离线 RPC 等新连接；关闭立即取消等待/计时器/请求，认证 401/403 立即拒绝。长时间运行、实际 Agent 断线与全部命令对账仍须后续真实验收。

Controller 与 Task 成员缓存随 HTTP 连接恢复：握手与 Settings/Selection view 追平成功后，宿主换代真实 Controller proxy 与服务快照，更新原 base workspace services 和 ServiceProvider。原 registry 据代理身份取得新连接的两类租约；其他服务代理（含 Agent）保持稳定，原 SessionDataLayer 与 sessions-index 继续按生命周期恢复。宿主沿原 membership 版本链重读持久 Task 左表，补齐断线期间丢失的成员事件，不伪造 task_created、不重新投影列表。恢复握手或 view 读取返回 401/403 时保留状态码，立即拒绝等待调用并终止重连，不发布新快照。此处不自动重发已提交的副作用命令。

原目录选择器 readdir 沿用 Project 工作目录的服务器本机路径校验，返回原 FileEntry（文件/目录、完整路径、符号链接标志），默认隐藏 dot 项、includeHidden 显式展示；目录优先并按原名称比较排序。空目录返回真实空数组，损坏 symlink 按原文件条目语义处理，缺失/非目录/相对路径给可读错误。正文读取仍校验 Project 归属及 symlink 边界。

file.resolvePath 规范化真实路径，workspace.open 绑定或创建实际 Code Project 与固定主画布；目录别名和并发打开复用同一身份，不同位置的同名目录各自独立。归档后迟到打开返回 409 与可读原因，不重新创建。setting.get/update 的 recentProjects 保存工作区顺序，写入前校验所有项目归属；不存在或已归档路径返回 404 且不污染已保存顺序。原选择器等待宿主绑定，失败沿原错误区显示并保持可重试，成功才关闭。根会话已验证共用该主画布，实际 Agent/child 的运行工作目录仍需运行验收。

原平台与设置类型/schema 由 packages/shared 直接再导出。当前 Code 宿主未接通自动化、嵌入浏览器、CUA 与远程工作区，原 UI 沿平台支持态隐藏相关操作并停止后台查询；不是 RPC 返回空成功。实际服务适配可用后再启用对应能力，未声明支持态的原宿主行为保持不变；本轮未改变 HTTP/WS 数据结构。


原 Root 的 setting.get/update 已按原 AppSettings/稀疏 patch 契约接真实工作区设置。语言、消息/工具显示、快捷键和本次运行产生的 tab/焦点等非敏感 UI 偏好存于前向 code_ui_app_preferences JSONB；recentProjects 仍由既有列持有，不复制第二份。读面同一 MVCC 行读取两者，写面按原子 JSON merge 保留未送叶子；未知字段/凭据字段拒绝。引用目录必须是当前工作区活跃 Code 项目，写入持有 FOR SHARE，归档先完成则整条拒绝。读取移除归档 tab 后按原激活条目重映射索引并清理关联焦点，最近项目按原 UI 固定规则去重保留前10项。该前置服务不转换历史调试数据，不代表原 Root 及运行偏好消费者已完成挂载。

Code 宿主已直接挂原 Root。file.ensureConversationWorkspace 沿原 IFileService 返回真实 `{path, created, workspacePurpose: "conversation"}`，共享 cwd 按当前 Workspace 身份隔离，并经 Project 服务建立真实 Code 默认对话项目与工作目录；冷并发复用身份，重开保留文件，已归档默认项目的迟到 ensure 返回 409。目录选择先 resolvePath，再 workspace.open，绑定失败交回原选择器保持重试。原 Root 只消费真实 hello.clientMode；同源父工作台与独立 Code 文档的刷新资格沿原 navigation 判定恢复，不伪造 desktop-continuous。此轮不新增 HTTP/WS schema，原 contract 继续由 shared 导出。

Code主标题的轻量元信息由宿主明确选择原Task.getTaskMeta读面，返回来自真实原V4快照的Task元信息；主/子消息流继续走原SessionDataLayer，不增加session/read旧消息展示链。未声明宿主策略的原平台仍消费原session snapshot/converter。此选择仅涉及宿主接口，HTTP/SSE帧结构未变化，原契约与Schema仍从shared再导出。

Code 的原 `plugin-management` 通道现已将 `listPlugins` 与 `getPluginsOverview` 接到本机真实包库存。返回结构直接使用固定原 ZCode schema，由 `packages/shared/src/code-ui-contracts.ts` 再导出；原 store、市场卡片与详情负责展示。内核 feature 不属于可卸载包，已停用包仍属于 installed；自带 bundle 与本机包各有真实来源。读取先验证活跃 Code Project 归属，损坏库存明确失败而不返回假空清单。当前只有读取，安装、卸载、启停、describe、市场源写入和项目覆盖尚待消费真实服务；其它方法保持 501，不能以目录可见认定市场完成。

原 `plugin-management` 写面已接 `installPlugin`（真实自带包）、`setPluginEnabled` 与 `uninstallPlugin`。原扁平 service 寻址仅转换为原 schema 的 workspace 引用；结果沿原 schema（启停同时包含 plugin 与 enabled）。变更消费既有管理员门：managed 普通用户403，local-trust 本机主人沿既有策略。项目层写入、外部来源、更新/describe及带operationId的取消恢复仍待接通，不以本机自带包链路代替完整市场。库存变更与旧HTTP/工具入口共享同一宿主写队列，文件原子替换；卸载后迟到启用404，不重装已删包。

自带包的原安装重放保留用户已有启停选择；显式removeCache=false卸载只移除安装与贡献，保留缓存/数据，返回removedPlugin.enabled=false。Host ready/close消费原服务恢复与写队列，关闭不提前报告资源释放完成。


原插件市场宿主接线（2026-10-09）：发行目录使用固定 kenfutwork-bundled 身份并归公开，本机来源归 kenfutwork-local；官方安装包同时核 trusted发行目录与record.source=builtin，不按同名猜归属。随发行包使用bundled__命名空间，与local__本机包区分，不维护旧调试ID别名。原overview／installed listing提供已声明包图标引用，仍由原组件及认证平台读取；停用只保留清单声明的图片元信息可读，运行面板和贡献继续收回。实例层原installPlugin/setPluginEnabled/uninstallPlugin无需Project或Task；若带项目引用仍须真实验证，workspace安装态尚未接入，不伪造工作目录。页面端无项目操作在共用管理文档切片完成。

公共GET /api/plugins独立返回installed与enabled，未安装／停用不返回运行面板入口；POST /api/plugins/:id/toggle保留installed=true并返回实际enabled。它们消费同一registry，不增加配置或安装服务。完整侧栏、MCP／技能、子定义双模式消费与共用管理页进度见《现有能力接线与入口统一》，当前目录／图标切片不表示完整目标完成。

插件入口接线（2026-10-09）：GET /api/plugins同时投影真实scope（code/design/shared/null），ui合并清单与运行时贡献，按pluginId＋entryId去重，同键运行时优先。Code原侧栏及Design各运行槽沿作用域过滤；写入返回或失败后读取对账，旧读取晚到不复活收回入口。Code父窗口桥只接收当前同源文档的code-open-plugin（pluginId/entryId）与code-plugins-changed；面板地址由父宿主重新核已安装、启用且适用的库存，沿现有PluginPanelOverlay与私有路由打开，不接收消息中的URL或凭据。实例settings槽不按工作模式缩窄。

### 原 MCP 管理宿主

`mcp-sync.loadMcpFromUserDirectory`、`readMcpServerConfiguration`、`saveMcpToUserDirectory` 和 `listWorkspaceMcpServerStatuses` 由 MCP feature 贡献，复用 REST／运行工具的同一 `McpService`。本机配置为实例数据库记录；原接口名称保留，不伪造文件夹或位置，也不创建 Project／Task。普通列表只返回 `envKeys`，本机授权编辑按 `hostRecordId` 单独读取完整配置；不将凭据写入共享 UI inventory 或普通事件。

创建传 `hostRecordId:null`；编辑、启停与删除传原记录 UUID。删除后迟到请求返回404，不能按同名记录重新绑定。写入响应未知时只读刷新，不自动重放；写入成功但刷新失败保留表单并报告读取错误。环境来源只读。当前服务承接 stdio／HTTP 与真实状态／重连；项目文件配置、OAuth、显式 SSE 类型、HTTP 请求头、超时及协议覆盖未接入，原表单禁用对应操作。外部 Agent 扫描／同步与市场检索仍继续接线，不计本片完成。

### 原技能管理宿主

原 `skills.list/setEnabled/deleteSkill/buildPromptContext` 在 skills feature 贡献，复用现有技能仓库、REST与运行目录数据。实例包返回 `scope:user`、真实 `resourceRef` 与空物理 `path`；不需要Project，不假作项目安装、文件目录或软链。原详情沿MessageResponse显示正文。原删除入口在本机包边界标为卸载并仅移除安装，保留可见定义；定义CRUD、目录及链接安装／市场检索仍在接线，不计本片完成。

启停及卸载需回传 `installationRevision`，由既有安装时间的UTC精确文本派生，并在原仓库SQL条件中原子匹配；卸载重装后旧请求404，不能改新安装。无新增配置库或SQL迁移。旧集中Skills桥及其项目/Task绑定退役；文件、Git与终端继续沿真实Project/Task权限边界。外部Agent扫描/同步原页面标未接入、禁用操作且不发送扫描/导入请求；不返回假空数据。设置页与共享技能消费接口都保护目标/服务/读取代际，写入响应未知只读对账不自动重放。

插件定义从同一注册表已安装包读取，返回 `scope:plugin`、稳定 `resourceRef` 与空物理路径；停用保留只读定义，卸载移除。资源身份为 `kenfutwork-plugin-skill:${encodeURIComponent(pluginId)}/${encodeURIComponent(relativeSkillPath)}`，不能按同名猜归属或映射成文件夹。原 Markdown 详情只展示按固定 ZCode 正文算法提取的 body，运行目录／`use_skill` 仍读取完整 SKILL.md 和包内相对资源。实例、canonical 相对路径、启用态及 Code／Design 模式都由既有资源服务核对；停用／卸载后拒绝运行读取。原轮次 loader 接同一注册表，并保留已取得的目录快照；Composer 选择与引用消费仍须逐场景验收，不以管理列表替代执行。

`provider` 复用原 `zcodeAgentProviderSchema` 的 `glm` wire 标识，表示原 Agent 协议身份，不是 BYOK 供应商选择。技能列表与诊断条目无效时宿主通道明确拒绝，原页面显示读取错误，不转成假空目录。

### 实例命令的运行输入

Code V4与Design原`agent.run`传输保留用户原文。现有运行设置读取后统一匹配`instance_settings.commands`，沿固定ZCode的原函数展开`$ARGUMENTS`、`$1/$2`及无占位符参数尾块，再进入已有媒体／上下文构造；原用户转录与工具权限不改写。动态shell预展开仍由原函数拒绝，不执行系统命令。后台结果、控制输入及已声明子派发深度不作为用户命令解析。原管理页CRUD、指导消息、并发草稿及冷恢复还须继续验收，不能以本片证明整套命令能力完成。

### 插件来源宿主

`plugin-management.inspectPluginSource/installPluginFromSource` 由 plugins feature 贡献，参数／结果沿既有 `pluginInspectRequest/Response` 与 `pluginInstallRequest/Response` 公共schema。来源检查与安装直接消费同一注册表，支持链接和本机目录，不创建Project／Task；原市场源添加、更新、删除是独立操作，未接入时保留原页并禁用。

来源安装不开放生命周期脚本授权；安装阶段重新执行既有兼容门禁，拒绝时原HTTP/RPC返回真实报告与422。停用后重装保持停用。原来源表单输入与检查结果绑定服务、目标、来源及弹窗代际；关闭表单仍给有效库存目标只读对账，迟到响应不清新表单或作废新目标读取，未知写入响应不自动重试。Native顶栏「刷新库存」仅重新读取目录，不冒充市场源更新。工作目录授权安装与导出入口仍待接线。

## Code/Design 共享 Task 传输

Code、Design 会话均使用原 V4 命令与 Task 宿主；工作方式、画布引用、选区、生成偏好在 `workContext` 内随输入接纳冻结。Task 持有固定文件目录与授权代际，画布引用不能签发目录授权。Goal、审批、取消、队列及重连使用同一会话协议；后续 Goal Run 重新捕获当时能力，已接纳输入保留自己的能力快照。

`sendConversationCommandV4` 使用原 V4 `envelope`，RPC 参数同时提供工作目录及项目身份；Goal 命令可使用下文的独立 `goalControl`。模型、思考、基础权限、`planEnabled` 与 `workContext` 使用原命令载荷，在点击发送和服务端接纳时分别冻结。RPC 参数、envelope 与各命令载荷均严格校验字段；Code、Design 共用原传输、可替换代理与服务客户端。

同一命令和相同内容重放返回原回执；同一命令更改内容返回冲突，不重复执行。基础权限为 `build`／`edit`／`yolo`，独立 Plan 在其上收窄执行范围；规划退出须经原人工批准流程，模型批准不能扩大角色或目录权限。原输入框直接使用当前规划草稿，普通文本沿 `sendText` 处理，明确目标命令沿 `sendGoalCommand` 处理。Goal 的创建、替换和恢复核验真实目标身份及修订，暂停后普通消息不自动恢复目标。

原会话快照通过 `taskControl: { projectId, branchGeneration }` 提供当前根 Task 的项目与分支事实。根会话和子会话使用同一根 Task 事实，HTTP 与 SSE 使用同一提供方；它与消息 `revision`、文件授权版本分别持有。KFW 的 `sendText` 和 `stop` 在操作时复制该值，附件准备、配置等待和请求传输均保留原值。缺少时回执为 `rejected/proto.missingTaskControl`，项目或分支已改变时为 `stale/proto.staleTaskControl`。根记录事务先处理原命令回执重放，再核对新操作的观察值；同一命令键改变观察值返回 409。

创建回执的 `result.taskControl` 来自同一事务内实际插入的根记录，并随回执保存。预热 Task 的首个订阅快照尚未到达时，原首发也使用该初始值；重放创建回执返回原值，不能据此推断当前分支。协议字段为可选，以保留原 ZCode 协议解析范围；上述缺字段拒绝由 KFW 接纳服务执行。其它 Task 控制入口及移动后的历史读取仍按升级计划逐项验证。

`createSession.firstInput` 与新 Task、原生线程、活动输入及创建回执在同一事务保存，回执的 `result.input` 返回 `startNow` 与原命令 ID。首条输入冻结模型、思考、规划、基础权限、工作内容及真实 Task 授权版本；模型执行在 HTTP 回执后通过原发布入口开始。同一实例、`clientId` 与 `commandId` 为创建业务键，首次参数指纹随回执保存；并发或顺序重放返回同一 Task，同键改参数返回 409，删除后迟到创建返回 404。COMMIT 回包丢失后的读取结果沿同一创建身份判断派发责任，不能让重复请求启动第二次执行。首条输入的附件继续要求先在真实 Task 上传。

新 Task 的附加目录在创建事务取得项目行锁后读取，并与 Task 一起保存。项目目录修改先提交时，并发创建使用修改后的目录；已有 Task 的目录、读写权限和授权版本保持原值。创建回执重放仍返回原 Task，不重新继承项目设置。

外部 HTTP `/api/agent/runs` 与 WS `agent.run` 使用同一 `codeUi.admitExternalRun`。必须提供真实 Task 及匹配的项目、授权代际；`inputId` 是稳定命令身份，同身份重放不重新执行。WS 先发送 `command.ack`（含 taskId/sessionId/inputId/runId），再触发同一原会话发布；运行事件与恢复通过原会话订阅读取。

`agent.cancel` 由 canonical Task 输入和运行控制核验身份，先记录停止意图，再等待实际取消。素材、模型、权限与工作内容均由共享 Task 接纳并核验，外部请求不能覆盖已冻结的运行事实。

服务升级后，中断输入需要明确重新提交，相关 Goal 保持暂停并等待明确恢复；模型、目录和权限上限继续使用原授权事实。完整升级规则见[实施规格 §2.7](../方案设计/Code工作域与工具内核实施规格.md)，检查回执与未完成验收见[日志](../日志.md)。

## 原项目编辑器

原 `ProjectEditor` 经已初始化的连接调用 `project.readProjects`、`project.readDirectory`、`project.saveProject` 与 `project.deleteProject`。提供方沿 `code-ui-host-rpc` 贡献，实例和接入身份由连接持有；本机目录浏览是明确的人类目录选择，不借用当前 Task 授权。

编辑包含项目 `id`、有序 `roots`、固定 `primaryRoot`、`rootPermissions` 及非负 32 位 `expectedRevision`。根目录按真实路径归一化，重复和符号链接别名合并，路径中的空格保持。新增附加目录按明确的只读或可写选择保存；项目修改只影响新 Task，已有 Task 的目录和授权版本保持。

创建省略 `id`，携带原表单生成的稳定 `creationId`、`kind: "code" | "design"`、有序目录和明确权限。实例与 `creationId` 组成创建业务键；规范化名称、目录、权限、工作方式及同目录选择形成参数指纹，同键改参数返回 409。项目与创建回执在同一事务保存，顺序或并发重放返回同一创建结果，不生成 Task 或 Canvas。同名新项目沿原规则追加 ` (2)`、` (3)`，同实例的名称分配在事务内串行完成。读取已提交回执先于再次校验文件系统；项目归档或物理删除后，回执仅保留实例和创建键，迟到请求返回 404，实例物理删除时级联清除。

实例、项目及观察修订组成保存业务键，规范化的名称、目录及权限形成意图指纹。同键同意图返回原回执，意图变化或修订过期返回 409；同值保存不推进修订，也不占用该修订的修改回执。回执与项目变更在同一事务保存，目录后来移除不影响已提交意图的重放。归档或删除后的迟到保存返回 404，不能恢复项目。

保存和归档后沿原 `broadcast.onMessage` 发布 `channel: "state:projects"`、`payload: { projectId }`。窗口重新读取真实项目列表，更新项目名称，不切换 Task、会话或内容标签。通知只提示重读，不能替代项目身份或目录授权。

连接取消后，保存事务继续检查取消信号，宿主等待在途调用退出；旧连接调用和取消后的回执返回可读的 404。关闭中的项目拒绝编辑和新 Task 创建，归档等待原 Task 资源实际关闭。已提交的保存仍由原业务键读取，不自动重放有副作用的请求。

## 原分组结构读取

原宿主 RPC 的 `task-groups.read` 只接收空参数元组，由已初始化的可信本机连接调用。所属插件贡献方法，独立读取接口和 PostgreSQL 提供方返回同一只读快照中的 `revision`、`groups`、`members` 及根节点 `order`。读取不登记 Task、不推进组织修订，也不启动 Run。

成员关联实例内的稳定 Task Owner；`workspaceKey` 和根 Task 排序键由当前 Project 身份与 Task 固定目录投影，项目当前目录改变不改写已有 Task 的目录或权限。组织修订独立于执行分支与授权代际。归档和恢复保留成员与顺序，Task 软删除或物理删除在原事务清除成员并推进一次组织修订，之后重复读取不能恢复记录。实例物理删除时级联清理组织数据。

未知参数或额外位置参数返回 400；连接关闭取消尚未开始的读取，宿主等待已有读取结束并拒绝旧连接结果。分组编辑、取消组、排序及首次登记随原侧栏消费者继续接入，本节只记录已提供的读取方法。

## 原项目树与归档管理

原归档页面通过同一目录 owner 调用 `project.readTree`。`includeDeleted: true` 显式包含已归档项目并以 `deleted: true` 标识；普通读取排除这些项目及所属 Task。项目与根 Task 在同一 PostgreSQL 只读快照投影，Task 使用创建时固定目录及当前 Project 身份，不从已打开标签推导归属。`includeDeletedTasks: true` 返回最小删除事实，仅包含不透明 `taskId`、`projectId` 和 `hostId`。归档读取不恢复目录授权或运行。

每个 Task 行的 `taskControl: { projectId, branchGeneration }` 供明确操作固定观察值。原 `archiveTask`、`unarchiveTask`、`deleteArchivedTask` 通过所属插件的宿主 RPC 贡献调用，完整参数包含 `taskId`、`workspacePath`、`workspaceIdentity` 及该观察值；客户端保留点击时的完整目标。未知字段、多余参数及缺少观察值返回 400，项目、目录或分支改变后拒绝旧操作。

归档业务键由实例、Task、项目、观察分支和目标归档值生成；明确字段的规范化参数形成 SHA-256 指纹。回执使用原命令存储，顺序和并发重放读取同一结果，同键异参返回 409。归档先在事务内推进授权与分支并进入关闭状态，再等待原资源关闭器确认运行、后台工作、文件操作和进程退出，最后同事务发表归档状态与回执。准备提交回包丢失时，同键操作在业务锁内核验指纹、固定身份、原分支下一代及关闭状态，继续同一次关闭，不重复推进代际。

恢复在原 Task 事务中保留固定目录、附加目录权限及沙箱范围，推进授权和分支后重新开放后续明确操作；同时更新持久 Goal 的 Task 分支与修订，原 SSE 发送新的 Goal 观察值。Goal 的正文、预算、计量、状态和历史保持，不自动发起 Run；用户通过原恢复入口携带当前 Task、Goal 观察值和 `baseRevision` 明确继续。关闭期间失败不能报告恢复完成。页面批次只处理确认时固定的身份集合，取消删除不发送删除请求；后续归档或搜索变化不能扩大确认范围。

`deleteArchivedTask` 在同一 Task 业务锁内核对当前归档及观察分支，再经原资源关闭和删除服务执行；已恢复、已删除或不存在返回 `false`，界面按跳过计数。成功删除后原 Task、事件、输出和命令回执按现有规则清理；命令墓碑清除参数指纹及回执内容，归档／恢复迟到请求返回 404，实例物理删除时级联清除。归档或恢复的完成通知只触发目录重读，不切换当前 Task 或内容标签。

## 文档资源变更

独立 `canvas.document.updated` 帧包含 `projectId`、`canvasId`、`deleted` 及可选真实 SHA-256 `revision`。它由文件变更和后台发布经 PostgreSQL 通知传递到实例 WS 与原宿主 SSE，不伪造 Agent Run 事件。宿主 SSE 的 `canvasDocumentUpdated` 通知投影为文档更新/删除事件，空文档列表也能收到更新。

画布编辑器在 `canvas.resume` ACK 后读取权威文档；重连与重复通知同样重新读取实际版本，保留视口、选区及尚未保存编辑。更新不改变内容标签焦点；删除关闭对应标签、清理引用并拒绝迟到桥接消息。通知是失效提示，真实内容与 CAS 仍由文档服务校验。

## 第一方 Code Goal 控制扩展

`sendConversationCommandV4` 的 envelope 结构沿用原 V4，第一方 RPC 参数同级可携 `goalControl: { expectedGoal: {goalId, revision} | null, resumeModelSelection? }`，接口定义位于 `packages/shared/src/code-ui-contracts.ts`。订阅 Task 时独立 `onGoalControlState` 通知返回该 Task 已观察的目标身份与修订。宿主适配器未观察状态时拒绝发送 Goal 控制；替换请求在 Task 根锁内核验原目标，客户端未观察新目标时不能自动补用新状态。同命令重连保留最初观察值，缓存按 Task 区分；服务端既有命令幂等域不变。

Goal 续跑与默认恢复消费持久的无密钥模型调用快照并核验供应商修订。显式重新选择由第一方参数 `goalControl.resumeModelSelection` 精确编译，不把失效选择换成默认模型。原 UI 恢复使用冻结值；供应商修订变化会给出可读拒绝。


## Flow 事件代际与续传

Flow 事件携带 `hostProjectId` 与 `hostGeneration`。宿主只广播并缓存当前代际且未排空项目的事件；`flow.resume` 重放前再次校验代际，旧代际、排空或不完整作用域的事件不进入当前流。续传 ACK 通过 `requestId` 对应原命令。
