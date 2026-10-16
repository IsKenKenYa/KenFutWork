# Code 与 Design 共享 Harness 对标核验

> **角色：调研快照**。核验日期：2026-10-16（北京时间）。本文提供公开证据与验收建议，不新增架构决策，不代表 KenFutWork 已通过对应验收。
> **目标属主**：[Code 工作域与工具内核实施规格](../方案设计/Code工作域与工具内核实施规格.md)「Code/Design 统一实施」；生命周期与 Goal 见 [Harness 稳定性与 Goal 实施规格](../方案设计/Harness稳定性与Goal实施规格.md)。本文不复述工具契约、ctx key 表或 API schema。
> **本轮范围**：同一本地实例内多标签页、Agent 修改、媒体回填与重启恢复；暂不增加多人实时协作。共享 Harness，Code/Design 可以贡献不同工具；已有项目隔离、显式共享、Run 冻结与内容标签约定保持有效。

## 1. 结论与证据口径

**工程判断：当前方向有足够的一手参照，不需要先换一条 Agent loop。** Code 侧优先核对持久会话、逐轮执行身份、审批与未知副作用恢复；Design 侧优先核对可见资源引用、生成产物与画布编辑并存、会话和文档分别持久化。一个共享 Task 宿主可以承接这两类工作，由模式插件贡献上下文和工具。

公开材料主要证明**产品暴露的行为与接口**。它们没有公开证明 TapNow、LibTV 或 Lovart 使用何种数据库、同步算法、重试队列、冲突合并或 exactly-once 协议；本文不据界面效果反推这些实现事实。

| 标记 | 本文含义 |
| --- | --- |
| 公开事实 | 本轮实际打开的官方帮助文档、官方协议，或只读核对的固定上游源码 |
| 工程判断 | 从事实提出的实现或验收建议；不声称竞品内部采用相同方案 |
| 未确认 | 未取得能支持该结论的一手证据，或产品指代尚有歧义 |

产品名按以下边界使用：

- 用户所称 CodeX 按 OpenAI **Codex** 核验；ZCode 为 `zai-org/ZCode`；DeepSeek Harness 为 `deepseek-ai/deepseek-harness`。
- 用户所称 **liblibTV** 暂以官方 **LibTV** 为候选对象。LibTV 官网使用“LibTV 画布 / LibTV Agent BETA”名称；不能仅凭用户拼写，把 LiblibAI 的 WebUI/ComfyUI 功能算作 LibTV 画布的已确认行为。[LibTV 官网](https://www.liblib.tv/)
- TapNow 官方文档当前以 **Creative OS** 为产品表述；本轮使用其官方帮助域名。Lovart 使用 `lovart.ai/docs` 的帮助文档，未把第三方 clone 仓库作为产品证据。[TapNow 文档](https://docs.tapnow.media/en/docs)、[Lovart 文档](https://www.lovart.ai/docs/getting-started/how-lovart-works)

## 2. Code 侧：会话、执行与审批

### Codex

**公开事实**：App Server 将 thread 与 turn 分开；`thread/resume` 打开已保存的 thread，后续 `turn/start` 在同一 thread 追加执行。分支产生新的 thread ID。命令与文件审批是服务端请求，携带 thread、turn、item 身份；客户端回复后，由服务端发布审批解决与 item 完成状态。[OpenAI 官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)

**对当前目标的判断**：会话/Task 是持久容器，一次 Run 是其中一次执行；切换右侧视图不应改写正在执行的身份。审批卡不能只保存按钮状态，必须关联真实 Run 与工具调用。这里支持的是身份与生命周期分层；**Code/Design 跨模式、Run 冻结哪些字段、项目默认隔离**仍是 KenFutWork 已确认的产品约定，不能写成 Codex 原有双模式能力。

### ZCode

**公开事实**：本地参考树为 `aac4755666d09fdcd70272fcf063c077a639015f`，本轮只读核对且工作树无改动。恢复路径按同一 session 读取持久消息与目录、重建运行上下文；权限等待进入 turn 状态机，由工具调用 ID 关联待审批与解决记录。子会话详情真实复用 `SessionPane`，传入 child/root session 身份和文件、浏览器等打开回调。[固定版本恢复源码](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/core/src/runtime/methods/resume.ts#L61-L145)、[权限状态机](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/core/src/agent/turn-machine.ts#L238-L273)、[子会话详情装配](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/packages/ui/src/app-shell/SubagentSessionSidePane.tsx#L41-L66)

**对当前目标的判断**：复用原 `SessionPane` 时，应保留 provider、事件投影、审批、恢复与宿主打开回调，不能只复用消息 JSX。源码中存在“打开浏览器/文件”的回调不等于已经证明“任何发送/审批都不切内容标签”；后者应由 KenFutWork 的真实宿主操作回归和桌面观察锁定。固定源码比较详见 [ZCode UI 更新分析](ZCode-3.15.1界面更新源码分析.md)。

### Claude Code

**公开事实**：官方文档区分继续最近会话与选择旧会话。恢复包含历史及工具调用/结果；前进程退出时尚未记录结果的工具不会默认重跑，应先核对副作用。恢复哪些模型、agent、权限模式和目录配置有明确条件，并非所有启动参数都会保留。[官方会话文档](https://code.claude.com/docs/en/sessions)

**公开事实**：内置权限规则由运行时执行，基本顺序为 deny、ask、allow；提示词与 `CLAUDE.md` 不能自行授予权限。目录授权与 OS 沙箱是不同边界，不能仅凭工具提示或配置名称推断系统隔离。[官方权限文档](https://code.claude.com/docs/en/permissions)

**对当前目标的判断**：共享会话不等于共享全部能力或目录权限。Code/Design 的工具曝光可以不同，执行时仍要复核有效作用域、授权代际与角色；恢复 UI 状态不能把已撤销权限复活。

### DeepSeek Harness

**公开事实**：官方架构将模型适配、工具、session log、loop 与 UI 分为可替换插件；持久 session 事实与实时 agent 事件分开，通用 profiles 复用基础能力。[官方架构](https://deepseek-harness.github.io/deepseek-harness/en/reference/)

**固定源码事实**：本地参考提交 `d743267388641bc76f17c45ce8b4c231aed1d32c` 的持久化契约将 `flush` 定义为耐久性屏障。恢复将“请求存在但调用未耐久记录”与“调用已记录但结果未知”分开，后者标记 `TOOL_OUTCOME_UNKNOWN`，要求验证副作用或询问，不能盲重试。[固定版本持久化契约](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/session/session-persistence/README.md#L12-L57)、[恢复语义](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/session/session-persistence/README.md#L125-L137)

**对当前目标的判断**：共享 Harness 加模式工具贡献符合这类能力分层。生成 API、命令或文件写入的“结果未知”必须独立于“失败”；日志可恢复不自动等于外部副作用恰好一次。无需为 Design 新建第二套循环、审批或恢复入口。

## 3. Design 侧：画布上下文、生成与历史

### TapNow / Creative OS

**公开事实**：画布承载上传材料、文本、Agent 生成结果；可以选一个或多个节点交给 Agent，生成新结果时保留来源节点。连接显示来源关系，但帮助文档仍要求在生成前核对实际引用材料。[官方画布说明](https://docs.tapnow.media/en/docs/canvas/explore-the-canvas)

**公开事实**：`Insert from canvas` 可将已选图片优先加入输入上下文；`@` 可显式区分产品图与风格参考。输入上方显示引用，发送前可增删。其会话模型在首条消息后锁定，这是 TapNow 的产品选择，**不作为本项目改动当前模型策略的理由**。[官方 Agent 对话说明](https://docs.tapnow.media/en/docs/agent/chat-with-agent)

**公开事实**：一个画布可重开不同对话或分支；新对话不删除同一画布里的节点与文件。Agent 忙时可以继续整理画布并排队后续指令。由此能确认“对话执行期间，画布仍可编辑”，不能由此确认后台并发保存算法。[官方会话管理](https://docs.tapnow.media/en/docs/agent/manage-conversations)

**公开事实**：生成图像/视频/音频通常落为画布节点；简报、剧本、表格和交互页面可作为当前画布的独立输出，选择后打开或再加入画布。生成 History 能重新应用产物，但**不是整个画布的版本快照**。[官方输出管理](https://docs.tapnow.media/en/docs/agent/manage-agent-outputs)、[官方 History 说明](https://docs.tapnow.ai/en/docs/canvas/organize-your-canvas)

**对当前目标的判断**：当前画布引用、显式选区与生成结果应有独立、可核对的资源身份；不能依赖“界面现在显示哪个画布”推断某个运行的目标。媒体完成、生成历史和文档版本是三类事实；媒体迟到只补对应结果，不应回写一份过期整图或清空当前编辑。

### Lovart

**公开事实**：上传到对话的图片/视频/PDF 用于 Agent 上下文，与“Add to Canvas”不同。Assets Library 提供可复用素材；Brand Kit 可按一次生成显式引用，也可应用到项目，后续生成使用更新后的套件。[官方引用与品牌说明](https://www.lovart.ai/docs/how-to-prompt/adding-references)

**公开事实**：`@` 可指定模型、品牌套件或画布元素；模型设置中的偏好与 `@` 的严格指定并不相同。直接图/视频生成器绕过 Agent，参数面板只显示所选模型支持的选项，完成后落画布。[官方 Chat Tools](https://www.lovart.ai/docs/how-to-prompt/chat-tools)、[官方模型选择与生成器](https://www.lovart.ai/docs/how-to-prompt/selecting-ai-models)

**公开事实**：项目内有 Chat History；Generated Files 单独列出 Agent 产物及下载操作，Layer 面板列出项目对象与历史。因此对话记录与产物索引并非一个列表。[官方 Chat History](https://www.lovart.ai/docs/how-to-prompt/chat-tools#chat-history)、[官方画布与产物面板](https://www.lovart.ai/docs/edit-your-design/customize-your-canvas)

**对当前目标的判断**：Design 插件可以给共享 Harness 注入选区、品牌与生成偏好；不应把“默认偏好”“这次指定”“工具实际采用值”混成同一个字段。供应商参数、媒体任务与回调仍消费本项目权威契约。Lovart 的跨项目素材库不推翻本项目“跨项目资源显式授权”，其品牌套件更新行为也不能证明其内部实现了 Run 级内容快照。

### LibTV 候选对象及证据限制

**公开事实**：本轮打开的官网公开页面可确认 LibTV 画布、Agent BETA、项目、资产、插件以及图/视频/音频生成入口。[LibTV 官网](https://www.liblib.tv/)

**未确认**：本轮没有取得能公开核对的详细帮助文档或源码来证明其审批恢复、跨会话画布上下文、生成幂等、自动保存、冲突合并或重启恢复语义。官网社区作品不是这些行为的一手技术证据；不据此为 KenFutWork 增加剧情生产、3D、多人协作或工作流节点系统。

## 4. Excalidraw 官方 API 对同步实现的约束

以下是编辑器集成接口事实，不是 TapNow/Lovart 的内部实现：

| 官方事实 | 对本轮的工程含义 |
| --- | --- |
| `onChange` 接收 `elements`、`appState`、`files`；文档示例将持久化交给宿主 | 回调不是“只发生了本地内容修改”的证明。宿主必须区分文档内容、视口/选区、外部应用与媒体回填，保存成功的确认范围也由宿主持有。[Props / onChange](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/props/#onchange) |
| `captureUpdate` 控制 Store/history 捕获；`IMMEDIATELY` 用于通常的本地可撤销更新，`NEVER` 用于不进入撤销栈的远端更新或初始化 | **`NEVER` 不是关闭 `onChange`、停止保存或确认持久化的开关。** 对 Agent 显式编辑如何组成可撤销动作按现有编辑语义处理；服务端确认或媒体水合不应变成用户一次 Undo 的错误目标。[API / captureUpdate](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/props/excalidraw-api#captureupdate) |
| `addFiles` 在现有文件缓存上加入文件；`getSceneElements` 排除删除元素，另有 `getSceneElementsIncludingDeleted` | 媒体文件补齐与场景元素替换是不同动作。删除墓碑、迟到结果与恢复策略需要显式处理，不能只以“当前元素数组中找不到”判定从未存在。[API / addFiles 与 scene getters](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/props/excalidraw-api#addfiles) |

**责任边界**：这些 API 没有承诺后端 revision、跨标签单写者、outbox、迟到保存确认、生成去重或崩溃恢复。采用何种已有机制应由当前代码与回归证据决定；本轮不因使用 Excalidraw 而引入多人 CRDT 或重写持久化架构。

## 5. 本目标可直接采用的五组验收条件

以下是**KenFutWork 验收建议**，来源是已确认规格，公开对标仅解释其价值。没有执行结果时不得标记完成。

| 优先 | 场景与操作 | 可观察结果 |
| --- | --- | --- |
| 1 | 同一 Task 依次在 Code/Design 发送；运行中切模式、切画布、改下一次模型偏好；撤销目录或文档授权后送到工具执行门 | 历史与 Goal 属同一持久 Task；每个 Run 按接纳时冻结的工作方式、能力、资源、模型及代际执行；当前界面不篡改旧 Run，撤销后拒绝越权；选择画布不增加文件目录权限 |
| 2 | 工具等待审批时刷新/重连/重启；重复提交审批答案；外部生成提交后在结果记录前终止进程 | 卡片与后端保持同一 Task/Run/调用身份；旧代际或已结算回执不再执行；未知副作用有可读状态并可核对真实任务，不自动重发一次付费生成或命令 |
| 3 | 打开画布并保留视口/选区；发送、审批、恢复、Goal 续轮、媒体完成；随后显式打开文件或浏览器 | 前一组后台动作不抢占内容标签、不重建当前画布；只有用户显式打开/切换动作改变活动标签。会话仍使用原 SessionPane 与真实宿主协议 |
| 4 | Design 发送当前画布可移除引用、指定选区/品牌/媒体模型；Agent 进行图或视频生成，同时用户切至另一画布并编辑 | 工具能核对本次资源身份与当前权限；结果落冻结目标，不借用新界面选区。原材料保留，参数遵守实际模型能力；生成任务、素材与落图身份可追踪。品牌冻结边界遵守现行规格，不把套件 ID 冻结悄悄扩为全部资产内容快照 |
| 5 | 两标签页交错编辑；保存 A 在途时修改并反向改回；Agent 修改与媒体回填交错；删除后迟到结果；断线重连/重启后重放同一生成事实 | 已确认保存只确认其覆盖前缀；新编辑及反向修改不被旧响应覆盖。删除不因迟到水合而复活；同一生成事实不重复落图；媒体缓存补齐保留当前布局与 appState。持久内容最终可恢复，并分别记录自动化、真实 PG、GUI 与模型端到端证据 |

这些条件不要求新增完整产物管理页、跨项目素材市场、多人协作、Office 或 Flow 工作流编辑；它们都不属于当前已确认增量。

## 6. 待 grilling 与本轮未核验项

无人值守期间只记录，不阻塞已授权工作：

| 问题 | 推荐答案 | 当前处理 |
| --- | --- | --- |
| “liblibTV”是否确指 `liblib.tv` 的 LibTV，还是另有指定产品/帮助入口？ | 按 LibTV 作为对标对象；若用户提供不同入口，再更正名称与证据 | 暂作候选；只引用已打开官网能支持的事实，不以 LiblibAI 功能补齐空白 |
| “Jev”指哪一个决策模型及协议，未来审批应如何选模型与预算？ | 沿既有 BYOK 模型与插件贡献提供审批决策适配，默认仍走现有人工审批；具体模型待提供权威标识后接入 | 已把“帮我批准”的身份绑定、权限上限与失败回人工边界写入工作域规格；本轮不猜测型号或做假开关 |
| 第二组是否长期保留五种入口，计划是否只留一个入口？ | 权限与规划独立；执行策略有真实消费。“目标”复用持久 Goal，“创造”明确为扩展创作；布局合并待用户决定 | 先修冻结、禁工具、Goal 路由和联动状态，不因布局待决阻塞已授权修复 |

本轮没有登录上述商业平台、创建项目、发送消息、调用生成 API 或测试其网络/进程故障恢复；未执行同模型同预算基准。公开文档与固定上游源码核验不能替代本项目实际门禁、临时真实 PG、`pnpm desktop` 及既有 GLM / 已配置真实图视频链路验收。

## 7. 与既有调研的关系

- [DeepAgents 与开源 Coding Agent 对比](09-DeepAgents与开源CodingAgent对比.md)：负责运行时、执行环境、模型适配与候选比较；本文不改变其选型。
- [ZCode 目标核对](10-目标与完成判定源码核对.md#zcode)与 [Codex 目标核对](10-目标与完成判定源码核对.md#codex)：负责目标状态和完成判定的固定源码；本文不以页面文案替代真实完成证据。
- 本文只补充本轮 Code/Design 对标的公开行为、Excalidraw 集成边界与现行目标验收映射；实施回执仍归权威规格和日志。
