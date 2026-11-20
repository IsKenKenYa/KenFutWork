-- 会话默认标题汉化：chat_sessions.title 的 DEFAULT 原为 'New Chat'，
-- 未指定标题创建的会话（画布助手新建会话即走这条）会在界面上显示英文占位标题。
-- 前向修复：改默认值 + 回填历史占位值（仅精确匹配占位串的行，不动用户自拟标题）。

ALTER TABLE public.chat_sessions
  ALTER COLUMN title SET DEFAULT '新对话';

UPDATE public.chat_sessions
   SET title = '新对话'
 WHERE title = 'New Chat';

COMMENT ON COLUMN public.chat_sessions.title IS
  '会话标题；缺省占位为「新对话」。';
