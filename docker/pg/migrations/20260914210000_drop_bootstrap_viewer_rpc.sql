-- Migration: 20260914210000_drop_bootstrap_viewer_rpc
-- 删除 public.bootstrap_viewer。
--
-- 理由：该 RPC 只是 private.bootstrap_user_foundation 的薄包装，跨 schema 调用；
-- 前者已在 20260914190000 中删除，导致 PL/pgSQL 运行期才报
-- 「function private.bootstrap_user_foundation(uuid, text, jsonb) does not exist」，
-- /api/viewer 全量 500。引导写路径改由应用层单事务完成
-- （apps/server/src/features/bootstrap/repository.ts 的 bootstrap），
-- 与 M1.3 起建项目由应用层显式事务接管同一口径：DB 函数不再承载业务编排，
-- 也就不再存在「DROP 私有函数时漏掉跨 schema 调用方」这类隐藏耦合。
--
-- 前置校验：确认全库已无其它函数体引用 bootstrap_viewer；有则中止（fail loud），
-- 避免重演本次事故。

do $$
declare
  v_callers text;
begin
  select string_agg(format('%s.%s', n.nspname, p.proname), ', ')
    into v_callers
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where p.proname <> 'bootstrap_viewer'
     and p.prosrc ~ 'bootstrap_viewer';

  if v_callers is not null then
    raise exception '仍有函数引用 bootstrap_viewer，不能删除：%', v_callers;
  end if;

  if to_regprocedure('public.bootstrap_viewer(uuid, text, jsonb)') is null then
    raise notice 'public.bootstrap_viewer 不存在，跳过';
    return;
  end if;

  drop function public.bootstrap_viewer(uuid, text, jsonb);
end;
$$;
