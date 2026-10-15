-- 队列是唤醒通道；重启后仍可从持久Job补齐投递。
alter table public.background_jobs
  add column next_action_at timestamptz not null default now(),
  add column wakeup_at timestamptz not null default now();
create index background_jobs_ready_action on public.background_jobs(next_action_at,wakeup_at)
  where status in ('queued','running','failed');
