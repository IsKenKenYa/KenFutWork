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
| `run.usage` | 用量 | 实际模型调用的累计绝对值及所在 Run 的调用总量 |
| `run.compacted` | 上下文 | 上下文压缩发生 |
| `run.hook` | 生命周期闸门 | hook 触发（如 plan 批准门） |
| `thinking.delta` | 流式增量 | 思考内容增量 |
| `message.delta` | 流式增量 | 消息正文增量 |
| `tool.started` | 工具 | 工具调用开始 |
| `tool.completed` | 工具 | 工具调用完成（含结果摘要） |
| `task.notification` | 子代理/后台任务 | 后台任务完成通知注入 |
| `canvas.sync` | 画布 | 画布状态同步 |
| `flowRun.event` | flow 集成 | flow 引擎运行事件回流（经宿主缝 `POST /api/flow/host/events` 进入） |

## 约定

- `run.usage.modelCallId` 来自 SDK 的真实模型调用身份；同调用 stream/end 上报是绝对值覆盖，不同调用相加。`inputTokens` / `outputTokens` 属于该调用，`runInputTokens` / `runOutputTokens` 属于整个 Run；不能用提示 token 是否变化或消息 ID 猜调用边界，也不能把重复事件再相加。
- 实际用量变化（包括终值向下修正）可下发，重复绝对值不再投影；停止或失败时只保留已观察到的用量，不估算未上报 token。`cachedInputTokens` / `runCachedInputTokens` 缺省表示上游未上报，已知缓存值在后续字段缺失时保留，显式 0 可覆盖。缺少真实调用身份或非法计量值拒绝采集；采集旁路失败不会终止原模型运行。
- Code 原 V4 宿主按 Run 的绝对总量维护 Task 累计并持久恢复，关闭 Run 的迟到事件不覆盖新 Run；原 V4 的必填缓存数字字段保留原协议形状，其 0 不能作为上游确实上报缓存的证据。外部流事件的缓存字段仍保持可选。

- 事件均为服务端 → 客户端单向推送；客户端命令通道见《ws-protocol.md》。
- 终态事件（`run.completed` / `run.failed` / `run.canceled`）必须整条保留消息块，禁止中途抹除（对齐 dsh 口径）。
- 事件经 WS 断线后可用 `canvas.resume`（`lastSeq`）重放，不丢事件。
