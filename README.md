<p align="center">
  <img src="apps/web/public/logo.svg" alt="Loomic Logo" width="80" />
</p>

<h1 align="center">Loomic</h1>

<p align="center">
  插件化 <b>BYOK Work 平台</b>——画布 AI 创作（design）与编码 Agent（code）双模式。<br/>
  自带模型 Key（BYOK），数据落在你自己的数据库里，开源（GPL-3.0）。
</p>

<p align="center">
  <img width="900" src="docs/images/base-image.png" alt="Loomic" />
</p>

---

## Loomic 是什么

Loomic 是一个基于无限画布的 AI 创作工作台：在画布上跟 Agent 对话，直接生成图片/视频、排版、迭代，不需要时间轴和模板。2026-09 完成插件化改造（P0–P8）后：

- **插件内核**：一切行为挂在插件上，`app.ts` 只剩约百行的装配薄封装；新增 feature = 一个 `features/<x>/plugin.ts` + profiles 清单一行。
- **BYOK 供应商缝**：用户在前端「供应商设置」添加自己的模型实例（OpenAI 兼容 / Anthropic / Gemini / 图像 / 视频协议），Key 加密落库、只写不读，对话与生成按实例实例化协议适配器——服务端零代码。
- **统一工具注册表**：MCP、联网搜索、skill、文件预览、差异分析都注册进 `ctx.tools`，按会话 preset 过滤后桥接进模型工具列表。
- **执行模式与权限**：会话级 agent/plan 模式切换；危险工具三档权限（默认审批 / 自动放行 / 完全访问），审批只能由用户发起。
- **用量统计**：Agent 链路（streamUsage）与直连生成（job 回调）双采集点落同一张 `usage` 表。

架构蓝图见 [docs/tech/改造计划.md](docs/tech/改造计划.md)，多端形态（桌面/自托管）见 [docs/tech/多端产品设计.md](docs/tech/多端产品设计.md)。

<p align="center">
  <img width="900" src="docs/images/home-image.png" alt="Loomic Workspace" />
</p>

---

## 架构

服务端是「内核 + 插件」的单插件树装配，双进程（API + Worker）来自同一棵树的两个 profile：

```
┌──────────────────────────────────────────────────────────────┐
│ 模式层   design preset（画布 + 依附插件） / code preset（编码）  │
├──────────────────────────────────────────────────────────────┤
│ Agent 能力层  文件预览 / 差异分析 / 子代理缝 / 执行模式 / 权限    │
├──────────────────────────────────────────────────────────────┤
│ 基础能力层  模型配置(BYOK) / MCP / Skill / 联网搜索 / 用量统计   │
├──────────────────────────────────────────────────────────────┤
│ 内核层   composePlugins + ctx(服务仓库) + ctx.tools            │
│          + 3 个 agent-run 事件缝（pre-step / tool-pre-execute  │
│          / turn-stopping）                                    │
└──────────────────────────────────────────────────────────────┘
```

装配关系：

- **profiles**（`apps/server/src/profiles/`）：进程形态的插件清单唯一属主——`server.ts`（HTTP 进程，含路由）、`worker.ts`（队列进程，只取服务）。`app.ts` / `worker.ts` 只做「选 profile → composePlugins」。
- **presets**（`apps/server/src/presets/`）：design/code 是会话级能力集（DEC-2），按工具 scope 过滤，shared 恒可用。
- **能力缝三元组**：可替换能力 = 服务接口（`kernel/types.ts` 的 `ServiceMap`，即 ctx key 表）+ Provider（实现）+ Consumer（路由/工具/executor）；缺一角启动期 fail loud，循环依赖启动期抛错。
- **数据**：Supabase（Postgres + Auth + Storage + PGMQ）为迁移期存量；去 Supabase 的自管 Postgres 迁移路径见《多端产品设计》§5（D1–D3）。

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

在你的 Supabase 中创建 4 个测试账号（free / starter / pro / ultra，密码均为 `opensourceloomic`），无需接支付即可体验各套餐。

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

## 目录结构

```
KenFutWork/
├── apps/
│   ├── web/                        # Next.js 16 前端（App Router，静态导出）
│   │   ├── src/app/                #   路由（workspace / canvas / auth / pricing）
│   │   ├── src/components/         #   画布 / 对话 / 设置组件
│   │   │   └── provider-settings.tsx #  BYOK 供应商设置（Key 只写不读）
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

带 ★ 的是插件化改造的核心目录。**新增 feature 的标准动作**：建 `features/<x>/plugin.ts`（服务工厂 + 路由挂到 `mounted` 阶段）→ 在 `profiles/server.ts` 清单加一行——`app.ts` 不需要动。

## 关键配置速查

| 变量 | 说明 |
| --- | --- |
| `LOOMIC_CREDENTIAL_SECRET` | BYOK 凭证加密主密钥（AES-256-GCM）；配置后用户才能在前端保存 Key |
| `LOOMIC_MCP_SERVERS` | MCP server 配置（JSON 数组，stdio 命令型），工具自动注册进 `ctx.tools` |
| `LOOMIC_SEARCH_API_KEY` | 联网搜索（`web_search` 工具）供应商 Key；`LOOMIC_SEARCH_PROVIDER` v1 仅 `metaso` |
| `LOOMIC_AGENT_MODEL` | 内置默认模型（`google:gemini-2.5-flash` / `openai:gpt-4o`；BYOK 实例模型经前端选择器下发） |
| `LOOMIC_SERVER_PORT` / `LOOMIC_WEB_ORIGIN` | API 端口（默认 3001）/ 前端源（CORS） |
| `WORKER_*` | Worker 并发与轮询（见 `.env.example`） |

## 部署（自托管）

产品方向为「桌面本地 + 自托管」两形态（2026-09-11 决策移除平台云托管）：

```bash
# API 进程
SERVICE_MODE=api docker build -t loomic-server -f apps/server/Dockerfile .
# Worker 进程（同镜像，不同环境变量）
SERVICE_MODE=worker WORKER_ID=w1 ...
```

Vercel / Railway 等平台托管配置已随该决策移除。桌面端（Tauri）与自托管 Compose 的路线见《多端产品设计》§13。

## 测试与文档

- `pnpm test`：workspace 门禁（`tests/workspace.test.mjs`，含 docs 治理校验）+ 各包 vitest（内核 / 插件 / 契约 / 前端组件全覆盖）。
- 文档治理：单一属主 + 决策稳定 ID（`DEC-*` / `FORM-*`）+ 机械校验（`pnpm test:docs`），规则见 [docs/README.md](docs/README.md)；架构改动先改文档再动代码。
- `references/` 是外部参考项目（git submodule），只作方向参考，不参与构建。

## License

GPL-3.0。第三方商标与模型服务归属各自所有者。
