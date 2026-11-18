-- Code 工作域前向改造（2026-10-03 用户授权无用户 MVP 的破坏性 Schema 调整）。
-- 本文件仅是待验证迁移源码：不删除真实文件，不删除 Design 内容，旧 Code 内容保留归档。
-- 实施先在临时空数据库全量重放并校验；现存数据库不由应用启动自动执行 DDL。

ALTER TABLE public.projects
  ADD COLUMN additional_directories jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT projects_additional_directories_array
    CHECK (jsonb_typeof(additional_directories) = 'array');

ALTER TABLE public.chat_sessions
  ALTER COLUMN canvas_id DROP NOT NULL,
  ADD COLUMN workspace_id uuid,
  ADD COLUMN project_id uuid,
  ADD COLUMN mode text;

UPDATE public.chat_sessions AS session
SET workspace_id = project.workspace_id,
    project_id = project.id,
    mode = project.kind
FROM public.canvases AS canvas
JOIN public.projects AS project ON project.id = canvas.project_id
WHERE session.canvas_id = canvas.id;

UPDATE public.chat_sessions SET canvas_id = NULL WHERE mode = 'code';

ALTER TABLE public.chat_sessions
  ALTER COLUMN workspace_id SET NOT NULL,
  ALTER COLUMN project_id SET NOT NULL,
  ALTER COLUMN mode SET NOT NULL,
  ADD CONSTRAINT chat_sessions_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE,
  ADD CONSTRAINT chat_sessions_project_workspace_fk
    FOREIGN KEY (project_id, workspace_id)
    REFERENCES public.projects(id, workspace_id) ON DELETE CASCADE,
  ADD CONSTRAINT chat_sessions_mode_check CHECK (mode IN ('design', 'code', 'flow')),
  ADD CONSTRAINT chat_sessions_mode_canvas_check
    CHECK ((mode = 'code' AND canvas_id IS NULL)
      OR (mode IN ('design', 'flow') AND canvas_id IS NOT NULL));

CREATE INDEX chat_sessions_workspace_project
  ON public.chat_sessions(workspace_id, project_id);

ALTER TABLE public.code_ui_sessions
  DROP COLUMN canvas_id,
  ADD COLUMN root_directory text,
  ADD COLUMN additional_directories jsonb,
  ADD COLUMN sandbox_mode text NOT NULL DEFAULT 'workspace-write',
  ADD COLUMN scope_generation bigint NOT NULL DEFAULT 0,
  ADD COLUMN execution_state text NOT NULL DEFAULT 'ready';

-- 旧会话缺少显式工作域，保留转录但不将它们的旧画布身份推定为新目录授权。
UPDATE public.code_ui_sessions SET archived = true, execution_state = 'failed';
UPDATE public.projects
SET archived_at = coalesce(archived_at, now())
WHERE kind = 'code' AND slug = 'code-workbench';

ALTER TABLE public.code_ui_sessions
  ADD CONSTRAINT code_ui_sessions_scope_generation_check CHECK (scope_generation >= 0),
  ADD CONSTRAINT code_ui_sessions_sandbox_mode_check
    CHECK (sandbox_mode IN ('read-only', 'workspace-write', 'danger-full-access')),
  ADD CONSTRAINT code_ui_sessions_execution_state_check
    CHECK (execution_state IN ('ready', 'revoking', 'failed')),
  ADD CONSTRAINT code_ui_sessions_live_scope_check
    CHECK (deleted_at IS NOT NULL OR execution_state = 'failed'
      OR (root_directory IS NOT NULL AND jsonb_typeof(additional_directories) = 'array')),
  ADD CONSTRAINT code_ui_sessions_project_workspace_fk
    FOREIGN KEY (project_id, workspace_id)
    REFERENCES public.projects(id, workspace_id) ON DELETE CASCADE;

ALTER TABLE public.workspace_settings
  ADD COLUMN runtime_governance jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT workspace_settings_runtime_governance_object
    CHECK (jsonb_typeof(runtime_governance) = 'object');

COMMENT ON COLUMN public.chat_sessions.mode IS '持久产品模式；Run 不得通过 preset 改变 Task 模式';
COMMENT ON COLUMN public.code_ui_sessions.root_directory IS 'Task 创建时固定主目录；项目默认修改只影响新 Task';
COMMENT ON COLUMN public.code_ui_sessions.scope_generation IS '目录与沙箱授权代际；确认旧资源退出后才能恢复 ready';
