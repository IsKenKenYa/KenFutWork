-- 组织状态独立于 Task 执行代际；读取不创建或改写分组。
CREATE TABLE public.code_task_group_state (
  instance_id uuid PRIMARY KEY REFERENCES public.local_instances(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0 AND revision <= 9007199254740991)
);

CREATE FUNCTION public.register_code_task_group_state()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.code_task_group_state(instance_id) VALUES (NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER code_task_group_state_created
AFTER INSERT ON public.local_instances
FOR EACH ROW EXECUTE FUNCTION public.register_code_task_group_state();

INSERT INTO public.code_task_group_state(instance_id)
SELECT id FROM public.local_instances;

CREATE TABLE public.code_task_groups (
  instance_id uuid NOT NULL REFERENCES public.code_task_group_state(instance_id) ON DELETE CASCADE,
  id uuid NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  color text NOT NULL CHECK (color IN ('gray','red','orange','yellow','green','blue','purple')),
  sort_order integer NOT NULL CHECK (sort_order >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instance_id,id)
);

CREATE TABLE public.code_task_group_members (
  instance_id uuid NOT NULL REFERENCES public.code_task_group_state(instance_id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  task_kind text NOT NULL CHECK (task_kind='code'),
  group_id uuid,
  sort_order integer NOT NULL CHECK (sort_order >= 0),
  user_organized boolean NOT NULL DEFAULT false,
  creation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instance_id,task_id,task_kind),
  FOREIGN KEY (instance_id,task_id,task_kind)
    REFERENCES public.execution_task_owners(instance_id,task_id,task_kind) ON DELETE CASCADE,
  FOREIGN KEY (instance_id,group_id)
    REFERENCES public.code_task_groups(instance_id,id) ON DELETE SET NULL (group_id)
);

CREATE INDEX code_task_groups_order
  ON public.code_task_groups(instance_id,sort_order,id);
CREATE INDEX code_task_group_members_order
  ON public.code_task_group_members(instance_id,group_id,sort_order,task_id);

-- 顺序为真实 Task、组织行、成员；首次登记也必须先核验并持有真实 Task。
CREATE FUNCTION public.retire_code_task_group_member()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  task public.code_ui_sessions%ROWTYPE;
  removed bigint;
BEGIN
  IF TG_OP='DELETE' THEN task:=OLD; ELSE task:=NEW; END IF;
  PERFORM 1 FROM public.code_task_group_state
    WHERE instance_id=task.instance_id FOR UPDATE;
  DELETE FROM public.code_task_group_members
    WHERE instance_id=task.instance_id AND task_id=task.id AND task_kind='code';
  GET DIAGNOSTICS removed=ROW_COUNT;
  IF removed>0 THEN
    UPDATE public.code_task_group_state SET revision=revision+1
      WHERE instance_id=task.instance_id;
  END IF;
  RETURN task;
END;
$$;

CREATE TRIGGER code_task_group_member_soft_deleted
AFTER UPDATE OF deleted_at ON public.code_ui_sessions
FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL AND NEW.parent_session_id IS NULL)
EXECUTE FUNCTION public.retire_code_task_group_member();

CREATE TRIGGER code_task_group_member_deleted
BEFORE DELETE ON public.code_ui_sessions
FOR EACH ROW WHEN (OLD.parent_session_id IS NULL)
EXECUTE FUNCTION public.retire_code_task_group_member();

COMMENT ON TABLE public.code_task_group_state IS
  '实例的独立分组组织修订；初始化随实例创建完成，普通读取不写数据';
COMMENT ON TABLE public.code_task_group_members IS
  '统一 Code/Design Task 的稳定 Owner 成员与排序；不保存项目、目录或 Task 授权';
