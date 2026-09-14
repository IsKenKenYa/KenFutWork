<h1 align="center">KenFutWork</h1>

<p align="center">
  插件化 <b>BYOK Work 平台</b>——用户自定义供应商与模型的 AI 工作台。<br/>
  画布创作（Design）与编码 Agent（Code）双模式，一切能力皆插件，数据与 Key 全部落在你手里。
</p>

> 项目定位、架构决策与阶段规划的唯一权威是本仓库的 `docs/`：
> [docs/tech/改造计划.md](docs/tech/改造计划.md)（插件内核 × BYOK × 双模式蓝图）、
> [docs/tech/多端产品设计.md](docs/tech/多端产品设计.md)（桌面 / 自托管形态）。
> 本 README 是面向使用者的入口，与文档冲突时以文档为准。

---

## 快速开始

前置：Node 20+、pnpm 10+、Docker（仅本地开发库需要）。

```bash
# 1) 起本地开发库（纯 Postgres，单容器；首次加 --build）
docker compose -f docker-compose.pg.yml up -d --build

# 2) 配置环境变量（模板见 .env.example）
cp .env.example .env.local
#   至少填：LOOMIC_DATABASE_URL（默认指向下面的本机库）
#           LOOMIC_CREDENTIAL_SECRET（BYOK Key 的加密主密钥，任意长随机串）

# 3) 装依赖 + 建表 + 灌测试账号
pnpm install
pnpm --filter @loomic/server migrate apply   # 迁移源在 supabase/migrations/，唯一 Schema 源
pnpm seed                                    # 建 4 个测试账号（见下表）

# 4) 启动（Web 3000 / API 3001 / worker 一起拉起）
pnpm dev
```

打开 <http://localhost:3000>，用下表账号登录，或直接注册新账号。

本机开发库连接串：`postgres://loomic:loomic@127.0.0.1:5433/loomic`
（容器 `loomic_pg_dev`，卷 `loomic_pg_dev_data`；停库用 `docker compose -f docker-compose.pg.yml down`，**别删卷**）。

### 测试账号

`pnpm seed` 会创建以下账号（幂等：重跑只重置口令，不重复建）：

| 账号 | 套餐 | 口令 |
| --- | --- | --- |
| `free@test.kenfutwork.com` | free | `kenfutwork` |
| `starter@test.kenfutwork.com` | starter | `kenfutwork` |
| `pro@test.kenfutwork.com` | pro | `kenfutwork` |
| `ultra@test.kenfutwork.com` | ultra | `kenfutwork` |

也可以指定账号：`pnpm seed -- user@example.com=my-password`。

### 两种模式

- **Code 模式**：主区是对话。**工作目录 = 项目**——选定工作目录即按目录名建（或复用）同名项目，
  对话挂在该项目下、Agent 在该项目的工作目录里读写文件；「不在项目中工作」则不绑定项目。
  输入区还带一个**分支 chip**：直接看/切该工作目录的 git 分支（目录不是仓库时会写明，而不是给个空下拉）。
- **Design 模式**：主区**恒为画布**（`/canvas` 的 iframe，对话在画布页自带的助手面板里），
  生成/编辑图像与视频、排版、多轮迭代。

---

## 目录结构

```
KenFutWork/
├── apps/
│   ├── web/                        # Next.js 16 前端（App Router，静态导出）
│   │   ├── src/app/                #   路由（workbench / canvas / login / register / admin）
│   │   ├── src/components/         #   画布 / 对话 / 设置 / 工作目录选择器
│   │   ├── src/hooks/              #   use-chat-stream / use-websocket
│   │   └── src/lib/                #   客户端纯逻辑（server-api / work-directory / run-failure …）
│   └── server/                     # Fastify API + Worker（同一棵插件树的两个 profile）
│       ├── src/
│       │   ├── kernel/             #   插件内核：composePlugins + ctx + 工具注册表 + 事件缝
│       │   ├── profiles/           #   进程插件清单（server.ts / worker.ts）
│       │   ├── presets/            #   会话级能力集（design / code）
│       │   ├── features/           #   领域插件（每个目录一个 plugin.ts）
│       │   ├── providers/          #   线协议适配器（openai-compatible / anthropic / gemini / …）
│       │   ├── agent/              #   agent 运行时 / 工具桥 / 子代理 / 沙箱后端
│       │   ├── http/               #   REST 路由（registerXxxRoutes）
│       │   └── ws/                 #   WebSocket 连接管理与事件缓冲
│       └── Dockerfile              #   自托管镜像（SERVICE_MODE=api|worker）
├── packages/
│   ├── shared/                     # zod 契约（HTTP / WS / job / provider）单一事实源
│   ├── config/                     # 共享 TS 配置
│   └── ui/                         # 共享组件
├── supabase/migrations/            # 数据库迁移（唯一 Schema 源；去 Supabase 后仍是 Postgres SQL）
├── skills/                         # 工作区技能（SKILL.md，运行时发现）
├── docs/                           # 技术文档（地图见 docs/README.md）
│   ├── tech/                       #   改造计划（权威）+ 多端产品设计
│   └── future/                     #   现状快照与调研
└── scripts/                        # docs 校验 / 打包 / 运行时下载
```

**新增 feature 的标准动作**：建 `features/<x>/plugin.ts`（服务工厂 + 路由挂到 `mounted` 阶段）→
在 `profiles/server.ts` 清单加一行；入口文件不需要动。扩展点速查表见《改造计划》§4.10。

---

## 架构

服务端是「内核 + 插件」的单插件树装配，API 与 Worker 双进程来自同一棵树的两个 profile。
分层自下而上：

- **内核层**：`composePlugins`（装配 + 环检测 + fail loud 配置门禁）、`ctx`（服务仓库，key 权威表见《改造计划》§4.2）、
  `ctx.tools`（统一工具注册表，MCP / 搜索 / 技能 / 文件工具都注册在这里）、3 个 agent-run 事件缝
  （`pre-step` / `tool-pre-execute` / `turn-stopping`）。
- **基础能力层**：BYOK 模型实例（加密落库、Key 只写不读）、MCP 接入、技能（SKILL.md 发现 + 市场）、
  联网搜索、用量统计。
- **Agent 能力层**：文件预览、差异分析、子代理缝、执行模式（六档）、危险工具三档权限审批。
- **模式层**：design / code 两个 preset——会话级能力集，按工具 scope 过滤，shared 恒可用。

要点：

- **能力缝三元组**：可替换能力 = Service Definition（接口）+ Provider（实现）+ Consumer（路由/工具/executor）；
  缺一角或循环依赖在启动期 fail loud。
- **presets**（`apps/server/src/presets/`）：design / code 是会话级能力集，不是两套代码。
- **BYOK**：`ProviderInstanceConfig.protocol` 是封闭集合，新增协议必须先扩契约再写适配器；
  禁止在业务代码里内联供应商判断。
- **用量统计**：Agent 链路（LangChain streamUsage）与直连生成（job 回调）双采集点落同一张 `usage` 表。

## 平台管理（管理员后台）

除自带 Key 的 BYOK 玩法外，平台侧可以统一配好模型再分发给用户，并做额度计费：

- **系统供应商（平台池）**：管理员在 `/admin` 配置带平台 Key 的供应商实例（`provider_instances.scope='system'`），
  全体用户无需自带 Key 即可在模型选择器里直接使用；停用即回收分发。
- **计费与额度**：走平台池的对话按 token 折算 credit 扣用户额度；额度耗尽会拦住运行并给出可读原因；
  **自带 Key 的调用不计费**。
- **统一管理**：用户/工作区列表、用量与成本总览、发/减额度、切换套餐、授予/回收管理员。
- **权限**：管理员由 `profiles.role='admin'` 标记；普通用户界面上没有入口，服务端对所有 `/api/admin/*`
  返回 403（前端隐藏不是安全边界）。决策见《改造计划》§6 `FORM-10`。

---

## 常用命令

```bash
pnpm dev          # 并行启动全部包的 dev（web 3000 / api 3001 / worker）
pnpm build        # 全量构建（shared/ui 出 dist，web 静态导出）
pnpm test         # 仓库级门禁 + 各包 vitest
pnpm typecheck    # 全包 tsc --noEmit
pnpm lint         # biome check .
pnpm test:docs    # docs 治理校验（链接 / 冻结区 / 决策 ID）
pnpm seed         # 灌测试账号（幂等）
```

只起单进程：

```bash
pnpm --filter @loomic/server dev:server    # 仅 API（热更新）
pnpm --filter @loomic/server dev:worker    # 仅 Worker（热更新）
```

### 两个可调行为

- **失败自动重试**：run 因上游抖动失败会自动重试，**缺省上限 10 次**，可在「设置 → 模型」里改（0 = 不重试）。
  安全边界：**本轮已执行工具就不重试**——重试会重复施加副作用（重复写文件、重复执行命令）。
- **git 来源**：优先用本机自带的 git，没有才用随包分发的（打包前 `pnpm fetch:runtimes` 会把 MinGit 取到
  `runtime/git`，`pnpm package:win` 一并打进包）。

## 部署（自托管）

**形态一：Windows exe 包（单机自托管）**

```bash
pnpm package:win
```

产出 `release/`：`KenFutWork-server.exe`（Node SEA 单文件服务端，内置 Node 运行时）+ `web/`（静态 UI）+
`启动.bat` + `说明.txt`。整个 `release/` 可拷到任意 Windows 机器（无需装 Node），双击「启动.bat」即启动。
内置本机 Postgres 与随包语言运行时（Node/Python/uv/JDK）；在同目录放 `.env` 可切换外部数据库。

**形态二：Docker 自托管（多用户）**

```bash
SERVICE_MODE=api    docker build -t work-server -f apps/server/Dockerfile .
SERVICE_MODE=worker docker build -t work-server -f apps/server/Dockerfile .
```

API 与 Worker 用同一镜像、不同 `SERVICE_MODE`。管理员登录后用 `/admin` 做运维级管理。
桌面端与自托管 Compose 的路线见《多端产品设计》§13。

**验证「用户拿到的成品」**：`pnpm build` 后由 server 直接托管静态 UI——
`LOOMIC_WEB_DIST=<repo>/apps/web/out pnpm --filter @loomic/server start`，打开 <http://localhost:3001>。

## 测试与文档

- `pnpm test`：workspace 门禁（`tests/workspace.test.mjs`，含 docs 治理校验）+ 各包 vitest。
- 文档治理：单一属主 + 决策稳定 ID（`DEC-*` / `FORM-*`）+ 机械校验（`pnpm test:docs`），
  规则见 [docs/README.md](docs/README.md)；架构改动先改文档再动代码。
- 主入口的产品行为不变量登记在 [AGENTS.md](AGENTS.md)「产品行为不变量」，改动前先读那一节。

## License

GPL-3.0。
