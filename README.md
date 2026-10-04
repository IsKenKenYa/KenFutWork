<p align="center">
  <img src="apps/web/public/logo-mark.png" width="120" alt="KenFutWork Logo">
</p>

<h1 align="center">KenFutWork</h1>

<p align="center">
  <strong>插件化的 BYOK Agent 工作台</strong>——模型、供应商、技能、插件、MCP 全由你自己接。
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue" alt="License: GPL-3.0"></a>
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A522-339933?logo=node.js&logoColor=white" alt="Node.js >= 22">
  <img src="https://img.shields.io/badge/pnpm-10-F9AD00?logo=pnpm&logoColor=black" alt="pnpm 10">
  <img src="https://img.shields.io/badge/Next.js-16-000000?logo=next.js&logoColor=white" alt="Next.js 16">
  <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black" alt="React 19">
  <img src="https://img.shields.io/badge/Fastify-5-000000?logo=fastify&logoColor=white" alt="Fastify 5">
  <img src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white" alt="TypeScript strict">
  <img src="https://img.shields.io/badge/code%20style-Biome%202-60A5FA" alt="Code style: Biome 2">
</p>

---

- **双模式**：`Code`（编码 agent，对话界面 + 工作目录=项目）与 `Design`（无限画布创作）。
- **开源基座**：Code 界面全量移植自 [ZCode](https://github.com/zai-org/ZCode)，插件内核理念源自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)——完整鸣谢见 §13。
- **六档执行方式**：自主 / 计划 / 对话 / 目标 / 循环 / 创造（创造模式下 agent 能造技能、造插件、造 MCP 工具）。
- **一切皆插件**：服务端是插件内核；第三方插件可贡献**工具 / 提示段 / HTTP 路由 / UI 面板**四类能力。
- **BYOK**：API Key 只写不读（服务端加密落库、日志脱敏、按工作区隔离），前端永不回显。

---

## 1. 目录速览

| 路径 | 是什么 |
| --- | --- |
| `apps/web` | 前端（Next.js 16 App Router + React 19 + Tailwind 4 + Excalidraw 画布） |
| `apps/server` | 后端（Fastify 5 + 插件内核 + LangChain/deepagents 运行时 + PGMQ worker） |
| `packages/shared` | 跨端 zod 契约（HTTP / WS / job 事件 / 凭据 / 插件 / 技能） |
| `packages/ui`、`packages/config` | 共享 UI 与 TS 配置 |
| `supabase/migrations` | **唯一**数据库 Schema 迁移源（原生 SQL，目录名沿用历史） |
| `plugins/` | 参考插件（`example-clock` 最小工具插件；`demo-panel` 演示四种能力） |
| `scripts/` | 构建/打包/诊断脚本（含本地搜索代理与本地模型替身） |
| `references/` | 外部开源参考项目（git 子模块），**只作方向参考**、不直接复制代码；上游清单与鸣谢见 §13 |
| `flow/` | 待合并的 flow 子系统（futureFlow，协作者项目），按 [`docs/插件/flow插件集成规划.md`](docs/插件/flow插件集成规划.md) 分阶段并入 |
| `docs/` | 技术文档；入口见 [`docs/README.md`](docs/README.md)（[`docs/日志.md`](docs/日志.md) 是历轮回执与变更台账） |

---

## 2. 快速开始（本机开发）

```bash
# 依赖：Node 22+、pnpm 10、Docker（只用它起开发库）

# 1) 起开发库（纯 Postgres，端口 5433，避开老 Supabase 栈）
docker compose -f docker-compose.pg.yml up -d --build

# 2) 配置：复制模板并按需修改（见下一节）
cp .env.example .env.local

# 3) 装依赖 + 建表 + 灌测试账号
pnpm install
pnpm --filter @kenfutwork/server migrate apply
pnpm seed

# 4) 启动（Web 3000 / API 3001 / worker 同起）
pnpm dev
```

打开 <http://localhost:3000>，用测试账号登录或直接注册。

**测试账号**（`pnpm seed` 创建，幂等；口令缺省 `kenfutwork`，可用 `KENFUTWORK_TEST_ACCOUNT_PASSWORD` 覆盖）：

| 账号 | 套餐 |
| --- | --- |
| `free@test.kenfutwork.com` | free |
| `starter@test.kenfutwork.com` | starter |
| `pro@test.kenfutwork.com` | pro |
| `ultra@test.kenfutwork.com` | ultra |

### 数据目录与身份（避免「换个启动方式数据就没了」）

认证有**两种驱动**（`KENFUTWORK_AUTH_DRIVER`）：`managed`（默认，自管账户表 + 口令登录，
自托管/云端用）与 `local-trust`（桌面免登录，固定本机账号，不做口令校验）。**BYOK 的供应商
Key 与此解耦**：按工作区加密存在本机数据目录（`credential-secret`），不随账户迁移。

| 启动方式 | 驱动 | 身份 | 数据目录 |
| --- | --- | --- | --- |
| `pnpm desktop` / DMG 安装包 / debug .app | `local-trust`（壳注入） | 本机用户 `local@kenfutwork.local` | `KENFUTWORK_DATA_DIR` |
| `pnpm dev` | `managed`（口令登录） | 登录谁就是谁 | 同上（`.env.local` 统一指向桌面数据目录） |

口径与注意（2026-09-23 起）：
- `.env.local` 的 `KENFUTWORK_DATA_DIR` 统一指向 `~/Library/Application Support/com.kenfutwork.desktop`
  （与桌面同库同身份）。旧仓库内 `.kenfutwork-data/` 是历史遗留，不再使用（保留可查）。
- `local@kenfutwork.local` 已设口令 `kenfutwork-2026`：`pnpm dev` 的登录页用它登录，
  与桌面形态看到的是**同一份**工作区/项目/对话。
- 同时只跑一套内嵌 Postgres：桌面实例占着集群时 `pnpm dev` 会 fail loud（postmaster 锁），
  先退出桌面实例即可——这是保护数据，不是故障。

**管理员**：`KENFUTWORK_ADMIN_EMAIL` + `KENFUTWORK_ADMIN_PASSWORD` 配好后再跑一次 `pnpm seed`，该账号会被创建/提升为平台管理员（幂等）。

> 开发库角色名注意：本机既有容器是历史建的（角色/库名 `loomic`），所以 `.env.local` 里的连接串用它；
> `docker-compose.pg.yml` 的默认已是 `kenfutwork`（重建容器才生效）。要统一：`ALTER ROLE loomic RENAME TO kenfutwork;`
> + `ALTER DATABASE loomic RENAME TO kenfutwork;`（需先断开连接），或重建容器（**会换数据卷，先备份**）。

---

## 3. 配置（`.env.local`）

服务端用 `--env-file` 读它；**web（Next）在 `next.config.ts` 里也读同一个文件**，所以「请求 baseUrl」这类前后端共用的值只需配一处。完整清单与说明见 [`.env.example`](.env.example)。

**必填 / 常用**：

| 变量 | 说明 |
| --- | --- |
| `KENFUTWORK_DATABASE_URL` | Postgres 连接串（也接受通用 `DATABASE_URL`） |
| `KENFUTWORK_CREDENTIAL_SECRET` | **必填**。BYOK 凭证加密主密钥（AES-256-GCM；丢了既有密文解不开） |
| `NEXT_PUBLIC_SERVER_BASE_URL` | 浏览器请求后端的地址（云端填公网地址；开发留空走同源代理） |
| `KENFUTWORK_WEB_ORIGIN` | 允许的前端来源（CORS / 回环判定） |
| `KENFUTWORK_DEPLOYMENT` | `local`（默认）/ `self-hosted` / `cloud` —— 决定能力开关，见下 |
| `KENFUTWORK_ADMIN_EMAIL`、`KENFUTWORK_ADMIN_PASSWORD` | 管理员账号（云端首次部署必须给） |
| `KENFUTWORK_SERVER_PORT` | API 端口（默认 3001） |

常用可选项：`KENFUTWORK_CANVAS_WORK_DIRS`（工作目录映射）、`KENFUTWORK_SANDBOX_ROOT`、`KENFUTWORK_MCP_SERVERS`、
`KENFUTWORK_SEARCH_API_KEY`、`KENFUTWORK_AGENT_MODEL`、`KENFUTWORK_PLUGINS_DIR`、`KENFUTWORK_AGENT_STREAM_IDLE_TIMEOUT_MS`。

---

## 4. 三种部署形态

### 4.1 本地单机（开发与桌面）

| 方式 | 命令 | 说明 |
| --- | --- | --- |
| 开发 | `pnpm dev` | web 3000 + API 3001 + worker；改代码热更新 |
| 桌面可执行包 | `pnpm fetch:runtimes` → `pnpm package:win` | 产出 `release/`：Node SEA 单文件服务端 + 静态 UI + `启动.bat`，**内嵌本机 Postgres 与 Node/Python/JDK 运行时** |

桌面包的行为：用户机**不需要装 Docker、Node、Python**；双击即用，数据落在 exe 同级的 `data/`（Postgres 数据、blobs）
与 `tmp/sandbox/`（画布工作目录）、`logs/`。git 相反——**优先用本机已装的 git**，随包 MinGit 只兜底。

### 4.2 自托管（Docker，单租户多用户）

```bash
docker build -f apps/server/Dockerfile -t kenfutwork .
docker run -e SERVICE_MODE=api    ...   # API
docker run -e SERVICE_MODE=worker ...   # Worker（可多副本）
```

要点：
- **迁移先跑**：`pnpm --filter @kenfutwork/server migrate apply`（或镜像里的迁移一次性任务）；生产只允许显式执行，API/Worker 用无 DDL 权限的运行角色。
- 反向代理需放行 **WebSocket / SSE**（`/api/ws`、run 流）。Nginx 参考：`proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";` 并关掉对 `/api/ws` 的缓冲。
- `KENFUTWORK_DEPLOYMENT=self-hosted`：插件可用；密钥经环境变量注入，不要写进镜像。

### 4.3 云端（多租户）

```bash
KENFUTWORK_DEPLOYMENT=cloud
KENFUTWORK_DATABASE_URL=postgres://...      # 托管 PG（含 sslmode）
KENFUTWORK_CREDENTIAL_SECRET=<长随机串>
KENFUTWORK_ADMIN_EMAIL=you@example.com
KENFUTWORK_ADMIN_PASSWORD=<强口令>
NEXT_PUBLIC_SERVER_BASE_URL=https://api.example.com
KENFUTWORK_WEB_ORIGIN=https://app.example.com
```

**`cloud` 与本地/自托管的差别（安全口径）**：

1. **默认禁止第三方插件**：共享基础设施不执行租户安装的代码。`install` 直接拒绝、重启不装载既有插件；
   确需开启必须显式 `KENFUTWORK_ALLOW_THIRD_PARTY_PLUGINS=true`（开启即表示接受该风险，不是"忘了关"的结果）。
2. **管理员口令必须显式配置**：不配置就没有管理员账号，也不会有公开的默认口令。
3. **多实例注意**：迁移只跑一次（单独任务）；API/Worker 各自多副本；`KENFUTWORK_SERVER_PORT` 按平台注入。

**谁能改什么（权限模型）**：

| 主体 | 能改 | 不能改 |
| --- | --- | --- |
| 平台管理员 | 系统供应商（平台池）、用户/工作区、套餐与额度、插件安装/卸载、MCP server 增删 | — |
| 普通用户 | 自己的 BYOK 供应商实例与 Key、模型选择、技能导入、自己的项目/画布/对话 | 管理员配置的任何东西（服务端对非管理员一律 403） |
| 第三方插件 | 只能通过四面能力贡献：`tools` / `systemPrompt` / `routes` / `ui` | **拿不到内核服务**（插件上下文里没有 `get/set/provide`），因此碰不到管理员配置、供应商凭证与设置项 |

---

## 5. 多端形态与打包

| 端 | 现状 | 怎么出 |
| --- | --- | --- |
| Web | 静态导出（`output: "export"`），可挂任意静态托管 | `pnpm build` → `apps/web/out/` |
| 桌面（Windows） | Node SEA 单文件 + 内嵌 PG + 随包运行时 | `pnpm fetch:runtimes` → `pnpm package:win` → `release/` |
| 桌面（macOS/Linux） | 未打包（同一份代码，需补打包脚本） | — |
| 移动端 | 以 Web 形态提供（响应式已做）；独立 App 未实现 | — |

仓库级构建门禁：`pnpm build`（`scripts/validate-foundation-app.mjs` 把关）→ `pnpm test` → `pnpm typecheck`。

---

## 6. 插件

- **安装**：插件市场「从链接安装」（GitHub 仓库 / npm tarball / 本机目录）或「从工作目录安装」（agent 产物）；变更类端点需要**管理员**。
- **能力面（四面，落地一套就登记一套）**：

| 能力 | 插件怎么写 | 效果 |
| --- | --- | --- |
| `tools` | `ctx.tools.register({name, description, parameters, execute})` | 工具进统一注册表，模型可调用 |
| `systemPrompt` | `ctx.promptFragments.register({id, text})` | 提示段追加进 system prompt（插件的"工作模式/行为引导"） |
| `routes` | `ctx.routes.register({method?, path, public?, handler})` | 自带 HTTP 端点，挂 `/api/plugins/<id>/…`；默认要登录 |
| `ui` | `ctx.ui.register({id, title, slot, url})` 或清单 `kenfutwork.ui` | 面板入口：`slot` ∈ `sidebar` / `conversation` / `canvas` / `settings` |

- **自带静态资源**：清单里 `"kenfutwork": { "assets": true }` 即可把 bundle 目录托管在 `/api/plugins/<id>/assets/…`
  （只读、公开、限 2MB、拒点文件与越界），面板页面不必自己起服务。
- 其余能力（`settings`/`llm`/`sessions`/`fs`/`subprocess`/`sandbox`/`agents`/`jobs`/`commands`）**显式拒绝并给出理由**——
  它们是结构性不匹配（需 request 级上下文或由运行时独占），不是"缺管道"。
- 参考实现：[`plugins/demo-panel`](plugins/demo-panel)（一个插件演示四种能力 + 自带页面）、[`plugins/example-clock`](plugins/example-clock)（最小工具插件）。

---

## 7. 常用命令

```bash
pnpm dev            # 全部包 dev（web 3000 / api 3001 / worker）
pnpm build          # 全量构建（web 静态导出；server 过门禁脚本）
pnpm test           # 仓库级门禁 + 各包 vitest
pnpm typecheck      # 全包 tsc --noEmit
pnpm lint           # biome check .
pnpm seed           # 灌测试账号（幂等；含可选管理员）

pnpm --filter @kenfutwork/server dev:server       # 仅 API
pnpm --filter @kenfutwork/server dev:worker       # 仅 Worker
pnpm --filter @kenfutwork/server migrate apply    # 执行迁移
pnpm fetch:runtimes / pnpm package:win            # 随包运行时 / Windows 打包
```

可调行为：**失败自动重试**缺省上限 10 次（设置 → 模型可改；**已执行工具的那轮绝不重试**；
认证/凭据/额度一类永久失败也不重试）；**每轮对话结束后自动 git 提交**（工作目录是仓库时，提交信息为「会话标题（第 N 轮）」）。

---

## 8. 联网搜索（`web_search`）

走 BYOK：把秘塔 Key 写进 `.env.local` 的 `KENFUTWORK_SEARCH_API_KEY`（缺省端点 `https://metaso.cn/api/v1/search`）。
秘塔**按量付费、无免费额度**——实测无 Key/任意 Key 一律 `errCode 2005「API密钥无效」`，所以未配 Key 时该工具不装配，属预期不是故障。

**没有秘塔 Key 也能用**：起本地搜索代理（同一套契约接到真实必应），Key 填任意非空、端点指过去：

```bash
node scripts/本地搜索代理.mjs      # 监听 127.0.0.1:9099
# .env.local：KENFUTWORK_SEARCH_API_KEY=local + KENFUTWORK_SEARCH_ENDPOINT=http://127.0.0.1:9099/search
```

代理是抓取式上游，不是稳定服务：命中无关兜底页时会被判为失败并给出可读原因（"搜索失败"≠"没搜到"）。
验收真实端点：`node scripts/诊断联网搜索.mjs`。

---

## 9. 平台管理（管理员）

- `/admin` 配置**系统供应商**（平台池，`scope='system'`）：全体用户免 Key 直接用，停用即回收。
- 走平台池按 token 折算 credit 计费，额度耗尽拦截运行并给可读原因；**自带 Key 不计费**。
- 用户/工作区管理、发减额度、切换套餐。管理员由 `profiles.role='admin'` 标记（用上面的环境变量种子），服务端对非管理员一律 403。

---

## 10. 测试与门禁

```bash
pnpm test            # = test:workspace（tests/workspace.test.mjs 仓库级门禁）+ test:packages（turbo run test）
pnpm typecheck
```

- 服务端测试与源码同目录（`*.test.ts`），需要真实库/中间件的命名为 `*.integration.test.ts`（默认 skipped）。
- 仓库级门禁覆盖：apps/packages 结构、文档地图与链接、决策 ID 登记、ctx key 单一来源等。
- **测试资源护栏**：turbo 默认并行跑各包测试；本机高负载时可能 OOM，逐包串行用
  `pnpm run test:packages -- --concurrency=1`。

---

## 11. 故障排查

| 现象 | 先看这里 |
| --- | --- |
| 刷新页面被踢回登录页 | 只有 **401** 才清本地令牌；5xx/网络错误保留。若刚重启过服务端，等它就绪再刷新 |
| 所有 run 立刻失败、提示"认证失败" | 服务端原始错误多半是 `Unable to decrypt provider credentials`——`KENFUTWORK_CREDENTIAL_SECRET` 变了/丢了 |
| 模型流卡住不动 | 空闲看门狗默认 180s 会按有界失败收尾；可用 `KENFUTWORK_AGENT_STREAM_IDLE_TIMEOUT_MS` 调 |
| 工作目录里没生成文件 | 确认 Code 模式已选「工作目录」；模型把路径写成嵌套子目录时看提示词里的工作目录说明 |
| 插件装不上 | 安装需要管理员；兼容性门禁不通过会返回报告（缺 engines、生命周期脚本、直连 `node:fs` 等） |
| 云端插件被拒 | `KENFUTWORK_DEPLOYMENT=cloud` 默认禁止第三方插件；要开需显式放开（见 §4.3） |

---

## 12. 安全红线

- 不提交 provider keys、`.env*`、service account 凭据、构建产物、日志（`.gitignore` 已覆盖）。
- BYOK Key **只写不读**：前端永不回显、服务端日志脱敏、按工作区隔离、AES-256-GCM 加密落库。
- 迁移只前向修复：已执行/共享的迁移不可改、不可重命名；Schema 校验与空库重放是发布前门禁。
- 插件是**本机执行第三方代码**：安装要管理员、云端默认关闭、能力面封闭（四面）且拿不到内核服务。

---

## 13. 鸣谢

KenFutWork 站在开源社区的肩膀上，特别感谢：

<p align="center">
  &nbsp;
  <a href="https://github.com/zai-org/ZCode"><img src="https://github.com/zai-org.png" width="52" alt="ZCode" title="ZCode"></a>&nbsp;&nbsp;&nbsp;
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://github.com/deepseek-ai.png" width="52" alt="DeepSeek Harness" title="DeepSeek Harness"></a>&nbsp;&nbsp;&nbsp;
  <a href="https://github.com/langchain-ai/deepagents"><img src="https://github.com/langchain-ai.png" width="52" alt="DeepAgents" title="DeepAgents"></a>&nbsp;&nbsp;&nbsp;
  <a href="https://github.com/openai/codex"><img src="https://github.com/openai.png" width="52" alt="Codex" title="Codex"></a>
  &nbsp;
</p>

**[ZCode](https://github.com/zai-org/ZCode)（Apache-2.0）** —— Code 模式的对话工作台、设置与插件市场界面直接采用 ZCode 3.14.3（提交 `29628c9a`）开源源码**全量移植**。上游版权与许可声明原样保留；逐文件来源、校验和与宿主适配偏差登记在 [`docs/源码来源/ZCode源码清单.json`](docs/源码来源/ZCode源码清单.json)。感谢 ZCode 提供了如此完整且高质量的 Code UI。

**[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH，MIT）** —— 服务端「**一切皆插件、没有特权核心**」插件内核架构的**理念来源**。本项目只借鉴其机制思想、结合自身实际重写实现，未复制其代码。感谢 DSH 给了本项目服务端演进的北极星。

### 真正用到的开源依赖

下表全部是 `package.json` 里的真实依赖（许可对照包内声明逐个核实过，非凭记忆）：

| 项目 | 许可 | 用在哪 |
| --- | --- | --- |
| [DeepAgents](https://github.com/langchain-ai/deepagents) | MIT | agent 运行时（规划 / 子代理 / 文件系统工具），Code/Design 共用 |
| [LangChain](https://github.com/langchain-ai/langchainjs) / [LangGraph](https://github.com/langchain-ai/langgraph) | MIT | 模型接入、agent 编排与 checkpoint 持久化 |
| [Next.js](https://github.com/vercel/next.js) / [React](https://github.com/facebook/react) | MIT | 前端框架（App Router + React 19） |
| [Fastify](https://github.com/fastify/fastify) | MIT | 后端 HTTP 框架 |
| [Excalidraw](https://github.com/excalidraw/excalidraw) | MIT | Design 模式无限画布 |
| [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss) | MIT | 样式系统 |
| [Base UI](https://github.com/mui/base-ui)（`@base-ui/react`） | MIT | 无头组件库 |
| [lucide-react](https://github.com/lucide-icons/lucide) | ISC | 图标库（随 ZCode UI 引入） |
| [zod](https://github.com/colinhacks/zod) | MIT | 跨端契约（`packages/shared`） |

工具链：[pnpm](https://github.com/pnpm/pnpm) · [Turborepo](https://github.com/vercel/turborepo) · [Biome](https://github.com/biomejs/biome) · [Vitest](https://github.com/vitest-dev/vitest)；队列用 Postgres 的 PGMQ 扩展，桌面形态内嵌 [embedded-postgres](https://github.com/leinelissen/aeonik-embedded-postgres)（MIT）。

### 仅方向参考（`references/` 子模块，未复制代码与素材）

以下项目**只作方向参考，未复制任何代码、schema、字段名与素材**：

| 项目 | 参考了什么 |
| --- | --- |
| [Codex](https://github.com/openai/codex)（Apache-2.0） | 重点参考：coding agent 的执行模式、工具面与提示设计 |
| [Cherry Studio](https://github.com/CherryHQ/cherry-studio) | 模型 Provider 管理与桌面形态 |
| [Jaaz](https://github.com/11cafe/jaaz) | 画布式设计 agent 的产品形态 |
| [kimi-code](https://github.com/MoonshotAI/kimi-code) | 治理可调数值（重试档位）的先例 |
| [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) / [MCP servers](https://github.com/modelcontextprotocol/servers) | MCP 协议与 server 实现 |
| [Octop](https://github.com/TencentCloud/Octop) | 多用户多 Agent 平台机制 |
| [nomifun-tauri](https://github.com/nomifun/nomifun-tauri) | Tauri 桌面形态 |
| [Jellyfish](https://github.com/Forget-C/Jellyfish)、[system-prompts-and-models-of-ai-tools](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools)、[seedance-2.0](https://github.com/Emily2040/seedance-2.0)、[Loomic](https://github.com/fancyboi999/Loomic) | 生成 provider、系统提示词合集、视频生成技能、品牌改名前的前身项目 |

根级 `flow/`（[futureFlow](https://github.com/future73807/futureFlow)，本仓协作者项目）是**待合并子系统**而非纯参考：按 [`docs/插件/flow插件集成规划.md`](docs/插件/flow插件集成规划.md) 分阶段并入，并入后即成为真正的第三方代码，届时报许可与 attribution。

### ZCode 移植 UI 的素材归属（2026-10 逐文件核对）

Code UI 移植携带的素材按来源分四层，归属与义务如下：

- **ZCode 第一方代码与素材**：Apache-2.0，版权人 Z.AI Co., Ltd。与本项目 GPL-3.0 兼容；移植目录（`apps/web/src/components/workbench/zcode/`）内原样保留上游 `LICENSE` / `NOTICE.md` / `THIRD-PARTY-NOTICES.md`（与上游逐字节一致），根 [NOTICE.md](NOTICE.md) 声明移植范围。
- **随上游一起移植的第三方组件**：shadcn（MIT）、ai-elements（Apache-2.0，Vercel）、Material Icon Theme 文件类型图标集（MIT，1146 个 SVG）、lucide-react（ISC）。这些组件的许可义务（版权与许可声明）由移植目录内嵌的 `THIRD-PARTY-NOTICES.md` 承接，随分发光一并分发。
- **第三方品牌 logo**（`provider-icons/`、`channel-icons/` 等处的 OpenAI、Anthropic、Discord、微信等图标）：**无开源许可**，版权归各品牌权利人。仅以指示性方式使用——logo 紧邻其对应的供应商/渠道名称，用于标识功能入口，不暗示背书；未被代码引用的品牌图标（支付类等 28 个文件）已从仓库移除。
- **商标声明**：Apache-2.0 第 3 条不授予商标权。ZCode、Z.ai、GLM 及各供应商、渠道的名称与 logo 商标归其各自权利人；本项目与上述各方无隶属或背书关系。

以上各项目版权归其各自权利人所有，按其原生许可授权使用；本仓库的 GPL-3.0 不改变上游组件的许可与版权归属。

---

## License

GPL-3.0（见 [LICENSE](LICENSE)）。所引用开源组件的归属与许可见 [§13 鸣谢](#13-鸣谢)。

### 第三方素材（字体等）

`docs/视觉设计/logo/` 下的字体样张与图片素材**不属于本项目代码，不在 GPL-3.0 的授权范围内**，版权归各自权利人所有：

- 其中三支字体是**需商业授权**的第三方字体，另有多支来自 Google Fonts 的开源字体（逐项清单与字体内许可字段原文见 [docs/视觉设计/logo/字体/字体说明.md](docs/视觉设计/logo/字体/字体说明.md)）。随本仓库分发**不构成授权**，使用前请自行取得相应许可。
- 仓库不代为授权、不担保这些素材的授权状态与可用性，也不对使用或再分发产生的任何后果负责。
