-- 审计中心（参考 WorkBuddy 安全中心）——记录权限判定的放行 / 拦截流水。
--
-- 为什么单表而不是复用日志文件：用户要能「导出与清空」，且条目必须能按时间与
-- 工具名检索。日志文件做不到按行删除，也会在应用日志轮转时丢证据。
--
-- 保留策略：只保留最近 5000 条（服务端写入时按上限裁剪），不设时间窗口——
-- 用户查的通常是「刚才那次为什么被拦」。
--
-- 记录内容刻意**不含**工具参数原文：参数里可能带文件内容、命令与凭据，
-- 审计只需回答「哪个工具、什么动作、为什么」，不复制一次敏感数据。
CREATE TABLE public.permission_audit_entries (
  id bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  tool_name text NOT NULL,
  -- allow / deny：策略最终给出的结论。
  decision text NOT NULL CHECK (decision IN ('allow', 'deny')),
  -- 命中来源：disabled / tool-rule / path-rule / command-rule / domain-rule /
  -- tier / approval-memory / approval；未命中级联时为空（放行即「无规则命中」）。
  source text,
  -- 是否硬拒绝（不给审批机会）；false 的 deny 表示「需审批」。
  blocked boolean NOT NULL DEFAULT false,
  reason text
);

CREATE INDEX permission_audit_entries_occurred_at_idx
  ON public.permission_audit_entries (occurred_at DESC);

COMMENT ON TABLE public.permission_audit_entries IS
  'Permission decision audit log (settings -> permissions -> audit center): tool name, allow/deny, which policy rule matched and the human-readable reason. Deliberately stores no tool arguments (they may contain file contents, commands or credentials).';
