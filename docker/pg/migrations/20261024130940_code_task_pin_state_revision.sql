ALTER TABLE public.code_ui_sessions
  ADD COLUMN pin_revision bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT code_ui_sessions_pin_revision_valid CHECK (
    pin_revision >= 0 AND pin_revision <= 9007199254740991
  );

COMMENT ON COLUMN public.code_ui_sessions.pin_revision IS
  'Task 置顶的独立观察修订；仅实际置顶变化时推进，不修改正文、运行修订或活动时间';
