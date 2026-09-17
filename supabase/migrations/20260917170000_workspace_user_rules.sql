-- 「规则与记忆」接进提示词（B）：用户规则此前只存在浏览器 localStorage，
-- 页面却写着「这些指令会附加到 Agent 的每次请求中」——服务端零消费方。
-- 现在落工作区设置，由 run 起始期拼进系统提示词。
ALTER TABLE public.workspace_settings
  ADD COLUMN user_rules text NOT NULL DEFAULT '';

ALTER TABLE public.workspace_settings
  ADD COLUMN rule_entries jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.workspace_settings
  ADD CONSTRAINT workspace_settings_rule_entries_array
  CHECK (jsonb_typeof(rule_entries) = 'array');

COMMENT ON COLUMN public.workspace_settings.user_rules IS
  'Free-form user rules appended to every agent run system prompt.';
COMMENT ON COLUMN public.workspace_settings.rule_entries IS
  'Short rule lines appended to every agent run system prompt.';
