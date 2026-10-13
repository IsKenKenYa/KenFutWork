alter table public.asset_objects add column task_kind text;
update public.asset_objects set task_kind='code' where task_id is not null;
alter table public.asset_objects add constraint asset_objects_task_kind_check
  check ((task_id is null)=(task_kind is null) and (task_kind is null or task_kind in ('code','design')));
alter table public.asset_objects drop constraint asset_objects_task_id_fkey;
alter table public.asset_objects add constraint asset_objects_execution_task_owner_fkey
  foreign key (instance_id,task_id,project_id,task_kind)
  references public.execution_task_owners(instance_id,task_id,project_id,task_kind) on delete cascade;
