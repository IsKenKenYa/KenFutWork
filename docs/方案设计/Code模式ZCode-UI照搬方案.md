# Code 模式 UI 全量照搬 ZCode 方案

> **角色：方案稿**。本文是 Code 模式对话 UI 全量照搬 `references/zcode/`（Apache-2.0，`packages/ui`）的差异分析与实施蓝图。
> 背景：2026-09-28/29 已做过一轮「zcode 式」部分改造（`apps/web/src/components/workbench/zcode/` 4 个文件，共约 1k 行），但只是骨架级参照。本轮目标（用户口径）：**完全照搬 ZCode 的 Code 模式 UI，不留自己的实现**；数据侧我们基于 DeepAgents 的事件模型经适配层接入，「一切皆插件」理念不变。
> 许可证：zcode 为 Apache-2.0（`references/zcode/LICENSE`），照搬 UI 代码需保留版权声明并在 NOTICE 中 attribution。

## 1. ZCode UI 架构要点（照搬对象）

ZCode 的对话 UI 全部在 `references/zcode/packages/ui/src/`，Electron 与 Web 共用。与本方案相关的四层：

1. **设计系统层**（`styles.css` + `DESIGN.md`）：CSS 变量语义 token（`--color-surface/-subtle/-subtlest/--color-diff-added` 等，4 套主题）、`text-ui-*` 字号阶（以 `--ui-font-size: 14px` 为基准 calc 派生，禁用 Tailwind `text-sm/xs`）、嵌套圆角层级（`rounded-xl → lg → md → sm`，`rounded-2xl` 只给主输入壳/浮动状态面板/toast）、全套动画（`animated-gradient-text` 运行态流光、`data-zcode-stream-animate` 流式淡入等）、全局滚动条样式。
2. **markdown 层**：`streamdown` 2.5 + `@streamdown/cjk|code|math|mermaid`；入口 `components/ai-elements/message.tsx`（约 1700 行，`MessageResponse`）+ `code-block.tsx`（自研代码块：头部语言标签/复制/换行按钮，流式期间关高亮）+ `markdown-{blockquote,list,table,image}.tsx` + `reasoning.tsx`（思考折叠行：静态 Brain 图标、流光「思考中」、流式单行摘要、吸底跟随、滚动渐隐 mask）。
3. **工具调用层**：`ToolCallBlocks.tsx`（递归树，嵌套容器 `ml-2 space-y-2 border-l pl-3.5`）+ `ToolLayout.tsx`（通用折叠卡：模块级 Map 持久展开态、300ms 延迟卸载、运行态 kindLabel 流光、失败态 dotted 下划线 + tooltip 复制）+ `ToolSummaryRow.tsx`（单行摘要：icon → kindLabel → kindDetail → sourceLabel 徽章 → primary/secondary/diffCount/status → hover 才显现的 chevron）+ `renderers/`（edit/execute/read/search/todo/ask-question/agent/explore/fallback/mcp/skill 等十余种）。inline diff 用自研 `lightweight-diff-preview.tsx`（标记位染色 + 左侧 inset 色条 + 可选行号，无 `+/-` 字形）+ shiki 异步着色包装。
4. **数据模型层**：v4 协议 `ConversationRow`（9 个 variant：turnHeader/userInput/assistantText/reasoning/toolCall/artifact/subagent/hookInvocation/timelineMarker），**事件→行投影在服务端（CLI）完成**，客户端只做 5 操作 delta 归约（appended/upserted/removed/delta/state.updated）。**但渲染层组件实际消费的是 legacy 形状** `TaskChatToolCallTreeNode = { toolCall: TaskChatToolCall, childToolCalls: [...] }`（`lib/toolCallTree.ts`、`lib/taskChatMessageTypes.ts`），由 `v4/toolCallRowAdapter.ts` 纯函数转换——这正是我们的适配靶子。

其他关键件：composer 是 **Lexical** 富文本（`ChatPromptEditor.tsx` 纯展示壳 + `LexicalChatInput.tsx` 1531 行 + mention/slash 插件）；权限审批是 `PermissionDialog.tsx`（序号列表 + 数字键应答 + always-allow 文案归一，**无倒计时条**）；浮动状态面板 `ConversationStatusPanel.tsx`（Git +a/-r、todo、后台任务停止，rounded-2xl，不含 token/cost）；时间线 `@tanstack/react-virtual` 虚拟化 + live tail 移出虚拟列表；子代理在父对话只有单行摘要（运行中滚动显示最新子工具摘要），完整 transcript 走右侧 Side Pane（复用 SessionPane，`readOnly`）。

## 2. 现状差异分析（我们 vs ZCode）

现状盘点基于 `apps/web/src/components/workbench/workbench.tsx`（3887 行巨组件）+ `workbench/zcode/`（message-response 102 行 / reasoning 110 行 / tool-layout 372 行 / tool-renderers 445 行）。

| 区域 | 我们现状 | ZCode | 差距 |
| --- | --- | --- | --- |
| 设计 token | 自有语义 token（`bg-secondary` 等）+ 部分 `text-ui-*` | 完整 token 体系 + 强制 `text-ui-*` 字号阶 + 圆角层级纪律 | **缺**：token 全集、动画集、滚动条、字号纪律 |
| 用户消息 | `rounded-lg bg-secondary` 右气泡，纯文本 | `rounded-xl rounded-tr-xs border bg-surface`，容器查询限宽，hover 复制/编辑操作行，状态行 | 样式不同；无 hover 操作 |
| 助手 markdown | streamdown 裸配（github 双主题，仅覆盖 a/strong） | streamdown + CJK/math/mermaid 插件、自研 CodeBlock（头部/复制/换行）、链接右键菜单、标题/行内 code/表格/引用全定制、异常降级纯文本 | **大部分缺** |
| 思考行 | 简化版 Collapsible（Brain + 文案 + 展开纯文本） | + 流式单行摘要、自动收起、吸底跟随、滚动渐隐 | 部分缺 |
| 工具骨架 | ToolLayout/ToolSummaryRow 已仿（模块级展开态、流光、失败样式） | 同源 | **最接近**，缺 QueuedSummaryContent 摘要切换动画、sourceLabel 徽章 |
| Edit/Write | 展开 = 纯文本 `<pre>` diff | `LightweightDiffPreview`：行染色 + inset 色条 + 行号 + shiki 异步着色 + 截断行；多文件嵌套列表 | **差距大** |
| Execute | 展开 = pre 输出 max-h-60 | `$` 提示 + 命令卡 + `ScrollFadeViewport`（max-h-5lh、流式吸底/用户滚动冻结/回底恢复、无输出提示） | 中 |
| Read/Search | 单行不可展开（已一致） | 同，文件 chip 可点击开 code viewer | 小（chip 行为） |
| Todo | 单行「更新目标」 | 展开 checklist（完成 ✓ 删除线 / 进行 → / 待办 ○）+ N/M 计数 | 中 |
| AskUserQuestion | 无 renderer | 有（Q&A 对、完成后可折叠） | **缺** |
| Fallback | summary + JSON pre | kind 首字母大写 + 原始 JSON dump 卡（`rounded-xl bg-surface max-h-50`） | 小 |
| 子代理 | 父对话单行摘要 → 右栏面板线程视图（模式已一致） | 同模式，但运行中摘要行**滚动显示最新子工具摘要**（live ticker）、agent 名按 hash 着色、侧栏目录面板（running/ended 分组 + 状态图标映射） | 中 |
| Composer | textarea + CompactSelect 簇，rounded-xl | Lexical 富文本、rounded-2xl 壳（focus-within/拖拽态换边色）、动作菜单（+)、模式/CUA/后台任务入口、模型簇、发送/停止状态机（空草稿显 Stop）、附件卡、队列面板 | **差距大** |
| 权限审批 | 无对话内审批 UI（设置页事前档位） | PermissionDialog（序号选项 + 数字键 + 反馈行 + 底部确认） | **缺（需协议适配）** |
| 浮动状态面板 | 无（仅 ElapsedEntry + ContextUsageButton） | ConversationStatusPanel（todo/git/后台任务分区 + 停止按钮） | **缺** |
| 虚拟滚动 | 无（全量渲染） | react-virtual + 高度缓存 + live tail 分离 + 滚动锚定 | **缺** |
| 侧栏任务条目 | 自研 | TaskListItem（状态槽 error>unread>loading>idle、hover 动作组、标题 mask 渐隐） | 中 |
| 文案 | 自造中文 | i18n key 体系（zh-CN 文案已抓表） | 照搬 zh-CN 文案 |

## 3. 照搬边界与适配决策

**原则：UI 组件逐文件照搬（视觉/交互/文案一致），数据与宿主能力经适配层接入，DeepAgents 特性与插件理念不动。**

| 决策点 | 结论 | 理由 |
| --- | --- | --- |
| 移植落点 | `apps/web/src/components/workbench/zcode/` 整体替换为照端口；视觉原语（button/tooltip/badge 等）照搬到 `apps/web/src/components/ui/` 缺啥补啥 | 不动 packages/ui（避免影响 Design 模式） |
| 原语库 radix → 照搬 radix | ~~替换为 Base UI~~ 改为**新增 `radix-ui` 依赖并逐文件照搬 zcode 的 `components/ui/` 原语**（P0.5 已落地，含 `@pierre/diffs@1.1.22` 精确钉版——1.5.x API 已变） | Base UI 的 Collapsible 不提供 `--radix-collapsible-content-height` 等 CSS 锚点且部件 API 不同，换成 Base UI 等于重写而非照搬；两库并存仅限 Code 模式对话区 |
| i18n | 不搬 intl 体系；`intl.formatMessage` 调用替换为 zh-CN 文案字面量（从 zcode locale 文件抓表） | 我们单语言；文案保持逐字一致 |
| 数据适配 | **新增纯函数适配层** `lib/zcode-adapter.ts`：现有 `TaskMessage/TaskToolEntry`（DeepAgents 事件归约产物，`lib/workbench-tools.ts` 不动）→ zcode 渲染层消费的 `TaskChatToolCallTreeNode` 形状（status 映射表照抄 `toolCallRowAdapter.ts`：running→in_progress 等）；子代理 `SubagentEntry` → 其 subagent 模型 | zcode 的事件→行投影在服务端，我们不改服务端协议；渲染层吃 legacy 形状即可全量复用 renderer |
| Lexical composer | **照搬** ChatPromptEditor 壳 + Lexical 输入（新增 `lexical`/`@lexical/react` 依赖）；mention 数据源接我方服务端文件搜索 API（无则先接工作目录文件列表），slash 命令接现有 `slash-commands` | 用户口径是完全照搬；mention/slash 数据属 DeepAgents 侧适配 |
| PermissionDialog | UI 照搬；协议侧 DeepAgents interrupt/HITL 事件为后续适配项（当前档位制不变），未接通前不渲染入口（不摆空壳） | 符合「未接通不出现」纪律 |
| 浮动状态面板 / 虚拟滚动时间线 | 列入照搬范围（分阶段 P5/P6） | 数据（todo/git/后台任务）我们已有 |
| 动效/主题 | 照搬 token 与动画定义进 `apps/web/src/app/globals.css`（或对应入口），与现有 token 合并时以 zcode 为准重命名冲突项 | 四主题只搬 light/dark 两套（zai 变体不搬） |

## 4. 分阶段实施计划

每阶段一个 PR，行为可验证、`pnpm test` + `pnpm typecheck` 护航；照搬文件顶部保留 Apache-2.0 声明与来源路径注释。

- **P0 地基**：新增依赖（`@streamdown/cjk|code|math|mermaid`、`@tanstack/react-virtual`、`use-stick-to-bottom`、`lexical`、`@lexical/react`）；token/动画/滚动条 CSS 照搬；`text-ui-*` 字号阶落地。验证：现有页面视觉回归走查。
- **P1 markdown 全量**：照搬 message.tsx + code-block.tsx + markdown-* + reasoning.tsx；替换 `zcode/message-response.tsx` / `zcode/reasoning.tsx`（旧文件删除）。验证：现有 `test/` 下相关测试 + 新增渲染快照。
- **P2 工具调用全量**：照搬 ToolCallBlocks/ToolLayout/ToolSummaryRow/QueuedSummaryContent + 全部 renderer + lightweight-diff-preview 三件套 + ExecuteOutput/ScrollFadeViewport；落 `lib/zcode-adapter.ts`；替换 `zcode/tool-layout.tsx` / `zcode/tool-renderers.tsx`（旧文件删除）。验证：`workbench-tools.test.ts` 不动（归约层不变）+ 新增 adapter 单测。
- **P3 子代理**：照搬 agent renderer（live ticker 摘要 + 名字着色）+ 目录/线程侧栏样式；替换 `subagent-directory-view.tsx` 相关渲染。验证：`subagent-directory.test.ts` + 视觉走查。
- **P4 用户消息行/时间线 marker/assistant 操作行**：照搬 UserInputRowView、MarkerDividerRow、ConversationAssistantTextActions。workbench.tsx 内联 JSX 收敛。
- **P5 composer**：照搬 ChatPromptEditor + LexicalChatInput + 工具栏 + 发送/停止状态机 + 附件卡样式；mention/slash 接我方数据源。替换 workbench.tsx 两处内联 composer。
- **P6 状态面板 + 队列面板**：照搬 ConversationStatusPanel（数据源：todo/git diff/后台任务已有）+ ConversationQueuePanel。
- **P7 虚拟滚动时间线**：react-virtual 时间线 + live tail + 回到底部按钮。可选，独立评估。
- **P8 PermissionDialog**：UI 照搬 + DeepAgents interrupt 协议适配（另立项跟踪）。

## 5. 风险与开放问题

1. **workbench.tsx 3887 行巨组件**：照搬过程中消息渲染段（:3040-3434）会大幅改写，需先补行为测试再动（回归锁：`workbench-tools.test.ts`、`workbench-surface.test.ts` 已覆盖归约与主区不变量）。
2. **Design 模式不受影响**：照搬范围限定 Code 模式对话区与 composer；`components/chat/tool-block-view.tsx`（Design 画布助手）不动。
3. **依赖体积**：Lexical + streamdown 插件 + react-virtual 约增若干百 KB；桌面端可接受，Web 端按需 dynamic import。
4. **zcode 组件隐式依赖**（zustand store、platform service、code viewer 侧栏）：照搬时以 props/context 注入替代，逐文件清点 import 图。
5. **NOTICE**：在仓库 NOTICE/THIRD-PARTY 文件登记 zcode Apache-2.0 attribution。
