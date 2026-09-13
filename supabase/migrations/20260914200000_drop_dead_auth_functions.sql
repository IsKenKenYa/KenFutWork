-- =============================================================================
-- 删除两个已死的 Supabase 时代函数（§4.13 M2.1 收尾）
-- =============================================================================
--
-- 它们在本轮的策略/触发器清扫后**已无任何引用**，且函数体引用的是已删除的对象
-- （`auth.users` 触发器语义、`private.bootstrap_user_foundation`），留着是隐患：
-- 一旦有人重新挂上触发器，就会在运行时炸。
--
--   · `public.handle_new_user`    —— `on_auth_user_created` 的触发器函数（触发器已随
--     `auth.users` 表删除一并移除）；引导逻辑现由 TS 侧 `ViewerRepository.bootstrap` 承担。
--   · `public.is_platform_admin`  —— 平台管理员判定；现由 `public.admin_users_overview` +
--     服务层 `AdminService.isAdmin` 承担（HTTP 层管理员门是权威边界）。
--
-- 安全前提由 SQL 自身校验：若仍有触发器或其它函数引用它们，直接 raise 而不是静默删除。

do $drop_dead$
declare
  f record;
  dependent_triggers text;
begin
  for f in
    select p.proname, pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('handle_new_user', 'is_platform_admin')
  loop
    select string_agg(format('%s.%s', c.relname, t.tgname), ', ')
      into dependent_triggers
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_proc p on p.oid = t.tgfoid
     where p.proname = f.proname
       and not t.tgisinternal;

    if dependent_triggers is not null then
      raise exception
        '函数 public.% 仍被触发器引用（%），不能删除',
        f.proname, dependent_triggers;
    end if;

    execute format('drop function if exists public.%I(%s) cascade', f.proname, f.args);
  end loop;
end
$drop_dead$;
