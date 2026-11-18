-- Historical rows default to Code because prior application writes were Code-only.

ALTER TABLE public.project_checkpoints
  ADD COLUMN task_kind text NOT NULL DEFAULT 'code'
    CHECK (task_kind IN ('code', 'design'));

ALTER TABLE public.project_checkpoints
  DROP CONSTRAINT project_checkpoints_task_fk,
  ADD CONSTRAINT project_checkpoints_execution_task_owner_fk
    FOREIGN KEY (instance_id, task_id, project_id, task_kind)
    REFERENCES public.execution_task_owners(instance_id, task_id, project_id, task_kind)
    ON DELETE CASCADE;

ALTER TABLE public.agent_turn_boundaries
  ADD COLUMN task_kind text NOT NULL DEFAULT 'code'
    CHECK (task_kind IN ('code', 'design'));

ALTER TABLE public.agent_turn_boundaries
  DROP CONSTRAINT agent_turn_boundaries_task_instance_fk,
  ADD CONSTRAINT agent_turn_boundaries_execution_task_owner_fk
    FOREIGN KEY (instance_id, task_id, project_id, task_kind)
    REFERENCES public.execution_task_owners(instance_id, task_id, project_id, task_kind)
    ON DELETE CASCADE;

COMMENT ON COLUMN public.project_checkpoints.task_kind IS
  '真实Task宿主模式；目录与当前授权仍由ScopeHandle和ExecutionScopes权威提供';
COMMENT ON COLUMN public.agent_turn_boundaries.task_kind IS
  '真实Task宿主模式；运行权限代际仍由Code/Design源记录校验';
