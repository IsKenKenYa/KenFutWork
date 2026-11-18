-- =============================================================================
-- 平台管理：管理员角色 + 系统供应商池 + 平台池计费
-- =============================================================================
-- 背景（FORM-10 范围修正）：管理后台需要「配置系统供应商 / API Key 并分发给
-- 用户」与「计费（限制额度）」。本迁移提供三件基础设施：
--   1) 平台管理员标记（profiles.role）与判定函数 is_platform_admin()
--   2) provider_instances.scope：'workspace'（BYOK，默认）| 'system'（平台池）
--      system 行 workspace_id 为 NULL，对全体登录用户只读可发现
--   3) 平台池计费所需：usage_records.user_id + chat_deduct 交易类型 +
--      deduct_chat_credits / admin_adjust_credits 两个 RPC
--
-- 安全说明：SECURITY DEFINER 函数默认对 PUBLIC 开放 EXECUTE，本迁移对
-- admin_adjust_credits（可凭空发分）与 deduct_chat_credits 显式收回，
-- 只授予 service_role（应用侧 admin client）；并顺带收紧既有 deduct_credits /
-- refund_credits / claim_daily_credits / grant_plan_credits——它们此前对
-- authenticated 开放，可跨工作区操作余额（存量漏洞）。
-- =============================================================================

-- ── 1. 平台管理员标记 ────────────────────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user';

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check CHECK (role IN ('user', 'admin'));

-- ── 2. 平台管理员判定（供 RLS 与路由复用）───────────────────
CREATE OR REPLACE FUNCTION public.is_platform_admin(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = p_user_id AND p.role = 'admin'
  );
$$;

-- ── 3. 系统供应商池 ──────────────────────────────────────────
ALTER TABLE public.provider_instances
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'workspace';

ALTER TABLE public.provider_instances DROP CONSTRAINT IF EXISTS provider_instances_scope_check;
ALTER TABLE public.provider_instances
  ADD CONSTRAINT provider_instances_scope_check CHECK (scope IN ('workspace', 'system'));

-- 平台池行没有归属工作区
ALTER TABLE public.provider_instances ALTER COLUMN workspace_id DROP NOT NULL;

ALTER TABLE public.provider_instances DROP CONSTRAINT IF EXISTS provider_instances_scope_workspace_chk;
ALTER TABLE public.provider_instances
  ADD CONSTRAINT provider_instances_scope_workspace_chk CHECK (
    (scope = 'system' AND workspace_id IS NULL)
    OR (scope = 'workspace' AND workspace_id IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS provider_instances_scope_idx
  ON public.provider_instances (scope) WHERE scope = 'system';

-- 系统行：全体登录用户可读（仅启用的），用于「分发」到模型目录
DROP POLICY IF EXISTS provider_instances_select_system ON public.provider_instances;
CREATE POLICY provider_instances_select_system ON public.provider_instances
  FOR SELECT TO authenticated
  USING (scope = 'system' AND enabled = true);

-- 平台管理员对 provider_instances 全权（含系统行增删改）
DROP POLICY IF EXISTS provider_instances_admin_all ON public.provider_instances;
CREATE POLICY provider_instances_admin_all ON public.provider_instances
  FOR ALL TO authenticated
  USING (public.is_platform_admin(auth.uid()))
  WITH CHECK (public.is_platform_admin(auth.uid()));

-- ── 4. 用量按用户归属（管理后台「统一管理」需要）─────────────
ALTER TABLE public.usage_records
  ADD COLUMN IF NOT EXISTS user_id uuid;

CREATE INDEX IF NOT EXISTS usage_records_user_idx
  ON public.usage_records (user_id, occurred_at DESC);

-- ── 5. 平台池计费 ────────────────────────────────────────────
ALTER TYPE public.credit_transaction_type ADD VALUE IF NOT EXISTS 'chat_deduct';

-- 聊天（平台池）扣费：与 generation 扣费分离，账本可辨
CREATE OR REPLACE FUNCTION public.deduct_chat_credits(
  p_workspace_id uuid,
  p_user_id uuid,
  p_amount integer,
  p_run_id text,
  p_description text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance integer;
  v_new_balance integer;
  v_version integer;
  v_tx_id uuid;
BEGIN
  IF p_amount IS NULL OR p_amount < 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: chat deduction amount must be >= 0';
  END IF;

  SELECT balance, version INTO v_balance, v_version
  FROM public.credit_balances
  WHERE workspace_id = p_workspace_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_BALANCE: No credit balance found for workspace %', p_workspace_id;
  END IF;

  v_new_balance := v_balance - p_amount;

  IF v_new_balance < 0 THEN
    RAISE EXCEPTION 'INSUFFICIENT_CREDITS: have %, need %', v_balance, p_amount;
  END IF;

  UPDATE public.credit_balances
  SET balance = v_new_balance,
      version = v_version + 1,
      updated_at = now()
  WHERE workspace_id = p_workspace_id AND version = v_version;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONCURRENT_MODIFICATION: credit balance was modified concurrently';
  END IF;

  INSERT INTO public.credit_transactions
    (workspace_id, user_id, transaction_type, amount, balance_after, job_id, description, metadata)
  VALUES
    (p_workspace_id, p_user_id, 'chat_deduct', -p_amount, v_new_balance, NULL, p_description,
     jsonb_build_object('run_id', p_run_id))
  RETURNING id INTO v_tx_id;

  RETURN v_tx_id;
END;
$$;

-- 管理员手动调整（正数发放 / 负数扣减），走 admin_adjustment 台账
CREATE OR REPLACE FUNCTION public.admin_adjust_credits(
  p_workspace_id uuid,
  p_user_id uuid,
  p_amount integer,
  p_description text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance integer;
  v_new_balance integer;
  v_version integer;
  v_tx_id uuid;
BEGIN
  IF p_amount IS NULL OR p_amount = 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: adjustment amount must be non-zero';
  END IF;

  SELECT balance, version INTO v_balance, v_version
  FROM public.credit_balances
  WHERE workspace_id = p_workspace_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_BALANCE: No credit balance found for workspace %', p_workspace_id;
  END IF;

  v_new_balance := v_balance + p_amount;

  IF v_new_balance < 0 THEN
    RAISE EXCEPTION 'INSUFFICIENT_CREDITS: have %, cannot deduct %', v_balance, abs(p_amount);
  END IF;

  UPDATE public.credit_balances
  SET balance = v_new_balance,
      version = v_version + 1,
      updated_at = now()
  WHERE workspace_id = p_workspace_id AND version = v_version;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONCURRENT_MODIFICATION: credit balance was modified concurrently';
  END IF;

  INSERT INTO public.credit_transactions
    (workspace_id, user_id, transaction_type, amount, balance_after, job_id, description)
  VALUES
    (p_workspace_id, p_user_id, 'admin_adjustment', p_amount, v_new_balance, NULL, p_description)
  RETURNING id INTO v_tx_id;

  RETURN v_tx_id;
END;
$$;

-- ── 6. 权限收紧：这些 DEFINER 函数只允许服务端（service_role）调用 ──
REVOKE EXECUTE ON FUNCTION public.admin_adjust_credits(uuid, uuid, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_adjust_credits(uuid, uuid, integer, text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.deduct_chat_credits(uuid, uuid, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.deduct_chat_credits(uuid, uuid, integer, text, text) TO service_role;

-- 存量漏洞收口：这几支同样能改余额，不该对登录用户开放
REVOKE EXECUTE ON FUNCTION public.deduct_credits(uuid, uuid, integer, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.deduct_credits(uuid, uuid, integer, uuid, text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.refund_credits(uuid, uuid, integer, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_credits(uuid, uuid, integer, uuid, text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.grant_plan_credits(uuid, public.subscription_plan, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.grant_plan_credits(uuid, public.subscription_plan, integer) TO service_role;

REVOKE EXECUTE ON FUNCTION public.claim_daily_credits(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_daily_credits(uuid, integer) TO service_role;
