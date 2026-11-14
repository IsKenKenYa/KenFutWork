CREATE TABLE public.code_task_group_move_receipts (
  instance_id uuid NOT NULL REFERENCES public.code_task_group_state(instance_id) ON DELETE CASCADE,
  node_type text NOT NULL CHECK (node_type IN ('group','task')),
  node_id uuid NOT NULL,
  expected_revision bigint NOT NULL CHECK (expected_revision BETWEEN 0 AND 9007199254740991),
  parameter_fingerprint text,
  source_group_id uuid,
  target_group_id uuid,
  anchor_type text CHECK (anchor_type IN ('group','task')),
  anchor_id uuid,
  deleted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (instance_id,node_type,node_id,expected_revision),
  CHECK (
    (deleted AND parameter_fingerprint IS NULL AND source_group_id IS NULL
      AND target_group_id IS NULL AND anchor_type IS NULL AND anchor_id IS NULL)
    OR
    (NOT deleted AND parameter_fingerprint IS NOT NULL
      AND parameter_fingerprint ~ '^[a-f0-9]{64}$'
      AND ((anchor_type IS NULL AND anchor_id IS NULL)
        OR (anchor_type IS NOT NULL AND anchor_id IS NOT NULL)))
  )
);

CREATE INDEX code_task_group_move_receipts_source
  ON public.code_task_group_move_receipts(instance_id,source_group_id)
  WHERE NOT deleted AND source_group_id IS NOT NULL;
CREATE INDEX code_task_group_move_receipts_target
  ON public.code_task_group_move_receipts(instance_id,target_group_id)
  WHERE NOT deleted AND target_group_id IS NOT NULL;
CREATE INDEX code_task_group_move_receipts_anchor
  ON public.code_task_group_move_receipts(instance_id,anchor_type,anchor_id)
  WHERE NOT deleted AND anchor_id IS NOT NULL;

CREATE FUNCTION public.retire_code_task_group_moves_for_group()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM public.code_task_group_state
    WHERE instance_id=OLD.instance_id FOR UPDATE;
  UPDATE public.code_task_group_move_receipts
    SET deleted=true,parameter_fingerprint=NULL,source_group_id=NULL,
      target_group_id=NULL,anchor_type=NULL,anchor_id=NULL
    WHERE instance_id=OLD.instance_id AND NOT deleted AND (
      (node_type='group' AND node_id=OLD.id)
      OR source_group_id=OLD.id OR target_group_id=OLD.id
      OR (anchor_type='group' AND anchor_id=OLD.id)
    );
  RETURN OLD;
END;
$$;

CREATE TRIGGER code_task_group_move_receipts_group_deleted
AFTER DELETE ON public.code_task_groups
FOR EACH ROW EXECUTE FUNCTION public.retire_code_task_group_moves_for_group();

CREATE FUNCTION public.retire_code_task_group_moves_for_task()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  task public.code_ui_sessions%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN task:=OLD; ELSE task:=NEW; END IF;
  PERFORM 1 FROM public.code_task_group_state
    WHERE instance_id=task.instance_id FOR UPDATE;
  UPDATE public.code_task_group_move_receipts
    SET deleted=true,parameter_fingerprint=NULL,source_group_id=NULL,
      target_group_id=NULL,anchor_type=NULL,anchor_id=NULL
    WHERE instance_id=task.instance_id AND NOT deleted AND (
      (node_type='task' AND node_id=task.id)
      OR (anchor_type='task' AND anchor_id=task.id)
    );
  RETURN task;
END;
$$;

CREATE TRIGGER code_task_group_move_receipts_task_soft_deleted
AFTER UPDATE OF deleted_at ON public.code_ui_sessions
FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL AND NEW.parent_session_id IS NULL)
EXECUTE FUNCTION public.retire_code_task_group_moves_for_task();

CREATE TRIGGER code_task_group_move_receipts_task_deleted
BEFORE DELETE ON public.code_ui_sessions
FOR EACH ROW WHEN (OLD.parent_session_id IS NULL)
EXECUTE FUNCTION public.retire_code_task_group_moves_for_task();

COMMENT ON TABLE public.code_task_group_move_receipts IS
  '手动移动以实例、节点类型、稳定身份及组织修订判重；相关组或Task删除后仅保留最小不透明业务键，实例删除级联清理';
