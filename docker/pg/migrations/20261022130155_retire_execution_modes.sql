-- 仅在服务停机后的迁移阶段执行；旧输入需要用户重新提交。
do $$
declare
  task record;
  previous jsonb;
  next_state jsonb;
  pending jsonb;
  snapshot jsonb;
  snapshots jsonb;
  row_value jsonb;
  rows_value jsonb;
  interrupted_runs text[];
  interrupts boolean;
  at_ms bigint := floor(extract(epoch from now()) * 1000);
begin
  for task in select id, state, active_run_id from public.code_ui_sessions
    where state is not null and (
      state ? 'runExecutionModes'
      or exists(select 1 from jsonb_array_elements(coalesce(state->'inputs','[]')) i where i ? 'executionMode')
      or exists(select 1 from jsonb_array_elements(coalesce(state->'inheritedHistory','[]')) h where h->'canonical' ? 'executionMode')
    ) for update
  loop
    previous := task.state;
    select coalesce(jsonb_agg(i),'[]') into pending
      from jsonb_array_elements(coalesce(previous->'inputs','[]')) i
      where i ? 'executionMode' and i->>'status' in ('queued','reserved','active');
    interrupts := jsonb_array_length(pending)>0 or (
      previous ? 'runExecutionModes' and task.active_run_id is not null
    );
    select coalesce(array_agg(distinct run_id),'{}') into interrupted_runs from (
      select i->>'runId' as run_id from jsonb_array_elements(pending) i
      union all
      select task.active_run_id::text where interrupts
      union all
      select w->>'foregroundExecutionId'
      from jsonb_array_elements(coalesce(previous->'snapshots','[]')) s,
        jsonb_array_elements(coalesce(s#>'{control,activeWorks}','[]')) w
      where interrupts
    ) r where run_id is not null;

    next_state := previous - 'runExecutionModes';
    if previous ? 'inputs' then
      next_state := jsonb_set(next_state,'{inputs}',(
        select coalesce(jsonb_agg((i - 'executionMode') || case
          when i ? 'executionMode' and i->>'status' in ('queued','reserved','active')
            then '{"status":"discarded"}'::jsonb else '{}'::jsonb end order by n),'[]')
        from jsonb_array_elements(previous->'inputs') with ordinality a(i,n)
      ));
    end if;
    if previous ? 'inheritedHistory' then
      next_state := jsonb_set(next_state,'{inheritedHistory}',(
        select coalesce(jsonb_agg(case when h->'canonical' ? 'executionMode'
          then jsonb_set(h,'{canonical}',(h->'canonical') - 'executionMode') else h end order by n),'[]')
        from jsonb_array_elements(previous->'inheritedHistory') with ordinality a(h,n)
      ));
    end if;
    if interrupts then
      next_state := next_state - 'inputOwner';
      next_state := jsonb_set(next_state,'{closedRuns}',(
        select coalesce(jsonb_agg(id),'[]') from (
          select jsonb_array_elements_text(coalesce(previous->'closedRuns','[]')) as id
          union select unnest(interrupted_runs)
        ) ids
      ));
      -- 只添加中断事实，历史成功或失败结果保持原值。
      next_state := jsonb_set(next_state,'{runOutcomes}',coalesce(previous->'runOutcomes','[]') || (
        select coalesce(jsonb_agg(jsonb_build_array(id,'canceled')),'[]')
        from unnest(interrupted_runs) id
        where not exists(select 1 from jsonb_array_elements(coalesce(previous->'runOutcomes','[]')) r where r->>0=id)
      ));
      update public.agent_runs set status='canceled', stop_reason='host_shutdown',
        completed_at=coalesce(completed_at,now()), error_code='agent_workflow_updated',
        error_message='Agent 工作流程已更新，请重新提交未完成的输入。'
        where id::text=any(interrupted_runs) and status in ('accepted','running');
    end if;

    -- Goal 与执行方式分开保存；升级不得自动接纳下一轮。
    if previous->'goalRecord'->>'status' in ('active','verifying','notSatisfied')
      or previous#>>'{goalRecord,claimedRunId}'=any(interrupted_runs) then
      next_state := jsonb_set(next_state,'{goalRecord}',previous->'goalRecord' || jsonb_build_object(
        'status','paused','claimedRunId',null,'runStartedAt',null,'evaluation',null,
        'lastSettledRunId',coalesce(nullif(previous#>'{goalRecord,claimedRunId}','null'::jsonb),previous#>'{goalRecord,lastSettledRunId}'),
        'reason','goal.workflowUpdated','revision',(previous#>>'{goalRecord,revision}')::bigint+1
      ));
    end if;

    snapshots := '[]';
    for snapshot in select value from jsonb_array_elements(coalesce(previous->'snapshots','[]'))
    loop
      if interrupts then
        snapshot := jsonb_set(snapshot,'{queue}',snapshot->'queue' || jsonb_build_object(
          'autoDrain',false,'pauseReason','manual','items',(
            select coalesce(jsonb_agg(i order by n),'[]')
            from jsonb_array_elements(snapshot#>'{queue,items}') with ordinality a(i,n)
            where not exists(select 1 from jsonb_array_elements(pending) p where p#>>'{intent,queueItemId}'=i->>'queueItemId')
          )
        ));
        snapshot := jsonb_set(snapshot,'{pendingCommands}',(
          select coalesce(jsonb_agg(c order by n),'[]')
          from jsonb_array_elements(snapshot->'pendingCommands') with ordinality a(c,n)
          where not exists(select 1 from jsonb_array_elements(pending) p
            where p#>>'{intent,sourceCommandId}'=c->>'commandId' and p#>>'{intent,clientId}'=c->>'clientId')
        ));
        if snapshot#>>'{control,phase}'='running' then
          snapshot := jsonb_set(snapshot,'{control}',snapshot->'control' || jsonb_build_object(
            'phase','completedInterrupted','sessionEnded',true,'canStop',false,'stopState','idle','activeWorks','[]'::jsonb,'apiRetry',null
          ));
          snapshot := jsonb_set(snapshot,'{pendingInteractions}','[]');
          rows_value := '[]';
          for row_value in select value from jsonb_array_elements(snapshot#>'{rows,window}') loop
            if row_value->>'kind'='turnHeader' and row_value->>'state'='running' then
              row_value := row_value || jsonb_build_object('state','completedInterrupted','endedAt',at_ms);
            elsif row_value->>'kind' in ('assistantText','reasoning') and row_value->>'state'='streaming' then
              row_value := row_value || '{"state":"interrupted"}'::jsonb;
            elsif row_value->>'kind'='toolCall' and row_value->>'status' in ('running','inputStreaming','pendingApproval') then
              row_value := row_value || jsonb_build_object('status','cancelled','endedAt',at_ms);
            end if;
            rows_value := rows_value || jsonb_build_array(row_value);
          end loop;
          snapshot := jsonb_set(snapshot,'{rows,window}',rows_value);
        end if;
        snapshot := jsonb_set(snapshot,'{inputRouting}',jsonb_build_object('mode',case
          when jsonb_array_length(snapshot#>'{queue,items}')>0 then 'choice' else 'startNow' end));
        if snapshot->>'sessionId'=task.id::text then
          snapshot := jsonb_set(snapshot,'{control,lastError}',jsonb_build_object(
            'code','agent_workflow_updated','message','工作流程已更新 请重新提交未完成输入',
            'recoverable',true,'source','runtime','at',at_ms
          ));
        end if;
      end if;
      snapshot := snapshot || jsonb_build_object('seq',(snapshot->>'seq')::bigint+1,'revision',(snapshot->>'revision')::bigint+1);
      snapshots := snapshots || jsonb_build_array(snapshot);
    end loop;
    next_state := jsonb_set(next_state,'{snapshots}',snapshots);
    update public.code_ui_sessions set state=next_state,
      active_run_id=case when interrupts then null else active_run_id end,
      revision=revision+1, updated_at=now() where id=task.id;
  end loop;
end $$;

alter table public.chat_sessions drop column execution_mode;
