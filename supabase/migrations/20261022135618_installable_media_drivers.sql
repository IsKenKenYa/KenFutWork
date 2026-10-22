-- 媒体供应商的安装代际、不可变版本及稳定操作回执；源码仍位于应用数据目录。
create table public.media_driver_registry (
  instance_id uuid not null references public.local_instances(id) on delete cascade,
  driver_id text not null check (driver_id ~ '^[a-z][a-z0-9-]*$'),
  generation bigint not null check (generation > 0),
  revision bigint not null check (revision >= 0),
  enabled boolean not null,
  current_version uuid,
  deleted_at timestamptz,
  primary key (instance_id, driver_id),
  check (
    (deleted_at is null and current_version is not null and revision > 0)
    or (deleted_at is not null and current_version is null and revision = 0 and not enabled)
  )
);

create table public.media_driver_versions (
  instance_id uuid not null references public.local_instances(id) on delete cascade,
  driver_id text not null,
  id uuid not null,
  generation bigint not null check (generation > 0),
  revision bigint not null check (revision > 0),
  source_digest text not null check (source_digest ~ '^[a-f0-9]{64}$'),
  compiled_digest text not null check (compiled_digest ~ '^[a-f0-9]{64}$'),
  source_bytes bigint not null check (source_bytes > 0),
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object'),
  methods jsonb not null check (jsonb_typeof(methods) = 'array'),
  approved_origins jsonb not null check (jsonb_typeof(approved_origins) = 'array'),
  created_at timestamptz not null default now(),
  primary key (instance_id, driver_id, id),
  unique (instance_id, driver_id, generation, revision),
  foreign key (instance_id, driver_id)
    references public.media_driver_registry(instance_id, driver_id) on delete cascade
);

alter table public.media_driver_registry
  add constraint media_driver_current_version_fk
  foreign key (instance_id, driver_id, current_version)
  references public.media_driver_versions(instance_id, driver_id, id)
  deferrable initially deferred;

create table public.media_driver_operations (
  instance_id uuid not null references public.local_instances(id) on delete cascade,
  driver_id text not null,
  generation bigint not null check (generation >= 0),
  expected_revision bigint not null check (expected_revision >= 0),
  kind text not null check (kind in ('install', 'update', 'enabled', 'remove')),
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  receipt jsonb not null check (jsonb_typeof(receipt) = 'object'),
  primary key (instance_id, driver_id, generation, expected_revision, kind),
  foreign key (instance_id, driver_id)
    references public.media_driver_registry(instance_id, driver_id) on delete cascade
);
