-- APIMart驱动安装声明；在已执行的GRSAI迁移后继续前向扩展。
ALTER TABLE public.provider_instances DROP CONSTRAINT provider_instances_protocol_check;
ALTER TABLE public.provider_instances ADD CONSTRAINT provider_instances_protocol_check
  CHECK (protocol IN ('openai-compatible', 'anthropic', 'gemini', 'google-image', 'replicate', 'volces', 'metaso', 'grsai', 'apimart', 'dify-engine'));
