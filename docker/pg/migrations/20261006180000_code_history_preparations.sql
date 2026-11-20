create table public.code_history_preparations (
  id uuid primary key,
  instance_id uuid not null references public.local_instances(id) on delete cascade,
  source_task_id uuid not null,
  target_task_id uuid not null,
  target_thread_id text not null,
  client_id text not null,
  command_id text not null,
  host_id text not null,
  runtime_id text not null,
  published boolean not null default false,
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object'),
  created_at timestamptz not null default now(),
  unique (instance_id, client_id, command_id)
);
create index code_history_preparations_owner on public.code_history_preparations(host_id, runtime_id);
comment on table public.code_history_preparations is '分叉私有资源先持久准备；发表位与Task/ACK同事务，重启仅核对和清理、不重放执行；不随源Task删除丢失准备事实';
