-- DEC-20：项目级技能归属由实例持有，键为真实 project id，不复用旧 workspace 技能表。
-- 外部目录导入按来源幂等；删除技能时写入最小墓碑，迟到导入不复活内容。

-- 复合外键需要被引用列的组合唯一约束；id 已是主键，此处只补组合约束。
alter table public.skills
  add constraint skills_id_instance_key unique (id, instance_id);

-- 项目级启停：技能仍需属于同一实例，项目删除或技能删除时级联清理。
create table public.project_skills (
  instance_id uuid not null references public.local_instances(id) on delete cascade,
  project_id uuid not null,
  skill_id uuid not null,
  enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (instance_id, project_id, skill_id),
  foreign key (project_id, instance_id)
    references public.projects(id, instance_id) on delete cascade,
  foreign key (skill_id, instance_id)
    references public.skills(id, instance_id) on delete cascade
);

create index project_skills_project_idx
  on public.project_skills (instance_id, project_id);

comment on table public.project_skills is
  '项目级技能启停；键为实例、真实项目和技能，解析不到项目时服务端不返回分档。';

-- 导入回执：request_key 是来源身份（规范化源根目录 + 源 slug）的摘要，
-- 参数指纹是技能包内容摘要；墓碑只留状态和时间，不留路径、slug、摘要或正文。
create table public.skill_import_receipts (
  instance_id uuid not null references public.local_instances(id) on delete cascade,
  request_key text not null check (request_key ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('imported', 'deleted')),
  skill_id uuid,
  parameter_fingerprint text
    check (parameter_fingerprint is null or parameter_fingerprint ~ '^[0-9a-f]{64}$'),
  source_root_path text,
  source_slug text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (instance_id, request_key),
  foreign key (skill_id, instance_id)
    references public.skills(id, instance_id) on delete set null,
  check (
    (status = 'imported'
      and skill_id is not null
      and parameter_fingerprint is not null
      and source_root_path is not null
      and source_slug is not null)
    or
    (status = 'deleted'
      and skill_id is null
      and parameter_fingerprint is null
      and source_root_path is null
      and source_slug is null)
  )
);

comment on table public.skill_import_receipts is
  '外部目录导入的幂等记录；技能物理删除时转为最小墓碑，迟到导入只返回已删除。';

-- 任何删除路径（接口、脚本、实例级清理）都经过同一触发器，不依赖应用层记得写墓碑。
create function public.retire_skill_import_receipts_on_delete()
returns trigger language plpgsql as $$
begin
  update public.skill_import_receipts
     set status = 'deleted',
         skill_id = null,
         parameter_fingerprint = null,
         source_root_path = null,
         source_slug = null,
         updated_at = now()
   where instance_id = old.instance_id
     and skill_id = old.id;
  return old;
end;
$$;

create trigger skills_retire_import_receipts
before delete on public.skills
for each row execute function public.retire_skill_import_receipts_on_delete();
