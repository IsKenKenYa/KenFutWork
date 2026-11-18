-- 当前归属仍在数据库中保持一致；延迟到同一移动事务提交时核验。
ALTER TABLE public.execution_task_owners
  DROP CONSTRAINT execution_task_owners_code_task_identity_fkey,
  ADD CONSTRAINT execution_task_owners_code_task_id_instance_id_project_id_fkey
    FOREIGN KEY (code_task_id, instance_id, project_id)
    REFERENCES public.code_ui_sessions(id, instance_id, project_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;
