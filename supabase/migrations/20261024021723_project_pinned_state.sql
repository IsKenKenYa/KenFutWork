alter table public.projects
  add column pinned boolean not null default false;

comment on column public.projects.pinned is
  '原项目侧栏的持久置顶状态；修改沿用项目编辑修订与幂等回执';
