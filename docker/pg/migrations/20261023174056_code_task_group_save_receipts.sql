CREATE TABLE public.code_task_group_save_receipts (
  instance_id uuid NOT NULL REFERENCES public.code_task_group_state(instance_id) ON DELETE CASCADE,
  operation_key text NOT NULL,
  group_id uuid NOT NULL,
  parameter_fingerprint text,
  result jsonb,
  deleted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (instance_id,operation_key),
  CHECK (
    (deleted AND parameter_fingerprint IS NULL AND result IS NULL)
    OR
    (NOT deleted AND parameter_fingerprint ~ '^[a-f0-9]{64}$' AND result IS NOT NULL AND jsonb_typeof(result)='object')
  )
);

CREATE INDEX code_task_group_save_receipts_group
  ON public.code_task_group_save_receipts(instance_id,group_id);

CREATE FUNCTION public.retire_code_task_group_save_receipts()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.code_task_group_save_receipts
    SET deleted=true,parameter_fingerprint=NULL,result=NULL
    WHERE instance_id=OLD.instance_id AND group_id=OLD.id;
  RETURN OLD;
END;
$$;

CREATE TRIGGER code_task_group_save_receipts_deleted
AFTER DELETE ON public.code_task_groups
FOR EACH ROW EXECUTE FUNCTION public.retire_code_task_group_save_receipts();

COMMENT ON TABLE public.code_task_group_save_receipts IS
  '分组创建与编辑的稳定业务回执；组删除后仅保留实例、业务键、组身份及删除状态，实例删除时级联清理';
