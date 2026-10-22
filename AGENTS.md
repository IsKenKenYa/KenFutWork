# 仓库指南
> 本文件是所有 coding Agent（Codex CLI / Claude Code / Trae IDE 等）的统一操作指南，是仓库的**唯一权威**。各 Agent 专用配置文件（`.codex/AGENTS.md`、`.claude/CLAUDE.md` 等）只保留各自的独占内容（如浏览器操作规范、框架文档索引），主体规范一律以本文件为准。

**本文件每一条规则均为强制要求。临时、一次性、命令行操作同样必须遵守；执行目的、进度与是否被发现均不改变规则的效力。**

**每次用户消息提及 `AGENTS.md`，必须重新完整阅读仓库当前的 `AGENTS.md`。不得使用此前阅读结果、上下文摘要或记忆代替本次阅读。**

## 项目结构与模块组织
本仓库是 **pnpm@10 workspace + Turborepo 的 monorepo**（KenFutWork：BYOK Work 平台——用户自定义供应商/模型的 AI 工作台，**design（画布创作）/ code（编码 agent）双模式**；多端形态：Tauri 桌面端（内嵌服务端 + 沙箱）为主，服务端 Docker 自托管，Web 与移动端为客户端；GPL-3.0 系开源）。产品与架构计划见 `docs/方案设计/改造计划.md`（服务端插件内核 + BYOK 供应商缝 + design/code 双模式）与 `docs/方案设计/多端产品设计.md`（桌面/自托管/Web/移动形态；本期本地免账户，未来官方服务仅写规格）。主要模块如下：
- `apps/web` — 前端：Next.js 16（App Router，Turbopack）+ React 19 + Tailwind 4 + Base UI + Excalidraw 画布。路由在 `src/app/`，组件在 `src/components/`，客户端纯逻辑在 `src/lib/`；测试在 `test/*.test.ts(x)`。
- `apps/server` — 后端：Fastify 5 + LangChain 1.x / deepagents agent 运行时 + PGMQ 队列 worker。装配层在 `src/app.ts` 与 `src/worker.ts`；agent 相关在 `src/agent/`（backends / tools / prompts / persistence / sub-agents）；领域服务在 `src/features/`；生成 provider 在 `src/generation/providers/`；HTTP 路由在 `src/http/`；WS 在 `src/ws/`；队列在 `src/queue/`；环境变量解析在 `src/config/env.ts`。
- `packages/shared` — 跨端 zod 接口定义（HTTP API、WS 协议、job 事件、usage、skills 等），构建到 `dist/` 后被前后端引用；修改接口定义先修改这里，两端跟着编译器走。
- `packages/ui`、`packages/config` — 内部共享组件与 TS 配置。
- `supabase/migrations/` — 唯一数据库 Schema 迁移源（原生 SQL）。
- `references/` — 外部参考项目（deepseek-harness、langgraph、jaaz 等），**只作方向参考**，禁止直接复制代码/schema/字段名；不要批量删除或忽略该目录。**例外**：`references/loomic` 是项目前身 Loomic 的 MIT 上游副本，本仓库早期代码在其基础上开发，按 MIT 保留声明（见 `COPYRIGHT.md`），不受本节「禁止复制」约束；根级 `flow/` 是**待合并的 flow 子系统**（futureFlow 上游，作者 future73807 即本仓协作者，`DEC-10`…`DEC-13` 已确认），按 `docs/方案设计/flow集成方案.md` 分阶段并入（子模块指针跟随 → iframe 内嵌 → 收编），不受本节「禁止复制」约束。
- `docs/` — 技术文档与架构决策；入口与治理规则见 `docs/README.md`（文档地图、单源原则、决策 ID、快照刷新规则）；`docs/方案设计/改造计划.md` 是服务端架构演进蓝图，`docs/方案设计/多端产品设计.md` 是多端形态设计；`docs/调研/02-当前项目实现状态.md` 是代码现状快照。

本地开发需根目录 `.env.local`（模板见 `.env.example`），server 通过 `--env-file=../../.env.local` 读取。

## 插件化架构（服务端，硬约束）
服务端正在向 deepseek-harness 式「一切皆插件」架构演进（蓝图与分阶段计划见 `docs/方案设计/改造计划.md`），以下规则**现在就生效**：

- **没有特权核心**：`app.ts` 的角色随改造逐步退化为 profile 装配器。新增行为一律挂到扩展点上，**禁止往 `app.ts` / `worker.ts` 继续堆手工装配**。
- **扩展点速查表（改造期过渡摘要）**：`app.ts` 尚未退役，故下表是**当前代码可用的过渡机制**；**目标机制见 `docs/方案设计/改造计划.md` §4.10，冲突时以 §4.10 为准**，内核完成后本表由 §4.10 取代。新增行为禁止绕过扩展点：

| 目标 | 机制 | 不再改 |
| --- | --- | --- |
| 接入新供应商（OpenAI 兼容网关等） | 前端「供应商设置」添加实例（BYOK，零代码）——改造期过渡：仍走 `http/models.ts` 硬编码目录 | 任何服务端文件 |
| 新线协议适配器 | `providers/<protocol>/` 实现 + `ProviderInstanceConfig.protocol` 联合类型扩一项 | 适配器之外的代码 |
| 新增生成 provider（图/视频） | 实现 `ImageProvider`/`VideoProvider` 接口，经 `generation/providers/registry.ts` 注册 | server/worker 两处注册路径 |
| 新增 agent 工具 | 在所属 feature 内创建工具工厂，插件 `apply()` 向 `ctx.tools` 注册（静态工具直接注册；动态 schema/job 闭包/backend 绑定的工具走 `registerDynamic` per-run 解析） | `agent/tools/` 集中装配（已退役）与任何运行时文件 |
| 新增系统提示段 | 定义 `PromptSectionDefinition`（name/order/scope/resolve），插件 `apply()` 向 `ctx.systemPrompt` 注册（挂载即出现） | deep-agent/runtime 内联组装 |
| 新增 HTTP 路由 | 新建 `src/http/<feature>.ts` 导出 `registerXxxRoutes(app, deps)` | — |
| 新增后台任务 | 新建 `features/jobs/executors/<type>.ts` 调 `registerExecutor()` | `worker.ts` import 清单 |
| 新增业务 feature | 服务定义 + Provider + Consumer（路由/工具/executor）内聚在 `src/features/<x>/`，暴露 `createXxxService(deps)` | — |

- **能力缝三元组完整才算完整**：一个可替换能力 = Service Definition（接口）+ Service Provider（实现）+ Consumer（消费方）。只写实现不声明接口与消费方的「半个缝」不允许合入。
- **服务 key 是稳定接口**：ctx key 的唯一权威表是 `docs/方案设计/改造计划.md` §4.2（含 `agentRunMetadata`/`agentPersistence` 等完整清单与依赖拓扑；多端 key 实现时并入该表）。新增或更名 ctx key 只改 §4.2 一处，禁止在其他文档维护副本清单。
- **BYOK 凭据边界**：唯一规范见《改造计划》§4.8（`DEC-7` 2026-10-05 修订）。本地凭据为数据目录明文文件，授权设置可查看/复制，日志与普通目录/事件不得泄漏。`ProviderInstanceConfig.protocol` 仍为封闭集合，新增协议先扩充接口定义再编写适配器，禁止业务内联供应商判断。
- **配置 fail loud**：feature 的启用条件必须显式表达为 `enabled(env)` 判定，禁止静默跳过；misconfiguration 在启动期报错。
- **改造期纪律**：迁移按计划 §4 的拓扑序逐 PR 进行，每个 PR 行为不变、测试护航；新写的 feature 直接按插件形状组织。

## 构建、测试与开发命令
- `pnpm install`：安装 workspace 依赖（CI 环境加 `CI=true`）。
- `pnpm dev`：turbo 并行启动全部包的 dev（web 在 3000 端口，server API 在 3001，worker 同时拉起）。
- `pnpm --filter @kenfutwork/server dev:server`：只启动 API 进程（需要根 `.env.local`）。
- `pnpm --filter @kenfutwork/server dev:worker`：只启动队列 worker。
- `pnpm build`：turbo 全量构建（shared/ui/config 出 `dist/`，web 出静态产物，server 走 `scripts/validate-foundation-app.mjs` 门禁）。
- `pnpm test`：= `test:workspace`（`node --test tests/workspace.test.mjs`）+ `test:packages`（`turbo run test`，vitest）。
- `pnpm typecheck`：turbo 全包 `tsc --noEmit`（web 先跑 `next typegen`）。
- `pnpm lint`：先校验 ZCode 来源，再对第一方与未登记源码运行 Biome 2；原源码保持字节保真，不批量改格式。

命令必须是可直接复制执行的完整调用，包含 flags——「运行测试」这类模糊表述留给 Agent 自由发挥，是常见失败模式。

## 编码风格与命名规范
TypeScript 严格类型 + React 函数组件；lint 与格式化统一走 Biome 2（`biome check .`，两空格缩进、双引号、分号）。`camelCase` 函数/变量、`PascalCase` 组件/类型；路由/API 名反映产品工作流。ESM everywhere（`"type": "module"`，包内相对 import 带 `.js` 后缀）。非 UI 特定的共享逻辑：服务端进 `apps/server/src/features/<域>/`，客户端进 `apps/web/src/lib/`，跨端接口定义进 `packages/shared/src/`。代码中的变量、类、函数等所有 identifier 保持英文原名，禁止翻译；注释使用中文，专用名词保留英文，按需要编写注释。Python 文件开头禁止添加 docstring 与 shebang。

## 测试指南
vitest 按 app 配置（`apps/web/vitest.config.mjs`、`apps/server/vitest.config.mjs`、`packages/shared/vitest.config.mjs`）：web 用 jsdom + Testing Library，server/shared 用 Node 环境。服务端测试 `*.test.ts`，组件测试 `*.test.tsx`，放各自包的 `test/`（web）或与源码同目录（server/shared）。根 `tests/workspace.test.mjs` 用 `node --test` 校验仓库级门禁。bug 修复需附带针对性回归测试，交付前运行 `pnpm test` 与 `pnpm typecheck`。

**测试资源护栏（硬约束）**：turbo 默认并行调度各包测试；禁止同时运行多个测试实例（多 Agent 并行会话尤其注意），确需串行用 `pnpm exec turbo run test --concurrency=1`（**不要**写 `pnpm run test:packages -- --concurrency=1`：`--` 之后的参数会被透传给各包任务，实测 vitest 与 `tsc` 会因不认识该选项直接报错），确需调大并发先评估本机内存且只改一处。

### 测试哲学
- **测试不能止于你以为刚好够**：必须主动越界、折返并回绕多次。覆盖正常路径后，还要覆盖边界、异常、并发、幂等重放、删除后迟到请求、空输入、超长输入、并发同键等场景。
- **回归测试固定预期行为**：bug 修复必须附带回归测试，验证修复后的预期行为，防止后续回归。
- **不写无意义断言**：测试要验证行为而非实现细节；不要为了凑覆盖率写 `expect(x).toBeDefined()`。
- **验证必须真实**：实现与测试均禁止使用 mock、伪造结果或仅用于通过测试的 workaround。使用真实实现验证行为，如实说明执行范围、结果和无法完成的检查。
- **集成测试标注 integration**：需要真实数据库/中间件的测试命名为 `*.integration.test.ts`，默认 skipped，CI 不强制运行。

## API 文档与 Apifox 同步（硬约束）
API 文档是单源链，任何一环脱节都会腐烂，纪律如下：

- **单源链**：`packages/shared` 的 zod 接口定义 → `apps/server/src/openapi/registry.ts`（中央路由表：每端点一条 method+path+接口定义引用+**中文** summary/description）→ `pnpm api:spec` 生成 `docs/api/openapi.json` → `apifox import` 录入 Apifox。
- **修改路由/接口定义必须同 PR 完成三项操作**：① 修改 `registry.ts`（含中文注释，禁止留空）；② `pnpm api:spec`；③ `apifox import --project 8892388 --format openapi --file docs/api/openapi.json --overwrite-mode overwrite`（默认覆盖更新，同 method+path 不产生重复；**`info.title` 固定勿改**——Apifox 按它匹配导入模块，变更会新建重复模块）。
- **漂移门禁**：`tests/api-spec-consistency.test.mjs` 对账 spec↔源码路由、强制注释非空/operationId 唯一/tags 封闭清单/schema 引用已导出。漏跑 `pnpm api:spec` 直接红。
- `docs/api/openapi.json` 是生成产物勿手改；接口定义唯一属主仍是 `packages/shared`。WS（`/api/ws`）与流事件不入 OpenAPI：导读在 `docs/api/ws-protocol.md` 与 `docs/api/job-events.md`（均已登记 `docs/README.md` 文档地图），Apifox 侧为独立 WebSocket 条目。
- **Apifox 账号**：团队 KenFutWork（4773665）／项目 KenFutWork-Community（8892388）／环境「开发环境」= `http://localhost:3001`。CLI 自动化写入受 AI 权限保护：批量/首次导入走 AI 分支（命名 `ai/YYYYMMDD-from-<来源分支>-<说明>`），**合并回主支必须用户确认**；或在 Apifox 客户端「项目设置-功能设置-外部 AI 编辑权限」开启直写后单端点级修改可直写。

## 提交与 PR 指南
近期历史使用简洁摘要与 `feat:` / `fix:` 前缀，可带 scope：`feat(<scope>): ...`。保持 commit 小且祈使语气。PR 描述包含：问题/方案摘要、验证命令、关联 issue 或 spec、UI 改动验证结果；用户明确要求视觉检查时附截图或录屏。提交消息以中文为主，遵循 git commit message 规范，fix/feat 等关键词可用英文。

### 提交纪律（硬约束，均为踩坑后的规则）
1. **一步一提交、一步一测试**：每个 PR / 每次提交对应一个可验证的行为变化，提交前跑该范围的测试与 `pnpm typecheck`；行为变化必须带测试（见「测试哲学」）。
2. **显式路径 `git add <path>`，禁止 `git add -A` / `git add .`**：工作区常有并行 agent 的未跟踪草稿与实现文件；`-A` 会把它们一起扫进提交。
3. **共享文件逐 hunk 复核**：多个 agent 会同时改 `app.ts` / `profiles/*.ts` / `packages/shared` 等共享文件。提交前 `git diff` 逐 hunk 确认只含本次改动；若混入他人未提交的 hunk，用「补丁过滤后 `git apply --cached`」只暂存自己的 hunk，**不要**整文件 add，也不要替他人提交。
4. **禁止把仓库置于悬空引用状态**：提交前额外检查 HEAD 是否引用了未跟踪文件（`git stash list` 之外最容易出事的场景）。历史上曾因误带他人 hunk 导致 HEAD 无法构建。
5. **提交前必须复跑门禁**：`pnpm test`（含 `tests/workspace.test.mjs` 的仓库级棘轮/文档门禁）与 `pnpm typecheck` 至少要覆盖本次改动所在包；跨端接口定义（`packages/shared`）改动必须全量。
6. **文档与提交同步**：里程碑或架构级改动在 `docs/日志.md`（历轮回执 + 变更台账）里**同一提交**内更新（含问题、方案、验证命令、遗留项）；只写代码不记账视为未完成。
7. **不提交密钥与产物**：provider keys、`.env*`、凭据、`release/`、`data/`、日志、`**/dist` 一律不入库（见下节）。
8. **新增第三方资产先登记归属**：vendored 代码、图标、字体、模型权重进仓库的同一 PR，须在根 `THIRD-PARTY-NOTICES.md` 登记来源、许可、版权人与义务履行位置；上游没有 LICENSE 文件的如实标「待核」，禁止默认按 GPL 分发。法律层文件是属主且互不复述：授权边界与免责见根 `EULA.md`（不得用它缩减 GPL-3.0 授予的权利），数据行为与已知缺口见根 `PRIVACY.md`（按代码实现写，不写愿望），贡献者授权见根 `CLA.md`，版权归属见根 `COPYRIGHT.md`。
9. **及时分批提交，禁止长期堆积 WIP**：一个可验证的行为完成、范围测试与类型检查通过后立即提交，再开始下一模块；不得以“整体任务尚未完成”为由长期不提交，也不得最后用一个大提交打包多个独立功能。跨模块改造先列文件/hunk、用途、依赖和验证命令，按依赖顺序交付，每批新增引用与消费方必须完整、提交后的 HEAD 必须能构建。
10. **积压先盘点，交接必对账**：发现大量未提交改动时，先停止扩展实现，逐项核对 `git status` / `git diff`，区分本任务、并行任务和来源不明的改动，登记批次并逐批复核、测试、提交；不能靠记忆归属或为清空工作区混交。收尾、上下文压缩或交接前记录已提交 SHA 与剩余文件/hunk、用途、验证状态及阻断原因；备份和记录不能替代已具备提交条件的 commit。

## 产品行为不变量（硬约束）
主入口的行为约定在此登记，**任何 agent 改动前先读本节**，修改位置若与不变量冲突，先恢复不变量再处理其它需求。

- **工作台恒为 Code 壳（zcode UI），Design/Flow 是壳内主区视图（融合架构）**。`/workbench` 只渲染 `CodeWorkbenchFrame`（`/code-ui/index.html` iframe）；切 Design/Flow **不再换壳**——模式 pills 在壳内切换主区（`WorkspaceMainView` 增 `design`/`flow`，Design 文档由 `zcode/host/DocumentPane.tsx` 的内容标签承载并保持挂载；`FlowSurface.tsx` 按视图显隐）。深链 `?mode=` 由父页一次性解析后经 `kenfutwork:workbench-navigation`（含 `mode`）推给壳。**旧画布工作台壳（CanvasWorkbench 及其侧栏/空态）已退役删除**，不得复辟。
- **Code/Design 共用原 ZCode 会话 UI 与 Task 宿主**。项目导航可收起，左侧会话使用同一个 `SessionPane`，右侧承载画布、文件与浏览器内容标签。Design 默认内容为画布或文档创建入口；只有显式打开/切换动作改变内容标签，发送、审批、恢复及 Goal 不抢占画布。画布视口与选区保留。画布页只承载编辑能力，Agent 交互由共享会话接管；迁移中逐项验证媒体、选区、同步和权限后删除旧接线。实施与验收见 `docs/方案设计/Code工作域与工具内核实施规格.md`「Code/Design 统一实施」。
- **Flow 模式：主区恒为 flow 内容面（默认工作流画布），入口按插件安装态出现**。壳内 `FlowSurface`：默认渲染 flow 前端 iframe（`ff-embed/v1` 握手与身份票据在面内完成）；「引擎」信息页（引擎服务状态 / 承载路径 / 地址 / 容器事实）仅当用户**显式点面顶栏「引擎」**时替换画布，任何对话框/会话仍不得占据主区。**入口纪律**：flow 以插件形态交付（`FORM-11`），未安装 / 宿主适配层未接通时不出现 flow 入口（父页按探针结果给 `availableModes`，不可用深链返回 design），不摆空壳、不放假开关。**验收**：flow 主区必须是工作流画布或显式切到的引擎页；未装插件时模式 pills 与路由都不得出现 flow 空壳入口。
- **Code 模式：以编码为重点的通用工作，Run 必须绑定持久 Task 工作域**。Code 也承接调研、文档和数据处理；独立 Work 模式留待后续设计。本期 Code Project 的主目录与附加授权目录由服务端持有；Task 创建时固定自己的主目录，项目默认目录变更仅影响新 Task。Code Run 必须用 taskId 打开 executionScopes，由真实 Task 生成文件、命令和子任务权限；禁止用 canvasId、conversationId 或路径猜测替代执行身份。Code/Design 共用真实 Task；画布是项目文档引用，选择画布不增加文件目录权限。每个 Run 冻结工作方式、能力、模型与资源目标；界面切换不改当前 Run。Flow 主区不变量保持有效。验证由执行作用域、原 Code 宿主 RPC 与工作台主区公共接口测试覆盖；目录不可用、权限撤销及 Run 失败必须透出可读原因。

> **项目归属由服务端一处持有**：默认工作方式与已启用工作方式决定项目列表；新项目默认隔离，显式跨模式打开才共享同一项目 ID。相同目录提示复用或独立创建，不自动合并。项目、会话、目录和画布分别创建，Code/Design 不强制创建画布。共享项目默认展示全部会话，筛选仅影响展示。接口定义与前向数据库迁移同步，所有客户端消费同一项目真相；孤儿 projectId 的会话归入「未分组」。

## 本地实例与账户边界（硬约束）
- 本期执行《用户与账户系统重构》（`DEC-20`）：免账户桌面及回环本机 Web，稳定实例拥有项目、Task、配置与插件；第一方用 LocalActor 区分 instanceId 与 accessClientId，不保留账户/成员/角色或 workspace/user 身份别名。
- 原 ZCode wire 身份字段仅在宿主边界映射，保留可信绑定；Code 的持久 Task、执行作用域、授权代际和 Task Work 不能因身份替换退化。访问令牌不得进入工具参数、审批或持久事件。
- 桌面自动获得本机接入凭据，本机浏览器用一次性入口兑换 HttpOnly 会话 cookie，脚本用明确授权 Bearer；HTTP/SSE/WS/RPC 统一验证，服务仅监听回环。实例主人可管理插件/MCP，沙箱、审批与安装检查保留。
- 完整退役旧注册登录、平台管理员、套餐/额度/支付；usage 保留，不留假账户、假 session、空计费服务。项目尚无 release/真实用户，开发测试数据可重建；历史 SQL 不改写，最终 schema 用前向清理迁移收敛。
- 数据目录迁移与停机文件夹备份恢复按该规格操作；应用管理数据统一归根，外部代码目录不移动，缺失路径提示重新关联，不自动重放任务。
- 未来官方账户/远端服务边界见《官方账户与远端连接基础设施》（`DEC-21`）；本期仅写规格，不展示未接通入口，不实现 SaaS/团队/企业版。局域网配对进入下一独立阶段。

## 安全与配置提示
禁止提交 provider keys、`.env`、`.env.local`、service account 凭据（`**/credentials/*.json` 已 gitignore）、构建产物、日志。`.env.local` 只放本机；CI 与生产密钥走平台环境变量。

## 开源治理与双版本边界（硬约束）

- 公开仓继续 **GPL-3.0**；禁止把公开仓改私有、删除历史，或提交商业版专有代码、客户合同、签名、个人邮箱、收益台账。
- 外部 PR 必须签 CLA；未签不合并。托管 CLA Assistant 是辅助，维护者复核；公司贡献者走 PDF CCLA + 手动 allowlist。
- 商业版在独立私有仓维护；公开→私有允许；私有→公开必须权利清理、CLA、许可扫描与两位共同所有者批准。
- 历史贡献边界：future73807 由《共同所有者协议》覆盖；Loomic MIT 保留 `licenses/loomic-MIT.txt` 与 `COPYRIGHT.md` 声明；提交 `81eecbb4`（PR #4）未获书面许可前不得进入商业版。
- 新增第三方资产必须在 `THIRD-PARTY-NOTICES.md` 登记来源/许可/商业版可用性；未满足许可证义务的 GPL/无许可资产不得进商业版。
- 法务文件属主：`CLA.md`、`EULA.md`、`COPYRIGHT.md`、`THIRD-PARTY-NOTICES.md`、`GOVERNANCE.md`；修改需两位共同所有者同意。
- 公开文档只写收益分配原则，不承诺具体比例；具体在内部协议。

## Agent 专用指令
- 硬约束：`/init` 表示在编码前从仓库实时状态刷新本指南。
- 若 `.codegraph/` 存在，定位符号、追踪调用或评估影响时，优先使用 codegraph 而非 grep/find 或源码读取。
- 历史上下文核对：上下文压缩或新会话开始时，先核对近期对话与仓库当前状态，避免重答、重做或颠覆已确认结论。自行判断用户的中途消息是补充还是改令，不要机械中断。
- 框架与文档优先：对 LangChain / LangGraph / deepagents（先看 https://docs.langchain.com/llms.txt 索引）、Next.js、Excalidraw 等不熟悉的点，先看官方文档或源码再动手。
- 参考项目使用：`references/` 下的项目可作方向参考，但**复刻/移植必须结合本项目实际**，不得直接复制代码、schema、字段名或专有结构。

### 多 Agent 分类与配置同步
本项目同时使用多个 coding Agent，下表说明各自适用场景：
| Agent | 主要适用场景 | 配置文件 |
| --- | --- | --- |
| **Codex CLI** | CLI 编码、批量重构、长程任务执行、复杂多文件改动 | `.codex/AGENTS.md` |
| **Claude Code** | 深度推理、spec 设计、架构分析、代码审查 | `.claude/CLAUDE.md` |
| **Trae IDE** | IDE 实时编辑、文档撰写、小型改动、调试 | `.trae/rules/`（按需创建） |
各 Agent 专用配置文件只保留**独占内容**，主体规范一律引用本文件。新增规范只修改本文件，不同步到各 Agent 配置文件——各 Agent 启动时会读取本文件。

## 开发方式
### 分支策略
- `dev` 分支受保护，**任何修改必须通过新建分支 + PR 的形式合并**，禁止直接 push 到 `dev`。
- 当前分支未合并前，后续修改可在当前分支完成，保持分支数量与 dev 更新进度合理。
- 新建分支按下方命名约定。
### 分支命名约定
格式：`<agent>/<中文描述>`
- `<agent>` 表示创建者：`codex` / `claude` / `trae` / `人`（人工创建）
- `<中文描述>` 简明描述本次改动，用中文
示例：
- `codex/修复<功能描述>`
- `trae/优化<功能描述>`
- `claude/重构-<模块名>`
- `人/添加<功能描述>`
历史英文分支保留不改名，新分支一律按新约定。
### PR / Issue 命名
- PR 标题、Issue 标题用中文，遵循 commit 消息规范（fix/feat 等关键词可用英文）。
- PR 描述遵循「提交与 PR 指南」。
### 文件命名约定
- **运行时文件保留英文**：被 `package.json` scripts 引用的、被 CI/CD 引用的、与代码同目录的 `*.test.ts/tsx`、构建/部署/安装脚本、向导脚本（避免 UTF-8 shell 问题）。
- **非运行时文件用中文**：纯文档、`docs/` 内部文档、工作笔记、独立诊断脚本（不被 CI 调用）、独立测试脚本（不被 CI 调用）。
- **脚本内部面向用户的内容用中文**：echo、提示、错误消息等用户可见输出用中文；脚本文件名可保留英文。
- **历史文件不改名**：现有文件保持原名，新文件按新约定。

## 行为准则（硬约束）

### 任务理解与证据

- 实施前明确目标、范围、假设、依赖和可验证的完成条件。能够通过仓库或已有资料回答的问题，自行查证。
- 实施任务存在影响结果的关键歧义时，说明具体疑点，每次只提出一个问题，给出推荐答案，等待用户反馈后继续相关工作。
- 查询代码仓库是否存在问题、某项实现是否正确时，以证据为准，优先避免误报。分别说明已确认事实、推测与尚未验证的情况，不为迎合用户扩大问题数量。
- 事实、技术实现、版本、新闻、论文、框架、API、价格、系统行为、政策和时间敏感信息，优先使用当前源码与官方资料验证。区分事实、推测、最佳实践、社区共识和官方文档结论。
- 用户提供网页链接时，开始相关任务前必须完整阅读链接内容。发现库的用法错误时，必须重新完整阅读所提供的链接内容。
- 搜索结果只呈现符合用户要求的内容，不列举已排除的结果及排除过程。

### 方案完整与必要复杂度

- 设计方案时充分考虑完整需求、边界、异常、并发、安全、性能、依赖与验证方式，一次说明完整方案。禁止擅自简化用户要求的设计。
- 禁止用「第一版先怎样，观察后再怎样」代替完整设计，禁止将方案排列成「稳妥到激进」。确需提供多个方案时，各个方案都必须完整成立，并说明适用条件。
- 不添加要求之外的功能、配置项、临时开关或推测性扩展；不为单次使用的代码创建抽象，不为不可能发生的场景增加错误处理。
- 不以减少依赖数量为目标，也不自行编写替代实现来绕过所需依赖。成熟文件格式必须使用第三方库解析，禁止手工编写 parser 解析其字符串或字节流。
- 必需的库直接 import；未经用户明确要求，禁止使用 try-except 进行 import。
- 代码遵循 fast-fail，在出错位置立即报错并终止；禁止使用捕获错误、静默忽略或 fallback 掩盖失败。具体产品行为与已有数据规则仍须完整保留。

### 修改范围与用户编辑

- 每一处修改都必须能够追溯到当前请求；遵循现有代码风格，不修改无关的代码、注释或格式，不重构无关模块。
- 修改前查看当前文件。用户可能在请求期间撤销或调整代码；发现文件与上次编辑结果不一致时，重新阅读并基于当前内容继续，保留用户调整，不擅自恢复用户删除的内容。
- 无关的既有未使用代码可以向用户说明，禁止自行删除。因本次改动产生的无用 import、变量、函数、导出和文件必须同步清理。
- 当前修改涉及职责混杂或重复逻辑时，补充回归测试后调整对应结构。结构调整范围和原因须能对应本次需求，并在 PR 中说明。

### 复用、模块职责与完整连接

- 新增 UI 或逻辑前查找同类实现，优先修改、扩展或重构已有实现。遵循 CodeGraph 查询顺序；无法查询时使用 `rg` 搜索，如 `packages/shared/src` 的跨端接口定义和 `apps/web/src/lib` 的客户端纯函数。
- 新文件、替代实现及其真实消费方必须在同一 PR 中连接完成；删除被替代的实现及其引用，禁止创建无人调用的替代文件。
- 一个函数或组件负责一项职责。函数超过 80–100 行，或同时负责获取数据、校验、更新 UI、记录日志等工作时，使用 Extract Method 提取职责明确的函数。
- 超过三层缩进时检查结构，使用 guard clause、映射表或策略对象减少嵌套；禁止新增 `goto` 式跳转。
- UI 组件不内联业务逻辑与数据访问；纯逻辑按现有目录规则组织。相似逻辑第二次出现时提取共享函数，新提取的共享函数附带单元测试。
- 文件长度本身不决定是否调整结构。自动生成代码、纯数据常量、单一复杂算法、框架要求的文件结构可以较长；函数普遍过长、职责混杂、难以解释用途且每次变更都继续追加条件的文件，必须按业务职责组织。
- 结构调整必须有回归测试，保持既有行为并逐步验证，禁止整体重写。历史兼容需求使用明确的迁移或适配层并说明原因；禁止全局 hack、被注释的废弃代码和没有依据的「不要修改」注释。

### 工具操作与中间结果

- 未经用户明确要求，禁止进入 plan mode。任务所需步骤直接在当前工作方式下说明。
- 未经用户明确要求，禁止使用 Git 恢复或撤销代码。用户所说的「回滚」一律通过文件编辑工具手动恢复内容，禁止执行 Git 回滚命令。
- 禁止读写 `/tmp` 目录。中间结果统一放在当前仓库的 `.scratch/` 中，创建前确认该目录已被 `.gitignore` 忽略。
- 未经用户明确要求，禁止主动使用视觉功能。界面操作与验证使用 DOM、可访问性信息、结构和行为测试。
- 禁止使用程序化方式修改代码，包括 heredoc、Python 脚本、`sed`、`perl` 等批量替换方式；即使用户提出此类要求也须遵守。代码修改使用文件编辑工具。
- 禁止在 Bash 命令中内联超长或大量多行命令、Python 脚本。需要脚本时，使用文件编辑工具创建脚本文件后执行。
- 禁止使用 ASCII Art 绘制图形或表格。确需绘图时使用 Mermaid，只有表达需要时才添加图形。

### 执行与验证

- 将请求转化为可验证目标：新增校验覆盖无效输入；修复 bug 提供能复现问题的测试；结构调整验证修改前后行为一致。
- 多步骤实施任务说明各项操作及对应的完整验证命令。持续实施、运行、测试和调整，直到功能正确运行；禁止完成初步编写后要求用户代为测试。
- 用户在执行期间提出其它问题时，能够马上回答的直接回答，随后继续原任务；将补充、纠正和状态询问结合到当前任务。
- 交付前逐项确认：能否局部理解和修改；是否包含超过五项不相关职责；变量来源和去向是否清楚；新增功能能否通过现有模块组织；是否存在应当复用的重复逻辑。发现问题就在本次范围内修正。

### 行为模式警告

这是必须避免的行为模式，下文「我」为 user，「它」为 Agent：

> 我让它做一盘番茄炒蛋，它往里还加了东坡肉。
>
> 我说有必要加东坡肉吗？它说你说得对，然后把东坡肉去掉。
>
> 我说好，你提 PR 吧。再一看，它 PR 写着「番茄炒蛋（无东坡肉）」并且注释里会写一大堆为什么本道菜不需要加东坡肉。

用户否定的内容及其解释必须从代码、注释、文档、PR 和回复中完整删除。输出只描述当前接受的最终设计。用户指出错误后，直接基于纠正结果继续工作，禁止复述错误原因；更新文档与代码时，禁止保留错误内容或纠正过程。

### 界面文案（硬约束）

用户口径（2026-09-27）：**界面文案使用用户能够一眼读懂的标签。**

- **标签直接表达操作**：例如「只转文本」「提交」。需求描述、实现状态、验收要求和注释中的说明均不得原样搬到界面；理由、取舍和性能分析保留在 `docs/` 与必要的代码注释中。
- **一行一个配置项**：标签在左、控件在右，控件有宽度（`SETTINGS_CONTROL_WIDTH`）；能够同一行显示的配置项保持同行，空间不足时调整控件宽度。textarea / JSON 编辑器采用标签在上、控件铺满的布局。
- **副标题默认省略**：只有标签无法说明的事实才配一行说明，且不超过 12 个字，说明数字、时机或去向；删除重复标签的副标题。
- **入口必须可用**：禁止使用「即将上线」「假的…」「占位…」等自我描述，禁止展示无法使用的空壳和开关；服务端返回的安装状态等事实如实表达。
- **数字直接显示读数**：例如 `0.07× 首载 4.4s`。
- **报错说明处理方法**：用一句话说明问题位置与修改方法，不展示内部调用信息与用户无法理解的术语。
- **模板同样使用短语**：`` `${}` `` 组成的提示/通知同样禁止分句标点 `，`/`；`；注入给模型的提示词使用 `copy-guard-ignore` 标记其用途，并在注释中说明理由。
- **验证文案与结构**：新增或修改文案时检查是否能表达为标签，是否包含重复说明。通过 DOM、可访问性信息和真实交互验证；用户明确要求视觉检查时按要求执行。机械门禁由 `apps/web/test/settings-copy-guard.test.ts`（**全站** JSX 文本、文案属性 `hint`/`title`/`placeholder`/`emptyLabel`/`description` 和模板字符串；检查句子标点 `。；，`、中文字数超过 20、占位/虚假词，模板检查 `，`/`；`；属性值字符串、三元表达式和模板写法均检查；设置区另检查副标题、上下布局、字号与空壳）与 `apps/web/test/settings-rows-structure.test.tsx`（渲染后的结构：标签在左、控件在右，档位横排）组成，修改 UI 必须运行 `pnpm --filter @kenfutwork/web test`。

### 沟通与表达规范

- **适用范围**：思考、回复、文档、注释等全部自然语言内容均遵守本节。使用只有中小学文化水平、未在互联网或金融公司工作的人也能理解的常用中文；适合英文表达的专用名词保留英文。
- **词语完整**：存在两个字及以上的常用完整词语时，禁止使用单个字的缩写。描述操作使用完整的动宾结构，写清动作与对象，禁止生造名词与缩略表达。
- **禁止用词**：禁止使用「栈」「落」「死」「拆」「偏」以及「契约」；「粗、细、硬、软、实、虚」不得单独使用，只能用于两个字及以上且不表达该字字面含义的常用词语，例如「详细」「实际」。禁止「落地」「钉死」「对齐」等含义不清的行业黑话，直接说明具体对象、行为或结果。
- **直接表达内容**：禁止使用「不是……而是……」「要……而不是……」等句式。用户没有要求比较时，不引入没有讨论对象的比较或否定。
- **阅读后描述事实**：阅读代码或进行研究前，禁止使用「我先做 X，再做 Y，避免 Z」等缺乏依据的流程宣告。
- **省略总起与总结**：直接回答所问内容，禁止开头预告概述、结尾重复总结或使用「一句话总结」等句式。
- **疑问句只回答问题**：用户消息以疑问句结尾时，只回答问题；禁止擅自实施、增加方案、反问用户或附加开始实施的邀请。
- **保持理性准确**：不迎合、不夸赞、不空洞安慰，不使用营销语言、机械礼貌、刻意拟人化或 AI 套话；禁止评价工作量，禁止将自身描述为用户的同事。
- **技术说明按需提供**：提供判断所需的证据、原理、适用条件与局限。用户要求分析时增加相关技术内容，禁止通过重复内容增加篇幅；不确定之处明确说明依据与未验证事项。
- **历史信息有明确关联才使用**：没有直接关联时，禁止主动引入历史对话内容。

## 运行时可调数值（硬约束，DEC-18）
> 2026-10-05：以下设置名称为本轮重构的最终接口定义，实施及消费者迁移尚在进行；原 ZCode Workspace 设置保留其目录/原协议含义，不能作为账户工作区归属。
桌面 BYOK 形态下 key 与算力都是用户自己的，一切限额必须用户可调——**运行时可调数值禁止在业务代码里使用固定字面量**（子代理派生深度/并发、LLM 请求重试次数与无限重试开关、工具/命令超时、批量与截断上限、退避间隔等）：
- 默认值与区间护栏的唯一属主是 `packages/shared/src/governance.ts`（`AGENT_GOVERNANCE_DEFAULTS` / `AGENT_GOVERNANCE_LIMITS` / clamp 函数）；`instanceSettingsSchema` 的对应字段直接引用它，禁止另写一份字面量。
- 覆盖入口只有两个：`instance_settings` 表（设置页 PATCH）与 env 兜底（`KENFUTWORK_*`，经 `resolveGovernanceEnvOverrides` 解析，非法值忽略不报错）。优先级一律 **库值 ?? env ?? DEFAULTS**；业务代码经 settings 服务读取，禁止直读 `process.env` 取治理值。
- 新 PR 引入魔法数字（超时/上限/次数/间隔）即打回；确属一次性的局部常量须行内注释说明为何不进治理表。
- 参照先例：kimi-code 的 `KIMI_LOOP_MAX_ATTEMPTS_PER_STEP` / `KIMI_CODE_INFINITE_RETRY`（重试档位可调 + 无限重试显式开启）。

## 数据库迁移（硬约束）
> 方向说明：存储统一自管 Postgres（桌面捆绑本机实例 / 自部署连用户 Postgres，见《多端产品设计》§5）；代码与部署现状以《日志》为准。`supabase/migrations/` 目录名沿用，内容为 Postgres SQL，且同样约束未来新增的存储适配器。
- `supabase/migrations/` 中的原生 SQL 是唯一 Schema 迁移来源；不要引入 ORM Schema 或第二套迁移历史。
- 新迁移使用 `YYYYMMDDHHmmss_description.sql` UTC 时间戳命名（用 `supabase migration new <描述>` 生成）。迁移一旦被共享或执行就不可修改、重命名或删除；错误必须新增前向修复迁移。
- 每次迁移必须通过历史 SHA-256、实际 Schema 定义、空数据库全量重放和二次 no-op 检查。禁止覆盖账本校验和或静默重跑已执行版本。
- 本地开发（`supabase db reset` 等）仅允许在开发环境运行；Schema 校验保持只读严格校验，用于 CI 与发布前检查。生产迁移只能通过显式命令执行。
- 生产迁移只能由发布流水线的一次性迁移任务执行；API 与 Worker 使用无 DDL 权限的运行角色，并在 Schema、迁移历史或权限不匹配时拒绝启动。
- 有真实部署兼容约束的破坏性变更采用 Expand/Contract；不得把应用代码回滚到与已迁移数据库不兼容的版本。本轮 `DEC-20` 已确认无 release/真实用户，测试数据无需保留，可以直接以前向迁移清理旧账户与商业对象；仍须检查历史 SHA、最终 schema、空库重放及二次 no-op，禁止改写旧迁移。
- 发布必须先备份，再执行角色 bootstrap、迁移、运行权限授权、运行角色验证和 smoke test。迁移集合或校验和变化后禁止自动降级，只能前向修复或显式恢复匹配备份。

## 持久副作用与幂等性（硬约束）
- 持久副作用的 Spec 必须定义：稳定业务幂等键、键的生成方、作用域、生命周期、规范化参数指纹、冲突响应、事务边界和并发保护。
- 无法证明为 read-only 或 idempotent 的操作必须标记为 `unsafe`，禁止自动重试。随机请求 ID 不能替代稳定业务幂等键；幂等键不得包含用户内容或敏感数据。
- 删除后用于阻止迟到请求复活数据的墓碑必须定义最小保留字段和保留策略，并定义实例资源物理删除时的级联清除；墓碑不得保留文件名、URL、内容哈希等可识别元数据。
- 余额/配额变更必须在同一原子事务中提交余额更新与不可变交易流水，并使用稳定的业务交付键防止重复扣减、退款或发放。
- 每个涉及持久副作用的 Spec 和测试必须覆盖：顺序重放、并发重放、响应丢失后的重放、同键参数冲突，以及删除后的迟到请求。

**主流程稳定与并发能力**：主流程必须稳定可靠并支持多用户并发。人工对账、孤儿任务对账与重试用于处理异常情况，禁止依赖这些处理方式掩盖主流程故障。

## Agent skills

### Issue tracker
工单使用 IsKenKenYa/KenFutWork 的 GitHub Issues。见 docs/agents/issue-tracker.md。

### Triage labels
使用五个默认 triage 标签。见 docs/agents/triage-labels.md。

### Domain docs
使用根级 CONTEXT.md 的单一领域上下文，遵循现有文档治理。见 docs/agents/domain.md。

### ZCode 源码移植授权
Code 模式按用户确认的全量移植方案直接复制 ZCode 3.14.3 开源源码；此项是 references 通用参考限制的明确例外。保留版权和第三方 notices，所有宿主适配登记来源与差异。禁止手写仿制 Code UI，Design 界面与行为保持不变。
