-- agent 治理可调数值（DEC-17/DEC-18）：子代理派生深度 / 后台并发 / LLM 请求重试 /
-- 无限重试开关 / execute 命令超时。全部是 workspace 级设置：代码里只留 DEFAULTS
-- 常量（apps/server/src/agent/governance.ts），覆盖入口 = 本表（设置页）+ env 兜底。
-- 各列带 check 护栏防荒唐值；读侧还有一道钳制（手改过的行不让读取失败）。

alter table public.workspace_settings
  add column if not exists subagent_max_depth integer not null default 1;

alter table public.workspace_settings
  drop constraint if exists workspace_settings_subagent_max_depth_check;

alter table public.workspace_settings
  add constraint workspace_settings_subagent_max_depth_check
  check (subagent_max_depth >= 1 and subagent_max_depth <= 4);

alter table public.workspace_settings
  add column if not exists subagent_max_concurrency integer not null default 4;

alter table public.workspace_settings
  drop constraint if exists workspace_settings_subagent_max_concurrency_check;

alter table public.workspace_settings
  add constraint workspace_settings_subagent_max_concurrency_check
  check (subagent_max_concurrency >= 1 and subagent_max_concurrency <= 16);

alter table public.workspace_settings
  add column if not exists llm_request_max_retries integer not null default 10;

alter table public.workspace_settings
  drop constraint if exists workspace_settings_llm_request_max_retries_check;

alter table public.workspace_settings
  add constraint workspace_settings_llm_request_max_retries_check
  check (llm_request_max_retries >= 0 and llm_request_max_retries <= 100);

alter table public.workspace_settings
  add column if not exists llm_infinite_retry boolean not null default false;

alter table public.workspace_settings
  add column if not exists execute_timeout_ms integer not null default 120000;

alter table public.workspace_settings
  drop constraint if exists workspace_settings_execute_timeout_ms_check;

alter table public.workspace_settings
  add constraint workspace_settings_execute_timeout_ms_check
  check (execute_timeout_ms >= 5000 and execute_timeout_ms <= 1800000);

comment on column public.workspace_settings.subagent_max_depth is
  '子代理派生深度上限（1=禁孙代理；缺省 1，DEC-17）。';
comment on column public.workspace_settings.subagent_max_concurrency is
  '后台任务（子代理/长命令）并发上限（缺省 4，DEC-17）。';
comment on column public.workspace_settings.llm_request_max_retries is
  'LLM 请求级重试上限，含首次，0=不重试（缺省 10，DEC-18）。';
comment on column public.workspace_settings.llm_infinite_retry is
  'LLM 请求无限重试开关，用户显式开启（缺省 false，DEC-18）。';
comment on column public.workspace_settings.execute_timeout_ms is
  'Code 模式 execute 命令超时毫秒（缺省 120000，DEC-18）。';
