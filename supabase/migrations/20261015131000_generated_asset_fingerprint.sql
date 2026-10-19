-- 独立生成产物沿用legacy文件归属；内容幂等不能占用ProjectFile专用列。
alter table public.asset_objects add column generation_fingerprint text;
alter table public.asset_objects add constraint asset_objects_generation_fingerprint_check
  check (generation_fingerprint is null or generation_fingerprint ~ '^[a-f0-9]{64}$');
