-- =============================================================================
-- 管理后台汇总查询（FORM-10：统一管理）
-- =============================================================================
-- 目的：后台一次拉齐「用户 + 归属工作区 + 套餐 + 额度 + 用量汇总」，
-- 避免把 usage_records 全量行拉进 Node 内存做聚合（行数随使用线性增长）。
-- 仅供服务端（service_role）调用，不对登录用户开放。
-- =============================================================================

CREATE OR REPLACE FUNCTION public.admin_users_overview()
RETURNS TABLE (
  user_id uuid,
  email text,
  display_name text,
  role text,
  workspace_id uuid,
  plan public.subscription_plan,
  balance integer,
  total_tokens bigint,
  cost_usd numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    p.id,
    p.email,
    p.display_name,
    p.role,
    w.id,
    COALESCE(s.plan, 'free')::public.subscription_plan,
    COALESCE(cb.balance, 0),
    COALESCE(u.total_tokens, 0)::bigint,
    COALESCE(u.cost_usd, 0)::numeric
  FROM public.profiles p
  LEFT JOIN public.workspaces w
    ON w.owner_user_id = p.id AND w.type = 'personal'
  LEFT JOIN public.subscriptions s
    ON s.workspace_id = w.id
  LEFT JOIN public.credit_balances cb
    ON cb.workspace_id = w.id
  LEFT JOIN (
    SELECT
      r.workspace_id,
      SUM(COALESCE(r.total_tokens, 0)) AS total_tokens,
      SUM(COALESCE(r.cost_usd, 0)) AS cost_usd
    FROM public.usage_records r
    GROUP BY r.workspace_id
  ) u ON u.workspace_id = w.id
  ORDER BY p.created_at ASC;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_users_overview() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_users_overview() TO service_role;
