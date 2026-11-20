-- 执行模式线程级持久化（DEC-3 六档：agent/plan/solo/goal/loop/creative）。
-- 此前模式状态只在进程内存 Map：重启即丢、多副本各存各的。落列后 activate 写回，
-- 未声明模式的 run 在起跑前读回（hydrate），线程的模式跨重启保持。
-- NULL = 默认 agent；约束限定合法值，防脏数据静默入表。

ALTER TABLE public.chat_sessions
  ADD COLUMN execution_mode text;

ALTER TABLE public.chat_sessions
  ADD CONSTRAINT chat_sessions_execution_mode_check
  CHECK (execution_mode IN ('agent', 'plan', 'solo', 'goal', 'loop', 'creative'));

COMMENT ON COLUMN public.chat_sessions.execution_mode IS
  '线程激活的执行模式（DEC-3）；NULL = 默认 agent。';
