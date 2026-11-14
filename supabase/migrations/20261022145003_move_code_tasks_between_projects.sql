-- 当前项目归属可以改变；历史资源继续保存生成时的项目来源。
ALTER TABLE public.execution_task_owners
  ADD CONSTRAINT execution_task_owners_stable_kind_key
    UNIQUE (instance_id, task_id, task_kind),
  DROP CONSTRAINT execution_task_owners_code_task_id_instance_id_project_id_fkey,
  ADD CONSTRAINT execution_task_owners_code_task_identity_fkey
    FOREIGN KEY (code_task_id, instance_id)
    REFERENCES public.code_ui_sessions(id, instance_id) ON DELETE CASCADE;

ALTER TABLE public.task_works
  DROP CONSTRAINT task_works_owner_fk,
  ADD CONSTRAINT task_works_owner_fk
    FOREIGN KEY (instance_id, task_id, owner_kind)
    REFERENCES public.execution_task_owners(instance_id, task_id, task_kind)
    ON DELETE CASCADE;

ALTER TABLE public.asset_objects
  DROP CONSTRAINT asset_objects_execution_task_owner_fkey,
  ADD CONSTRAINT asset_objects_execution_task_owner_fkey
    FOREIGN KEY (instance_id, task_id, task_kind)
    REFERENCES public.execution_task_owners(instance_id, task_id, task_kind)
    ON DELETE CASCADE;

ALTER TABLE public.project_checkpoints
  DROP CONSTRAINT project_checkpoints_execution_task_owner_fk,
  ADD CONSTRAINT project_checkpoints_execution_task_owner_fk
    FOREIGN KEY (instance_id, task_id, task_kind)
    REFERENCES public.execution_task_owners(instance_id, task_id, task_kind)
    ON DELETE CASCADE;

ALTER TABLE public.agent_turn_boundaries
  DROP CONSTRAINT agent_turn_boundaries_execution_task_owner_fk,
  ADD CONSTRAINT agent_turn_boundaries_execution_task_owner_fk
    FOREIGN KEY (instance_id, task_id, task_kind)
    REFERENCES public.execution_task_owners(instance_id, task_id, task_kind)
    ON DELETE CASCADE;

ALTER TABLE public.design_task_goals
  DROP CONSTRAINT design_task_goals_instance_id_task_id_project_id_task_kind_fkey,
  ADD CONSTRAINT design_task_goals_stable_owner_fkey
    FOREIGN KEY (instance_id, task_id, task_kind)
    REFERENCES public.execution_task_owners(instance_id, task_id, task_kind)
    ON DELETE CASCADE,
  ADD CONSTRAINT design_task_goals_source_project_fkey
    FOREIGN KEY (project_id, instance_id)
    REFERENCES public.projects(id, instance_id) ON DELETE CASCADE;

CREATE TABLE public.code_ui_task_project_moves (
  instance_id uuid NOT NULL REFERENCES public.local_instances(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  source_project_id uuid NOT NULL,
  target_project_id uuid NOT NULL,
  observed_revision bigint NOT NULL CHECK (observed_revision >= 0),
  parameter_fingerprint text NOT NULL CHECK (parameter_fingerprint ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('preparing', 'committed')),
  scope_generation bigint NOT NULL CHECK (scope_generation > 0),
  PRIMARY KEY (instance_id, task_id, source_project_id, target_project_id, observed_revision),
  FOREIGN KEY (task_id, instance_id)
    REFERENCES public.code_ui_sessions(id, instance_id) ON DELETE CASCADE,
  CHECK (source_project_id <> target_project_id)
);

-- 删除后的迟到移动由原 Task 墓碑拒绝；参数指纹随删除清除。
CREATE FUNCTION public.clear_deleted_task_project_moves()
RETURNS trigger
LANGUAGE plpgsql
AS $clear_deleted_task_project_moves$
BEGIN
  DELETE FROM public.code_ui_task_project_moves
  WHERE instance_id = NEW.instance_id AND task_id = NEW.id;
  RETURN NEW;
END
$clear_deleted_task_project_moves$;

CREATE TRIGGER code_ui_task_project_moves_deleted
AFTER UPDATE OF deleted_at ON public.code_ui_sessions
FOR EACH ROW
WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL AND NEW.parent_session_id IS NULL)
EXECUTE FUNCTION public.clear_deleted_task_project_moves();

COMMENT ON TABLE public.code_ui_task_project_moves IS
  'Task 项目移动回执；稳定业务键与参数指纹用于并发及重放，软删除 Task 时清除，物理删除 Task 或实例时级联清除';
COMMENT ON COLUMN public.execution_task_owners.project_id IS
  'Task 当前项目归属；历史资源 project_id 保留其生成时来源并通过稳定 Task 身份关联';
