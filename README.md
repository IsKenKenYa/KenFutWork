<h1 align="center">KenFutWork</h1>

<p align="center">
  插件化 <b>BYOK Work 平台</b>——用户自定义供应商与模型的 AI 工作台。<br/>
  画布创作（Design）与编码 Agent（Code）双模式，一切能力皆插件，数据与 Key 全部落在你手里。
</p>

> 架构决策与阶段规划的唯一权威是 `docs/`：[改造计划](docs/tech/改造计划.md)、[多端产品设计](docs/tech/多端产品设计.md)。本 README 是使用入口，冲突时以文档为准。

## 快速开始

前置：Node 20+、pnpm 10+、Docker（仅本地开发库需要）。

```bash
# 1) 起本地开发库（纯 Postgres 单容器；首次加 --build）
docker compose -f docker-compose.pg.yml up -d --build

# 2) 配置环境变量（模板 .env.example）：至少填 LOOMIC_DATABASE_URL、LOOMIC_CREDENTIAL_SECRET
cp .env.example .env.local

# 3) 装依赖 + 建表 + 灌测试账号
pnpm install
pnpm --filter @loomic/server migrate apply
pnpm seed

# 4) 启动（Web 3000 / API 3001 / worker）
pnpm dev
```

打开 <http://localhost:3000> 登录，或直接注册新账号。本机库连接串
`postgres://loomic:loomic@127.0.0.1:5433/loomic`（容器 `loomic_pg_dev`；停库 `docker compose -f docker-compose.pg.yml down`，**别删卷**）。

**测试账号**（`pnpm seed` 创建，幂等，口令均为 `kenfutwork`）：

| 账号 | 套餐 |
| --- | --- |
| `free@test.kenfutwork.com` | free |
| `starter@test.kenfutwork.com` | starter |
| `pro@test.kenfutwork.com` | pro |
| `ultra@test.kenfutwork.com` | ultra |

也可指定账号：`pnpm seed -- user@example.com=my-password`。

## 目录说明

| 目录 | 说明 |
| --- | --- |
| `apps/web` | Next.js 16 前端（App Router，静态导出）。`src/app` 路由，`src/components` 画布/对话/设置组件，`src/lib` 客户端纯逻辑 |
| `apps/server` | Fastify API + Worker，同一棵插件树的两个 profile。`src/kernel` 插件内核，`src/profiles` 进程插件清单，`src/presets` design/code 能力集，`src/features` 领域插件（每个目录一个 plugin.ts），`src/providers` 线协议适配器，`src/agent` agent 运行时/沙箱/子代理，`src/http` REST 路由，`src/ws` WebSocket |
| `packages/shared` | zod 契约（HTTP / WS / job / provider）单一事实源 |
| `packages/config`、`packages/ui` | 共享 TS 配置与组件 |
| `supabase/migrations` | 数据库迁移，唯一 Schema 源（Postgres SQL） |
| `skills` | 工作区技能（SKILL.md，运行时发现） |
| `docs` | 技术文档（地图见 [docs/README.md](docs/README.md)） |
| `scripts` | docs 校验 / 打包 / 运行时下载 |

**新增 feature 的标准动作**：建 `features/<x>/plugin.ts` → 在 `profiles/server.ts` 清单加一行，入口文件不动。扩展点速查表见《改造计划》§4.10。

## 两种模式

- **Code：主区是对话**。工作目录 = 项目——选定目录即按目录名建（或复用）同名项目，Agent 在项目沙箱里读写；composer 带分支 chip 可看/切 git 分支。
- **Design：主区恒为画布**。对话走画布页自带的助手面板，图像/视频生成、排版、多轮迭代。

## 架构

```mermaid
graph TD
    Web["apps/web 前端（Next.js）"]
    subgraph Server["apps/server（API 与 Worker = 同一棵插件树的两个 profile）"]
        Kernel["插件内核：composePlugins + ctx 服务仓库 + 统一工具注册表 + agent 事件缝"]
        Base["基础能力：BYOK 供应商 · MCP · 技能 · 联网搜索 · 用量统计"]
        AgentCap["Agent 能力：沙箱文件 · 子代理 · 六档执行模式 · 三档权限审批"]
        Presets["模式层：design / code preset（会话级能力集）"]
        Kernel --> Base --> AgentCap --> Presets
    end
    Web -->|"HTTP + WebSocket"| Kernel
    Base --> DB[("自管 Postgres")]
```

- **能力缝三元组**：Service Definition + Provider + Consumer，缺角或循环依赖启动期 fail loud。
- **BYOK**：`protocol` 是封闭集合，新增协议先扩契约再写适配器；Key 加密落库、只写不读。
- **用量**：Agent 链路与直连生成双采集点，落同一张 `usage` 表。

## 平台管理（管理员）

- `/admin` 配置**系统供应商**（平台池，`scope='system'`）：全体用户免 Key 直接用，停用即回收。
- 走平台池按 token 折算 credit 计费，额度耗尽拦截运行并给可读原因；**自带 Key 不计费**。
- 用户/工作区管理、发减额度、切换套餐；管理员由 `profiles.role='admin'` 标记，服务端对非管理员一律 403。

## 常用命令

```bash
pnpm dev          # 全部包 dev（web 3000 / api 3001 / worker）
pnpm build        # 全量构建
pnpm test         # 仓库级门禁 + 各包 vitest
pnpm typecheck    # 全包 tsc --noEmit
pnpm lint         # biome check .
pnpm seed         # 灌测试账号（幂等）

pnpm --filter @loomic/server dev:server   # 仅 API（热更新）
pnpm --filter @loomic/server dev:worker   # 仅 Worker（热更新）
```

两个可调行为：**失败自动重试**缺省上限 10 次（设置 → 模型可改；已执行工具的那轮绝不重试）；**git** 优先用本机自带，随包 MinGit 只兜底（`pnpm fetch:runtimes` 下载，`pnpm package:win` 打包）。

## 部署（自托管）

- **Windows exe 单机包**：`pnpm package:win` 产出 `release/`（Node SEA 单文件服务端 + 静态 UI + 启动.bat），内置本机 Postgres 与 Node/Python/JDK 运行时，拷到任意 Windows 机器双击即用。
- **Docker 多用户**：同一镜像按 `SERVICE_MODE=api|worker` 起两个容器（`apps/server/Dockerfile`）。
- 验证成品 UI：`pnpm build` 后 `LOOMIC_WEB_DIST=<repo>/apps/web/out pnpm --filter @loomic/server start`，开 <http://localhost:3001>。

## 测试与文档

- `pnpm test` = workspace 门禁 + 各包 vitest；bug 修复必须附带回归测试。
- 文档治理（单一属主 + 决策 ID + 机械校验 `pnpm test:docs`）见 [docs/README.md](docs/README.md)。
- 产品行为不变量（Design 恒画布 / Code 必绑项目等）登记在 [AGENTS.md](AGENTS.md)，改动前先读。

## License

GPL-3.0。
