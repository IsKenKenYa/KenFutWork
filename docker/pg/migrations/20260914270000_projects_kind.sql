-- 项目类型（设计 vs 编码）：区分「画布项目」与「工作目录项目」。
--
-- 背景：`projects` 原先只有一种语义（Design 画布项目），Code 模式的「工作目录=项目」
-- 只能在客户端用 localStorage 另造一套 codeProjects，导致两套真相——用户选了工作
-- 目录，列表里看不到；而服务端项目又会冒到 Design 列表。加 kind 后由服务端一处持有
-- 类型，两端各自按 kind 取自己的列表。
--
-- 保留 `code-workbench`（Code 会话的兜底载体）与既有设计项目：默认 'design'，
-- 该兜底项目由更新语句显式标成 'code'。

alter table public.projects
  add column if not exists kind text not null default 'design';

alter table public.projects
  drop constraint if exists projects_kind_check;

alter table public.projects
  add constraint projects_kind_check check (kind in ('design', 'code'));

comment on column public.projects.kind is
  '项目类型：design=画布项目，code=工作目录项目（Code 模式「工作目录=项目」）';

-- Code 会话兜底载体归入 code 类（它本就不出现在任何列表里，靠 slug 排除）
update public.projects
   set kind = 'code'
 where slug = 'code-workbench';

create index if not exists projects_workspace_kind_idx
  on public.projects (workspace_id, kind)
  where archived_at is null;
