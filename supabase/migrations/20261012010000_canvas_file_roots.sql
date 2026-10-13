-- Canvas路径为持久定位索引；项目默认目录仅影响新Canvas。
alter table public.canvases add column root_directory text check (root_directory is null or length(root_directory)>0);
-- 旧Task目录必须一致，禁止任取某个Task覆盖其他Task的真实目录。
do $$
begin
  if exists (
    select 1 from public.design_task_executions d
    join public.chat_sessions s on s.id=d.task_id and s.instance_id=d.instance_id and s.project_id=d.project_id
    left join public.canvases c on c.id=s.canvas_id and c.project_id=d.project_id
    where s.mode='design' and (s.canvas_id is null or c.id is null)
  ) then raise exception 'Design Task与Canvas项目归属不一致，请先修复'; end if;
  if exists (
    select s.canvas_id from public.design_task_executions d
    join public.chat_sessions s on s.id=d.task_id and s.instance_id=d.instance_id and s.project_id=d.project_id
    join public.canvases canvas_owner on canvas_owner.id=s.canvas_id and canvas_owner.project_id=d.project_id
    where s.canvas_id is not null and s.mode='design'
    group by s.canvas_id having count(distinct d.root_directory)>1
  ) then
    raise exception 'Canvas关联Task目录冲突，请先迁移到一致目录';
  end if;
end $$;
update public.canvases c set root_directory=roots.root_directory
from (
  select s.canvas_id,min(d.root_directory) as root_directory from public.design_task_executions d
  join public.chat_sessions s on s.id=d.task_id and s.instance_id=d.instance_id and s.project_id=d.project_id
  join public.canvases canvas_owner on canvas_owner.id=s.canvas_id and canvas_owner.project_id=d.project_id
    where s.canvas_id is not null and s.mode='design' group by s.canvas_id
) roots where c.id=roots.canvas_id;

-- 无会话Canvas素材绑定确切Canvas，不由项目默认目录推断其位置。
alter table public.canvases add constraint canvases_id_project_key unique (id,project_id);
alter table public.asset_objects add column canvas_id uuid;
alter table public.asset_objects add constraint asset_objects_canvas_project_fk foreign key (canvas_id,project_id) references public.canvases(id,project_id) on delete cascade;
alter table public.asset_objects add constraint asset_objects_canvas_task_exclusive check (canvas_id is null or task_id is null);
create index asset_objects_canvas_files_idx on public.asset_objects(instance_id,canvas_id) where canvas_id is not null;

alter table public.asset_objects add constraint asset_objects_canvas_state_check check (canvas_id is null or (project_id is not null and file_state in ('pending','ready')));
