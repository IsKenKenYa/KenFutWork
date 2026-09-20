# KenFutWork

**插件化的 BYOK Agent 工作台**：模型、供应商、技能、插件、MCP 全由你自己接。

- **双模式**：`Code`（编码 agent，对话界面 + 工作目录=项目）与 `Design`（无限画布创作）。
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
| `docs/` | 技术文档；入口见 [`docs/README.md`](docs/README.md)（改造计划 §4.13 是变更台账） |

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

## License

GPL-3.0（见 [LICENSE](LICENSE)）。

### 第三方素材（字体等）

`docs/视觉设计/logo/` 下的字体样张与图片素材**不属于本项目代码，不在 GPL-3.0 的授权范围内**，版权归各自权利人所有：

- 其中三支字体是**需商业授权**的第三方字体，另有多支来自 Google Fonts 的开源字体（逐项清单与字体内许可字段原文见 [docs/视觉设计/logo/字体/字体说明.md](docs/视觉设计/logo/字体/字体说明.md)）。随本仓库分发**不构成授权**，使用前请自行取得相应许可。
- 仓库不代为授权、不担保这些素材的授权状态与可用性，也不对使用或再分发产生的任何后果负责。
