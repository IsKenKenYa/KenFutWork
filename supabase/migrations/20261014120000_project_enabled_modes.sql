-- 项目默认工作方式与已启用方式分别持有；Code/Design 显式共享同一项目。
alter table public.projects add column enabled_modes text[];
update public.projects set enabled_modes = array[kind];
alter table public.projects alter column enabled_modes set not null;

-- 所有创建入口（包括 Flow/测试种子）遵守同一个缺省规则。
create function public.initialize_project_modes() returns trigger
language plpgsql as $$
begin
  if new.enabled_modes is null then
    new.enabled_modes := array[new.kind];
  end if;
  return new;
end;
$$;
create trigger projects_initialize_modes before insert on public.projects
  for each row execute function public.initialize_project_modes();

alter table public.projects add constraint projects_enabled_modes_check check (
  cardinality(enabled_modes) between 1 and 3
  and enabled_modes <@ array['code', 'design', 'flow']::text[]
  and kind = any(enabled_modes)
  and array_position(enabled_modes, null) is null
  and (not ('flow' = any(enabled_modes)) or enabled_modes = array['flow']::text[])
  and cardinality(enabled_modes) =
    (('code' = any(enabled_modes))::int + ('design' = any(enabled_modes))::int
     + ('flow' = any(enabled_modes))::int)
);

comment on column public.projects.kind is '项目默认工作方式；不是资源类型或权限。';
comment on column public.projects.enabled_modes is '用户显式启用的项目工作方式；新项目仅启用默认方式。';
create index projects_enabled_modes_idx on public.projects using gin (enabled_modes)
  where archived_at is null;
