alter table public.design_task_executions add column restore_operation_id uuid;
alter table public.design_task_executions add constraint design_task_restore_operation_state_check
  check (restore_operation_id is null or execution_state='revoking');
