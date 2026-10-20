-- 画布评论与标注：本仓自持的设计评审数据，作用域 = 实例 + 上游画布 project + 设计文件。
-- project_id 不建外键：画布的生命周期归上游 daemon，上游删掉 project 后这里只是孤儿行。
create table public.design_review_comments (
  instance_id uuid not null references public.local_instances(id) on delete cascade,
  id uuid not null,
  project_id text not null check (length(project_id) > 0),
  file_name text not null check (length(file_name) > 0),
  body text not null check (length(body) between 1 and 4000),
  status text not null default 'open' check (status in ('open', 'resolved')),
  anchor_path text not null check (length(anchor_path) between 1 and 600),
  anchor_rect jsonb not null,
  anchor_excerpt text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (instance_id, id)
);

create index design_review_comments_scope
  on public.design_review_comments (instance_id, project_id, file_name, created_at);

create table public.design_review_annotations (
  instance_id uuid not null references public.local_instances(id) on delete cascade,
  id uuid not null,
  project_id text not null check (length(project_id) > 0),
  file_name text not null check (length(file_name) > 0),
  kind text not null check (kind in ('pen', 'rect')),
  color text not null check (length(color) between 1 and 32),
  stroke_width numeric not null check (stroke_width > 0 and stroke_width <= 64),
  points jsonb not null check (jsonb_typeof(points) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (instance_id, id)
);

create index design_review_annotations_scope
  on public.design_review_annotations (instance_id, project_id, file_name, created_at);
