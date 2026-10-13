# ZCode 3.15.1 界面更新源码分析

核查日期：2026-10-13。范围：原 UI、交互装配及移植影响；本次没有修改运行源码或升级宿主。

## 核查基线与结论

- 比较旧基线 **3.14.3 / `29628c9acdb81b703bbd4080c207a0e7ce5e276e`** 与本地参考仓库 **3.15.1 / `aac4755666d09fdcd70272fcf063c077a639015f`**。版本提交：[上游提交](https://github.com/zai-org/ZCode/commit/aac4755666d09fdcd70272fcf063c077a639015f)。两个版本的 UI 均在 `packages/ui/src`，不能用删除/新增文件量直接认定界面重写。
- 主研究线程联网核实：本地参考仓库 HEAD 与 `git ls-remote` 上游 HEAD 一致；源码版本是 3.15.1，但 GitHub `releases/latest` 仍为 **3.14.3（2026-09-24）**，`releases/tags/v3.15.1` 返回 404。因此这里称“3.15.1 源码”，不称“已发布的 3.15.1 正式 Release”。本项目移植清单仍固定旧基线。
- **有实质 UI 功能更新，但不是全套聊天界面换皮。** 最明显的是工具交互 UI/生成 UI、长命令展开、MCP 进度、移动远控、工作流补全与高速卡。子代理目录和 Markdown 核心没有新的外观重写证据。
- “新增组件文件”不等于“已接入产品”：本次特意追查消费路径，下文列出未发现装配调用的组件，不把它们当成可见功能。

## 已有实际装配的变化

### 1. 新增：插件交互 UI，进入原工具流与右侧栏

`resolveRenderer` 新增 `PluginUi.shouldRenderPluginUi` 分支。`SessionPane` 增加 `PluginUiSessionProvider`；右栏 `AnimatedSidePanePanel` 在两个入口装配 `PluginUiLauncherItems`。工具卡可以固定/收起、打开右栏，具有加载、错误、重试状态；在侧栏已打开时工具流显示打开状态。插件 launcher 绑定正式 `sessionId`，草稿态明确不显示，并以 `pluginId/surfaceId` 区分。

证据：[原 renderer 注册](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/ToolCallBlocks/resolveRenderer.ts:125)、[会话 provider](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/v4/SessionPane.tsx:5418)、[右栏装配](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/app-shell/AnimatedSidePanePanel.tsx:779)、[工具卡](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/plugin-ui/components/PluginUiToolCallBlock.tsx:8)、[入口规则](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/plugin-ui/components/PluginUiLauncherItems.tsx:30)。以上本地路径展开根为 `/Users/shigaoyu/Develop/KenKenDev/KenFutWork/`。

移植影响：这是原 ZCode 新增的会话级工具 UI 承载，不等同于 KenFutWork 已有的实例插件侧栏贡献。应移植完整装配和宿主接口，不能把原工具卡重新手写或以通用文本替代。MCP Apps 的原契约已有服务消费（主研究线程追查 `zcodeAgent.ts:675/689`、`zcodeAgentService.ts:4393`、`node.ts:1539/2616`），仅复制组件不足以接通。

### 2. 新增：助手正文中的 Gen UI 卡片

原 `ConversationRowView` 把助手文本包装由 `MessageResponse` 换成 `GenUiMessageResponse`。新包装解析生成 UI 引用，普通文本继续交给原 Markdown；UI 段渲染 `GenUiCard`，未完成/无效引用显示对应状态。卡片支持预览放大、复制、调整及提交前确认，并有 unsupported/offline/error/loading 状态。用户行新增 `genUi` / `pluginUi` 来源，插件 UI 上下文以 chip 呈现。

证据：[真实正文消费](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/v4/ConversationRowView.tsx:1700)、[引用分段](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/gen-ui/components/GenUiMessageResponse.tsx:6)、[卡片与状态](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/gen-ui/components/GenUiCard.tsx:49)、[用户来源](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/v4/ConversationRowView.tsx:1396)。

移植影响：新的 UI service/page 生命周期必须跟随移植，仍复用原 Markdown，不能替换成全新的消息 renderer。文件变更摘要还会根据助手文本排除 Gen UI 源文件，避免把其内部文件当作普通产物；[摘要过滤](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/v4/ConversationFileSummaryPanel.tsx:78)。

### 3. 改进：终端工具的长命令可展开

旧 `execute.tsx` 的命令区域限高截断，没有完整阅读入口；新版真实调用新增 `ExecuteCommand`。默认显示三行，溢出时提供展开/收起，展开区可滚动至十行高度；使用 `ResizeObserver` 按实际高度判断溢出，展开切换重置滚动位置。

证据：[组件](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/ToolCallBlocks/renderers/ExecuteCommand.tsx:7)、[原工具消费](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/ToolCallBlocks/renderers/execute.tsx:1)。`ExecuteOutput.tsx` 在该比较范围没有 diff，不应声称整套终端结果 UI 重做。

移植影响：适合直接取原代码并沿原 execute 装配升级，不需要新增终端 backend；原真实输入/输出契约仍需宿主提供。

### 4. 新增：MCP 工具运行进度

MCP renderer 仅在 `in_progress` 且存在合法 `raw.progress` 时显示进度条；`fraction` 存在时确定宽度，否则不定进度动画，可附消息。失败/停止等终态仍走原状态分支。

证据：[运行中消费](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/ToolCallBlocks/renderers/mcp.tsx:184)、[进度 UI](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/ToolCallBlocks/ToolCallProgressIndicator.tsx:18)。

移植影响：UI 值来自 v4 `ToolProgress` 契约和行适配，不应合成假的进度。没有进度事件的现有后端保持原状态展示。

### 5. 改进：文本材料预览与消息来源

新增 `topic-history` / `clipboard-text` 文本材料打开路径：按附件引用读取 bytes，用 `TextDecoder` 展示在原附件预览对话框中，支持取消前一请求、加载及错误态。自动化来源标识也接受合法的手动运行 runId，而非仅 schedule runId；群输入/群投递在用户和助手行中装配独立来源及操作组件。

证据：[文本附件读取](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/v4/ConversationRowView.tsx:344)、[点击消费](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/v4/ConversationRowView.tsx:795)、[群投递操作](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/v4/ConversationRowView.tsx:1647)。

移植影响：扩展现有附件读取边界、保留真实错误。群业务/云投递在本产品未接入时不能随源码更新自动开放。

### 6. 改进：MCP 与技能设置的插件资源呈现

MCP 页插件行改为插件头像，连接状态点放在图标角落；显式展示连接错误，OAuth URL 存在时提供授权按钮；状态刷新新增工作区身份核查、刷新队列和 OAuth 返回后的刷新协调。技能页从插件管理库存投影作用域，插件技能使用原市场头像，并有真实详情对话框。远控模式同步入口按真实连接上下文过滤。

证据：[MCP 行图标/授权](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/settings/McpSettingsSection.tsx:538)、[作用域过滤](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/settings/McpSettingsSection.tsx:1317)、[OAuth 返回刷新](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/settings/McpSettingsSection.tsx:1237)、[技能插件头像](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/settings/SkillsSection.tsx:657)、[技能详情](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/settings/SkillsSection.tsx:980)。

移植影响：应结合既有实例/项目作用域适配，不能直接沿用上游 workspace 语义恢复第二套配置。MCP OAuth/同步是否可用取决于真实服务。

### 7. 改进：市场来源文字与非正常安装记录

市场卡原有安装行为保留，新增处理“有安装记录但无运行时 info”情况；来源函数把 cache 解释为来自市场、其他来源解释为内置，默认市场名称使用 Claude Code 插件标签。市场详情主体仅增加函数导出和注释，不能据此宣称市场整体视觉改版。

证据：[市场卡](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/settings/PluginStoreCard.tsx:88)、[来源规则](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/settings/pluginSourceLabel.ts:30)、[详情原布局](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/settings/PluginStoreDetailView.tsx:128)。

另新增 `InstalledPluginManagement` 详情/面板源码，可呈现配置控件、组件分组、诊断、连接与更新/卸载等信息；但未找到外部装配，不能算启用的新页面。`PluginStorePage` 的新增逻辑主要是营销导航请求定位市场/详情和远控参数传递，而非市场布局重写。

移植影响：上游来源规则与本项目已确认的“公开/本机”和可信官方发行清单不一致；升级时保留 KenFutWork 的权威来源适配，不能把用户本机来源一律标内置。

### 8. 新增/改进：移动远控紧凑壳及输入

`WorkspaceShellLayout` 实际装配 `WebRemoteControlMobileShell`；主/子 `SessionPane` 增加 `compactForRemoteControl`，原右栏子会话转入移动 overlay 时传递该参数；移动下助手操作常显、部分目录/分享操作受限。Lexical 新增 16px 输入字号选项用于避免 iOS 聚焦缩放；模型菜单根据可用宽度限界。

证据：[移动壳](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/app-shell/WorkspaceShellLayout.tsx:2074)、[子会话传参](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/app-shell/SubagentSessionSidePane.tsx:50)、[移动右栏](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/app-shell/AnimatedSidePanePanel.tsx:1160)、[Lexical](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/LexicalChatInput.tsx:1458)、[移动菜单](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/v4/composer/V4ComposerToolbar.tsx:1102)。

移植影响：真实 relay/remote transport 是前提。本期本机桌面优先的产品边界下可以保留源码，不应仅因新组件存在展示未接通远控入口。

### 9. 新增：高速卡与动态工作流 UI

输入工具栏真实装配 Highspeed 模型指示器/倒计时，卡片生效期间锁定模型；整轮增加高速输出页脚、满足耗时/收益条件才提供分享。工作流时间线增加 holes/fills，能显示补全生长及进入补全详情，并扩展设置/保存控件。无用户气泡的工作流通知轮去掉原固定顶空白。

证据：[输入模型指示器](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/v4/composer/V4ComposerToolbar.tsx:1102)、[倒计时](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/v4/composer/V4ComposerToolbar.tsx:1164)、[输出页脚](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/v4/ConversationTurnGroup.tsx:1715)、[时间线补全](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/components/workflow-timeline/WorkflowTimeline.tsx:348)、[轮间空白](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/v4/ConversationTurnGroup.tsx:1488)。

移植影响：上游动态工作流不等于本仓 Flow 子系统；Highspeed、账号/套餐、营销等服务也不在本期本机 BYOK 边界，不能机械开放。可以移植消息链中的通用修正，能力入口须按真实服务过滤。

### 10. 改进：侧栏可见性修复

grouped 列表现在保留全局 pinned 区，避免置顶后任务从主体消失；归档也保留 pinned。侧栏恢复搜索按钮，但明确调用 `onOpenCommandCenter`，不是新增 TaskSearchDialog 的查询链路。

证据：[置顶区](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/WorkspaceSidebar.tsx:678)、[搜索入口](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/WorkspaceSidebar.tsx:1503)、[搜索装配说明](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/WorkspaceSidebar.tsx:1513)、[归档置顶](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/WorkspaceSidebar.tsx:1586)。

## 没有证据支持“全新外观”的部分

- **Markdown 核心无 diff**：`components/ai-elements/message.tsx`、`reasoning.tsx` 在两提交间相同。依然由原 Streamdown 处理，正文 `animated={false}`；变化是上层 GenUi 分段包装，不是换 Markdown 引擎。[原 Markdown 入口](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/components/ai-elements/message.tsx:1620)。新增 `packages/stream-animate` 不能视为聊天已换动画引擎；本次未发现其被原聊天组件 import。
- **子代理目录没有重设计**：`SubagentDirectorySidePane.tsx` 仅函数 export 和格式变化；子详情仅增加移动参数，依然共用原 SessionPane。[目录](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/app-shell/SubagentDirectorySidePane.tsx:32)、[子详情](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/app-shell/SubagentSessionSidePane.tsx:47)。Agent 行有实质标签适配：接受 Codex nickname、`spawn_agent` 和 `agent_type`。[标签读取](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/ToolCallBlocks/renderers/agentHelpers.ts:94)。
- **子定义设置页没有新增编辑器外观**：`SubagentsSection.tsx` 的 diff 主要 export/格式；运行定义缓存/watcher 是运行行为更新。主线程已确认 `services/subagents/subagentRuntimeConfig.ts`、`subagentConfigScope.ts` 新增，`subagentsService.ts:560/592` 真正消费；父轮冻结定义、运行 child 不刷新。移植这部分需要服务接线，不能靠更新设置组件实现。
- **存在新增但未发现装配的组件**：`TaskSearchDialog.tsx`、`WindowsCaptionMenuButton.tsx`、`chat-input-toolbar/ChatModeSwitchControl.tsx`、`PluginStoreEnabledSwitch` 和 `InstalledPluginDetailDialog` 的源码存在，但本次对当前 `packages` 非测试源码检索，没有发现其真实组件调用（详情 dialog 内部调用 panel 不算外部装配）。不要宣称新任务搜索弹窗、Windows 菜单、全新聊天模式或者新的市场开关已在主产品界面启用。[搜索源码](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/TaskSearchDialog.tsx:83)、[标题栏源码](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/WindowsCaptionMenuButton.tsx:34)、[模式控件](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/chat-input-toolbar/ChatModeSwitchControl.tsx:7)、[启停控件](/Users/shigaoyu/Develop/KenKenDev/KenFutWork/references/zcode/packages/ui/src/settings/PluginStoreCard.tsx:88)。

## 升级建议与验收边界

1. 优先移植可以独立验收的原 UI 改进：长命令展开、真实 MCP 进度、插件资源头像、文本材料预览、侧栏置顶/空白修复；保留原装配，不手写仿制。
2. 将 Plugin UI / Gen UI 作为完整 feature 切片：原组件、协议、projection、page transport、资源和生命周期一起核查，按现有服务扩展点适配；不直接引入另一套插件后端。
3. 更新源码清单、版权/校验和及逐项宿主偏差；本仓融合壳下 Design/Flow 常驻主区与持久 Task 工作域不变量不能被上游 shell 覆盖。
4. 对每项做实际桌面交互/截图，尤其长命令、流式转静态、右栏打开/关闭、刷新恢复、明暗主题、并发子代理与取消。本文是源码研究，不是视觉验收，也没有运行新版本。

复核方式：`git -C references/zcode diff 29628c9acdb81b703bbd4080c207a0e7ce5e276e aac4755666d09fdcd70272fcf063c077a639015f -- packages/ui/src`；逐项查真实消费调用。没有把测试、生成资源和依赖大批量变更当作产品功能新增。
