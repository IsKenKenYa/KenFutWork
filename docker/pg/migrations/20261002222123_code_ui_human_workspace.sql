-- 原版 Code UI 的人工偏好；目录权限/模型凭据仍归各自服务，禁止混入此 JSON。
ALTER TABLE public.workspace_settings
  ADD COLUMN code_ui_preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT workspace_settings_code_ui_preferences_object
    CHECK (jsonb_typeof(code_ui_preferences) = 'object');
COMMENT ON COLUMN public.workspace_settings.code_ui_preferences IS 'Code UI 语言、展示及标签偏好；不保存执行授权或供应商凭据';
