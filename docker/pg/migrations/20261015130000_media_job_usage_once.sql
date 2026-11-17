-- 一个Job对应一次上游请求。历史媒体重复记录保留首次，之后由唯一键防重。
with duplicate as (
  select id,row_number() over(partition by instance_id,job_id order by occurred_at,id) as ordinal
  from public.usage_records where job_id is not null and capability in ('image','video')
)
delete from public.usage_records r using duplicate d where r.id=d.id and d.ordinal>1;
create unique index usage_records_media_job_once on public.usage_records(instance_id,job_id)
  where job_id is not null and capability in ('image','video');
