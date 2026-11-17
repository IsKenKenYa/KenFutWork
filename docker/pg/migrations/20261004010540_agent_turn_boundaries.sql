-- Harness轮次边界账本；只保存opaque context与有效文件引用，不复制聊天正文或凭据。
CREATE TABLE public.agent_turn_boundaries (
  run_id uuid NOT NULL REFERENCES public.agent_runs(id) ON DELETE CASCADE,
  phase text NOT NULL CHECK (phase IN ('pre', 'post')),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  task_id uuid NOT NULL,
  boundary jsonb NOT NULL CHECK (jsonb_typeof(boundary) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, phase),
  CONSTRAINT agent_turn_boundaries_task_workspace_fk
    FOREIGN KEY (task_id, workspace_id) REFERENCES public.code_ui_sessions(id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT agent_turn_boundaries_project_workspace_fk
    FOREIGN KEY (project_id, workspace_id) REFERENCES public.projects(id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT agent_turn_boundaries_phase_matches CHECK (boundary->>'phase' = phase),
  CONSTRAINT agent_turn_boundaries_scope_generation CHECK ((boundary->>'scopeGeneration')::bigint >= 0),
  CONSTRAINT agent_turn_boundaries_branch_generation CHECK (
    boundary->'branchGeneration' = 'null'::jsonb OR (boundary->>'branchGeneration')::bigint >= 1)
);
CREATE INDEX agent_turn_boundaries_task ON public.agent_turn_boundaries(workspace_id, task_id, created_at, run_id);
COMMENT ON TABLE public.agent_turn_boundaries IS '真实Run前后context/files捕获事实；run/phase幂等，同键不同事实拒绝覆盖，partial状态不得作为恢复依据';
