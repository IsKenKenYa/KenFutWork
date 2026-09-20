# 仓库指南
> 本文件是所有 coding Agent（Codex CLI / Claude Code / Trae IDE 等）的统一操作指南，是仓库的**唯一权威**。各 Agent 专用配置文件（`.codex/AGENTS.md`、`.claude/CLAUDE.md` 等）只保留各自的独占内容（如浏览器操作规范、框架文档索引），主体规范一律以本文件为准。

## 项目结构与模块组织
本仓库是 **pnpm@10 workspace + Turborepo 的 monorepo**（KenFutWork：BYOK Work 平台——用户自定义供应商/模型的 AI 工作台，**design（画布创作）/ code（编码 agent）双模式**；多端形态：Tauri 桌面端（内嵌服务端 + 沙箱）为主，服务端 Docker 自托管，Web 与移动端为客户端；GPL-3.0 系开源）。产品与架构计划见 `docs/方案设计/改造计划.md`（服务端插件内核 + BYOK 供应商缝 + design/code 双模式）与 `docs/方案设计/多端产品设计.md`（桌面/自托管/Web/移动形态，**已去云托管**）。主要模块如下：
- `apps/web` — 前端：Next.js 16（App Router，Turbopack）+ React 19 + Tailwind 4 + Base UI + Excalidraw 画布。路由在 `src/app/`，组件在 `src/components/`，客户端纯逻辑在 `src/lib/`；测试在 `test/*.test.ts(x)`。
- `apps/server` — 后端：Fastify 5 + LangChain 1.x / deepagents agent 运行时 + PGMQ 队列 worker。装配层在 `src/app.ts` 与 `src/worker.ts`；agent 相关在 `src/agent/`（backends / tools / prompts / persistence / sub-agents）；领域服务在 `src/features/`；生成 provider 在 `src/generation/providers/`；HTTP 路由在 `src/http/`；WS 在 `src/ws/`；队列在 `src/queue/`；环境变量解析在 `src/config/env.ts`。
- `packages/shared` — 跨端 zod 契约（HTTP API、WS 协议、job 事件、credits、skills 等），构建到 `dist/` 后被前后端引用；改契约先改这里，两端跟着编译器走。
- `packages/ui`、`packages/config` — 内部共享组件与 TS 配置。
- `supabase/migrations/` — 唯一数据库 Schema 迁移源（原生 SQL）。
- `references/` — 外部参考项目（deepseek-harness、langgraph、jaaz 等），**只作方向参考**，禁止直接复制代码/schema/字段名；不要批量删除或忽略该目录。**例外**：`references/futureFlow` 是**待合并的 flow 子系统**（作者 future73807 即本仓协作者，`DEC-10`…`DEC-13` 已拍板），不是纯参考——集成方案见 `docs/方案设计/flow集成方案.md`；其代码按方案分阶段并入（子模块指针跟随 → iframe 内嵌 → 收编），不受本节「禁止复制」约束。
- `docs/` — 技术文档与架构决策；入口与治理规则见 `docs/README.md`（文档地图、单源原则、决策 ID、快照刷新规则）；`docs/方案设计/改造计划.md` 是服务端架构演进蓝图，`docs/方案设计/多端产品设计.md` 是多端形态设计；`docs/调研/02-当前项目实现状态.md` 是代码现状快照。

本地开发需根目录 `.env.local`（模板见 `.env.example`），server 通过 `--env-file=../../.env.local` 读取。

## 插件化架构（服务端，硬约束）
服务端正在向 deepseek-harness 式「一切皆插件」架构演进（蓝图与分阶段计划见 `docs/方案设计/改造计划.md`），以下规则**现在就生效**：

- **没有特权核心**：`app.ts` 的角色随改造逐步退化为 profile 装配器。新增行为一律挂到扩展点上，**禁止往 `app.ts` / `worker.ts` 继续堆手工装配**。
- **扩展点速查表（改造期过渡摘要）**：`app.ts` 尚未退役，故下表是**当前代码可用的过渡机制**；**目标机制见 `docs/方案设计/改造计划.md` §4.10，冲突时以 §4.10 为准**，内核落地后本表由 §4.10 取代。新增行为禁止绕过扩展点：

| 目标 | 机制 | 不再改 |
| --- | --- | --- |
| 接入新供应商（OpenAI 兼容网关等） | 前端「供应商设置」添加实例（BYOK，零代码）——改造期过渡：仍走 `http/models.ts` 硬编码目录 | 任何服务端文件 |
| 新线协议适配器 | `providers/<protocol>/` 实现 + `ProviderInstanceConfig.protocol` 联合类型扩一项 | 适配器之外的代码 |
| 新增生成 provider（图/视频） | 实现 `ImageProvider`/`VideoProvider` 接口，经 `generation/providers/registry.ts` 注册 | server/worker 两处注册路径 |
| 新增 agent 工具 | 在所属 feature 内创建工具工厂并注册（改造期过渡：仍需在 `agent/tools/index.ts` 接线，内核落地后改走工具缝） | — |
| 新增 HTTP 路由 | 新建 `src/http/<feature>.ts` 导出 `registerXxxRoutes(app, deps)` | — |
| 新增后台任务 | 新建 `features/jobs/executors/<type>.ts` 调 `registerExecutor()` | `worker.ts` import 清单 |
| 新增业务 feature | 服务定义 + Provider + Consumer（路由/工具/executor）内聚在 `src/features/<x>/`，暴露 `createXxxService(deps)` | — |

- **能力缝三元组完整才算完整**：一个可替换能力 = Service Definition（接口）+ Service Provider（实现）+ Consumer（消费方）。只写实现不声明接口与消费方的「半个缝」不允许合入。
- **服务 key 是稳定契约**：ctx key 的唯一权威表是 `docs/方案设计/改造计划.md` §4.2（含 `agentRunMetadata`/`agentPersistence` 等完整清单与依赖拓扑；多端 key 落地时并入该表）。新增或更名 ctx key 只改 §4.2 一处，禁止在其他文档维护副本清单。
- **BYOK 凭证红线**：用户 API Key 只写不读（前端永不回显）、服务端日志脱敏、按工作区 RLS 隔离；`ProviderInstanceConfig.protocol` 是封闭集合（openai-compatible / anthropic / gemini / 图视频协议），新增协议必须先扩契约再写适配器，禁止在业务代码里内联供应商判断。
- **配置 fail loud**：feature 的启用条件（如 Lemon Squeezy 配置齐全才建 PaymentService）必须显式表达为 `enabled(env)` 判定，禁止静默跳过；misconfiguration 在启动期报错。
- **改造期纪律**：迁移按计划 §4 的拓扑序逐 PR 进行，每个 PR 行为不变、测试护航；新写的 feature 直接按插件形状组织，不等内核落地。

## 构建、测试与开发命令
- `pnpm install`：安装 workspace 依赖（CI 环境加 `CI=true`）。
- `pnpm dev`：turbo 并行启动全部包的 dev（web 在 3000 端口，server API 在 3001，worker 同时拉起）。
- `pnpm --filter @kenfutwork/server dev:server`：只启动 API 进程（需要根 `.env.local`）。
- `pnpm --filter @kenfutwork/server dev:worker`：只启动队列 worker。
- `pnpm build`：turbo 全量构建（shared/ui/config 出 `dist/`，web 出静态产物，server 走 `scripts/validate-foundation-app.mjs` 门禁）。
- `pnpm test`：= `test:workspace`（`node --test tests/workspace.test.mjs`）+ `test:packages`（`turbo run test`，vitest）。
- `pnpm typecheck`：turbo 全包 `tsc --noEmit`（web 先跑 `next typegen`）。
- `pnpm lint`：`biome check .`（格式 + lint，Biome 2）。
- `pnpm seed`：`pnpm --filter @kenfutwork/server seed:accounts` 经自管 Postgres 灌测试账号（幂等；账号与口令见 README「测试账号」表）。

命令必须是可直接复制执行的完整调用，包含 flags——「运行测试」这类模糊表述留给 Agent 自由发挥，是常见失败模式。

## 编码风格与命名规范
TypeScript 严格类型 + React 函数组件；lint 与格式化统一走 Biome 2（`biome check .`，两空格缩进、双引号、分号）。`camelCase` 函数/变量、`PascalCase` 组件/类型；路由/API 名反映产品工作流。ESM everywhere（`"type": "module"`，包内相对 import 带 `.js` 后缀）。非 UI 特定的共享逻辑：服务端进 `apps/server/src/features/<域>/`，客户端进 `apps/web/src/lib/`，跨端契约进 `packages/shared/src/`。

## 测试指南
vitest 按 app 配置（`apps/web/vitest.config.mjs`、`apps/server/vitest.config.mjs`、`packages/shared/vitest.config.mjs`）：web 用 jsdom + Testing Library，server/shared 用 Node 环境。服务端测试 `*.test.ts`，组件测试 `*.test.tsx`，放各自包的 `test/`（web）或与源码同目录（server/shared）。根 `tests/workspace.test.mjs` 用 `node --test` 校验仓库级门禁。bug 修复需附带针对性回归测试，交付前运行 `pnpm test` 与 `pnpm typecheck`。

**测试资源护栏（硬约束）**：turbo 默认并行调度各包测试；禁止同时运行多个测试实例（多 Agent 并行会话尤其注意），确需串行用 `pnpm exec turbo run test --concurrency=1`（**不要**写 `pnpm run test:packages -- --concurrency=1`：`--` 之后的参数会被透传给各包任务，实测 vitest 与 `tsc` 会因不认识该选项直接报错），确需调大并发先评估本机内存且只改一处。

### 测试哲学
- **测试不能止于你以为刚好够**：必须主动越界、折返并回绕多次。覆盖正常路径后，还要覆盖边界、异常、并发、幂等重放、删除后迟到请求、空输入、超长输入、并发同键等场景。
- **回归测试锁死行为**：bug 修复必须附带回归测试，把已修复的行为锁死，防止后续回归。
- **不写无意义断言**：测试要验证行为而非实现细节；不要为了凑覆盖率写 `expect(x).toBeDefined()`。
- **集成测试标注 integration**：需要真实数据库/中间件的测试命名为 `*.integration.test.ts`，默认 skipped，CI 不强制运行。

## 提交与 PR 指南
近期历史使用简洁摘要与 `feat:` / `fix:` 前缀，可带 scope：`feat(<scope>): ...`。保持 commit 小且祈使语气。PR 描述包含：问题/方案摘要、验证命令、关联 issue 或 spec、UI 改动截图或录屏。提交消息以中文为主，遵循 git commit message 规范，fix/feat 等关键词可用英文。

### 提交纪律（硬约束，均为踩坑后的规则）
1. **一步一提交、一步一测试**：每个 PR / 每次提交对应一个可验证的行为变化，提交前跑该范围的测试与 `pnpm typecheck`；行为变化必须带测试（见「测试哲学」）。
2. **显式路径 `git add <path>`，禁止 `git add -A` / `git add .`**：工作区常有并行 agent 的未跟踪草稿与实现文件；`-A` 会把它们一起扫进提交。
3. **共享文件逐 hunk 复核**：多个 agent 会同时改 `app.ts` / `profiles/*.ts` / `packages/shared` 等共享文件。提交前 `git diff` 逐 hunk 确认只含本次改动；若混入他人未提交的 hunk，用「补丁过滤后 `git apply --cached`」只暂存自己的 hunk，**不要**整文件 add，也不要替他人提交。
4. **禁止把仓库置于悬空引用状态**：提交前额外检查 HEAD 是否引用了未跟踪文件（`git stash list` 之外最容易出事的场景）。历史上曾因误带他人 hunk 导致 HEAD 无法构建。
5. **提交前必须复跑门禁**：`pnpm test`（含 `tests/workspace.test.mjs` 的仓库级棘轮/文档门禁）与 `pnpm typecheck` 至少要覆盖本次改动所在包；跨端契约（`packages/shared`）改动必须全量。
6. **文档与提交同步**：里程碑或架构级改动在 `docs/日志.md`（历轮回执 + 变更台账）里**同一提交**内更新（含问题、方案、验证命令、遗留项）；只写代码不记账视为未完成。
7. **不提交密钥与产物**：provider keys、`.env*`、凭据、`release/`、`data/`、日志、`**/dist` 一律不入库（见下节）。

## 产品行为不变量（硬约束）
主入口的行为约定在此登记，**任何 agent 改动前先读本节**，改动落点若与不变量冲突，先改回不变量再谈其它需求。

- **Design 模式的主区恒为画布（canvas），永不被对话框取代**。工作台（`/workbench`）在 Design 模式下：选中项目即渲染画布（`/canvas?id=…` 的 iframe），对话走**画布页自带的助手面板**；工作台不得用「任务/会话对话框」占据主区。该判定集中在 `apps/web/src/lib/workbench-surface.ts` 的 `resolveWorkbenchSurface`（Design 分支永不返回 `conversation`），并由 `apps/web/test/workbench-surface.test.ts` 锁死。**历史事故**：主区判定曾内联在 JSX 里且把 `activeTask` 排在画布之前，导致「发一条消息画布就被对话框顶掉」，用户多次反馈。**验收**：Design 模式主区必须是画布 iframe；任何把 `conversation` 暴露到 Design 模式的改动都不许合入。
- **Code 模式：工作目录 = 项目，run 必须绑定项目**。选定工作目录即按目录名解析出项目并选中，run 的作用域取该项目的**主画布**（`canvasId` 同时就是沙箱目录名，故同一项目的多轮运行共享同一个工作目录；追问必须沿用同一作用域，否则上一轮写的文件会「消失」）。目录名到项目的判定集中在 `apps/web/src/lib/work-directory.ts` 的 `resolveWorkDirProject`，run 侧口径在 `apps/web/src/components/workbench/workbench.tsx`，由 `apps/web/test/work-directory.test.ts` 锁死。**历史事故**：客户端曾用 `conversationId` 顶替 `canvasId`（每会话一个沙箱、项目是假的），而 run 不绑项目会**整轮秒失败**（`canvasId is required for production (state) backend mode`），且失败原因被客户端吞成「运行失败，请重试」。**验收**：Code 模式起 run 必须带项目作用域；run 失败必须透出服务端给出的可读原因。

> **项目类型由服务端一处持有**：`projects.kind ∈ {design, code}`（design=画布项目，code=工作目录项目）。
> 两个模式各自按 kind 取列表（`GET /api/projects?kind=…`），**不得**再在客户端另造一套项目（曾用
> `localStorage` 的 `codeProjects`，与服务端 `projects` 两套真相：选了工作目录列表里看不见、
> 对话因 `projectId` 指向不存在的分组而「凭空消失」）。Code 侧栏的分组必须容忍孤儿
> `projectId`——认不出的 id 一律归入「未分组」，否则对话会消失。

## 安全与配置提示
禁止提交 provider keys、`.env`、`.env.local`、service account 凭据（`**/credentials/*.json` 已 gitignore）、构建产物、日志。`.env.local` 只放本机；CI 与生产密钥走平台环境变量。

## Agent 专用指令
- 硬约束：`/init` 表示在编码前从仓库实时状态刷新本指南。
- 若 `.codegraph/` 存在，定位符号、追踪调用或评估影响时，优先使用 codegraph 而非 grep/find 或源码读取。
- 历史上下文核对：上下文压缩或新会话开始时，先核对近期对话与仓库当前状态，避免重答、重做或颠覆已确认结论。自行判断用户的中途消息是补充还是改令，不要机械中断。
- 框架与文档优先：对 LangChain / LangGraph / deepagents（先看 https://docs.langchain.com/llms.txt 索引）、Next.js、Excalidraw 等不熟悉的点，先看官方文档或源码再动手。
- 参考项目使用：`references/` 下的项目可作方向参考，但**复刻/移植必须结合本项目实际**，不得直接复制代码、schema、字段名或专有结构。

### 多 Agent 分类与配置同步
本项目同时使用多个 coding Agent，各自适用场景如下（软引导，不强制边界）：
| Agent | 主要适用场景 | 配置文件 |
| --- | --- | --- |
| **Codex CLI** | CLI 编码、批量重构、长程任务执行、复杂多文件改动 | `.codex/AGENTS.md` |
| **Claude Code** | 深度推理、spec 设计、架构分析、代码审查 | `.claude/CLAUDE.md` |
| **Trae IDE** | IDE 实时编辑、文档撰写、小型改动、调试 | `.trae/rules/`（按需创建） |
各 Agent 专用配置文件只保留**独占内容**，主体规范一律引用本文件。新增规范只修改本文件，不同步到各 Agent 配置文件——各 Agent 启动时会读取本文件。

## 开发方式
### 分支策略
- `dev` 分支受保护，**任何修改必须通过新建分支 + PR 的形式合并**，禁止直接 push 到 `dev`。
- 当前分支未合并前，后续修改可在当前分支完成，避免新建过多分支导致 dev 落后。
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
- PR 描述包含：问题/方案摘要、验证命令、关联 issue 或 spec、UI 改动截图或录屏。
### 文件命名约定
- **运行时文件保留英文**：被 `package.json` scripts 引用的、被 CI/CD 引用的、与代码同目录的 `*.test.ts/tsx`、构建/部署/安装脚本、向导脚本（避免 UTF-8 shell 问题）。
- **非运行时文件用中文**：纯文档、`docs/` 内部文档、工作笔记、独立诊断脚本（不被 CI 调用）、独立测试脚本（不被 CI 调用）。
- **脚本内部面向用户的内容用中文**：echo、提示、错误消息等用户可见输出用中文；脚本文件名可保留英文。
- **历史文件不改名**：现有文件保持原名，新文件按新约定。

## 行为准则（硬约束）
**权衡**：这些准则偏向谨慎而非速度。对于简单任务，请自行判断。
### 编码前思考 — 不要假设，不要隐藏困惑，暴露权衡
- 明确陈述你的假设。不确定时，提问。
- 存在多种合理解释时，全部呈现 — 不要默默选一种执行。
- 存在更简单的做法时，提出异议。该推回时推回。
- 某事不清楚时，停下来。指出不清楚的地方，提问。
- 事实、技术实现、版本、新闻、论文、框架、API、价格、系统行为、政策、时间敏感信息，优先联网搜索验证后再回答。
- 区分事实、推测、最佳实践、社区共识、官方文档结论，回答时明确标注。
- **避免为极少数场景堆叠备选方案**：不为不可能发生的场景做错误处理；不为长尾分支拖慢主链路或前端响应。备选方案是兜底，不是默认设计。
### 简洁优先 — 最少代码解决问题，不做投机性编写
简洁是**写新代码**的态度，不是忽略既有屎山的借口。当改动必须落在一段已腐坏的结构上时，先修正结构再谈简洁——在屎山上打最小补丁不是简洁。
- 不添加要求之外的功能。
- 不为单次使用代码创建抽象。
- 不添加未请求的"灵活性"或"可配置性"。
- **不为不可能发生的场景做错误处理**。
- 200 行能写成 50 行的，重写。
- **简洁 ≠ 对屎山视而不见**：改动落脚的代码本身混乱时，先写回归测试锁行为再重构；不要让"保持简洁"成为不改坏结构的借口。
- 检验标准：资深工程师会觉得过于复杂吗？如果是，简化。
### 精准修改 — 只碰必须碰的，只清理自己的烂摊子
"精准"指**改动范围**：与本次改动无关的东西不碰。它不是"绕过坏代码"的许可——改动**落脚**的坏结构恰恰属于"必须碰"的范围。
编辑现有代码时：
- 不要"改进"与本次改动无关的相邻代码、注释或格式。
- 不要重构没坏的东西。
- 匹配现有风格，即使你偏好不同写法。
- 注意到无关死代码时提一下，不要自行删除。
- **改动落脚的屎山必须一起收拾**：新逻辑要接在一段已腐坏的结构上时，先补回归测试，再连同本次改动修结构，而不是在屎山上垫一个补丁绕开它。
你的改动产生孤儿代码时：
- 清理 **你自己的改动** 造成的无用 import/变量/函数。
- 不要删除 **预先存在的** 死代码，除非被要求；但它若恰好在你本次改动的路径上，一并清理并说明原因。
- 检验标准：diff 中的每一行修改都应能直接追溯到用户的请求；为修结构而越出原始请求的部分，在 PR 描述中说明动机即可，不必因此回避。
### 新增与拆分 — 先改后增、先复用、必接线、即清理
**默认先改后增**：新需求的第一反应不是"新写一段"，而是先看落点的既有代码能否被修改、扩展或重构来承接——先查看可以改的代码，再决定是否新增。只有既有实现确实承接不了时才新增文件或函数；新增是兜底，不是默认动作。
- **新增前先搜同类**：新 UI/逻辑先 grep 仓库找同类实现（如 `packages/shared/src` 的共享契约、`apps/web/src/lib` 的客户端纯函数），能复用就复用，不要另写一份内联实现。
- **新增文件必须同 PR 接线**：创建替代实现的同时删除被取代的旧实现；合并前 grep 全仓确认新文件有真实消费方、旧实现零残留引用。禁止「提取后不接线」的半拆分。
- **死代码即清理**：自己的改动造成的无引用导出/文件同 PR 删除；预先存在的死代码提一下或开 issue，不顺手删。
- **拆分以职责清晰为准**：不设机械行数红线；职责混杂、出现重复逻辑时再拆。拆分产物按域归入子目录，不为拆而拆、不过度抽象。
### 可维护性 — 反屎山结构与复杂度护栏
本项目大量代码是 vibe coding 产物，**结构腐朽 + 职责混杂 + 补丁堆叠**是最常见的失败模式。屎山的本质不是行数，而是"改不动"：改一行要理解上下游十个模块，加需求只能往末尾堆 `else if`。所有改动默认遵守下列护栏。
**写新代码的红线**
- **函数/组件职责单一**：一个函数只做一件事。函数超过 80-100 行，或同时做"取数据 + 校验 + 改 UI + 打日志"等多件事，必须用 Extract Method 拆成命名清晰的小函数。
- **禁止深层嵌套与 if-else 套娃**：超过 3 层缩进即信号。用 guard clause（提前 return）、映射表、策略对象摊平；新代码禁止 `goto` 式跳转。
- **不混层**：UI 组件不内联业务逻辑与数据访问；纯逻辑进服务端 `src/features/` 或客户端 `src/lib/`。改一个字段不应牵连十个模块，也不应"编译全过、运行即崩"。
- **消灭复制粘贴**：相似逻辑第二次出现就提取共享函数，不复制第二十份。写之前先 grep 找同类实现；新提取的共享函数默认附单元测试。
**大文件的两面性**
- 千行文件不必然是屎山：自动生成代码（protobuf/parser/ORM）、纯数据常量（路由表/错误码枚举）、强内聚的单一复杂算法、框架强制结构（老式 MVC Controller）可以大。
- 一个文件**同时**满足以下信号即为屎山，必须拆（按业务边界拆，不按行数硬切）：
  - 平均函数超过 80-100 行；
  - 混杂业务逻辑、数据校验、UI 更新、日志打印等不相关职责；
  - 新人读完答不出"这个文件是干嘛的"；
  - 每次需求变更都是末尾追加 `else if`，而不是修改结构。
**改既有代码的纪律（防历史包袱）**
- **修 bug 改结构，不追加补丁**：需求变更落在正确抽象上，而不是在函数末尾再挂一个 `else if`。
- 禁止新增临时开关、条件编译、被注释的死代码；需要版本对比用 git，不要"注释留底"。
- 禁止写「// 别动，动了就出事」式注释——它出现即意味着该补回归测试并重构，而不是留下玄学。
- 禁止为兼容历史 bug 留全局 hack；确需兼容时写成显式迁移/适配层并记录原因。
**面对既有屎山（禁止大爆炸重写）**
- 先补回归测试锁住现有行为，再动手。
- 用 Extract Method 拆大块逻辑；按业务边界拆文件；消灭重复、统一共享工具函数。
- 重构必须是行为不变、测试护航的渐进过程；禁止推倒重写。
**交付前自检**：对本次改动的每个文件问：
1. 能否只改其中一小块，而不用通读全文？
2. 文件里是否塞了超过 5 个不相关的业务职责？
3. 任意变量能否在 10 秒内说清从哪来、到哪去？
4. 明天加新功能，是"拆一块出来写"，还是"继续往下堆"？
5. 是否又复制了一份相似逻辑，而不是复用？
任一答案否定，先在本次改动内修正，不要留给以后。
### 目标驱动执行 — 定义成功标准，循环直到验证通过
将指令式任务转化为可验证目标：
- "添加验证" → "为无效输入写测试，然后让它们通过"
- "修复 bug" → "写一个复现测试，然后让它通过"
- "重构 X" → "确保重构前后测试都通过"
多步骤任务先列简短计划，每步附验证方式：
```text
1. [步骤] → 验证: [检查方式]
2. [步骤] → 验证: [检查方式]
3. [步骤] → 验证: [检查方式]
```
强成功标准让 Agent 能独立循环；弱标准（"让它工作"）需要不断澄清。
### 沟通与表达规范
- **保持理性、克制、准确**：不进行情绪化迎合，不使用空洞安慰、过度夸赞或刻意拟人化表达。
- **默认采用计算机与工程领域表达风格**：优先保证正确性而非迎合用户；优先给出结论，再给分析；避免冗长废话；减少低信息密度表达；不重复用户问题；不使用营销式语言；不使用 AI 套话。
- **结构化表达**：先结论、再原因、最后给建议或代码。技术问题默认从原理、架构、复杂度、边界条件、工程实践多个层面分析。
- **涉及代码时**：默认给出可运行方案；标注时间复杂度与空间复杂度；说明适用场景与局限性；优先现代工程实践；避免过时 API；默认考虑异常处理、并发、安全性、可维护性。
- **系统设计与架构问题**：默认考虑可扩展性、可维护性、解耦、容错、性能瓶颈、安全风险、成本权衡。不只给"标准答案"，还要说明 trade-off。
- **允许指出用户方案中的潜在错误、风险与不合理设计**，而不是一味顺从。当用户表达不准确时，可以直接纠正，但需要说明依据。
- **不确定性处理**：若问题存在不确定性，明确说明不确定来源，给出概率较高的解释，不伪造不存在的信息。
- **当用户问题较模糊时**：优先基于上下文做合理推断，仅在关键歧义影响结果时再追问。如果用户要求深入分析，则提高技术密度，而不是单纯增加字数。
- **避免的行为**：无意义免责声明、机械式礼貌、重复总结、情绪化共鸣、"你这个问题很好"、"作为 AI"、"我认为"、"让我们一步一步"、过度 emoji、为了显得自然而故意口语化。
- **历史上下文核对**：当当前对话与历史对话存在明确关联时，可以参考历史上下文；若无直接关联，则禁止主动引入历史对话内容，避免上下文污染与错误联想。

## 数据库迁移（硬约束）
> 方向说明：已决策去 Supabase 云（2026-09-11），存储统一自管 Postgres（桌面捆绑本机实例 / 自托管连用户 Postgres，见《多端产品设计》§5）；当前代码仍运行在 Supabase 上，迁移前本节规则照常生效。迁移后 `supabase/migrations/` 目录名沿用，内容为 Postgres SQL，且同样约束未来新增的存储适配器。
- `supabase/migrations/` 中的原生 SQL 是唯一 Schema 迁移来源；不要引入 ORM Schema 或第二套迁移历史。
- 新迁移使用 `YYYYMMDDHHmmss_description.sql` UTC 时间戳命名（用 `supabase migration new <描述>` 生成）。迁移一旦被共享或执行就不可修改、重命名或删除；错误必须新增前向修复迁移。
- 每次迁移必须通过历史 SHA-256、实际 Schema 契约、空数据库全量重放和二次 no-op 检查。禁止覆盖账本校验和或静默重跑已执行版本。
- 本地开发（`supabase db reset` 等）仅允许在开发环境运行；Schema 校验保持只读严格校验，用于 CI 与发布前检查。生产迁移只能通过显式命令执行。
- 生产迁移只能由发布流水线的一次性迁移任务执行；API 与 Worker 使用无 DDL 权限的运行角色，并在 Schema、迁移历史或权限不匹配时拒绝启动。
- 破坏性变更采用 Expand/Contract：先扩展并保持旧代码兼容，完成回填与切流后再在后续发布收缩。不得把应用代码回滚到与已迁移数据库不兼容的版本。
- 发布必须先备份，再执行角色 bootstrap、迁移、运行权限授权、运行角色验证和 smoke test。迁移集合或校验和变化后禁止自动降级，只能前向修复或显式恢复匹配备份。

## 持久副作用与幂等性（硬约束）
- 持久副作用的 Spec 必须定义：稳定业务幂等键、键的生成方、作用域、生命周期、规范化参数指纹、冲突响应、事务边界和并发保护。
- 无法证明为 read-only 或 idempotent 的操作必须标记为 `unsafe`，禁止自动重试。随机请求 ID 不能替代稳定业务幂等键；幂等键不得包含用户内容或敏感数据。
- 删除后用于阻止迟到请求复活数据的墓碑必须定义最小保留字段和保留策略，并定义账户或工作区物理删除时的级联清除；墓碑不得保留文件名、URL、内容哈希等可识别元数据。
- 余额/配额变更必须在同一原子事务中提交余额更新与不可变交易流水，并使用稳定的业务交付键防止重复扣减、退款或发放。
- 每个涉及持久副作用的 Spec 和测试必须覆盖：顺序重放、并发重放、响应丢失后的重放、同键参数冲突，以及删除后的迟到请求。
**主链路稳定优先，对账重试兜底**：人工对账、孤儿任务对账、重试策略都是兜底机制——目标是提升系统稳定性和鲁棒性，提高多用户并发能力，而不是只会对账兜底。「有剑不用」：对账、重试、人工兜底是最后的剑，主目标是主链路本身稳定、并发扛得住，让剑永远不用出鞘。
