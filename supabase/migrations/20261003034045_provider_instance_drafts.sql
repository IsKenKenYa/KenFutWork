-- 供应商设置可保存未配置 API Key 的草稿；凭证解析仍须显式拒绝缺失凭证。
alter table public.provider_instances
  alter column encrypted_api_key drop not null;

comment on column public.provider_instances.encrypted_api_key is
  '加密 API Key；NULL 表示未配置凭证的供应商草稿，运行时不得回落环境凭证。';
