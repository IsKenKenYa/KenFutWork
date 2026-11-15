ALTER TABLE public.context_model_requests
  ADD COLUMN logical_call_id uuid,
  ADD COLUMN attempt_number integer,
  ADD CONSTRAINT context_model_requests_attempt_pair CHECK (
    (logical_call_id IS NULL AND attempt_number IS NULL)
    OR (logical_call_id IS NOT NULL AND attempt_number IS NOT NULL AND attempt_number > 0)
  );

CREATE UNIQUE INDEX context_model_requests_call_attempt
  ON public.context_model_requests(instance_id, task_id, run_id, logical_call_id, attempt_number)
  WHERE logical_call_id IS NOT NULL;

COMMENT ON COLUMN public.context_model_requests.logical_call_id IS '宿主一次模型调用的身份，仅在请求进入宿主管理的尝试后记录';
COMMENT ON COLUMN public.context_model_requests.attempt_number IS '同次模型调用内从一开始的宿主尝试顺序，旧请求无此字段';
