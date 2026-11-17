-- 「永久」工具审批的持久化：approvedForever 此前只存进程内存（permission-service 的
-- in-memory Set），服务端一重启就丢——UI 写着「已永久批准」，重启后同一工具又被拦，
-- 「永久」名不副实（2026-10-07 真机走查实测）。落到 app_config 单行表，与档位同列。
--
-- 默认空数组：与旧行为一致（没有历史批准可读回，宁严勿松）。
ALTER TABLE public.app_config
  ADD COLUMN approved_tools jsonb NOT NULL DEFAULT '[]';

COMMENT ON COLUMN public.app_config.approved_tools IS
  'Tool names approved forever via settings -> permissions (jsonb array of strings); survives server restarts.';
