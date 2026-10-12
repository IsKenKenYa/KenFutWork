-- 关闭意图先持久化，资源确认后再归档；失败不恢复旧Task授权代际。
alter table public.projects add column archive_state text not null default 'open';
alter table public.projects add constraint projects_archive_state_check
  check (archive_state in ('open', 'closing', 'failed'));
