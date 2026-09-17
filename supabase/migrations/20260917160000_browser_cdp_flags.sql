-- R5-4 续：「连接到 Chrome」（CDP 通道）与「自动截图」的开关。
--
-- 与 browser_control_enabled 同一处（实例级：都是「这台机器上的浏览器怎么用」）。
ALTER TABLE public.app_config
  ADD COLUMN browser_auto_screenshot boolean NOT NULL DEFAULT false;

ALTER TABLE public.app_config
  ADD COLUMN browser_headless boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.app_config.browser_auto_screenshot IS
  'Whether agent browser actions attach a screenshot artifact automatically (settings -> browser).';
COMMENT ON COLUMN public.app_config.browser_headless IS
  'Whether the CDP-managed browser runs headless (settings -> browser -> external).';
