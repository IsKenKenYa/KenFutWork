-- R5-3：权限的「分场景 + 第 4 档自定义配置」，R5-4：浏览器控制开关。
--
-- 另外要把既有 permission_tier 的 CHECK 放宽到含 'custom'（第 4 档）。
--
-- 三条都是**实例级**配置（与本机有关：自动化档位、审批规则、能不能让 agent 打网页），
-- 故与本表既有的 permission_tier 一样落在 app_config 单行表，不挂工作区。
ALTER TABLE public.app_config
  DROP CONSTRAINT IF EXISTS app_config_permission_tier_check;

ALTER TABLE public.app_config
  ADD CONSTRAINT app_config_permission_tier_check
  CHECK (permission_tier IS NULL OR permission_tier IN ('default', 'auto-approve', 'full-access', 'custom'));

ALTER TABLE public.app_config
  ADD COLUMN automation_permission_tier text NOT NULL DEFAULT 'default';

-- 档位是封闭集合（与 packages/shared 的 permissionTierSchema 同一口径）：
-- default / auto-approve / full-access / custom（custom = 按 permission_rules 判）
ALTER TABLE public.app_config
  ADD CONSTRAINT app_config_automation_tier_check
  CHECK (automation_permission_tier IN ('default', 'auto-approve', 'full-access', 'custom'));

-- 自定义配置的规则表：{"deny": ["mcp__*"], "allow": ["write_file"]}
-- 判定顺序 deny → allow → default 档兜底（拒绝优先）。
ALTER TABLE public.app_config
  ADD COLUMN permission_rules jsonb NOT NULL DEFAULT '{"allow": [], "deny": []}'::jsonb;

ALTER TABLE public.app_config
  ADD CONSTRAINT app_config_permission_rules_shape
  CHECK (
    jsonb_typeof(permission_rules) = 'object'
    AND jsonb_typeof(coalesce(permission_rules->'allow', '[]'::jsonb)) = 'array'
    AND jsonb_typeof(coalesce(permission_rules->'deny', '[]'::jsonb)) = 'array'
  );

-- 浏览器控制（R5-4「允许 AI 控制浏览器」）：关着的时候 browser_open 工具会**如实拒绝**
-- 并说明去哪打开，而不是把工具悄悄摘掉（摘掉会让模型以为这个能力不存在）。
ALTER TABLE public.app_config
  ADD COLUMN browser_control_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.app_config.automation_permission_tier IS
  'Permission tier used by unattended runs (goal/loop execution modes).';
COMMENT ON COLUMN public.app_config.permission_rules IS
  'Custom-tier rules: {deny: string[], allow: string[]} with trailing-* prefixes.';
COMMENT ON COLUMN public.app_config.browser_control_enabled IS
  'Whether the agent may fetch pages with browser_open (settings -> browser).';
