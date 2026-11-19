-- 恢复线程级执行模式持久化（自主/计划/对话/目标/创造）。
-- 20261022130155 统一主 Agent 时删除了该列，桌面端会话切换执行方式后无法跨重启保持；
-- 本次以前向迁移把列与约束加回，NULL = 默认 agent。

ALTER TABLE public.chat_sessions
  ADD COLUMN execution_mode text;

ALTER TABLE public.chat_sessions
  ADD CONSTRAINT chat_sessions_execution_mode_check
  CHECK (execution_mode IN ('agent', 'plan', 'solo', 'goal', 'loop', 'creative'));

COMMENT ON COLUMN public.chat_sessions.execution_mode IS
  '线程激活的执行模式；NULL = 默认 agent。';
