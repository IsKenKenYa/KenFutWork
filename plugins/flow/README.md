# Flow 工作流插件（kenfutwork-flow）

Flow 是 KenFutWork 的第三种工作模式（design / code 之外的 flow）：可视化 AI 工作流，
覆盖编排、发布快照、执行与审计。本插件是它的**产品入口**（`FORM-11`）。

## 安装后发生什么

- 工作台模式切换器出现 **Flow** 项（前提：服务端适配层已配齐，见下）；
- Flow 模式主区内嵌 flow 前端（iframe，`ff-embed/v1` 协议握手）：
  身份由宿主签发（免二次登录）、去品牌、视觉随宿主；
- 卸载本插件即消失 Flow 入口，不加载 flow 能力（不摆空壳）。

## 服务端配置（缺一项入口就不出现）

```
KENFUTWORK_FLOW_EMBED_SECRET=<与 flow 网关 HOST_SHARED_SECRET 相同的共享密钥，≥16 位>
KENFUTWORK_FLOW_FRONTEND_URL=<flow 前端地址，origin 形式，如 http://127.0.0.1:8080>
KENFUTWORK_FLOW_GATEWAY_URL=<flow 网关地址，如 http://127.0.0.1:15010>
```

配齐与否可用 `GET /api/flow/host/status` 探测（未配齐会如实返回缺失原因）。
flow 侧（futureFlow 网关）按 `flow/docs/ff-embed-v1.md` 配置 `HOST_MODE=embedded` 等变量。

## 本机联调

网关与前端是两套进程，前端与网关的地址在**启动时**决定；地址对不上时 Flow 主区只会停在加载或握手报错。

```
# 网关（读取 flow/.futureflow.runtime.env 与 flow/.env）
pnpm run start:dev            # 在 flow/gateway 下执行

# 前端（在 flow/frontend 下执行；网关地址是编译期常量，不读 flow/.env）
# PowerShell：
$env:FRONTEND_PORT='8190'; $env:PUBLIC_GATEWAY_URL='http://127.0.0.1:15010'; pnpm run start
# bash：
FRONTEND_PORT=8190 PUBLIC_GATEWAY_URL=http://127.0.0.1:15010 pnpm run start
```

两端地址要与服务端 `KENFUTWORK_FLOW_FRONTEND_URL` / `KENFUTWORK_FLOW_GATEWAY_URL`、网关 `HOST_SHARED_SECRET` 与 `KENFUTWORK_FLOW_EMBED_SECRET` 成对一致。

## 引擎说明

执行引擎（本地 Dify 无头栈）**不随安装包分发**：启用执行能力时按需下载，
由本插件托管生命周期（WSL2 / 本机容器双 Provider，P6 落地）。仅使用画布与编排
不需要引擎。
