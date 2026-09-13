-- =============================================================================
-- 供给前导 00000000000001：把 Supabase 供给的对象物化成自管对象（§4.13 M2.1）
-- =============================================================================
--
-- 背景：历史迁移（`supabase/migrations/`）写于「跑在 Supabase 上」的前提，直接引用了
-- Supabase 供给的 schema / 扩展 / 角色 / 函数 / 表。空库重放（`migrate replay`）因此
-- 失败于第一条迁移（`schema "extensions" does not exist`）。
--
-- 本文件把那些对象建出来并**归我们自管**，使历史迁移可在空库上完整重放。
--
-- **写法约束（踩过的坑）**：无条件 `CREATE TABLE IF NOT EXISTS auth.users …` 在
-- Supabase 供给的库上会报 `permission denied for schema auth`——`auth`/`storage` 两个
-- schema 归 `supabase_admin` 所有，且 Postgres 对 `IF NOT EXISTS` 也**先查 schema 权限**
-- 再判存在性。故本文件每一步都是「先用 `to_regclass` / `pg_proc` / `pg_roles` 做**只读**
-- 存在性判定，缺席才 `EXECUTE` 建」：
--   · Supabase 供给过的库 → 全部命中「已存在」，整份脚本是只读 no-op（不碰别人的对象）；
--   · 空库 / 自管 Postgres（桌面捆绑、自托管纯 PG）→ 全部缺席，逐一建出来。
--
-- 之所以放在 `supabase/bootstrap/` 而不是 `supabase/migrations/`：不污染 Supabase CLI 的
-- 历史，也不进「去 Supabase 残留」统计口径（那衡量**耦合**，本文件是**物化**）。
-- 版本号用保留段 `000000000000NN`（14 位、数值上先于一切时间戳）。
--
-- **RLS 与 `auth.uid()` 的地位（FORM-9）**：目标态隔离由应用层强制（repository 单一入口），
-- 运行角色是表 owner、默认绕过 RLS。故这里物化的 `auth.uid()` 只让历史策略**能建出来**，
-- 不承担隔离职责；策略清扫、FK 改指自管账号表（`public.accounts`）、blob 缝替换
-- `storage.objects` 是后续 M2.1/M3 的工作。

-- ── 1. schema ───────────────────────────────────────────────────────────────
-- `create schema if not exists` 对已存在的 schema 不需要权限（实测通过）
create schema if not exists extensions;
create schema if not exists auth;
create schema if not exists storage;

-- ── 2. 扩展（历史迁移用 extensions.gen_random_uuid / extensions.moddatetime） ──
do $ext$
declare
  wanted text[] := array['pgcrypto', 'moddatetime'];
  ext_name text;
begin
  foreach ext_name in array wanted loop
    if not exists (select 1 from pg_extension where extname = ext_name) then
      execute format('create extension %I with schema extensions', ext_name);
    end if;
  end loop;
end
$ext$;

-- pgmq：自托管可装真扩展；桌面拿不到（FORM-2：Windows 无预编译，改走进程内队列），
-- 故缺扩展时物化一个**最小替身**，只保证 `pgmq.create(queue)` 与队列表存在，
-- 让历史的 `SELECT pgmq.create(...)` 可重放。桌面的队列语义由进程内队列承担。
do $pgmq$
begin
  if exists (select 1 from pg_available_extensions where name = 'pgmq') then
    if not exists (select 1 from pg_extension where extname = 'pgmq') then
      execute 'create extension pgmq';
    end if;
    return;
  end if;

  execute 'create schema if not exists pgmq';
  if not exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'pgmq' and p.proname = 'create'
  ) then
    execute $def$
      create function pgmq.create(queue_name text)
      returns void language plpgsql as $body$
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
      $body$
    $def$;
  end if;
end
$pgmq$;

-- ── 3. 角色（历史迁移大量 grant … to authenticated / anon / service_role） ────
do $roles$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated', 'service_role'] loop
    if not exists (select 1 from pg_roles where rolname = role_name) then
      if role_name = 'service_role' then
        execute 'create role service_role nologin noinherit bypassrls';
      else
        execute format('create role %I nologin noinherit', role_name);
      end if;
    end if;
  end loop;
end
$roles$;

-- ── 4. auth：账号表 + auth.uid() ────────────────────────────────────────────
-- 历史迁移只把 `auth.users(id)` 当 FK 目标，故这里是最小形状；
-- 自管账号表（邮箱 + 口令哈希 + 会话）与 FK 改指是 M1.4/M2.1 的后续工作。
do $auth_table$
begin
  if to_regclass('auth.users') is null then
    execute $def$
      create table auth.users (
        id uuid primary key default extensions.gen_random_uuid(),
        email text,
        raw_user_meta_data jsonb default '{}'::jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      comment on table auth.users is
        '供给前导物化的最小账号表（过渡期 FK 目标）；目标态账号表是 public.accounts（M1.4）。';
    $def$;
  end if;
end
$auth_table$;

-- 与 Supabase 同语义（从 `request.jwt.claims` 取 sub）。运行时不设置该 GUC，故返回 NULL
-- ——隔离不靠它（FORM-9：应用层 repository 强制 workspace 谓词）。
do $uid$
begin
  if not exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'auth' and p.proname = 'uid'
  ) then
    execute $def$
      create function auth.uid() returns uuid language sql stable as $body$
        select coalesce(
          nullif(current_setting('request.jwt.claim.sub', true), ''),
          nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
        )::uuid
      $body$
    $def$;
  end if;
end
$uid$;

-- ── 5. storage：桶表 + 对象表 + foldername() ────────────────────────────────
-- 目标态对象存储走 blob 缝（M3：本地 FS / MinIO），这两张表届时退役。
do $storage$
begin
  if to_regclass('storage.buckets') is null then
    execute $def$
      create table storage.buckets (
        id text primary key,
        name text not null,
        owner uuid,
        public boolean default false,
        avif_autodetection boolean default false,
        file_size_limit bigint,
        allowed_mime_types text[],
        created_at timestamptz default now(),
        updated_at timestamptz default now()
      );
    $def$;
  end if;

  if to_regclass('storage.objects') is null then
    execute $def$
      create table storage.objects (
        id uuid primary key default extensions.gen_random_uuid(),
        bucket_id text references storage.buckets (id),
        name text,
        owner uuid,
        created_at timestamptz default now(),
        updated_at timestamptz default now(),
        last_accessed_at timestamptz default now(),
        metadata jsonb,
        path_tokens text[] generated always as (string_to_array(name, '/')) stored
      );
      alter table storage.objects enable row level security;
      alter table storage.buckets enable row level security;
    $def$;
  end if;

  -- `(storage.foldername(name))[1]` 取顶层目录（历史策略用它取工作区 id）
  if not exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'storage' and p.proname = 'foldername'
  ) then
    execute $def$
      create function storage.foldername(name text) returns text[] language plpgsql immutable as $body$
      declare
        parts text[];
      begin
        parts := string_to_array(name, '/');
        if array_length(parts, 1) is null then
          return array[]::text[];
        end if;
        return parts[1:array_length(parts, 1) - 1];
      end
      $body$
    $def$;
  end if;
end
$storage$;
