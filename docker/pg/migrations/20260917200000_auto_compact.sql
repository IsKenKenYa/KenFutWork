-- 上下文自动压缩开关（R4-1「输出预留线」的执行面）。
--
-- 背景：上下文条只画了「已用 / 预留输出 / 剩余」，越线时界面写的建议是「新建对话」——
-- 因为当时**没有**自动压缩。现在接上 deepagents 的 summarization middleware：
-- 阈值默认取「窗口 − 预留输出」（与界面上那根线同一个数），摘要用本轮 run 的模型
-- （BYOK 不引入第二个模型配置），被压掉的消息 offload 到工作区 /conversation_history/、
-- 模型上下文里换成一条摘要（库里的转录不动）。
--
-- 缺省 true：不压缩时超长会话会直接撞上游上限而失败（用户侧只能看到通用报错），
-- 默认开着对用户更友好；想保留完整上下文的人可以在设置里关掉（关掉时中间件**不挂**）。
alter table public.workspace_settings
  add column if not exists auto_compact_enabled boolean not null default true;

comment on column public.workspace_settings.auto_compact_enabled is
  '上下文自动压缩：超阈值时把较早消息摘要掉（阈值=窗口-预留输出；摘要用本轮模型；转录不变）';
