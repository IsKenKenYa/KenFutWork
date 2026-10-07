import { setTimeout } from "node:timers/promises";
import type { AgentRunService } from "../../agent/runtime.js";
import type { PersistenceService } from "../persistence/types.js";
import type { SettingsService } from "../settings/settings-service.js";
import type { LocalInstanceService } from "./types.js";

/** 不取消已接受的工作；接收门关闭后等待真实运行、后台工作与生成任务全部终态。 */
export async function waitForLocalInstanceIdle(options: {
  instance: LocalInstanceService;
  runs: Pick<AgentRunService, "activeRunCount">;
  persistence: PersistenceService;
  settings: SettingsService;
  inFlightJobs(): number;
}) {
  const actor = await options.instance.serviceActor();
  for (;;) {
    // 暂停队列是待保留数据；只有根快照允许自动消费的queued输入属于停机在途工作。
    const row = await options.persistence
      .forInstance(actor.instanceId)
      .queryOne<{ active: string | number }>(
        `select (select count(*) from public.task_works where instance_id = :instance and status = 'running')
        + (select count(*) from public.background_jobs where instance_id = :instance and status in ('queued', 'running'))
        + (select count(*) from public.code_ui_sessions code_session where instance_id = :instance and deleted_at is null
          and (active_run_id is not null or exists(select 1 from jsonb_array_elements(coalesce(state->'inputs','[]'::jsonb)) input
            where input->>'status' = 'reserved'
              or (input->>'status' = 'queued' and parent_session_id is null and not archived and execution_state = 'ready'
                and exists(select 1 from jsonb_array_elements(coalesce(state->'snapshots','[]'::jsonb)) snapshot
                  where snapshot->>'sessionId' = code_session.id::text and snapshot->'queue'->>'autoDrain' = 'true'))))) as active`,
      );
    if (
      !options.instance.activeAdmissionCount() &&
      !options.runs.activeRunCount() &&
      !options.inFlightJobs() &&
      Number(row?.active ?? 0) === 0
    )
      return;
    const settings = await options.settings.getInstanceSettings(
      actor,
      actor.instanceId,
    );
    await setTimeout(settings.localDataMigrationPollMs);
  }
}
