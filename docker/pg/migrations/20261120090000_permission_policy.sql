-- 工具策略：三态规则表 + 禁用清单（参考 WorkBuddy 安全中心的工具管控）。
--
-- 为什么单列一列而不是复用 permission_rules：
-- 既有 `permission_rules`（allow / deny 两张表）的语义是「命中 deny 表 = 需审批」，
-- 没有「硬拒绝」的表达力。三态规则（allow / ask / deny）需要区分「问一下」与「一律不给」，
-- 因此独立成列，旧列的判定保持不变（向后兼容，已有数据无需迁移）。
--
-- 结构：{"rules": [{"pattern": "mcp__*", "action": "deny"}], "disabledTools": ["shell_*"]}
-- 判定顺序：禁用清单（硬拒绝） → 三态规则按表内顺序取第一条命中 → 档位判定。
-- 与档位正交：完全访问放开的是审批，不放开这里被禁用的工具。
ALTER TABLE public.app_config
  ADD COLUMN permission_policy jsonb NOT NULL
    DEFAULT '{"rules": [], "disabledTools": []}'::jsonb;

COMMENT ON COLUMN public.app_config.permission_policy IS
  'Tool policy: three-state rules (allow/ask/deny) plus a disabled-tool list, evaluated before the tier. Disabled tools are hard-denied even under full access (settings -> permissions -> tool control).';
