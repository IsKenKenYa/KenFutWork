-- flow 计费三段事务（《flow 集成方案》P4 / DEC-12 宿主态）
--
-- 目标：flow run 的三段事务（预扣 / 结算 / 退款）落到主仓 credits，**flow run id 作幂等键**。
-- 三条口径：
--   1) 幂等载体：`flow_credit_holds` 一行一 run（UNIQUE(workspace_id, run_id)）+
--      `credit_transactions.business_key` 部分唯一索引（`flow:<runId>:<op>`）——
--      同键重放返回原结果（replayed=true），不重复动账（AGENTS.md 持久副作用纪律）；
--   2) 原子性：每段是**一个库函数 = 一个事务**，余额（balance/reserved_balance）与
--      不可变流水同事务提交，余额行 FOR UPDATE + version 乐观锁；
--   3) 冻结额即**消费上限**：settle 实扣 min(actualCost, 冻结额)，超出部分在
--      uncovered_amount 里如实回报并留痕（balance 有 CHECK >= 0，不允许负余额）。
--
-- 账目口径：`reserved_balance`（冻结中）与 `balance` 都是钱；可用 = balance - reserved_balance。
-- reserve/refund 只动 reserved（流水 amount=0，释放额记在 metadata），settle 才动 balance
-- （流水 amount=-实扣额）。

-- ── 1. 余额表加冻结列 ────────────────────────────────────────
ALTER TABLE public.credit_balances
  ADD COLUMN reserved_balance integer NOT NULL DEFAULT 0 CHECK (reserved_balance >= 0);

COMMENT ON COLUMN public.credit_balances.reserved_balance IS
  'flow 三段事务的冻结额（预扣）；可用额度 = balance - reserved_balance。';

-- ── 2. 冻结台账（一次 run 一行；UNIQUE 即幂等载体） ─────────
CREATE TABLE public.flow_credit_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  run_id text NOT NULL,
  amount integer NOT NULL CHECK (amount >= 0),
  status text NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'settled', 'released')),
  settled_amount integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  UNIQUE (workspace_id, run_id)
);

COMMENT ON TABLE public.flow_credit_holds IS
  'flow run 的预扣冻结台账；UNIQUE(workspace_id, run_id) 是「同 run 重放不重复冻结」的载体。'
  ' 访问只经本迁移的 SECURITY DEFINER 函数（service_role）；不建 RLS——自管化后隔离'
  ' 由应用层 workspace 谓词强制（FORM-9），与 20260917 起的新表同约定。';

-- ── 3. 流水加业务幂等键 ─────────────────────────────────────
ALTER TABLE public.credit_transactions ADD COLUMN business_key text;

CREATE UNIQUE INDEX credit_transactions_business_key_unique
  ON public.credit_transactions (business_key)
  WHERE business_key IS NOT NULL;

COMMENT ON COLUMN public.credit_transactions.business_key IS
  '稳定业务交付键（如 flow:<runId>:<op>）；非空即唯一，重放不重复入账。';

-- ── 4. 流水类型：补 chat_deduct（DB 早有、契约缺失的历史缺口）与 flow 三型 ──
ALTER TYPE public.credit_transaction_type ADD VALUE IF NOT EXISTS 'chat_deduct';
ALTER TYPE public.credit_transaction_type ADD VALUE IF NOT EXISTS 'flow_reserve';
ALTER TYPE public.credit_transaction_type ADD VALUE IF NOT EXISTS 'flow_deduct';
ALTER TYPE public.credit_transaction_type ADD VALUE IF NOT EXISTS 'flow_refund';

-- ── 5. 预扣（reserve）：可用额度校验 + 冻结 ─────────────────
CREATE OR REPLACE FUNCTION public.flow_reserve_credits(
  p_workspace_id uuid,
  p_user_id uuid,
  p_amount integer,
  p_run_id text,
  p_description text DEFAULT NULL
) RETURNS TABLE(hold_id uuid, frozen_amount integer, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hold_id uuid;
  v_hold_amount integer;
  v_balance integer;
  v_reserved integer;
  v_version integer;
BEGIN
  IF p_amount IS NULL OR p_amount < 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: reserve amount must be >= 0';
  END IF;
  IF p_run_id IS NULL OR length(p_run_id) = 0 THEN
    RAISE EXCEPTION 'INVALID_RUN_ID: run id is required as the idempotency key';
  END IF;

  -- 幂等第一步：同 run 已有冻结 → 原样返回（不重复冻结）。
  -- ON CONFLICT DO NOTHING 而非先查后插：并发同键由唯一约束兜底，
  -- 冲突方拿到空返回再回读，不会因异常把整个事务掀掉。
  INSERT INTO public.flow_credit_holds (workspace_id, user_id, run_id, amount)
  VALUES (p_workspace_id, p_user_id, p_run_id, p_amount)
  ON CONFLICT (workspace_id, run_id) DO NOTHING
  RETURNING id INTO v_hold_id;

  IF v_hold_id IS NULL THEN
    SELECT id, amount INTO v_hold_id, v_hold_amount
    FROM public.flow_credit_holds
    WHERE workspace_id = p_workspace_id AND run_id = p_run_id;
    RETURN QUERY SELECT v_hold_id, v_hold_amount, true;
    RETURN;
  END IF;

  SELECT balance, reserved_balance, version INTO v_balance, v_reserved, v_version
  FROM public.credit_balances
  WHERE workspace_id = p_workspace_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_BALANCE: No credit balance found for workspace %', p_workspace_id;
  END IF;

  IF (v_balance - v_reserved) < p_amount THEN
    RAISE EXCEPTION 'INSUFFICIENT_CREDITS: have %, need %', (v_balance - v_reserved), p_amount;
  END IF;

  UPDATE public.credit_balances
  SET reserved_balance = v_reserved + p_amount,
      version = v_version + 1,
      updated_at = now()
  WHERE workspace_id = p_workspace_id AND version = v_version;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONCURRENT_MODIFICATION: credit balance was modified concurrently';
  END IF;

  -- 冻结也动账（reserved_balance），同事务留痕：amount=0（钱未离开余额），
  -- 冻结额记 metadata，便于对账。
  INSERT INTO public.credit_transactions
    (workspace_id, user_id, transaction_type, amount, balance_after, job_id, description, metadata, business_key)
  VALUES
    (p_workspace_id, p_user_id, 'flow_reserve', 0, v_balance, NULL,
     COALESCE(p_description, 'flow run 预扣冻结'),
     jsonb_build_object('run_id', p_run_id, 'hold_id', v_hold_id, 'frozen_amount', p_amount),
     'flow:' || p_run_id || ':reserve');

  RETURN QUERY SELECT v_hold_id, p_amount, false;
END;
$$;

-- ── 6. 结算（settle）：解冻 + 实扣（冻结额为上限） ──────────
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

  SELECT id, amount, status, settled_amount
    INTO v_hold_id, v_hold_amount, v_status, v_settled
  FROM public.flow_credit_holds
  WHERE workspace_id = p_workspace_id AND run_id = p_run_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_HOLD: no flow credit hold for run % (reserve must run first)', p_run_id;
  END IF;

  -- 幂等：已结算 → 返回原结果（tx 由 business_key 定位）。
  IF v_status = 'settled' THEN
    SELECT id INTO v_tx_id FROM public.credit_transactions
    WHERE business_key = 'flow:' || p_run_id || ':settle';
    RETURN QUERY SELECT v_tx_id, COALESCE(v_settled, 0), 0, true;
    RETURN;
  END IF;

  IF v_status = 'released' THEN
    RAISE EXCEPTION 'HOLD_RELEASED: run % was refunded; a released hold cannot be settled', p_run_id;
  END IF;

  SELECT balance, reserved_balance, version INTO v_balance, v_reserved, v_version
  FROM public.credit_balances
  WHERE workspace_id = p_workspace_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_BALANCE: No credit balance found for workspace %', p_workspace_id;
  END IF;

  -- 冻结额即消费上限：超出部分不扣（balance 不允许负），如实回报 uncovered。
  v_apply := LEAST(p_actual_cost, v_hold_amount);
  v_uncovered := p_actual_cost - v_apply;
  v_new_balance := v_balance - v_apply;

  UPDATE public.credit_balances
  SET balance = v_new_balance,
      reserved_balance = GREATEST(v_reserved - v_hold_amount, 0),
      version = v_version + 1,
      updated_at = now()
  WHERE workspace_id = p_workspace_id AND version = v_version;

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
    SELECT id INTO v_tx_id FROM public.credit_transactions
    WHERE business_key = 'flow:' || p_run_id || ':settle';
  END IF;

  UPDATE public.flow_credit_holds
  SET status = 'settled', settled_amount = v_apply, closed_at = now()
  WHERE id = v_hold_id;

  RETURN QUERY SELECT v_tx_id, v_apply, v_uncovered, false;
END;
$$;

-- ── 7. 退款（refund）：解冻（已结算的 run 不允许退款，需人工调整） ──
CREATE OR REPLACE FUNCTION public.flow_refund_credits(
  p_workspace_id uuid,
  p_user_id uuid,
  p_run_id text,
  p_description text DEFAULT NULL
) RETURNS TABLE(tx_id uuid, released_amount integer, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hold_id uuid;
  v_hold_amount integer;
  v_status text;
  v_balance integer;
  v_reserved integer;
  v_version integer;
  v_tx_id uuid;
BEGIN
  SELECT id, amount, status INTO v_hold_id, v_hold_amount, v_status
  FROM public.flow_credit_holds
  WHERE workspace_id = p_workspace_id AND run_id = p_run_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_HOLD: no flow credit hold for run % (reserve must run first)', p_run_id;
  END IF;

  -- 幂等：已退款 → 返回原结果。
  IF v_status = 'released' THEN
    SELECT id INTO v_tx_id FROM public.credit_transactions
    WHERE business_key = 'flow:' || p_run_id || ':refund';
    RETURN QUERY SELECT v_tx_id, v_hold_amount, true;
    RETURN;
  END IF;

  IF v_status = 'settled' THEN
    RAISE EXCEPTION 'HOLD_SETTLED: run % was settled; refunding settled charges is an admin adjustment', p_run_id;
  END IF;

  SELECT balance, reserved_balance, version INTO v_balance, v_reserved, v_version
  FROM public.credit_balances
  WHERE workspace_id = p_workspace_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_BALANCE: No credit balance found for workspace %', p_workspace_id;
  END IF;

  UPDATE public.credit_balances
  SET reserved_balance = GREATEST(v_reserved - v_hold_amount, 0),
      version = v_version + 1,
      updated_at = now()
  WHERE workspace_id = p_workspace_id AND version = v_version;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONCURRENT_MODIFICATION: credit balance was modified concurrently';
  END IF;

  INSERT INTO public.credit_transactions
    (workspace_id, user_id, transaction_type, amount, balance_after, job_id, description, metadata, business_key)
  VALUES
    (p_workspace_id, p_user_id, 'flow_refund', 0, v_balance, NULL,
     COALESCE(p_description, 'flow run 退款（释放冻结）'),
     jsonb_build_object('run_id', p_run_id, 'hold_id', v_hold_id, 'released_amount', v_hold_amount),
     'flow:' || p_run_id || ':refund')
  ON CONFLICT (business_key) WHERE business_key IS NOT NULL DO NOTHING
  RETURNING id INTO v_tx_id;

  IF v_tx_id IS NULL THEN
    SELECT id INTO v_tx_id FROM public.credit_transactions
    WHERE business_key = 'flow:' || p_run_id || ':refund';
  END IF;

  UPDATE public.flow_credit_holds
  SET status = 'released', closed_at = now()
  WHERE id = v_hold_id;

  RETURN QUERY SELECT v_tx_id, v_hold_amount, false;
END;
$$;

-- ── 8. 权限收紧：这三支同样能改余额，只允许服务端调用 ───────
REVOKE EXECUTE ON FUNCTION public.flow_reserve_credits(uuid, uuid, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.flow_reserve_credits(uuid, uuid, integer, text, text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.flow_settle_credits(uuid, uuid, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.flow_settle_credits(uuid, uuid, integer, text, text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.flow_refund_credits(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.flow_refund_credits(uuid, uuid, text, text) TO service_role;
