-- 已提交迁移保持原始字节，使用前向约束拒绝缺少指纹的有效回执。
ALTER TABLE public.code_task_group_save_receipts
  ADD CONSTRAINT code_task_group_save_receipts_fingerprint_present
  CHECK (deleted OR parameter_fingerprint IS NOT NULL);
