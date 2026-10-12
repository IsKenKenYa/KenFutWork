ALTER TABLE public.background_jobs ADD COLUMN file_target jsonb;
ALTER TABLE public.background_jobs ADD CONSTRAINT background_jobs_file_target_shape
  CHECK (file_target IS NULL OR (
    jsonb_typeof(file_target) = 'object'
    AND file_target->>'kind' IS NOT NULL
    AND file_target->>'kind' IN ('standalone', 'project', 'task')
  ));
COMMENT ON COLUMN public.background_jobs.file_target IS
  '服务器接纳时冻结的成果来源；关联外键SET NULL不擦除来源；NULL历史记录禁止重放';
