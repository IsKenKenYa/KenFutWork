-- 轮末闸门续轮上限（DEC-15/18）：后台任务挂死时，runtime 最多按本列续轮次数
-- 重入 thread 等待结算，打满即放行终态并由 finally abortAll 收割残留任务。
-- 数值语义唯一属主 shared governance.ts；覆盖入口 = 本表 + env 兜底。

alter table public.workspace_settings
  add column if not exists subagent_max_continuations integer not null default 50;

alter table public.workspace_settings
  drop constraint if exists workspace_settings_subagent_max_continuations_check;

alter table public.workspace_settings
  add constraint workspace_settings_subagent_max_continuations_check
  check (subagent_max_continuations >= 1 and subagent_max_continuations <= 200);

comment on column public.workspace_settings.subagent_max_continuations is
  '轮末闸门续轮上限（缺省 50，DEC-15/18）。打满后残留后台任务被终止。';
