-- 消费消息只负责唤醒；数据库租约决定谁能执行及写回。
alter table public.background_jobs
  add column lease_token uuid,
  add column lease_until timestamptz;
create index background_jobs_expired_lease
  on public.background_jobs (lease_until)
  where status in ('queued','running','failed');
