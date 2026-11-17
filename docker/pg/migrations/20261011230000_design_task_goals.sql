-- Design Task Goal consumer: forward migration; published migrations remain immutable.
create table public.design_task_goals (
  task_id uuid primary key,
  instance_id uuid not null,
  project_id uuid not null,
  task_kind text not null default 'design' check(task_kind='design'),
  state jsonb not null check(jsonb_typeof(state)='object'),
  owner_client_id uuid not null references public.local_access_clients(id),
  observed_at timestamptz not null default now(),
  unique(task_id,instance_id),
  foreign key(instance_id,task_id,project_id,task_kind)
    references public.execution_task_owners(instance_id,task_id,project_id,task_kind) on delete cascade
);
create table public.design_goal_evidence (
  task_id uuid not null,
  instance_id uuid not null,
  run_id text not null,
  source_id text not null,
  kind text not null check(kind in('toolCall','assistantText')),
  tool_name text,
  input jsonb,
  detail text not null default '',
  status text not null default 'pending' check(status in('pending','success','error','cancelled')),
  primary key(task_id,source_id),
  foreign key(task_id,instance_id) references public.design_task_goals(task_id,instance_id) on delete cascade
);
alter table public.design_task_inputs add column input_origin text not null default 'userInput'
  check(input_origin in('userInput','backgroundResult','goalContinuation'));
alter table public.design_task_inputs add column goal_fence jsonb;
