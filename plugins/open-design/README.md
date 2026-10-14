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

## 边界

- 只走 **local-first + BYOK**，不接 OpenDesign Cloud / 付费计划；
- 不把 OpenDesign 源码克隆进本仓（上游仓库 ≈3.4GB），接入走发行包 / Docker 镜像；
- 上游许可证 Apache-2.0（bundled skills / templates 保留各自 license）。
