-- 自定义斜杠命令（R5-2 的「命令」条目）。
--
-- 参考图里它是一个设置页：用户定义「名字 + 说明 + 提示词模板」，在对话输入框里用
-- `/名字 参数` 触发。此前登记为「不做（没有命令注册表与消费方）」——现在补上**真的
-- 注册表与真的消费方**（输入框提交前展开成提示词），不是只放一个写不进东西的页面。
--
-- 形状：[{"name":"review","description":"审查改动","prompt":"请审查以下改动：{{args}}"}]
-- 约束与校验在契约层（packages/shared/src/contracts.ts）：名字 1-32 位字母数字与连字符、
-- 提示词非空、最多 50 条。
alter table public.workspace_settings
  add column if not exists commands jsonb not null default '[]'::jsonb;

alter table public.workspace_settings
  add constraint workspace_settings_commands_array
  check (jsonb_typeof(commands) = 'array');

comment on column public.workspace_settings.commands is
  '自定义斜杠命令（name/description/prompt）；输入框以 /name 触发，提交前展开成 prompt';
