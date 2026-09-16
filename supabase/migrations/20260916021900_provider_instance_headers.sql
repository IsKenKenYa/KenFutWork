-- 供应商实例自定义请求头（《改造计划》§4.8「自定义请求头」，未做需求 R6-1）
--
-- 动机：部分网关要求额外请求头才肯路由（如 opencode 的 x-opencode-session），
-- 而契约原先只有 apiKey（固定映射 Authorization）与 base_url，表达不了。
--
-- 口径：
--   * 值含白名单占位符（{{sessionId}} / {{threadId}}），在发请求时按会话上下文替换；
--   * 保留头（authorization / content-type / host 等）不可覆盖——由应用契约在**写入时**拒绝；
--   * 头名是合法 HTTP token、值是可打印 ASCII（禁 CR/LF）同样在写入时校验（fail loud）；
--   * 只写不读：API 只回 headerKeys（键名），值永不回显（与 MCP env/envKeys 同口径）。

ALTER TABLE public.provider_instances
  ADD COLUMN headers jsonb;

COMMENT ON COLUMN public.provider_instances.headers IS
  'Per-instance custom request headers; values are write-only (API exposes headerKeys only).';

ALTER TABLE public.provider_instances
  ADD CONSTRAINT provider_instances_headers_object_check
  CHECK (headers IS NULL OR jsonb_typeof(headers) = 'object');
