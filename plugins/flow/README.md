# Flow 工作流插件（kenfutwork-flow）

Flow 是 KenFutWork 的可视化工作流模式，
覆盖编排、发布快照、执行与审计。本插件是它的**产品入口**（`FORM-11`）。

## 安装后发生什么

- 工作台模式切换器出现 **Flow** 项；
- 宿主自动准备运行时：数据目录生成端口与密钥、在应用库创建 `futureflow` 库、
  构建并启动网关与前端（iframe，`ff-embed/v1` 握手，身份由宿主签发）；
- 插件禁用或卸载时停止运行时；**应用重启、电脑重启后按安装态自动重新拉起**；
- 不需要手工改端口、启动进程或填写地址。

## 服务端配置

本机实例**不需要配置**：`KENFUTWORK_FLOW_EMBED_SECRET`、`KENFUTWORK_FLOW_FRONTEND_URL`、
`KENFUTWORK_FLOW_GATEWAY_URL` 三项全部留空时走自动托管。

只有接入外部 flow 实例（自托管或反向代理）时才需要三项同时配置；只配一部分会显式报错，
不会悄悄覆盖用户的半套配置。

```
KENFUTWORK_FLOW_EMBED_SECRET=<与 flow 网关 HOST_SHARED_SECRET 相同的共享密钥，≥16 位>
KENFUTWORK_FLOW_FRONTEND_URL=<flow 前端地址，origin 形式，如 http://127.0.0.1:8080>
KENFUTWORK_FLOW_GATEWAY_URL=<flow 网关地址，如 http://127.0.0.1:15010>
```

`GET /api/flow/host/status` 返回 `runtime.state`：`starting`（启动中，前端会自动重试）、
`ready`、`error`（带可读原因）、`external`（外部实例）。

## 运行时文件与排障

- `<数据目录>/flow/flow-runtime.json`：端口与密钥（0600），重启复用；
- `flow/gateway/.futureflow.runtime.env`：网关最高优先级 env，由宿主生成；
- `<数据目录>/flow/gateway.log`、`gateway-build.log`、`frontend-build.log`：运行与构建日志；
- 首次启动会构建 flow 网关与前端（需要 flow 子模块已安装依赖）；源码更新后自动重建，
  构建产物未变化时直接复用。

## 引擎说明

执行引擎（本地 Dify 无头栈）**不随安装包分发**：启用执行能力时按需下载，
由本插件托管生命周期（WSL2 / 本机容器双 Provider，P6 落地）。仅使用画布与编排
不需要引擎。
