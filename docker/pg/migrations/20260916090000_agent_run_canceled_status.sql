-- agent_runs.status 增加 'canceled' 一档。
--
-- 起因（GUI 实测）：用户在对话里点「停止本轮」后，`run.canceled` 事件到达客户端、流也停了
-- （服务端日志 `ws.run_cancel` → 38ms 后 `stream_done`），但 `agent_runs` 的行**没有任何终态**——
-- `syncPersistedRunFromEvent` 只认 `run.completed`/`run.failed`，取消路径不落库。结果是：
--   1. 行永远停在 `running`（僵尸行），只能等下次进程启动的「孤儿对账」把它收敛成 failed；
--   2. 那一轮明明是用户主动取消，运行历史里却被记成失败，污染失败率。
--
-- 为什么单列一档而不是复用 'failed'：取消不是故障——客户端的终态事件、界面文案（已停止）、
-- 后续统计口径都区分这两者；把取消记成失败会让「失败率」这个指标失去意义。
--
-- 约束是建表时内联写的，Postgres 自动命名为 `agent_runs_status_check`；这里显式重建（前向迁移，
-- 不改历史迁移文件）。
ALTER TABLE public.agent_runs
  DROP CONSTRAINT IF EXISTS agent_runs_status_check;

ALTER TABLE public.agent_runs
  ADD CONSTRAINT agent_runs_status_check
  CHECK (status IN ('accepted', 'running', 'completed', 'failed', 'canceled'));
