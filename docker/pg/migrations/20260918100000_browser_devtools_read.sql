-- 「允许 AI 读取开发者工具数据」（面板里悬浮控制台采集到的控制台日志 / 页面报错 / 网络请求）。
--
-- 默认**开**：这些数据是 agent 调试网页的主要依据（页面报的错、失败的请求），而它们本来就
-- 只来自本机受控浏览器的会话（不给 agent 用户的浏览器身份，见 cdp-session 的头注）。
-- 关掉后 browser_console / browser_network 会如实拒绝，不静默降级。
ALTER TABLE public.app_config
  ADD COLUMN browser_devtools_read_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.app_config.browser_devtools_read_enabled IS
  'Whether the agent may read captured devtools data (console logs / page errors / network requests) from the controlled browser (settings -> browser).';
