-- 语音性能检测结果（实例级单行）。
--
-- 为什么在 app_config 而不在 workspace_settings：检测量的是**这台机器**
-- （CPU 核数 / 内存 / 转写实时率 / 端点首 token 延迟），与哪个工作区无关；
-- 而三段模型选择含 BYOK 实例 id（工作区作用域），必须留在 workspace_settings.voice。
-- 两者不能混，否则「换个工作区，机器性能变了」这种怪象就会出现。

ALTER TABLE public.app_config
  ADD COLUMN IF NOT EXISTS voice_diagnose jsonb;

ALTER TABLE public.app_config
  ADD CONSTRAINT app_config_voice_diagnose_object
  CHECK (voice_diagnose IS NULL OR jsonb_typeof(voice_diagnose) = 'object');

COMMENT ON COLUMN public.app_config.voice_diagnose IS
  '语音性能检测报告（规划 §6：硬件 + 听/想/说三段实测）；启动期读回，PUT 先写库再改内存。';
