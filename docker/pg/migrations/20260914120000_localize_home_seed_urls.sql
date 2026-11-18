-- =============================================================================
-- 本地化首页种子素材的 URL（§4.13 M2.1：307 处硬编码云 URL）
-- =============================================================================
--
-- 问题：首页示例/发现库的种子行里，图片地址写死为
-- `https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/<bucket>/<path>`
-- （历史遗留的云项目绝对地址）。离线桌面 / 自托管不连该主机 → 全部 404，
-- 首页图片全挂。
--
-- 做法：前向迁移把绝对地址**改写为相对对象引用** `<bucket>/<path>`，读取侧（home 路由）
-- 再经 blob 缝解析成当前形态可访问的 URL（本地 FS / MinIO / 过渡期 Storage）。
-- 这样代码与数据里不再残留任何云主机名，且将来放入同路径的对象即可自动生效。
--
-- 幂等：只在列/JSON 里真的含该主机名时才改写，重复执行为 no-op。
-- 注意：迁移一旦执行不可再改（校验和），后续修正必须新增前向迁移。

-- 1) 数组列 image_urls
update public.home_example_examples
   set image_urls = (
         select array_agg(
                  replace(
                    url,
                    'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/',
                    ''
                  )
                  order by ord
                )
           from unnest(image_urls) with ordinality as t(url, ord)
       )
 where array_to_string(image_urls, ',') like '%jmcrxgenontlkxktpihl.supabase.co%';

-- 2) 文本列
update public.home_discovery_cases
   set cover_image_url = replace(
         cover_image_url,
         'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/',
         ''
       )
 where cover_image_url like '%jmcrxgenontlkxktpihl.supabase.co%';

update public.home_discovery_cases
   set author_avatar_url = replace(
         author_avatar_url,
         'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/',
         ''
       )
 where author_avatar_url like '%jmcrxgenontlkxktpihl.supabase.co%';

-- 3) JSONB 里的 imgSrc（input_mentions 是扁平结构：数组元素上的 imgSrc 字符串）
--    经文本整体替换再解析回来；这些 URL 不含引号/反斜杠，改写不会破坏 JSON 转义。
update public.home_example_examples
   set input_mentions = replace(
         input_mentions::text,
         'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/',
         ''
       )::jsonb
 where input_mentions::text like '%jmcrxgenontlkxktpihl.supabase.co%';
