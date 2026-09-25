-- MCP server 支持远程连接（FORM-11 后续 / 用户反馈「官方市场一堆暂不支持」）：
-- kind = stdio（本地子进程，command/args 生效）| http（远程 Streamable HTTP/SSE，url 生效）。
-- 历史行默认 stdio，行为不变。

ALTER TABLE public.mcp_servers
  ADD COLUMN kind text NOT NULL DEFAULT 'stdio',
  ADD COLUMN url text;

ALTER TABLE public.mcp_servers
  ADD CONSTRAINT mcp_servers_kind_check CHECK (kind IN ('stdio', 'http')),
  ADD CONSTRAINT mcp_servers_url_required_for_http CHECK (
    kind <> 'http' OR (url IS NOT NULL AND length(url) > 0)
  );

COMMENT ON COLUMN public.mcp_servers.kind IS
  '传输类型：stdio = 本地子进程（command/args），http = 远程 Streamable HTTP/SSE（url）。';
COMMENT ON COLUMN public.mcp_servers.url IS
  'http 类型的远程端点 URL；stdio 类型为空。';
