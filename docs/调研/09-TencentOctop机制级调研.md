# 08 · TencentCloud Octop 机制级调研

> 调研对象：[references/octop/](../../references/octop/)（TencentCloud/Octop，浅克隆，v1.0.2b5，MIT）。
> 调研方式：Explore 子代理分域源码深读，结论全部带 `文件:行号` 引用可回源核对（行号是 2026-09-25 子模块快照值，子模块更新后以符号名为准）。
> 对照基准：KenFutWork（下称 KFW）现状——Fastify5 + deepagents 内核插件化、Next.js16、Tauri2 sidecar（内嵌 PG + CJS 服务端）、BYOK 供应商实例加密落本机、credits 计费、managed/local-trust 双认证驱动、flow 子模块（Dify 工作流）。

---

## 一、Octop 是什么（整体架构）

**单进程 Python 自托管 AI 助手平台**（多用户、多 Agent），一个 wheel = FastAPI 后端 + React dashboard + Click CLI（`AGENTS.md:37-39`）。关键定性：**仓库本身不含 Agent 内核**——Agent 运行时在外部包 `octop-harness`（LangGraph 系），IM 网关在 `octop-gateway`（`pyproject.toml:24-27`、`docs/architecture.md:4-6`）。本仓库是「平台壳」：多用户、API、IM 接入、cron、知识库、插件管理、打包。

四层结构（`docs/architecture.md:15-22`、`AGENTS.md:79-104`）：`dashboard/(React SPA) → api/(FastAPI 路由) → infra/(领域层) → infra/db + infra/utils`，依赖单向内流，硬性禁令表（`AGENTS.md:97-104`）；组合根唯一放行点 `launch.py`（`launch.py:56-156`）。进程装配序：ExpertCatalog → SubagentCatalog → PluginManager → DB+迁移 → SharedServices(DI) → AgentManager → Gateway → CronManager → UserManager（`src/octop/infra/server.py:283-334`）。**无外部队列/无 worker**：单进程 asyncio、重启即从控制面 DB 全量重建（ADR `docs/adr/001-single-process-model.md:14-27`——理由：Agent 调用是 LLM-bound I/O，asyncio 扇出即可；代价：只能纵向扩展）。

数据库：控制面 SQLite(WAL) 默认 / PostgreSQL 可选，**双引擎并行迁移** `00N.sql + 00N.pg.sql`（`AGENTS.md:223-226`、ADR 002）；三层存储分离（控制面 / harness checkpoint / agent 记忆）。资源表统一 `id`(整数代理键) + `{entity}_id`(公开 ULID) 双键（`AGENTS.md:236-246`）。

**desktop/ 不是 Tauri 也不是 Electron**：Wails v3（Go）壳 + 「绿色便携」Python 运行时 zip——`runtime/`（便携 CPython）+ `packages/`（`uv pip install --target` 可重定位 site-packages）+ `launch.py`（`desktop/portable/package.sh:13-19`）。首次启动解压 zip → 起服务 → `waitHealth` 轮询 → webview 加载 dashboard（`desktop/src/main.go:159-196`）；升级前强制 SQLite 备份、永不降级（`desktop/README.md:77-79`）；产物 DMG/NSIS/tar.gz 六平台 CI 矩阵（`desktop/README.md:31-47`）。

## 二、多用户与认证（对照 KFW 双驱动）

- **单部署多用户 + admin 角色**：首用户即 admin（`api/routers/auth.py:81-106`）；行级所有权（资源挂 `user_id`，请求校验 owner，admin 旁路，`docs/architecture.md:68-71`）。
- **模块级细粒度权限**：`PERMISSIONS` 按模块定义 key，`require_permission(key)` 工厂依赖注入校验，未知 key 构造期 fail-fast（`infra/users/permissions.py:50-80`）。
- **无状态 JWT（HS256）**：secret 存 DB `secrets` 表（`server.py:627-629`）；**滑动续期**——剩余寿命 < 1/3 TTL 时经响应头 `X-Octop-Access-Token` 发新 token（`api/deps.py:151-173`）；**登出仅写审计、不吊销**（`auth.py:128-132`，无服务端会话表/刷新令牌）。
- 登录防护：Argon2id + 失败计数锁定 + 密码策略 + 可插拔验证码（`infra/users/manager.py:452-508`、`infra/users/password.py:12-70`）；邀请制注册 + SSO 四 provider。
- **BYOK 密钥三形态、水位不一**：JWT secret 明文 kv；**模型 provider api_key 明文落库**（`db/repos/providers.py:29,83-87`）；Connector 凭据 Fernet 加密但密钥同库（混淆级）。对照 KFW：credential-secret 本机加密 + scrypt 凭据 **强于** Octop——此项 Octop 是反面教材。

## 三、Agent 运行时（对照 KFW deepagents 内核）

- **多 Agent = AgentTeams 协调者模式**：主持人工具白名单收窄到 5 个（`teams/service.py:25-42`），编制存主持人工作区 `manifest.json`；并行 dispatch + `ask_agent` 同步互问 + fan-in 带 `speaker_agent_id` 上墙；成员 checkpoint 隔离（`docs/expert-teams.md:11-74`）。比通用 A2A 协议轻得多。
- **工具治理**：`BUILTIN_TOOL_CATALOG` 静态目录 + `CRITICAL_TOOLS` 不可禁用 + per-agent `tools_disabled` 持久化（`tool_catalog.py:12-38`、`manager.py:1912-1931`）；shell 守卫 YAML 规则可由 dashboard 编辑（`tool_guard_rules.py:34-60`）；HITL 协调器 + SSE 专端点恢复。
- **MCP 双向**：出站做 MCP client（connector 凭据 Fernet + SSRF 守卫 `custom_mcp.py`）；入站把连接器网关暴露为 MCP 端点（`internal_mcp.py:18-70`，内部 token 鉴权）。
- **会话/历史**：checkpoint 归 harness 黑盒（**无影子 git**——删对话须显式 `adelete_thread`，`manager.py:1140-1173` 专门警告「只删注册表行是化妆式删除」）；`thread_messages` + `trajectory_events` 落库；可选 v2 分段归档（SQLite-only，PG 拒绝启用）。
- **用量与配额**：`usage_log` cache-aware token 分桶 + 多 provider 字段归一化（`usage_record.py:33-60`）；per-user token 配额走 LangChain `AgentMiddleware.before_agent` **回合前硬拒**（`middleware/token_quota.py:26-47`）。只有计量没有计费。

## 四、模型供应商接入（对照 KFW 封闭协议集）

DB `kind` → harness protocol 仅 5 种（openai/anthropic/ollama/azure/gemini，后三折算 openai，`providers/store.py:19-25`）——比 KFW 的协议集更窄。值得看的运维细节：模型 pin 失效自动清理（`store.py:73-99`）、provider 变更触发的最小化 agent 热重载（`manager.py:1330-1377`）、按模型名多模态能力启发式（`store.py:28-48`）、推理能力元数据 200+ 行前缀硬编码表（`presets.py:8-211`）。

## 五、部署与运维

单容器单进程（`docker/docker-compose.yml:31-37`，首启随机 admin 密码写 `credential.txt`）；**fnos（飞牛 NAS）`.fpk` 应用中心产线**——Docker 版 + 560MB 本地版双形态，首启凭据「应用设置窗口 + `octop-login.txt` 备份文件」双通道送达（`fnos/README.md:9-48`）；Langfuse 可观测集成（`observability.py`）；审计表 `audit_log` 全量记录登录/改密/登出；httpx 日志压 WARNING 防 token 泄漏（`server.py:621-625`）。

## 六、工程实践

455 个测试文件：`unit/`（按域）+ `integration/`（72 个 API 级，含 e2e golden path、authz 边界、PG 专项）+ `live/`（真 LLM 默认跳过）+ `support/`（ASGITransport 进程内起完整 OctopServer + httpx 客户端，`tests/support/app.py:38-75`）；pytest marker 三档（live/slow/postgresql）。**双层文档**：AGENTS.md（AI 向导：边界/禁令/schema 约定/发布流程）与 architecture.md（人读）明确分工。质量门：ruff + mypy --strict 全 src + 全测试 + dashboard build（`Makefile:201`）。docstring 密度高且解释「为什么」（含 CI 症状复盘注释）。上乘开源工程水准。

## 七、结论

### 7.1 可借鉴点清单（按引入成本排序）

| # | Octop 做法（证据） | 对 KFW 板块 | 成本 |
|---|---|---|---|
| 1 | **JWT 滑动续期**：剩余寿命 < 1/3 TTL 时经响应头发新 token（`api/deps.py:151-173`） | 认证（活跃用户免重登；叠加在现有 account_sessions 体系上） | 低 |
| 2 | **回合前 token 配额硬拒**：per-user 策略 + `before_agent` 中间件（`token_quota.py:26-47`） | credits（补「回合前拒绝」执行点位与策略表） | 低 |
| 3 | **cache-aware token 分桶计量** + 多 provider 字段归一化（`usage_record.py:33-60`） | credits（prompt cache 命中/写入分开计价） | 低-中 |
| 4 | **provider 变更 → 模型 pin 失效清理 + 最小化 agent 热重载**（`store.py:73-99`、`manager.py:1330-1377`） | BYOK/ProviderInstanceConfig 运维健壮性 | 中 |
| 5 | **内建工具目录 + CRITICAL_TOOLS 不可禁用 + per-agent 禁用持久化**（`tool_catalog.py:12-38`） | Agent 运行时（工具注册表治理/审计面） | 低 |
| 6 | **工具白名单收窄的多 Agent 编排**（主持人 5 工具 + manifest + fan-in 标注 + checkpoint 隔离） | Agent 运行时（比 A2A 协议务实的多 agent 起点；KFW 已有 subagent_task，可作演进参照） | 中-高 |
| 7 | **桌面绿色运行时产线**：升级前强制备份、zip 嵌 `Contents/Resources`、六平台 CI 矩阵、`--only-binary` 防 Homebrew 污染（`package.sh:123-130,247`） | desktop（DMG/NSIS 产线加固，尤其升级前自动备份交互） | 低-中 |
| 8 | **首启凭据双通道送达**（设置窗口 + 备份文件，`fnos/README.md:9-16`） | desktop/部署首次安装 UX | 低 |
| 9 | **双层文档分工**（AGENTS.md 给 AI / architecture.md 给人）+ **双引擎迁移对**（每 schema 变更同写 SQLite/PG 两份 + PG 专项测试门控） | 工程治理（KFW 文档地图已有类似，迁移对纪律可参） | 低 |
| 10 | 明文 provider key + Fernet 同库密钥的**反面教材** | 认证/BYOK（反向验证 credential-secret 方案必要性） | 零 |

### 7.2 不适用/不建议

1. 技术栈整体不可移植（Python/uv 单 wheel vs KFW TS monorepo）——只借鉴「单向依赖 + 唯一组合根」原则本身。
2. 单进程无队列架构（ADR 001）依赖 SQLite 单写者假设，与 KFW 多端多进程 + 内嵌 PG 冲突。
3. **无状态 JWT、登出不吊销**——KFW 已有 `account_sessions` 服务端会话表，勿倒退；借鉴点 1 应叠加在现有会话体系上。
4. **provider api_key 明文落库**——与 KFW 实例加密决策直接冲突，禁止借鉴。
5. 全量门禁（455 测试文件 + 前端 build 每次 commit 全跑）——KFW 继续 Turborepo 按影响面执行。
6. 内嵌 25+ 娱乐化 bundled 插件进 wheel——内容运营型做法，KFW flow/Dify 保持独立分发。
7. fnos fpk 产线（无 NAS 分发需求）；history_v2 分段归档（SQLite-only 设计，KFW 有 PG）。
8. WS + SSE 双协议并存（迁移包袱）——KFW 统一协议即可。

### 7.3 一句话总评

**Octop 对 KFW 的最大价值不是架构（技术栈不同、且更简单），而是「单机自托管 AI 助手平台」的一整套机制细节样本——JWT 滑动续期、回合前 token 配额硬拒、cache-aware 计量、provider 变更热重载、工具治理目录、桌面绿色运行时升级备份产线——均可低成本逐条移植；其明文存 BYOK 密钥、无会话吊销的现实，恰好反向验证了 KFW 在凭证加密与会话管理上的既有决策。**

---

**建议处置**：借鉴点 1/2/3（认证会话体验 + credits 精度）与 7（桌面升级备份交互）成本低、收益直接，建议进入《改造计划》§6 决策流程排期；5/6/4 视 Agent 运行时演进节奏再议；其余记录备查。
