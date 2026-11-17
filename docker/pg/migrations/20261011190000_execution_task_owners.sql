
ALTER TABLE public.code_ui_sessions
  ADD CONSTRAINT code_ui_sessions_execution_owner_identity
  UNIQUE (id, instance_id, project_id);

ALTER TABLE public.design_task_executions
  ADD CONSTRAINT design_task_executions_owner_identity
  UNIQUE (task_id, instance_id, project_id);

CREATE TABLE public.execution_task_owners (
  instance_id uuid NOT NULL REFERENCES public.local_instances(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  project_id uuid NOT NULL,
  task_kind text NOT NULL CHECK (task_kind IN ('code', 'design')),
  code_task_id uuid,
  design_task_id uuid,
  PRIMARY KEY (instance_id, task_id),
  UNIQUE (instance_id, task_id, project_id, task_kind),
  CHECK (
    (task_kind = 'code' AND code_task_id IS NOT NULL AND code_task_id = task_id AND design_task_id IS NULL)
    OR (task_kind = 'design' AND design_task_id IS NOT NULL AND design_task_id = task_id AND code_task_id IS NULL)
  ),
  FOREIGN KEY (project_id, instance_id)
    REFERENCES public.projects(id, instance_id) ON DELETE CASCADE,
  FOREIGN KEY (code_task_id, instance_id, project_id)
    REFERENCES public.code_ui_sessions(id, instance_id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (design_task_id, instance_id, project_id)
    REFERENCES public.design_task_executions(task_id, instance_id, project_id) ON DELETE CASCADE
);

DO $check_execution_task_owner_identity_collision$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.code_ui_sessions c
    JOIN public.design_task_executions d
      ON d.instance_id=c.instance_id AND d.task_id=c.id
    WHERE c.parent_session_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Code and Design Task identities collide in execution_task_owners';
  END IF;
END
$check_execution_task_owner_identity_collision$;

INSERT INTO public.execution_task_owners
  (instance_id, task_id, project_id, task_kind, code_task_id)
SELECT instance_id, id, project_id, 'code', id
FROM public.code_ui_sessions
WHERE parent_session_id IS NULL;

INSERT INTO public.execution_task_owners
  (instance_id, task_id, project_id, task_kind, design_task_id)
SELECT instance_id, task_id, project_id, 'design', task_id
FROM public.design_task_executions;

CREATE FUNCTION public.register_code_execution_task_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $register_code_execution_task_owner$
BEGIN
  IF NEW.parent_session_id IS NULL THEN
    INSERT INTO public.execution_task_owners
      (instance_id, task_id, project_id, task_kind, code_task_id)
    VALUES (NEW.instance_id, NEW.id, NEW.project_id, 'code', NEW.id)
    ON CONFLICT (instance_id, task_id) DO NOTHING;

    IF NOT EXISTS (
      SELECT 1 FROM public.execution_task_owners
      WHERE instance_id = NEW.instance_id AND task_id = NEW.id
        AND project_id = NEW.project_id AND task_kind = 'code'
        AND code_task_id = NEW.id AND design_task_id IS NULL
    ) THEN
      RAISE EXCEPTION 'execution task owner identity conflict for Code Task %', NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END
$register_code_execution_task_owner$;

CREATE TRIGGER code_execution_task_owner_created
AFTER INSERT ON public.code_ui_sessions
FOR EACH ROW EXECUTE FUNCTION public.register_code_execution_task_owner();

ALTER TABLE public.task_works
  ADD COLUMN owner_kind text NOT NULL DEFAULT 'code'
    CHECK (owner_kind IN ('code', 'design'));

ALTER TABLE public.task_works
  DROP CONSTRAINT task_works_task_instance_fk,
  ADD CONSTRAINT task_works_owner_fk
    FOREIGN KEY (instance_id, task_id, project_id, owner_kind)
    REFERENCES public.execution_task_owners(instance_id, task_id, project_id, task_kind)
    ON DELETE CASCADE;

COMMENT ON TABLE public.execution_task_owners IS
  '普通 Task 的归属索引；权限与代际仍由对应 Code/Design 源记录权威决定';
COMMENT ON COLUMN public.execution_task_owners.code_task_id IS
  'Code owner 的真实 code_ui_sessions 源 FK，Design owner 时为空';
COMMENT ON COLUMN public.execution_task_owners.design_task_id IS
  'Design owner 的真实 design_task_executions 源 FK，Code owner 时为空';
