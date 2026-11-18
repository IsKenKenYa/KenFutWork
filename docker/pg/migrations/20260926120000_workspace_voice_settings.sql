-- 语音助手（设置 →「语音」）：功能模式 + 三段模型选择 + 语音回复开关。
--
-- 为什么在工作区列而不在 app_config：选择里含 BYOK 实例 id，而实例是**工作区作用域**的
-- （provider_instances 按 workspace 隔离），放实例级单行表会跨工作区串味。性能检测结果
-- （机器属性，与工作区无关）另走 app_config，两边不混。
--
-- 形状：{mode, listen, think, speak, speakReplies}；三段各存 {kind,id,model?,voice?}，
-- 缺省值由服务端补（缺列/坏值逐字段回落，不整块丢弃）。

ALTER TABLE public.workspace_settings
  ADD COLUMN IF NOT EXISTS voice jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.workspace_settings
  ADD CONSTRAINT workspace_settings_voice_object
  CHECK (jsonb_typeof(voice) = 'object');

COMMENT ON COLUMN public.workspace_settings.voice IS
  '语音助手设置：{mode: transcribe|loop, listen/think/speak: {kind,id,model?,voice?}|null, speakReplies: bool}';
