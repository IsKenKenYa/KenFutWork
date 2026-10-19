# 智能家居插件（kenfutwork-ha）

把**用户自建的 Home Assistant（HA）**接进工作台：侧栏面板可看可控制，agent 也能直接操作。
HA 里装了什么生态集成，这里就覆盖什么设备——米家靠 HA 的小米集成、华为靠 HA 的华为集成，
**本插件不碰任何厂商协议，也不按厂商分支**。方案与取证见
《[HA 插件规划](../../docs/插件/米家和HA插件规划.md)》。

## 安装

1. 插件市场 →「内置」分区 →「智能家居」点安装（自带 bundle，不需要找来源链接）。
   没有「内置」分区时（本机开发态）走「从链接安装」→ 填目录路径 `plugins/ha`。
2. 安装需要本机接入身份；装完侧栏出现「智能家居」一行。

## 用法

1. 在 HA 里：「个人资料 → 安全」创建一个**长期访问令牌**。
2. 侧栏「智能家居」→ 填 HA 地址（形如 `http://192.168.1.20:8123`）与令牌 → 点「连接」。
   连得上才保存；之后面板只显示「已配置」，令牌不再回显。
3. 面板按**区域**分组列实体（区域信息来自 HA 的注册表，拿不到时退回按域分组）：
   灯给开关/亮度/色温，开关给开关，窗帘给开/合/停 + 位置，空调给目标温度 + 模式，
   风扇、媒体播放器给基础项，其余品类（传感器、二进制传感器、太阳、天气……）**如实只读**。
   离线与未知状态置灰并标「离线」，不编造设备。
4. agent 工具：
   - `ha_entities`：按域/区域/关键字查实体（状态、读数、可用控件与量程）；
   - `ha_control`：按 `entityId + key + service (+ value)` 下发，返回**读回的真值**；
     设备没动时如实回「已发出，状态未变」，不报假成功。
   - 未配置时两个工具都直接报「请先在侧栏『智能家居』面板完成配置」。

## 能力与接线

- 能力声明：`tools` + `routes` + `ui` + `storage`，零内核改动（自带 bundle 由
  `plugins/` 目录自动发现，打包脚本整目录随包拷贝）。
- 路由（全部私有，需本机接入身份；面板用同源 iframe + HttpOnly 会话 cookie）：
  `GET config`、`POST config`、`POST test`、`GET entities`、`POST control`、`POST disconnect`。
- 配置（HA 地址 + 长期令牌）存 `ctx.storage`：**按实例隔离、值在本机库明文保存、HTTP 永不回显**；
  卸载由 registry purge，只「停用」则保留。见 `DEC-7`（2026-10-05 修订）后的本地凭据口径。
- 实时性：每实例一条 HA WebSocket 会话（`subscribe_events` 的 `state_changed` 增量 +
  注册表命令补齐名称/区域）。连不上时自动退回 REST 轮询，面板顶栏**如实标注「轮询」**，不假装实时。
- 控件与量程换算只在服务端一处（`lib/entity-model.js`）：面板与工具说百分比，
  HA 收到的是 `brightness_pct` / `position` / `volume_level(0~1)`；越界、改服务名、
  点只读实体的控件一律被拒。`entity_id` 一定随服务参数下发——漏了它会打给该域的**全部**实体。

## 协议要点（对着 HA 官方文档与 core 源码逐条核过，2026-10-18）

1. REST：`GET /api/`（`{"message":"API running."}`）、`GET /api/config`、`GET /api/states`、
   `GET /api/states/<entity_id>`、`POST /api/services/<domain>/<service>`；鉴权统一
   `Authorization: Bearer <长期令牌>`。401/403 = 令牌问题，400 体里的 `message` 是 HA 的原话，直接带出。
2. WebSocket：端点 `<base>/api/websocket`；服务端先回 `auth_required`，客户端才递凭据
   （不抢跑），`auth_ok` 后才 `subscribe_events`。令牌被判 `auth_invalid` 时**停止重试**——
   反复撞认证失败的日志没有意义，改配置才重起。
3. 注册表命令 `config/entity_registry/list`、`config/area_registry/list`、
   `config/device_registry/list` 的 `result` 都是**裸数组**（HA core 源码
   `homeassistant/components/config/*_registry.py`）；实体条目直接带 `area_id` 与 `device_id`，
   所以区域可以先取实体自己的 `area_id`，没有再经设备继承。
4. **控件判据取「能力」不取「当前属性」**（真机 2026.10.2 实测）：灯关着时 HA 不再报
   `brightness` 属性，但 `supported_color_modes` 仍在（demo 灯为 `["color_temp","hs"]`）——
   亮度控件按前者给，当前值拿不到就如实给 `null`（面板显示「—」）。若按当前属性判，
   「把关着的灯调到 30%」这条最自然的指令会被自己拒掉（`turn_on` + `brightness_pct` 正是 HA 的语义）。
   只支持 `onoff` 的灯不给亮度控件。
5. 面板不能嵌 HA 前端：它默认发 `X-Frame-Options: SAMEORIGIN`，嵌进去还要再登录一次，
   观感与工作台割裂（沿用规划 §4.4 的既有结论）。
6. 只想给 agent 用、不做面板：HA ≥ 2025.2 自带 MCP Server（`POST /api/mcp`），
   在本产品「MCP」面板「手动添加 → 远程端点」填 `<HA 地址>/api/mcp`，请求头一栏写
   `Authorization=Bearer <长期令牌>` 即可直连（本仓的 MCP `http` 传输已支持自定义头）。
   它的暴露面仅限「已暴露给 Assist 的实体」，且工具进 `mcp__` 前缀每次审批——所以本插件仍是主路。

## 已知限制（如实）

1. **要有一台在跑的 HA**。本插件只对接 HA；没有 HA 就只能用米家插件（自包含那套）。
2. **服务端要能访问 HA 地址**：桌面端与 HA 通常同一局域网；Docker 自托管时容器要能出到该地址，
   连不上面板会给「HA 地址不可达（<地址>）」而不是含糊的「失败」。
3. **单实例单 HA**（v1）：一个实例一份配置，不做多 HA 聚合。
4. **控制面只做常用域**，其余域只读（规划 §8-6）；不做 Lovelace 仪表盘编辑、
   自动化/场景编辑、推送通知，也不做 Matter/Thread 直连（设备若经 HA 的 Matter 集成出现，自然覆盖）。
5. **华为侧覆盖率由社区集成决定**（`xiasi0/ha-huawei-smarthome` 按 `prodId` 逐产品适配）：
   没有适配器的设备表现为「HA 里根本没有这个实体」，本面板也就看不到它。
6. **令牌等价于创建它的 HA 用户权限**（HA 没有按令牌的实体白名单）。要收窄控制面，
   用 HA 的 Assist 暴露 + MCP 路线，或另建一个权限更小的 HA 用户。日志不打印令牌与实体敏感属性。
7. `ha_control` 声明 `access: "write"` → **默认档下写设备要审批**；`ha_entities` 声明 `read`，只读不审批。
   更严可在设置 → 权限 → 自定义里加 deny 规则。
8. 一次最多渲染 500 个实体、`ha_entities` 一次最多返回 60 条，超出都在界面上如实标注。
   这些是插件内的命名常量：治理数值的属主 `packages/shared/src/governance.ts` 属于 workspace 包，
   bundle 独立分发、不能 import 它（规划 §4.4 已确认此例外）。
9. **与米家插件并存、互不联动**（规划 HA-7）：两个都装时侧栏出现两行入口、工具面同时存在。
   已经用 HA 接入米家的用户**不需要再装米家插件**，否则同一批设备会在两处各出现一次。

## 开发

- **静态资源布局**：面板文件放 bundle **根目录**（`panel.html` / `panel.js`），清单里的 `ui.url`
  写 `assets/panel.html`——`assets/` 是内核的 HTTP 路由前缀（`/api/plugins/<id>/assets/*`），
  文件路径相对 bundle 根。放成子目录 `assets/panel.html` 会 404（米家插件实测踩过的坑，本包有回归测试锁死）。
- 直接改本目录后**重启服务端**即生效（安装是把 bundle 拷到实例数据根的 `plugins/` 下）；
  改清单（`package.json` 的 `ui`/`assets`、`cordis.patch.yml` 的 `inject`）需要重新安装。
- 零依赖是硬约束：bundle 安装期不跑包管理器，只收文本文件。REST 用全局 `fetch`，
  WS 用 Node 22 的全局 `WebSocket`（随包运行时同为 22.20.0）。
- 单测在宿主侧：`apps/server/src/features/plugins/ha-plugin.test.ts`
  （纯函数 + 假 HA 的 HTTP/WS 桩跑通 配置 → 实体 → 控制 → 实时增量 → agent 工具）。
  假桩只证明**收发一致性**（鉴权头、URL 拼法、状态机、错误分支），不构成对真实 HA 的验证。
- 图标是自绘的房子+信号点，不是 Home Assistant 的商标图形。

## 真机验收配方（一次性）

```bash
docker run -d --name ha -p 8123:8123 -v ha_config:/config \
  ghcr.io/home-assistant/home-assistant:stable
# HACS 装小米集成（XiaoMi/ha_xiaomi_home 或 al-one/hass-xiaomi-miot）并登录；
# 要覆盖华为再装 xiasi0/ha-huawei-smarthome。
# 「个人资料 → 安全」创建长期访问令牌。
curl -H "Authorization: Bearer <令牌>" http://<HA>:8123/api/        # 期望 {"message":"API running."}
curl -H "Authorization: Bearer <令牌>" http://<HA>:8123/api/states   # 期望米家与华为实体同池出现
```

然后在侧栏「智能家居」面板填入地址与令牌：列实体 → 开关灯看设备真变 →
让 agent「把客厅灯打开」并核对读回结果。
