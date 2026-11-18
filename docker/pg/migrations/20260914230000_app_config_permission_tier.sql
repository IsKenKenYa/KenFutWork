-- 权限档位持久化（DEC-4 三档）：此前 globalTier 只在进程内存，重启归零回 default，
-- 而 UI 仍显示旧档——用户以为已放行、服务端却在 default 档拦截（实测漂移）。
-- 实例级单行配置表（id 恒为 1）：权限档位是「本安装实例的信任级别」，
-- 不按工作区拆（服务是进程单例，评估点只有工具名，无工作区上下文）。
-- NULL = 默认 default 档。

CREATE TABLE public.app_config (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  permission_tier text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_config_permission_tier_check
    CHECK (permission_tier IN ('default', 'auto-approve', 'full-access'))
);

COMMENT ON TABLE public.app_config IS
  '实例级单行配置（id 恒为 1）：权限档位等跨重启持久状态。';

COMMENT ON COLUMN public.app_config.permission_tier IS
  '全局权限档位（DEC-4）；NULL = 默认 default。';
