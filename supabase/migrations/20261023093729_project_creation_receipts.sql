-- 创建意图按实例登记；删除后仅保留业务键，迟到请求不能重新创建项目。
create table public.project_creation_receipts (
  instance_id uuid not null references public.local_instances(id) on delete cascade,
  creation_id uuid not null,
  project_id uuid,
  parameter_fingerprint text,
  result jsonb,
  primary key (instance_id, creation_id),
  foreign key (project_id, instance_id)
    references public.projects(id, instance_id) on delete set null (project_id),
  check (
    (project_id is null and parameter_fingerprint is null and result is null)
    or
    (project_id is not null and parameter_fingerprint is not null and result is not null
      and parameter_fingerprint ~ '^[0-9a-f]{64}$'
      and jsonb_typeof(result) = 'object')
  )
);

create function public.retire_project_creation_receipts()
returns trigger language plpgsql as $$
begin
  update public.project_creation_receipts
     set project_id=null,parameter_fingerprint=null,result=null
   where instance_id=old.instance_id and project_id=old.id;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger project_creation_receipts_archived
after update of archived_at on public.projects
for each row when (old.archived_at is null and new.archived_at is not null)
execute function public.retire_project_creation_receipts();

create trigger project_creation_receipts_deleted
before delete on public.projects
for each row execute function public.retire_project_creation_receipts();

comment on table public.project_creation_receipts is
  '项目创建回执；删除墓碑只保留实例与creationId，实例物理删除时级联清理。';
