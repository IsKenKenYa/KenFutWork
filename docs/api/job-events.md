# 服务端事件契约（run / job 流事件）

> **角色**：参考。契约唯一属主是 `packages/shared/src/events.ts`（`streamEventSchema` 判别联合），本文只做导读；改事件先改契约，再同步本文。

## 投递通道

1. **WebSocket 实时推送**：`/api/ws` 的 `event` 帧（`wsServerEventSchema` 包装 `streamEventSchema`），见《ws-protocol.md》。
2. **HTTP 轮询兜底**：后台任务（图片/视频生成等 PGMQ job）的状态与结果经 `GET /api/jobs/:jobId` 轮询（见 openapi.json `jobs` 域）。

## 事件清单（`streamEventSchema` 判别联合，按 `type` 区分）

| type | 阶段 | 说明 |
| --- | --- | --- |
| `run.started` | run 生命周期 | 运行开始 |
| `run.completed` | run 生命周期 | 运行完成（终态结算） |
| `run.canceled` | run 生命周期 | 运行被取消 |
| `run.failed` | run 生命周期 | 运行失败（含可读错误） |
| `run.retrying` | run 生命周期 | 步骤重试中 |
| `run.usage` | 用量 | 单 run 用量上报 |
| `run.compacted` | 上下文 | 上下文压缩发生 |
| `run.hook` | 生命周期闸门 | hook 触发（如 plan 批准门） |
| `thinking.delta` | 流式增量 | 思考内容增量 |
| `message.delta` | 流式增量 | 消息正文增量 |
| `tool.started` | 工具 | 工具调用开始 |
| `tool.completed` | 工具 | 工具调用完成（含结果摘要） |
| `task.notification` | 子代理/后台任务 | 后台任务完成通知注入 |
| `canvas.sync` | 画布 | 画布状态同步 |
| `billing.error` | 计费 | 计费错误（错误码封闭枚举 `billingErrorCodeSchema`） |
| `flowRun.event` | flow 集成 | flow 引擎运行事件回流（经宿主缝 `POST /api/flow/host/events` 进入） |

## 约定

- 事件均为服务端 → 客户端单向推送；客户端命令通道见《ws-protocol.md》。
- 终态事件（`run.completed` / `run.failed` / `run.canceled`）必须整条保留消息块，禁止中途抹除（对齐 dsh 口径）。
- 事件经 WS 断线后可用 `canvas.resume`（`lastSeq`）重放，不丢事件。
