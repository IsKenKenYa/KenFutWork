-- 编辑器修订由所有项目更新共同推进，旧 REST 与原 UI 使用同一项目事实。
alter table public.projects
  add column editor_revision integer not null default 0
  check (editor_revision >= 0);

create function public.advance_project_editor_revision()
returns trigger language plpgsql as $$
begin
  if (to_jsonb(new) - 'editor_revision' - 'updated_at')
       is distinct from (to_jsonb(old) - 'editor_revision' - 'updated_at') then
    new.editor_revision := old.editor_revision + 1;
    new.updated_at := clock_timestamp();
  else
    new.editor_revision := old.editor_revision;
    new.updated_at := old.updated_at;
  end if;
  return new;
end;
$$;

create trigger projects_editor_revision
before update on public.projects
for each row execute function public.advance_project_editor_revision();

-- receipt 只记录本次编辑的幂等结果，项目内容仍由 public.projects 持有。
create table public.project_editor_save_receipts (
  instance_id uuid not null references public.local_instances(id) on delete cascade,
  project_id uuid not null,
  expected_revision integer not null check (expected_revision >= 0),
  parameter_fingerprint text not null check (parameter_fingerprint ~ '^[0-9a-f]{64}$'),
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  primary key (instance_id, project_id, expected_revision),
  foreign key (project_id, instance_id)
    references public.projects(id, instance_id) on delete cascade
);

comment on column public.projects.editor_revision is '项目配置观察修订；真实更新推进，同值更新不推进。';
comment on table public.project_editor_save_receipts is '原项目编辑器按实例、项目和观察修订保存的幂等记录；物理删除归属资源时级联清理。';
