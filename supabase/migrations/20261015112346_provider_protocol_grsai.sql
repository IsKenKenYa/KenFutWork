-- GRSAI驱动安装声明：保持协议封闭集合，历史迁移不改写。
ALTER TABLE public.provider_instances DROP CONSTRAINT provider_instances_protocol_check;
ALTER TABLE public.provider_instances ADD CONSTRAINT provider_instances_protocol_check
  CHECK (protocol IN ('openai-compatible', 'anthropic', 'gemini', 'google-image', 'replicate', 'volces', 'metaso', 'grsai', 'dify-engine'));
