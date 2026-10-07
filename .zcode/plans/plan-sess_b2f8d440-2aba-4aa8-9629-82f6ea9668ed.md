# Code/Design 模式能力分离方案（DEC-2 收敛实现）

## 结论
两模式共享同一 agent 内核（deepagents），但**工具面、系统提示、canvas_state 注入三处按 preset 装配，单一通路走内核工具注册表（scope 过滤）**，不留 `createMainAgentTools` 过渡参数。Code 会话从此不携带任何画布能力。

## 已拍板决策（本轮用户确认）
1. **彻底分离**：code preset 剔除画布三件套 + canvas_state 不注入 Code 会话；future 的「Code 操作画布」以「显式目标画布」将来另行立项
2. **生图生频归 design**：Code 模式先剔除；「两模式打通」是远期方向（Codex 先例成立），前置条件是各自能力做强 + 数据流理清（Design 图片存 S3/本地文件系统、Code 操作真实 FS）
3. **直接对准注册表目标态**：无用户探索期，测试数据可弃，不畏惧迁移风险，不做参数化过渡层
4. **Design 侧 execute/文件工具本期不动**（记遗留项）

## 实施步骤（一步一提交一测试）

### Step 1：内置工具迁内核注册表（行为变化核心）
- `apps/server/src/features/agent-runs/` 新建内置工具注册模块，插件 `apply()` 内向 `ctx.tools.register()` 注册 8 个工具（服务依赖均已在插件内可得：`canvasRepository`/`jobService`/`blob`/`connectionManager`，plugin.ts:68-157）：
  - **scope=design**：`inspect_canvas`、`manipulate_canvas`、`screenshot_canvas`、`generate_image`、`generate_video`、`get_brand_kit`
  - **scope=shared**：`persist_sandbox_file`、`project_search`
- 工具从 StructuredTool 工厂改写为 `ToolDefinition`（name/description/scope/parameters/execute(args, execCtx)）：
  - 上下文来源从 `configurable.canvas_id/user_id` 改为 `execCtx.canvasId/workspaceId/accessToken`（runtime.ts:1714-1716 已填）
  - `ToolExecutionContext` 补可选 `userId`/`sessionId` 字段（kernel/types.ts:205，重造 submitImageJob 闭包所需）
  - `submitImageJob/submitVideoJob` 的 per-run 闭包（runtime.ts:640-837：提交 PGMQ+轮询+插画布+推 canvas.sync）重构为基于 execCtx+服务实例的函数；取消信号用 `execCtx.signal`，缺失时轮询有 MAX_WAIT 上界兜底
- `deep-agent.ts:425-460` 删除 `createMainAgentTools` 调用，`tools/index.ts` 装配职责退役；`execute_background` 的 `preset==="code"` 分支（:571）保留（已正确门控）
- 迁移风险点：`jsonSchemaToZod` 4 层深度封顶 vs `manipulate_canvas` operations 嵌套——若超限，封顶值提额为带注释的具名常量（或进 governance.ts）
- 验证：`registry.list("code")` 不含画布/生图工具；`list("design")` 全含；回归锁死「manipulate_canvas 完成后 canvas.sync 照发」（stream-adapter.ts:556 链路）

### Step 2：系统提示拆分（base + design + code 三段）
- `prompts/kenfutwork-main.ts` 拆三份：
  - `base.ts`：身份、语言规则、纯文字任务不调工具、错误处理总则
  - `design.ts`：现有画布指导（画布感知/manipulate 操作表/尺寸颜色字号/参考图/模型偏好）
  - `code.ts`（新写）：文件与命令工具约定（ls/read_file/write_file/edit_file/glob/grep/execute/write_todos）、项目作用域与沙箱（工作目录=项目、多轮共享同目录）、检查点（影子 git 自动提交）、长命令超时与重试口径（引用工作区治理、不写死数字）、子代理用法（explore/review）、错误处理；**不提任何画布/生图能力**
- `deep-agent.ts:385` 组装改为 `base + (design段|code段)` + 品牌套件段（仅 design）+ Skills 段 + 插件/用户规则段（两模式保留）；preset 分支复用 :571 已有的 preset 来源，不新开通路

### Step 3：canvas_state 门控与子代理联动
- `runtime.ts:1741` 注入条件加 `resolvePresetForRun(run) === "design"`
- `subagent-definitions.ts`：`video_generate` 子代理 preset 从 shared → design（其白名单依赖 `generate_video`）
- `resolveChildToolbelt` 缺名静默跳过 → **fail loud**（防 preset 过滤无声掏空子代理，属本次改动路径上的既有缺口），补回归测试
- `resolvePresetForRun` 注释修正（「无画布的纯会话归 code」已过时；现状：显式 preset 优先，canvasId 兜底 design，Code 客户端显式传 code）

### Step 4：契约测试 + 文档
- vitest（apps/server，与源码同目录）：
  - 工具面契约：code 装配不含 6 个 design 工具；design 装配全含；两模式均含 `persist_sandbox_file/project_search`
  - 提示契约：code 提示含编码段、不含画布/品牌段；design 反之；base 段两模式都在
  - canvas_state：code run（即使带 canvasId）不注入，design 注入
  - 子代理矩阵：design=[planner,batch_image,video_generate]、code=[explore,review]；子代理白名单在生效 preset 下完整解析（fail-loud）
- 文档：`docs/方案设计/` 新增 spec（含「远期打通」一节：Codex 先例、两模式能力先强、数据流前置条件）；`docs/日志.md` 同提交记账；改造计划 §4.7/§4.2 若受影响同 PR 更新
- 每步跑 `pnpm --filter @kenfutwork/server test` + `pnpm typecheck`；无 shared 契约变更（preset 枚举不动）

## 遗留项（spec 记录，本期不做）
- Design 侧 execute/文件工具收敛（随内核 PR）
- 「Code 操作画布/生图落沙箱」显式目标画布设计（future 需求，待两模式能力成熟立项）
- 内置工具注册权从 agent-runs 插件下沉到各自 feature 插件（§4.10 完全体，逐工具渐进）
- 已知不一致：`persist_sandbox_file` 在 Code 无项目时 canvasId 是会话 UUID、workspace 解析回落 uploads/（预存行为，不在本次范围）
- 提示段注册表化（dsh PromptSection 式），待内核落地