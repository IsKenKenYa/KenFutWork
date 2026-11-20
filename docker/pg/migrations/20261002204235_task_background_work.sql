-- 后台执行属于 Code Task；派发幂等键、通知消费回执和重启中断独立于前台 Run。
ALTER TABLE public.code_ui_sessions
  ADD CONSTRAINT code_ui_sessions_id_workspace_unique UNIQUE (id, workspace_id);

CREATE TABLE public.task_works (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  task_id uuid NOT NULL,
  scope jsonb NOT NULL CHECK (jsonb_typeof(scope) = 'object'),
  agent_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('command', 'subagent')),
  label text NOT NULL,
  origin_run_id text NOT NULL,
  tool_call_id text NOT NULL,
  parameter_fingerprint text NOT NULL,
  child_session_id uuid,
  branch_generation bigint NOT NULL CHECK (branch_generation > 0),
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'canceled', 'interrupted')),
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  summary text,
  output_ref text,
  output_stats jsonb CHECK (output_stats IS NULL OR jsonb_typeof(output_stats) = 'object'),
  consumed_at timestamptz,
  consumed_by_run_id text,
  owner_id uuid NOT NULL,
  execution_host_id text NOT NULL,
  CONSTRAINT task_works_task_workspace_fk FOREIGN KEY (task_id, workspace_id)
    REFERENCES public.code_ui_sessions(id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT task_works_project_workspace_fk FOREIGN KEY (project_id, workspace_id)
    REFERENCES public.projects(id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT task_works_dispatch_unique UNIQUE (workspace_id, task_id, branch_generation, origin_run_id, tool_call_id),
  CONSTRAINT task_works_terminal_time CHECK ((status = 'running' AND ended_at IS NULL) OR (status <> 'running' AND ended_at IS NOT NULL))
);
CREATE INDEX task_works_pending ON public.task_works(workspace_id, task_id, branch_generation, ended_at, id)
  WHERE status <> 'running' AND consumed_at IS NULL;
CREATE INDEX task_works_host_running ON public.task_works(execution_host_id, owner_id) WHERE status = 'running';
COMMENT ON TABLE public.task_works IS 'Task 后台命令/子代理的持久记录；真实停止后结算，终态原子消费，重启不自动重放';
