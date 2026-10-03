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

- 分支：`codex/完整移植ZCode-Code界面`，目标 active。已按独立切片提交：`613ed706` 产物忽略、`dae8ee1b` 技能配置、`fca5bab9` 原契约依赖、`5c9dd46b` 运行事实、`1574d031` V4 会话宿主。另已提交 `07d8657d` 完整原 UI 恢复检查点、`65d1097e` 认证/模式接口。尚未推送、未创建 PR。
- 来源核对 3051 条、零漂移。完整原 UI、资源、契约源码及模型规则已随检查点入库。原版权/notices 保留，独立 vendor 检查与 strict/exactOptional 宿主检查通过。
- 原 UI 整树和真实 host/main 已存在，独立 Vite 文档构建通过。使用原 RemoteServiceAccess/ProxyChannel、providers/store、RootWorkspaceContent/App/SessionPane；Code CSS/portal/主题在独立文档内。原 diff worker 构建副作用设置与 PDF CMap 插件已补齐，产物含非空 worker 和 168 个 CMap。
- 原输入器已实际发送 GLM 4.5 Air 请求；真实子代理派发后，原 Agent 行打开右侧只读子 SessionPane，独立 Markdown/工具转录可读，原文件 chip 呈现。真实文本、幂等、主区刷新恢复已验证。完整 source-vs-host 视觉/交互对照尚未进行。
- codeUi 插件持有真实 Task/Project 主画布绑定、固定工作目录、命令去重与事务 ACK、原快照/行、owned SSE 订阅、恢复、Task 索引、安全模型 view 与文本文件读取。原 subscribe 服务入参为 sessionId，返回 ACK-only；不传项目 UUID 作 workspaceIdentity。
- 事件日志与主/子快照同事务持久化。已覆盖正文/思考、成功/失败/取消、重复派发、主/子分流、前台子终态、恢复与迟到保护。真实参数在事件日志保留，UI 文件工具路径适配为实际项目路径。
- SQL `20261002133704_code_ui_projection.sql` 已执行且不可修改。前轮历史 SHA、71 条迁移临时库重放及二次 0 条验证通过。
- 最近检查：server 1478 测试通过，shared 80 测试通过，原事件窄回归 38、会话/model view 范围另通过；server/shared、vendor/host 类型检查通过；四项公开接口 integration（含 GLM 真实文本）通过；暂存独立快照 workspace/API 文档门禁和 frozen-lockfile 通过。不能将范围检查称为最终全仓完成。

### 所有权与下一步

用户安排其他 Agent 接续后端（主要 Agent 运行时）。本 Agent 聚焦前端原件接线、宿主适配、模式隔离、Code 旧实现清零及视觉/Design 回归，不再并行改 Agent 核心。后端现有改动已经提交，后续按明确接口集成。

1. `/workbench` 已默认挂原 Code 文档，Design/Flow 独立客户端导航；旧 Code 自有装配、本地转录、归约、右栏及其测试共 53 个文件已退役。Design 侧栏/画布和共享设置保留，原共享输入叶子单独编译；web 368 测试和类型检查通过。继续原版视觉、长会话与服务集成回归。
2. 宿主仍未接全部命令：停止、队列、编辑/分叉、权限/结构化提问恢复、文件回退、终端等必须由真实能力实现。availability 目前仍有待纠正的预设 true；不能把未实现能力宣称可用。
3. 后端需继续：官方 LangGraph interrupt/Command.resume、waiting/checkpoint 恢复、Code PG fail loud、GraphInterrupt 穿透、精确 child 停止与后台终态；Code 不依赖名称/顺序兜底。
4. 设置写入/原市场与插件服务、模型选项执行、Gemini 适配、真实 before/after diff 与完整长输出引用仍未完成。BYOK 表单保持原件，成功保存后只清对应未继续编辑的 key 草稿，服务端不回传 key。
5. Code store 恒为 coding；原 office 菜单仅导航 Design。Footer 云登录/账户/套餐及购买查询已按真实平台能力隐藏；模型设置预置云账户/套餐导航与无模型套餐提示也已从原组件装配按 supportsCloudAccounts 隐藏，停止云凭据/权益查询，原 BYOK 配置/刷新保留。自动化/浏览器控制等不可用入口仍待真实能力显隐，不能认定全局显隐完成。
6. 原版同场景截图/交互、GLM 工具链锁定回归、旧 Code 清零、Design 回归、完整 pnpm test/typecheck/lint/build/API spec 与 Apifox AI 分支仍必须完成，之后一个完整 PR。

### 供应商设置宿主的已核实前置契约

原 `IProviderSettingsService` 方法面必须完整接入，不能用现有执行模型目录代替设置候选。固定版本的原 `ProviderSettingsFacade` 在 `packages/provider/src/facades.ts`，草稿写入语义在 `config-service.ts`：

- `createPersonalProvider` 立即持久化无凭证/无模型草稿并返回 `{providerId,view}`；未完整配置仍显示在 Settings，执行 Registry 只收完整可执行项。
- 保存稀疏 provider overlay，保留未编辑叶子；omit Key 保留旧凭证，新 Key 加密替换，明确 clear 移除凭证。所有读面、通知和 mutation response 剥离 Key 与 headers 值，返回真实 presence；禁止伪 Key/星号占位。
- 模型 add/rename/delete/reorder/enabled 和 `savePersonalModelDraft` 更新成员、顺序、精确配置必须原子化；`basedOnRevision` 作冲突检测。删除后迟到保存必须拒绝而不重建。
- Settings View 的 revision 是整个 workspace Registry 的单调修订，持久 mutation 成功后推进，commit 后广播相同 View；没有配置变化的 refresh 不增修订。禁止 Date.now、数组长度、各实例 revision 求和。
- 原 Key 表单依赖旧明文作脏比较，宿主不回读后必须在原组件增加最小 presence/明确 clear 接线；不重新手写供应商 UI。

KenFutWork `modelProviders` 持有身份、workspace 隔离、加密和真实实例库，扩此聚合承接上述语义。草稿切片已新增前向迁移 `20261002210045_provider_draft_registry.sql`：凭证允许真实 NULL，读面 hasCredential 反映实际配置；workspace 修订随配置写入同事务推进，探测缓存及同值写入不推进。原宿主已接无 Key/无模型的创建、读取、刷新和删除。既有 HTTP create/update 仍要求完整实例；完整原 overlay、模型原子操作/CAS、顺序、通知和凭证 clear 继续实施，不另建明文 ZCode 配置文件或第二套模型真相。原 `providerFacades` 的原样 serializer 会含 Key，不能直接跨网络返回。

草稿公开 RPC red（未实现时 501）→green 已在独占临时数据库验证，含创建/删除 revision +1、读取/刷新不增修订、不可执行和凭证不回读。72 条迁移空库重放、历史 SHA、二次 no-op 和实际可空字段检查通过；server 1478 回归、server 类型检查与 25 项 workspace/API 门禁通过。该切片只证明空草稿链路。

后续快照/通知切片已将完整实例配置与 workspace revision 合为单一 MVCC 查询；模型目录只补该快照的元信息，不二次查询实例。原 Settings 保留停用供应商与模型，Selection 按实际启用与凭证资格过滤。create/delete 提交后向 owned SSE 广播原两服务的 `onDidChange`，数据与 mutation response 同源。两条新增公开宿主测试分别从缺失通知、误把停用模型标为可执行的 red 到 green；包含同值保存不推进修订。其他保存入口的事件、全量 overlay/CAS 与原表单仍继续实施。

Provider 保存切片已接 `savePersonalProviderOverlay`，复用原 ProviderConfig parser/overlay，保留 API 格式、品牌、Key 管理地址及未编辑字段。前向 `20261002215830_provider_code_settings.sql` 只保存非敏感扩展叶子，DB 约束禁止 Key、headers、endpoint、模型成员在扩展列复制，原规范列仍唯一属主。显式 Key/null 清除与 headers/null 清除、真实 credentialConfigured、提交后原通知和删除后迟到保存 404 已通过公开接口；原 Key 组件 presence/明确 clear 与模型完整操作/CAS、模板基线仍继续。73 条空库重放、历史 SHA、二次 no-op 和实际 schema 约束检查通过，迁移执行后不可修改。

原 Key 控件的宿主接线已完成：原 Input/Button、卡片/投影/稀疏保存链保留，增加可选 credentialConfigured 与原按钮的明确 clear；不返回旧 Key、不用假星号。按 Key 草稿修订和 providerId 只清成功提交且未继续编辑的字段，失败、重试、迟到应答不覆盖新草稿。原模型/Provider/View 类型从 packages/shared 直接导出；9 处允许偏差逐项登记，3051 来源校验零漂移。原组件操作 red→green 及三项回归、全量 pnpm test/typecheck、原 UI 构建通过。隔离真实数据库的完整原页面验证创建→保存→空输入/真实 presence→clear→刷新；截图见 `docs/验收/Code模式ZCode/原供应商只写凭证.jpg` 与 `原供应商凭证清除.jpg`，仅使用无外部效力的测试文本，未验证模型执行。模型原子操作/CAS、模板基线与全局能力显隐继续实施。

完整模型设置/错误横幅的云能力显隐：沿原 ModelProviderSection、导航/权益 Hook、套餐入口和 ChatErrorBanner 判断宿主能力，未提供云账户时不展示预置账户/套餐、不查询凭据/权益、不显示“正在查询套餐”，保留原自定义供应商及配置操作。没有声明能力的原宿主仍保留原套餐入口语义。两项原组件操作 red→green，Web 374 回归/类型与原 UI 构建通过；真实完整页面截图 `docs/验收/Code模式ZCode/原设置云入口隐藏.jpg`。此证据不覆盖自动化/CUA/远程等能力。

原模型解析/添加宿主切片已接 resolveModelConfig/addPersonalModel。原推荐 JSON 内容不变，移到 modelProviders 域；原 ModelConfigRules 负责精确/手动合成。配置与模式标记保存于实际 models 成员，不另存一套 UI 模型；运行侧容量由同一规则推导。公开接口覆盖原通配推荐 200000/32000、个人覆盖 256000/8192、Unicode ID、刷新恢复、并发成员不丢失、同键一次成功/409、删除后迟到添加 404。六项供应商/模型 integration、server 1478 回归/类型、25 门禁、3051 来源校验通过。此切片未证明原模型保存/CAS、启停/改名/排序/删除、指定模型测试或真实模型执行完成。

只读审计基线仍为 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`。上述缺口说明当前模型读取冒烟不证明原设置写入完成；服务接线验收必须覆盖空草稿→模型配置→写 Key→真实 executable、清 Key、删除最后模型、并发/CAS、通知和刷新恢复。

原模型草稿保存/CAS 切片已接 `savePersonalModelDraft`：改名、精确规则和成员位置同事务写入，保留兄弟模型；所有 HTTP/原宿主配置写入口统一先锁 workspace revision，再修改实例。公开宿主从 501 red→green，验证原成员改名与 260000/9000 配置、同修订重放/并发、跨供应商过期修订及目标重名均不部分写入。七项原供应商/模型 integration、server 158 文件/1478 回归与类型检查、25 workspace/API 门禁通过。恢复智能规则的空配置语义、独立成员操作与指定模型测试仍未完成，不能认定模型设置完整。

恢复智能规则已补齐：仅导出原 `isStructurallyEmpty` 供宿主复用，原函数不变，偏差登记来源清单；recommended + 结构空配置不持有个人精确规则，Code 模型身份仍保留，继续从原推荐推导容量。同值重存不增修订，手动空配置仍按原 schema 拒绝。公开接口 red→green 与八项供应商/模型 integration、server 1478 回归、全量 typecheck 通过；原完整模型弹窗实际完成添加 260K→重置表单→保存 200K→刷新，截图 `docs/验收/Code模式ZCode/原模型推荐恢复.png`。此证据不代表启停/删除等剩余模型操作和真实外部模型执行完成。

### 验收进程与文件审计

- 本任务临时 API 3301、生产静态 preview 3300；只连接现存开发 PG，不管理其生命周期。开发主服务监听源码变化时可能停/起 PG 并换端口；临时回环转发 3332 跟随当前 PG 端口。临时脚本位于 `/tmp/ken-code-api.mts` 与 `/tmp/ken-code-db-proxy.mjs`，不入库；先检查实时监听再使用，PID/exec handle 不作为长期事实。
- 公开接口命令：`RUN_CODE_UI_INTEGRATION=1 RUN_CODE_UI_MODEL_SMOKE=1 CODE_UI_TEST_BASE=http://127.0.0.1:3301 CODE_UI_TEST_ORIGIN=http://localhost:3300 pnpm --filter @kenfutwork/server exec vitest run src/features/code-ui/host.integration.test.ts`。测试临时建项目/目录并归档清理。
- 前端浏览器验收目录 `/tmp/ken-code-ui-browser-6T6wxE`（临时项目 id `f6387289-4da8-44c2-ac94-96aea078984a`）尚保留供后续交互，需要结束时清理；不恢复或迁移其他旧调试数据。
- 本轮审计发现 121 个 `apps/server/data/checkpoints/` 影子 Git 运行文件并补忽略；约 3109 个新增/修改源文件与必要资源应入库。dist/types/host/design 编译产物、node_modules、public/code-ui 静态产物、.env.local 已被忽略，凭据模式扫描 0 匹配。不能忽略原源码、图标、许可证、契约、来源清单或前向迁移来减少文件数。

原模型启停已接 setPersonalModelEnabled，事务内只叠加最新 enabled，保留手动/智能模式与全部精确叶子；停用成员仍在 Settings，移出 Selection，同值保存不增修订，未知成员 404，非法布尔 400。公开接口 501 red→green 与九项真实 integration、server 1478 回归/类型通过；原开关实际停用并刷新仍未选中，截图 `docs/验收/Code模式ZCode/原模型停用.png`。改名/排序/删除、连通性与其它设置仍继续。

原模型删除已接 deletePersonalModel：同事务删除成员与精确规则，保留兄弟模型；并发删不同成员不丢失，刷新不复活，迟到的保存/启用及重复删除返回 404，非法空 ID 400。十项真实宿主 integration、server 1478 回归/类型通过；原删除按钮实际删除最后成员且刷新仍为空，截图 `docs/验收/Code模式ZCode/原模型删除.png`。临时 API 重启后原 SSE 连接关闭仍需手动重载，此缺口尚未修复，不能计为断线自动恢复通过。

通知恢复前置策略已接：新增前向 20261003035733_code_ui_reconnect_setting.sql，workspace_settings 库值优先于 env/default，原 hello 不改，宿主 ready 单独提供 reconnectDelayMs。公开宿主测试覆盖真实持久化、刷新、ready 读面与非法范围拒绝；74 条独占空库重放、历史 SHA、二次 no-op 和实际 schema 约束通过，迁移执行后不可修改。

API 单源链已生成 SSE 媒体类型与完整原快照引用组件；不裁剪原契约。Apifox 批量导入曾因内联原快照过长失败，改为原 snapshot/row/toolCall 实例的复用引用后，同一 AI 分支 ai/20261003-from-main-code-ui-recovery 最终接口/schema errorCount 均为 0。该分支主线合并仍需用户确认；并不代表整个 Code UI 验收或 PR 完成。

HTTP 通知恢复接线已完成：物理断线先转原 unavailable，新连接沿同一客户端握手、刷新原两种模型 view，再转原 restarted/available；原 transport 与 SessionDataLayer 自行清 ownership/重订阅。四条宿主测试含同主/子连接、独立恢复、子面板释放、认证失败和关闭取消；原组件的外部 HTTP 夹具补真实通知握手，没有改组件。全量 web 378 测试/类型、原 UI 构建、3051 来源核对通过。真实页面主动切断一条预览通知流，在离线窗口更新供应商，原设置页无需重载/刷新便追上最新 view；截图 docs/验收/Code模式ZCode/原通知断线恢复.png。此证据不代表实际 Agent 运行断线、全部命令对账、长会话或视觉全矩阵已完成。

原 DirectoryBrowser 的 readdir 已接真实 FS 元信息；原组件、隐藏开关、错误显示与图标保持原件。共享接口导出原 FileEntry 和参数 schema，宿主复用既有 Project 本机路径校验；不放宽正文读取的归属边界。公开接口 501 red→green，十二项宿主 integration 通过，包含隐藏/Unicode/空目录/符号链接/损坏链接和不可用路径。真实原弹窗导航及隐藏切换已实证，截图 docs/验收/Code模式ZCode/原目录浏览.png。目录选择后的 Project/主画布绑定、最近项目写入与实际 run 工作目录继续实施。

目录绑定切片已接原 platform.activateOrSetWorkspace → workspace.open → Project 聚合与固定主画布。真实路径规范化后按目录身份复用；冷并发、目录 symlink/.. 别名同一项目，同名不同目录各自独立。recentProjects 沿原 setting 接口持久化，过滤已归档目录，非法归属写入整条拒绝；前向迁移 20261003060836_code_ui_recent_projects.sql 已执行，禁止改写。原 DirectoryBrowser 仅拓宽异步宿主回调并沿用原 loading/error 状态，原 Root hook 可把选择错误交回宿主，失败不关闭弹窗。源码偏差登记且 3051 项零漂移。

十三项公开宿主 integration、原组件失败/重试 red→green、pnpm test（15 任务；web 64 文件/379 测试）、pnpm typecheck（12 包）及原 UI build 通过；独占临时库 75 条空库重放、历史 SHA/缺失零漂移、二次 0 条与实际 text[]/NULL/default 核对通过。原完整页面中文目录选择、刷新恢复、归档错误保留弹窗实证见 docs/验收/Code模式ZCode/原目录项目绑定.png 与 原目录绑定失败.png。两根真实会话共用该主画布已通过，实际活动 Agent/child 工作目录与工具运行尚未验证；整体目标 active。

当前验收使用本任务独占临时 Postgres/API 3341，经回环转发 3301 与静态 preview 3300 接浏览器，不管理共享开发 PG。临时数据和脚本不入库。工作树审计的剩余源码、测试、迁移、文档、许可证、截图及参考指针应入库；依赖/构建/本地凭据/运行数据已忽略。并行 Agent 的 README/许可证/调研与参考指针不由本切片代提交。

宿主能力显隐已接原平台接口：当前未接通的自动化/嵌入浏览器/CUA/远程工作区明确关闭，原组件、设置分区、统一远程门与 CUA 前置平台门消费支持态。自动化的原侧栏、分组入口、主视图、草稿/行上下文回调、Cron/OffPeak 跳转按钮和闲时通知轮询均受门控；保留工具结果正文与全部原实现供后续接通。原设置隐式跳转到隐藏分区保持当前可见页；未声明能力的原宿主语义不变。原接口/schema 从 shared 直接再导出；10 处偏差登记、3051 来源零漂移，原装配/CSS 不变。

原完整 App 与原组件用户操作 red→green 覆盖额外闲时查询、Windows Web CUA 插件查询、工具卡按钮、设置跳转及默认宿主点击。pnpm test（web 381 测试）、pnpm typecheck、原 UI build 与双轴审查通过；真实页面证据见 docs/验收/Code模式ZCode/原能力显隐主界面.png、原能力显隐设置.png。完整 lint 的既有 Agent/Computer Use 错误仍未通过；插件市场/设置服务、核心运行交互、活动 Agent/child、完整视觉与 Design 验收继续，不以能力显隐代替完整接线。
