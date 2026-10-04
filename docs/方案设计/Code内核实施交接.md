# Code 内核实施交接

> 2026-10-04，Goal active，按用户要求分模块提交并准备合并UI。此文件是施工交接，不取代实施规格或服务key权威表。下方较早状态与“未commit”均为历史取样；最新状态以本节为准。现存数据库未执行新迁移。

## 2026-10-05 主工作区并行施工（当前唯一入口）

- 用户要求停止独立worktree施工，现已将内核分支快进整合到主checkout：`/Users/shigaoyu/Develop/KenKenDev/KenFutWork`，分支`codex/完整移植ZCode-Code界面`，功能合并点`6f5fd45b`。提交树与旧内核分支完全一致，无冲突；包含先前双亲UI合并`b234f8f8`，双方正确修改和删除均保留。旧`code-harness`工作树保持干净、停止编辑，不再作为施工入口；`main`及`啃啃在开发`未切换或修改。
- 已通知“重新设计用户系统”线程（`01a107eb-b461-7eb2-958a-9ebc564bc28d`）共用上述目录与分支：本线程负责Code/Harness与原UI能力接线，另一线程负责用户系统。涉及auth、viewer/bootstrap、persistence、shared、profiles或内核类型的共享hunk先协调；显式路径暂存，不替对方提交，测试单实例。
- question首RED测试已原字节搬入主checkout，初始SHA-256一致；随后仅修正它的协议导入到现有shared公开入口，主区类型检查通过。broker/tool/答案消费者尚未实现，不把该测试草稿当能力完成；当前不由冻结的旧Agent继续编辑。
- 主checkout依赖已用`CI=true pnpm install --frozen-lockfile --offline`同步；初次类型检查读到旧shared声明，强制`pnpm exec turbo run build --force`后13任务成功，再`pnpm typecheck`13成功。来源3027项零漂移；合并前全test16成功、模式拒读拒写真实HTTP4GREEN。收据`/private/tmp/kfw-main-checkout-{install-final,build,types-final,source}.log`与《日志》一百一十六。未push/PR/运行库迁移，完整Goal active。

## 2026-10-04 提交冻结与UI合并入口（最新）

### 合并验证收口（优先于下方冻结取样）

#### 合并后原UI接线进展（最新）

##### 运行初始化拒绝与迁回主工作区（2026-10-05）

- 旧POST启动消费者已接Store新语义：显式activate或Scoped hydrate真实失败均503，不能吞错按默认agent创建Run。真实PG读/写拒绝各RED→GREEN，公开组合4GREEN；registry/spec与Apifox独立AI分支同步见《日志》一百一十五。AI分支未合主，历史3条退役接口的审阅清理另行完成。
- 用户最新指令：此模块提交后快进整合到主checkout的codex/完整移植ZCode-Code界面，之后停止在code-harness worktree编辑，与用户系统线程共用主工作区。question仅首真实RED、无生产broker；测试草稿保留并迁入主checkout。完整Goal active，后续施工位置以合并回执为准。

##### 可信执行模式指导接线（2026-10-05最新）

- runtime以已接受Run与scopeHandle描述提供pre-step事实（实际runId/preset/workspaceId/taskId/sessionId）；agent-modes在Code输入前await Scoped hydrate恢复原指导。真实内核+PG+Harness冷服务与同Task真实分支换thread/冷Kernel2条GREEN，最新HumanMessage含goal，不靠历史前缀假绿。V4工具权限仍是唯一执行授权，本轮只恢复指导，无新事件/key/runtime。
- 组合27GREEN，全test16/types13/build13、owned11路径与docs通过，来源3027零漂移；全lint仍20个历史error。详见《日志》一百一十四。下一结构化提问沿原协议接真实答案消费者、取消与刷新，未将unknown已处理ACK计为成功；完整Goal active。

##### 执行模式持久化与缓存收口（2026-10-05）

- 沿既有agentModes实现，Code不经Canvas join；Project/Workspace复合归属、stable session/current native thread双入口、冷恢复与真实编辑换绑均经独占PG验证，old alias无效。Scoped hydrate读权威存储，foreign miss不借owner暖缓存；save反馈真实受影响行，零行或DB失败不发布新缓存。Design/Flow六档保持。无新迁移/服务key/模式枚举。
- Store/cache真实6条与既有Service19条、下一指导2条组合27GREEN；全test16/types13/build13成功，来源3027零漂移，全lint仍20个历史error。证据与具体命令见《日志》一百一十三。模式存储不等于V4工具执行授权，可信pre-step消费已在上节独立接线；完整Goal active。

##### 原行内编辑与上下文分支接线（2026-10-05最新）

- 原editUserQuery latest-realUser/idle/preserve已真实HTTP与原行内组件验证：native分支成功再切Task，线程/state/输入/ACK原子保存，同目录、权限冻结、editRerun/rootSource来源与重放保持；绑定事务失败保旧正文/文件、清未发布target，不执行新模型。SDK普通/Delta/tool messages、完整祖先、占用与lease/部分put故障见《日志》一百一十二。系统Prompt/工具/GUI原链不仿写。
- 仍需完整history其它分支、workspace rewind/retry/fork、guide、question broker/tool/答案消费者、子停止及全部插件/跨平台/视觉回归。原question协议/组件已在，本树resolve仅permissions，不能把unknown已处理ACK当回答成功。通用agentModes的Canvas join已由下一持久化切片修复，Code按Project/Workspace直接存储并在换context thread后恢复，详见上节；可信模型指导亦已独立接线，不能以V4权限mode保存代替。

##### 可靠持久化与释放接续（最新）

- 历史控制前置持久化实际故障已修：明确配置PG却初始化失败不再Memory fallback，真实Harness模型不执行、run.failed；原服务共享单初始化promise顺序建SDK资源，部分失败清理后可重试。dispose由agent-runs插件的释放栈持有；关闭拒绝新getter、等待在途初始化、幂等释放SDK连接，CodeUI夹具不再强制get或手工end/stop。真实RED/GREEN与独占PG组合6条（本模块5/队列1）、全test16/types13/build13成功详见《日志》一百一十；来源3027项漂移0，全lint仍20个历史error。未将此前关闭延迟归因为此问题。
- 原Goal仍active；当前修复不等于history consumer已完成。下一独立模块沿最新realUser的idle preserve编辑，先接原生context恢复与真实durable ACK，再打开原canEdit，不从UI DTO或隐藏subagent凑分叉。

##### 原队列公开与实际页面收口（最新）

- 合并后原UI队列编辑撤回、指定项立即抢占、Stop暂停、刷新恢复、继续真实消费与最终停止均有实际页面证据。独占HTTP/SSE/PG与真实Harness新1条通过，另锁重排、输入身份、stale revision与duplicate无二次效果；测试脚本与截图见《日志》一百零九。未把拖拽鼠标操作/guide当成完成。
- 历史控制只读核验：原三命令/回调保留，服务尚无consumer，行action未开启；fork总availability仍需随真实实现修正。下一最小切片先可靠持久化，再idle最新realUser的preserve编辑，原生上下文restore与文件/branch/ACK逐步接通，不用flat DTO或subagent替代。

##### 默认Task真实恢复收口（优先于下方较早样本）

- 真正跨模式试验暴露local qualified身份被原远程启发式漏存tab、共享迁移丢Q、后端Q焦点当path、侧栏强制remote折叠及本机精确services绑定回退base。统一parser与原pure resolver修复，Q只取自身绑定并local；缺绑定等待，旧无identity才base，不削弱remote或同路径Project隔离。后端由真实Project/Task规范化唯一Q，legacy有证据才升级；Task固定A/Project新B、recent归属与invalid/archived原子保护均保持。
- 公开Root 4与metadata/config/lease 19、偏好16均GREEN；独占PG3GREEN；最后串行全test16成功（shared90/web453/server1871、174默认skip、Unhandled零）、types13、build13通过，来源3027漂移零，当前10登记source copiedSHA已刷新。全lint20个历史error未代改。源码/测试/文档为单一恢复bug切片，原checkout/UI分支未改、未push/PR/运行库迁移。
- 实际新预览重演：默认Task发送/真实流/停止，Design→Code之后Task侧栏仍可见，原Task转录与已停止可读，第二次刷新自动恢复。截图在《日志》一百零八。Design矩形实际绘制与刷新保存、助手真实发送/取消/转录恢复亦通过；此前未观察图形是坐标落在属性面板/未到桌面布局，不再作为未验收结论。两图视口不同，不代表全视觉1:1或Design全场景已经完成。
- 原Goal仍active。下一步沿已授权原协议逐条queue/guide/history edit-retry-fork/权限与提问/子停止真实UI，剩余插件agent-command-hook-MCP与技能执行消费者、默认SDK持久化silent fallback/partial pool、Project-before-Task readonly lease、附件lineage、真实外部模型与Windows实机、全部视觉/旧UI零残留/Design矩阵、Apifox与可审阅交付。不得用本轮真实停止或默认skip代替这些能力。

- 双亲merge已完成`b234f8f8`；原Root可选模型参数HTTP还原独立提交`151d8669`（实际浏览器横幅RED→消失，provider12GREEN）；独占HTTP/client/ProjectUUID/思考档位与真实根停止已独立提交`3f3b2a77`。后续源码继续按模块提交，未push/PR/运行库迁移，原checkout仍干净。
- 插件本轮只实现真实技能与版本描述，Registry→原list/describe→原DetailView同一读面。首候选/安装列表分别实际RED→GREEN，公开unknown/remote/symlink4GREEN；UI3GREEN仅为真实组件+外部HTTP/SSE契约补证，实际私有HTTP候选与根stop2GREEN另有证据，不能混称全插件组件已实现。其它agent/command/hook/MCP、author及技能运行消费者继续。
- 最终全量`pnpm test`16成功（shared90/web451/server1871、server171默认skip、Unhandled零），`pnpm typecheck`13成功；server build与owned10路径Biome无error，来源清单保真。全lint20个common-base错误仍在。收据`/private/tmp/kfw-code-ui-wiring-{full-test,types-final,server-build,owned-lint}.log`、`/private/tmp/kfw-code-isolated-http-green.log`、`/private/tmp/kfw-plugin-detail-ui-final.log`。
- 新独占HTTP夹具真实viewer→SSE/hello→ProjectUUID→preferredSelection→run/stop，客户端退出明确await reader.cancel/releaseLock与app/native/PG关闭；没有force-close/放大timeout。此前79s关闭和首次候选超时不计GREEN，阶段trace无证据，不能声称确定根因。旧stop5例/其它外部DSN矩阵尚未迁移。
- 浏览器独占预览：原Root真实输入/Task建立/流式文本/原按钮停止到“已停止”通过；Design创建项目、canvas iframe与真实两层Excalidraw及助手侧板仍装配，未被Code对话替代。矩形绘制尝试未观察到图形，未计绘制/持久化GREEN，也未据自动化坐标单独判产品故障。全视觉/完整Design回归仍待完成。
- 关闭审计另发现历史AgentPersistence首次读并发建SDK schema、失败静默退Memory且部分pool无清理。这是源码事实、尚无本轮故障归因；后续按公共Harness+数据库边界验证真实durability/生命周期，不把本次描述或fixture切片扩成混合重写。

- 已先完成17批提交，冻结ours `6e746f55`，再以双亲merge整合UI固定提交 `29fb8c09`。保留原Root/主子SessionPane/renderer、品牌与资源删除；保留Task UUID/Project UUID、固定根、权限代际、配置租约、附件/终端和Code无Canvas。原checkout未编辑/切支；尚未push/PR，Goal仍active。
- 偏好只保留`code_ui_preferences`/workspace-rpc，模型只保留`compat.codeUi`与实例CAS；删掉无consumer的第二settings/config helper，双方历史SQL原字节保留。根锁内登记Run同时检查ready/activeRun/授权与分支代际及canonical输入；插件串行变更、等待restore/disposal/shutdown与失败贡献物保留同时生效。
- 合并首全量4失败及1未处理异常均已修复：显式清空API后原SDK端点校验同时约束选择器与运行快照；旧SQL夹具识别实际insert/update而非事务begin；畸形卸载拒绝且库存无副作用；搜索授权复验期间撤销的真实取消窗口actualRED→GREEN，在创建流前拒绝已中止signal并等待文件/子进程收尾。窄回归77+21通过，未skip/吞异常。
- 最新`pnpm test`通过：shared90、web449、server1866（170默认跳过），16任务成功且没有Unhandled；`pnpm typecheck`13任务成功；`pnpm build`13任务成功，包含原Code/Design两bundle；`pnpm api:spec`、`pnpm test:docs`通过。日志`/private/tmp/kfw-merge-{test-final,types-commit,build,api-spec,docs}.log`。3027项ZCode来源零漂移；Kimi明确登记源码逐项SHA验证，不批量格式化第三方。
- 独占临时PG验证5条：V4 compact FIFO、真实文件rewind、真实卸载/缓存与加密数据、Controller固定Task根、设置与归档竞争；另TaskWork真实库3条含全迁移重放和二次no-op。日志`/private/tmp/kfw-merge-private-pg-green.log`、`/private/tmp/kfw-merge-pg-replay-green.log`。未连接现有开发库、未执行运行库迁移。
- lint仍须区分基线：本Goal新增与merge第一方格式/import已整理；Computer Use与两份历史Web文件保持common base原字节，现存20个错误尚未修，不能称全lint绿色。原源码与版权按来源SHA验证。旧Code已删资源静态import零残留，不等于全视觉验收。
- 新UI分支若干默认skip的HTTP integration仍使用目录替Project UUID/旧Canvas或缺ClientHello，公共fixture默认3001且stop会直接锁外部DSN；不能以skip当GREEN，也不放宽生产身份来迁就。后续先显式client+独占PG/buildApp/随机端口，再验证原UI命令。describe/list真实组件发现、edit/retry/fork/guide、子停止/权限/队列完整UI、全视觉与Design回归及Windows实机仍待完成。

- 用户要求先提交全部暂存/未暂存/未跟踪工作，按功能模块分批，之后合并固定UI提交 `29fb8c09c03e99bd55d60ea491dfbda076f1eae1`，由本线程统一继续。原checkout该分支干净，只在隔离 `codex/重构Code工作域与工具内核` 操作；尚未push/PR。
- 已按源码许可、契约/依赖、存储、Task/文件、沙箱/PTY、后台任务、审批、扩展/释放、供应商、检查点、附件、Harness、原UI、Code宿主、装配与测试拆分提交。逐批日志在《日志》末尾；不得把多个模块重新压成一个大提交。
- 冻结工作树 `pnpm test` 与 `pnpm typecheck` 全通过，日志 `/private/tmp/kfw-precommit-all-green.log`、`/private/tmp/kfw-precommit-full-types-final.log`；`pnpm api:spec` 与文档门禁通过。真实native/PG/V4FIFO压缩、完整文件恢复与独占临时PG重放证据继续有效，运行库未迁移。旧OpenAPI3失效注册已按本次“正确处理删除与提交”授权清理，不补假schema。
- 全量门禁补证修复：旧shared检查点/供应商夹具、路由startup空库端口、Web原provider/casing/可选接口、原生Responses断言、Git upstream真实fixture；真实PTY晚订阅丢尾部已actualRED→GREEN，沿真实offset/seq有界补交付，exit等待drain且幂等。没有把夹具回压调整当新产品修复。
- 两份施工规格未实现且不计GREEN：Darwin系统Git实际路径首test明确skip；插件uninstall integration默认显式PG门禁，尚无生产action。UI分支另外的describe integration亦是已确认501的未完成项。merge时保护双方测试意图，不能因已入库声称能力完成。
- 原UI交接已读：主链替换完成、不是所有操作/1:1验收完成。merge必须保留原Root/主子SessionPane/renderer/品牌/资源清理，同时保留新Task/权限/Harness权威。原分支的旧Canvas后端不能带回。后续继续queue/权限/结构化提问/子停止/历史控制、终端/文件、插件详情等真实消费与Visual/Design回归；Windows实机、Project-before-Task Git及真实guide仍待验。

## 2026-10-04 手动维护与插件消费接续（最新）

- 原UI最新审计固定 `eef278394714ffab4d416503fa5b1f1a37025315`，只读Git对象；相对前一固定 `ea3b79ec` 共4文件，新增规范化bundle ID、第一方恢复策略及真实重启测试。原树dirty文件未取入。不得整体覆盖registry，donor仍有不等待unload的路径，会丢失本树awaited disposal/失败保留。
- 原compact进入canonical FIFO并复用同一前台运行身份；仅产生manual运行标记，不造Human/turnHeader。实际公共RED→GREEN修复完成后原标记不结束/多造auto标记，以及noop/failure/cancel仍running；原成功/无变化/失败/Stop取消均接同一marker，维护通知归task_status_changed。输入18+会话11共 **29 GREEN**，`/private/tmp/kfw-code-compact-outcomes-green.log`。真实native compact/PG与CodeUi FIFO组合仍在验证，不能用LLM边界替身证明原生提交完成。
- 插件库存adapter真实example-clock与registry **5 GREEN**，损坏JSON/schema明确拒绝而不发假空或覆盖原磁盘。Root主消费HTTP实际RED501→接CodeUiPlugin既有plugins注入→两文件 **6 GREEN**，`/private/tmp/kfw-code-plugins-host-consumer-green.log`。user机器库存不读/创建Project、Task或执行scope；携带target使用既有真实Project/固定Task根只读解析。三写动作、规范化ID/策略、串行持久化与启动关闭生命周期仍下一切片，未声称已完成市场。
- 原UIworkspace-config消费者全9及相关四文件共 **23 GREEN**，新在线完整态取代恢复帧后旧flight阻塞下一恢复的实际RED已修；pendingACK末lease回收、source失败与显式重读、同Project共享/同根不同Project隔离均通过。vendor+host types与真实UI build exit0，6owned固定source/copy SHA一致，收据 `/private/tmp/kfw-workspace-config-consumer-final-public-green.log`、`/private/tmp/kfw-workspace-config-ui-final-{types,build}.log`。旧下方2/4/6条状态为历史，不作为最新验收。
- Goal仍active；历史edit/retry/fork、真实guide、附件lineage、Project-only Git、真实账户/模型/浏览器与全量门禁仍未完成。旧OpenAPI3/Git写/旧转录物理清理的精确审批与Windows实机环境仍pending，不绕过或假成功。HEAD仍65d1097e，运行库未迁移，未commit/push/PR。

## 2026-10-04 最新完整控制接线（优先于以下历史状态）

- 原UI分支已更新，最新审阅基准固定 `5633106034e74b9320eafc1a2d5224947976b369`：相对3f5c共12文件，仅插件真实包库存bridge/registry/shared event/tests及回执。原树同文件还有未提交动作/授权与brand/assets工作，严禁整体复制moving/dirty文件。file负责只读库存增量审计，Root再接DSH真实权威，不带回Canvas backend或第二插件库存。
- 原V4 fileChanges详情已走私有原生完整canonical journal；卡片预算预览与完整详情分开。两非邻hunk真实Edit在卡片仅一hunk时详情仍完整两hunk，公共 **5 GREEN** (`/private/tmp/kfw-code-native-detail-full-public-green.log`)；提交journal私有PG **1 GREEN**（`kfw-code-native-detail-full-green.log`中该文件成功，公共3失败为缺defaultModel的夹具已另修），同run20k只读Read不占文件预算。字段、计数、Project/Task根、entity、epoch/revision均锁住，读取不造Run/scope。
- `file-history.ts`真实消费已有metadata pre/post与file journal，接原preview/apply；CodeUiPlugin注入既有checkpoints，没有新ctx key。恢复采用真实scope.backend.commitBatch+process/file双barrier；准备后beginRewindTask事务再检查epoch/revision，持久reverted事实与原命令ACK后才开放readiness，重放先命令回执而不再执行文件effect。缺provider给可读拒绝，缺捕获/日志/冲突给真实不安全原因，不截聊天。
- File preparer每条实际RED→GREEN后最终 **19 GREEN**（UTF16/BOM、partial update/add/delete、缺日志/引用、实体/CAS、外部或shell混入、预览后竞争、同/异Task真实process barrier、completion真实顺序、0600/0700）。Git仅保存exec位：现存文件保最终native observation权限，删除恢复仅owner600+owner exec，避免644扩大权限。原V4真实PG **1 GREEN** `/private/tmp/kfw-file-rewind-v4-current.log`：native tools→bridge→生命周期→stream→真实journal/metadata，preview/apply/cold聊天保持与reverted、旧revision duplicate不二次覆盖外部新文件、ready新generation/旧scope撤销，全部真实SRT/ShadowGitExec。Mac夹具gitBinDir使用xcrun发现的已安装实际Git；系统shim首失败是环境问题，尚未证明默认system Git profile无缺口。
- native durability/storage故障实际RED→GREEN **3 GREEN**：有checkpointer时adapter通过公开参数固定sync、显式checkpoint_id重读确认新summary；存储put拒绝仍run.failed、没有run.compacted与Unhandled，旧摘要复用/冻结ref正例保持。代价是每superstep等待持久化，SDK参数不露到产品层。accepted未消费取消actualPG GREEN、重复stream所有权actualPG GREEN（第二消费者不能释放首个活Run或写post）；真实Git无文件变化effective引用消费下一case待验。公共source回执见 `/private/tmp/KenFutWork-Harness轮次边界实施回执.md`。
- workspace-config producer与三原topic owned epoch/seq/lease fence **16 GREEN**；原Conversation/Index旧snapshot同样会全替换，已在生产发送端统一阻止迟到旧seq/旧epoch，合法新epoch归零与同seq recovery保持。逐订阅真实错误隔离并精确dispose，不发假空目录，initial读取中source更新重读已实证。CodeUI主consumer实际RED→GREEN **3文件30 GREEN** (`kfw-code-workspace-config-host-green.log`)：强握手/用户归属、真实CodeProject与固定Task根A来源，Project默认B不重绑，原presentation与配置frame共享commands来源。
- SettingsService深化原服务，新增只发workspaceId/changedKeys的onUpdated；成功保存/回读后再通知，插件消费defaultModel/commands变化刷新同配置source。provider原notifyViews也已刷新，失效订阅精确释放。Settings/HTTP稀疏更新/配置主consumer/owned lease组合 **5文件47 GREEN** (`kfw-settings-config-fact-green.log`)。未引第二设置/模型目录。
- 客户端配置消费现 **2 public GREEN**：原V4Pane/toolbar/真实typed agent/HTTP/store链，默认目录/模型/slash实时可见，当前Task选择保留；原prepare从同existing lease读完整态，三个真实调用点与main/pane共用entry，不造Task/Run。reconnect/resync/精确退订、旧lease与同根不同Project矩阵仍在下一slice，不能把两条通过当整体UI完成。
- 最新env扫描2362文件GREEN；本轮Root types/owned Biome仍在收口，旧OpenAPI3精确审批与Windows实机环境继续pending。整Goal仍active，manual compact/edit/retry/fork、attachment lineage、真实guide、Project-only Git、真实账户/模型/浏览器与当前全量门禁/迁移收据/PR仍未完成。运行库未迁移，HEAD仍65d1097e，未commit/push/PR。
- 后续最新：shared第三配置frame与冻结563两条插件读schema实际build GREEN；Settings新增onUpdated Definition所需Controller/MCP mock补齐，fixtureUnknown commands按原schema解析，Root本域类型零错；最新TSC只剩explicit新failure测试两条待修fixture错误与旧OpenAPI3（explicit已修两条，尚待最终再检）。最新env **2364文件GREEN**，Rootowned diff check exit0。根Registry/API退役审批仍未绕过。
- Core补证：actual native+PG failure/cancel **2 GREEN**（hook失败记录failed而非captured null，真正取消在post保存后才释放active），actualGit两轮无文件变化 **1 GREEN**（唯一旧checkpoint归首run，但两run各自phase/run均消费effective ref）。这两个证明现有正确实现，未伪造RED/多加补丁；日志 `kfw-harness-active-failure-cancel-public.log`、`kfw-harness-effective-files-public.log`。explicit已进入已授权manual compact的公共原生hook/graph operation seam方案，Root将接canonical FIFO与非用户行投影。
- UI配置消费者最新 **4 public GREEN**：初始metadata/source/currentTask隔离、完整prepare、断线重订阅、坏physical原typed resync恢复；no Task/Run命令重放、generation/decoder/barrier均回收。当前minimal准备3pane同Project共享/同根不同Project隔离与最后lease/pending ACK精确cleanup，未宣称全UI完成。file当前完成563冻结审计并开始仅两读插件库存adapter首TDD（新plugins.ts fail-closed骨架/单publictest待RED）；Root尚未接该adapter，不能声称插件市场库存已同步完成。

## 2026-10-04 最新接续（优先于以下历史状态）

- 实施树仍为隔离 `codex/重构Code工作域与工具内核`、HEAD `65d1097e`。原UI分支实时复核仍在冻结 `3f5c38732f151fa64e99856f456623b303dbe14e`，不覆盖其dirty修改，不带回旧Canvas backend。
- 轻量 `getTaskMeta` 先按Task读取，不依赖工作区全量会话枚举，不授予执行作用域。真实空Task已允许无模型创建，持久空model/thought且省略modelSelection；第一条sendText仍要求可执行真实模型。公共项目/输入/Controller组合最新 **3文件35 GREEN**，证据 `/private/tmp/kfw-code-no-model-task-{red,green}.log`。
- 三个人类目录创建入口（ensure/Default/Scratch）均返回真实CodeProject UUID+canonical目录；原UI三消费者使用完整DTO，拒绝非法UUID，旧Task固定根不重绑。偏好仍在code_ui_preferences，内部默认项目引用不公开。cold复用、archive失效与save失败已GREEN；跨host默认唯一性尚未实证。原Root标题/metadata/目录/Controller/channel最新 **6文件31 GREEN**，vendor+host类型/build exit0，证据 `/private/tmp/kfw-code-metadata-creation-{final-narrow,ui-typecheck,ui-build}.log`。
- 文件worker接通native工具display→bridge独立artifact→canonical公共事件→原toolOutputSchema→原ToolCallBlock。单文件真实Read/Edit、ApplyPatch两文件真实部分成功与第三文件失败、canonical/model不改、治理预算截断已 **server4文件26 GREEN / public UI3 GREEN**；UI类型/build exit0。最后truncated提示/来源收口仍持唯一测试令牌，随后归还explicit。Root负责原V4详情与file-only rewind公共消费链，不能靠row-level display union或展示补丁猜原文件。
- 实际Graph/MemorySaver两轮自动压缩：第一轮实际新Command.update写入并确认checkpoint，第二轮只复用已有摘要；实际RED→GREEN first=1/second=0，证据 `/private/tmp/kfw-compaction-reuse-{red,green}.log`。explicit继续RunService稳定Human身份、原生context history与现有agentRunMetadata ledger；新adapter/Harness组合仍待本次窗口验证。
- Root已准备原V4文件详情首public RED；minimal继续独立workspace-config producer接线。整体Goal active，仍待真实历史控制/附件lineage/steering/Project-only Git/当前全量门禁/真实UI模型环境验证。Windows缺实机；3个worktree OpenAPI退役、Git UI写RPC与旧原始terminal/转录物理删除的精确审批仍未解除。没有迁移运行库、commit/push/PR。
- 此后Root详情actual RED→GREEN已接原V4 fileChanges与turnHeader摘要；ApplyPatch部分失败仅计已提交两文件，revision/epoch/entity/Project/固定目录拒绝矩阵GREEN。FIFO的canonical输入身份与后台host.task-work持久命令身份首RED→GREEN接共同Harness，不以新runId冒充原输入；重复后台通知不增加Run。精确pre文件原始字节读取只materialize选定path，UTF16/BOM与真实工作文件均验证；详情/输入/snapshot/真实Git **4文件37 GREEN**，`/private/tmp/kfw-code-detail-input-snapshot-green.log`。
- 私有PG原生提交journal读取actual RED→GREEN **1 GREEN**，工作区/Task/Run归属、完整canonical保真、事件数/字节预算和删除后迟到读取均验证（`/private/tmp/kfw-code-file-journal-{red,green}.log`）。该文件随后新增afterCommit回执先落库再开放readiness的下一RED，尚未实现，旧1GREEN不替代此新增场景。Root尚未把安全file-only preview/apply接到V4；file已准备真实FS/精确pre/post/native Edit与两种restore barrier首slice，测试令牌目前归file，其完成后explicit runtime ledger GREEN、Root控制consumer按次序串行。
- 文件展示最后truncated首RED→GREEN：server26、public UI **4 GREEN**，UI类型/build exit0，6个owned来源SHA精确验证。版权通知CRLF按来源原字节保留，owned diff check通过；不能为消除全diff trailing whitespace而改版权bytes。native ApplyPatch delete.version是删除前版本，move.version是目标提交后版本且filePath为源，patch files没有originalFile/content；恢复绝不能误用这些字段或按UTF8近似。
- actual native contextHistory port **2 GREEN**，真实摘要有效消息、冻结旧checkpoint读取与最小白名单引用已验证。深化现有agentRunMetadata的record/read与前向`20261004010540_agent_turn_boundaries.sql`私有PG **1 GREEN**（全量replay/no-op、并发同值幂等/异值409、cold pre/post与跨actor拒绝）；RunService真正durable pre/post首RED已记录，runtime consumer实现待下一GREEN窗口。service key没有新增，仅深化既有agentRunMetadata；未进入graph的失败/取消只记录partial/unavailable，未知branch=null，控制consumer须拒绝。

## 2026-10-04 第二批界面接线（优先于下方历史状态）

- 继续完整 Goal，没有回到访谈阶段。唯一实施树仍是隔离 `codex/重构Code工作域与工具内核`，HEAD `65d1097e`；原 UI 分支只读保护。首批同步冻结 `e58fe8ce`，第二批只读增量冻结 `92fad1ca182fcdd224d5f8f0c15ab4202d7b8754`；原分支仍有品牌/素材等未提交修改，不能覆盖或批量取入。版权通知已按原字节同步（SHA256 `874bf7c10bdcadd0df0b50fc782f39f077669c6e41bbdbccd868409cd714dec3`）。
- 已离线补齐 `@zcode/window-controller`、server RPC/services 和 shared services workspace 依赖；固定原 Controller 的 7 个文件与 Apache LICENSE/来源记录入树。shared/window-controller 依赖拓扑构建通过。一个 Project 的旧 Task 根 A 与当前默认 B、同根的不同 Project 都以 `JSON([真实ProjectUUID,固定根])` 为独立公开 Controller/cache/topic 身份；服务端只匹配可信来源表，不解码调用方字符串授予权限。Project UUID 仍独立保存，原 `zcodeTaskMetaSchema` 新增 optional UUID 防止帧解析丢失该归属。
- Root新增 `controller-host.ts` 真实 readonly consumer：来源是可见 Code Project 默认目录与未删除根 Task 的固定目录（包括归档列表）；真实列表/排序/正文搜索与 sessions-index 来自现有 repo，没有 Canvas JOIN、运行或执行授权。每个人类通知连接一个 Controller，每个 source 独立索引连接与租约；source 不接全局 service 广播。主宿主匹配 qualified Task/Project，SSE/侧栏事件也保留该身份。原 Controller 首 source 分区、joined dispose、ACK前 physical wire observer 三个切片已 GREEN；外部 subscribe/resync/unsubscribe、refresh/来源变动/迟到租约回收仍由 explicit 继续，尚未完整验收。
- Root最新公共回归 **20/20 GREEN**：输入 FIFO/冻结模型/附件、队列 CAS/held/sendQueuedNow、连接用户、Stop 取消 reserved 输入以及已保存未启动输入、同一 publish 并发只能派发一次、真实 localhost HTTP 响应丢失后仍派发且重试不重放、Project 默认与 Task 固定根、同路径不同 Project 原 physical wire 组装、qualified Skills 归属、原元信息未选 thought 档位省略空字符串。命令：`pnpm --filter @kenfutwork/server exec vitest run --config vitest.config.mjs src/features/code-ui/input.test.ts src/features/code-ui/project-identity.test.ts --maxWorkers=1 --no-file-parallelism`；日志 `/private/tmp/kfw-code-root-publication-identity-green.log`。这不替代真正 Harness/数据库/浏览器全链验收。
- 客户端第一批恢复/能力/目录/identity回归先取样 31 GREEN/1 RED，发现原 UI 把 qualified identity 走 remote 分支；宿主通过原 RemoteWorkspaceSession 注册把可信本地来源绑定现有 HTTP services，再定向 2文件9/9 GREEN（包含唯一失败的 membership 与 schema parse）。没有声明远程云能力，没有 mutation/附件重放。file继续 direct Root 的三处必要宿主缝：激活目录返回 canonical target、新 Task 刷新 Project 默认、viewer 上下文先安装；不能整文件复制 donor main 丢掉固定 Task 根与真实 UUID。
- 偏好仍由现有 `code_ui_preferences` 一处持有，不取原分支第二套 app preferences 表。recent读写保序/去重/前10先实际 RED→GREEN，保存前验证全部引用（含会被截到前10之外的非法尾项，整条拒绝）；公开 settings-host/workspace RPC **13/13 GREEN**，私有PG归档whole-patch竞态+重放/no-op **1/1 GREEN**，日志 `/private/tmp/kfw-code-settings-public-current.log` 与 `/private/tmp/kfw-code-settings-archive-pg-current.log`。shared reconnect治理 **9/9 GREEN**，SSE ready 输出 DB ?? env ?? default 的实际延迟。默认空会话/默认/临时目录入口的真实CodeProject DTO与持久默认引用仍在下一slice，不能声称完成。
- Root最近完整server类型检查仅旧 OpenAPI 3 个失效导入报错，没有本轮 Controller/输入/HTTP 类型错误；本轮Root8文件Biome执行exit0（仓库既有 non-null 等警告未当成 error）。三个退役 worktrees API 的本地注册与生成描述清理再次向用户提出精确授权，仍等待答复，禁止 stub/alias/其它工具绕过此前自动拒绝。Git UI写 RPC、旧 raw terminal/转录物理删除、Windows实机环境此前的阻断也仍有效。运行库未迁移，未 commit/push/PR。
- 后续Root搜索全局计数 actual RED（2命中被source裁成1且hasMore=false）→移除source静默截断、在主宿主最终query用治理限额→输入/项目公共 **21/21 GREEN**（Root52505 exit0，`/private/tmp/kfw-code-controller-search-count-green.log`）。这是顶节20条之后的最新取样。Root3文件Biome最后exit0，types仍仅旧OpenAPI3；explicit原subscriber也actual RED→GREEN，实际原frame parser保留projectId与qualified address（`/private/tmp/kfw-controller-subscribe-green.log`），当前list/subscribe与observer/dispose已接。
- 原Root直接接入已完成：main删除自建WorkspaceHost，三个必要宿主缝与真实Project/Task/viewer、ensure DTO opaque identity消费接好；先4/4启动实际RED，再单独Ctrl+N A→B目录实际RED，最后**9文件34/34 GREEN**（`/private/tmp/kfw-code-root-client-final-narrow.log`）。同根两个Project不合桶，旧Task请求仍A；原vendor+host `@zcode/ui typecheck`、实际build均exit0。14个owned Root/守卫/IFile消费者来源记录更新，16个owned SHA无漂移；详见《Code界面阶段同步记录》（已登记文档地图）。这不是原生桌面/完整浏览器/后端全链验收。
- Human `ensureConversationWorkspace`真实入口首public实际RED→GREEN **1/1**（`/private/tmp/kfw-code-conversation-workspace-green.log`）：同workspace单flight、新factory/cold复用现有code_ui_preferences内部defaultConversationProjectId引用、返回真实CodeProject UUID与当前canonical默认目录，不创建Canvas/Task或签scope，不因recent get创建。公开setting隐藏并拒写内部ID。默认/临时创建入口仍仅path，完整DTO的下一public RED已准备未实现；默认引用archive失效/保存false和跨host原子唯一性仍待实证，不偷加第二真相或DB表。
- explicit原Controller refresh、owned resync/unsub及迟到source ACK lease都已实际RED→GREEN；正在当前独占窗口继续local搜索预算/权限错误fail loud与完整兼容回归，最终token尚未返。Root消费者尚须把refresh接到archive/delete/project源变化，不能只完成adapter不接线。Harness真实边界方案在 `/private/tmp/KenFutWork-Harness轮次边界公共接口方案.md`：深化现有agentRunMetadata ledger，不加空ctx key；稳定Human ID来自Task+client/source原输入，自动压缩只认本次实际Command.update且最终graph checkpoint已提交。runtime/deep-agent/ledger尚未改。
- Root私有PG `input-restart.integration.test.ts`已补reserved输入的真实持久回执与不重放断言，源码恢复分支此前已包括reserved；尚未跑本次新场景，不能沿用旧1GREEN证明它。下一Root窗口运行 `KENFUTWORK_CODE_INPUT_TEST_PG=1 pnpm --filter @kenfutwork/server exec vitest run --config vitest.config.mjs src/features/code-ui/input-restart.integration.test.ts --maxWorkers=1 --no-file-parallelism`，只创建临时localhost数据库，绝不读运行库凭据。
- **上述待验项的最新覆盖**：Controller公共完整 **10/10 GREEN**、production factory/真实repo/CodeUiConnections/全migration replay+no-op私有PG **1/1 GREEN**（`/private/tmp/kfw-controller-public-complete.log`、`/private/tmp/kfw-controller-private-pg.log`）。Root已实际RED→GREEN接archive/delete后的host.refresh，timeline正文搜索复用原membership谓词避免置顶重复；输入/主消费者/Controller组合 **3文件33/33 GREEN**（`/private/tmp/kfw-code-controller-consumer-public-current.log`）。reserved输入私有PG新3receipt/不重放/不同host隔离也 **1/1 GREEN**（`/private/tmp/kfw-code-restart-archive-consumer-slice.log`中该文件通过）；首次失败是foreign新Task夹具复用了旧Task的代际，被真实scope fence拒绝，已按真实repo描述修夹具，未放宽业务fence。该日志同轮archive消费者仍RED，之后33GREEN证明archive修复。
- Root最新完整server tsc仍仅旧OpenAPI3；Root本轮4文件Biome exit0、diff check exit0。新增Controller私有PG测试开关已登记，另补既有附件三个env（maxPerInput/retries/retryDelay）的登记与示例；`node scripts/check-env.mjs`扫描2350文件GREEN。没有运行库连接、迁移执行、commit/push/PR。
- 原分支又前进到冻结 `3f5c38732f151fa64e99856f456623b303dbe14e`（相对92实际14文件，先前git diff仅筛UI范围显示4文件，不能当完整范围）。file只审UI轻量标题hook/platform必要增量，不取donor旧backend/shared快照/截图；下一actual Root标题public RED已准备。token当前minimal Default/Scratch DTO边界；explicit已返token，准备本轮新压缩实际Graph loop第一个public RED。Root不改其runtime/deep-agent/ledger所有权；剩余整合与强审批/Windows阻断继续有效，Goal active。
- 测试始终单实例：最新 Root52505和explicit subscriber均exit0，token当前短租minimal默认入口slice；file directRoot4个真实原Root操作case已准备，explicit public refresh/源删改/错误fail loud尚待RED。后续继续真实 turn boundary/稳定模型消息ID/手动 compact/edit/retry/fork/files rewind。旧摘要出现不能当作本轮新自动压缩，现 emitter 仍待修。最后需要当前完整 workspace/server/web/shared/types/lint/build/license/source/env/schema/replay/no-op 与真实账户/模型/Design、非空网络和 Windows环境证据。

## 2026-10-04 接续状态（覆盖以下历史施工状态）

- Goal active。用户再次明确继续完整目标，并要求阶段性同步 `codex/完整移植ZCode-Code界面` 的持续修改；原 checkout 只读，仍在隔离 `codex/重构Code工作域与工具内核` 实施。同步审计固定原分支 HEAD `e58fe8ce029be5ea0462fdf9d6e8a3c599b05fe5`；该分支尚有设置域未提交内容，不能整文件覆盖或当作已完成交付。共享契约的原 `canvasId` 不得带回新 Code Task。原目录 `.codegraph/` 与隔离目录都没有可用 index，已先尝试 CodeGraph，未初始化。
- Root 接通纯附件 `sendText`、canonical 附件/clientId、私有可信 `codeInputs`。模型输入实证：文本 bytes 创建 Run 后不被调用端改写；图片尊重显式能力；PDF走原生文件或真实提取/页图路径，超过治理预算可读失败。共同 Harness 定向 11 GREEN；原 UI Completions `false` 优先于 Responses 探测的真实 HTTP 路径另已 GREEN。没有把 renderer 任意路径交给模型。
- Root 输入状态含持久 canonical intent、冻结 ModelInvocationSnapshot、scope/branch 代际及宿主 owner。忙时 FIFO、前台真实释放后原子消费、队列 pause/reorder/delete/edit CAS 已接；busy `requestedDelivery=startNow` 是先认领、真 stop barrier、再投影新轮，竞争认领拒绝。输入公共 5 GREEN 是加入 held 确认前的取样。held 全集合确认/clear/keep 已补 source，最新回归曾被新 terminal profile 缺链接阻断而未收 GREEN；离线依赖已成功补齐。`sendQueuedNow`、Stop 对 reserved 输入的取消、真正 guide 仍需继续；不可用 guide 当前明确降为 queue。
- 重启私有 PG 1 GREEN：同宿主旧 active/queued 回执标记 `fault.command.inputDiscardedOnRestart`，返回原 `inputDisposition`、保留转录、不重放，不改其它宿主 Task。后续新增 reserved 状态纳入恢复，须再回归。模型 dispatch 重新核 scope/branch，并将 admission mode 作为 approval ceiling。自动 `run.compacted` 已真实投影 auto marker；没有伪造 token 数。手动 compact/edit/retry/fork/files rewind 尚未接完整语义。
- 附件服务 lease loss/pending Begin 关闭 2 GREEN；真实 Task release/purge 私有 PG 1 GREEN，先关闭执行资源、revoking 精确代际只清自身 opaque blobs、UPDATE 最小墓碑，保留归档 committed 与外部 sentinel。Root 已接 branch/archive release 和 delete purge；beginClose 返回锁定的真实 generation。原运行库没有迁移或删除。
- 附件 renderer 三文件 15/15 GREEN：同 chip/Task uploadId 网络重放、chunk ACK 丢失不自动 Abort、显式取消后 Begin/Commit 迟到回执拒绝、手动新 attempt、runtime 中断不自动重发、ready 保留、旧 Task 预算回执不能污染新 Task、path-only 明确失败、实际 File 即便含 localPath 仍上传真实 bytes。九项有效预算由宿主治理查询，workspace-only metadata 不授予上传；Node/renderer同源。三层共享包与原 UI vendor/host declarations build GREEN，web tsc GREEN。原生可信 path import 仍待真实 seam，未接受任意 path ref。
- 原 workspace-installed Skills host list/toggle/buildPromptContext + Code loader/use_skill/resource_path 已接同 repo；不使用 Canvas JOIN，不给 Native Read 伪 `/workspace-skills` 路径，DB 资源走只读资源缝。本域早期 22 GREEN；Git/watch/prefs/Skills 后续 server 20 GREEN、原 channel 8 GREEN。readonly Git 的后续 untracked/ref 边界测试待重验。Root已接 Git/watch consumer、watcher Task/connection/revoke/Kernel cleanup、原 terminal profile preferences 与 server `@zcode/services` workspace 依赖（offline install exit0）。这不等于端到端宿主验收。
- Windows source：真实 ConPTY/private controller/预赋外层 Job、MXC/PSEC、严格 physical range-empty、双流 ACK/UTF8/EOF/tail。portable TS 8 GREEN + native ACK 3 GREEN，WindowsGNU cargo check/fmt/Biome GREEN，没产 v2 EXE，6 条 Windows 实机测试未执行。已异步请求用户提供 Windows 环境，尚无答复。Mac/Linux已完成证据见下文，未因 Windows slice 重跑。
- Root当前拥有唯一 test token；全部子代理本轮测试已结束。file 子代理只读审 UI 分支；explicit 只读审 Harness 历史控制；minimal已完成附件 slice。其它 chat 仍可能测试，Root已只读检查全机测试 PID 后确认当时为空，继续遵守全局单 runner。最新 Root 开始 `input.test.ts -t 同workspace其它用户` 的实际 RED（连接只核 workspace、需要真实 hello user binding），该 source 尚未修；worker已指出同 workspace 不能代替连接用户归属。
- 新自动审批阻断：Git UI 写 RPC 小 hunk 两次正常审查均拒绝，未应用。原有受控 discard/commit/push HTTP/Service 存在，但 review 仍要求精确用户授权；不能换 alias/HTTP consumer 绕过。保留 10 只读方法，8未支持方法明确错误。当前 Goal 未执行任何 worktree git commit/push/discard。原 3 worktrees endpoint retirement、旧 raw terminal/旧转录删除阻断仍有效；OpenAPI缺3 exports不能伪称 types/build全绿。
- 仍未验收：分阶段 UI 分支同步与 settings 合并；connection user binding；remaining V4 控制与精确 context/file boundaries、fork附件 lineage；原 host 完整真实浏览器/空账户/模型/Design回归；native desktop trusted file import、Project-before-Task Git、非空网络配置、Windows实机；当前全 server/web/shared/workspace/types/lint/build/license/OpenAPI/Apifox、迁移终检及可审阅交付。未 commit/push/PR。

## 最新状态（本节取代下方历史施工状态）

- 本 Goal 仍 active，完整授权来自既有实施阶段；不要重新访谈或缩小目标。Code 是编码优先的通用工作，本期不新增 Work 枚举。
- 测试 token 当前 parent；所有测试只一实例。最新完整 server round3：1607 passed / 0 failed / 109 skipped，JSON `/private/tmp/kfw-code-harness-server-tests-round3.json`。之后新增 PTY tracer actual RED（spawnPty 未实现），所以不是当前全绿。Web 全套正在跑，session 57950，报告 `/private/tmp/kfw-code-harness-web-tests.json`。
- parent 已接完整逐调用 broker -> Kernel args owner-schema normalization -> final claim -> 原 V4 pendingInteraction/resolveInteraction。`permissionInvocation` 和 `approvedExecutionMode` 是 private 执行事实；原 plan 或 final plan 只能只读，不因后续 yolo 放大。edit 仅 Write/Edit/ApplyPatch 自动，其他 write/execute 仍人审。
- Code 子代理 Task 工具已接同 AgentRunService，独立 child Session/Run、真实事件投影、主/子转录隔离、稳定 child UUID、治理 depth/ownership/criteria、冻结 worker ceiling、durable full result + TaskOutput。foreground 消费标志阻止重复后台消息；detached 保留父停止后生命周期。Task work 终态补救丢失的 child 终态，拒绝迟到正文。
- ToolCatalogue 实际 SDK graph 已验证并修复不允许替换已注册实例的问题；模型过滤曝光、执行换 current owner。每模型/发现/执行边界刷新纯 mode/role/ceiling policy；systemPrompt registry 每模型重 compose，真实目录/角色/模式与插件指导不会残留旧事实。
- Project AGENTS/本地 Skills loader + Read 局部规则已接。metadata 读取用只读派生账本，不能污染主模型已读事实；完整/截断/继续指针、UTF8预算、多页frontmatter、主根 canonical 限制与附加根局部性有真实回归。
- Scope/Human 宿主已按显式 Project/Task/viewer 身份，绝不从历史 root_directory 猜 Project。同路径多 Project 409，旧 Task/draft A 后续创建用其同 Project 最新 default B，selected Project 与后台 metadata 缓存分离。packed 文件树/递归 fuzzy search/授权复验已接。
- TaskWork/Process/PG 收口回执：manager12、Process25（含 provisional barrier race 八次回绕）、private PG session1 + production store3 GREEN。Process readonlyExecution provider 保证 + consumer 接线；私有 HOME/temp canonical；全部迁移重放/no-op独立临时 PG 已做，无现存 DB 连接或 node_modules 修改。
- FS+Process restore barriers 已接并覆盖 postSnapshot；foreign writer/pending 409，不杀对方；release 后才 After(true) CAS ready。旧失败 callback 按 expected generation CAS，不污染新关闭动作。真正 Git snapshots 使用 ls-files/NUL/literal pathspecs，readonly 反向 gitignore 不破边界。
- create_mcp_server 仍 Canvas/native stdio，现只允许 Design，Code 创建/stdio沙箱 lifecycle 仍未完成；已有 MCP/compat未知效果以 execute/deferred 分类，readonly不露。
- 独立产品 worktree retirement 的 source hunks由minimal正常审核通过已应用，但parent移除 OpenAPI 3 entries/imports script遭自动拒绝（未执行）。已异步问真人精确批准 GET/POST /api/code/git/worktrees 和 POST /api/code/git/worktrees/remove，不能绕过。最新 server tsc仅这3 missing exports，其余已绿。generic Code chat transcripts物理删除、旧raw terminal bulk retirement先前同样拒绝，仍未应用。
- PTY 实施当前 explicit agent：ProcessSandbox.spawnPty -> ManagedTerminalProcess.resize/onOutput，同 Task helper内 node-pty + SRT + sanitized env/range-empty/restore barrier；实时流独立于有界日志。它 owns process-sandbox/** 与 legacy terminal-session必要小export，不删除legacy。first真实TTY tracer已actual RED，parent等其source后短租token。Parent owns WS/shared/CodeUI人类终端consumer。不能把人类终端伪造 originRun/toolCall 的 Agent TaskWork。
- file agent owns command-tools.ts+test/policy 最后补覆盖；已3真实 producer GREEN，readonly/worker只能控制own record.agentId，main可控wholeTask；TaskOutput仍可读Task记录。最后coverage还需纳入全 suite。
- minimal agent已收口 Scope/Projects/Chat/Git/Checkpoints、package扫描、Human files/host identity；最新原 UI build+host tsc已GREEN。它的最后UI draftalias/host channel新增case在此次Web suite中验证。
- 总体尚未验收：原UI浏览器/空账户/真实模型、原host Provider CRUD/terminal/ignore/watcher缺口，三协议原UIGemini当前unsupported，Windows真实运行和非空受限网络，全 pnpm test/typecheck/lint/build、最新 api:spec、Apifox AI分支导入、迁移历史SHA/实际schema完整交付账本、review与commit/PR。不要把已过的窄/服务端suite说成完整目标。

下方条目保留为历史施工背景，其未完成描述以本节为准。

## 工作区

- 实施 worktree：`/Users/shigaoyu/.codex/worktrees/code-harness/KenFutWork`，分支 `codex/重构Code工作域与工具内核`，基于 `65d1097e`。
- 原 checkout `/Users/shigaoyu/Develop/KenKenDev/KenFutWork` 的 ZCode UI 迁移要保护。上游 refs 在原 checkout 可读，worktree refs 未初始化。
- CodeGraph 已尝试，不可用，不重新初始化索引。所有 tests 共用一个 token，禁止并行测试实例。

## 已接源码

- Code Project/Task/Chat 持久身份与目录 scope，不创建 Canvas。目录/权限代际、branch generation、只读派生、恢复期私有 handle 均已有接口。
- 文件 core Read/Glob/Grep/Write/Edit/ApplyPatch/preview/diff、真实目录/版本/原子 bytes 发布、取消与撤销、图片/PDF 已接。Kimi/Codex 纯算法来源和 LICENSE/NOTICE/SHA 已核对。
- SRT 每 Task helper，真实 stop/stdin/EOF/argv/统一采集 cap 和 stdout/stderr 分流；可信更新与关闭屏障；发布 helper 完整依赖闭包；Mac CJS/SEA 使用独立 Node 路径。
- `features/task-work` 已有 durable store、manager、Bash/TaskOutput/TaskInput/TaskStop、私有日志引用/快照统计；Code 已不装旧 Run-owned registry，不再按旧轮末闸门 LLM 轮询。Design 旧路径仍在，需最终审计。
- runtime private `eventSink` 统一投影，`cancelTaskRuns` 等待真正 stream 完成；Code main 具有 Task foreground lease。HTTP/WS Code 起 Run 必须 open 实际 Task，再经过 CodeUi.admitExternalRun；不能伪造 Canvas 或改变持久模式。
- CodeUI onTaskWorkChanged、resumeTaskWork（bool admission）、rewindTask/finishTaskRestore、Task actors cache、Task close resource callback 已落。恢复整个 batch+后快照结束前维持 revoking，普通 Run 不可进入。
- 旧 Code Workbench 已替换为原 CodeWorkbenchFrame；Visual 只 Design/Flow。Vite 原 UI 生成+stage public/code-ui，Web prebuild/predev 已接拓扑构建。明确孤儿旧 Code UI family 已清理。
- Human directory picker / workspace.open / 默认与 scratch Code 项目 / 真实 UI preferences / Task 或 Project 显式 viewerScope 正由 scope worker收口；不按路径猜 Task。
- ToolCatalog feature 初稿：常规 ToolSearch，core 常驻，optional schema deferred，动态 wrapModelCall/wrapToolCall，SDK context 经 AgentRunExtension 传入。MCP/browser/search/CU 曝光元数据已调整，**还未行为测试，不能算完成**。
- 中性共享 base prompt已改；Code prompt由工具属主贡献。项目 AGENTS/本地 Skills 与 workspace skills 的 Code 加载尚未实现。
- Code user hooks 的 governed timeout/preview 已改，新增 scoped-hook-command 经 ProcessSandbox argv 执行；**尚未测试，Design raw hook/旧 native terminal 仍需审计**。

## 最新证据

- Process public真实回归 13/13；18 own files Biome；Windows GNU cargo check --locked/rustfmt green。Mac 发布 helper独立 Node 实际命令运行已测。Windows 实机与非空网络 allowlist仍未完成（fail closed，不能用编译替代）。
- FS/producer/profile/diff串行4文件30/30，FS21、producer4、profile1、diff4；23 own files Biome、来源 SHA核验 green。
- 原 ZCode UI拓扑构建及 Web tsc green；空账户 E2E和真实浏览器尚未验证。
- TaskWork首3测试 green；随后真实四并发 stop修复为join，同域4/4；host lease manager5/5；独立私有PG session lock1/1。后续 worker仍施工，不能把这些窄 tests 当总验收。
- 最近 server tsc仍 exit1：runtime-checkpoints.test旧canvas hook、个别root已退役ensureCodeSession fixture，以及新 PersistenceSessionLock要求的 runner fixtures；这些正分属parent/worker处理。

## 当前代理 ownership

1. scope_interface_minimal：execution scope/types/repos、projects/chat、Code UI storage与Human workspace/viewer、CodeGit/checkpoint接口/HTTP/shared契约与fixtures、Web原入口接线。parent保留CodeUi service新Run/BG/restore methods、plugins接线、runtime/WS/registry/docs。
2. scope_interface_explicit：process-sandbox实现已收口（parent plugin.ts）；当前TaskWork types/service/repository/test-store/测试、Persistence session lock Provider/契约与必要fixtures。parent保留TaskWork command-tools/plugin/model-mailbox/close-resources。**持唯一test token**，真实PG只临时私有集群。
3. file_tools_implementation：文件实现已收口；当前permissions feature、HTTP、agent-modes工具策略和必要shared permission契约/tests。parent保留kernel/context/types、runtime/deep-agent、CodeUI投影与ToolCatalog。未持test token。

## 紧接下一步

1. 完成 TaskWork stop/close/lease-loss/restart/false-admission/代际场景及生产PG store COALESCE；parent已接onHostLost→cancelTaskRuns+revokeTaskFileOperations，onReady await initialize。
2. 权限 worker给出完整call/admit/peek/claim与pending/resolve/revoke接口后，parent接kernel payload、async SDK gate、原V4 pendingInteraction及审批command。build/edit/plan/yolo、旧worker审批ceiling、同参数与scope generation的一次许可不可用工具名永久记忆代替。
3. **Code子代理仍未实现新共用Harness**：当前Code不装旧子代理，API清单/提示须最后与实际工具同源。用同createAgentRunService/factory，独立child session/run和eventSink，readonly explore/review与writable worker，Main stop不终止显式BG。不得恢复旧createAgent单独loop。
4. ToolCatalog需公共SDK行为测试（真实Scripted Model或公开middleware seam）：core/已激活optional才进请求，安装/卸载更新，Readonly未知effect拒绝，activation不是授权，providers无native tool-search也可用。optional插件提示段需对应实际激活，不挂所有安装能力的过时指导。
5. 根/嵌套 AGENTS与本地Skills先metadata后正文；Code workspace skills不得Canvas JOIN。真实选中模型的vision/pdf能力目前仅credential.vision，需与目录声明/hints一致，保留显式false。
6. 核对所有残留 Code Canvas / 旧裸执行：plugins install、MCP创建路径、preview/terminal/CodeIndex、代码文件交付、old generic chat collector、Code AGENTS不变量与文档。WS Code collector已限制不写generic Chat，Code UI唯一转录聚合。
7. Scope worker checkpoint/CodeGit新契约需更新OpenAPI所有query/body为taskId，optional rootDirectory说明，expectedVersion恢复；`pnpm api:spec`后Apifox AI branch import，合并按repo确认规则。
8. 加真实 TaskWork Bash/停止/重启日志和Code UI host integration、原UI从空账户建目录/Task/工具/后台结果/审批/回滚/媒体/Design/Flow浏览器验收、真实模型链路。
9. 历史SHA、临时空PG全链重放、实际schema、二次no-op；主test/typecheck/lint/build；第三方校验脚本/目录Biome排除；docs/日志/AGENTS同步；逐hunk review、明确路径commit/PR。

## 自动审批阻断（不得绕过）

- 特定 Code Task的 generic chat_sessions/转录物理DELETE源码，两次正常审核均拒绝（含parent按真实chat_session_id/Code/workspace/root限定hunk）；理由具体记录删除授权不足、不可逆数据破坏。补丁未落、没有DB执行。已用异步问题请求用户选择“仅该Task关联Code转录删除”或“保留归档”，**目前等待回复**。
- scope worker整批退役旧terminal_* WS schema/helpers、raw terminal-session/git-exec源与测试的操作也被拒绝，理由可能中断现有终端功能，缺明确移除能力的人类授权。未落，不可通过只删consumer/改名等方式规避。可准备迁移同一Scope/ProcessSandbox保留能力的安全替代；若仍需移除，提供具体可审阅范围并请求审批。

## 新迁移

- 20261002192638_code_task_execution_scope.sql
- 20261002202429_code_checkpoints_task_scope.sql（含branch generation）
- 20261002204235_task_background_work.sql（parent新表）
- 20261002222123_code_ui_human_workspace.sql

所有旧迁移不可修改；当前仅新源码，无现存数据库执行、无用户真实文件删除。

## 补充交接：后续宿主与门禁状态

- Web first全套481 passed/2 failed（`test/zcode-message.test.tsx`缺IntlProvider）；父已修真实provider fixture，单文件4/4 GREEN。完整Web需复跑。env权威登记12项新治理数值+isolated PG gate，`node scripts/check-env.mjs`GREEN。workspace gates22/25，仍有worktree API/spec/retiredimports两个等待真人批准项（不得绕过）。
- Parent三次完整server：round1 46fail→round2 3fail→round3 1607 passed/0failed/109skipped（尚未加入后续PTY/provider/red）。报告在/private/tmp/kfw-code-harness-server-tests-round{2,3}.json，失败修复证据保存log。HTTP/app probes用public memory TaskWork manager override，生产onReady真实PG host lock fail-loud不被放宽。Agent assembly补显式dependencies，旧Code virtual-path chip改真实absolute语义。
- 唯一test token此刻root，无live。explicit继续PTY source不tests；file Provider CAS source不tests；minimal原Provider adapter source不tests。
- PTY4条actualGREEN：真实TTY/创建尺寸/stdin/stop、resize/raw方向键Ctrl+C、cap之后live ANSI、UTF8全量byte cursor。native node-pty安装spawn-helper0644是真失败原因，Task私有复制品0755，不改共享node_modules；仅此次PTY启SRT官方allowPty。public onOutput(data,{sequence,offset,nextOffset})，seq每process从1，cursor全量UTF8（不等retainedBytes），reader Promise后ACK/pause回压，一帧pending，无无界queue。
- **PTY job-control第五条仍actualRED**：stop宣称rangeEmpty后自己创建的后台job heartbeat98→105，不能宣称完整停止。explicit正在Mac native getsid/libproc birth+SID/PGID范围inspection/helper；ps sess0不是SID，不能杀单PTYpid就假退出。Linux bwrap new-session/pidnamespace与controlling TTY需真实接线；Windows同样不许pipes假PTY，目前failclosed。旧WS terminal仍canvasId?且不传时宿主cwd rawPTY，必须父consumer改显式Task并保留真实能力；不能bulkdelete绕自动拒绝。
- 新BYOK闭环分工：file owns model-provider service/repo/types及shared create/update/response credential/draft/CAS hunk、nullable前向migration、providers/types/resolve/OpenAI index必要explicit dialect hunk。first draft RED→GREEN service19/19；create无key/models[]是真draft，hasCredential真、configRevision库default1，resolve无key409。update null clear/protocol/CAS待继续。minimal owns providerCompat安全codeUi/chatApi、packages/zcode-provider nativeGemini闭集、CodeUI provider-settings-rpc/model-views及69d31706必要凭证UIhunks。双方避免整shared文件格式覆盖。
- Parent runtime已转发credentials.useResponsesApi/responsesApi，!==undefined保留false。原CodeUImodel optionMap必须按selected options编译每Run再交三协议adapter，当前Anthropic/Gemini参数还未完全在线；不能把view配置当执行已接。minimal建议adapter.readModels(actor,selection)->{settings,selection}；call(actor, service,method,args)->{result}|null，notifyViews回调父owned connections。
- 原IProviderSettings真实get/refresh/create/saveOverlay/delete/reorderProviders&models/add/rename/delete/saveModelDraft/setModelEnabled/resolveModelConfig/testConnectivity；IModelSelectionService仅getView，模型选择通过原V4持久command（需核对实际command名称，不另造loop）。UI安全metadata放providerCompat.codeUi；providerOrder放existing code_ui_preferences，不另造第二份供应商。Gemini要google-generative-language真实闭集，不谎报OpenAI。
- 任务总目标active，所有外部DB未执行migration，未commit/push/PR。PTY/provider/watch/ignore等原host缺口、模型参数三协议、用户输入附件/排队/重试/rewind/fork/compact真实原V4入口、browser/empty account/live模型、Windows实机/network配置、全gate/docs/OpenAPI/Apifox/review仍待完整推进。不要用本补充里的局部green结束Goal。

## 续轮增量（终端consumer与Provider）

- Parent新增 `features/code-terminal/types.ts/service.ts/service.test.ts`，首public准入case actual RED→GREEN 1/1（`/private/tmp/kfw-code-harness-terminal-admission-green.log`）：显式Task+owned用户连接；同步reserve后await scope、同ID复用启动Promise、参数换绑冲突；断线/Task关闭夹紧pending，迟到授权不能spawn，stop等待rangeEmpty否则保留stop_unconfirmed。此模块目前**尚未注册plugin/consumer或激活输出**，下一slice必须接线，不能称人类终端完成。Root owns这个模块、WS/shared、CodeUI terminal listener/activation。
- Explicit PTY5真实 GREEN，随后既有Process25+PTY5同runner GREEN30（`/private/tmp/kfw-code-harness-process-pty-regression.log`）。Mac小C inspector编译通过，getsid+libproc birth校验，session所有PGID冻结再TERM/CONT/KILL与实际empty扫描；natural退出同样等残余jobs清空。原test第5 heartbeat泄漏已修，仍要包装发布资源和后续边界矩阵。Linux/Windows PTY仍未完成，明确failclosed，不冒称三平台都实现。
- token最近explicit正式返root（runner35361exit0），Root末次自己的terminal admission session6883exit0，无live；file/minimal只source，不跑tests。所有新tests还需最后fullsuite重新取样。
- Provider接口进一步一致：file新增实际 testModelConnectivity(user,{instanceId,modelId,...})→{modelId,success,error?{code,message}}，必须当前真实native adapter/headers/extraBody，错误脱敏，不把capability探测bool拼success。API dialect明确选型采用SDK真正export的ChatOpenAICompletions/Responses，false也不能模型族启自动responses；缺省才保留probe自动纠偏。Parent runtime已透传两个dialect事实保留false。
- minimal adapter/readModels方案已给parent；原option map必须每Run编译选择选项（Anthropic/Gemini/显式null/缺档位不能读时静默最高档），实际ModelSelection command名称仍要核实，不照交接泛称盲加新命令。safe compat metadata、Gemini闭集与原凭证UI必要69d31706 hunk在隔离分支推进。
- 环境变量权威登记和样例已完成，static env check GREEN。Worktree 3 endpoint退役metadata自动拒绝的明确真人选择仍pending；该hunk不能间接绕过。Goal active/no commit/push/PR，目录/Scope编译与门禁不代表PTY、Provider及原UI全目标完成。

## 最新接续状态（2026-10-03 下午，覆盖前述历史待办）

- 总Goal仍active。主树仍保留，唯一实施树为 `/Users/shigaoyu/.codex/worktrees/code-harness/KenFutWork`，未commit/push/PR。Code定位仍coding-first general work，本期不增加Work枚举。
- root完成Task人类终端模块、plugin/key/profile、WS显式taskId、原CodeUI TerminalService/SSE绑定；前端data+exit监听均装好才activate，terminalId隔离，关闭连接/Task等待真实rangeEmpty。并发预算terminalMaxSessions进governance。Service+WS12GREEN、原Channel6GREEN、发布helper2GREEN。@zcode/ui host严格类型与web类型曾GREEN，后续附件wire改动仍需复核。
- explicit完成Mac PTY job-control与两条drain缺陷：慢listener等ACK、native node-pty200ms强制close丢尾部。只改Task私有SDK副本，保留MIT来源；Mac Process25+PTY7合计32GREEN（在后续stdio改动前）。Unix spawnStdio首真实1GREEN：非TTY双流、UTF8、EOF、live/capture独立。当前compiled helper `/private/tmp/kfw-process-helper-stdio-5rnki1u1/task-helper.mjs`，含两流RPC和PTY新readerRPC；早期artifact不能验新协议。
- Linux/WindowsPTY及Windows双流仍未验收/部分未实现，failclosed。Docker Desktop已启，曾瞬态退出；日志是Electron requested shutdown→dockerd healthy exit，触发者未知，不能推断OOM/CUA/用户。现在CLI ready，无我们容器，16GiB机器内存余量较低，测试按单文件串行；独占平台/test token时再开1GiB/2CPU临时容器，不动既有镜像/容器/用户配置。CUA getApp(Docker)异常等待1767s超时，别重复。
- file已完成Provider草稿NULL/clear/protocol/完整模型声明读回、workspace与system原子CAS及外workspace404、显式OpenAI API类、实际connectivity。36unit/HTTP GREEN，私有PG1GREEN含全迁移replay/noop，75既有SHA不变。新NULL草稿SQL未执行运行库。
- minimal的原provider-settings-rpc/model-views/model-execution-options已17GREEN，并由root接到constructor/hostRpc/广播/native connectivity。真实ModelSelection通过sendText.modelSelection持久，没有虚构V4 setModelSelection。Root已接内部ModelInvocationSnapshot并校configRevision，完整body不再重并静态extraBody；三native协议消费真实参数，修复OpenAI SDK覆盖max_tokens。实际Harness HTTP与陈旧配置拒绝已GREEN。最新新增snapshot.useResponsesApi锁UI方言（保留false、避免probe改到另一协议）尚需针对复验。
- root async disposer首RED→GREEN27；核心与compat/plugin registry生产unload均await，失败保留loaded/资源以便retry，不删bundle/假称卸载。ResourceDisposer类型是两个函数类型union，兼容同步cleanup返回array.push数字；drain识别thenable。ToolDefinition.projectArguments已接canonical middleware、runtime公开tool.started/deny与审批displayArgs，执行/指纹仍用原始normalized args。public args只给副本，投影失败隐藏；52GREEN验证原始env不被改写且公开只envKeys。
- file正推进MCP Task service：stdio SDK transport4GREEN、Task基线8GREEN；合法ASCII配置name+中文/点/长RPC名的wire alias先RED，后Task9+transport4共13GREEN。下一tools/plugin6已5RED/1GREEN，当前实现唯一mode dynamic create dispatcher与Task/revoke/hostlost/unload关闭接线，保留Design HTTP。Unknown效果execute，不能信remote readonlyHint；aliases<=64 ASCII，description可按原名搜，RPC仍原名；env projector必须幂等。
- minimal的附件service首unavailable RED→真实private Blob/metadata1GREEN，bounded local Blob11GREEN；新Begin协商chunkMaxBytes/totalChunks，renderer去固定384KiB，wire默认20MiB/64限制移到governance（固定frame护栏保留）。privatePG第一次真实RED为新草稿FK指auth.users兼容view，已仅改未发布未入账SQL到public.accounts，待同file复跑。原历史SQL/账本不变。新附件SQL、6项governance/env registry/examples已登记，node scripts/check-env.mjs GREEN。
- root新增attachments/host.ts作为CodeUI归属回调（workspace/rootTask/session/row target+index）；主service.ts/plugin/HTTP已接附件RPC与private repo/blob，lazy init由附件模块确保，连接before-call先require。**此接线仍未完成Run输入与rows附件消费，也未验首begin断线竞态**。minimal下一slice需hostLease在Blob写时丢失的非aborted save护栏、同步closedConnections pending fence、releaseTask及softdelete仅我们私有附件清理、composer20MiB/8件前置门预算。别把plan只读执行当Human上传禁令；archive历史附件read不看canUpload。
- V4原入口审计：`/private/tmp/kfw-v4-original-entrypoints-audit.md`。忙sendText应FIFO/held，不直接拒绝；attachments/clientId/canonical intent待持久；compact是真上下文操作且同FIFO，不新造user row；普通retry按钮原UI不渲染；队列编辑是deleteQueueItem后恢复composer。编辑会话回退走editUserQuery（默认preserve，显式rewind才文件恢复）；文件专用applyFileRewind不截聊天。fork是独立可选Task，不能用隐藏subagent parent_session_id。Checkpoint当前kind=turn无法分pre/post且未变snapshot为null，须精确边界，不猜上一条。
- remaining：附件/队列/真正compact/edit/fork/file rewind、原Git/watch/ignore/终端偏好/skills等host缺口、Code workspace-installed skills、nonempty network设置及三平台实证、私有真实空账户/模型/浏览器/Design、当前全server/web/shared/workspace/typecheck/lint/build与源码来源门禁、迁移最终replay/noop、OpenAPI/Apifox AI分支、reviewable delivery。历史1607GREEN不代表当前全绿。运行DB未迁移。
- reviewer拒绝的3worktree endpoint OpenAPI retirement仍pending真人准确回答，不用alias/stub/apply_patch间接绕过；server总typecheck最后仅剩该3exports时仍不能称绿。旧Code chat_sessions物理删除等拒绝也未执行。
- 更新：MCP工具/plugin/legacy21GREEN，加Task9/transport4共34及compiled-helper actual1全部GREEN；MCP本域Biome23files及owned类型无错误，说明在features/mcp/任务MCP与stdio生命周期.md。两个native test env已进权威表。附件native accounts FK修正后privatePG全流程1GREEN8.72s无unhandled；新hostLease Blob写期间释放public RED已验证（旧代码返回committed，应拒绝），source已修等待同caseGREEN；连接首begin/close race RED已写待运行。
- root HTTP optional publish闭包已改捕获const调用，避免附件RPC返回类型新增后unknown/possiblyundefined；当前server全量类型仍需重新跑（minimal附件测试fixture隐式any正在其owner修复，OpenAPI3保持review pending）。新attachments/host.ts与主service绑定没有model-input消费证据，不能宣称附件已可供模型使用。
