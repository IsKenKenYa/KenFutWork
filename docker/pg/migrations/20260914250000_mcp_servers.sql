-- MCP server 实例配置（此前只能塞 LOOMIC_MCP_SERVERS 环境变量 JSON，界面上无法增删）。
-- 实例级资源：MCP server 以 stdio 子进程方式在本机运行，不按工作区隔离；
-- 变更类操作走管理员门（与插件安装同口径——都会在本机执行代码）。
-- env 列可能含密钥：接口只回传键名不回传值（BYOK 红线同口径）。
-- 环境变量里的 server 仍支持（只读，UI 标注来源），两者按名称合并由运行时负责。

CREATE TABLE public.mcp_servers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  command text NOT NULL,
  args jsonb NOT NULL DEFAULT '[]'::jsonb,
  env jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.mcp_servers IS
  '实例级 MCP server 配置（stdio）；env 值只写不读。';

CREATE INDEX mcp_servers_enabled_idx ON public.mcp_servers(enabled);
