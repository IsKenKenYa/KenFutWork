-- =============================================================================
-- 自管账号表：public.accounts 取代 auth.users（§4.13 M2.1 中性化）
-- =============================================================================
--
-- 背景：`auth.users` 是 Supabase Auth（GoTrue）的表，13 张业务表 + 自管认证的
-- `account_credentials`/`account_sessions` 共 15 张表把它当 FK 目标。自管认证（M1.4）
-- 之后应用已不再依赖 GoTrue，但表名/表结构仍是 Supabase 形状（RLS 表达式 `auth.uid()`、
-- `auth.users` 触发器都在这个前提上建立）。
--
-- 本迁移把账号**数据与归属**搬到 `public.accounts`：
--   1. 建 `public.accounts`（id/email/raw_user_meta_data/时间戳），从 auth.users 回填；
--   2. **按目录泛化重指全部外键**（遍历 pg_constraint，不写死约束名）：
--      逐个 drop 后以相同删除动作（cascade / set null / …）重建到 public.accounts；
--      遇到**复合外键**指向 auth.users 时直接 raise（未预期的形状必须显式暴露，
--      而不是静默跳过留下悬空归属）；
--   3. `auth.users` 改为 `public.accounts` 上的**可更新视图**：读兼容、写入自动落到
--      accounts（PostgreSQL 单表视图自动可更新），故不会出现「两张账号表漂移」。
--
-- 幂等：全部步骤都是「先查存在性再动」；重复执行为 no-op（`drop constraint` 用目录值，
-- 视图用 `create or replace`）。

-- ── 1. 账号表 ──────────────────────────────────────────────────────────────
create table if not exists public.accounts (
  id uuid primary key default extensions.gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.accounts is
  '自管账号表（M2.1）：取代 Supabase 的 auth.users；auth.users 现在是它的可更新视图。';

-- 邮箱登录要按 lower(email) 精确查；不建唯一约束（存量可能有仅大小写不同的历史行），
-- 查重放在服务层（注册前先查存在性）。
create index if not exists accounts_lower_email_idx
  on public.accounts (lower(email::text));

-- ── 2. 回填 ────────────────────────────────────────────────────────────────
do $backfill$
begin
  if to_regclass('auth.users') is null then
    return;
  end if;
  -- auth.users 已是视图（重复执行/重放尾部）时无需回填
  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'auth' and c.relname = 'users' and c.relkind = 'v'
  ) then
    return;
  end if;

  insert into public.accounts (id, email, raw_user_meta_data, created_at, updated_at)
  select u.id,
         u.email,
         coalesce(u.raw_user_meta_data, '{}'::jsonb),
         coalesce(u.created_at, now()),
         coalesce(u.updated_at, now())
    from auth.users u
  on conflict (id) do nothing;
end
$backfill$;

-- ── 3. 外键重指（按目录泛化） ──────────────────────────────────────────────
do $repoint$
declare
  fk record;
  action text;
begin
  if to_regclass('auth.users') is null then
    return;
  end if;
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'auth' and c.relname = 'users' and c.relkind = 'r'
  ) then
    -- 已是视图：外键不存在，无需重指
    return;
  end if;

  for fk in
    select c.conname,
           c.conrelid::regclass as tbl,
           c.confdeltype,
           array_length(c.conkey, 1) as ncols,
           (select string_agg(quote_ident(a.attname), ', ' order by u.ord)
              from unnest(c.conkey) with ordinality as u(attnum, ord)
              join pg_attribute a
                on a.attrelid = c.conrelid and a.attnum = u.attnum) as cols
      from pg_constraint c
     where c.contype = 'f'
       and c.confrelid = 'auth.users'::regclass
  loop
    if fk.ncols <> 1 then
      raise exception
        '复合外键指向 auth.users（未预期形状，需人工确认）：%.%',
        fk.tbl, fk.conname;
    end if;

    action := case fk.confdeltype
                when 'c' then 'on delete cascade'
                when 'n' then 'on delete set null'
                when 'd' then 'on delete set default'
                when 'r' then 'on delete restrict'
                else ''
              end;

    execute format('alter table %s drop constraint %I', fk.tbl, fk.conname);
    execute format(
      'alter table %s add constraint %I foreign key (%s) references public.accounts (id) %s',
      fk.tbl, fk.conname, fk.cols, action
    );
  end loop;
end
$repoint$;

-- ── 4. auth.users → 可更新视图 ─────────────────────────────────────────────
do $to_view$
begin
  if to_regclass('auth.users') is null then
    return;
  end if;
  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'auth' and c.relname = 'users' and c.relkind = 'v'
  ) then
    return;
  end if;

  -- 先删 `on_auth_user_created` 等依赖触发器（Supabase 遗产），再删表建视图
  execute 'drop table if exists auth.users cascade';
  execute $view$
    create view auth.users as
      select id, email, raw_user_meta_data, created_at, updated_at
        from public.accounts
  $view$;
end
$to_view$;

comment on view auth.users is
  '兼容视图（M2.1）：读写都落到 public.accounts；新代码请直接用 public.accounts。';
