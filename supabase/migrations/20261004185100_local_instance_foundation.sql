-- 本地实例与客户端接入：不创建账户、成员、角色或订阅。
create table public.local_instances (
  id uuid primary key,
  singleton boolean not null default true unique check (singleton),
  created_at timestamptz not null default now()
);

create table public.local_access_clients (
  id uuid primary key,
  instance_id uuid not null references public.local_instances(id) on delete cascade,
  kind text not null check (kind in ('desktop', 'browser', 'api')),
  label text not null,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz
);

create index local_access_clients_instance on public.local_access_clients(instance_id);
