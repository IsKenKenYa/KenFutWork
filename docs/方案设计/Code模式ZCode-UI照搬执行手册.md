# Code 模式 ZCode UI 照搬执行手册（Agent 施工单）

> **角色：执行手册**。本文是《Code模式ZCode-UI照搬方案.md》（差异分析与决策，下称「方案」）的配套施工单，供执行 Agent 逐阶段照单施工，**不需要重新做差异分析**。
> 总目标（用户口径）：**完全照搬 ZCode 的 Code 模式 UI，不留自己的实现**；数据侧经适配层接 DeepAgents 事件模型，「一切皆插件」理念不变。
> 许可证：zcode 为 Apache-2.0（`references/zcode/LICENSE`），照搬文件保留来源注释；NOTICE 登记在方案 §5.5 跟踪。

## 0. 给执行 Agent 的元说明

1. **照单施工，不要重新分析**。方案 §2 的差异表已定案；本手册给出逐文件的 source→target 清单与适配注记。
2. **每阶段一个 PR**：只搬本阶段清单内的文件，跑通本阶段门禁即收尾，不夹带后续阶段内容。
3. **禁止改动的区域**：`packages/ui`（Design 模式共用）、`apps/web/src/components/chat/tool-block-view.tsx`（Design 画布助手）、`lib/workbench-tools.ts`（DeepAgents 事件归约层，适配层只读它不改它）、`lib/workbench-surface.ts`（主区不变量）。
4. **先查已就位清单（§1）再动手**——已就位的文件直接 import，不要重复搬运。
5. 照搬=**视觉/交互/文案逐字一致**。允许且仅允许两类偏差：① import 路径映射（§2.1）；② 宿主能力适配（§2.2 已列明的适配点）。每一处偏差必须写进文件头的「适配注记」。

## 1. 当前进度快照（已完成，切勿重做）

### 1.1 已提交（commit `0f6e73d9`，P0.5）

`@zui`（= `apps/web/src/components/workbench/zcode/`，tsconfig paths `@zui/*` → `./src/components/workbench/zcode/*`）下已就位：

- `components/ui/`：30 个视觉原语（button、button-group、card、dialog、alert-dialog、context-menu、dropdown-menu、popover、hover-card、tooltip、select、tabs、accordion、alert、avatar、badge、checkbox、collapsible、input、input-group、kbd、label、progress、scroll-area、scroll-fade-viewport、separator、spinner、switch、textarea、toast、code-viewer(891 行)、flip-metric-value、lightweight-diff-preview、highlighted-lightweight-diff-preview）
- `components/lib/utils.ts`（cn）
- `i18n/`：`IntlProvider.tsx`（`useZCodeIntl()`，locale 恒 zh-CN 透传）+ `zh-CN.ts`（zcode zh-CN locale **6722 行整表照搬**——照搬组件里的 `intl.formatMessage({id})` 调用**原样保留**，键已齐）
- `lib/`：codeCommentContext、codePreviewPreferences、codePreviewSettings（含 `DEFAULT_CODE_PREVIEW_SETTINGS`）、diffsHighlighterEngine、fileDisplay（含 `FileDisplayIcon`/`FOLDER_FILE_ICON_SRC`/`resolveFileDisplayDescriptor`）、fileDisplayHelpers、keyboardShortcuts、memoryDiagnostics、mermaidLanguage、mermaidRenderBudget、patchDiffPreview、path（含 `getPathLeaf`/`getContainingDirectoryPath`）、shikiHighlighter
- 根级：`logger.ts`（`logger`）、`useTheme.ts`（`Theme`/`ResolvedTheme`/`useTheme`/`resolveTheme`，zai 变体折叠到 light/dark）、`ControlHintTooltip.tsx`
- `apps/web/src/app/globals.css`：zcode 语义 token 全集 + 动画集（`animated-gradient-text`、`data-zcode-stream-animate` 等）+ `text-ui-*` 字号阶 + 滚动条样式
- `biome.json`：zcode 目录 override（a11y 三条降为 warn）
- 依赖已装：`radix-ui`、`@pierre/diffs@1.1.22`（**精确钉版，勿升**，1.5.x API 已变）、`@streamdown/{cjk,code,math,mermaid}`、`@tanstack/react-virtual`、`use-stick-to-bottom`、`lexical`、`@lexical/react`、`shiki`、`motion`、`framer-motion`、`katex`、`next-themes`

### 1.2 已落盘未提交（本轮地基，P0 收尾 + P1 前置适配层）

- 依赖新增：`remark-cjk-friendly-gfm-strikethrough`、`@radix-ui/react-use-controllable-state`（pnpm 严格隔离，直接 import 必须是直接依赖）
- `@zui/lib/zcode-shared.ts`：`@zcode/shared` 最小等价——`EditorInfo`/`FileStat`/`FileMediaPreview`/`OpenInEditorOptions`/`OpenInEditorRemoteTarget`/`RemoteTarget`/`SSHConnectOptions`/`WSLConnectOptions`/`DockerConnectOptions`/`createOpenInEditorRemoteTarget`/artifact 图片三函数（`rewriteMarkdownArtifactImageSources`/`decodeMarkdownArtifactImageSource`/`extractMarkdownArtifactImageRefs`）/`TID_CHAT_REASONING_TRIGGER`/`TID_CHAT_REASONING_CONTENT`
- `@zui/lib/ai-types.ts`：`UIMessage` stub（只含 `role` 联合——zcode message.tsx 仅消费 `UIMessage["role"]`）
- `@zui/hooks/usePlatform.tsx`：`PlatformProvider`/`usePlatform`/`useOptionalPlatform`/`useSelectDirectory`/`useConnectRemote` + `ZCodePlatformSlice`（stub：`getInstalledEditors`→`[]`、`openInEditor`/`openInFileManager`→`{success:false}`、`selectDirectory`→`null`、`openExternal`→系统浏览器。UI 据此自动降级隐藏「在编辑器/文件管理器打开」入口，符合「未接通不出现」纪律；Tauri 桌面接通时**只换 stub 实现**，照搬组件零改动）
- `@zui/hooks/useServices.tsx`：`ServiceProvider`/`useServices`/`useOptionalServices` + `ZCodeServiceSlice`（`fileService.stat` 抛「未接通」——消费方都有 optional 兜底）
- `@zui/hooks/useFileContextActions.ts`：照搬（复制路径可用；revealInFileManager 随 platform stub 降级）
- `@zui/hooks/useWorkspaceOpenInEditorTarget.ts`：恒 `{isRemoteWorkspace:false, remoteTarget:undefined}`（我们无远程工作区）
- `@zui/store/StoreProvider.tsx`：`useZCodeStoreWithDefault` 恒回 `defaultValue`（theme/codePreviewSettings 由调用方 props 注入，不经 store）；`useZCodeStore` 保留同签名抛错口径
- `@zui/embeddedBrowserHelpers.ts`：`resolveMessageLinkOpenTarget`（本机/私网启发式）+ `MessageLinkOpenTarget` + `DEFAULT_BROWSER_URL`（webview guest 生命周期等 Electron 专属逻辑**不搬**）
- `@zui/workspace-file-tree/model.ts`：`getWorkspaceFileRelativePath`/`areWorkspaceFilePathsEqual`/`isWorkspaceFilePathInside`；`helpers.ts`：`sortInstalledEditorsForFileTree`/`isFileManagerOpenTarget`

### 1.3 待替换的旧实现（9-28/29 骨架级参照，P1/P2 接线时删除）

| 旧文件 | 消费点 | 删除时机 |
| --- | --- | --- |
| `zcode/message-response.tsx`（102 行） | `workbench.tsx:92,321` | P1 接线 |
| `zcode/reasoning.tsx`（110 行） | `workbench.tsx:93,331` | P1 接线 |
| `zcode/tool-renderers.tsx`（445 行，导出 `resolveToolRenderer`/`AgentPromptSection`/`AgentActivitySection`） | `workbench.tsx:94,378`；`subagent-directory-view.tsx:8` | P2 接线 |
| `zcode/tool-layout.tsx`（372 行） | 仅被 tool-renderers.tsx 引用 | P2 接线 |

## 2. 照搬规则总纲

### 2.1 import 路径映射表（机械执行）

| zcode 源 import | 照搬后 |
| --- | --- |
| `@/X.js`（`@/` = zcode `packages/ui/src/`） | `@zui/X.js` |
| `../ui/X.js`（ai-elements 内的相对引用） | `@zui/components/ui/X.js` |
| `../lib/utils.js`（= zcode `components/lib/utils`） | `@zui/components/lib/utils.js` |
| `@zcode/shared` | `@zui/lib/zcode-shared.js`（符号已在 §1.2 就位；**缺新符号时先补进 zcode-shared.ts 再引用**，禁止直接 import `@zcode/shared`） |
| `ai`（仅 `UIMessage` 类型） | `@zui/lib/ai-types.js` |
| `@zcode/services` / `@zcode/rpc` / `@zcode/provider` | **禁止出现**。platform 能力走 `@zui/hooks/usePlatform.js`，RPC 服务走 `@zui/hooks/useServices.js` |
| `radix-ui` | 保持（zcode 源就用聚合包） |
| `@radix-ui/react-use-controllable-state` | 保持（已装直接依赖） |
| 其余 npm 包（react/lucide-react/streamdown/@streamdown/*/shiki/unified/remark-cjk-friendly-gfm-strikethrough/@pierre/diffs/motion/next-themes/class-variance-authority/clsx/tailwind-merge） | 保持 |

### 2.2 宿主能力适配点（全方案仅此几处，其余逐字照搬）

1. **链接打开**（message.tsx）：`resolveMessageLinkOpenTarget` 返回 `"app-browser"` 时，调用我方 `@/lib/browser-panel` 的 `canOpenInBrowserPanel()`/`requestBrowserOpen(url)`（已有，旧 message-response.tsx 的 onClick 口径即参照）；`"external-browser"` 时走 `platform.openExternal`（stub=系统浏览器）。保留 zcode 组件结构，只替换「打开 app 内浏览器」的实现体。
2. **文件链接打开**（message.tsx 的 `onOpenFileLink`/`onOpenCodeViewer` props）：由调用方（workbench 装配处）注入；P1 阶段 workbench 侧先传 `undefined`（zcode 组件内部有可选兜底），**接通 code viewer 侧栏属 P4 接线项**。
3. **theme / codePreviewSettings**：workbench 装配处经 `@zui/useTheme.js` 取 theme、以 `DEFAULT_CODE_PREVIEW_SETTINGS` 默认值注入 props（zcode MessageResponse 已支持 props 注入，勿动组件内实现）。
4. **未接通能力**（编辑器枚举、文件管理器、fileService、远程工作区）：一律经 §1.2 stub 降级，照搬文件**禁止**自行新增宿主调用。

### 2.3 文件头注释模板（每个照搬文件必带）

```ts
/**
 * zcode 照搬：`<原 zcode import 路径>`（references/zcode/packages/ui/src/<相对路径>）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：<与源文件的每一处偏差，逐条列；无偏差写「逐字照搬，仅 import 路径映射（手册 §2.1）」>
 */
"use client";  // 源文件有则保留，首行顺序：注释 → "use client" → imports
```

### 2.4 TS / lint 陷阱（已踩过，勿重蹈）

1. **`exactOptionalPropertyTypes: true`**（本仓 tsconfig.base）：可选属性不能显式赋 `undefined`；对象字面量里写 `prop: maybeUndefined` 直接报错。修法：`...(v !== undefined ? { v } : {})` 条件展开；若联合类型上展开推断不稳，显式构造（先例：`zcode-shared.ts` wsl 分支、`useFileContextActions.ts` workspaceIdentity）。
2. **ESM `.js` 后缀**：`@zui/**` 与相对导入一律带 `.js` 后缀（含 `.tsx` 源文件，写 `.js`）。
3. **死导入清理**：源文件 import 但未使用的符号删除并记进适配注记（已确认案例：zcode `message.tsx:92` 的 `useZCodeStore` 是死导入）。
4. **biome**：两空格缩进、双引号、分号；收尾跑 `pnpm exec biome check --write apps/web/src/components/workbench/zcode`（仅本目录，勿全仓 `--write`）。
5. **`data-testid`**：zcode 用 `TID_*` 常量（已在 zcode-shared.ts 就位），不要内联字面量。
6. **导出保真**：所有 export 名称/签名与源文件逐字一致——后续阶段与其他文件按原名 import。

### 2.5 每阶段验收门禁（PR 收尾前必跑，顺序执行）

```bash
# 1. 类型（web 包）
pnpm --filter @kenfutwork/web typecheck
# 2. web 包测试
pnpm --filter @kenfutwork/web test
# 3. 照搬目录 lint/格式
pnpm exec biome check apps/web/src/components/workbench/zcode
# 4. 全仓门禁（workspace 棘轮 + 文档门禁 + 全包测试；禁止与其他测试实例并行）
pnpm test
```

## 3. P1 施工单：markdown 全量照搬

**目标产物**：`@zui/components/ai-elements/` 完整 markdown 渲染栈 + 其 lib 依赖；接线替换 workbench 两处 import；删除旧 `message-response.tsx`/`reasoning.tsx`。

### 3.1 文件清单（source → target；行数为源文件规模，供工作量预估）

| # | 源（`references/zcode/packages/ui/src/`） | 行数 | 目标（`@zui/`） | 适配注记 |
| --- | --- | --- | --- | --- |
| 1 | `lib/markdownFileLink.ts` | 316 | `lib/markdownFileLink.ts` | 纯函数；仅路径映射 |
| 2 | `lib/assistantPathQuotes.ts` | 73 | 同名 | 纯函数 |
| 3 | `lib/windowsFileLinkEscapeRemarkPlugin.ts` | 95 | 同名 | remark 插件 |
| 4 | `lib/zcodeFileCitation.ts` | 154 | 同名 | 纯函数 |
| 5 | `lib/zcodeFileCitationRemarkPlugin.ts` | 79 | 同名 | remark 插件，依赖 #4 |
| 6 | `lib/editorPreference.ts` | 36 | 同名 | localStorage 读写，照搬 |
| 7 | `lib/openWithEditors.ts` | 18 | 同名 | 纯函数（与 `workspace-file-tree/helpers.ts` 已就位的排序同实现，**保留同名导出**勿合并） |
| 8 | `lib/workspaceEditorSelection.ts` | 89 | 同名 | 纯函数，依赖 #7 |
| 9 | `lib/codeViewer.ts` | 602 | 同名 | 类型 + 语言/媒体类型推断纯函数。注意 `export { buildUnifiedDiff } from "@/lib/toolDiffPreview.js"`——**`lib/toolDiffPreview.ts` 一并搬运**（属 P2 共用件，先搬不接线） |
| 10 | `mentions/components/scrollMask.ts` | 62 | `mentions/components/scrollMask.ts` | 纯函数（滚动渐隐 mask） |
| 11 | `components/ai-elements/streamdown-controls.ts` | 7 | 同路径 | 常量表 |
| 12 | `components/ai-elements/code-block.tsx` | 550 | 同路径 | 自研代码块（语言标签/复制/换行钮；流式关高亮）；依赖 shikiHighlighter（已就位） |
| 13 | `components/ai-elements/markdown-blockquote.tsx` | 22 | 同路径 | |
| 14 | `components/ai-elements/markdown-list.tsx` | 64 | 同路径 | |
| 15 | `components/ai-elements/markdown-table.tsx` | 1420 | 同路径 | 大文件；消费 code-viewer、store stub、toast（均已就位） |
| 16 | `components/ai-elements/markdown-image.tsx` | 391 | 同路径 | `services.fileService` 媒体预览在 stub 下自动降级为外链图 |
| 17 | `components/ai-elements/mermaid-block.tsx` | 328 | 同路径 | mermaidLanguage/mermaidRenderBudget 已就位 |
| 18 | `components/ai-elements/image-thumbnail-gallery.tsx` | 31 | 同路径 | |
| 19 | `components/ai-elements/image-preview-dialog.tsx` | 564 | 同路径 | |
| 20 | `components/ai-elements/diagram-preview-dialog.tsx` | 702 | 同路径 | mermaid 大图预览 |
| 21 | `ToolCallBlocks/QueuedSummaryContent.tsx` | 254 | `ToolCallBlocks/QueuedSummaryContent.tsx` | reasoning.tsx 的依赖；只依赖 react+motion，属 P2 共用件先搬 |
| 22 | `components/ai-elements/message.tsx` | 1670 | 同路径 | 核心。**死导入 `useZCodeStore` 删除**；链接打开走 §2.2-1 适配；platform/services/store hooks 全部已就位（§1.2） |
| 23 | `components/ai-elements/reasoning.tsx` | 577 | 同路径 | `useControllableState`（依赖已装）；QueuedSummaryContent（#21）；TID 常量在 zcode-shared |

### 3.2 P1 接线（workbench.tsx，逐 hunk 复核）

1. `workbench.tsx:92` `import { MessageResponse } from "@/components/workbench/zcode/message-response"` → `from "@zui/components/ai-elements/message.js"`。**props 形状变化**：zcode `MessageResponseProps` 用 **`children` 传 markdown**（不是 `text`），另有 `streaming`/`theme`/`codePreviewSettings`/`workspacePath`/`onOpenCodeViewer`/`onOpenFileLink`/`onOpenExternalUrl`（全可选）。调用点（:321）改为 `<MessageResponse streaming={…} theme={…} codePreviewSettings={DEFAULT_CODE_PREVIEW_SETTINGS}>{group.text}</MessageResponse>`；theme 经 `@zui/useTheme.js` 的 `useTheme()` 取。
2. `workbench.tsx:93` `Reasoning` → `from "@zui/components/ai-elements/reasoning.js"`。props 变化：`text`→**`children`**；`streaming`→**`isStreaming`**；`durationSeconds`→**`duration`**；可选 `autoCollapseKey`（传消息 id 即可，流完自动收起）。调用点 :331 同步改写。
3. 删除 `zcode/message-response.tsx`、`zcode/reasoning.tsx`；全仓 grep 确认零引用。
4. **回归测试**：`apps/web/test/` 下若存在引用旧文件路径的测试一并改接；为 `MessageResponse`/`Reasoning` 各补一个渲染冒烟测试（流式/静态两态），放 `apps/web/test/zcode-message.test.tsx`。

### 3.3 P1 建议分工（可多 Agent 并行，目标路径互不重叠）

- **Agent-A（lib 批）**：#1-#10（纯函数库，约 1800 行）
- **Agent-B（叶子组件批）**：#11-#21（约 3400 行）
- **Agent-C（核心编排批）**：#22-#23（约 2500 行；import 按本手册路径表写，B 的产物路径已固定，无需等 B 完成）

## 4. P2 施工单：工具调用全量照搬

### 4.1 骨架文件（全搬）

| 源 | 行数 | 目标 |
| --- | --- | --- |
| `ToolCallBlocks.tsx` | 393 | 同名 |
| `ToolCallBlocks/ToolLayout.tsx` | 363 | 同名 |
| `ToolCallBlocks/ToolSummaryRow.tsx` | 235 | 同名 |
| `ToolCallBlocks/ToolCallBody.tsx` | 204 | 同名 |
| `ToolCallBlocks/shared.tsx` | 17 | 同名 |
| `ToolCallBlocks/ToolSnapshotFieldNotice.tsx` | 80 | 同名 |
| `ToolCallBlocks/fileSummaries.ts` | 231 | 同名 |
| `ToolCallBlocks/fileSummaryTypes.ts` | 317 | 同名 |
| `ToolCallBlocks/renderers.tsx` | 175 | 同名（注册表；按 4.2 裁剪 case） |
| `lib/toolCallTree.ts` | 6 | 同名 |
| `lib/taskChatMessageTypes.ts` | 100 | 同名 |
| `lib/toolDiffPreview.ts` | — | 同名（P1 #9 若已搬则跳过） |

### 4.2 renderer 选择性照搬（对齐我方 DeepAgents 工具集）

**必搬**（13+5 个配套）：`edit.tsx`(480)+`EditInlineDiffContent.tsx`(85)、`execute.tsx`(380)+`ExecuteOutput.tsx`(50)+`execute-group.tsx`(140)、`read.tsx`(316)、`search.tsx`(134)、`todo.tsx`(154)、`ask-question.tsx`(92)、`agent.tsx`(413)+`agentPromptSection.tsx`(51)、`explore.tsx`(490)、`fallback.tsx`(112)、`skill.tsx`(224)、`task-stop.tsx`(215)、`changes-group.tsx`(319)

**不搬**（zcode 专有 CUA/工作流/cron 等，我方无对应工具；渲染注册表相应 case 删除）：`cua*.tsx`、`*workflow*.tsx`、`cron-create.tsx`、`offpeak-create.tsx`、`list-models.tsx`、`node-repl*.tsx`、`nodeReplImageGrid.tsx`、`read-session-context.tsx`、`send-message.tsx`、`submit-result.tsx`、`goal.tsx`、`escalate.tsx`、`respond-to-coordinator.tsx`、`switch-mode.tsx`、`task-output.tsx`、`plan-guidance.tsx`、`resolve-workflow-question.tsx`

### 4.3 数据适配层（新写，非照搬）

- 参照 `references/zcode/packages/ui/src/v4/toolCallRowAdapter.ts`（130 行）的 **status 映射表**与 `lib/taskChatMessageTypes.ts` 的 `TaskChatToolCallTreeNode` 形状，新写 `apps/web/src/lib/zcode-adapter.ts`：把我方 `TaskToolEntry`（`apps/web/src/lib/workbench-tools.ts`，**只读不改**）投影为 `TaskChatToolCallTreeNode`。附单测 `apps/web/test/zcode-adapter.test.ts`（覆盖：running→in_progress 等全状态映射、子代理树嵌套、diff 计数透传）。

### 4.4 P2 接线

1. `workbench.tsx:94,378` `resolveToolRenderer` → ToolCallBlocks 渲染路径（`<ToolCallBlocks nodes={…} />` 或按 zcode 调用形态；以照搬组件的实际导出签名为准）。
2. `subagent-directory-view.tsx:8` 的 `AgentPromptSection`/`AgentActivitySection` 改从 `@zui/ToolCallBlocks/renderers/agent.js` 导入（若 zcode agent.tsx 导出名不同，以照搬件为准并同步改调用处）。
3. 删除 `zcode/tool-layout.tsx`、`zcode/tool-renderers.tsx`；grep 确认零引用。
4. `workbench-tools.test.ts` **不动**（归约层不变）；新增 adapter 单测。

## 5. P3 施工单：子代理（agent renderer 已含 P2，本阶段为体验补全）

1. **live ticker**：zcode 父对话子代理单行摘要在运行中滚动显示子代理最新动作——照 `ToolCallBlocks/renderers/agent.tsx` 内实现接线（数据源：我方 `SubagentEntry` 的最新工具行，`lib/subagent-directory.ts`）。
2. **agent 名 hash 着色**：照 zcode 配色函数（在 agent.tsx / agentPromptSection.tsx 内）逐字搬。
3. **侧栏目录面板**：`subagent-directory-view.tsx` 的 running/ended 分组 + 状态图标映射对齐 zcode 的 SessionPane 子代理视图样式（施工时先在 zcode 源定位侧栏组件：`WorkspaceSidebar`/Session 相关，按其视觉规格改 subagent-directory-view）。
4. 回归：`apps/web/test/subagent-directory.test.ts` 保持绿并按新交互补用例。

## 6. P4 施工单：用户消息行 / 时间线 marker / 操作行

施工时先在 zcode 源定位（关键词：`UserInputRow`、`MarkerDivider`、`AssistantTextActions`，可能在 `v4/` 或会话行组件内）：

1. **用户消息行**：`rounded-xl rounded-tr-xs border bg-surface` + 容器查询限宽 + hover 复制/编辑操作行。替换 workbench.tsx 内联的用户气泡 JSX。
2. **MarkerDividerRow**：替换 workbench.tsx :340-366 的内联 notification 分隔线（现状已是近似仿制，换 zcode 原件）。
3. **ConversationAssistantTextActions**：助手正文 hover 操作行（复制/重试入口）。
4. workbench.tsx 消息渲染段（:300-395）内联 JSX 收敛进对应照搬组件。

## 7. P5 施工单：composer（全方案最重，独立 PR）

| 源 | 规模 | 目标 |
| --- | --- | --- |
| `LexicalChatInput.tsx` | 1531 行 | 同名 |
| `prompt-editor/` 目录（ChatPromptEditor 壳等） | 施工时盘点 | 同路径 |
| `chat-input-toolbar/` 目录 | 施工时盘点 | 同路径 |
| `mentions/` 目录（mention 插件 + scrollMask 已在 P1 #10） | 施工时盘点 | 同路径 |
| `SlashCommandPlugin.tsx` + `slashCommandHelpers.ts` + `slashCommandPanelSections.tsx` | — | 同名 |

适配决策（方案 §3 已拍板）：mention 数据源接我方服务端文件搜索 API（无则先接工作目录文件列表）；slash 命令接现有 `slash-commands`。替换 workbench.tsx 两处内联 composer（textarea + CompactSelect 簇），视觉壳 = zcode `rounded-2xl`（focus-within/拖拽态换边色）+ 发送/停止状态机 + 附件卡。
**可选项**：若 PR 过大，拆 P5a（视觉壳 + Lexical 纯文本输入 + 发送/停止状态机）/ P5b（mention+slash 数据源接线）两个 PR——拆分时须保证 P5a 单独可用（mention/slash 入口隐藏，不摆空壳）。

## 8. P6 施工单：浮动状态面板 + 队列面板

- `ConversationStatusPanel.tsx`（zcode 源定位）：todo 分区 + Git ± 分区 + 后台任务停止按钮；`rounded-2xl`。数据源我方已有（todo 条目 / git diff 统计 / 后台任务列表），经 props 注入。
- `ConversationQueuePanel.tsx`：排队消息面板。
- 装配进 workbench Code 模式对话区（悬浮位与 zcode 一致）。

## 9. P7 施工单：虚拟滚动时间线（可选，独立评估）

`@tanstack/react-virtual` 时间线 + 高度缓存 + live tail 移出虚拟列表 + 回到底部按钮（zcode 会话主列表实现，施工时定位）。**独立 PR**，先做性能基线截图再动工；若当前消息量级无卡顿可暂缓。

## 10. P8 施工单：PermissionDialog（UI 照搬 + 协议适配，另立项）

- `PermissionDialog.tsx`（zcode 源根目录）：序号选项 + 数字键应答 + always-allow 文案归一（无倒计时条）。
- 协议侧：DeepAgents interrupt/HITL 事件 → PermissionDialog props 的适配属服务端契约工作，**另立项跟踪**；未接通前不渲染入口（方案 §3 纪律：不摆空壳）。

## 11. 风险登记（施工前必读）

1. **workbench.tsx 3887 行巨组件**：接线改动集中 :92-94（import）与 :300-395（消息渲染段）；提交前 `git diff` 逐 hunk 复核，共享文件勿夹带他人改动（AGENTS.md 提交纪律 #3）。
2. **行为不变量**：`lib/workbench-surface.ts`（Design 主区恒画布）与 `workbench-surface.test.ts` 必须保持绿；本照搬不动该文件。
3. **测试护栏**：全仓 `pnpm test` 不得与其他测试实例并行；确需串行用 `pnpm exec turbo run test --concurrency=1`（勿用 `--` 透传）。
4. **导出保真**：后续阶段按符号名 import 前序产物；改名=断链。
5. **依赖钉版**：`@pierre/diffs@1.1.22` 勿升；新增依赖先查 zcode `packages/ui/package.json` 对齐版本区间再 `pnpm --filter @kenfutwork/web add <pkg>`。
6. **文档同步**：每阶段 PR 在 `docs/日志.md` 同提交记账（问题/方案/验证命令/遗留项）；本手册与方案已登记 `docs/README.md` 文档地图，新增文档须同步登记。
7. **NOTICE**：首次合入照搬代码的 PR 需在仓库 NOTICE/THIRD-PARTY 登记 zcode Apache-2.0 attribution（方案 §5.5）。
