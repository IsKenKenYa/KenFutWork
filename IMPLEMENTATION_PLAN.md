# IMPLEMENTATION_PLAN.md

来源：`specs/ha-zero-config.md`、`specs/dify-zero-config.md`。
方案：就地补齐 + 主动触发（不新增内核缝）。按用户要求在当前窗口逐项实现，不运行 `./loop.sh build`。
每完成一项更新下方状态并跑该任务的 Verification 命令。根 `AGENTS.md` 是唯一权威，不被覆盖。

通用验证命令（仓库根执行）：
- 定向：`pnpm --filter @kenfutwork/server exec vitest run <相对 apps/server 的路径>`
- 门禁：`pnpm test`、`pnpm typecheck`、`pnpm lint`、`node --test tests/workspace.test.mjs`

---

### Task 1: HA 自动初始化补「已完成 onboarding」的可信网段分支 [已完成]
Files: modify `plugins/ha/lib/auto-init.js`
Verification: `pnpm --filter @kenfutwork/server exec vitest run src/features/plugins/ha-auto-init.test.ts`

新增 `exchangeTrustedNetworkCode(options)`：`POST /auth/login_flow`，body
`{client_id: baseUrl + "/", redirect_uri: baseUrl + "/", handler: ["trusted_networks", null]}`；
仅接受 `type === "create_entry"` 且 `result` 非空，其余一律抛错（code `trusted_network_unavailable`）。
**禁止** `handler:[null,null]`（本机实测 HA 返回 500）。
把 `initializeHomeAssistant` 里 WS 签发长期令牌段抽成 `issueLongLivedToken(options, accessToken)`，
新增 `initializeExistingHomeAssistant(options)`：授权码 → `exchangeAccessToken(code)` →
`issueLongLivedToken` → `{baseUrl, token}`。现有 `initializeHomeAssistant` 复用同一签发函数，行为不变。

```js
export async function exchangeTrustedNetworkCode(options) {
  const payload = await request(options, "/auth/login_flow", {
    method: "POST",
    body: {
      client_id: `${options.baseUrl}/`,
      redirect_uri: `${options.baseUrl}/`,
      handler: ["trusted_networks", null],
    },
  });
  if (payload?.type !== "create_entry" || typeof payload.result !== "string" || !payload.result) {
    throw autoInitError("HA 未开启可信网段免登录，无法自动接入（请检查 allow_bypass_login / trusted_networks）。", "trusted_network_unavailable");
  }
  return payload.result;
}
```

### Task 2: 删除 HA 两层兜底，失败抛错不回落表单 [已完成]
Files: modify `plugins/ha/index.js`, `plugins/ha/panel.js`
Verification: `pnpm --filter @kenfutwork/server exec vitest run src/features/plugins/ha-auto-init.test.ts src/features/plugins/ha-plugin.test.ts`

- `autoInitializeConfig`：已有 `AUTO_INIT_KEY` 走恢复；`readHaOnboarding` 成功且 `user !== true` 走全自动建号；
  `user === true` 或 onboarding 读不到（本机 404 实况）改走 `initializeExistingHomeAssistant`；
  **删除** `catch { return null }`，任何失败带 code/原因抛出。
- `readOrInitializeConfig`：**删除** `ctx.logger.warn(...); return null`，改为 `throw error`（保留 finally 的 Map 清理）。
- `GET config` 路由用 `errorResult(error)` 包裹，失败返回非 200 + `{error, code}`；面板 `boot()` 的
  `.catch(showError)` 显示失败态。`if (!payload.configured)` 不再 `renderSetup()`，表单只由标题栏「配置」显式进入。
- `runtimeFor` 的 `notConfiguredError` 保留为防御分支，不再作为常规回落路径。

### Task 3: HA 回归测试改写与新增 [已完成]
Files: modify `apps/server/src/features/plugins/ha-auto-init.test.ts`（新增用例合并进此文件，共享同一份 fake HA fixture）, `apps/server/src/features/plugins/ha-plugin.test.ts`
Verification: `pnpm --filter @kenfutwork/server exec vitest run src/features/plugins/ha-auto-init.test.ts src/features/plugins/ha-plugin.test.ts`

- fake HA 增加 `/auth/login_flow`：显式 `["trusted_networks", null]` → create_entry + result；其他 handler → 500。
- 改写现有「已完成 onboarding 仍走显式连接」用例：断言 `configured:true`、令牌 1 条、未改号。
- 新增：onboarding 返回 404（本机实况）仍自动接入；可信网段未开 → 抛错且 config 返回错误态、
  不出现 `configured:false`；并发同实例只签一次；响应丢失首次为错误态、二次按持久凭据恢复；
  `handler:[null,null]` 不被调用。

### Task 4: 宿主在插件安装/启用后预热 HA（装上即触发） [已完成]
Files: modify `apps/server/src/features/plugins/plugin-registry-service.ts`, `plugins/ha/index.js`, `plugins/ha/package.json`
Verification: `pnpm --filter @kenfutwork/server exec vitest run src/features/plugins/plugin-registry-service.test.ts src/features/plugins/ha-auto-init.test.ts`

插件 bundle 的 `apply(ctx)` 拿不到 instanceId（ctx 只有 routes/tools/ui/storage/effect/on/logger，
`EVENT_ALIASES` 只有三个 agent-run 事件，没有安装事件）。故由宿主在启用成功后以
`localInstance.serviceActor().instanceId` 调用插件的 `auto-init` 私有路由一次；插件声明该路由供宿主发现。
失败抛错到安装结果，不静默跳过。这是 Task 1-3 之后才做的触发点前移，不改变初始化逻辑。

### Task 5: Dify 凭据全量由宿主生成并同源供给 [已完成]
Files: modify `apps/server/src/features/flow/engine/install.ts`, `apps/server/src/features/flow/plugin.ts`, `apps/server/src/features/flow/engine/install.test.ts`
Verification: `pnpm --filter @kenfutwork/server exec vitest run src/features/flow/engine/install.test.ts src/features/flow/engine/bootstrap.test.ts`

`ensureStackEnvFile(dataDir)` 在现有 `SECRET_KEY / INIT_PASSWORD / ADMIN_API_KEY` 之外补
`DIFY_ADMIN_EMAIL / DIFY_ADMIN_PASSWORD / DIFY_DB_PASSWORD / DIFY_SANDBOX_API_KEY`，
`existsSync` 时补齐缺失键并保留既有值（不轮换导致失配），0600。
`bootstrap.ts` 的 `readRequiredEnv` 已读 `options.envFile`，管理员凭据由此直接可得；
`flow/plugin.ts` 的 `credentialEnvFiles` 保留为兼容回退，去掉「缺管理员账号即安装停止」的人工依赖。
测试：干净目录一次生成全量键、重启复用同一值、缺键补齐、值不泄漏到日志。

### Task 6: 安装完成后补一次网关控制面授权 [已完成]
Files: modify `apps/server/src/features/flow/engine/install.ts`, `apps/server/src/features/flow/plugin.ts`, `flow/gateway/src/dify/dify-integration.service.ts`
Verification: `pnpm --filter @kenfutwork/server exec vitest run src/features/flow/engine/install.test.ts src/features/flow/engine/bootstrap.test.ts src/features/flow/flow-host.test.ts`

网关 `onModuleInit` 只在启动时按 `DIFY_AUTO_BOOTSTRAP=true` 重试 30×2s；引擎是用户后来点按钮装的，
窗口早过。由宿主安装完成态驱动一次网关侧复用 `DifyIntegrationService.bootstrap()` 的服务调用
（不直连带 `AdminGuard` 的 `/admin/*`、不新增免鉴权端点），失败抛错并置安装态 `error`，
重试期间错误可见。测试锁死「装完即 active、不依赖启动期窗口」。

### Task 7: 全量门禁与台账 [待办]
Files: modify `docs/日志.md`
Verification: `pnpm test`、`pnpm typecheck`、`node --test tests/workspace.test.mjs`、`pnpm lint`

按仓库纪律：`docs/日志.md` 记本轮问题/方案/验证命令/遗留项；显式 `git add <path>`，不 `git add -A`；
共享文件逐 hunk 复核；三端 × 双场景真机验收单独记录，注入式结果不冒充真机证据。

---

## 状态（2026-11-04 17:40，Task 1-6 全部完成）

- [x] Phase 1：两份 spec 已批准、自检通过
- [x] 首次运行设置：`loop.sh`、`clean-state.sh`、`build/AGENTS.md`（根 `AGENTS.md` 未动）
- [x] Task 1：HA 可信网段分支（`plugins/ha/lib/auto-init.js`）
- [x] Task 2：删两层兜底 + 失败抛错（`plugins/ha/index.js`、`plugins/ha/panel.js`）
- [x] Task 3：HA 回归测试（旧「已完成 onboarding 仍走显式连接」断言已改写）
- [x] Task 4：宿主预热（`plugins/ha/index.js` 新增 `auto-init` 路由；
      `plugin-registry-service.ts` 新增可选 `serviceInstanceId` dep + `warmUpAutoInit`；
      `features/plugins/plugin.ts` 装配；新增安装预热回归）
- [x] Task 5：Dify 凭据全量宿主生成 + 同源补进网关 env（`install.ts`、`plugin.ts`）
- [x] Task 6：安装完成后补网关控制面授权（`install.ts` 新增 `onReady`；
      `flow/plugin.ts` 用宿主共享密钥调网关；`flow/gateway` 新增
      `host/ff-embed/v1/dify/reauthorize` controller + `reauthorizeControlPlane()`，
      复用 `HostProjectControlGuard`，不直连带 `AdminGuard` 的 `/admin/*`）
- [x] 验证：server 定向 6 文件 150/150；flow 网关 `nest build` 通过；
      网关鉴权覆盖（20 控制器 / 98 路由）、全局守卫、ff-embed 协议烟测通过；
      workspace 门禁 38/38；改动文件 Biome `check` 10 文件退出 0、零诊断
- [x] 全量 `pnpm --filter @kenfutwork/server test`：3639 通过 / 404 失败 / 650 跳过
      （30 文件失败），失败清单全为既有 Windows 平台债
      （cad gui / code-ui file-rewind / process-sandbox ECONNRESET / canvas 等），
      **本轮 6 个改动相关测试文件 0 失败**
- [!] `pnpm lint` 被既有 ZCode vendored 副本漂移阻断（33 处「字节漂移 / 副本缺失」，
      第一道来源校验即红）；本轮文件单独 `biome check` 已零诊断，不替他人修副本
- [!] 全量 `pnpm typecheck`：本机空闲物理内存约 2.7GB，TypeScript 7 Go 版与 6.0.3
      全项目 `tsc` 均 OOM；改动前一次全量退出 0，本轮 4 个改动 TS 文件轻量检查
      无本轮错误（仅 1 条来自未改动 `src/http/flow-project-files.ts` 的既有类型差异）
- [ ] Task 7（验收层，非代码）：三端 × 双场景真机验收、Apifox 同步。
      代码改动已完成，这些需真机 / 凭据，不伪装完成
- [!] **交付完整性**：`flow/` 是独立 git 子模块（根记录 `160000 d6c6af79`）。
      Task 6 的网关侧 3 个文件（`gateway/src/dify/dify-integration.service.ts`、
      `dify.module.ts`、新增 `host-dify-reauthorize.controller.ts`）落在子模块工作区，
      **未提交、也不被根仓库跟踪**；根 `git status` 只显示 `m flow`。
      只提交根仓库会漏掉整个网关侧改动。需在子模块内显式 `git add <3 个路径>`
      + commit，再由根仓库更新子模块指针（需用户确认，本轮不擅自跨仓库写历史）

**架构边界（已按此落地）**：插件 `apply(ctx)` 拿不到 instanceId、
`EVENT_ALIASES` 只有三个 agent-run 事件 → Task 4 由宿主可选能力探测
`POST auto-init` 完成，不改 manifest 契约。网关 `/admin/*` 带 `AdminGuard`、
`onModuleInit` 只有 30×2s 启动期窗口 → Task 6 走宿主共享密钥端点触发网关内部
服务调用；补授权失败抛错、安装态置 `error`，不谎报 ready。

**本机 typecheck 说明**：TypeScript 7 Go 版 `tsc` 与 6.0.3 全项目 `tsc` 均因
物理内存吃紧（空闲约 3.3GB）偶发 OOM；改动前一次全量 `tsc` 退出 0，
本轮对 4 个改动文件的轻量类型检查无本轮错误（仅 1 条既有 Fastify 类型差异，
来自未改动的 `src/http/flow-project-files.ts`）。
