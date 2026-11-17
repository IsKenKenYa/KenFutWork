-- Old Design execution rows remain as audit/FK identities. Only code_ui_sessions
-- is an executable Task aggregate after the shared host is installed.
update public.agent_runs r
set status='failed', completed_at=coalesce(completed_at,now()),
    error_code='design_session_retired',
    error_message='旧画布会话已停用，请在项目中新建会话。'
from public.chat_sessions c
where r.session_id=c.id and c.mode='design' and r.status in ('accepted','running')
  and not exists(select 1 from public.code_ui_sessions s where s.id=c.id);

update public.design_task_executions d
set execution_state='failed', scope_generation=scope_generation+1,
    branch_generation=branch_generation+1, planning_epoch=planning_epoch+1,
    active_run_id=null, runtime_owner_id=null, run_state='idle',
    plan_enabled=false, restore_operation_id=null
where (execution_state<>'failed' or active_run_id is not null or runtime_owner_id is not null)
  and not exists(select 1 from public.code_ui_sessions s where s.id=d.task_id);

update public.design_task_inputs i
set status='canceled', request=null, goal_fence=null
where status in ('queued','running')
  and not exists(select 1 from public.code_ui_sessions s where s.id=i.task_id);

update public.design_task_goals g
set state=state || jsonb_build_object(
  'status','paused','claimedRunId',null,'runStartedAt',null,'evaluation',null,
  'reason','design.sessionRetired',
  'revision',coalesce((state->>'revision')::bigint,0)+1
), observed_at=now()
where state->>'status' not in ('paused','complete','failed')
  and not exists(select 1 from public.code_ui_sessions s where s.id=g.task_id);

-- Failed jobs remain retryable in the worker. Retire only jobs whose actual
-- session is legacy Design; don't infer ownership from opaque payload run IDs.
update public.background_jobs j
set status='canceled', canceled_at=coalesce(canceled_at,now()),
    error_code='design_session_retired',
    error_message='旧画布会话已停用，后台任务已取消。'
from public.chat_sessions c
where j.session_id=c.id and j.instance_id=c.instance_id and c.mode='design'
  and j.status in ('queued','running','failed')
  and not exists(select 1 from public.code_ui_sessions s where s.id=c.id and s.instance_id=c.instance_id);

update public.task_works w
set status=case when status='running' then 'interrupted' else status end,
    ended_at=case when status='running' then coalesce(ended_at,now()) else ended_at end,
    summary=case when status='running' then '旧画布会话已停用，后台工作已中断。' else summary end,
    consumed_at=coalesce(consumed_at,now())
where owner_kind='design'
  and not exists(select 1 from public.code_ui_sessions s where s.id=w.task_id);

comment on table public.code_ui_sessions is
  'Code/Design 共用权威 Task 聚合；工作方式与文档引用按输入/Run 冻结，文件授权由固定目录与代际持有';
comment on table public.design_task_executions is
  '已退役的 Design 执行审计与外键身份；生产 Scope/TaskWork/Run 不得读取其运行策略';
comment on column public.chat_sessions.mode is
  '会话创建时的来源方式；共享 Task 的实际能力与资源由 code_ui_sessions 中每个 Run 的冻结上下文决定';
