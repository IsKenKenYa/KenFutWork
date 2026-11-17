-- 前向修复 20260924140000 的 flow_settle_credits：OUT 参数与列名歧义。
--
-- 现象：`字段关联 "settled_amount" 是不明确的` —— `RETURNS TABLE(settled_amount integer ...)`
-- 的 OUT 参数在函数体内是变量，`SELECT id, amount, status, settled_amount INTO ... FROM
-- flow_credit_holds` 里的裸列名与它同名，plpgsql 直接报错。**每一次只带 hold 行的结算都会踩**，
-- 由真实库集成回归 `flow-billing.integration.test.ts` 抓到（空库重放只看 DDL，抓不到函数体问题）。
--
-- 修复：SELECT 列表用表别名限定（`h.settled_amount`），其余字段一并限定，消除歧义面。
-- 语义与 20260924140000 完全一致，只改 SQL 写法。

CREATE OR REPLACE FUNCTION public.flow_settle_credits(
  p_workspace_id uuid,
  p_user_id uuid,
  p_actual_cost integer,
  p_run_id text,
  p_remark text DEFAULT NULL
) RETURNS TABLE(tx_id uuid, settled_amount integer, uncovered_amount integer, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hold_id uuid;
  v_hold_amount integer;
  v_status text;
  v_settled integer;
  v_balance integer;
  v_reserved integer;
  v_version integer;
  v_apply integer;
  v_uncovered integer;
  v_new_balance integer;
  v_tx_id uuid;
BEGIN
  IF p_actual_cost IS NULL OR p_actual_cost < 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: settle amount must be >= 0';
  END IF;

  SELECT h.id, h.amount, h.status, h.settled_amount
    INTO v_hold_id, v_hold_amount, v_status, v_settled
  FROM public.flow_credit_holds h
  WHERE h.workspace_id = p_workspace_id AND h.run_id = p_run_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_HOLD: no flow credit hold for run % (reserve must run first)', p_run_id;
  END IF;

  -- 幂等：已结算 → 返回原结果（tx 由 business_key 定位）。
  IF v_status = 'settled' THEN
    SELECT ct.id INTO v_tx_id FROM public.credit_transactions ct
    WHERE ct.business_key = 'flow:' || p_run_id || ':settle';
    RETURN QUERY SELECT v_tx_id, COALESCE(v_settled, 0), 0, true;
    RETURN;
  END IF;

  IF v_status = 'released' THEN
    RAISE EXCEPTION 'HOLD_RELEASED: run % was refunded; a released hold cannot be settled', p_run_id;
  END IF;

  SELECT cb.balance, cb.reserved_balance, cb.version
    INTO v_balance, v_reserved, v_version
  FROM public.credit_balances cb
  WHERE cb.workspace_id = p_workspace_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_BALANCE: No credit balance found for workspace %', p_workspace_id;
  END IF;

  -- 冻结额即消费上限：超出部分不扣（balance 不允许负），如实回报 uncovered。
  v_apply := LEAST(p_actual_cost, v_hold_amount);
  v_uncovered := p_actual_cost - v_apply;
  v_new_balance := v_balance - v_apply;

  UPDATE public.credit_balances cb
  SET balance = v_new_balance,
      reserved_balance = GREATEST(cb.reserved_balance - v_hold_amount, 0),
      version = cb.version + 1,
      updated_at = now()
  WHERE cb.workspace_id = p_workspace_id AND cb.version = v_version;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONCURRENT_MODIFICATION: credit balance was modified concurrently';
  END IF;

  INSERT INTO public.credit_transactions
    (workspace_id, user_id, transaction_type, amount, balance_after, job_id, description, metadata, business_key)
  VALUES
    (p_workspace_id, p_user_id, 'flow_deduct', -v_apply, v_new_balance, NULL,
     COALESCE(p_remark, 'flow run 结算'),
     jsonb_build_object('run_id', p_run_id, 'hold_id', v_hold_id,
                        'frozen_amount', v_hold_amount, 'uncovered_amount', v_uncovered),
     'flow:' || p_run_id || ':settle')
  ON CONFLICT (business_key) WHERE business_key IS NOT NULL DO NOTHING
  RETURNING id INTO v_tx_id;

  -- 兜底：hold 还是 held 但流水已存在（异常历史）——回读原交易，不重复扣。
  IF v_tx_id IS NULL THEN
    SELECT ct.id INTO v_tx_id FROM public.credit_transactions ct
    WHERE ct.business_key = 'flow:' || p_run_id || ':settle';
  END IF;

  UPDATE public.flow_credit_holds h
  SET status = 'settled', settled_amount = v_apply, closed_at = now()
  WHERE h.id = v_hold_id;

  RETURN QUERY SELECT v_tx_id, v_apply, v_uncovered, false;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.flow_settle_credits(uuid, uuid, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.flow_settle_credits(uuid, uuid, integer, text, text) TO service_role;
