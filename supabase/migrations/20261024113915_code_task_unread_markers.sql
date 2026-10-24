ALTER TABLE public.code_ui_sessions
  ADD COLUMN unread_at bigint,
  ADD COLUMN last_unread_at bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT code_ui_sessions_unread_marker_valid CHECK (
    last_unread_at >= 0 AND last_unread_at <= 9007199254740991
    AND (unread_at IS NULL OR (unread_at > 0 AND unread_at <= last_unread_at))
  );

COMMENT ON COLUMN public.code_ui_sessions.unread_at IS
  '根 Task 当前未读标记；按客户端观察到的 marker 比较清除，不改运行与授权状态';
COMMENT ON COLUMN public.code_ui_sessions.last_unread_at IS
  '未读标记持久水位；清除未读后继续保留，软删除 Task 时清空';
