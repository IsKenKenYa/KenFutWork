# Code 模式 ZCode 全量源码移植执行手册

> 状态：实施中，2026-10-02 用户确认。此稿替换旧 P0–P8 施工单及其收口结论。
> 唯一源码基线：ZCode 3.14.3，29628c9acdb81b703bbd4080c207a0e7ce5e276e。
> Code 全部 UI 直接搬源；Design 保持不变；DSH 仅参考插件机制。旧调试数据不兼容、不转换、不恢复。

## 1. 移植边界与来源

完整复制原 UI 树，保留 App、workspace shell、SessionPane、消息时间线、Markdown、全部工具 renderer、输入器、左右栏、设置和插件市场的真实装配关系。子代理详情复用只读 SessionPane。

来源清单为 `docs/源码来源/ZCode源码清单.json`：源路径、目标路径、源 SHA-256、复制 SHA-256、适配记录。保留原版权及第三方 notices。

允许偏差仅限导入映射、构建/类型兼容、公共资源路径、宿主接口、品牌与模式文案、真实能力显隐。禁止手写用户气泡、工具卡、消息装配、子代理目录、动作行、分隔线等仿制组件。

上游 UI 由独立 TypeScript/Vite 工程检查和构建，Next 消费构建产物；宿主 adapter 保持 strict/exactOptionalPropertyTypes。不扩充手写 zcode-shared stub，不搬原 Node 服务实现和 Agent CLI。

## 2. 宿主与模式隔离

`/workbench` 采用客户端 mode 导航，默认 code。Code 挂完整原界面；Design/Flow 挂保留的原界面。Code 原菜单的 office 入口仅映射为进入 Design，Code store 保持 coding，不激活原 office 功能。

隔离 Code CSS、主题/字号 DOM 目标与 portal 容器。Store 初始化也不得修改 Design 的 document theme。ZCode 云账户/套餐移除；远程、CUA、定时任务等按真实插件能力隐藏。

真实 store、services、transport、projection 必须接通。禁止以恒空租约、恒空列表、无效回调或抛“未接通”的必需服务宣称接入完成。

## 3. 后端及公开契约

保留 DeepAgents，新增 codeUi 插件的 Definition/Provider/Consumer，服务 key 登记《改造计划》§4.2。禁止在 app.ts/worker.ts 手工堆装配。

原 V4 ConversationTransport、SessionDataLayer、rows/snapshot/command/frame 为 UI 契约。首屏初始化原 workspace tab/draft 与模型 view；V4 subscribe 返回 ACK-only，snapshot 经所属 frame 通知发送。

根 session 对应 Task；运行绑定 Project 的固定工作目录。每次子派发建立稳定 childSessionId，按 parentToolCallId 关联，禁用名字/派发顺序兜底。主/子正文、思考、工具和终态独立持久化。

工具结果保留完整文本、结构化 output/display、真实 diff、实时输出预览及 success/error/cancelled。长输出按引用读取，不能整段丢弃。事件/命令有稳定身份、单调序号、幂等重放、终态保护与删除墓碑。

必须接通发送/停止、排队、编辑/分叉、文件查看/回退、终端、子代理独立停止、权限请求-应答-恢复及结构化提问。新 Schema 仅新增前向 SQL 迁移；治理值沿用 shared 的单一配置来源；BYOK key 只写不读。

## 4. TDD 与完整验收

用户已确认四个测试接口：Agent 公共运行事件；Code 宿主快照/订阅/命令/文件服务；原组件真实用户操作；Design 画布与助手不变量。

逐条 red→green，覆盖并发同类型子代理、父派发收尾、失败/取消、关闭侧栏后继续运行、刷新/断线、重复与迟到事件、删除后迟到请求、空/Unicode/超长输出和真实 diff。

真实模型冒烟使用本机公共模型目录所列 glm-4.5-air；不读取或输出 API key。确定性回归在外部模型边界使用替身。

在相同浏览器/视口/字体/语言/主题中，与同一 ZCode 提交使用相同数据逐场景截图及交互对照。源码来源、视觉/交互、真实后端、旧 Code 清零、Design 回归全部满足后才算完成。

## 5. 实施顺序与交付

1. 已确认技能配置、更新方案/手册、来源清单与测试场景。
2. 子派发→原 Agent 行→目录→子 SessionPane 的首个完整切片，再逐条接通工具和运行交互。
3. 完整工作台、设置、右栏与真实宿主服务。
4. 删除所有旧 Code 分支、组件、展示归约、空 stub、旧测试及无用引用；共享 Design 实现保留，不设旧界面回退开关。
5. 顺序执行 pnpm test、pnpm typecheck、pnpm lint、pnpm build、pnpm api:spec；同步 HTTP/WS 文档。HTTP 契约变化按既有规则导入 Apifox AI 分支，合并由用户确认。

交付一个完整替换 PR，按可验证切片提交；每次提交遵守显式路径暂存与门禁规则，日志同步记录实际证据及未完成项。

## 6. 实时实施记录（2026-10-03）

- 分支：`codex/完整移植ZCode-Code界面`，目标 active。已按独立切片提交：`613ed706` 产物忽略、`dae8ee1b` 技能配置、`fca5bab9` 原契约依赖、`5c9dd46b` 运行事实、`1574d031` V4 会话宿主。尚未推送、未创建 PR。
- 来源核对 3051 条、零漂移。334 条契约源码及原完整模型规则已随相关切片入库；其余 UI 来源将在前端切片补入。原版权/notices 保留，独立 vendor 检查与 strict/exactOptional 宿主检查通过。
- 原 UI 整树和真实 host/main 已存在，独立 Vite 文档构建通过。使用原 RemoteServiceAccess/ProxyChannel、providers/store、RootWorkspaceContent/App/SessionPane；Code CSS/portal/主题在独立文档内。原 diff worker 构建副作用设置与 PDF CMap 插件已补齐，产物含非空 worker 和 168 个 CMap。
- 原输入器已实际发送 GLM 4.5 Air 请求；真实子代理派发后，原 Agent 行打开右侧只读子 SessionPane，独立 Markdown/工具转录可读，原文件 chip 呈现。真实文本、幂等、主区刷新恢复已验证。完整 source-vs-host 视觉/交互对照尚未进行。
- codeUi 插件持有真实 Task/Project 主画布绑定、固定工作目录、命令去重与事务 ACK、原快照/行、owned SSE 订阅、恢复、Task 索引、安全模型 view 与文本文件读取。原 subscribe 服务入参为 sessionId，返回 ACK-only；不传项目 UUID 作 workspaceIdentity。
- 事件日志与主/子快照同事务持久化。已覆盖正文/思考、成功/失败/取消、重复派发、主/子分流、前台子终态、恢复与迟到保护。真实参数在事件日志保留，UI 文件工具路径适配为实际项目路径。
- SQL `20261002133704_code_ui_projection.sql` 已执行且不可修改。前轮历史 SHA、71 条迁移临时库重放及二次 0 条验证通过。
- 最近检查：server 1478 测试通过，shared 80 测试通过，原事件窄回归 38、会话/model view 范围另通过；server/shared、vendor/host 类型检查通过；四项公开接口 integration（含 GLM 真实文本）通过；暂存独立快照 workspace/API 文档门禁和 frozen-lockfile 通过。不能将范围检查称为最终全仓完成。

### 所有权与下一步

用户安排其他 Agent 接续后端（主要 Agent 运行时）。本 Agent 聚焦前端原件接线、宿主适配、模式隔离、Code 旧实现清零及视觉/Design 回归，不再并行改 Agent 核心。后端现有改动已经提交，后续按明确接口集成。

1. `/workbench` 尚未替换，旧 Code shell/stub 引用仍导致 web 类型检查失败。先完成客户端默认 Code/Design/Flow 导航与父窗口认证/模式桥接，保留 Design/Flow 原壳，删除 Code 自有装配、归约、右栏和旧测试。
2. 宿主仍未接全部命令：停止、队列、编辑/分叉、权限/结构化提问恢复、文件回退、终端等必须由真实能力实现。availability 目前仍有待纠正的预设 true；不能把未实现能力宣称可用。
3. 后端需继续：官方 LangGraph interrupt/Command.resume、waiting/checkpoint 恢复、Code PG fail loud、GraphInterrupt 穿透、精确 child 停止与后台终态；Code 不依赖名称/顺序兜底。
4. 设置写入/原市场与插件服务、模型选项执行、Gemini 适配、真实 before/after diff 与完整长输出引用仍未完成。BYOK 表单保持原件，成功保存后只清对应未继续编辑的 key 草稿，服务端不回传 key。
5. Code store 恒为 coding；原 office 菜单仅导航 Design。隐藏云账户/套餐和真实不可用可选能力。当前前端桥接尚未完成，不能按现有 main 认定 Code/Design 路由或能力显隐已经交付。
6. 原版同场景截图/交互、GLM 工具链锁定回归、旧 Code 清零、Design 回归、完整 pnpm test/typecheck/lint/build/API spec 与 Apifox AI 分支仍必须完成，之后一个完整 PR。

### 验收进程与文件审计

- 本任务临时 API 3301、Vite preview 3300；只连接现存开发 PG，不管理其生命周期。开发主服务监听源码变化时可能停/起 PG 并换端口；临时回环转发 3332 跟随当前 PG 端口。临时脚本位于 `/tmp/ken-code-api.mts` 与 `/tmp/ken-code-db-proxy.mjs`，不入库；先检查实时监听再使用，PID/exec handle 不作为长期事实。
- 公开接口命令：`RUN_CODE_UI_INTEGRATION=1 RUN_CODE_UI_MODEL_SMOKE=1 CODE_UI_TEST_BASE=http://127.0.0.1:3301 CODE_UI_TEST_ORIGIN=http://localhost:3300 pnpm --filter @kenfutwork/server exec vitest run src/features/code-ui/host.integration.test.ts`。测试临时建项目/目录并归档清理。
- 前端浏览器验收目录 `/tmp/ken-code-ui-browser-6T6wxE`（临时项目 id `f6387289-4da8-44c2-ac94-96aea078984a`）尚保留供后续交互，需要结束时清理；不恢复或迁移其他旧调试数据。
- 本轮审计发现 121 个 `apps/server/data/checkpoints/` 影子 Git 运行文件并补忽略；约 3109 个新增/修改源文件与必要资源应入库。dist/types/host 声明、node_modules、public/code-ui 静态产物、.env.local 已被忽略，凭据模式扫描 0 匹配。不能忽略原源码、图标、许可证、契约、来源清单或前向迁移来减少文件数。
