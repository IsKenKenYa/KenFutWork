-- 视频任务恢复与跨修订防护（docs/future/05 §5.3，阶段 C）。
--
-- provider_job_id：外部厂商的不透明任务引用（replicate prediction id /
-- ark task id / fal request_id…）。submit 成功即落库——worker 崩溃重启后
-- 据此续 poll，而不是重新提交（重新提交 = 云端重复计费）。
-- 空值语义：任务尚未 submit 成功（首次执行）或阻塞式 provider（无外部句柄）。

alter table public.background_jobs
  add column provider_job_id text;

-- config_revision：实例配置修订号（单调自增）。用户/管理员对实例的任何
-- 配置变更（models / base_url / headers / enabled…）都使旧修订作废——
-- 已持久化的异步任务在执行时比对 job 落盘修订与当前修订，不一致即拒，
-- 不跨修订复用旧句柄（nomifun 同款老化治理）。

alter table public.provider_instances
  add column config_revision bigint not null default 1;
