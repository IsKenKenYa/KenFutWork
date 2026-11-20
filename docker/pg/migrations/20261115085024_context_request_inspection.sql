-- 本机上下文检查记录；只由真实模型调用创建，Task 删除时清除全部正文。
CREATE TABLE public.context_model_requests (
  id uuid PRIMARY KEY,
  instance_id uuid NOT NULL REFERENCES public.local_instances(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  run_id uuid NOT NULL,
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  agent_call_id text,
  agent_name text,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  model text,
  input_text text NOT NULL,
  input_fingerprint text NOT NULL,
  input_characters integer NOT NULL CHECK (input_characters >= 0),
  output_text text,
  output_fingerprint text,
  output_characters integer CHECK (output_characters >= 0),
  usage jsonb,
  message_count integer NOT NULL CHECK (message_count >= 0),
  tool_count integer CHECK (tool_count >= 0),
  FOREIGN KEY (task_id, instance_id)
    REFERENCES public.code_ui_sessions(id, instance_id) ON DELETE CASCADE,
  CHECK ((status = 'running' AND ended_at IS NULL) OR (status <> 'running' AND ended_at IS NOT NULL)),
  CHECK ((output_text IS NULL) = (output_fingerprint IS NULL))
);
CREATE INDEX context_model_requests_task_sequence
  ON public.context_model_requests(instance_id, task_id, sequence DESC);
COMMENT ON TABLE public.context_model_requests IS '模型调用上下文的本机只读检查；UUID为SDK调用身份，正文不进入流事件或遥测，终态只更新原记录';

CREATE FUNCTION public.clear_deleted_task_context_requests() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    DELETE FROM public.context_model_requests WHERE task_id=NEW.id AND instance_id=NEW.instance_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER clear_deleted_task_context_requests
AFTER UPDATE OF deleted_at ON public.code_ui_sessions
FOR EACH ROW EXECUTE FUNCTION public.clear_deleted_task_context_requests();
