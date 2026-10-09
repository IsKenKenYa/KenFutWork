-- 「允许 AI 在页面里执行任意 JS」（browser_eval 工具）。
--
-- 默认**关**：与 browser_devtools_read（默认开）不同——读数据是 agent 调试网页的主要依据，
-- 而 eval 能从「看和点」扩到「任意脚本」（改写页面状态、绕过前端校验、发起本机请求）。
-- 这是权限口径，须由用户在「设置 → 浏览器」显式打开；关掉后 browser_eval 如实拒绝并指路。
-- 仍需先开「允许 AI 控制浏览器」（browser_control_enabled）：eval 是控制面的延伸，不是读数。
ALTER TABLE public.app_config
  ADD COLUMN browser_eval_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.app_config.browser_eval_enabled IS
  'Whether the agent may execute arbitrary JavaScript in the controlled browser page via the browser_eval tool (settings -> browser). Default off; also requires browser control enabled.';
