-- 项目启用方式补第四类 `work`（与 projects.kind 的 work 对齐）。
--
-- 背景：20261025000000_projects_kind_work.sql 只改了 kind 约束，enabled_modes 仍只允许
-- code/design/flow，导致 work 项目落库时被 `kind = any(enabled_modes)` 与枚举约束拒绝。
-- 本迁移按同一约束名前向重写：允许 work 与 code/design 显式共享；Flow 仍然独立。
--
-- 前向迁移：不改历史迁移原文。

alter table public.projects
  drop constraint if exists projects_enabled_modes_check;

alter table public.projects
  add constraint projects_enabled_modes_check check (
    cardinality(enabled_modes) between 1 and 4
    and enabled_modes <@ array['code', 'design', 'work', 'flow']::text[]
    and kind = any(enabled_modes)
    and array_position(enabled_modes, null) is null
    and (not ('flow' = any(enabled_modes)) or enabled_modes = array['flow']::text[])
    and cardinality(enabled_modes) =
      (('code' = any(enabled_modes))::int + ('design' = any(enabled_modes))::int
       + ('work' = any(enabled_modes))::int + ('flow' = any(enabled_modes))::int)
  );

comment on column public.projects.enabled_modes is
  '用户显式启用的项目工作方式（code/design/work 可共享；flow 独立）；新项目仅启用默认方式。';
