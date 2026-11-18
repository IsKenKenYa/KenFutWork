-- 保存 Design 接纳输入与 Goal 的模型调用快照，仅存引用和参数，不存接入凭据。
-- 已有记录保留 NULL，由显式恢复流程重新核验，不推测历史选择。
alter table public.design_task_goals
  add column model_invocation jsonb
    check (model_invocation is null or jsonb_typeof(model_invocation) = 'object');

alter table public.design_task_inputs
  add column model_invocation jsonb
    check (model_invocation is null or jsonb_typeof(model_invocation) = 'object');
