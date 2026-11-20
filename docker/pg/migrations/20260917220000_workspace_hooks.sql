-- 用户钩子（R5-2「钩子」条目）：在每一轮的起点/终点跑一条用户自己的命令。
--
-- 与「命令」（斜杠命令）的区别：命令是**提示词模板**（模型侧的输入展开），
-- 钩子是**在沙箱工作目录里执行的 shell 命令**（运行期的副作用钩子），
-- 参考图把它们分成两页，本表也只存后者。
--
-- 口径（写在这里也是给下一个人的护栏）：
--   1. 只有**用户本人**能在设置里配置；模型**无法**新增或触发钩子——
--      它不进工具注册表，也不受工具门管（工具门管的是模型发起的调用）；
--   2. 执行身份与目录同终端/agent（服务端进程身份 + 该项目的沙箱工作目录）；
--   3. 失败**不阻断**本轮（钩子是旁路），输出与退出码如实进转录。
alter table public.workspace_settings
  add column if not exists hooks jsonb not null default '[]'::jsonb;

alter table public.workspace_settings
  add constraint workspace_settings_hooks_array
  check (jsonb_typeof(hooks) = 'array');

comment on column public.workspace_settings.hooks is
  '用户钩子：[{event:"turn-start"|"turn-end", command}]；在项目工作目录里以服务端身份执行，失败不阻断本轮';
