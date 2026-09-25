-- Code 模式检查点（影子 git）。
--
-- 影子仓库本身在服务端数据目录（GIT_DIR），本表只存「影子提交的元数据行」：
-- 每轮开始/结束与回滚时打一个快照，客户端据此展示改动并一键回滚。
-- run_id 关联产生该检查点的运行（回滚恢复点没有 run，为 NULL）。
--
-- 隔离：按工作区（FORM-9：应用层强制 workspace_id 谓词，漏写即失败），
-- workspace_id 由客户端绑定的 :workspace 占位符写入，不进业务参数。
-- id 由应用层 randomUUID 生成，不用 DB 默认值。
create table if not exists public.project_checkpoints (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  canvas_id text not null,
  run_id uuid,
  kind text not null check (kind in ('baseline','turn','restore')),
  label text not null,
  shadow_commit text not null,
  files_changed int not null default 0,
  insertions int not null default 0,
  deletions int not null default 0,
  created_at timestamptz not null default now()
);

-- 画布时间线（列表升序 / getPrevious 取严格早于的最近一行）都走这条索引
create index if not exists project_checkpoints_canvas_idx
  on public.project_checkpoints(workspace_id, canvas_id, created_at);

comment on table public.project_checkpoints is
  'Code 模式检查点：影子 git 提交的元数据行，按工作区隔离（FORM-9 应用层谓词）';
