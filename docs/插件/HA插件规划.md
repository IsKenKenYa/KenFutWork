# HA 插件规划

> **角色声明**：方案稿（参考级，非权威）——Home Assistant（HA）接入方案的实施蓝图。**尚未拍板**：文内决策用 `HA-*` 本地编号占位，拍板后归并《[改造计划](../方案设计/改造计划.md)》§6 并分配 `DEC-*` 编号；结论与理由以《改造计划》§6 为准。
> 状态：2026-10-09 成稿。外部事实逐条取证（来源与日期见 §2、§9）；仓库侧结论均在本机代码上核对过，附文件与行号。
> **进展（2026-10-09 第二轮）**：本轮的**三个仓库侧缺口已按文内推荐落地**（不依赖 HA 插件本身）：① 桌面发布包/自托管镜像补自带插件 bundle（§3.5）；② MCP `http` 传输支持自定义请求头（§5.1）；③ 插件工具可声明 `access: read/write/execute` 并据此进默认档审批（§3.3）。插件本体（P1–P4）**尚未开工**。
> **拍板（2026-10-09，用户口径）**：面板/侧栏入口标题 = **「智能家居」**（§8-1）；**米家插件保留**、与 HA 插件并存不撤（§8-5）。§8-6（v1 控制面只做常用域）仍待拍板。
> 需求来源：2026-10-09 用户口径——「我想兼容 HA，可以同时兼容米家和华为的」。
> 与既有文档的关系：本条是《[米家插件规划](./米家插件规划.md)》**路线 A** 的落地化设计（该文档推荐的 HA 路线当时因「本机无 HA、端到端验收做不了」改走了路线 B 自包含实现；本轮用户明确要兼容 HA 且要覆盖华为，故把路线 A 正式立项）。已落地的米家插件（`plugins/mihome/`）**保留不撤**，两者关系见 §4.7 与 §8。

## 0. 结论速览

| 决策点 | 结论 |
| --- | --- |
| 交付形态 | **仓库内自带 bundle** `plugins/ha/`（包名 `kenfutwork-ha`），与 `plugins/mihome/` 同形；能力面 `tools` + `routes` + `ui` + `storage`，**零内核改动** |
| 集成点 | 用户自建的 **HA 作为生态归一化层**：米家靠 HA 的小米集成、华为靠 HA 的华为集成，我们只持有一个 HA 长期令牌（REST + WebSocket） |
| 米家（HA 侧） | `XiaoMi/ha_xiaomi_home`（官方，许可限「非商业 HA 用途」）或 `al-one/hass-xiaomi-miot`（社区，Apache-2.0） |
| 华为（HA 侧） | HA 核心**没有**智慧生活集成（实测 404）；社区 `xiasi0/ha-huawei-smarthome`（GPL-3.0-only，`cloud_push`，逐产品适配器，实验性）是当前唯一通路 |
| 「同时兼容」的实现 | 一个 HA 里可以同时装小米与华为集成，实体同池 → 我们的面板与工具天然同时覆盖两家，**不需要我们区分厂商** |
| 面板 | **自带面板页**（不走 HA 前端 iframe）：配置（地址+令牌）→ 实体网格（按区域分组、域驱动控件）；WS 实时优先、降级轮询。侧栏入口标题 **「智能家居」**（拍板 2026-10-09） |
| agent 工具 | `ha_entities`（读）/ `ha_control`（写，读回校验）——经 ToolSearch 激活；未配置时 fail loud |
| 凭据 | HA 长期令牌存插件存储：实例隔离、**值明文落库**（`DEC-7` 2026-10-05 修订后的本地口径）、HTTP 不回显、卸载即清 |
| 零代码替代 | HA MCP（HA ≥ 2025.2，`POST /api/mcp`）——**已通**：MCP `http` 类型现支持自定义请求头（Authorization），面板即可直连，不再需要 `npx mcp-remote` 中转（§5.1） |
| 已知仓库侧缺口 | ~~桌面发布包**未拷贝 `plugins/`**~~ **已修**（2026-10-09）：`package-win/mac.mjs` 拷贝 + tauri 资源映射 + Docker 镜像 COPY + 加载器契约测试（§3.5）。~~插件工具不进默认档审批~~ **已修**：`access` 声明进危险判据（§3.3） |

## 1. 需求与判定

### 1.1 需求（用户口径）

一条：**兼容 HA，且同时兼容米家和华为**。即装一个插件（或走一条通路）后，本产品能看到并控制米家设备与华为设备，agent 也能操作，重启不丢配置。

### 1.2 为什么形态只能是「HA 当枢纽」

- **米家**：HA 侧有官方与社区两套成熟集成（§2.2）。
- **华为**：HA 核心无智慧生活集成（`homeassistant/components/huawei_smarthome/manifest.json` → 404，2026-10-09 实测；核心只有 `huawei_lte` 路由器级集成）——**自研华为协议是本方案的唯一替代**，成本与风险都不可接受（用户协议、风控、逐型号适配）。
- 社区 `xiasi0/ha-huawei-smarthome` 已经承担了华为侧的协议适配（GPL-3.0-only，按 `prodId` 逐产品适配器）。于是「同时兼容」的正确解法是：**我们不碰任何厂商协议，只对接 HA**；HA 里装什么集成，我们就覆盖什么生态。新增生态（涂鸦、Matter 等）零成本顺带支持。

### 1.3 插件系统的硬边界（决定实现约束）

第三方 bundle 的能力面、门禁与依赖限制（`apps/server/src/features/plugins/`，2026-10-09 实测）：

1. **能力面五项**：`tools` / `systemPrompt` / `routes` / `ui` / `storage` 支持，其余（`settings`/`jobs`/`llm`/`sessions`/`commands`/`fs`/`subprocess`/`sandbox`/`agents`）显式拒绝并给出理由（`capability-binding.ts`）。
2. **门禁禁止直连系统**：`child_process`、`node:fs`、`vm`、`cluster`、`worker_threads` 一律判 blocker（`module-scan.ts`）——插件不能自己落盘，只能走 `ctx.storage`。
3. **bundle 不能带 npm 依赖**：安装期不跑包管理器（`bundle-source.ts` 只收文本白名单）。
4. 由 2+3 推出：**HA 客户端必须手写、零依赖**——`fetch`（REST）+ Node 22 全局 `WebSocket`（WS，`node -e "typeof WebSocket"` → `function`，Node v22.20.0 实测；随包运行时同为 22.20.0，见 `scripts/fetch-runtimes.mjs`）。两条都是平台内建能力，不需要 import。

## 2. 外部事实核实（2026-10-09，逐条附来源）

### 2.1 Home Assistant 侧

| 事实 | 取证 |
| --- | --- |
| REST：`GET /api/`（`{"message":"API running."}`）、`GET /api/config`、`GET /api/states`、`GET /api/states/<entity_id>`、`POST /api/services/<domain>/<service>`（支持 `?return_response`）；鉴权统一 `Authorization: Bearer <token>` | `developers.home-assistant.io` 的 REST 文档与其仓库源 `docs/api/rest.md` |
| WebSocket：连接后 `auth_required` → 客户端 `auth{access_token}` → `auth_ok`；`call_service`、`subscribe_events`（`state_changed`）为标准命令 | 同上仓库 `docs/api/websocket.md` |
| 注册表命令存在：`config/entity_registry/list`、`config/entity_registry/list_for_display`、`config/device_registry/list`、`config/area_registry/list` | HA core 源码 `homeassistant/components/config/{entity,device,area}_registry.py` |
| 长期访问令牌：在「个人资料 → 安全」创建；HA core dev 源码中 `token_type != NORMAL` 时 `expire_at=None`——**不设过期**（可随时吊销）。与旧口径「有效期 10 年」（《米家插件规划》§2.3）不一致，以真机复核为准 | `homeassistant/auth/__init__.py`（dev 分支） |
| MCP Server 集成（core，HA ≥ 2025.2）：`POST /api/mcp`（Streamable HTTP、无状态；`/api/mcp/<api_id>` 可选，如 `assist`）；鉴权 OAuth(IndieAuth) 或长期令牌；**暴露面 = 暴露给 Assist 的实体**；默认限管理员；不支持 sampling/notifications；stdio 需本地代理（如 `mcp-proxy`） | `home-assistant.io/integrations/mcp_server/` |
| HA 自带前端默认 `X-Frame-Options: SAMEORIGIN`，iframe 内嵌需在 HA 侧关闭该头，且 iframe 内要再登录一次 | 沿用《米家插件规划》§5 的既有取证，本轮未复测 |

### 2.2 米家（小米）侧（HA 集成）

| 候选 | 许可 | 要点（取证） |
| --- | --- | --- |
| `XiaoMi/ha_xiaomi_home`（官方） | 小米自定义许可：**仅限非商业性 Home Assistant 使用**，明文「未授权您将授权作品用于任何其他用途，包括但不限于开发应用程序（APP）、Web 服务」 | README + `LICENSE.md` 逐字核对；HA core ≥ 2024.4.4、OS ≥ 13.0；HACS 可装 |
| `al-one/hass-xiaomi-miot`（社区） | Apache-2.0（`LICENSE` 核对） | README：HACS 默认源；账号接入可选「自动/本地/纯云」，支持局域网直连的 `miot-spec` 设备自动走本地 |

**许可边界的推论**：官方集成禁止被用于「开发 APP / Web 服务」——**我们绝不嵌入、不搬运它的代码**；用户把它装在自己的 HA 里使用，是用户自己的合规判断。我们只对接 HA 的通用 API，这一层与小米许可无涉。

### 2.3 华为侧（HA 集成）

| 事实 | 取证 |
| --- | --- |
| HA 核心无华为智慧生活集成 | `components/huawei_smarthome/manifest.json` → **404**；核心仅有 `huawei_lte`（路由器） |
| 社区集成 `xiasi0/ha-huawei-smarthome`：127★、2026-10-09 仍有提交、GPL-3.0-only、manifest `version: 2026.10.7`、`iot_class: cloud_push`、依赖 `cryptography` + `paho-mqtt` | GitHub 搜索 API + 仓库 `README.md`/`LICENSE`/`manifest.json` 核对 |
| 登录：华为账号密码 + 短信验证码或「已登录华为设备推送挑战码」；验证后选择要接入的华为家庭 | 同上 README |
| 覆盖：**逐产品适配器**（`custom_components/huawei_smarthome/device_adapters/prod_<prodId>.py`），无适配器不出实体（README 明确「不提供覆盖全部产品的通用协议转换器」）；仓库带「已接入设备清单」`docs/supported-devices.md`（含华为智选/鸿蒙智选及欧普、达伦、领普、BroadLink 等第三方白牌） | 同上 README + `docs/supported-devices.md` |
| README 自述：非官方、未获华为授权、**学习交流与技术研究用途**、`status: experimental` | 同上 |

**结论**：「同时兼容米家和华为」在 HA 里**成立**，但华为侧是「适配器覆盖到哪、控到哪」——无适配器的设备表现为「HA 里根本没有这个实体」，我们的面板必须**如实显示缺件**，不得编造设备。

### 2.4 待复验（不写进结论的）

- 华为集成对不同账号地区/风控的表现、MQTT 推送的稳定性——以用户真机为准。
- 长期令牌「无过期」的结论取自 dev 分支源码，未逐版本回溯；落地时按真机行为定稿文案。
- 华为设备的 Matter 通路（若设备侧支持，HA 另有通用集成）——本轮未取证，不列入方案。

## 3. 项目侧现状（实测，附落点）

### 3.1 插件能力面与存储

- 能力绑定表：`apps/server/src/features/plugins/capability-binding.ts`——`tools`/`systemPrompt`/`routes`/`ui`/`storage` 支持，其余显式拒绝（附给用户的理由）。
- 存储：`apps/server/src/features/plugins/plugin-storage.ts`——「按实例 + 插件 + 键」存字符串；**值在本机数据库明文保存**（`DEC-7` 2026-10-05 修订后的口径，注意与米家插件注释里「加密落库」的旧文案已不一致，以本文件为准）；HTTP 面不暴露；插件「停用」保留数据、「卸载」由 registry 调 `purgePlugin` 清空。
- 插件上下文面：`apps/server/src/features/plugins/compat-context.ts`——`ctx.tools.register`、`ctx.routes.register`（handler 拿到 `instanceId`）、`ctx.ui.register`、`ctx.storage`、`ctx.promptFragments`、`ctx.effect`（自管定时器，返回 disposer）、`ctx.on`（内核事件）。

### 3.2 面板与登录态握手

- 面板槽位固定四种：`sidebar` / `conversation` / `canvas` / `settings`（`packages/shared/src/plugin-contracts.ts`）。
- iframe 面板**带不上 Authorization 头**，宿主经 `postMessage` 把令牌递进去：`kenfutwork:plugin-panel-token`（宿主→面板）+ `kenfutwork:plugin-panel-ready`（面板→宿主，防「监听器晚于 onLoad」丢令牌）；判据是「消息来自父窗口」而不是同源（开发态 3000/3001 本非同源，同源判据会让面板永远停在「获取登录态」）——见 `plugins/mihome/lib/panel-host-message.js` 与宿主侧 `apps/web/src/lib/plugin-panels.tsx`。
- 面板静态资源：`/api/plugins/<id>/assets/*` 只读公开，须清单声明 `kenfutwork.assets: true`；URL 前缀 `assets/` 映射 **bundle 根**（`apps/server/src/http/plugins.ts` 资源路由；米家插件有回归测试锁死该口径）。

### 3.3 插件工具面与审批（关键缺口）

- `ctx.tools.register` 的插件工具被规范化成：`scope: "shared"`、`exposure: "deferred"`、`access: <属主声明 | "execute">`（`compat-context.ts` 的 `normalizeToolDefinition`）。
- `deferred` = 不在首轮工具清单里，模型要先经 **ToolSearch** 发现并激活（`apps/server/src/features/tool-catalog/catalogue.ts`）。
- 审批判据 = **危险工具名模式**（`/^(Write|Edit|ApplyPatch|Bash|TaskInput|TaskStop)$/`、`/^mcp__/`、`/^execute$/`、`/shell/i` 等）**或属主声明的非只读效果**（`permission-service.ts` 的 `isDangerousCall`）。
- **审批缺口已修（2026-10-09）**：插件在 `ctx.tools.register` 里声明 `access: "read" | "write" | "execute"`——`read` 只读放行、`write`/`execute` 进默认档审批，**不声明按 `execute` 处理**（未知效果按执行策略做人审，与 MCP 工具同口径）。链路：`compat-context` 归一化 → 内核 `tool-pre-execute` 事件带 `access` → permissions 插件据此判。写工具不声明 `access` 仍会被拦（默认档），漏网只剩「明确声明 `read` 却干写」这一种自欺——那是插件作者的责任，验收见 `plugins/mihome/README.md` 的声明示例。

### 3.4 安装与分发路径

- 三种安装入口（`packages/shared/src/plugin-contracts.ts`）：① 自带 bundle（按包名，一键装）；② 从链接（本机目录路径或 GitHub 仓库/子目录）；③ 沙箱工作目录。
- 自带 bundle 目录候选：`<cwd>/plugins` → `<cwd>/../../plugins`，可用 `KENFUTWORK_BUILTIN_PLUGINS_DIR` 覆盖（`apps/server/src/features/plugins/plugin.ts`）。仓库内事件前例：`plugins/{mihome,flow,computer-use,demo-panel,example-clock}`。

### 3.5 桌面发布包的缺口（本轮新发现，影响所有自带 bundle）——**已修（2026-10-09）**

`scripts/package-win.mjs` 组装 `release/` 时只拷：静态 UI（`web/`）、内嵌 Postgres（`pg/`）、迁移 SQL（`supabase/`）、flow 引擎资源（`dify/`）、sharp/node-pty 原生包、运行时（`runtime/`）——**没有拷贝 `plugins/`**，且桌面入口（`apps/server/src/desktop/`）不注入 `KENFUTWORK_BUILTIN_PLUGINS_DIR`。后果：装好的桌面端里「自带插件」列表为空，米家/flow 与本次的 HA 插件都只能走「从链接安装」。

**修法（已落地）**：`package-win.mjs` / `package-mac.mjs` 各加一步 `plugins/ → release/plugins` 拷贝，tauri 资源映射补 `release/plugins → app/plugins`（mac 侧替换原先只映射 `computer-use` 的窄条目），`apps/server/Dockerfile` 补 `COPY plugins/ plugins/`（容器 cwd 是 `/app/apps/server`，命中 `<cwd>/../../plugins` 候选）。壳以应用目录为服务端 cwd 拉起（`src/lib.rs` 的 `packaged_spawn_config`），加载器的 `<cwd>/plugins` 候选即命中——这条**打包布局契约**由 `apps/server/src/features/plugins/plugin-bundled-dir.test.ts` 锁死（cwd 命中 + env 覆盖优先 + 目录不存在返回空 + 坏目录只跳过自己）。
**Windows 例外**：`computer-use` 不进 Windows 包——该形态是 Node SEA（`import.meta.url` 为空），执行原语 `windows-native.ps1` 既未随包也无法按入口定位，装了也用不了，不发半成品（`package-win.mjs` 的 cpSync filter 里写明；mac 侧照常交付）。

### 3.6 既有米家插件（形状模板，协议不通用）

`plugins/mihome/`（约 1900 行：`index.js` + `lib/micloud.js` + `lib/device-model.js` + `panel.html/js`）：扫码登录、会话落插件存储、侧栏面板、`mihome_devices`/`mihome_control` 两个工具、私有路由 + 面板握手、静态资源口径、404 错误码约定。**可复用它的工程形状与测试骨架（`apps/server/src/features/plugins/mihome-plugin.test.ts`：假云全链路、门禁安装、401、重启后免登、读回校验），不复用任何米家协议代码**——HA 侧协议完全不同（标准 REST/WS，无需逆向）。

## 4. 方案设计

### 4.1 形态（`HA-1`）：仓库内自带 bundle

```
plugins/ha/
  package.json        # name: kenfutwork-ha；kenfutwork.bundle: {patch, title:"Home Assistant", assets:true, ui:[{slot:"sidebar"}]}
  cordis.patch.yml    # inject: [tools, routes, ui, storage]
  index.js            # apply(ctx)：客户端装配 + 路由 + 工具 + UI 入口
  lib/ha-rest.js      # REST 原语（fetch，零依赖）
  lib/ha-ws.js        # WebSocket 客户端（状态机 + 退避重连，connect 可注入以便测试）
  lib/entity-model.js # 实体 → 控件模型的纯函数（域/属性 → 可写性与控件）
  panel.html / panel.js / icon.svg
  README.md
```

选自带 bundle 的理由：零内核改动、可随仓库版本演进、与米家插件同形（安装/停用/卸载路径已经过验证）；不自研 MCP 桥、不引外部 App。

### 4.2 架构（`HA-2`）：一条令牌，三条接线

```
 [米家设备] ←  HA 集成（官方/社区）  ─┐
 [华为设备] ←  HA 集成（社区适配器） ─┤→ 用户自建 HA 实例 ──REST/WS（长期令牌）──> plugins/ha（服务端进程内）
 [其它生态] ←  HA 其它集成          ─┘                                              ├─ 私有路由 ← 自带面板（宿主 postMessage 递令牌）
                                                                                    └─ agent 工具（ToolSearch 激活）
```

- **不在我们侧区分厂商**：面板与工具只见 HA 实体（`entity_id`、`state`、`attributes`、area/device 归属）；米家/华为的差异被 HA 集成吸收。这是「同时兼容」的全部机制。
- **单实例单 HA**（v1）：一个实例一份配置（HA 地址 + 令牌）；多 HA 不做（§7 明确不做）。
- **服务器 → HA 的网络可达性**是部署前提：桌面端与 HA 通常同局域网；自托管需要容器能访问 HA 地址（写进 README 与错误提示）。

### 4.3 数据模型：直接采用 HA 实体模型（不造抽象层）

- 实体列表 = `GET /api/states`（含 `entity_id`/`state`/`attributes`/`last_changed`）+ WS 注册表命令补齐**名称/区域/设备**（`config/entity_registry/list`、`config/area_registry/list`、`config/device_registry/list`）。
- 控件可写性由**域 + 属性**推导（`light`→开关/亮度/色温；`switch`/`input_boolean`→开关；`cover`→开合/位置；`climate`→目标温度/模式；`fan`/`media_player` 基础项；`sensor`/`binary_sensor`→只读读数）。
- 不给米家/华为写任何按厂商的分支，也不为「未来多生态」预造抽象——需要时再由实体模型演进（`HA-3`）。

### 4.4 面板（`HA-4`：自带面板页，不走 HA 前端 iframe）

| 状态 | 界面 |
| --- | --- |
| 未配置 | 两行表单：HA 地址（默认 `http://homeassistant.local:8123`）、长期令牌；「连接测试」打 `GET /api/` + `GET /api/config`，成功显示 HA 版本 |
| 已连接 | 实体网格：按区域分组、按域给控件、离线/未知如实置灰；顶部显示 HA 版本与刷新态（`实时`/`轮询`） |
| 出错 | 一句话说清「哪不对、去哪改」：401 → 令牌无效/被吊销；网络失败 → 地址不可达；WS 断 → 面板标「轮询」并自动重连 |

不嵌 HA 前端的理由：默认 `X-Frame-Options: SAMEORIGIN` 要用户改 HA 配置才能嵌、嵌进去还要再登录一次、观感与工作台割裂（沿用《米家插件规划》§2.3 的既有结论）。

面板形态沿用插件 UI 缝的既有形态（侧栏入口 + 弹层 iframe，与米家面板同形），**不占工作台主区**——《AGENTS.md》的 Design/Flow/Code 主区不变量不受本插件影响。

实时性：WS `subscribe_events`（`state_changed`）驱动增量更新为默认；WS 连不上时降级 5 秒轮询并在界面**如实标注**（不假装实时）。重连用退避（初值/上限/抖动为插件内命名常量并注释；插件 bundle 独立于 `packages/shared` 的治理表，无法引用 `DEC-18` 的属主模块——该理由写进代码注释与 README）。

### 4.5 agent 工具（`HA-5`）

| 工具 | 语义 | 关键行为 |
| --- | --- | --- |
| `ha_entities` | 读：按关键字/域/区域查实体（名称、状态、关键属性） | 结果截断上限；无匹配如实说「没有」 |
| `ha_control` | 写：`entity_id`（或 `domain`+`service`）+ 服务与参数 | 调用后**读回真值**再报结果：`{ok, state, changed}`；未变化如实说「已发出，状态未变」，不假成功 |

- 未配置/令牌失效时 fail loud：返回可读错误（「请先在侧栏 Home Assistant 面板完成配置」），不假装成功。
- **审批口径（已落地）**：`ha_control` 注册时声明 `access: "write"`、`ha_entities` 声明 `access: "read"`——写设备在默认档进审批（与 `mihome_control` 同一套声明，见 §3.3）。插件面板与 README 如实写明「写操作按当前权限档审批」，不再需要「默认档不拦设备写入」的兜底声明。
- 可选：注册一段 systemPrompt 提示（「控制智能家居前先用 ToolSearch 找 `ha_*` 工具」）——先不做，真机验证模型能否自行发现；发现困难再加（保持最小面）。

### 4.6 凭据与边界（`HA-6`）

- 令牌落 `ctx.storage`（实例隔离）；**值明文存本机库**——按 `DEC-7` 修订后的口径如实说明（README + 面板），不写「加密落库」的过期文案。
- HTTP 面永不回显令牌；面板只在「配置」态写入一次，之后只显示「已配置」。
- 令牌等价创建它的 HA 用户的权限（HA 未取证到按令牌的实体白名单）；面板给一句提示「令牌等同该账号在 HA 的控制权限，请妥善保管」。若要收窄控制面，用 HA 的 Assist 暴露 + MCP 路线（§5.1）或另建权限更小的 HA 用户（落地时真机复核）。
- 日志纪律：不打印令牌与实体敏感属性。

### 4.7 与米家插件的关系（`HA-7`）

- **并存，互不依赖**（**已拍板 2026-10-09：米家插件保留不撤**）：米家插件（路线 B，自包含、无 HA 可用）与 HA 插件（路线 A，覆盖米家+华为+其它）各自独立安装；两个都装时侧栏出现两行入口、工具面同时存在，**不做去重/联动**（避免复杂性）。
- 文档口径：HA 插件 README 说明「已用 HA 接入米家的用户不需要再装米家插件，否则设备会在两处各出现一次」；米家插件 README 加一行同样的互斥说明（同一提交内改，属文案级改动）。
- 是否在未来收敛掉米家插件（用户都迁到 HA 后）——列开放问题（§8），本轮不动。

## 5. 备选路线（评估后不取）

### 5.1 零代码 MCP 路线（保留为「只给 agent 用」的轻通路）

HA ≥ 2025.2 自带 MCP Server（`POST /api/mcp`）。两条接法：

1. **推荐（已通，2026-10-09）**：MCP 面板「手动添加 → 远程端点」填 `<HA地址>/api/mcp`，请求头一栏一行 `Authorization=Bearer <长期令牌>` 即可直连，不再需要 `npx mcp-remote` 中转（桌面端可能没有 Node/npx）。
2. **~~本仓缺口~~ 已补齐（2026-10-09）**：MCP 的 `http` 类型此前不支持自定义头——`mcp-service.ts` 构造 `StreamableHTTPClientTransport(new URL(spec.url))` 时不带 `requestInit`，而 HA 的 MCP 端点必须带 `Authorization`。补齐落点：契约（`mcpServerCreateRequestSchema`/`Update` 加 `headers`，名按 HTTP token 收窄、值禁 CR/LF；视图只回 `headerKeys`，值只写不读）+ 存储（迁移 `20261009120036_mcp_servers_headers.sql` 的 `headers jsonb`）+ 传输（Streamable HTTP 与 SSE 回退两条路径都带 `requestInit: { headers }`）+ 面板（远程端点分支的请求头输入框）+ 测试（本机 HTTP 桩断言请求头真的发到线上、值不外发、stdio 不吃请求头）。

不把 MCP 作为主路的原因：暴露面仅限「已暴露给 Assist 的实体」（要在 HA 里逐个配置）、无设备面板、工具进 `mcp__` 危险前缀默认档每次审批。

### 5.2 自研华为/米家云客户端

不取。双份逆向协议（米家已付出一次，见 `plugins/mihome/README.md` 的「协议要点」血泪清单）、风控与许可证红线、逐型号适配成本：华为侧比米家更碎（`prodId` 逐产品适配）。**米家侧已有的自包含实现保留**（无 HA 场景兜底），不再向下投入。

### 5.3 内嵌 HA 前端

不取，理由同 §4.4（X-Frame-Options + 二次登录 + 观感割裂）。

## 6. 分期与验证

一步一提交、一步一测试（《[AGENTS.md](../../AGENTS.md)》提交纪律）；每步验证命令写在该步。

| # | 步骤 | 状态 | 验证 |
| --- | --- | --- | --- |
| P0 | 本文档 + `docs/README.md` 文档地图登记 | ✅ 2026-10-09 | `pnpm test:docs` |
| P1 | bundle 骨架（package.json/patch/入口/README）+ `lib/ha-rest.js`（URL 归一、错误映射）+ 单测（假 HA 的 fetch 层） | 未开工 | `pnpm --filter @kenfutwork/server test` |
| P2 | 面板 + 路由（配置/连接测试/实体列表/控制）+ 存储 + 面板握手接线 | 未开工 | 假 HA 全链路单测 + 真机走查（docker HA：配置 → 列实体 → 开关灯真变） |
| P3 | WS：`subscribe_events` 增量 + 退避重连 + 降级轮询；`ha-ws.js` 的 connect 可注入 | 未开工 | 单测（假 socket 驱动状态机：auth 流/断线/重连/降级）+ 真机（HA 里改灯，面板跟随） |
| P4 | agent 工具 `ha_entities`/`ha_control` + 读回校验 + 未配置 fail loud | 未开工 | 假 HA 单测 + 真机「让 agent 开客厅灯」并核对读回 |
| P5 | 前置缺口：桌面发布包/镜像补 `plugins/` 拷贝；MCP 自定义头（§5.1）；插件工具 `access` 声明进审批（§3.3） | ✅ 2026-10-09（先于 P1 落地，缺口修复独立于插件本体） | `pnpm package:win` 后核 `release/plugins` 存在且市场列出（真机复验见《日志》本轮遗留）；`plugin-bundled-dir.test.ts`、`mcp-service.test.ts` 的线上桩、`permission-service.test.ts` 的声明判据 |
| P6 | 台账（《[日志](../日志.md)》）+ 面板文案复核 + 与米家插件的互斥说明（§4.7） | 未开工（随 P1–P4） | `pnpm test` + `pnpm typecheck` + 真机看图 |

真机验收配方（用户侧一次性）：

1. `docker run -d --name ha -p 8123:8123 -v ha_config:/config ghcr.io/home-assistant/home-assistant:stable`（或用户现有 HA）。
2. HACS 装 `XiaoMi/ha_xiaomi_home`（或 `al-one/hass-xiaomi-miot`）登录小米账号；装 `xiasi0/ha-huawei-smarthome` 登录华为账号并选家庭。
3. 「个人资料 → 安全」创建长期访问令牌。
4. 验证：`curl -H "Authorization: Bearer <令牌>" http://<HA>:8123/api/`（期望 `{"message":"API running."}`）、`curl .../api/states | head`（期望米家与华为实体同池出现——这是「同时兼容」的现场证据）。
5. 到本产品侧栏「Home Assistant」面板填入地址与令牌。

## 7. 明确不做

- 不做 Lovelace 仪表盘编辑、自动化/场景编辑（HA 前端已覆盖；只做「看状态 + 常用控制」）。
- 不做多 HA 实例聚合、不做多用户共享一份 HA 配置。
- 不做厂商协议自研（米家/华为云逆向）、不做厂商分支路由（`if xiaomi` / `if huawei` 一律不许进代码）。
- 不做 Matter/Thread 直连（若设备经 HA 的 Matter 集成出现，本插件自然覆盖）。
- 不内嵌 HA 前端、不做 HA 移动端式推送通知。

## 8. 待拍板问题

> 2026-10-09 第二轮：2–4 已按文内建议落地（缺口修复先于插件本体）；1、5 已由用户拍板（入口叫「智能家居」、米家插件保留）；6 仍待拍板（属插件本体的产品口径，不影响本轮已落地的三处修复）。

1. **插件标题**：**已拍板（用户 2026-10-09）→ 「智能家居」**。面板与侧栏入口用这个名字；HA 字样只出现在配置项与 README（如实说明底层是 Home Assistant）。
2. ~~**写工具审批缺口**（§3.3）~~ **已按建议落地（2026-10-09）**：`CompatToolDefinition.access`（`read`/`write`/`execute`，不声明按 `execute`）映射进内核 `access` 并纳入危险判据；`mihome_control` 已声明 `write`、`mihome_devices` 声明 `read`。**副作用需知**：判据同时对内建共享工具生效——`browser_navigate`/`browser_act`/`browser_eval`、`create_skill`、`install_plugin` 声明的是 `execute`/`write`，在**非 Code 场景（画布助手等）的默认档下从此需要审批**（Code 场景走既有的 Task 审批策略，行为不变）。若认为其中某个不该拦，把它的 `access` 改成与实际效果相符的值即可。
3. ~~**桌面发布包补 `plugins/` 拷贝**（§3.5）~~ **已落地（2026-10-09）**：本轮一并做（win/mac/镜像三处 + 契约测试），并额外排除 Windows 形态下跑不起来的 `computer-use`（§3.5 末）。
4. ~~**MCP 自定义头**（§5.1）~~ **已落地（2026-10-09）**：面板可直连 HA 的 `POST /api/mcp`，无需 `npx`。
5. **米家插件去留**：**已拍板（用户 2026-10-09）→ 两者并存，米家插件保留不撤**（无 HA 场景的兜底，也是自研云客户端的唯一存量实现）。未来是否收敛掉自包含实现——不在本期。
6. **面板控制面**（`HA-3`）：v1 只做常用域（灯/开关/窗帘/空调/传感器），其余域如实只读——是否接受？（**仍待拍板**）

## 9. 参考链接

- HA REST API：<https://developers.home-assistant.io/docs/api/rest/>；WebSocket API：<https://developers.home-assistant.io/docs/api/websocket/>（源文件 `home-assistant/developers.home-assistant` 的 `docs/api/rest.md`、`docs/api/websocket.md`）
- HA 长期令牌（创建入口在「个人资料 → 安全」）：<https://www.home-assistant.io/docs/authentication/>
- HA MCP Server 集成：<https://www.home-assistant.io/integrations/mcp_server/>
- HA 注册表命令源码：<https://github.com/home-assistant/core/tree/dev/homeassistant/components/config>
- 官方小米集成：<https://github.com/XiaoMi/ha_xiaomi_home>（许可见仓库 `LICENSE.md`：仅限非商业 HA 用途）
- 社区小米集成：<https://github.com/al-one/hass-xiaomi-miot>（Apache-2.0）
- 社区华为集成：<https://github.com/xiasi0/ha-huawei-smarthome>（GPL-3.0-only；适配器清单 `docs/supported-devices.md`）
- `mcp-remote`（stdio ↔ HTTP 桥）：<https://github.com/geelen/mcp-remote>
