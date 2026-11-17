-- 文档索引软删除；保留会话、素材与外部画布文件。
alter table public.canvases add column deleted_at timestamptz;
drop index public.canvases_one_primary_per_project_key;
create unique index canvases_one_primary_per_project_key
  on public.canvases(project_id) where is_primary and deleted_at is null;
create index canvases_active_project_idx
  on public.canvases(project_id, updated_at desc, id) where deleted_at is null;
comment on column public.canvases.deleted_at is '删除文档索引，不删除源文件、素材或统一会话。';
