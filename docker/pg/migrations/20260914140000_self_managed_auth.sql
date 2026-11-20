-- =============================================================================
-- 自管认证：口令凭据 + 会话（§4.13 M1.4）
-- =============================================================================
--
-- 目标：不再依赖 Supabase Auth（GoTrue）签发的 JWT，改由本服务签发并校验**不透明会话令牌**。
--
-- 账号表沿用 `auth.users`：它已被供给前导物化为**我们自管的最小形状**
-- （id/email/raw_user_meta_data/created_at/updated_at），且 13 张业务表以它为 FK 目标
-- ——沿用可避免一次性改写全部外键（改名为 `public.accounts` 属纯命名整理，另做）。
--
-- 两张新表：
--   · `account_credentials`：口令哈希（scrypt，含参数与盐，见 `features/auth/password.ts`）
--   · `account_sessions`：会话令牌的 **SHA-256 哈希**（不落明文令牌——库被读走也无法冒充）
--
-- 隔离口径：这两张表是**身份建立之前**的数据访问（登录时还不知道用户是谁），故读写走
-- 根客户端而非 `:workspace`/`:user` 谓词；行本身以 `user_id` 归属，越权面靠「令牌不可猜 +
-- 只按令牌哈希精确匹配」控制，不做列表扫描。

create table if not exists public.account_credentials (
  user_id uuid primary key references auth.users (id) on delete cascade,
  -- 格式：scrypt$N$r$p$<salt-b64>$<hash-b64>（自描述，换参数不必迁移历史行）
  password_hash text not null,
  created_at timestamptz not null default now(),
  password_updated_at timestamptz not null default now()
);

comment on table public.account_credentials is
  '自管认证的用户口令凭据（scrypt）。不存在行 = 该账号未设口令（如仅由外部 IdP 创建）。';

create table if not exists public.account_sessions (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- 只存令牌的 SHA-256；明文令牌仅在签发响应里出现一次
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_used_at timestamptz not null default now()
);

comment on table public.account_sessions is
  '自管认证的会话（不透明令牌的哈希）。过期即失效，登出即删除；支持按 expires_at 清理。';

create index if not exists account_sessions_user_id_idx
  on public.account_sessions (user_id);

create index if not exists account_sessions_expires_at_idx
  on public.account_sessions (expires_at);

-- 邮箱登录的查重索引（不区分大小写）。**仅在 auth.users 归我们所有时创建**：
-- Supabase 供给的库里该表属 `supabase_admin`，建索引会 `must be owner of table users`。
-- 不建唯一约束：存量行可能已有仅大小写不同的重复，加约束会让迁移失败；查重放在服务层
-- （登录按 lower(email) 精确取一行、注册前先查存在性）。
do $idx$
begin
  if (
    select pg_get_userbyid(c.relowner)
      from pg_class c
     where c.oid = 'auth.users'::regclass
  ) = current_user then
    execute 'create index if not exists auth_users_lower_email_idx
               on auth.users (lower(email::text))';
  end if;
end
$idx$;
