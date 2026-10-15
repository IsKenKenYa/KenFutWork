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
```

配齐与否、服务是否可达，可用 `GET /api/open-design/host/status` 探测（未配齐 / 不可达都会如实
返回缺失原因，界面把原因透出，不放无提示的假开关）。

自托管形态：OpenDesign 官方 `deploy/docker-compose.yml` 起在本机 `127.0.0.1:7456`。

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

## 边界

- 只走 **local-first + BYOK**，不接 OpenDesign Cloud / 付费计划；
- 不把 OpenDesign 源码克隆进本仓（上游仓库 ≈3.4GB），接入走发行包 / Docker 镜像；
- 上游许可证 Apache-2.0（bundled skills / templates 保留各自 license）。
