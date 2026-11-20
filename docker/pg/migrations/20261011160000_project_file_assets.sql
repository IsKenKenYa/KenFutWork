-- 普通项目文件索引：legacy源保留，pending发布可按已知路径恢复。
alter table public.asset_objects
  add column relative_path text,
  add column task_id uuid references public.code_ui_sessions(id),
  add column write_fingerprint text,
  add column scope_generation bigint,
  add column file_state text not null default 'legacy',
  add column pending_relative_path text,
  add column legacy_bucket text,
  add column legacy_object_path text;

alter table public.asset_objects add constraint asset_objects_project_file_state_check check (
  (file_state = 'legacy' and relative_path is null and task_id is null and write_fingerprint is null and pending_relative_path is null)
  or
  (file_state in ('pending', 'ready') and project_id is not null
    and relative_path is not null and relative_path <> ''
    and write_fingerprint ~ '^[a-f0-9]{64}$'
    and ((task_id is null and scope_generation is null) or (task_id is not null and scope_generation > 0)))
);
create index asset_objects_project_files_idx on public.asset_objects(instance_id, project_id, task_id)
  where relative_path is not null;
