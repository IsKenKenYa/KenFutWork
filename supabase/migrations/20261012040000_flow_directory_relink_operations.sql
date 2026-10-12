-- Flow 目录恢复跨进程保留控制意图；未知停止不重放副作用。
create table public.project_directory_relink_operations (
  instance_id uuid not null references public.local_instances(id) on delete cascade,
  project_id uuid not null,
  operation_id uuid not null,
  previous_root text not null check (length(previous_root)>0),
  next_root text not null check (length(next_root)>0),
  expected_flow_generation bigint not null check (expected_flow_generation>0),
  phase text not null check (phase in ('staged','quiesce_unknown','quiesced','root_published','complete_unknown','complete')),
  gateway_receipt jsonb check (gateway_receipt is null or jsonb_typeof(gateway_receipt)='object'),
  primary key (instance_id,project_id,operation_id),
  foreign key (project_id,instance_id) references public.projects(id,instance_id) on delete cascade
);
create unique index project_directory_relink_one_pending
  on public.project_directory_relink_operations(instance_id,project_id)
  where phase<>'complete';
