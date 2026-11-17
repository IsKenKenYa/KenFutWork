-- 前向保留历史检查点；旧画布字段只作不可执行的历史数据，不推定新 Task 目录授权。
ALTER TABLE public.project_checkpoints RENAME COLUMN canvas_id TO legacy_canvas_id;
ALTER TABLE public.project_checkpoints ALTER COLUMN legacy_canvas_id DROP NOT NULL;
ALTER TABLE public.project_checkpoints
  ADD COLUMN project_id uuid,
  ADD COLUMN task_id uuid,
  ADD COLUMN root_directory text,
  ADD COLUMN directory_snapshots jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT project_checkpoints_directory_snapshots_array
    CHECK (jsonb_typeof(directory_snapshots) = 'array'),
  ADD CONSTRAINT project_checkpoints_project_workspace_fk
    FOREIGN KEY (project_id, workspace_id) REFERENCES public.projects(id, workspace_id) ON DELETE CASCADE,
  ADD CONSTRAINT project_checkpoints_task_fk
    FOREIGN KEY (task_id) REFERENCES public.code_ui_sessions(id) ON DELETE CASCADE;
CREATE INDEX project_checkpoints_task_idx ON public.project_checkpoints(workspace_id, task_id, created_at);

-- 分支/回滚代际与目录授权代际分离；旧通知只能写回其原分支。
ALTER TABLE public.code_ui_sessions
  ADD COLUMN branch_generation bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT code_ui_sessions_branch_generation_check CHECK (branch_generation >= 1);
COMMENT ON COLUMN public.code_ui_sessions.branch_generation IS 'Task 分支与回滚代际；用于拒绝旧后台通知与迟到请求';
