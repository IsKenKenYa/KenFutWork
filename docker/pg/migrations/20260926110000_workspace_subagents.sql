-- 用户自定义子智能体（设置 →「子智能体」）：主 Agent 可把子任务派给它执行。
--
-- 与内置声明（agent/sub-agents.ts 的 video_generate）的关系：内置是代码声明、
-- 不可删；本列存用户自建的（name/label/description/systemPrompt），按 name 派活。
--
-- 口径：
--   1. 只有**用户本人**能在设置里增删；模型无法新增或删除（不进工具注册表）；
--   2. agent 装配（deep-agent.ts）每轮从工作区设置读这份清单追加进 subagents；
--   3. 名字以字母开头、限字母数字与 - _（与斜杠命令同风格），最多 10 条。
alter table public.workspace_settings
  add column if not exists subagents jsonb not null default '[]'::jsonb;

alter table public.workspace_settings
  add constraint workspace_settings_subagents_array
  check (jsonb_typeof(subagents) = 'array');

comment on column public.workspace_settings.subagents is
  '用户自定义子智能体：[{name, label, description, systemPrompt}]；装配进 deepagents subagents，按 name 派活';
