-- 新模型体系不转换旧开发偏好；默认按能力角色独立持有。
ALTER TABLE public.instance_settings
  ADD COLUMN model_defaults jsonb NOT NULL
  DEFAULT '{"chat":null,"image":{"mode":"auto"},"video":{"mode":"auto"}}'::jsonb;

ALTER TABLE public.instance_settings
  ADD CONSTRAINT instance_settings_model_defaults_object
  CHECK (jsonb_typeof(model_defaults) = 'object');

COMMENT ON COLUMN public.instance_settings.model_defaults
  IS '实例聊天、图像、视频默认；任务及画布元素可显式覆盖';
