-- pgmq 兼容 shim（仅开发用）：历史迁移只调用 pgmq.create(queue)，这里提供等价物——
-- 建队列表 q_<queue> 与归档表 a_<queue>。**不含 send/read/...**：本地开发走进程内队列。
create function pgmq.create(queue_name text)
returns void
language plpgsql
as $$
begin
  execute format(
    'create table if not exists pgmq.%I (
       msg_id bigint generated always as identity primary key,
       read_ct integer not null default 0,
       enqueued_at timestamptz not null default now(),
       vt timestamptz not null default now(),
       message jsonb
     )',
    'q_' || queue_name
  );
  execute format(
    'create table if not exists pgmq.%I (
       msg_id bigint primary key,
       read_ct integer not null default 0,
       enqueued_at timestamptz not null default now(),
       archived_at timestamptz not null default now(),
       vt timestamptz not null default now(),
       message jsonb
     )',
    'a_' || queue_name
  );
end
$$;
