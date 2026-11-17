-- 一个请求可以按原生多图能力拆成多个上游操作；操作索引在同一实例内唯一。
create unique index if not exists background_jobs_media_request_identity
  on public.background_jobs (
    instance_id,
    (payload->>'request_id'),
    (coalesce(payload->>'request_index', '0'))
  ) where payload ? 'request_id';
