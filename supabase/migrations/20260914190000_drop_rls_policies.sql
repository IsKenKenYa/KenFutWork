-- =============================================================================
-- RLS 与策略清扫：数据库退出隔离职责（§4.13 M2.1；FORM-9）
-- =============================================================================
--
-- `FORM-9` 已拍板：隔离由**应用层**强制（repository 单一入口，workspace 谓词写进语句），
-- DB 层不再保留 RLS 兜底。故本迁移把所有策略删掉——它们建立在两个已经不存在的前提上：
--   ① `auth.uid()`（Supabase GoTrue 注入 JWT claim，M1.5 删 GoTrue 后**恒为 NULL**，
--      这类策略实际已在拒绝一切，只是我们的运行角色是 owner 才没暴露）；
--   ② `private.is_*` 判定函数（同样读 `auth.uid()`）。
--
-- **关键陷阱（必须同时处理）**：表上 `ENABLE ROW LEVEL SECURITY` + **没有任何策略**
-- 时，**非 owner 角色读到 0 行**（PostgreSQL 默认拒绝）。只删策略不关 RLS，会让将来按
-- 《AGENTS.md》换用「无 DDL 运行角色」的部署**全表读空**——这是静默故障。故这里
-- 「删策略」与「关闭 RLS」必须一起做。
--
-- 保留不动：`anon`/`authenticated`/`service_role` 三个 NOLOGIN 角色与历史 GRANT——
-- 历史迁移在空库重放时会 GRANT 给它们，删角色会让重放失败；它们无法登录，且 RLS 已关，
-- 保留无风险。`storage.*` 表保留（历史迁移会写入桶定义），只清策略与 RLS。
--
-- 幂等：全部按目录遍历，「没有就跳过」。

-- ── 1. 删除 public / storage 上的全部策略 ──────────────────────────────────
do $policies$
declare p record;
begin
  for p in
    select schemaname, tablename, policyname
      from pg_policies
     where schemaname in ('public', 'storage')
  loop
    execute format(
      'drop policy %I on %I.%I',
      p.policyname, p.schemaname, p.tablename
    );
  end loop;
end
$policies$;

-- ── 2. 关闭 RLS（public / storage / langgraph）────────────────────────────
-- 不清空这一步，非 owner 运行角色会因「RLS 开着但无策略」读不到任何行。
do $disable$
declare t record;
begin
  for t in
    select schemaname, tablename
      from pg_tables
     where schemaname in ('public', 'storage', 'langgraph')
       and rowsecurity
  loop
    execute format(
      'alter table %I.%I disable row level security',
      t.schemaname, t.tablename
    );
  end loop;
end
$disable$;

-- ── 3. 删掉只为策略/触发器存在的函数 ──────────────────────────────────────
-- 3a. private 的策略判定辅助函数（只被上面删掉的策略引用）
do $private$
declare f record;
begin
  for f in
    select p.proname, pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'private'
       and p.proname in (
         'is_workspace_member',
         'is_workspace_owner',
         'is_workspace_admin_or_owner',
         'is_project_member',
         'is_project_admin_or_owner',
         'asset_object_project_matches_workspace',
         'try_parse_uuid'
       )
  loop
    execute format('drop function if exists private.%I(%s) cascade', f.proname, f.args);
  end loop;

  -- 3b. Supabase 时代的引导/约束函数：TS 侧已自管（viewer 引导 + 仅改 display_name），
  --     没有任何调用方；一并删除以免留下「两套引导」的错觉。
  for f in
    select p.proname, pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'private'
       and p.proname in ('bootstrap_user_foundation', 'prevent_profile_email_change')
  loop
    execute format('drop function if exists private.%I(%s) cascade', f.proname, f.args);
  end loop;
end
$private$;

-- ── 4. 删掉依赖 auth.uid() 的公有 RPC 与 auth.uid() 本身 ────────────────────
-- `create_project_with_canvas` 依赖 `auth.uid()`，M1.3 起建项目改由应用层显式事务完成，
-- 已无调用方（全仓 grep 为 0）。`auth.uid()` 至此只剩「被策略引用」这一用途，策略已删。
-- 按目录取签名删除（不写死参数列表，避免签名漂移导致漏删）
do $rpc$
declare f record;
begin
  for f in
    select p.proname, pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'create_project_with_canvas'
  loop
    execute format(
      'drop function if exists public.%I(%s) cascade', f.proname, f.args
    );
  end loop;
end
$rpc$;
do $authuid$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'auth' and p.proname = 'uid'
  ) then
    execute 'drop function auth.uid() cascade';
  end if;
end
$authuid$;
