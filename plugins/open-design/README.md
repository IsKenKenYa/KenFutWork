# OpenDesign 插件（kenfutwork-open-design）

OpenDesign 是写代码 / 原型用的设计引擎（Figma 同类位，但由 coding agent 驱动）。本插件是它的
**产品入口**：安装后 Code 模式右侧栏出现 OpenDesign 面板，与浏览器面板同位互斥切换。

## 安装后发生什么

- Code 模式右侧栏出现 **OpenDesign** 面板（前提：服务端配好前端地址且服务可达，见下）；
- 面板内嵌 OpenDesign 前端（iframe），与浏览器面板占用同一个右侧栏槽位、互斥切换；
- 卸载本插件即消失入口，不摆空壳。

**它不是一个新模式**：OpenDesign 挂在 Code 模式右侧，Code 主区恒为对话（`AGENTS.md` 产品行为不变量）。

## 服务端配置（缺一项入口就不出现）

```
KENFUTWORK_OPEN_DESIGN_FRONTEND_URL=<OpenDesign 前端地址，origin 形式，如 http://127.0.0.1:7456>
KENFUTWORK_OPEN_DESIGN_EMBED_SECRET=<与 OpenDesign 栈 OD_API_TOKEN 成对；不配则凭证下发不可用（503），画布不受影响>
```

配齐与否、服务是否可达，可用 `GET /api/open-design/host/status` 探测（未配齐 / 不可达都会如实
返回缺失原因，界面把原因透出，不放无提示的假开关）。

自托管形态：见下节——配成伴随地址即可由主程序托管起停，无需手动跑上游 compose。

## 承载形态：伴随容器（2026-10-15 拍板，规划 §9-3）

- `KENFUTWORK_OPEN_DESIGN_FRONTEND_URL=http://127.0.0.1:7456`（或 localhost / [::1] 同端口）
  = **伴随容器**：主程序启动即拉起 `open-design/docker-compose.open-design.yml` 的栈，
  退出即停（数据卷保留）；首次启动需拉镜像（分钟级、异步不阻塞），期间入口如实显示
  「正在启动」而不是空壳；
- 伴随栈固定 `OD_DISABLE_API_AUTH=1`：入站免认证只服务宿主 `127.0.0.1:7456`（与上游
  「环回免 token」同一信任边界；真机实证：带 token 的 Basic Auth 会把 iframe 锁死在
  登录弹窗）。`OD_API_TOKEN` 仍随起栈注入成对密钥，供 daemon **出站**调本仓凭证缝；
  未配密钥画布照常可用，凭证下发如实 503；
- 指向其它地址（远端实例 / https 反代）= 用户自管，主程序不起不停不动容器；
- 未装 Docker / 守护进程没起：伴随模式起栈失败，`GET /api/open-design/host/status`
  透出退出码与首行错误，界面把原因带出来；
- 配了 `KENFUTWORK_OPEN_DESIGN_EMBED_SECRET` 时，同一值以 `OD_API_TOKEN` 注入容器
  （凭证下发门的成对半边）；
- 镜像钉 digest（`ghcr.io/nexu-io/od@sha256:587a99…`，2026-10-15 观测 = release
  `open-design-v0.24.1`），升级走 compose 改动 + 回归；归属登记 `THIRD-PARTY-NOTICES.md` §F。

## BYOK 凭证下发（O3 / `OD-4`）

OpenDesign 的 coding-agent CLI（Claude Code / Codex / Cursor / DeepSeek Harness / …）用的
API Key 由**本仓 BYOK 实例**下发，不另配一套：

```
KENFUTWORK_OPEN_DESIGN_EMBED_SECRET=<与 OpenDesign 栈的 OD_API_TOKEN 配成同一值>
```

- OpenDesign daemon 持该密钥调 `POST /api/open-design/host/credentials`（Bearer + 共享密钥
  门，协议版本头 `x-od-embed-protocol: v1`），宿主返回**全部启用且有 Key 的实例清单**
  （`providerId / name / protocol / apiBase / apiKey`），daemon 按各 CLI 需要自行选用；
- **没配密钥 = 这条缝没开**：端点返回 503 与可读原因（不是静默空响应）；
- 明文 Key 只在这条**机器对机器**的通道里流动（服务端 → daemon），浏览器 iframe 永远不经过它，
  日志与错误消息同样不落明文；无可用实例 404、Key 读不到 / 地址非法 409（失败消息只提实例名）；
- 配哪些实例、什么 Key，仍在「供应商设置」里管（本仓 BYOK 的唯一入口）。

## 面板能力口径（2026-10-15 收窄）

面板提供 OpenDesign 画布的**自动连接、打开与直接编辑**：入口出现即画布可用（伴随容器
由主程序起停，见上节）。曾按 O2 最小档实现的深链「在 OpenDesign 中打开当前文件」
**已按用户口径移除**——上游未实现 `od/v1` 协议（实测 0 命中，功能等于点了没反应；
协议支持追踪 [nexu-io/open-design#8776](https://github.com/nexu-io/open-design/issues/8776)）。
`od/v1` 握手通道保留（`data-od-handshake` 诊断），上游若实现联动可直接恢复。

## 边界

- 只走 **local-first + BYOK**，不接 OpenDesign Cloud / 付费计划；
- 不把 OpenDesign 源码克隆进本仓（上游仓库 ≈3.4GB），接入走发行包 / Docker 镜像；
- 上游许可证 Apache-2.0（bundled skills / templates 保留各自 license）。
