-- 媒体连接使用不可变修订，凭据仅保存文件引用；标准聊天连接继续由原表持有。
create table public.media_driver_connections (
  id uuid primary key,
  instance_id uuid not null references public.local_instances(id) on delete cascade,
  installation_id uuid not null,
  driver_id text not null,
  provider_id uuid not null references public.provider_instances(id) on delete cascade,
  driver_version_id uuid not null,
  revision bigint not null check (revision > 0),
  config_values jsonb not null check (jsonb_typeof(config_values) = 'object'),
  secret_keys jsonb not null check (jsonb_typeof(secret_keys) = 'array'),
  credential_origins jsonb not null check (jsonb_typeof(credential_origins) = 'array'),
  credential_digest text not null check (credential_digest ~ '^[a-f0-9]{64}$'),
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  unique(instance_id,installation_id,provider_id,revision),
  foreign key(instance_id,installation_id)
    references public.media_driver_registry(instance_id,installation_id) on delete cascade,
  foreign key(instance_id,driver_id,driver_version_id)
    references public.media_driver_versions(instance_id,driver_id,id) on delete cascade
);
