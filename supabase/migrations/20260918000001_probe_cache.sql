-- 实例级能力探测缓存（docs/future/05 §6.2，阶段 E）。
--
-- probe_result：连通性 + 中转站方言探测结果（include_usage / strict tool
-- schema / Responses API / anthropic cache_control——各项 true/false/缺席=未知）。
-- 探测由用户/管理员显式触发（POST probe），运行期据此裁剪请求（ fail open：
-- 无结果 = 不裁剪，按全能力尝试）。
-- probed_at：探测时刻（过期显示用，不参与门禁）。

alter table public.provider_instances
  add column probe_result jsonb;

alter table public.provider_instances
  add column probed_at timestamptz;
