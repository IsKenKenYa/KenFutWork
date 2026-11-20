-- 「索引库」拆成参考图里的两个开关（R4-3 对齐）。
--
-- 参考图（docs/参考图/索引库-代码库索引开关.png）是**两行**开关：
--   ① 索引新文件夹 —— 「自动索引文件数少于 50,000 的新文件夹。」
--   ② 索引存储库以实现即时搜索（测试版）—— 「自动对仓库进行索引，以加快 Grep 搜索速度。
--      所有数据均存储在本地。」
-- 此前只有一个总开关（`code_index_enabled`），两种语义混在一起、文案也对不上。
--
-- 拆法（两行都是**真行为**，不是排版）：
--   `code_index_enabled`        → ② 即时搜索：右栏「文件目录」的搜索走索引；关掉时搜索
--                                 端点如实拒绝并指路（不是回空列表）。
--   `code_index_auto_new_folder`→ ① 索引新文件夹：搜到一份**还没有索引**的工作目录时自动建
--                                 一份；目录文件数达到 50,000 就不自动建，如实说明并指路
--                                 「手动重建」。
-- 缺省 true（与参考图两行都打开一致）：只在 ② 开着时才起作用，所以不会带来「悄悄建索引」
-- 的意外——② 默认仍是 false。
alter table public.workspace_settings
  add column if not exists code_index_auto_new_folder boolean not null default true;

comment on column public.workspace_settings.code_index_auto_new_folder is
  'R4-3「索引新文件夹」：自动为尚无索引的工作目录建索引（文件数 < 50,000 才建）；关掉则只手动重建';
