-- 原 Code V4 附件事务：私有 Blob bytes 与 Task 所属持久事实；不影响 Design 上传。
create table public.code_attachments (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  task_id uuid not null references public.code_ui_sessions(id) on delete cascade,
  session_id uuid not null references public.code_ui_sessions(id) on delete cascade,
  user_id uuid not null references public.accounts(id) on delete cascade,
  upload_key text not null check (upload_key ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('staging', 'committed', 'aborted')),
  execution_host_id text not null,
  connection_id text,
  runtime_id text,
  record jsonb not null check (jsonb_typeof(record) = 'object'),
  primary key (workspace_id, upload_key),
  check (record->>'status' = status and record->>'key' = upload_key),
  check ((status = 'staging' and connection_id is not null and runtime_id is not null)
    or (status <> 'staging' and connection_id is null and runtime_id is null)),
  -- 墓碑只保留稳定生命周期身份；不保留文件名、引用、内容摘要或 checksum。
  check (status <> 'aborted' or record - array['status','key','workspaceId','projectId','taskId','sessionId','userId']::text[] = '{}'::jsonb)
);
create index code_attachments_task on public.code_attachments (workspace_id, task_id);
create index code_attachments_staging on public.code_attachments (execution_host_id, connection_id) where status = 'staging';
comment on table public.code_attachments is 'Code Task 私有附件事实；aborted 最小墓碑保留至工作区、Task 或用户物理删除级联清除，阻止迟到上传复活。';
