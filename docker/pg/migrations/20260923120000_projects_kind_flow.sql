-- 项目类型加第三类 `flow`（可视化 AI 工作流项目）。
--
-- 背景：flow 子系统（futureFlow）按《flow 集成方案》分阶段并入。flow 的 run 同样**必绑项目**
-- （与 Code 模式「工作目录=项目」同一条硬约束：画布 id 即作用域，追问沿用同一作用域），
-- 因此项目类型先扩一项，由服务端一处持有类型、前端按 kind 取自己的列表。
-- 本迁移只改数据约束：flow 的模式入口与画布随宿主适配层（P2）接通后出现，接通前界面上
-- 不出现 flow 入口（不摆空壳）。
--
-- 前向迁移：不改历史迁移（`20260914270000_projects_kind.sql` 的约束原文保持不动），
-- 此处按同一约束名重写 CHECK 与列注释。

alter table public.projects
  drop constraint if exists projects_kind_check;

alter table public.projects
  add constraint projects_kind_check check (kind in ('design', 'code', 'flow'));

comment on column public.projects.kind is
  '项目类型：design=画布项目，code=工作目录项目（Code 模式「工作目录=项目」），flow=工作流项目（Flow 模式）';
