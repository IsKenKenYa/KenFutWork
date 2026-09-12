<h1 align="center">KenFutWork</h1>

<p align="center">
  插件化 <b>BYOK Work 平台</b>——用户自定义供应商与模型的 AI 工作台。<br/>
  画布创作（design）与编码 Agent（code）双模式，一切能力皆插件，数据与 Key 全部落在你手里。
</p>

> 项目定位、架构决策与阶段规划的唯一权威是本仓库的 `docs/`：
> [docs/tech/改造计划.md](docs/tech/改造计划.md)（插件内核 × BYOK × 双模式蓝图）、
> [docs/tech/多端产品设计.md](docs/tech/多端产品设计.md)（桌面 / 自托管多端形态）。
> 本 README 是面向使用者的入口，与文档冲突时以文档为准。

---

## 这是什么

按《改造计划》的定义，这是一个 **BYOK（Bring Your Own Key）Work 平台**：用户自带模型 Key，按工作区配置自己的供应商与模型实例，平台不再持有也不经手任何模型账单。两大产品模式共享同一套插件内核：

- **design 模式（画布创作）**：无限画布上与 Agent 对话，生成/编辑图像与视频、排版、多轮迭代；Agent 读写画布上下文。
- **code 模式（编码 Agent）**：文件预览、差异分析、子代理、执行模式（agent / plan）、危险工具三档权限。

三个贯穿全局的设计决策：

1. **插件内核（一切皆插件）**：自建约 150 行内核（`composePlugins` + 服务仓库 `ctx` + 统一工具注册表 `ctx.tools` + 3 个 agent-run 事件缝），所有业务能力都是挂到扩展点上的插件；新增 feature 不改核心。
2. **BYOK 供应商缝**：协议适配器封闭集合（openai-compatible / anthropic / gemini / 图像 / 视频协议），用户实例加密落库（Key 只写不读），对话与生成按实例实例化——接入新供应商零代码。
3. **多端形态（规划中）**：桌面本地（Tauri 内嵌服务端）为主形态 + Docker 自托管，已决策移除平台云托管；数据落在用户自己的 Postgres 里。

存储现状：Supabase（Postgres + Auth + Storage + PGMQ）为迁移期存量，去 Supabase 的自管 Postgres 迁移是已规划的独立工程（见《多端产品设计》§5）。

开源协议 GPL-3.0。

---

## 架构

服务端是「内核 + 插件」的单插件树装配，API 与 Worker 双进程来自同一棵树的两个 profile：

```
┌──────────────────────────────────────────────────────────────┐
│ 模式层   design preset（画布 + 依附插件） / code preset（编码）  │
├──────────────────────────────────────────────────────────────┤
│ Agent 能力层  文件预览 / 差异分析 / 子代理缝 / 执行模式 / 权限    │
├──────────────────────────────────────────────────────────────┤
│ 基础能力层  模型配置(BYOK) / MCP / Skill / 联网搜索 / 用量统计   │
├──────────────────────────────────────────────────────────────┤
│ 内核层   composePlugins + ctx(服务仓库) + ctx.tools            │
│          + 3 个 agent-run 事件缝（pre-step / tool-pre-execute   │
│          / turn-stopping）                                     │
└──────────────────────────────────────────────────────────────┘
```

- **profiles**（`apps/server/src/profiles/`）：进程形态的插件清单唯一属主——`server.ts`（HTTP 进程，含路由）、`worker.ts`（队列进程，只取服务）。入口文件只做「选 profile → composePlugins」。
- **presets**（`apps/server/src/presets/`）：design / code 是会话级能力集（DEC-2），按工具 scope 过滤，shared 恒可用。
- **能力缝三元组**：可替换能力 = 服务接口（`kernel/types.ts` 的 `ServiceMap`，即 ctx key 表）+ Provider（实现）+ Consumer（路由/工具/executor）；缺一角或循环依赖在启动期 fail loud。
- **统一工具注册表**：MCP、联网搜索、skill、文件预览、差异分析注册进 `ctx.tools`，按会话 preset 过滤后桥接进模型工具列表；危险调用经 `tool-pre-execute` 事件走三档权限策略（DEC-4）。
- **用量统计**：Agent 链路（LangChain streamUsage）与直连生成（job 回调）双采集点落同一张 `usage` 表（DEC-6）。

---

## 快速开始

### 前置要求

- Node.js ≥ 20、pnpm ≥ 10（`npm install -g pnpm`）
- Supabase CLI（`brew install supabase/tap/supabase`）+ 一个 Supabase 项目（免费档可用）
- 至少一个 AI 供应商 Key（Google 或 OpenAI）

### 1. 安装

```bash
git clone https://github.com/IsKenKenYa/KenFutWork.git
cd KenFutWork
pnpm install
```

### 2. 初始化数据库

```bash
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

迁移会建齐全部表、RLS 策略、存储桶与 PGMQ 队列（源在 `supabase/migrations/`，是唯一 Schema 源）。

### 3. 配置环境

```bash
cp .env.example .env.local
```

最小可用配置：

```bash
# ── Supabase（必需）────────────────────────────
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SUPABASE_DB_URL=postgresql://postgres:pw@db.xxx:5432/postgres
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key

# ── 至少一个 AI 供应商（内置目录，迁移期存量）───
LOOMIC_AGENT_MODEL=google:gemini-2.5-flash        # 或 openai:gpt-4o
GOOGLE_API_KEY=your-google-api-key
# OPENAI_API_KEY=your-openai-key

# ── BYOK 供应商设置（可选，推荐）───────────────
# 用户在前端「设置 → Providers」添加实例，Key 加密落库需要主密钥：
LOOMIC_CREDENTIAL_SECRET=any-long-random-string
```

完整变量见 [`.env.example`](.env.example)（含 MCP / 联网搜索 / Vertex / 支付 / Worker）。

### 4. （可选）灌测试账号

```bash
pnpm seed
```

在你的数据库中创建 4 个测试账号（free / starter / pro / ultra，密码均为 `opensourceloomic`），无需接支付即可体验各套餐。

### 5. 启动开发

```bash
pnpm dev
```

| 服务 | 地址 | 说明 |
| --- | --- | --- |
| Web | http://localhost:3000 | Next.js 前端 |
| API Server | http://localhost:3001 | Fastify API + WebSocket |
| Worker | — | PGMQ 后台任务（图像/视频生成） |

只起单进程：

```bash
pnpm --filter @loomic/server dev:server       # 仅 API
pnpm --filter @loomic/server dev:worker       # 仅 Worker
pnpm --filter @loomic/server dev:workers:2    # 2 个 Worker 横向扩容
```

### 常用命令

```bash
pnpm build        # 全量构建（shared 出 dist，web 静态导出）
pnpm test         # workspace 门禁 + 各包 vitest
pnpm typecheck    # 全包 tsc --noEmit
pnpm lint         # biome check .
pnpm test:docs    # docs 治理校验（链接/冻结区/决策 ID）
```

---

## 目录结构

```
KenFutWork/
├── apps/
│   ├── web/                        # Next.js 16 前端（App Router，静态导出）
│   │   ├── src/app/                #   路由（workspace / canvas / auth / pricing）
│   │   ├── src/components/         #   画布 / 对话 / 设置组件
│   │   │   ├── provider-settings.tsx #  BYOK 供应商设置（Key 只写不读）
│   │   │   └── execution-mode-select.tsx # 会话级执行模式切换
│   │   ├── src/hooks/              #   use-chat-stream / use-websocket 等
│   │   └── src/lib/                #   server-api 等客户端纯逻辑
│   └── server/                     # Fastify API + Worker（同一棵插件树）
│       ├── src/
│       │   ├── kernel/             # ★ 插件内核：composePlugins + ctx +
│       │   │                       #   tools/capabilities 注册表 + 事件缝
│       │   ├── profiles/           # ★ 进程插件清单（server.ts / worker.ts）
│       │   ├── presets/            # ★ 会话级能力集（design / code）
│       │   ├── features/           # ★ 领域插件（每个目录一个 plugin.ts）
│       │   │   ├── model-providers/  #  BYOK 实例 CRUD + SecretStore + 目录
│       │   │   ├── agent-runs/       #  agent 运行时三件套
│       │   │   ├── permissions/      #  三档权限策略缝
│       │   │   ├── agent-modes/      #  执行模式（agent / plan）
│       │   │   ├── search/           #  联网搜索工具
│       │   │   ├── mcp/              #  MCP 工具接入
│       │   │   ├── usage/            #  用量统计（双采集点）
│       │   │   └── …                 #  canvas / chat / credits / jobs / …
│       │   ├── providers/          # ★ 线协议适配器（openai-compatible /
│       │   │                       #   anthropic / gemini / google-image /
│       │   │                       #   replicate / volces / metaso）
│       │   ├── agent/              #   deepagents 运行时 / 工具桥 / 子代理
│       │   ├── http/               #   REST 路由（registerXxxRoutes）
│       │   ├── ws/                 #   WebSocket 连接管理与事件缓冲
│       │   ├── generation/         #   图像/视频生成实现（迁移期 env 注册）
│       │   ├── queue/              #   PGMQ 客户端
│       │   ├── config/             #   环境变量解析（fail loud）
│       │   ├── supabase/           #   admin / user 客户端（存储缝存量）
│       │   └── app.ts              #   薄封装：选 profile → composePlugins
│       └── Dockerfile              #   自托管镜像（SERVICE_MODE=api|worker）
├── packages/
│   ├── shared/                     # zod 契约（HTTP/WS/job/provider）单一事实源
│   ├── config/                     # 共享 TS 配置
│   └── ui/                         # 共享组件
├── supabase/migrations/            # 数据库迁移（唯一 Schema 源）
├── skills/                         # 工作区技能（SKILL.md，运行时发现）
├── docs/                           # 技术文档（地图见 docs/README.md）
│   ├── tech/                       #   改造计划（权威）+ 多端产品设计
│   ├── decisions/                  #   ADR（DEC-* / FORM-* 拍板记录）
│   └── future/                     #   现状快照与调研
├── references/                     # 外部参考项目（git submodule，只读参考）
└── scripts/                        # docs 校验 / 种子脚本等
```

带 ★ 的是插件内核与插件目录。**新增 feature 的标准动作**：建 `features/<x>/plugin.ts`（服务工厂 + 路由挂到 `mounted` 阶段）→ 在 `profiles/server.ts` 清单加一行——入口文件不需要动。扩展点速查表见《改造计划》§4.10。

## 关键配置速查

| 变量 | 说明 |
| --- | --- |
| `LOOMIC_CREDENTIAL_SECRET` | BYOK 凭证加密主密钥（AES-256-GCM）；配置后用户才能在前端保存 Key |
| `LOOMIC_MCP_SERVERS` | MCP server 配置（JSON 数组，stdio 命令型），工具自动注册进 `ctx.tools` |
| `LOOMIC_SEARCH_API_KEY` | 联网搜索（`web_search` 工具）供应商 Key；`LOOMIC_SEARCH_PROVIDER` v1 仅 `metaso` |
| `LOOMIC_AGENT_MODEL` | 内置默认模型（`google:gemini-2.5-flash` / `openai:gpt-4o`；BYOK 实例模型经前端选择器下发） |
| `LOOMIC_SERVER_PORT` / `LOOMIC_WEB_ORIGIN` | API 端口（默认 3001）/ 前端源（CORS） |
| `WORKER_*` | Worker 并发与轮询（见 `.env.example`） |

> 注：`@loomic/*` 为 workspace 包名与镜像名（代码事实），与产品命名无关。

## 部署（自托管）

产品方向为「桌面本地 + 自托管」两形态（2026-09-11 决策移除平台云托管）：

```bash
# API 进程
SERVICE_MODE=api docker build -t work-server -f apps/server/Dockerfile .
# Worker 进程（同镜像，不同环境变量）
SERVICE_MODE=worker WORKER_ID=w1 ...
```

Vercel / Railway 等平台托管配置已随该决策移除。桌面端（Tauri）与自托管 Compose 的路线见《多端产品设计》§13。

## 测试与文档

- `pnpm test`：workspace 门禁（`tests/workspace.test.mjs`，含 docs 治理校验）+ 各包 vitest（内核 / 插件 / 契约 / 前端组件全覆盖）。
- 文档治理：单一属主 + 决策稳定 ID（`DEC-*` / `FORM-*`）+ 机械校验（`pnpm test:docs`），规则见 [docs/README.md](docs/README.md)；架构改动先改文档再动代码。
- `references/` 是外部参考项目（git submodule），只作方向参考，不参与构建。

## License

GPL-3.0。
