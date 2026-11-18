-- run 失败重试上限（含首次尝试；0 = 不重试）。
--
-- 背景：上游（one-api + glm 一类代理）偶发「首 token 后停滞」或流异常中断，整轮失败但
-- 重跑即好。此前失败只能甩给用户手动再发一次；现在由服务端按此上限自动重试。
--
-- 安全边界不在本列：是否可重试由 agent/run-retry.ts 判定（**本轮已执行工具就不重试**，
-- 避免重复施加副作用）。本列只是次数上限，故给区间护栏防荒唐值。

alter table public.workspace_settings
  add column if not exists agent_max_retries integer not null default 10;

alter table public.workspace_settings
  drop constraint if exists workspace_settings_agent_max_retries_check;

alter table public.workspace_settings
  add constraint workspace_settings_agent_max_retries_check
  check (agent_max_retries >= 0 and agent_max_retries <= 50);

comment on column public.workspace_settings.agent_max_retries is
  'run 失败自动重试上限（含首次尝试；0=不重试；缺省 10）。已执行工具的轮次不重试。';
