-- 可读停止语义随Run主账本持久；旧记录保留NULL，不推测历史终止原因。
alter table public.agent_runs add column stop_reason text;
alter table public.agent_runs add constraint agent_runs_stop_reason_check check (
  stop_reason is null or stop_reason in (
    'completed', 'output_limit', 'user_cancelled', 'task_stopped', 'host_shutdown'
  )
);
