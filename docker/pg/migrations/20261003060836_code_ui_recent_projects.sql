-- 原 Code 宿主最近项目顺序；NULL 表示尚未保存，由实际 Code 项目列表提供初始值。
alter table public.workspace_settings add column code_ui_recent_projects text[];
