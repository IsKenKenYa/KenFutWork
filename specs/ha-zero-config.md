# HA 插件装上即用（零手工接入）

## JTBD（Jobs To Be Done — 用户雇佣此功能要完成的任务）
用户在插件市场装上智能家居插件，期望立刻看到并控制自己 HA 实例里的设备，不愿意先去 HA「个人资料 → 安全」造长期访问令牌、再粘贴到配置表单。当前装上后静默回落到手动配置表单，真实失败被 `catch → return null` 藏起来；这条兜底正是缺陷本身。

## 范围（Scope）
把 HA 插件从「装上后要手动填令牌」改成「装上即自动接入本机 HA 实例」。

## 验收标准（Acceptance Criteria）
1. 插件市场安装/启用 `kenfutwork-ha` 后立即触发 `ensureReady`，不再等面板或工具首次调用（懒加载退役）。
2. 本机 `http://127.0.0.1:8123` 已完成 onboarding 的 HA（`/api/` 401、`/api/onboarding` 404、`/auth/providers` 含 Trusted Networks）：`POST /auth/login_flow` 显式带 `handler:["trusted_networks", null]` 拿授权码 → `/auth/token` 换访问令牌 → WS `auth/long_lived_access_token` 签发长期令牌 → 落配置。用户零输入、零授权点击，面板直接进入 HA 原生界面并显示实体。
3. 全新 HA（onboarding 未完成）：沿用现有 `initializeHomeAssistant` 全自动建所有者、core_config / analytics / integration、签发长期令牌。
4. **失败不兜底**：探测不到 HA、可信网段来源 IP 不匹配、未开 `allow_bypass_login`、login_flow 失败、授权码交换失败、WS 签发失败，一律抛出带错误码与可读原因的错误；面板显示失败态，不回落到「请填写长期访问令牌」表单，不写 `configured:true`，不记 `warn` 后静默返回 `null`。删除 `autoInitializeConfig` 与 `readOrInitializeConfig` 两层 `catch → return null`。
5. `handler:[null,null]` 不得使用（本机实测 HA 返回 500）；该约束由回归测试锁死。
6. 幂等：并发启用同实例共享一个 `ensureReady` Promise；凭据先落盘再产生远端副作用，响应丢失按已持久化状态重放；已有配置直接短路；不产生第二个所有者或第二份令牌。卸载插件清除配置。
7. 凭据全部由宿主生成、落数据目录 0600、重启复用同一份，HTTP 永不回显（`DEC-7` 本地明文口径）。地址默认 `127.0.0.1:8123`，允许宿主侧覆盖自管地址。
8. 三端 × 双场景共 6 组验收通过：桌面端 / 自托管 / Web × 场景 A（产品侧数据目录干净，外部 HA 处于全新 onboarding）/ 场景 B（外部 HA 已完成 onboarding，本机 8123 实况）；每组断言零手工步骤即可用。
9. 注入式单测覆盖三分支、并发同实例、响应丢失重放、失败抛错不回落、显式 handler；新增回归把「已完成 onboarding 不再 `return null`」钉死。全量门禁通过（`pnpm test`、`pnpm typecheck`、workspace 门禁、OpenAPI 一致性、ZCode 来源漂移）。

## 约束（Constraints）
- 目的为行为缺陷修复：不改「HA 由用户自建」的产品定位，不由产品自带或拉起 HA 实例，不新增内核缝。
- 改动集中在已有属主：`plugins/ha/lib/auto-init.js`、`plugins/ha/index.js` 及其测试；遵循插件化能力缝三元组、一步一提交一测试、`docs/日志.md` 同提交记账。
- 桌面 / 自托管 / Web 三端同标准验收；三端都只连宿主，由服务端访问回环端口。Docker 形态下来源 IP 为网桥地址（历史踩坑 `172.17.0.1`），可信网段不匹配时按第 4 条抛错，不伪造成功。
- 不做：首启向导、一次浏览器授权点击、示例实体、面板配置表单的自动填充。表单仅保留为显式人工入口，不得作为失败回落路径。
- 测试不依赖真机做单元断言；三端双场景真机验收单独记录，注入式结果不得冒充真机证据。
- Phase 1→2 的首次运行设置不得覆盖项目根 `AGENTS.md`（仓库唯一权威），循环专用说明另存 `build/AGENTS.md`。
