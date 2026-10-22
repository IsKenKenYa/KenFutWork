-- 安装内部ID与文件声明标识分开；卸载后仅保留拒绝重放所需的内部字段。
alter table public.media_driver_registry
  add column installation_id uuid not null default gen_random_uuid(),
  add constraint media_driver_installation_unique unique(instance_id,installation_id);

alter table public.media_driver_versions add column installation_id uuid;
update public.media_driver_versions v
set installation_id=d.installation_id
from public.media_driver_registry d
where v.instance_id=d.instance_id and v.driver_id=d.driver_id;
alter table public.media_driver_versions
  alter column installation_id set not null,
  add constraint media_driver_version_installation_fk
    foreign key(instance_id,installation_id)
    references public.media_driver_registry(instance_id,installation_id) on delete cascade;

update public.media_driver_operations o
set receipt=jsonb_set(
  jsonb_set(o.receipt,'{driver,installationId}',to_jsonb(d.installation_id)),
  '{driver,currentVersion,installationId}',to_jsonb(d.installation_id)
)
from public.media_driver_registry d
where o.instance_id=d.instance_id and o.driver_id=d.driver_id;

create table public.media_driver_removals (
  instance_id uuid not null references public.local_instances(id) on delete cascade,
  installation_id uuid not null,
  generation bigint not null check(generation > 0),
  removed_at timestamptz not null,
  primary key(instance_id,installation_id)
);
