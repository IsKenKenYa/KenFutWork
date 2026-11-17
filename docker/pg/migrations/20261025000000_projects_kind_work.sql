-- 项目类型加第四类 `work`（办公 / 生产力创作项目：原生 Office 三件套 + 图片 / 视频编辑）。
--
-- 依据：《work 模式集成规划》（docs/插件/work模式集成规划.md）WD-1 / WD-6——Work 作为
-- 共享工作台的第四种工作方式，模式壳进内核、编辑引擎以扩展包按需下载（ArtCraft 系列）。
-- 本迁移只改数据约束：编辑器未接通前工作台不出现 Work 入口（入口纪律，不摆空壳）。
--
-- 前向迁移：不改历史迁移（`20260914270000_projects_kind.sql` 与
-- `20260923120000_projects_kind_flow.sql` 的约束原文保持不动），此处按同一约束名重写
-- CHECK 与列注释。

alter table public.projects
  drop constraint if exists projects_kind_check;

alter table public.projects
  add constraint projects_kind_check check (kind in ('design', 'code', 'flow', 'work'));

comment on column public.projects.kind is
  '项目类型：design=画布项目，code=工作目录项目（Code 模式「工作目录=项目」），flow=工作流项目（Flow 模式），work=办公/生产力创作项目（Work 模式）';
