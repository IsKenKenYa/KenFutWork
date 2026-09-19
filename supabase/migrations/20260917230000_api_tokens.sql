-- 外部应用访问令牌（R5-2「外部应用授权」条目）。
--
-- 参考图里这一页是「把账号授权给外部应用」。本产品的诚实对应物是**个人访问令牌**：
-- 外部应用 / 脚本 / CI 拿它调本服务的 HTTP API，权限与登录会话同源（同一个工作区隔离）。
--
-- 红线（与 BYOK 凭证同族）：
--   1. **只写不读**：明文只在创建响应里回一次，库里只存 sha256；
--   2. 可即时吊销（`revoked_at`），吊销后下一次请求就失效（不做宽限窗口）；
--   3. **令牌不能签发令牌**：创建/列出/吊销三个端点只认会话令牌（防止一把泄漏的令牌永久续命）；
--   4. 记录 `last_used_at` 供用户在界面上判断「这把还在用吗」，不记来源 IP。
create table if not exists public.api_tokens (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references public.accounts(id) on delete cascade,
  name text not null,
  token_hash text not null unique,
  -- 前 12 位（`kfw_` + 8 位）供界面辨认，不足以还原明文
  token_prefix text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index if not exists api_tokens_workspace_created_idx
  on public.api_tokens(workspace_id, created_at desc);

comment on table public.api_tokens is
  '外部应用访问令牌：只存 sha256、明文只回一次；可即时吊销；不能签发令牌';
