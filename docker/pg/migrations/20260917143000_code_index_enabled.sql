-- R4-3 索引库：开关挂在工作区设置（与终端 shell 同一处），
-- 索引数据本身落在服务端本机 `<cwd>/.kenfutwork/index/<canvasId>.json`（不进库表）。
ALTER TABLE public.workspace_settings
  ADD COLUMN code_index_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.workspace_settings.code_index_enabled IS
  'Whether the codebase index (settings -> index library) is enabled for this workspace.';
