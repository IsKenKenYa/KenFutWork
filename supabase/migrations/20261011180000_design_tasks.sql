alter table public.chat_sessions add constraint chat_sessions_task_instance_project_key unique (id,instance_id,project_id);
create table public.design_task_executions (
  task_id uuid primary key,
  instance_id uuid not null references public.local_instances(id) on delete cascade,
  project_id uuid not null,
  root_directory text not null check (length(root_directory)>0),
  additional_directories jsonb not null default '[]'::jsonb check (jsonb_typeof(additional_directories)='array'),
  sandbox_mode text not null default 'workspace-write' check (sandbox_mode in ('read-only','workspace-write','danger-full-access')),
  scope_generation bigint not null default 1 check (scope_generation>0),
  branch_generation bigint not null default 1 check (branch_generation>0),
  permission_mode text not null default 'build' check (permission_mode in ('build','edit','yolo')),
  plan_enabled boolean not null default false,
  planning_epoch bigint not null default 0 check (planning_epoch>=0),
  execution_state text not null default 'ready' check (execution_state in ('ready','revoking','failed')),
  active_run_id text,
  runtime_owner_id uuid,
  run_state text not null default 'idle' check (run_state in ('idle','running','stopping')),
  next_input_seq bigint not null default 1 check (next_input_seq>0),
  last_settled_run_id text,
  last_run_outcome text check (last_run_outcome in ('completed','canceled','failed')),
  unique (task_id,instance_id),
  foreign key (project_id,instance_id) references public.projects(id,instance_id) on delete cascade,
  foreign key (task_id,instance_id,project_id) references public.chat_sessions(id,instance_id,project_id) on delete cascade,
  check ((active_run_id is null)=(run_state='idle'))
);
create table public.design_task_inputs (
  task_id uuid not null,
  instance_id uuid not null,
  input_id text not null,
  run_id text not null,
  admission_seq bigint not null check (admission_seq>0),
  scope_generation bigint not null check (scope_generation>0),
  branch_generation bigint not null check (branch_generation>0),
  request jsonb,
  fingerprint text not null,
  created_by_client_id uuid,
  status text not null check (status in ('queued','running','settled','canceled')),
  primary key (task_id,input_id),
  unique (task_id,admission_seq),
  unique (instance_id,run_id),
  foreign key (task_id,instance_id) references public.design_task_executions(task_id,instance_id) on delete cascade,
  check ((status in ('queued','running'))=(request is not null))
);
create index design_task_inputs_fifo on public.design_task_inputs(task_id,admission_seq) where status='queued';
