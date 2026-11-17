-- Code UI 原 V4 会话：仅新增调试期新会话，不转换历史 content_blocks。
create table public.code_ui_sessions (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  canvas_id uuid not null references public.canvases(id) on delete cascade,
  chat_session_id uuid references public.chat_sessions(id) on delete set null,
  root_session_id uuid not null references public.code_ui_sessions(id) on delete cascade,
  parent_session_id uuid references public.code_ui_sessions(id) on delete cascade,
  parent_tool_call_id text,
  state jsonb,
  revision bigint not null default 0 check (revision >= 0),
  active_run_id uuid,
  archived boolean not null default false,
  pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (state is null or jsonb_typeof(state) = 'object'),
  check (parent_session_id is null or parent_session_id <> id)
);
create index code_ui_sessions_workspace_root on public.code_ui_sessions(workspace_id, root_session_id);
create unique index code_ui_sessions_dispatch on public.code_ui_sessions(parent_session_id, parent_tool_call_id)
  where parent_session_id is not null and deleted_at is null;

-- seq 由服务端在锁定根会话的事务内产生；同一事件键只允许同参重放。
create table public.code_ui_events (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  root_session_id uuid not null references public.code_ui_sessions(id) on delete cascade,
  seq bigint not null check (seq > 0),
  event_key text not null,
  parameter_fingerprint text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (root_session_id, seq),
  unique (root_session_id, event_key)
);

create table public.code_ui_commands (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  client_id text not null,
  command_id text not null,
  session_id uuid references public.code_ui_sessions(id) on delete cascade,
  parameter_fingerprint text,
  ack jsonb,
  status text not null check (status in ('pending', 'accepted', 'failed', 'deleted')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, client_id, command_id)
);

create table public.code_ui_outputs (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  root_session_id uuid not null references public.code_ui_sessions(id) on delete cascade,
  contents text not null,
  created_at timestamptz not null default now()
);

comment on table public.code_ui_sessions is 'Code UI 权威会话聚合；删除墓碑仅保留不透明身份与作用域，state/派发元信息应清空';
comment on table public.code_ui_events is 'Code UI 有序、幂等事件日志；软删除会话时同事务删除内容';
comment on table public.code_ui_commands is '工作区+clientId+commandId 为客户端生成的稳定命令键；删除时清空参数指纹与应答';
