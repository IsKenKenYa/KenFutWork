# Flow 引擎装完即用（零手工打通控制面）

## JTBD（Jobs To Be Done — 用户雇佣此功能要完成的任务）
用户在引擎 tab 点一次「安装引擎栈」，期望装完就能在 Flow 里直接干活，不愿意再手动跑 `/console/api/init` + `/setup`、在 `flow/.env` 里填管理员账号、或重启网关让控制面授权生效。当前「自动化」只覆盖新装时的 init/setup，凭据靠人工 env、网关授权只在启动期 60 秒窗口内尝试，装完仍用不了。

## 范围（Scope）
把 Flow 引擎从「点安装后还要手工初始化」改成「安装完成即控制面可用」。

## 验收标准（Acceptance Criteria）
1. 引擎 tab 保留「安装引擎栈」按钮，触发点不变（不改首启自动安装、不去掉按钮、不改 FORM-11 按需下载镜像的产品决策）。
2. `install.ts` 统一生成全部凭据：`DIFY_ADMIN_EMAIL / DIFY_ADMIN_PASSWORD / DIFY_SECRET_KEY / DIFY_INIT_PASSWORD / DIFY_ADMIN_API_KEY / DIFY_DB_PASSWORD / DIFY_SANDBOX_API_KEY`，同源写入引擎 env 与 flow 网关 env，去掉对人工 `flow/.env` 的依赖；落数据目录 0600、重启复用同一份，HTTP 不回显。
3. `bootstrap.ts` 自动完成 `/console/api/init` + `/setup`；`GET /console/api/setup` 明确 `step=finished` 时返回 `already_initialized` 幂等短回，其余异常不当成功。
4. **安装完成后主动补一次网关控制面授权**：由网关侧在引擎就绪后复用既有 `DifyIntegrationService.bootstrap()` 服务调用完成，宿主不直连 `/admin/*`（该前缀带 `AdminGuard`），不新增免鉴权端点，不依赖 `onModuleInit` 的 30×2s 启动期窗口；就绪信号由宿主安装完成态驱动，具体接线归实现计划细化。安装态转 ready 时 Dify integration 为 `active`，Flow 画布可立即新建并执行工作流。
5. **失败不兜底**：凭据生成、镜像拉取、init/setup、网关补授权任一阶段失败都抛出带可读原因的错误，安装态置 `error`、安装日志可见（引擎页失败自动展开），不谎报 ready、不静默跳过、不降级成「部分可用」。允许重试，但重试期间错误态与原因保持可见，重试耗尽仍抛出错误。
6. 幂等：重复安装返回 409；取消安装后的迟到请求不误判 ready；已初始化栈重放不重复建管理员；`DIFY_SYNC_LLM_PROVIDER=false` 保持不动（规避首次无供应商插件的阻塞）。
7. 不预置示例工作流；日志遗留的 `workflows` 0 行不作为本轮交付物。验收口径为「装完后控制面已授权、画布可立即新建并执行工作流」。
8. 三端 × 双场景共 6 组验收通过：桌面端 / 自托管 / Web × 场景 A（产品侧数据目录干净，Dify 栈首次安装）/ 场景 B（Dify 栈已初始化，`setup_at 2026-11-01`，本机 15001 实况）；每组断言零手工步骤即可用。
9. 注入式单测覆盖 env 自动生成与同源同步、缺凭据不静默、已初始化幂等、安装完成触发补授权、取消/迟到请求、失败日志可读；新增回归把「引擎装完控制面自动授权、不依赖启动期窗口」钉死。全量门禁通过（`pnpm test`、`pnpm typecheck`、workspace 门禁、OpenAPI 一致性、ZCode 来源漂移）。

## 约束（Constraints）
- 目的为行为缺陷修复：不改「Dify 无头栈不随安装包分发、按需下载」的既有拍板，不引入新的内核初始化缝。
- 改动集中在已有属主：`apps/server/src/features/flow/engine/{install,bootstrap}.ts`、`apps/server/src/features/flow/plugin.ts` 及其测试；涉及跨端契约改动须同步 `packages/shared` 并走 OpenAPI 三连（registry.ts → `pnpm api:spec` → Apifox 导入）。
- 三端都只连宿主，由服务端访问 `127.0.0.1:15001`；Web 端不直接碰回环端口。凭据只落数据目录，日志与普通目录/事件不得泄漏（`DEC-7`）。
- 遵循仓库硬约束：插件化能力缝三元组、配置 fail loud、一步一提交一测试、`docs/日志.md` 同提交记账、显式 `git add <path>`。
- 不做：首启自动安装、去掉安装按钮、统一首启向导、预置示例工作流、改 `DIFY_SYNC_LLM_PROVIDER`。
- 测试不依赖真机做单元断言；三端双场景真机验收单独记录，注入式结果不得冒充真机证据。
- Phase 1→2 的首次运行设置不得覆盖项目根 `AGENTS.md`（仓库唯一权威），循环专用说明另存 `build/AGENTS.md`。
