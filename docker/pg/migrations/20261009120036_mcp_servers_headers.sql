-- http 类型 MCP server 的自定义请求头：HA 的 `POST /api/mcp` 一类端点必须带
-- `Authorization: Bearer <长期令牌>`，此前本仓的 http 传输发不出自定义头（见
-- 《docs/插件/HA插件规划.md》§5.1）。
-- 与 env 同口径：值可能含密钥，接口只回传键名不回传值（BYOK 红线）；stdio 行保持空对象。

ALTER TABLE public.mcp_servers
  ADD COLUMN headers jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.mcp_servers.headers IS
  'http 类型的自定义请求头（键值对，值只写不读）；stdio 类型为空。';
